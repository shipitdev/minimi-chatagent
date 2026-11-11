"""Runtime configuration for the minimi chat agent.

Everything is env-driven so the same code runs locally, in eval, and in CI.
No secrets are ever written to disk by this module.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[2]


def load_dotenv(path: Path | None = None) -> None:
    """Minimal .env loader. Does not override already-exported variables."""
    path = path or (PACKAGE_ROOT / ".env")
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


@dataclass
class Settings:
    """All tunables for the agent. Defaults are the 'balanced' operating point."""

    # --- credentials / endpoints -------------------------------------------
    api_key: str = ""
    base_url: str = "https://api.deepseek.com"
    beta_base_url: str = "https://api.deepseek.com/beta"

    # --- models -------------------------------------------------------------
    model: str = "deepseek-flash"          # served by DeepSeek-V4.1-Flash-1017
    planner_model: str = "deepseek-flash"  # same weights, different prompt

    # --- retrieval budget ---------------------------------------------------
    # Search costs $0.75 / 1k successful requests and `count` is free, so we
    # over-fetch per query and filter client-side.
    results_per_query: int = 8
    max_queries_per_plan: int = 3
    max_search_rounds: int = 2
    # Sized so a full first plan (max_queries_per_plan) still leaves room for the
    # one corrective query the research prescribes (4 = 3 plan queries + 1 fix).
    # A tighter cap silently disables the corrective pass entirely.
    max_search_requests_per_turn: int = 4
    max_llm_calls_per_turn: int = 5
    # LongMemEval 2410.10813: 8B-class readers "drop sharply beyond 3k retrieved
    # tokens". This is the budget that actually matters for answer quality, and it
    # is deliberately far below anything the model window would allow.
    max_retrieved_tokens: int = 3_000
    # Lexical coverage of the plan's checklist before the harness spends another
    # search request. Deterministic, so it cannot drift between runs.
    checklist_coverage_threshold: float = 0.45
    recall_k: int = 6
    # --- deterministic retrieval relevance gate ---
    # Measured problem: a search for something that does not exist returns
    # plausible-looking low-authority pages, and a cheap model will happily write
    # a confident answer from them. The literature's remedy is a *cheap*
    # pre-generation gate (CRAG 2401.15884 uses a 0.77B evaluator for exactly
    # this), and a lexical one needs no model at all. If nothing retrieved is both
    # reasonably ranked AND lexically overlapping with the question, we treat the
    # evidence as unusable and say so.
    min_usable_rerank: float = 1.0
    min_query_overlap: float = 0.15
    min_rerank_score: float = 0.0          # client-side quality floor
    prefer_authority: int = 2              # authority >= this is "strong"

    # --- context management -------------------------------------------------
    # Token budget the compactor targets for the whole prompt (excluding the
    # completion). Kept well under the model window on purpose: the whole point
    # of this architecture is that we refuse to need long context.
    context_budget_tokens: int = 12_000
    reserve_output_tokens: int = 1_200
    keep_recent_turns: int = 4             # verbatim tail window
    summarize_chunk_turns: int = 6         # turns folded per summary step
    evidence_token_cap: int = 2_600        # cap on injected search evidence
    per_result_token_cap: int = 450        # cap on one search result's text
    max_compactions_in_a_row: int = 3

    # --- generation ---------------------------------------------------------
    temperature_decide: float = 0.0
    temperature_plan: float = 0.4
    temperature_answer: float = 0.3
    max_tokens_decide: int = 400
    max_tokens_plan: int = 700
    max_tokens_answer: int = 1_600
    request_timeout_s: float = 90.0
    max_retries: int = 3

    # --- behaviour toggles (eval ablations) ---------------------------------
    enable_router: bool = True             # narrow-enum gate vs always-search
    enable_planning: bool = True           # multi-query plan before searching
    enable_corrective: bool = True         # one harness-triggered re-query
    enable_relevance_gate: bool = True     # deterministic pre-generation evidence check
    enable_thinking_on_answer: bool = False
    strict_tools: bool = True              # beta strict-mode JSON schema
    use_ori_question: bool = True          # pass user's raw question to Search
    cache_bust: bool = False               # test-only: break prefix caching
    mock_latency_s: float = 0.006           # scripted-backend latency simulation

    # --- memory -------------------------------------------------------------
    memory_dir: Path = field(default_factory=lambda: PACKAGE_ROOT / "runs")

    # --- logging ------------------------------------------------------------
    trace: bool = False
    verbose: bool = False

    # --- pricing (USD per 1M tokens, USD per request) -----------------------
    # Defaults are the "idle" tier ($1/M cache-miss in, $4/M out, 5 yuan/1k search
    # at ~7.1 CNY/USD). Peak is exactly 2x on every model line, so there is one
    # multiplier rather than a second table.
    price_in_miss: float = 0.14
    price_in_hit: float = 0.028
    price_out: float = 0.56
    price_per_search: float = 0.00075
    price_per_fetch: float = 0.00075

    # The router/planner/answer all build on the same system prompt, so moving
    # the real date into the (uncached) per-call instruction keeps the cached
    # prefix byte-identical while still letting the model reason about recency.
    include_date_in_router: bool = True

    def estimate_cost(self, usage) -> dict:
        if hasattr(usage, "as_dict"):
            u = usage.as_dict()
        else:
            u = usage
        cost_in_miss = u.get("cache_miss_tokens", 0) / 1e6 * self.price_in_miss
        cost_in_hit = u.get("cache_hit_tokens", 0) / 1e6 * self.price_in_hit
        cost_out = u.get("completion_tokens", 0) / 1e6 * self.price_out
        cost_search = u.get("search_requests", 0) * self.price_per_search
        cost_fetch = u.get("fetch_requests", 0) * self.price_per_fetch
        total = cost_in_miss + cost_in_hit + cost_out + cost_search + cost_fetch
        # Cost if nothing had been cached: isolates the value of the stable prefix.
        naive = (u.get("prompt_tokens", 0) / 1e6 * self.price_in_miss) + cost_out + cost_search + cost_fetch
        return {
            "input_miss_usd": round(cost_in_miss, 6),
            "input_hit_usd": round(cost_in_hit, 6),
            "output_usd": round(cost_out, 6),
            "search_usd": round(cost_search, 6),
            "fetch_usd": round(cost_fetch, 6),
            "total_usd": round(total, 6),
            "no_cache_baseline_usd": round(naive, 6),
            "cache_saving_usd": round(naive - total, 6),
        }

    # Keys that Usage.as_dict() actually emits. Kept as a constant so a rename in
    # one place cannot silently zero out a metric in the other: reading a key that
    # does not exist returns 0 rather than raising, which is how `completion_calls`
    # reported 0 for every run while tokens accounted correctly.
    _USAGE_KEYS = (
        "prompt_tokens", "completion_tokens", "cache_hit_tokens",
        "cache_miss_tokens", "reasoning_tokens", "completion_calls",
        "search_requests", "fetch_requests", "search_results",
    )

    def usage_delta(self, before: dict, after: dict) -> dict:
        """Difference between two Usage snapshots, then priced."""
        missing = [k for k in self._USAGE_KEYS if k not in after]
        if missing:
            raise KeyError(
                f"usage snapshot is missing {missing}; Usage.as_dict() keys changed "
                "and every metric depending on them would silently read zero"
            )
        delta = {k: (after.get(k, 0) - before.get(k, 0)) for k in self._USAGE_KEYS}
        priced = self.estimate_cost(delta)
        delta["calls"] = delta["completion_calls"]
        delta.update({f"cost_{k}": v for k, v in priced.items()})
        return delta

    @classmethod
    def from_env(cls, **overrides) -> "Settings":
        load_dotenv()
        s = cls(
            api_key=os.environ.get("DEEPSEEK_API_KEY", ""),
            base_url=os.environ.get("DEEPSEEK_BASE_URL", cls.base_url),
            beta_base_url=os.environ.get("DEEPSEEK_BETA_BASE_URL", cls.beta_base_url),
            model=os.environ.get("MINIMI_MODEL", cls.model),
            context_budget_tokens=int(os.environ.get("MINIMI_CONTEXT_BUDGET", cls.context_budget_tokens)),
            trace=os.environ.get("MINIMI_TRACE", "").lower() in {"1", "true", "yes"},
            verbose=os.environ.get("MINIMI_VERBOSE", "").lower() in {"1", "true", "yes"},
        )
        for k, v in overrides.items():
            if v is None:
                continue
            if not hasattr(s, k):
                raise TypeError(f"unknown setting: {k}")
            setattr(s, k, v)
        return s

    def require_key(self) -> str:
        if not self.api_key:
            raise SystemExit(
                "DEEPSEEK_API_KEY is not set.\n"
                "  export DEEPSEEK_API_KEY=sk-...   (or put it in .env)\n"
                "  Get one at https://platform.deepseek.com/api_keys"
            )
        return self.api_key


# ---------------------------------------------------------------------------
# Approximate token accounting.
#
# We deliberately avoid a tokenizer dependency: the compactor only needs to be
# roughly right and slightly conservative. ~4 chars/token for English prose,
# which under-estimates CJK badly, so non-ASCII characters are priced higher.
# ---------------------------------------------------------------------------


def estimate_tokens(text: str) -> int:
    if not text:
        return 0
    ascii_chars = sum(1 for c in text if ord(c) < 128)
    non_ascii = len(text) - ascii_chars
    return int(ascii_chars / 3.6) + non_ascii + 4


def estimate_message_tokens(msg: dict) -> int:
    total = 4
    content = msg.get("content")
    if isinstance(content, str):
        total += estimate_tokens(content)
    elif isinstance(content, list):
        for block in content:
            if isinstance(block, dict):
                total += estimate_tokens(str(block.get("text", "")))
    for call in msg.get("tool_calls") or []:
        total += estimate_tokens(str(call))
    return total


def estimate_prompt_tokens(messages: list[dict]) -> int:
    return sum(estimate_message_tokens(m) for m in messages) + 8
