"""The hybrid agent loop.

Architecture, and the evidence behind each decision
---------------------------------------------------

    gate → (recall | direct | plan→search→answer) → harness stop

**Gate.** One call emitting a narrow enum (`recall` | `direct` | `research`), not
a judgement about the model's own knowledge. Self-judged retrieval is the
measured small-model failure: Mallen 2212.10511 finds adaptive-retrieval gains
are "much smaller... models smaller than 10 billion"; Adaptive-RAG 2403.14403
measures LLM-judged routing at 23.1 F1 versus 38.3 for a trained T5-Large
classifier; SKR 2310.05002 finds direct self-knowledge prompting "relatively
poor". The gate therefore classifies the *shape* of the request, which is easy,
and is upgradeable to a trained classifier behind the same one-value interface.

**Plan.** ReWOO 2305.18323: the plan is emitted *before* any observation exists.
That is the strongest transfer result in the literature — 5x fewer tokens and
+4.4% accuracy on average across six benchmarks, and a LoRA-tuned LLaMA-7B
planner matched a 25x larger GPT-3.5. Fixing the plan up front also stops the
loop re-reading a growing trajectory, which is what makes ReAct degrade.

**Search.** One tool only. ReWOO's own failure analysis found 17 of 20
two-tool-vs-seven-tool failures were tool misuse, so tool breadth is a liability,
not a capability. Results are compressed by deterministic code before the model
sees them, and the retrieved payload is capped near 3k tokens because LongMemEval
2410.10813 measures 8B-class models dropping sharply beyond that.

**Stop.** Every termination condition is a *harness counter*: answer emitted,
search cap, retrieved-token cap, LLM-call cap, and a no-new-entities counter.
MAST 2503.13657 names "unaware of stopping conditions" and "step repetition" as
first-class failure modes; the literature's meta-lesson is that these work as
counters, never as instructions to a cheap model.

What we deliberately did **not** build
--------------------------------------
* **No ReAct loop.** Unbounded observe-act cycles are where error compounding
  lives, and with one tool there is nothing to discover mid-loop that the planner
  could not have written down. ReAct alone even loses to plain CoT on HotpotQA
  (27.4 vs 29.4) at PaLM-540B scale; it cannot be expected to hold up on a cheap
  model.
* **No reflexive self-critique.** 2310.01798: models "struggle to self-correct
  their responses without external feedback, and at times their performance might
  even degrade post self-correction". Our one corrective pass is triggered by a
  counter, not by the model's opinion.
* **No ensembling, voting or debate.** 2403.02419 finds compound-system accuracy
  is *non-monotonic* in the number of LM calls — more calls help easy queries and
  hurt hard ones. Debate also costs 2-3x for efficacy "no better than
  self-consistency" at equal sample count.
* **No multi-agent split.** That is the super-agent pattern, and it pays for
  itself only with many concurrent isolated tasks; MAST measures 25% correctness
  for a state-of-the-art multi-agent system, with obvious fixes recovering only
  +14%.
* **No memory tool, no second tool.** Memory is injected automatically. A second
  tool would break the one-tool contract and hand the model another way to fail.
* **No history summarisation on the recall path.** LongMemEval reports that
  replacing sessions with extracted summaries or facts "negatively impacts QA
  performance due to information loss". Recall retrieves verbatim turns.
"""

from __future__ import annotations

import json
import re
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable

from .client import DeepSeekClient, Usage
from .compaction import Compactor, trim_evidence_layer
from .config import Settings
from .memory import Memory, MemoryStore, Turn
from .prompts import (
    SYSTEM_PROMPT,
    answer_prompt,
    direct_answer_prompt,
    gap_prompt,
    index_prompt,
    memory_block,
    plan_prompt,
    recall_prompt,
    route_prompt,
)
from .tools import EvidenceStore, Result, SourceRegistry, run_web_search, validate_citations

# ---------------------------------------------------------------------------
# Tool schema — exactly one tool, strict-mode compatible
# ---------------------------------------------------------------------------

