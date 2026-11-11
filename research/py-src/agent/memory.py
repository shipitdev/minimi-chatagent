"""Memory: three tiers, because the three prompt classes need different things.

| Tier | What it holds | How it is used | Why this way |
|---|---|---|---|
| fact log | one row per verified claim, with source + confidence | only rows matching the current query, at the END of the evidence block | keeps compaction lossy-but-recoverable (LongMemEval's fact-augmented keys) |
| summary chain | append-only chain of dated summary blocks | head of the prompt, before recent turns | append-only keeps the prefix cacheable; rewriting a summary invalidates the cache from that byte onward |
| turn index | every exchange, with entities/topics + a query-overlap score | retrieved for recall questions and for pronoun resolution | recall questions ("what did I tell you") are a first-class task type, not an edge case |

The tier that earns its keep is the fact log. It is the only structure that
survives aggressive compaction without distortion, because it is extractive and
typed rather than abstractive.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Iterable

from .config import estimate_tokens

_WORD_RE = re.compile(r"[a-z0-9][a-z0-9'\-_.]*")
_STOP = {
    "the", "a", "an", "and", "or", "but", "if", "of", "to", "in", "on", "for",
    "with", "is", "are", "was", "were", "be", "been", "it", "its", "this",
    "that", "these", "those", "as", "at", "by", "from", "i", "you", "we",
    "they", "he", "she", "my", "your", "our", "their", "me", "us", "them",
    "do", "does", "did", "so", "than", "then", "there", "here", "what",
    "which", "who", "when", "where", "how", "why", "can", "could", "should",
    "would", "will", "just", "about", "into", "not", "no", "yes",
}


def terms(text: str) -> list[str]:
    return [t for t in _WORD_RE.findall((text or "").lower()) if t not in _STOP and len(t) > 1]


def canon_terms(text: str) -> list[str]:
    """Canonical comparison tokens: hyphen-split, punctuation-stripped.

    `terms()` deliberately keeps hyphens and internal periods so identifiers such
    as `gpt-3.5` or `eu-west-2` survive as single units, which is right for
    indexing and for entity keys. For *comparing* a query against retrieved text
    that choice is wrong: `lost-in-the-middle` and `lost in the middle` would hash
    to different tokens, so a perfectly relevant page looks unrelated, and a
    sentence-final `ordering.` never matches `ordering`. Use this function when
    deciding whether two pieces of text are about the same thing.
    """
    raw = (text or "").lower().replace("-", " ").replace("_", " ")
    out: list[str] = []
    for tok in _WORD_RE.findall(raw):
        tok = tok.strip(".'\u2019")
        if tok and tok not in _STOP and len(tok) > 1:
            out.append(tok)
    return out


def _hash(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8", "replace")).hexdigest()[:16]


# ---------------------------------------------------------------------------
# Tier 1: fact log
# ---------------------------------------------------------------------------


@dataclass
class Fact:
    claim: str
    source_url: str = ""
    date: str = ""
    confidence: str = "tentative"   # "verified" | "tentative"
    topic: str = ""
    turn: int = 0
    created: float = field(default_factory=time.time)

    @property
    def key(self) -> str:
        return _hash(self.claim.lower())

    def render(self) -> str:
        tag = "verified" if self.confidence == "verified" else "tentative"
        src = f" ({self.source_url})" if self.source_url else ""
        return f"- {self.claim}{src} [{tag}]"


class FactLog:
    def __init__(self, max_facts: int = 400):
        self.max_facts = max_facts
        self._facts: dict[str, Fact] = {}

    def add(self, fact: Fact) -> bool:
        if not fact.claim.strip():
            return False
        # A verified fact supersedes the same tentative claim.
        existing = self._facts.get(fact.key)
        if existing:
            if fact.confidence == "verified" and existing.confidence != "verified":
                self._facts[fact.key] = fact
                return True
            return False
        self._facts[fact.key] = fact
        if len(self._facts) > self.max_facts:
            oldest = sorted(self._facts.values(), key=lambda f: f.created)[: len(self._facts) - self.max_facts]
            for f in oldest:
                self._facts.pop(f.key, None)
        return True

    def add_many(self, claims: Iterable[dict], turn: int = 0) -> int:
        n = 0
        for c in claims:
            if self.add(Fact(
                claim=str(c.get("claim", "")).strip(),
                source_url=str(c.get("source_url", "")),
                date=str(c.get("date", "")),
                confidence=str(c.get("confidence", "tentative")),
                topic=str(c.get("topic", "")),
                turn=turn,
            )):
                n += 1
        return n

    def __len__(self) -> int:
        return len(self._facts)

    def all(self) -> list[Fact]:
        return list(self._facts.values())

    def relevant(self, query: str, budget_tokens: int = 200, limit: int = 6) -> list[Fact]:
        """Only facts that overlap the current query, capped hard.

        This is the LongMemEval recipe: fact-augmented keys, injected small.
        """
        q = set(terms(query))
        if not q:
            return []
        scored: list[tuple[float, Fact]] = []
        for f in self._facts.values():
            ft = set(terms(f.claim))
            if not ft:
                continue
            overlap = len(q & ft) / math.sqrt(len(ft))
            if overlap <= 0:
                continue
            bonus = 0.15 if f.confidence == "verified" else 0.0
            scored.append((overlap + bonus, f))
        scored.sort(key=lambda x: x[0], reverse=True)

        out: list[Fact] = []
        used = 0
        for _, f in scored[:limit]:
            cost = estimate_tokens(f.render()) + 2
            if used + cost > budget_tokens and out:
                break
            out.append(f)
            used += cost
        return out

    def to_json(self) -> list[dict]:
        return [asdict(f) for f in self._facts.values()]

    @classmethod
    def from_json(cls, rows: list[dict]) -> "FactLog":
        log = cls()
        for r in rows or []:
            try:
                log.add(Fact(**{k: v for k, v in r.items() if k in Fact.__annotations__}))
            except TypeError:
                continue
        return log


# ---------------------------------------------------------------------------
# Tier 2: append-only summary chain
# ---------------------------------------------------------------------------


@dataclass
class SummaryBlock:
    turn_from: int
    turn_to: int
    text: str
    created: float = field(default_factory=time.time)

    def render(self) -> str:
        return f"(turns {self.turn_from}-{self.turn_to}) {self.text.strip()}"


class SummaryChain:
    """Append-only by contract.

    Rewriting an earlier block would invalidate every cache prefix unit from that
    token onward, which — at a 5x cache-hit/miss price gap — costs more than the
    tokens the rewrite saves.
    """

    def __init__(self, max_blocks: int = 8):
        self.max_blocks = max_blocks
        self.blocks: list[SummaryBlock] = []

    def append(self, block: SummaryBlock) -> None:
        self.blocks.append(block)
        if len(self.blocks) > self.max_blocks:
            self.blocks = self._merge_oldest(self.blocks, self.max_blocks)

    @staticmethod
    def _merge_oldest(blocks: list[SummaryBlock], keep: int) -> list[SummaryBlock]:
        """Merge only the *oldest* blocks, so the newest remain untouched and the
        shortest possible prefix changes."""
        excess = len(blocks) - keep + 1
        head = blocks[:excess]
        merged = SummaryBlock(
            turn_from=head[0].turn_from,
            turn_to=head[-1].turn_to,
            text=" ".join(b.text.strip() for b in head),
        )
        return [merged] + blocks[excess:]

    def render(self) -> str:
        if not self.blocks:
            return ""
        return "\n".join(b.render() for b in self.blocks)

    def token_estimate(self) -> int:
        return estimate_tokens(self.render())

    def to_json(self) -> list[dict]:
        return [asdict(b) for b in self.blocks]

    @classmethod
    def from_json(cls, rows: list[dict]) -> "SummaryChain":
        chain = cls()
        for r in rows or []:
            try:
                chain.blocks.append(SummaryBlock(
                    turn_from=int(r.get("turn_from", 0)),
                    turn_to=int(r.get("turn_to", 0)),
                    text=str(r.get("text", "")),
                    created=float(r.get("created", time.time())),
                ))
            except (TypeError, ValueError):
                continue
        return chain


# ---------------------------------------------------------------------------
# Tier 3: turn index (episodic recall)
# ---------------------------------------------------------------------------


@dataclass
class Turn:
    index: int
    user: str
    assistant: str
    entities: list[str] = field(default_factory=list)
    topics: list[str] = field(default_factory=list)
    user_fact: str = ""
    ts: float = field(default_factory=time.time)

    def brief(self, max_chars: int = 320) -> str:
        u = self.user.strip().replace("\n", " ")
        a = self.assistant.strip().replace("\n", " ")
        if len(u) > max_chars // 2:
            u = u[: max_chars // 2] + "…"
        if len(a) > max_chars:
            a = a[:max_chars] + "…"
        return f"Turn {self.index} — User: {u} | You: {a}"

    def to_json(self) -> dict:
        return asdict(self)

    @classmethod
    def from_json(cls, r: dict) -> "Turn":
        return cls(
            index=int(r.get("index", 0)),
            user=str(r.get("user", "")),
            assistant=str(r.get("assistant", "")),
            entities=list(r.get("entities") or []),
            topics=list(r.get("topics") or []),
            user_fact=str(r.get("user_fact", "")),
            ts=float(r.get("ts", time.time())),
        )


class TurnIndex:
    """Entity/topic-keyed retrieval over turns.

    Deliberately lexical, not semantic: no embedding model to ship, no extra
    dependency, and for recall questions the user's own words are almost always
    present in the stored turn — which is exactly where lexical search is strong.
    """

    def __init__(self):
        self.turns: list[Turn] = []
        self._df: dict[str, int] = {}

    def add(self, turn: Turn) -> None:
        self.turns.append(turn)
        for t in set(terms(turn.user + " " + turn.assistant) + [e.lower() for e in turn.entities]):
            self._df[t] = self._df.get(t, 0) + 1

    def __len__(self) -> int:
        return len(self.turns)

    def search(self, query: str, k: int = 3, exclude_last: int = 0) -> list[Turn]:
        """BM25-lite with an entity bonus. Deterministic and dependency-free."""
        q = set(terms(query))
        if not q or not self.turns:
            return []
        n = len(self.turns)
        avgdl = sum(len(terms(t.user + " " + t.assistant)) for t in self.turns) / max(1, n)
        pool = self.turns[: n - exclude_last] if exclude_last else self.turns

        scored: list[tuple[float, Turn]] = []
        for t in pool:
            doc_terms = terms(t.user + " " + t.assistant)
            if not doc_terms:
                continue
            tf: dict[str, int] = {}
            for w in doc_terms:
                tf[w] = tf.get(w, 0) + 1
            dl = len(doc_terms)
            score = 0.0
            for w in q:
                if w not in tf:
                    continue
                df = self._df.get(w, 1)
                idf = math.log(1 + (n - df + 0.5) / (df + 0.5))
                denom = tf[w] + 1.5 * (1 - 0.75 + 0.75 * dl / max(avgdl, 1))
                score += idf * (tf[w] * 2.5) / denom
            # Entity hits are the strongest recall signal, so they get a boost.
            ent_hits = sum(1 for e in t.entities if e.lower() in q)
            score += 1.2 * ent_hits
            if t.user_fact:
                score += 0.3
            if score > 0:
                scored.append((score, t))

        scored.sort(key=lambda x: x[0], reverse=True)
        return [t for _, t in scored[:k]]


# ---------------------------------------------------------------------------
# Container
# ---------------------------------------------------------------------------


class Memory:
    """Everything persistent for one conversation."""

    def __init__(self):
        self.facts = FactLog()
        self.summaries = SummaryChain()
        self.index = TurnIndex()
        self.answer_cache: dict[str, dict] = {}   # summary hash -> {"text": ...}
        self.turn_counter = 0

    def next_turn(self) -> int:
        self.turn_counter += 1
        return self.turn_counter

    def render_summary(self) -> str:
        return self.summaries.render()

    def recall(self, query: str, k: int = 3, exclude_last: int = 1) -> list[Turn]:
        """Retrieve turns matching a recall-style query, excluding the newest."""
        hits = self.index.search(query, k=k, exclude_last=exclude_last)
        if hits:
            return hits
        # Fall back to the most recent turns: a vague "what did we discuss?" has
        # no lexical overlap with anything, but recency is the right prior.
        return self.index.turns[-k:] if self.index.turns else []

    def to_json(self) -> dict:
        return {
            "version": 1,
            "turn_counter": self.turn_counter,
            "facts": self.facts.to_json(),
            "summaries": self.summaries.to_json(),
            "turns": [t.to_json() for t in self.index.turns],
        }

    @classmethod
    def from_json(cls, data: dict) -> "Memory":
        m = cls()
        m.turn_counter = int(data.get("turn_counter", 0))
        m.facts = FactLog.from_json(data.get("facts") or [])
        m.summaries = SummaryChain.from_json(data.get("summaries") or [])
        for r in data.get("turns") or []:
            m.index.add(Turn.from_json(r))
        return m


class MemoryStore:
    """Filesystem persistence, one JSON file per conversation."""

    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, conversation_id: str) -> Path:
        safe = re.sub(r"[^A-Za-z0-9_.-]", "_", conversation_id)[:80] or "default"
        return self.root / f"{safe}.memory.json"

    def load(self, conversation_id: str) -> Memory:
        p = self._path(conversation_id)
        if not p.exists():
            return Memory()
        try:
            return Memory.from_json(json.loads(p.read_text(encoding="utf-8")))
        except (json.JSONDecodeError, OSError, TypeError):
            # A corrupt memory file must never take the agent down.
            return Memory()

    def save(self, conversation_id: str, memory: Memory) -> Path:
        p = self._path(conversation_id)
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(memory.to_json(), ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(p)
        return p
