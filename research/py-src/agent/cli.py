"""Interactive CLI and one-shot runner.

    python -m src.agent.cli                       # interactive
    python -m src.agent.cli -q "..." --trace      # one question
    python -m src.agent.cli --selftest            # no-network sanity checks
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from src.agent.agent import Agent
from src.agent.config import Settings
from src.agent.tools import SourceRegistry

DIM = "\033[2m"
BOLD = "\033[1m"
CYAN = "\033[36m"
RESET = "\033[0m"


def _trace_printer(event: str, payload) -> None:
    icon = {
        "route": "◇", "plan": "◇", "search": "⌕", "gap_check": "?",
        "compaction": "⇩", "layerA": "⇩", "gap_followup": "↻",
    }.get(event, "·")
    if event == "route":
        print(f"{DIM}  {icon} {payload.get('task_type')} · search={payload.get('needs_search')} "
              f"· {payload.get('reason','')}{RESET}")
    elif event == "search":
        print(f"{DIM}  {icon} “{payload['query']}” → {payload['n']} results"
              f"{' ERROR ' + str(payload['error']) if payload.get('error') else ''}{RESET}")
    else:
        print(f"{DIM}  {icon} {event}: {json.dumps(payload, default=str)[:220]}{RESET}")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="minimi", description="single-tool web-search chat agent")
    p.add_argument("-q", "--question", help="ask one question and exit")
    p.add_argument("-c", "--conversation", default="cli", help="conversation id (memory key)")
    p.add_argument("--trace", action="store_true", help="show routing/planning/search decisions")
    p.add_argument("-v", "--verbose", action="store_true")
    p.add_argument("--budget", type=int, default=None, help="context budget in tokens")
    p.add_argument("--no-router", action="store_true", help="always search (ablation)")
    p.add_argument("--no-planning", action="store_true", help="search the raw question only")
    p.add_argument("--no-corrective", action="store_true",
                   help="disable the harness-triggered corrective re-query")
    p.add_argument("--stats", action="store_true", help="print usage/cost accounting")
    p.add_argument("--reset", action="store_true", help="forget this conversation's memory")
    p.add_argument("--selftest", action="store_true", help="run offline checks and exit")
    return p


def print_stats(agent: Agent) -> None:
    u = agent.usage.as_dict()
    inp_miss = u["cache_miss_tokens"] / 1e6 * 0.14
    inp_hit = u["cache_hit_tokens"] / 1e6 * 0.028
    out = u["completion_tokens"] / 1e6 * 0.56
    search = u["search_requests"] * 0.00075
    fetch = u["fetch_requests"] * 0.00075
    total = inp_miss + inp_hit + out + search + fetch
    print(f"\n{BOLD}usage{RESET}")
    print(f"  prompt {u['prompt_tokens']:>7,} tok  (cache hit {u['cache_hit_rate']*100:5.1f}%)"
          f"   completion {u['completion_tokens']:>6,} tok")
    print(f"  llm calls {u['completion_calls']}   searches {u['search_requests']}"
          f"   results {u['search_results']}")
    print(f"  latency {u['latency_ms']/1000:.1f}s")
    print(f"  {BOLD}est. cost ${total:.5f}{RESET}  "
          f"{DIM}(idle-tier; in ${inp_hit:.5f} · out ${out:.5f} · search ${search + fetch:.5f}){RESET}")
    print(f"  compaction: {json.dumps(agent.compactor.instrument()['thresholds'])}")


def selftest() -> int:
    """Offline checks for the pieces that must not depend on the network."""
    from src.agent.compaction import (
        dedupe_near, evict_weak, query_overlap_snippet, Thresholds,
    )
    from src.agent.config import estimate_tokens
    from src.agent.memory import Fact, FactLog, Memory, SummaryChain, SummaryBlock, TurnIndex, Turn
    from src.agent.tools import EvidenceStore, EvidenceStore as ES, Result, SourceRegistry

    failures: list[str] = []

    def check(name: str, cond: bool, extra: str = "") -> None:
        if cond:
            print(f"  ok   {name}")
        else:
            failures.append(name)
            print(f"  FAIL {name} {extra}")

    s = Settings()
    print(f"{BOLD}offline selftest{RESET}")

    # token estimator monotonic and sane
    check("token estimate scales", estimate_tokens("a" * 360) > estimate_tokens("a" * 36))
    check("token estimate non-ascii",
          estimate_tokens("你好世界你好世界") >= 8)

    # thresholds
    t = Thresholds.from_settings(Settings(context_budget_tokens=10_000, reserve_output_tokens=1_000))
    check("budget = window - reserve", t.budget == 9_000, str(t))
    check("soft < hard < budget", t.soft < t.hard < t.budget)

    # query-overlap extraction keeps the relevant sentence
    doc = ("The company was founded in 1998 in Oslo. "
           "Unrelated filler about the weather and shipping lanes. "
           "Revenue for the fiscal year was 4.2 billion dollars.")
    out = query_overlap_snippet(doc, "revenue fiscal year", max_tokens=12)
    check("extraction keeps relevant sentence", "Revenue" in out or "revenue" in out, out)

    # dedupe
    a = Result(title="A", url="https://x.com/1", text="alpha beta gamma delta epsilon zeta eta theta " * 3,
               source_field="summary")
    b = Result(title="B", url="https://y.com/2", text="alpha beta gamma delta epsilon zeta eta theta " * 3,
               source_field="summary")
    c = Result(title="C", url="https://z.com/3", text="completely different words here " * 3,
               source_field="summary")
    kept, dropped = dedupe_near([a, b, c])
    check("near-duplicate dropped", dropped == 1 and len(kept) == 2, f"{dropped} {len(kept)}")

    # eviction respects the floor
    weak = [Result(title=str(i), url=f"https://d{i}.com", text="x" * 200, source_field="summary",
                   rerank_score=r)
            for i, r in enumerate([2.0, 0.05, 0.04])]
    kept2, evicted = evict_weak(weak)
    check("weak results evicted down to floor", len(kept2) == 3, str(len(kept2)))

    # citation registry is stable across stores
    reg = SourceRegistry()
    st1 = EvidenceStore(s, reg)
    r1 = Result(title="T", url="https://a.com/p", text="text " * 40, source_field="summary")
    st1.add_outcome(type("O", (), {"query": "q1", "results": [r1], "empty": False, "error": None})())
    n1 = st1.number(r1)
    st2 = EvidenceStore(s, reg)
    st2.add_outcome(type("O", (), {"query": "q2", "results": [r1], "empty": False, "error": None})())
    check("citation number stable across turns", st2.number(r1) == n1, f"{n1} vs {st2.number(r1)}")

    # memory recall
    idx = TurnIndex()
    idx.add(Turn(index=1, user="my project is called Mantis", assistant="Noted.",
                 entities=["Mantis"], topics=["project"], user_fact="The user's project is Mantis."))
    idx.add(Turn(index=2, user="what is the weather", assistant="Sunny.",
                 entities=[], topics=["weather"]))
    hits = idx.search("Mantis project", k=1, exclude_last=0)
    check("entity-keyed recall finds the right turn", bool(hits) and hits[0].index == 1)

    # fact log relevance + supersede
    fl = FactLog()
    fl.add(Fact(claim="The user's project is Mantis.", confidence="tentative"))
    fl.add(Fact(claim="The user's project is Mantis.", confidence="verified"))
    check("verified fact supersedes tentative",
          len(fl) == 1 and fl.all()[0].confidence == "verified")
    fl.add(Fact(claim="The user lives in Kolkata."))
    check("relevant facts filtered by query",
          len(fl.relevant("where does the user live")) == 1)

    # summary chain append-only merge
    chain = SummaryChain(max_blocks=3)
    for i in range(5):
        chain.append(SummaryBlock(turn_from=i, turn_to=i, text=f"block {i}"))
    check("summary chain bounded", len(chain.blocks) <= 3, str(len(chain.blocks)))
    check("summary chain keeps newest block text", "block 4" in chain.render())

    # memory round trip
    m = Memory()
    m.next_turn()
    m.facts.add(Fact(claim="x is y"))
    m.summaries.append(SummaryBlock(turn_from=1, turn_to=2, text="something happened"))
    m.index.add(Turn(index=1, user="hi", assistant="hello"))
    m2 = Memory.from_json(json.loads(json.dumps(m.to_json())))
    check("memory round-trips", len(m2.facts) == 1 and len(m2.index) == 1
          and len(m2.summaries.blocks) == 1)

    # tool schema is exactly one tool and strict-safe
    from src.agent.agent import WEB_SEARCH_TOOL
    check("exactly one tool exposed", len(WEB_SEARCH_TOOL) == 1)
    check("tool schema additionalProperties=false",
          WEB_SEARCH_TOOL[0]["function"]["parameters"]["additionalProperties"] is False)

    # json parse tolerance
    from src.agent.agent import parse_json
    check("parse_json handles fenced json", parse_json('```json\n{"a": 1}\n```') == {"a": 1})
    check("parse_json handles prose-wrapped json",
          parse_json('Sure! {"a": 2} hope that helps') == {"a": 2})
    check("parse_json returns {} on garbage", parse_json("no json here") == {})

    # ---- harness counters: the termination authority ----
    from src.agent.agent import Agent, HarnessState, _entity_set, _query_echoes

    h = HarnessState()
    check("fresh harness allows a followup", h.followup_allowed())
    h.account_search(3, new_entities=5, tokens=500)
    # The key regression guard: a full 3-query first plan must NOT consume the
    # whole request budget, or the corrective pass can never fire.
    check("3-query plan still leaves room for a corrective query",
          h.followup_allowed(), str(h.as_dict()))
    h.account_search(1, new_entities=5, tokens=500)
    check("after the corrective round the cap blocks a 3rd", not h.followup_allowed())
    check("request cap is the binding constraint here",
          h.exhausted_reason() == "search_round_cap", str(h.exhausted_reason()))
    check("exhausted_reason names the cap", h.exhausted_reason() == "search_round_cap", str(h.exhausted_reason()))

    h2 = HarnessState()
    h2.account_search(3, new_entities=0, tokens=100)
    check("one fruitless round still allows a retry", h2.followup_allowed())
    h2.account_search(3, new_entities=0, tokens=100)
    check("two fruitless rounds stop the loop (step repetition)",
          not h2.followup_allowed(), str(h2.new_entities_per_search))

    h3 = HarnessState()
    h3.account_search(1, new_entities=2, tokens=3_200)
    check("retrieved-token cap blocks further search",
          not h3.followup_allowed() and h3.exhausted_reason() == "retrieved_token_cap")

    h4 = HarnessState(max_llm_calls=3)
    for stage in ("route", "plan", "answer"):
        h4.account_llm(stage)
    check("llm-call cap reported", h4.llm_budget_exhausted and h4.exhausted_reason() == "llm_call_cap")

    h5 = HarnessState(max_search_requests=2)
    h5.account_search(2, new_entities=9, tokens=10)
    check("search-request cap blocks further search", not h5.followup_allowed())

    # entity novelty extraction and query-repeat detection
    ents = _entity_set([Result(title="ReWOO arXiv 2305.18323", url="https://a.b",
                               text="Microsoft Research reported LoRA LLaMA-7B",
                               source_field="summary")])
    check("entity extraction finds acronyms/versions",
          {"rew", "arxiv", "2305.18323"} & ents != set(), str(sorted(ents))[:120])
    check("near-duplicate query detected",
          _query_echoes("when was Bangladesh founded 1971", "Bangladesh founded in 1971"))
    check("distinct query not flagged",
          not _query_echoes("melting point of gallium", "history of Bangladesh"))

    # ---- prompt section markers (guards the mock/test parsing path) ----
    from src.agent.prompts import plan_prompt, route_prompt, section

    pmark = plan_prompt("Who wrote Attention Is All You Need?", "mem", "research")
    check("plan prompt carries a QUESTION marker",
          section(pmark, "QUESTION") == "Who wrote Attention Is All You Need?")
    rmark = route_prompt("what time does it arrive?", "mem")
    check("route prompt carries a MESSAGE marker",
          section(rmark, "MESSAGE") == "what time does it arrive?")
    check("absent marker yields empty string", section(pmark, "NOPE") == "")

    # ---- tokenisation: identifiers preserved, comparisons canonical ----
    from src.agent.memory import canon_terms, terms
    check("identifier kept whole by terms()", "eu-west-2" in terms("eu-west-2 gpt-3.5"),
          str(terms("eu-west-2 gpt-3.5")))
    check("hyphenated phrase splits for comparison",
          {"lost", "middle"} <= set(canon_terms("lost-in-the-middle")),
          str(canon_terms("lost-in-the-middle")))
    check("sentence-final punctuation stripped",
          "ordering" in canon_terms("implies prompt ordering."),
          str(canon_terms("implies prompt ordering.")))

    # ---- retrieval relevance gate ----
    from src.agent.agent import Agent

    def _store(results):
        st = ES(s)
        st.add_outcome(type("O", (), {
            "query": "q", "empty": not results, "error": None, "results": results,
        })())
        return st

    ag = Agent.__new__(Agent)
    ag.s = s
    relevant = _store([Result(title="Lost in the Middle: How Language Models Use Long Contexts",
                              url="https://arxiv.org/abs/2307.03172", rerank_score=2.9, authority=4,
                              text="Performance degrades when relevant information sits in the middle "
                                   "of a long context, and improves at the start and end.",
                              source_field="summary")])
    v = Agent.assess_retrieval(ag, "lost in the middle prompt ordering", relevant)
    check("gate accepts a relevant hit", v["usable"], str(v))

    irrelevant = _store([Result(title="Search results and advertising directory",
                                url="https://dir.invalid/x", rerank_score=0.8, authority=0,
                                text="A directory page with general listings and cookie notices.",
                                source_field="summary")])
    v2 = Agent.assess_retrieval(ag, "lost in the middle prompt ordering", irrelevant)
    check("gate rejects an irrelevant hit", not v2["usable"], str(v2))

    # The regression that motivated the overlap-coefficient change: a question
    # word absent from the page ("implies") must not veto a perfect result.
    v3 = Agent.assess_retrieval(
        ag, "what does lost in the middle imply for prompt ordering", relevant)
    check("gate tolerates unmatched question words", v3["usable"], str(v3))

    check("gate handles empty retrieval",
          not Agent.assess_retrieval(ag, "anything", _store([]))["usable"])

    # ---- usage accounting: snapshot keys and pricing ----
    from src.agent.client import Usage

    usage = Usage()
    usage.add_completion({
        "prompt_tokens": 1_000, "completion_tokens": 200,
        "prompt_cache_hit_tokens": 800, "prompt_cache_miss_tokens": 200,
    }, stage="answer")
    usage.search_requests += 2
    snap = usage.as_dict()
    empty = {k: 0 for k in Settings._USAGE_KEYS}
    delta = s.usage_delta(empty, snap)
    check("usage delta counts completion calls", delta["completion_calls"] == 1,
          str(delta.get("completion_calls")))
    check("usage delta prices search requests", abs(delta["cost_search_usd"] - 0.0015) < 1e-9,
          str(delta["cost_search_usd"]))
    priced = s.estimate_cost(snap)
    check("cache saving is positive when prefixes hit",
          priced["cache_saving_usd"] > 0, str(priced))
    check("cache hit rate computed", abs(snap["cache_hit_rate"] - 0.8) < 1e-9,
          str(snap["cache_hit_rate"]))
    try:
        s.usage_delta(empty, {"prompt_tokens": 1})
        check("usage delta rejects a stale snapshot schema", False, "no error raised")
    except KeyError:
        check("usage delta rejects a stale snapshot schema", True)

    # ---- grader semantics: must_contain entries are alternatives ----
    from src.eval.datasets import ALL_ITEMS
    from src.eval.judge import grade

    m4 = next(i for i in ALL_ITEMS if i.id == "m4")
    g = grade(m4, "The cap is 12,000 dollars and launch moved to June.")
    check("alternatives in one requirement group are OR, not AND", g.passed, g.detail)
    g2 = grade(m4, "The cap is 12,000 dollars.")
    check("a partially met item fails", not g2.passed, g2.detail)

    # ---- refusal detection covers the agent's own honest-failure wording ----
    h1 = next(i for i in ALL_ITEMS if i.id == "h1")
    g3 = grade(h1, "I searched and found nothing usable, so I will not guess.")
    check("refusal grader recognises the agent's own phrasing", g3.passed, g3.detail)
    g4 = grade(h1, "The attendance was approximately 450 people.")
    check("refusal grader rejects a confident invented figure", not g4.passed, g4.detail)

    # ---- deterministic checklist coverage (no model call) ----
    st = ES(s)
    st.add_outcome(type("O", (), {
        "query": "q", "empty": False, "error": None,
        "results": [Result(title="Lost in the Middle long context",
                           url="https://arxiv.org/abs/2307.03172",
                           text="Performance degrades when relevant information is in the middle of a long context.",
                           source_field="summary")],
    })())
    uncovered = Agent._uncovered(ag, ["performance degrades in the middle", "cost of bananas in Peru"], st)
    check("coverage check flags only the truly uncovered item",
          len(uncovered) == 1 and "bananas" in uncovered[0], str(uncovered))

    print()
    if failures:
        print(f"{BOLD}{len(failures)} FAILED:{RESET} {', '.join(failures)}")
        return 1
    print(f"{BOLD}all checks passed{RESET}")
    return 0


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if args.selftest:
        return selftest()

    overrides: dict = {}
    if args.trace:
        overrides["trace"] = True
    if args.verbose:
        overrides["verbose"] = True
    if args.budget:
        overrides["context_budget_tokens"] = args.budget
    if args.no_router:
        overrides["enable_router"] = False
    if args.no_planning:
        overrides["enable_planning"] = False
    if args.no_corrective:
        overrides["enable_corrective"] = False

    settings = Settings.from_env(**overrides)
    settings.require_key()

    if args.reset:
        for suffix in (".memory.json", ".sources.json"):
            p = settings.memory_dir / f"{args.conversation}{suffix}"
            if p.exists():
                p.unlink()
        print(f"memory cleared for “{args.conversation}”")

    agent = Agent(settings, conversation_id=args.conversation, trace=_trace_printer)

    try:
        if args.question:
            conv = agent.respond(args.question)
            print(f"\n{BOLD}{conv.assistant}{RESET}")
            if conv.citation_check.get("invalid_citations"):
                print(f"{DIM}  (warning: invalid citations "
                      f"{conv.citation_check['invalid_citations']}){RESET}")
            if args.stats:
                print_stats(agent)
            return 0

        print(f"{BOLD}minimi{RESET} — one tool (web_search), model {settings.model}")
        print(f"{DIM}conversation “{args.conversation}” · /stats /reset /exit{RESET}\n")
        while True:
            try:
                q = input(f"{CYAN}you ›{RESET} ").strip()
            except (EOFError, KeyboardInterrupt):
                print()
                break
            if not q:
                continue
            if q in {"/exit", "/quit"}:
                break
            if q == "/stats":
                print_stats(agent)
                continue
            if q == "/reset":
                agent.memory = type(agent.memory)()
                agent.conversations.clear()
                agent.registry = SourceRegistry()
                print("memory cleared")
                continue
            t0 = time.perf_counter()
            conv = agent.respond(q)
            print(f"\n{BOLD}minimi ›{RESET} {conv.assistant}")
            print(f"{DIM}  ({conv.latency_ms/1000:.1f}s, {len(conv.queries)} searches, "
                  f"{conv.n_results} results){RESET}\n")
        if args.stats:
            print_stats(agent)
        return 0
    finally:
        agent.close()


if __name__ == "__main__":
    raise SystemExit(main())