WEB_SEARCH_TOOL = [
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": (
                "Search the live web and return ranked results with titles, URLs, "
                "publication dates and a summary of each page. Use it for facts you "
                "may not know, anything that changes over time, and anything the user "
                "wants sourced. One call searches one query; make the query specific."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": (
                            "The search query, 3 to 12 words, as a search engine expects. "
                            "Operators allowed: site:, \"exact phrase\", after:2025."
                        ),
                    },
                    "recency_sensitive": {
                        "type": "boolean",
                        "description": "True when an outdated answer would be wrong.",
                    },
                },
                "required": ["query", "recency_sensitive"],
                "additionalProperties": False,
            },
        },
    }
]

_JSON_RE = re.compile(r"\{.*\}", re.DOTALL)
ROUTES = ("recall", "direct", "research")


def parse_json(text: str) -> dict:
    """Tolerant JSON extraction.

    Small models sometimes wrap JSON in prose or fences even when told not to.
    We recover what we can and never raise on a parse failure — a failed parse
    degrades to a safe default instead of crashing the turn.
    """
    if not text:
        return {}
    candidate = text.strip()
    if candidate.startswith("```"):
        candidate = re.sub(r"^```[a-zA-Z]*\s*", "", candidate)
        candidate = re.sub(r"\s*```$", "", candidate)
    try:
        return json.loads(candidate)
    except json.JSONDecodeError:
        pass
    m = _JSON_RE.search(candidate)
    if m:
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            pass
    return {}


# ---------------------------------------------------------------------------
# Harness state: the termination authority
# ---------------------------------------------------------------------------


@dataclass
class HarnessState:
    """Counters that decide when the turn stops.

    Split deliberately into two classes of condition:

    * **Hard caps** (`llm_calls`, `search_rounds`, `retrieved_tokens`) truncate
      unconditionally. These bound worst-case cost and latency.
    * **Diminishing returns** (`followup_allowed`) asks whether another search can
      plausibly add anything. A wrong answer here costs one cheap search request;
      the research says a confident unsourced answer costs far more, so the
      default is permissive and only structural signals override it.
    """

    # NOTE: these defaults mirror Settings. Settings is the source of truth and
    # Agent.respond() always passes them explicitly; the duplicated values exist
    # only so the harness is testable in isolation.
    max_llm_calls: int = 5
    max_search_rounds: int = 2
    max_search_requests: int = 4
    max_retrieved_tokens: int = 3_000
    novelty_min: int = 1
    novelty_window: int = 2
    min_results_to_answer: int = 1
    llm_calls: int = 0
    search_rounds: int = 0
    search_requests: int = 0
    retrieved_tokens: int = 0
    new_entities_per_search: list[int] = field(default_factory=list)
    stops: list[str] = field(default_factory=list)
    log: list[dict] = field(default_factory=list)

    # -- accounting --------------------------------------------------------

    def account_search(self, request_count: int, new_entities: int, tokens: int) -> None:
        self.search_rounds += 1
        self.search_requests += request_count
        self.new_entities_per_search.append(new_entities)
        self.retrieved_tokens += tokens

    def account_llm(self, stage: str) -> None:
        self.llm_calls += 1
        self.log.append({"stage": stage, "llm_calls": self.llm_calls})

    # -- stop conditions ---------------------------------------------------

    @property
    def llm_budget_exhausted(self) -> bool:
        return self.llm_calls >= self.max_llm_calls

    @property
    def token_budget_exhausted(self) -> bool:
        return self.retrieved_tokens >= self.max_retrieved_tokens

    def stop(self, reason: str) -> bool:
        self.stops.append(reason)
        return False

    def followup_allowed(self) -> bool:
        """The single gate on another search round. All conditions deterministic."""
        if self.search_rounds >= self.max_search_rounds:
            return False
        if self.search_requests >= self.max_search_requests:
            return False
        if self.llm_budget_exhausted or self.token_budget_exhausted:
            return False
        recent = self.new_entities_per_search[-self.novelty_window :]
        if len(recent) >= self.novelty_window and max(recent) < self.novelty_min:
            # Consecutive searches found no new entities: step repetition.
            return False
        return True

    def exhausted_reason(self) -> str | None:
        if self.llm_budget_exhausted:
            return "llm_call_cap"
        if self.token_budget_exhausted:
            return "retrieved_token_cap"
        if self.search_rounds >= self.max_search_rounds:
            return "search_round_cap"
        return None

    def as_dict(self) -> dict:
        return {
            "llm_calls": self.llm_calls,
            "search_rounds": self.search_rounds,
            "search_requests": self.search_requests,
            "retrieved_tokens": self.retrieved_tokens,
            "new_entities_per_search": self.new_entities_per_search,
            "stops": self.stops,
            "exhausted": self.exhausted_reason(),
        }


