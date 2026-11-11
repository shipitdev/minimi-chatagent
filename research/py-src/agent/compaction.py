"""Context compaction: a three-layer escalation with thresholds in token budget.

The policy is straight out of the research briefs (see docs/01-research-compaction.md):

* **Compaction frequency is the cost driver, not compression ratio.** Cheap
  layers therefore run often; the expensive layer runs rarely.
* **Never mutate an earlier message.** Cache-prefix units require a *full* match,
  so rewriting turn 3 of 10 invalidates the cache from turn 3 onward. We only
  ever (a) drop whole turns from the *front*, and (b) append a new summary block
  to the head. Both preserve the longest possible invariant prefix.
* **Never re-compress the newest content.** The verbatim window is sacred: last
  N turns keep their tool results in full.
* **Synchronous summarisation is up to 62% of end-to-end wall time** and it also
  destroys prefix-cache reuse. So summarisation is (i) cached by content hash,
  (ii) chunked, (iii) deferred to a turn boundary rather than run mid-step.
* **Retention floor.** Instrumented and asserted above ~10%: below that regime
  the literature measures a large absolute accuracy loss.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path

from .config import Settings, estimate_tokens, estimate_prompt_tokens
from .memory import Memory, SummaryBlock, _hash
from .prompts import summary_prompt
from .tools import EvidenceStore, Result


# ---------------------------------------------------------------------------
# Thresholds
# ---------------------------------------------------------------------------


@dataclass
class Thresholds:
    budget: int
    soft: int
    hard: int
    resume: int

    @classmethod
    def from_settings(cls, s: Settings) -> "Thresholds":
        budget = max(2000, s.context_budget_tokens - s.reserve_output_tokens)
        return cls(
            budget=budget,
            soft=int(0.55 * budget),
            hard=int(0.85 * budget),
            resume=int(0.15 * budget),
        )


@dataclass
class CompactionReport:
    layer: str
    tokens_before: int
    tokens_after: int
    turns_dropped: int = 0
    results_trimmed: int = 0
    summary_used: bool = False
    summary_cached: bool = False
    notes: list[str] = field(default_factory=list)

    @property
    def retained_ratio(self) -> float:
        return (self.tokens_after / self.tokens_before) if self.tokens_before else 1.0

    def as_dict(self) -> dict:
        return {
            "layer": self.layer,
            "tokens_before": self.tokens_before,
            "tokens_after": self.tokens_after,
            "retained_ratio": round(self.retained_ratio, 3),
            "turns_dropped": self.turns_dropped,
            "results_trimmed": self.results_trimmed,
            "summary_used": self.summary_used,
            "summary_cached": self.summary_cached,
            "notes": self.notes,
        }


# ---------------------------------------------------------------------------
# Layer A: deterministic, extractive, free
# ---------------------------------------------------------------------------

_SENT_SPLIT = ("。", "！", "？", ". ", "! ", "? ", "\n")


def query_overlap_snippet(text: str, query: str, max_tokens: int = 160) -> str:
    """Extract the sentences with the highest query-term overlap.

    This is the cheap, query-aware substitute for a LongLLMLingua contrastive
    perplexity pass: no second model, no extra latency, and it targets *this*
    question rather than being query-independent like an off-the-shelf compressor.
    """
    text = (text or "").strip()
    if not text:
        return ""
    if estimate_tokens(text) <= max_tokens:
        return text

    # Sentence split that keeps CJK terminators working.
    pieces: list[str] = []
    buf = text
    for delim in _SENT_SPLIT:
        new: list[str] = []
        for p in buf.split(delim):
            new.append(p)
        buf = "\x00".join(new) if delim != "\n" else buf
    # Simpler and robust: split on any terminator, keep order.
    import re

    sentences = [s.strip() for s in re.split(r"(?<=[.!?。！？])\s+|\n+", text) if s.strip()]
    if len(sentences) <= 1:
        return _cut_to_tokens(text, max_tokens)

    qterms = {t for t in _terms(query)}
    scored: list[tuple[float, int, str]] = []
    for i, s in enumerate(sentences):
        st = _terms(s)
        if not st:
            continue
        overlap = len(qterms & set(st)) / math.sqrt(len(st))
        # Mild recency tiebreak: later sentences in a search summary are often
        # the conclusion.
        scored.append((overlap + 0.01 * i, i, s))

    if not scored:
        return _cut_to_tokens(text, max_tokens)

    scored.sort(key=lambda x: (x[0], -x[1]), reverse=True)
    chosen: list[tuple[int, str]] = []
    used = 0
    for _, i, s in scored:
        cost = estimate_tokens(s) + 1
        if used + cost > max_tokens and chosen:
            break
        chosen.append((i, s))
        used += cost
    chosen.sort(key=lambda x: x[0])          # restore document order
    out = " ".join(s for _, s in chosen)
    return out or _cut_to_tokens(text, max_tokens)


def _cut_to_tokens(text: str, max_tokens: int) -> str:
    budget = max(80, int(max_tokens * 3.6))
    if len(text) <= budget:
        return text
    window = text[:budget]
    cut = max(window.rfind(". "), window.rfind("! "), window.rfind("? "))
    if cut > budget * 0.55:
        window = window[: cut + 1]
    return window.rstrip() + " …"


def _terms(text: str) -> list[str]:
    from .memory import terms

    return terms(text)


def dedupe_near(results: list[Result], gram: int = 8) -> tuple[list[Result], int]:
    """Drop results whose leading text is a near-duplicate of an earlier one."""
    seen: list[set[str]] = []
    kept: list[Result] = []
    dropped = 0
    for r in results:
        words = _terms(r.text)[:120]
        shingles = {
            " ".join(words[i : i + gram])
            for i in range(max(0, len(words) - gram + 1))
        }
        if shingles and any(
            len(shingles & prev) / max(1, len(shingles | prev)) > 0.6 for prev in seen
        ):
            dropped += 1
            continue
        if shingles:
            seen.append(shingles)
        kept.append(r)
    return kept, dropped


def evict_weak(results: list[Result], ratio: float = 0.35, floor: int = 3) -> tuple[list[Result], int]:
    """Drop results scoring below `ratio` x the top score, while >= floor remain.

    Uses rerank_score only (a stable, API-provided signal) so the policy does not
    depend on our own ranking heuristics.
    """
    if len(results) <= floor:
        return results, 0
    top = max((r.rerank_score for r in results), default=0.0)
    if top <= 0:
        return results, 0
    cutoff = ratio * top
    kept = [r for r in results if r.rerank_score >= cutoff]
    if len(kept) < floor:
        kept = results[:floor]
    return kept, len(results) - len(kept)


def trim_evidence_layer(
    store: EvidenceStore,
    query: str,
    *,
    max_results: int = 8,
    per_result_tokens: int = 160,
) -> tuple[int, list[str]]:
    """Layer A over an EvidenceStore: rank-truncate -> extract -> dedupe -> evict.

    Returns (n_results_trimmed, notes). Mutates the store's result set in place,
    keeping the *original* citation numbering stable for anything already cited.
    """
    notes: list[str] = []
    results = store.results()
    if not results:
        return 0, notes

    n_before = len(results)
    trimmed = results[:max_results]
    if len(trimmed) < n_before:
        notes.append(f"rank-truncated {n_before} -> {len(trimmed)}")

    deduped, dropped = dedupe_near(trimmed)
    if dropped:
        notes.append(f"deduped {dropped} near-duplicate results")
    trimmed = deduped

    for r in trimmed:
        extracted = query_overlap_snippet(r.text, query, max_tokens=per_result_tokens)
        if len(extracted) < len(r.text):
            r.text = extracted
            r.source_field = r.source_field + "+extracted"
            r.truncated = True

    trimmed, evicted = evict_weak(trimmed)
    if evicted:
        notes.append(f"evicted {evicted} low-score results")

    if len(trimmed) != n_before:
        store.replace_results(trimmed)
    return n_before - len(trimmed), notes


# ---------------------------------------------------------------------------
# Layer B: turns -> summary blocks (LLM, cached, chunked, deferred)
# ---------------------------------------------------------------------------


class Compactor:
    def __init__(self, settings: Settings, memory: Memory, cache_dir: Path | None = None):
        self.s = settings
        self.memory = memory
        self.thresholds = Thresholds.from_settings(settings)
        self.cache_dir = cache_dir
        if cache_dir:
            cache_dir.mkdir(parents=True, exist_ok=True)
        self.reports: list[CompactionReport] = []

    # -- measurement -------------------------------------------------------

    def prompt_tokens(self, messages: list[dict]) -> int:
        return estimate_prompt_tokens(messages)

    def full_history_tokens(self, conversations: list["Conversation"]) -> int:
        """Tokens for the conversation as it would be sent *without* compaction.

        This is the quantity the thresholds must be compared against. Measuring
        only the already-trimmed window is a self-defeating trigger: once the
        window is small, the condition can never become true again, so compaction
        silently stops firing and memory growth goes unnoticed.
        """
        from .prompts import SYSTEM_PROMPT

        total = estimate_tokens(SYSTEM_PROMPT) + 8
        for c in conversations:
            total += estimate_tokens(c.user) + estimate_tokens(c.assistant) + 8
        return total

    def should_trim(self, messages: list[dict]) -> bool:
        return self.prompt_tokens(messages) > self.thresholds.soft

    def should_trim_history(self, conversations: list["Conversation"]) -> bool:
        return self.full_history_tokens(conversations) > self.thresholds.soft

    def should_compact(self, messages: list[dict]) -> bool:
        return self.prompt_tokens(messages) > self.thresholds.hard

    def should_compact_history(self, conversations: list["Conversation"]) -> bool:
        return self.full_history_tokens(conversations) > self.thresholds.hard

    # -- layer A -----------------------------------------------------------

    def trim(
        self, messages: list[dict], conversations: list["Conversation"], query: str
    ) -> CompactionReport:
        """Deterministic front-eviction of old turns. No model call."""
        before = self.prompt_tokens(messages)
        keep = self.s.keep_recent_turns
        if len(conversations) <= keep:
            report = CompactionReport(
                layer="A", tokens_before=before, tokens_after=before,
                notes=["nothing to trim: within verbatim window"],
            )
            self.reports.append(report)
            return report

        droppable = conversations[:-keep]
        # Drop oldest-first until we are back under the soft threshold.
        dropped: list["Conversation"] = []
        msgs = list(messages)
        while droppable and self.prompt_tokens(msgs) > self.thresholds.soft:
            turn = droppable.pop(0)
            dropped.append(turn)
            msgs = [m for m in msgs if m.get("_turn") not in {t.index for t in dropped}]

        after = self.prompt_tokens(msgs)
        report = CompactionReport(
            layer="A", tokens_before=before, tokens_after=after,
            turns_dropped=len(dropped),
            notes=[f"dropped turns {[t.index for t in dropped]}"] if dropped else [],
        )
        if messages:
            messages[:] = msgs
        self.reports.append(report)
        return report

    # -- layer B -----------------------------------------------------------

    def _cache_path(self, key: str) -> Path | None:
        return (self.cache_dir / f"{key}.txt") if self.cache_dir else None

    def _load_cached(self, key: str) -> str | None:
        p = self._cache_path(key)
        if p and p.exists():
            try:
                return p.read_text(encoding="utf-8")
            except OSError:
                return None
        # In-process cache (the memory object also caches; this covers reruns).
        hit = self.memory.answer_cache.get(key)
        return hit.get("text") if hit else None

    def _save_cached(self, key: str, text: str) -> None:
        self.memory.answer_cache[key] = {"text": text}
        p = self._cache_path(key)
        if p:
            try:
                p.write_text(text, encoding="utf-8")
            except OSError:
                pass

    def compact_turns(
        self,
        client,
        conversations: list["Conversation"],
        *,
        chunk_tokens: int = 512,
        target_words: int = 180,
    ) -> CompactionReport:
        """Summarise old turns into an appended summary block.

        Chunked by token budget because whole-context summarisation silently
        over-compresses; cached by content hash because identical history must
        produce an identical summary (CV up to 42.9% otherwise).
        """
        before = 0
        keep = self.s.keep_recent_turns
        old = conversations[:-keep] if len(conversations) > keep else []
        if not old:
            report = CompactionReport(
                layer="B", tokens_before=0, tokens_after=0,
                notes=["nothing old enough to summarise"],
            )
            self.reports.append(report)
            return report

        # Only summarise turns not already covered by a summary block.
        covered_to = max((b.turn_to for b in self.memory.summaries.blocks), default=-1)
        old = [t for t in old if t.index > covered_to]
        if not old:
            report = CompactionReport(
                layer="B", tokens_before=0, tokens_after=0,
                notes=["all old turns already summarised"],
            )
            self.reports.append(report)
            return report

        chunks: list[list["Conversation"]] = []
        current: list["Conversation"] = []
        used = 0
        for turn in old:
            cost = estimate_tokens(turn.user) + estimate_tokens(turn.assistant) + 8
            if current and used + cost > chunk_tokens:
                chunks.append(current)
                current, used = [], 0
            current.append(turn)
            used += cost
        if current:
            chunks.append(current)

        total_before = 0
        appended: list[SummaryBlock] = []
        notes: list[str] = []
        for chunk in chunks:
            excerpt = "\n\n".join(
                f"User: {t.user}\nAssistant: {t.assistant[:1500]}" for t in chunk
            )
            total_before += estimate_tokens(excerpt)
            key = _hash(
                f"v1|{self.s.model}|{excerpt}|{self.s.summarize_chunk_turns}|{target_words}"
            )
            cached = self._load_cached(key)
            if cached is not None:
                text = cached
                cached_hit = True
            else:
                prompt = summary_prompt(excerpt, self.memory.render_summary(), target_words)
                try:
                    res = client.chat(
                        [{"role": "user", "content": prompt}],
                        stage="compact",
                        temperature=0.0,          # determinism is a correctness property here
                        max_tokens=700,
                        thinking=False,
                    )
                    text = res.content.strip()
                except Exception as e:
                    notes.append(f"summarisation failed ({type(e).__name__}); kept chain unchanged")
                    continue
                if not text:
                    notes.append("summarisation returned empty; kept chain unchanged")
                    continue
                self._save_cached(key, text)
                cached_hit = False
            appended.append(SummaryBlock(
                turn_from=chunk[0].index, turn_to=chunk[-1].index, text=text,
            ))

        for block in appended:
            self.memory.summaries.append(block)

        after = self.memory.summaries.token_estimate()
        report = CompactionReport(
            layer="B", tokens_before=total_before, tokens_after=after,
            summary_used=bool(appended), summary_cached=False, notes=notes,
        )
        self.reports.append(report)
        return report

    # -- orchestration -----------------------------------------------------

    def enforce(
        self,
        client,
        messages: list[dict],
        conversations: list["Conversation"],
        query: str,
        *,
        allow_summarise: bool = True,
    ) -> list[CompactionReport]:
        """Run the cheapest sufficient layer. Called at turn boundaries only.

        Escalation is deliberately conservative: layer A (free, deterministic)
        runs alone while it is sufficient, because compaction frequency — not
        compression ratio — is the measured cost driver.
        """
        produced: list[CompactionReport] = []
        # Gate on the *uncompacted* history, not on the trimmed window.
        if not self.should_trim_history(conversations):
            return produced
        produced.append(self.trim(messages, conversations, query))
        if allow_summarise and self.should_compact_history(conversations):
            produced.append(self.compact_turns(client, conversations))
        return produced

    def instrument(self) -> dict:
        return {
            "thresholds": {
                "budget": self.thresholds.budget,
                "soft": self.thresholds.soft,
                "hard": self.thresholds.hard,
                "resume": self.thresholds.resume,
            },
            "reports": [r.as_dict() for r in self.reports],
            "min_retained_ratio": round(
                min((r.retained_ratio for r in self.reports), default=1.0), 3
            ),
            "retention_floor_ok": all(r.retained_ratio >= 0.10 for r in self.reports),
        }
