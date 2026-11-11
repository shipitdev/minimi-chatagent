"""Evaluation runner.

    python -m src.eval.run --quick                      # smoke pass, few cents
    python -m src.eval.run                              # full suite
    python -m src.eval.run --ablation no_router          # one ablation
    python -m src.eval.run --all-ablations --limit 8     # compare configurations
    python -m src.eval.run --scenario                    # multi-turn compaction drill

Writes runs/<stamp>-<label>/results.json and report.md.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from collections import defaultdict
from dataclasses import asdict
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from src.agent.agent import Agent
from src.agent.config import Settings
from src.eval.datasets import ABLATIONS, ALL_ITEMS, SCENARIO, Item, by_category
from src.eval.judge import grade
from src.eval.mocks import MockStats, attach_mock


# ---------------------------------------------------------------------------


def run_item(agent: Agent, item: Item, settings: Settings) -> dict:
    """Run one item in its own conversation, with planted preamble if any."""
    before = agent.usage.as_dict()
    t0 = time.perf_counter()

    for line in item.preamble:
        agent.respond(line)

    conv = agent.respond(item.prompt)
    wall_ms = (time.perf_counter() - t0) * 1000

    answer = conv.assistant or ""
    g = grade(item, answer, client=agent.client, settings=settings)

    after = agent.usage.as_dict()
    delta = settings.usage_delta(before, after)

    # The gate now emits a 3-value enum; "research" is the searching route.
    needs_search = conv.route == "research"
    routing_ok = None
    if item.expected_search is not None:
        routing_ok = needs_search == bool(item.expected_search)

    return {
        "id": item.id,
        "category": item.category,
        "prompt": item.prompt,
        "answer": answer,
        "grade": g.as_dict(),
        "passed": g.passed,
        "score": g.score,
        "route": conv.route,
        "route_query": conv.route_query,
        "harness": conv.harness,
        "recall_extracts": conv.recall_extracts,
        "plan_queries": [q["query"] for q in (conv.plan.get("search_queries") or [])],
        "executed_queries": conv.queries,
        "n_results": conv.n_results,
        "citation_check": conv.citation_check,
        "routing_correct": routing_ok,
        "expected_search": item.expected_search,
        "needs_search": needs_search,
        "search_requests": delta["search_requests"],
        "completion_calls": delta["calls"],
        "prompt_tokens": delta["prompt_tokens"],
        "completion_tokens": delta["completion_tokens"],
        "cache_hit_tokens": delta["cache_hit_tokens"],
        "cache_miss_tokens": delta["cache_miss_tokens"],
        "cost_usd": delta["cost_total_usd"],
        "latency_ms": round(wall_ms, 1),
        "agent_latency_ms": round(conv.latency_ms, 1),
        "compaction": conv.compaction,
        "errors": conv.errors,
    }


def summarise(rows: list[dict], label: str, settings: Settings, wall_s: float) -> dict:
    by_cat: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_cat[r["category"]].append(r)

    def agg(rs: list[dict]) -> dict:
        if not rs:
            return {}
        return {
            "n": len(rs),
            "pass_rate": round(sum(1 for r in rs if r["passed"]) / len(rs), 3),
            "mean_score": round(statistics.fmean(r["score"] for r in rs), 3),
            "mean_search_requests": round(statistics.fmean(r["search_requests"] for r in rs), 2),
            "mean_latency_s": round(statistics.fmean(r["latency_ms"] for r in rs) / 1000, 2),
            "total_cost_usd": round(sum(r["cost_usd"] for r in rs), 6),
        }

    routed = [r for r in rows if r["routing_correct"] is not None]
    # The two routing errors are not equally bad, and the research says cheap
    # models fail on the over-search side more often, so we report both.
    over = sum(1 for r in routed if r["expected_search"] is False and r["needs_search"] is True)
    under = sum(1 for r in routed if r["expected_search"] is True and r["needs_search"] is False)

    total_cost = sum(r["cost_usd"] for r in rows)
    baseline = sum(r["cache_miss_tokens"] for r in rows) / 1e6 * settings.price_in_miss
    hits = sum(r["cache_hit_tokens"] for r in rows)
    misses = sum(r["cache_miss_tokens"] for r in rows)

    return {
        "label": label,
        "n_items": len(rows),
        "pass_rate": round(sum(1 for r in rows if r["passed"]) / max(1, len(rows)), 3),
        "mean_score": round(statistics.fmean([r["score"] for r in rows]) or 0.0, 3),
        "per_category": {k: agg(v) for k, v in sorted(by_cat.items())},
        "routing": {
            "n": len(routed),
            "accuracy": round(
                sum(1 for r in routed if r["routing_correct"]) / len(routed), 3
            ) if routed else None,
            "over_search": over,
            "under_search": under,
        },
        "efficiency": {
            "total_cost_usd": round(total_cost, 6),
            "cost_per_item_usd": round(total_cost / max(1, len(rows)), 6),
            "total_search_requests": sum(r["search_requests"] for r in rows),
            "searches_per_item": round(
                sum(r["search_requests"] for r in rows) / max(1, len(rows)), 2
            ),
            "total_llm_calls": sum(r["completion_calls"] for r in rows),
            "calls_per_item": round(
                sum(r["completion_calls"] for r in rows) / max(1, len(rows)), 2
            ),
            "cache_hit_rate": round(hits / max(1, hits + misses), 3),
            "mean_latency_s": round(
                statistics.fmean(r["latency_ms"] for r in rows) / 1000, 2
            ),
            "wall_clock_s": round(wall_s, 1),
        },
        "integrity": {
            "items_with_invalid_citations": sum(
                1 for r in rows if (r.get("citation_check") or {}).get("invalid_citations")
            ),
            "items_with_errors": sum(1 for r in rows if r["errors"]),
            "items_zero_results": sum(1 for r in rows if r["n_results"] == 0),
        },
        "settings": asdict(settings) | {"memory_dir": str(settings.memory_dir), "api_key": "***"},
    }


# ---------------------------------------------------------------------------


def eval_suite(settings: Settings, label: str, items: list[Item], outdir: Path,
               *, mock: bool = False) -> dict:
    run_dir = outdir / label
    run_dir.mkdir(parents=True, exist_ok=True)
    settings.memory_dir = run_dir / "memory"

    rows: list[dict] = []
    t0 = time.perf_counter()
    # One agent per item, so memory is isolated and each item starts clean.
    for i, item in enumerate(items, 1):
        agent = Agent(settings, conversation_id=f"{label}-{item.id}")
        client = attach_mock(agent) if mock else None
        try:
            row = run_item(agent, item, settings)
            if client is not None:
                row["mock"] = client.stats.as_dict()
        except Exception as e:
            import traceback
            print(f"  !! harness error on {item.id}: {type(e).__name__}: {e}", flush=True)
            traceback.print_exc()
            row = {
                "id": item.id, "category": item.category, "prompt": item.prompt,
                "answer": "", "passed": False, "score": 0.0,
                "grade": {"detail": f"harness error: {type(e).__name__}: {e}"},
                "search_requests": 0, "completion_calls": 0, "cost_usd": 0.0,
                "latency_ms": 0.0, "cache_hit_tokens": 0, "cache_miss_tokens": 0,
                "prompt_tokens": 0, "completion_tokens": 0, "n_results": 0,
                "route": "", "route_query": "", "harness": {}, "recall_extracts": 0,
                "plan_queries": [], "executed_queries": [],
                "citation_check": {}, "routing_correct": None,
                "expected_search": item.expected_search, "needs_search": None,
                "compaction": [], "errors": [str(e)],
            }
        finally:
            agent.close()
        rows.append(row)
        mark = "PASS" if row["passed"] else "fail"
        print(
            f"  [{i:>2}/{len(items)}] {mark} {item.id:<4} {item.category:<10} "
            f"score={row['score']:.2f} search={row['search_requests']} "
            f"{row['latency_ms']/1000:.1f}s ${row['cost_usd']:.5f}",
            flush=True,
        )

    wall = time.perf_counter() - t0
    summary = summarise(rows, label, settings, wall)
    summary["backend"] = "scripted (mock)" if mock else "live" 
    (run_dir / "results.json").write_text(
        json.dumps({"summary": summary, "rows": rows}, indent=1, default=str),
        encoding="utf-8",
    )
    return {"summary": summary, "rows": rows, "dir": str(run_dir)}


def run_scenario(settings: Settings, outdir: Path, *, mock: bool = False) -> dict:
    """Multi-turn drill: does recall survive after compaction has kicked in?"""
    run_dir = outdir / "scenario"
    run_dir.mkdir(parents=True, exist_ok=True)
    settings.memory_dir = run_dir / "memory"
    # Force compaction early so the scenario actually exercises it.
    settings.context_budget_tokens = min(settings.context_budget_tokens, 6000)

    agent = Agent(settings, conversation_id="scenario")
    client = attach_mock(agent) if mock else None
    turns: list[dict] = []
    try:
        for i, q in enumerate(SCENARIO):
            conv = agent.respond(q)
            turns.append({
                "turn": i + 1,
                "prompt": q,
                "answer": conv.assistant,
                "route": conv.route,
                "needs_search": conv.route == "research",
                "queries": conv.queries,
                "n_results": conv.n_results,
                "harness": conv.harness,
                "compaction": conv.compaction,
                "errors": conv.errors,
            })
            print(f"  turn {i+1}: route={conv.route} "
                  f"queries={len(conv.queries)} compaction={len(conv.compaction)}", flush=True)

        # Turn 4 must recall "DeepSeek Flash" from turn 1, across compaction.
        recall_turn = turns[3]["answer"]
        recall_ok = "flash" in recall_turn.lower() or "deepseek" in recall_turn.lower()
        summary_turn = turns[4]["answer"].lower()
        summary_ok = "llmlingua" in summary_turn
        mem = agent.memory
    finally:
        agent.close()

    result = {
        "turns": turns,
        "cross_turn_recall_ok": recall_ok,
        "final_summary_mentions_topic": summary_ok,
        "summary_chain_blocks": len(mem.summaries.blocks),
        "fact_log_size": len(mem.facts),
        "turn_index_size": len(mem.index),
        "compaction": agent.compactor.instrument(),
        "full_history_tokens": agent.compactor.full_history_tokens(agent.conversations),
        "compaction_fired": bool(agent.compactor.reports),
        "stages": client.stats.as_dict() if client else None,
        "usage": agent.usage.as_dict(),
        "cost": settings.estimate_cost(agent.usage),
    }
    (run_dir / "scenario.json").write_text(json.dumps(result, indent=1, default=str), encoding="utf-8")
    return result


# ---------------------------------------------------------------------------


def write_report(outdir: Path, results: dict[str, dict], scenario: dict | None) -> Path:
    lines: list[str] = ["# minimi evaluation report", ""]
    lines.append(f"Generated: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append("")

    lines.append("## Configuration comparison")
    lines.append("")
    lines.append("| config | pass rate | mean score | routing acc | over-search | under-search | "
                 "searches/item | llm calls/item | cache hit | cost/item | latency |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|---|")
    for label, res in results.items():
        s = res["summary"]
        e, r = s["efficiency"], s["routing"]
        lines.append(
            f"| `{label}` | {s['pass_rate']:.1%} | {s['mean_score']:.2f} | "
            f"{('%.1f%%' % (r['accuracy']*100)) if r['accuracy'] is not None else '–'} | "
            f"{r['over_search']} | {r['under_search']} | {e['searches_per_item']} | "
            f"{e['calls_per_item']} | {e['cache_hit_rate']:.0%} | "
            f"${e['cost_per_item_usd']:.5f} | {e['mean_latency_s']:.1f}s |"
        )
    lines.append("")

    lines.append("## Per-category pass rates")
    lines.append("")
    cats = sorted({c for r in results.values() for c in r["summary"]["per_category"]})
    header = "| config | " + " | ".join(cats) + " |"
    lines.append(header)
    lines.append("|" + "---|" * (len(cats) + 1))
    for label, res in results.items():
        pc = res["summary"]["per_category"]
        cells = [
            (f"{pc[c]['pass_rate']:.0%} (n={pc[c]['n']})" if c in pc else "–")
            for c in cats
        ]
        lines.append(f"| `{label}` | " + " | ".join(cells) + " |")
    lines.append("")

    lines.append("## Failure detail")
    lines.append("")
    for label, res in results.items():
        fails = [r for r in res["rows"] if not r["passed"]]
        if not fails:
            continue
        lines.append(f"### `{label}` — {len(fails)} failing items")
        lines.append("")
        for r in fails:
            detail = (r.get("grade") or {}).get("detail", "")
            lines.append(f"- **{r['id']}** ({r['category']}) score={r['score']:.2f} — {detail}")
            snippet = (r["answer"] or "")[:220].replace("\n", " ")
            lines.append(f"  - answer: {snippet}…")
        lines.append("")

    if scenario:
        lines.append("## Multi-turn scenario (compaction drill)")
        lines.append("")
        lines.append(f"- cross-turn recall of a fact from turn 1, read back at turn 4: "
                     f"**{'OK' if scenario['cross_turn_recall_ok'] else 'FAILED'}**")
        lines.append(f"- final summary retained the session topic: "
                     f"**{'OK' if scenario['final_summary_mentions_topic'] else 'FAILED'}**")
        lines.append(f"- compaction fired during the scenario: "
                     f"**{scenario.get('compaction_fired')}** "
                     f"(full history {scenario.get('full_history_tokens')} tokens vs "
                     f"soft threshold {scenario['compaction']['thresholds']['soft']})")
        lines.append(f"- summary chain blocks: {scenario['summary_chain_blocks']}")
        lines.append(f"- fact log entries: {scenario['fact_log_size']}")
        lines.append(f"- turn index entries: {scenario['turn_index_size']}")
        lines.append(f"- cost: ${scenario['cost']['total_usd']:.5f} "
                     f"(cache saving ${scenario['cost']['cache_saving_usd']:.5f})")
        lines.append("")
        thr = scenario["compaction"]["thresholds"]
        lines.append(f"- compaction thresholds: soft {thr['soft']}, hard {thr['hard']}, "
                     f"budget {thr['budget']}")
        lines.append(f"- min retained ratio across compactions: "
                     f"{scenario['compaction']['min_retained_ratio']} "
                     f"(floor satisfied: {scenario['compaction']['retention_floor_ok']})")
        lines.append("")
        lines.append("| turn | needs_search | queries | results | compactions |")
        lines.append("|---|---|---|---|---|")
        for t in scenario["turns"]:
            lines.append(f"| {t['turn']} | {t['needs_search']} | {len(t['queries'])} | "
                         f"{t['n_results']} | {len(t['compaction'])} |")
        lines.append("")

    path = outdir / "report.md"
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="minimi-eval")
    p.add_argument("--ablation", choices=sorted(ABLATIONS), default="full")
    p.add_argument("--all-ablations", action="store_true")
    p.add_argument("--quick", action="store_true", help="one item per category")
    p.add_argument("--limit", type=int, default=None, help="max items per category")
    p.add_argument("--categories", default=None, help="comma-separated subset")
    p.add_argument("--scenario", action="store_true",
                   help="also run the multi-turn drill and include it in the report")
    p.add_argument("--scenario-only", action="store_true",
                   help="run only the multi-turn drill")
    p.add_argument("--out", default=None)
    p.add_argument("--label", default=None)
    p.add_argument("--mock", action="store_true",
                   help="scripted backend, no network: validates the harness, not answer quality")
    p.add_argument("--stress", action="store_true",
                   help="run the forced-compaction memory stress test (uses the scripted backend)")
    p.add_argument("--citations", action="store_true",
                   help="run the cross-turn citation integrity drill")
    return p


# ---------------------------------------------------------------------------
# Memory stress test (forced compaction)
# ---------------------------------------------------------------------------
#
# A 20-item suite never grows the conversation enough to compact, so the memory
# and compaction design would go unvalidated. This drill plants identifiers early,
# then drives the conversation past the threshold so layer A drops those turns and
# layer B summarises them — and then asks for the identifiers back. That is the
# exact failure the three-tier memory exists to prevent, and it is deterministic
# enough to assert on.

STRESS_PLANTS = {
    1: "My name is Anjali Deshmukh and I work at Kestrel Robotics.",
    2: "Remember that our deployment region is ap-south-1 and the engine is DuckDB 1.2.",
    3: "My project codename is Tinwhistle.",
}

STRESS_FILLER = [
    "Explain how prompt caching works for an API that bills cached input differently, "
    "and what an agent should do structurally to get cache hits rather than misses.",
    "What does the lost-in-the-middle result imply about where to place retrieved "
    "documents in a prompt, and how should the ordering change as evidence grows?",
    "Summarise the arguments for planning a tool-use chain before executing it, and "
    "contrast that with interleaving reasoning and acting step by step.",
    "What are the reported failure modes when an agent's context is compacted while a "
    "task is still in progress, and what should a harness counter do about them?",
    "Why does adding more tools tend to reduce agent reliability, and what does the "
    "reported evidence say about the relationship between tool count and failures?",
    "What does the evidence say about self-correction in smaller language models, and "
    "why does that rule out a critique-and-retry loop on a cheap model?",
    "How should an agent decide when to stop searching, and why do counters in the "
    "harness work better than instructions in the prompt for that decision?",
    "What is the argument for compressing retrieved evidence with deterministic code "
    "rather than with a summarisation model, and what does it cost in accuracy?",
    "Describe the tradeoff between retrieved context size and reader accuracy for a "
    "small model, and name the token budget the evidence suggests.",
    "Why does query-aware compression outperform a query-independent compressor, and "
    "how could that be approximated without a second model?",
    "What does the literature say about how many tools an agent should be given, and "
    "what evidence supports that position?",
    "How should an assistant answer a question about something that does not exist, "
    "and what is the failure mode to avoid?",
]

STRESS_QUERY = "What is my name, my project codename, my deployment region and my database engine?"


CITATION_TOPICS = [
    "Compare the ReWOO and ReAct agent patterns and their token efficiency.",
    "Explain what the lost-in-the-middle problem implies for prompt ordering.",
    "What do we know about compaction failure modes for agents mid-task?",
]


def run_citation_drill(settings: Settings, outdir: Path, *, mock: bool = True) -> dict:
    """Check citation integrity across a conversation with accumulating sources.

    Citation numbers come from a conversation-level registry rather than being
    renumbered per turn. If that registry were wrong, turn 3's "[2]" would point at
    a different page than turn 1's "[2]", and the citations would silently become
    unverifiable. This drill runs several sourced questions and checks that every
    citation resolves at every step.
    """
    run_dir = outdir / "citations"
    run_dir.mkdir(parents=True, exist_ok=True)
    settings.memory_dir = run_dir / "memory"

    agent = Agent(settings, conversation_id="citations")
    client = attach_mock(agent) if mock else None
    checks: list[dict] = []
    try:
        for i, topic in enumerate(CITATION_TOPICS, 1):
            conv = agent.respond(topic)
            cc = conv.citation_check or {}
            checks.append({
                "turn": i, "prompt": topic, "route": conv.route,
                "citations": cc.get("citations"),
                "invalid": cc.get("invalid_citations"),
                "n_sources_this_turn": cc.get("n_sources"),
                "registry_size": len(agent.registry),
                "answer": conv.assistant[:300],
            })
        # Verify every number the registry knows about still resolves to a URL.
        dangling = [n for n, url in agent.registry._url_by_n.items() if not url]
        unique_urls = len(set(agent.registry._url_by_n.values()))
    finally:
        agent.close()

    total_invalid = sum(len(c["invalid"] or []) for c in checks)
    result = {
        "turns": checks,
        "total_invalid_citations": total_invalid,
        "registry_size": checks[-1]["registry_size"] if checks else 0,
        "unique_urls": unique_urls,
        "dangling_numbers": dangling,
        "passed": total_invalid == 0 and not dangling and all(c["citations"] for c in checks),
        "stages": client.stats.as_dict() if client else None,
    }
    (run_dir / "citations.json").write_text(json.dumps(result, indent=1, default=str), encoding="utf-8")
    return result


def run_stress(settings: Settings, outdir: Path, *, mock: bool = True) -> dict:
    """Force compaction, then check whether planted identifiers survive it."""
    run_dir = outdir / "stress"
    run_dir.mkdir(parents=True, exist_ok=True)
    settings.memory_dir = run_dir / "memory"
    # Force layer B to fire: budget well below the accumulated history.
    # Chosen so layer A and then layer B actually fire. A budget that is never
    # reached would make this drill vacuous, which is what the first run did.
    settings.context_budget_tokens = 4_000
    settings.keep_recent_turns = 2
    settings.recall_k = 8

    agent = Agent(settings, conversation_id="stress")
    client = attach_mock(agent) if mock else None
    turns: list[dict] = []
    layers: list[str] = []
    try:
        sequence = list(STRESS_PLANTS.items())
        for turn_no, text in sequence:
            conv = agent.respond(text)
            layers += [c["layer"] for c in conv.compaction]
            turns.append({"turn": turn_no, "prompt": text, "assistant": conv.assistant,
                          "route": conv.route, "compaction": conv.compaction})

        for i, filler in enumerate(STRESS_FILLER):
            conv = agent.respond(filler)
            layers += [c["layer"] for c in conv.compaction]
            turns.append({"turn": len(sequence) + i + 1, "prompt": filler,
                          "assistant": conv.assistant, "route": conv.route,
                          "compaction": conv.compaction})

        recall = agent.respond(STRESS_QUERY)
        turns.append({"turn": len(turns) + 1, "prompt": STRESS_QUERY,
                      "assistant": recall.assistant, "route": recall.route,
                      "compaction": recall.compaction})

        identifiers = ["Anjali", "Deshmukh", "Kestrel", "Tinwhistle", "ap-south-1", "DuckDB"]
        haystack = (recall.assistant + " " + agent.memory.render_summary() + " " +
                    " ".join(f.claim for f in agent.memory.facts.all()))
        found = [i for i in identifiers if i.lower() in haystack.lower()]

        # Citation integrity across a conversation, using the shared registry.
        registry_sources = len(agent.registry)
        conv_usage = agent.usage.as_dict()
    finally:
        agent.close()

    result = {
        "compaction_fired": bool(layers),
        "layer_b_fired": "B" in layers,
        "vacuous": not bool(layers),
        "planted": len(identifiers),
        "surviving": len(found),
        "identifiers": identifiers,
        "found": found,
        "missing": [i for i in identifiers if i not in found],
        "recall_answer": recall.assistant,
        "recall_verbatim_extracts": recall.recall_extracts,
        "layers_fired": layers,
        "compaction_layers": {layer: layers.count(layer) for layer in sorted(set(layers))},
        "compaction_instrument": agent.compactor.instrument(),
        "fact_log_size": len(agent.memory.facts),
        "turn_index_size": len(agent.memory.index),
        "summary_chain_blocks": len(agent.memory.summaries.blocks),
        "final_prompt_tokens": agent.compactor.prompt_tokens(agent._base_messages()),
        "thresholds": agent.compactor.instrument()["thresholds"],
        "registry_sources": registry_sources,
        "usage": conv_usage,
        "cost": settings.estimate_cost(conv_usage),
        "stages": client.stats.as_dict() if client else None,
        "turns": turns,
    }
    (run_dir / "stress.json").write_text(json.dumps(result, indent=1, default=str), encoding="utf-8")
    return result


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    items = list(ALL_ITEMS)
    if args.categories:
        wanted = {c.strip() for c in args.categories.split(",")}
        items = [i for i in items if i.category in wanted]
    if args.limit:
        grouped: dict[str, list[Item]] = defaultdict(list)
        for i in items:
            grouped[i.category].append(i)
        items = [i for cat in sorted(grouped) for i in grouped[cat][: args.limit]]
    if args.quick:
        seen: dict[str, int] = defaultdict(int)
        picked: list[Item] = []
        for i in items:
            if seen[i.category] < 1:
                picked.append(i)
                seen[i.category] += 1
        items = picked

    stamp = time.strftime("%Y%m%d-%H%M%S")
    outdir = Path(args.out) if args.out else Path("runs") / stamp
    outdir.mkdir(parents=True, exist_ok=True)

    base = Settings.from_env()
    if not args.mock:
        base.require_key()
    else:
        print("backend: scripted (no network). Quality numbers are meaningless; "
              "this validates plumbing only.\n")

    if args.citations:
        result = run_citation_drill(Settings.from_env(), outdir, mock=args.mock)
        print(f"\ncitation drill: {'PASS' if result['passed'] else 'FAIL'}")
        print(f"  invalid citations across {len(result['turns'])} turns: "
              f"{result['total_invalid_citations']}")
        print(f"  registry size {result['registry_size']}, unique URLs {result['unique_urls']}, "
              f"dangling {result['dangling_numbers']}")
        for t in result["turns"]:
            print(f"    turn {t['turn']}: cites {t['citations']} "
                  f"(registry {t['registry_size']}), invalid {t['invalid']}")
        return 0 if result["passed"] else 1

    if args.stress:
        result = run_stress(Settings.from_env(), outdir, mock=True)
        print(f"\nstress: identifiers surviving compaction: "
              f"{result['surviving']}/{result['planted']}")
        print(f"  compaction layers fired: {result['compaction_layers']}")
        print(f"  cache hit rate: {result['usage']['cache_hit_rate']:.0%}")
        return 0 if result["surviving"] == result["planted"] else 1

    scenario: dict | None = None
    if args.scenario:
        print("multi-turn scenario drill")
        scenario = run_scenario(Settings.from_env(), outdir, mock=args.mock)
        if args.scenario_only:
            report = write_report(outdir, {}, scenario)
            print(f"\nreport: {report}")
            return 0 if scenario["cross_turn_recall_ok"] else 1

    labels = sorted(ABLATIONS) if args.all_ablations else [args.ablation]
    results: dict[str, dict] = {}
    for label in labels:
        overrides = dict(ABLATIONS[label])
        settings = Settings.from_env(**overrides)
        run_label = args.label or label
        print(f"\n=== {run_label} ({len(items)} items) ===")
        try:
            results[run_label] = eval_suite(settings, run_label, items, outdir, mock=args.mock)
        except KeyboardInterrupt:
            print("\ninterrupted; writing partial report")
            break
        s = results[run_label]["summary"]
        print(f"  → pass {s['pass_rate']:.1%}  cost ${s['efficiency']['total_cost_usd']:.5f}  "
              f"cache hit {s['efficiency']['cache_hit_rate']:.0%}")

    report = write_report(outdir, results, scenario)
    print(f"\nreport: {report}")
    print(f"json:   {outdir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())