# ---------------------------------------------------------------------------
# Conversation state
# ---------------------------------------------------------------------------


@dataclass
class Conversation:
    index: int
    user: str
    assistant: str = ""
    route: str = ""
    route_query: str = ""
    plan: dict = field(default_factory=dict)
    queries: list[str] = field(default_factory=list)
    n_results: int = 0
    citation_check: dict = field(default_factory=dict)
    harness: dict = field(default_factory=dict)
    recall_extracts: int = 0
    retrieval_check: dict = field(default_factory=dict)
    compaction: list[dict] = field(default_factory=list)
    latency_ms: float = 0.0
    errors: list[str] = field(default_factory=list)
    _evidence_block: str = ""


# ---------------------------------------------------------------------------
# Agent
# ---------------------------------------------------------------------------


class Agent:
    def __init__(
        self,
        settings: Settings | None = None,
        *,
        conversation_id: str = "default",
        memory: Memory | None = None,
        usage: Usage | None = None,
        trace: Callable[[str, Any], None] | None = None,
    ):
        self.s = settings or Settings.from_env()
        self.conversation_id = conversation_id
        self.client = DeepSeekClient(self.s, usage=usage)
        self.usage = self.client.usage

        store = MemoryStore(self.s.memory_dir)
        self.store = store
        self.memory = memory if memory is not None else store.load(conversation_id)
        self.registry = self._load_registry(conversation_id)
        self.compactor = Compactor(self.s, self.memory, cache_dir=self.s.memory_dir / "summaries")
        self.conversations: list[Conversation] = []
        self._trace = trace
        self._json_mode_supported = True

    def _load_registry(self, conversation_id: str) -> SourceRegistry:
        p = self.s.memory_dir / f"{conversation_id}.sources.json"
        if p.exists():
            try:
                return SourceRegistry.from_json(json.loads(p.read_text(encoding="utf-8")))
            except (json.JSONDecodeError, OSError, TypeError):
                pass
        return SourceRegistry()

    # -- lifecycle ---------------------------------------------------------

    def close(self) -> None:
        self.save()
        self.client.close()

    def __enter__(self) -> "Agent":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def save(self) -> None:
        self.store.save(self.conversation_id, self.memory)
        try:
            (self.s.memory_dir / f"{self.conversation_id}.sources.json").write_text(
                json.dumps(self.registry.to_json()), encoding="utf-8"
            )
        except OSError:
            pass

    def _log(self, event: str, payload: Any) -> None:
        if self._trace:
            self._trace(event, payload)
        if self.s.verbose:
            print(f"[{event}] {json.dumps(payload, default=str)[:400]}")

    # -- context assembly --------------------------------------------------

    def _recent_exchanges(self) -> list[tuple[str, str]]:
        return [(c.user, c.assistant) for c in self.conversations if c.assistant]

    def _memory_block(self, question: str) -> str:
        recalled = [t.brief(400) for t in self.memory.recall(question, k=3, exclude_last=1)]
        return memory_block(
            self.memory.render_summary(),
            recalled,
            self._recent_exchanges(),
            max_exchanges=self.s.keep_recent_turns,
        )

    def _base_messages(self) -> list[dict]:
        """The cacheable prefix: system prompt + verbatim recent turns.

        The system prompt is byte-identical for the lifetime of the agent and
        older context lives in the memory block inside each user message, so this
        prefix only ever grows by appending. That is what makes prompt caching
        actually hit, which at a 5x hit/miss price gap is the largest single cost
        lever we have.
        """
        msgs: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT}]
        for c in self.conversations[-self.s.keep_recent_turns:]:
            msgs.append({"role": "user", "content": c.user, "_turn": c.index})
            if c.assistant:
                msgs.append({"role": "assistant", "content": c.assistant, "_turn": c.index})
        return msgs

    # -- stage 1: gate -----------------------------------------------------

    def _route(self, question: str, memory: str) -> dict:
        fallback = {"route": "research", "query": question[:96], "reason": "gate unavailable"}
        if not self.s.enable_router:
            return fallback
        today = time.strftime("%Y-%m-%d") if self.s.include_date_in_router else None
        try:
            res = self.client.chat(
                [{"role": "system", "content": SYSTEM_PROMPT},
                 {"role": "user", "content": route_prompt(question, memory, today)}],
                stage="route",
                temperature=self.s.temperature_decide,
                max_tokens=200,
                thinking=False,
                response_format={"type": "json_object"} if self._json_mode_supported else None,
            )
        except Exception as e:
            self._log("route_error", str(e))
            fallback["reason"] = f"gate error: {type(e).__name__}"
            return fallback

        if not res.content and self._json_mode_supported:
            self._json_mode_supported = False
            return self._route(question, memory)

        data = parse_json(res.content)
        route = str(data.get("route") or "").strip().lower()
        if route not in ROUTES:
            # An out-of-enum answer is treated as "research": the safe direction,
            # because a needless search costs one cheap request while a missed one
            # produces an unsourced claim.
            fallback["reason"] = f"out-of-enum route {route!r}"
            return fallback
        return {
            "route": route,
            "query": str(data.get("query") or "").strip()[:120],
            "reason": "",
        }

    # -- stage 2: plan -----------------------------------------------------

    def _plan(self, question: str, memory: str, route: str) -> dict:
        fallback = {
            "search_queries": [{"query": question[:96], "why": "fallback: raw question"}],
            "answer_checklist": [],
            "needs_recency": False,
        }
        if not self.s.enable_planning:
            return fallback
        try:
            res = self.client.chat(
                [{"role": "system", "content": SYSTEM_PROMPT},
                 {"role": "user", "content": plan_prompt(question, memory, route)}],
                stage="plan",
                temperature=self.s.temperature_plan,
                max_tokens=self.s.max_tokens_plan,
                thinking=False,
                response_format={"type": "json_object"} if self._json_mode_supported else None,
            )
        except Exception as e:
            self._log("plan_error", str(e))
            return fallback

        data = parse_json(res.content) or {}
        queries: list[dict] = []
        for q in data.get("search_queries") or []:
            if isinstance(q, str):
                q = {"query": q, "why": ""}
            if not isinstance(q, dict):
                continue
            text = str(q.get("query") or "").strip()
            if text:
                queries.append({"query": text[:120], "why": str(q.get("why") or "")[:80]})
        if not queries:
            return fallback

        seen: set[str] = set()
        unique: list[dict] = []
        for q in queries:
            key = " ".join(sorted(set(re.findall(r"[a-z0-9]+", q["query"].lower()))))
            if key in seen:
                continue
            seen.add(key)
            unique.append(q)
        return {
            "search_queries": unique[: self.s.max_queries_per_plan],
            "answer_checklist": [
                str(c)[:120] for c in (data.get("answer_checklist") or []) if str(c).strip()
            ][:4],
            "needs_recency": bool(data.get("needs_recency")),
        }

    # -- stage 3: retrieve -------------------------------------------------

    def _retrieve(
        self,
        queries: list[dict],
        *,
        ori_question: str,
        store: EvidenceStore,
        harness: HarnessState,
        round_index: int,
    ) -> int:
        """Execute queries concurrently and account for them.

        Search QPS is 100/account, so a small thread pool is safe and buys back
        most of the latency. Returns the number of new entities added, which is
        the signal the novelty counter uses.
        """
        def one(q: dict):
            return run_web_search(
                self.client, self.s, q["query"],
                ori_question=ori_question, count=self.s.results_per_query,
            )

        before_keys = {r.key for r in store.results()}
        before_ents = _entity_set(store.results())
        with ThreadPoolExecutor(max_workers=min(4, max(1, len(queries)))) as pool:
            outcomes = list(pool.map(one, queries))
        for outcome in outcomes:
            store.add_outcome(outcome)
            self._log("search", {
                "query": outcome.query, "round": round_index,
                "n": len(outcome.results), "error": outcome.error,
            })

        after_ents = _entity_set(store.results())
        new_entities = len(after_ents - before_ents)
        tokens = sum(r_tokens for r_tokens in _result_tokens(store.results()))
        harness.account_search(len(queries), new_entities, tokens)
        self._log("harness", {"round": round_index, "new_entities": new_entities,
                             "new_results": len(store) - len(before_keys),
                             "retrieved_tokens": harness.retrieved_tokens})
        return new_entities

    # -- stage 3b: one harness-triggered corrective query ------------------

    def _corrective_query(
        self, question: str, checklist: list[str], store: EvidenceStore, uncovered: list[str]
    ) -> str:
        """Only the *query wording* is delegated to the model here. The decision to
        look again was already made by HarnessState.followup_allowed()."""
        try:
            res = self.client.chat(
                [{"role": "system", "content": SYSTEM_PROMPT},
                 {"role": "user", "content": gap_prompt(
                     question, checklist, uncovered, store.digest(), store.queries
                 )}],
                stage="requery",
                temperature=0.0,
                max_tokens=160,
                thinking=False,
                response_format={"type": "json_object"} if self._json_mode_supported else None,
            )
        except Exception as e:
            self._log("requery_error", str(e))
            return ""
        data = parse_json(res.content) or {}
        q = str(data.get("followup_query") or "").strip()[:120]
        if q and any(_query_echoes(q, used) for used in store.queries):
            return ""      # a repeat would waste a search request
        return q

    # -- stage 4: synthesise -----------------------------------------------

    def _synthesise(self, question: str, store: EvidenceStore, checklist: list[str]) -> str:
        notes = ""
        if store.errors:
            notes = "Some searches failed: " + "; ".join(store.errors[:3])
        elif store.empty_queries:
            notes = "Some searches returned nothing: " + "; ".join(store.empty_queries[:3])
        res = self.client.chat(
            [{"role": "system", "content": SYSTEM_PROMPT},
             {"role": "user", "content": answer_prompt(question, store.block(), checklist, notes=notes)}],
            stage="answer",
            temperature=self.s.temperature_answer,
            max_tokens=self.s.max_tokens_answer,
            thinking=self.s.enable_thinking_on_answer,
        )
        return res.content

    def _answer_direct(self, question: str, memory: str, route: str) -> str:
        res = self.client.chat(
            [{"role": "system", "content": SYSTEM_PROMPT},
             {"role": "user", "content": direct_answer_prompt(question, memory, route)}],
            stage="direct",
            temperature=self.s.temperature_answer,
            max_tokens=self.s.max_tokens_answer,
            thinking=False,
        )
        return res.content

    def _answer_recall(self, question: str) -> tuple[str, int]:
        """Verbatim retrieval, then a quote-faithfully answer.

        LongMemEval: replacing sessions with summaries or facts hurts QA through
        information loss, so this path never answers from the summary alone when
        verbatim extracts exist.
        """
        hits = self.memory.index.search(question, k=self.s.recall_k + 2, exclude_last=0)
        # The current question can rank first for a recall query, since a memory
        # question restates what it is asking about. Feeding the user's own words
        # back to them as though they had said them earlier is both misleading and
        # a waste of tokens, so drop near-echoes of the question.
        hits = [t for t in hits if not _query_echoes(t.user, question)][: self.s.recall_k]
        if not hits:
            hits = self.memory.index.turns[-self.s.recall_k :] if self.memory.index.turns else []
        excerpts = [
            f"Turn {t.index}\nUser: {t.user}\nYou: {t.assistant[:900]}"
            for t in hits
        ]
        res = self.client.chat(
            [{"role": "system", "content": SYSTEM_PROMPT},
             {"role": "user", "content": recall_prompt(
                 question, excerpts, self.memory.render_summary()
             )}],
            stage="recall",
            temperature=0.0,
            max_tokens=700,
            thinking=False,
        )
        return res.content, len(excerpts)

    # -- post-turn bookkeeping ---------------------------------------------

    def _index_turn(self, question: str, answer: str, turn_index: int) -> None:
        """Extract retrieval keys and durable user facts. One cheap call, and the
        only thing that makes recall questions answerable later."""
        entities: list[str] = []
        topics: list[str] = []
        user_fact = ""
        try:
            res = self.client.chat(
                [{"role": "system", "content": SYSTEM_PROMPT},
                 {"role": "user", "content": index_prompt(question, answer)}],
                stage="index",
                temperature=0.0,
                max_tokens=300,
                thinking=False,
                response_format={"type": "json_object"} if self._json_mode_supported else None,
            )
            data = parse_json(res.content) or {}
            entities = [str(e)[:60] for e in (data.get("entities") or [])][:6]
            topics = [str(t).lower()[:40] for t in (data.get("topics") or [])][:4]
            if data.get("is_user_fact"):
                user_fact = str(data.get("durable_fact") or "")[:240]
        except Exception as e:
            self._log("index_error", str(e))

        if user_fact:
            self.memory.facts.add_many(
                [{"claim": user_fact, "confidence": "verified", "topic": ",".join(topics)}],
                turn=turn_index,
            )
        self.memory.index.add(Turn(
            index=turn_index, user=question, assistant=answer,
            entities=entities, topics=topics, user_fact=user_fact,
        ))

    # -- the loop ----------------------------------------------------------

    def respond(self, question: str) -> Conversation:
        started = time.perf_counter()
        turn_index = self.memory.next_turn()
        conv = Conversation(index=turn_index, user=question)
        harness = HarnessState(
            max_llm_calls=self.s.max_llm_calls_per_turn,
            max_search_rounds=self.s.max_search_rounds,
            max_search_requests=self.s.max_search_requests_per_turn,
            max_retrieved_tokens=self.s.max_retrieved_tokens,
        )

        # 1. Compact at the turn boundary, never mid-step. Cheapest layer first.
        base = self._base_messages()
        for report in self.compactor.enforce(self.client, base, self.conversations, question):
            conv.compaction.append(report.as_dict())
            self._log("compaction", report.as_dict())

        mem = self._memory_block(question)
        store = EvidenceStore(self.s, self.registry)

        # 2. Gate.
        route = self._route(question, mem)
        harness.account_llm("route")
        conv.route = route["route"]
        conv.route_query = route["query"]
        self._log("route", route)

        if route["route"] in ("direct", "recall"):
            try:
                if route["route"] == "recall":
                    conv.assistant, conv.recall_extracts = self._answer_recall(question)
                    harness.account_llm("recall")
                else:
                    conv.assistant = self._answer_direct(question, mem, "direct")
                    harness.account_llm("direct")
            except Exception as e:
                conv.errors.append(f"{route['route']} answer failed: {type(e).__name__}: {e}")
                conv.assistant = "I could not produce an answer for that. Please try again."
        else:
            # 3. Plan once, without observations (ReWOO).
            plan = self._plan(question, mem, route["route"])
            conv.plan = plan
            harness.account_llm("plan")
            checklist = plan.get("answer_checklist") or []

            self._retrieve(
                plan["search_queries"], ori_question=question, store=store,
                harness=harness, round_index=1,
            )
            trim_evidence_layer(
                store, question,
                per_result_tokens=int(self.s.per_result_token_cap * 0.5),
            )

            # 4. At most one corrective pass, decided by counters.
            if self.s.enable_corrective and harness.followup_allowed() and checklist:
                uncovered = self._uncovered(checklist, store)
                if uncovered:
                    self._log("corrective", {"uncovered": uncovered})
                    q = self._corrective_query(question, checklist, store, uncovered)
                    harness.account_llm("requery")
                    if q:
                        self._retrieve(
                            [{"query": q, "why": "harness-detected gap"}],
                            ori_question=question, store=store,
                            harness=harness, round_index=2,
                        )
                        trim_evidence_layer(
                            store, question,
                            per_result_tokens=int(self.s.per_result_token_cap * 0.5),
                        )
                else:
                    harness.stop("checklist_covered_after_round_1")
            else:
                harness.stop(harness.exhausted_reason() or "no_followup_needed")

            # 5. Deterministic relevance gate before spending a generation.
            # Assess against the standalone question (pronouns resolved) rather
            # than the raw message, so "what about that paper?" is judged on what
            # it is actually asking for.
            verdict = self.assess_retrieval(route.get("query") or question, store)
            conv.retrieval_check = verdict
            self._log("retrieval_gate", verdict)

            # 6. Synthesise from compressed evidence only.
            if len(store) >= harness.min_results_to_answer and verdict["usable"]:
                conv._evidence_block = store.block()
                try:
                    conv.assistant = self._synthesise(question, store, checklist)
                    harness.account_llm("answer")
                except Exception as e:
                    conv.errors.append(f"synthesis failed: {type(e).__name__}: {e}")
                    conv.assistant = self._fallback_answer(store, e)
                conv.citation_check = validate_citations(conv.assistant, store)
                harness.stop("answer_emitted")
            else:
                # The gate said search, but the evidence is absent or irrelevant.
                # Say so rather than fabricating: honest failure is a scored
                # outcome, not an accident.
                conv.errors.append(f"no usable evidence ({verdict['reason']})")
                conv.assistant = self._no_evidence_answer(store, verdict)
                harness.stop(f"no_usable_evidence:{verdict['reason']}")

        conv.queries = list(store.queries)
        conv.n_results = len(store)
        conv.harness = harness.as_dict()

        # 6. Bookkeeping — the last model call, and not on the answer path.
        if not harness.llm_budget_exhausted:
            try:
                self._index_turn(question, conv.assistant, turn_index)
                harness.account_llm("index")
            except Exception as e:
                conv.errors.append(f"indexing failed: {type(e).__name__}: {e}")
        else:
            # Still record the turn verbatim, just without extracted keys.
            self.memory.index.add(Turn(
                index=turn_index, user=question, assistant=conv.assistant
            ))
            harness.stop("index_skipped_budget")

        conv.harness = harness.as_dict()
        self.conversations.append(conv)
        self.save()
        conv.latency_ms = (time.perf_counter() - started) * 1000
        return conv

    # -- deterministic retrieval relevance gate ----------------------------

    def assess_retrieval(self, question: str, store: EvidenceStore) -> dict:
        """Decide, without a model, whether the retrieved evidence is usable.

        Two independent signals, either of which is sufficient:

        * **Rank**: the API's own `rerank_score` blends relevance, authority and
          freshness; the docs call >= 1.5 high quality. A page scoring well below
          that is not an answer to this question.
        * **Overlap**: distinctive question terms appearing in the retrieved text.
          This catches the case where the search engine returns confidently-ranked
          pages about something else entirely.

        Deliberately lexical and dependency-free, because the whole point is to be
        able to run it *before* spending a generation. A miss here routes to the
        honest-failure path rather than to a fluent guess.
        """
        results = store.results()
        if not results:
            return {"usable": False, "reason": "no_results", "best_rerank": 0.0, "best_overlap": 0.0}
        if not self.s.enable_relevance_gate:
            # Ablation only: accept whatever was retrieved. This exists so the
            # gate's contribution is measured rather than assumed.
            return {
                "usable": True, "reason": "gate_disabled",
                "best_rerank": round(max(r.rerank_score for r in results), 3),
                "best_overlap": 0.0, "n_results": len(results),
            }

        best_rerank = max(r.rerank_score for r in results)
        qterms = {t for t in _canon_terms(question) if len(t) > 3}
        best_overlap = 0.0
        for r in results:
            rterms = set(_canon_terms(f"{r.title} {r.text}"))
            if qterms and rterms:
                # Overlap coefficient, not Jaccard against the query. A question
                # phrased as "what does X imply for Y" contains words that no
                # relevant page will literally repeat ("imply"), and dividing by
                # the full query made one unmatched function word veto an
                # otherwise perfect result. This measures how much of the
                # *result's* vocabulary the question reaches into, which is the
                # question actually being asked: is this page about the query.
                best_overlap = max(
                    best_overlap, len(qterms & rterms) / max(1, min(len(qterms), len(rterms)))
                )

        rank_ok = best_rerank >= self.s.min_usable_rerank
        overlap_ok = (not qterms) or best_overlap >= self.s.min_query_overlap
        usable = rank_ok and overlap_ok
        reason = "ok"
        if not usable:
            reason = "low_rank" if not rank_ok else "low_overlap"
        return {
            "usable": usable,
            "reason": reason,
            "best_rerank": round(best_rerank, 3),
            "best_overlap": round(best_overlap, 3),
            "n_results": len(results),
        }

    # -- deterministic checklist coverage ----------------------------------

    def _uncovered(self, checklist: list[str], store: EvidenceStore) -> list[str]:
        """Lexical coverage check on the plan's own checklist — no model call.

        An item is covered if a sufficient share of its distinctive terms appear
        anywhere in the evidence. Crude, but it is deterministic, free, and the
        literature is clear that the alternative (asking the model whether its
        evidence suffices) is exactly the judgement small models get wrong.
        """
        haystack = _canon_terms(" ".join(r.title + " " + r.text for r in store.results()))
        uncovered: list[str] = []
        for item in checklist:
            needles = [t for t in _canon_terms(item) if len(t) > 2]
            if not needles:
                continue
            hit = sum(1 for n in needles if n in haystack)
            if hit / len(needles) < self.s.checklist_coverage_threshold:
                uncovered.append(item)
        return uncovered

    # -- degraded paths ----------------------------------------------------

    def _fallback_answer(self, store: EvidenceStore, err: Exception) -> str:
        """If synthesis fails, hand the user the evidence rather than nothing."""
        top = store.results()[:3]
        if not top:
            return f"I found sources but could not write the answer ({type(err).__name__})."
        lines = [f"I hit an error writing the answer ({type(err).__name__}), "
                 "but found these sources:"]
        for r in top:
            when = f" ({r.date[:10]})" if r.date else ""
            lines.append(f"- {r.title}{when} — {r.url}")
        return "\n".join(lines)

    def _no_evidence_answer(self, store: EvidenceStore, verdict: dict | None = None) -> str:
        if store.errors:
            detail = "; ".join(store.errors[:2])
            return ("The search did not succeed, so I cannot answer this reliably. "
                    f"({detail}) Please try again, or rephrase the question.")
        tried = ", ".join(f"“{q}”" for q in store.queries[:3])
        if verdict and verdict.get("reason") == "low_overlap":
            return (f"I searched ({tried}) but the results I found are not about your question, "
                    "so I have no reliable answer. I will not guess. If you can give an exact "
                    "name, date or spelling, I will search again.")
        return (f"I searched ({tried}) and found nothing usable, so I will not guess. "
                "If you can give a more specific name, date or spelling, I will search again.")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_URL_ENTITY_RE = re.compile(r"\b(?:[A-Z][A-Za-z0-9.&'-]{2,}|[A-Z]{2,}|\d+(?:\.\d+)+)\b")


def _entity_set(results: list[Result]) -> set[str]:
    """Cheap entity extraction (capitalised tokens, acronyms, version numbers).

    Used only as a *novelty* signal for the stop counter, so recall matters more
    than precision: an over-eager extractor makes the counter more permissive,
    which is the safe direction.
    """
    ents: set[str] = set()
    for r in results:
        for m in _URL_ENTITY_RE.findall(f"{r.title} {r.text[:400]}"):
            ents.add(m.lower())
    return ents


def _result_tokens(results: list[Result]) -> list[int]:
    from .config import estimate_tokens

    return [estimate_tokens(r.text) + estimate_tokens(r.title) for r in results]


def _terms(text: str) -> set[str]:
    from .memory import terms

    return set(terms(text))


def _canon_terms(text: str) -> set[str]:
    """Comparison tokens: hyphen-split and punctuation-stripped."""
    from .memory import canon_terms

    return set(canon_terms(text))


def _query_echoes(candidate: str, used: str) -> bool:
    """True when a candidate query is essentially a repeat of one already used."""
    a, b = _canon_terms(candidate), _canon_terms(used)
    if not a or not b:
        return False
    return len(a & b) / max(1, min(len(a), len(b))) > 0.8


def build_agent(**kwargs) -> Agent:
    return Agent(**kwargs)
