#!/usr/bin/env python3
"""DeepEval evaluation at component, pipeline, and workflow levels.

Component: deterministic memory/search/citation checks + contextual recall.
Pipeline: faithfulness and answer relevancy over the produced evidence.
Workflow: one case-compliance GEval over the golden criteria and forbidden claims,
plus the structural route/search checks from the golden runner.

Run with the project's eval Python environment (deepeval 4.3.3):
  /path/to/.venv-eval/bin/python evals/deepeval/run_deepeval.py --splits dev,holdout,live
"""
import argparse
import json
import os
import re
import statistics

os.environ.setdefault("DEEPEVAL_TELEMETRY_OPT_OUT", "YES")
os.environ.setdefault("DEEPEVAL_PER_ATTEMPT_TIMEOUT_SECONDS", "20")
os.environ.setdefault("DEEPEVAL_PER_TASK_TIMEOUT_SECONDS", "35")
os.environ.setdefault("DEEPEVAL_RETRY_MAX_ATTEMPTS", "1")
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
RUNS = ROOT / "evals" / "runs"
CASES = ROOT / "evals" / "golden-v2" / "cases.json"

from deepeval.models import DeepSeekModel
from deepeval.metrics import AnswerRelevancyMetric, ContextualRecallMetric, FaithfulnessMetric, GEval
from deepeval.test_case import LLMTestCase, SingleTurnParams



def mean(values):
    vals = [v for v in values if isinstance(v, (int, float))]
    return round(statistics.fmean(vals), 4) if vals else None


def p50(values):
    vals = sorted(v for v in values if isinstance(v, (int, float)))
    return vals[len(vals) // 2] if vals else None


def p95(values):
    vals = sorted(v for v in values if isinstance(v, (int, float)))
    return vals[min(len(vals) - 1, int(len(vals) * 0.95))] if vals else None


def canonical(url):
    try:
        parts = urlsplit(url)
        return (parts.netloc.lower().removeprefix("www."), parts.path.rstrip("/"))
    except Exception:
        return (str(url), "")


def load_cases():
    return {c["id"]: c for c in json.loads(CASES.read_text())}


def load_rows(splits):
    rows = []
    for split in splits:
        path = RUNS / f"{split}.json"
        if not path.exists():
            raise SystemExit(f"missing run: {path}")
        data = json.loads(path.read_text())
        for row in data["results"]:
            row["_split"] = split
            rows.append(row)
    return rows


def deterministic_component(case, row):
    result = row.get("result", {})
    checks = row.get("checks", {})
    gold = case["gold"]
    required = set(gold["required_turn_ids"])
    selected = set(result.get("selected_turn_ids") or [])
    memory = (1.0 if required <= selected else 0.0) if required else None
    expected_search = gold["expected_route"] in ("research", "historical_update")
    queries = result.get("search_queries") or []
    search = 1.0 if bool(queries) == expected_search else 0.0
    cited = result.get("citations") or []
    cited_ids = {c.get("id") for c in cited}
    cited_urls = {canonical(c.get("url")) for c in cited if c.get("url")}
    required_rules = [c for c in gold["criteria"] if c["evidence_ids"] or c["acceptable_urls"]]
    source = None
    if required_rules:
        ok = 0
        for rule in required_rules:
            if rule["evidence_ids"]:
                ok += int(set(rule["evidence_ids"]) <= cited_ids)
            else:
                ok += int(any(canonical(u) in cited_urls for u in rule["acceptable_urls"]))
        source = ok / len(required_rules)
    retrieval_text = "\n".join(result.get("retrieval_context") or [])
    citation_valid = None if not cited else (1.0 if all((c.get("url") or "") in retrieval_text for c in cited) else 0.0)
    return {
        "memory_selection": memory,
        "search_behavior": search,
        "source_coverage": source,
        "citation_url_membership": citation_valid,
    }


def make_judge():
    key = os.environ.get("DEEPSEEK_API_KEY")
    if not key:
        raise SystemExit("DEEPSEEK_API_KEY is required for DeepEval judge metrics")
    return DeepSeekModel(
        model=os.environ.get("DEEPEVAL_MODEL", os.environ.get("DEEPSEEK_MODEL", "deepseek-flash")),
        api_key=key,
        cost_per_input_token=0,
        cost_per_output_token=0,
    )


def criteria_text(case):
    gold = case["gold"]
    parts = [f"- {c['text']}" for c in gold["criteria"]]
    if gold.get("forbidden_claims"):
        parts.append("The answer must not contain any of these claims: " + "; ".join(gold["forbidden_claims"]))
    return "\n".join(parts)


def measure(metric, test_case):
    try:
        metric.measure(test_case)
        return {"score": float(metric.score), "reason": str(metric.reason)[:1200], "success": bool(metric.success)}
    except Exception as exc:
        return {"score": None, "error": f"{type(exc).__name__}: {str(exc)[:500]}"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--splits", default="dev,holdout,live")
    parser.add_argument("--max-cases", type=int, default=0, help="0 = all")
    parser.add_argument("--case-ids", default="", help="comma-separated case ids")
    parser.add_argument("--no-llm", action="store_true", help="deterministic component checks only")
    parser.add_argument("--profile", choices=("full", "workflow", "pipeline"), default="full", help="which DeepEval judge levels to run")
    parser.add_argument("--out", default=str(RUNS / "deepeval.json"))
    args = parser.parse_args()

    splits = [s.strip() for s in args.splits.split(",") if s.strip()]
    cases = load_cases()
    rows = [r for r in load_rows(splits) if r.get("status") == "answered"]
    if args.case_ids:
        wanted = {x.strip() for x in args.case_ids.split(",") if x.strip()}
        rows = [r for r in rows if r["id"] in wanted]
    if args.max_cases:
        rows = rows[: args.max_cases]
    judge = None if args.no_llm else make_judge()

    component_metric = None
    faithfulness_metric = None
    relevancy_metric = None
    if judge:
        if args.profile == "full":
            component_metric = ContextualRecallMetric(model=judge, threshold=0.5, async_mode=False)
        if args.profile in ("full", "pipeline"):
            faithfulness_metric = FaithfulnessMetric(model=judge, threshold=0.5, async_mode=False)
            relevancy_metric = AnswerRelevancyMetric(model=judge, threshold=0.5, async_mode=False)

    per_case = []
    for i, row in enumerate(rows, 1):
        cid = row["id"]
        case = cases[cid]
        result = row.get("result", {})
        expected = criteria_text(case)
        retrieval = result.get("retrieval_context") or ["No retrieval context returned."]
        test_case = LLMTestCase(
            input=case["prompt"],
            actual_output=result.get("answer", ""),
            retrieval_context=retrieval,
            expected_output=expected,
        )
        det = deterministic_component(case, row)
        entry = {
            "id": cid,
            "split": row.get("_split"),
            "category": case.get("category"),
            "prompt_style": case.get("prompt_style"),
            "pair_id": case.get("pair_id"),
            "route": result.get("route"),
            "expected_route": case["gold"]["expected_route"],
            "component": det,
            "pipeline": {},
            "workflow": {},
            "telemetry": {
                "agent_ms": result.get("agent_ms"),
                "first_answer_text_ms": result.get("first_answer_text_ms"),
                "input_tokens": result.get("input_tokens"),
                "output_tokens": result.get("output_tokens"),
                "search_evidence_tokens": result.get("search_evidence_tokens"),
                "model_calls": result.get("model_calls"),
                "cost_usd": result.get("cost_usd"),
            },
        }
        if judge:
            if component_metric:
                entry["component"]["contextual_recall"] = measure(component_metric, test_case)
            if faithfulness_metric:
                entry["pipeline"]["faithfulness"] = measure(faithfulness_metric, test_case)
            if relevancy_metric:
                entry["pipeline"]["answer_relevancy"] = measure(relevancy_metric, test_case)
        if judge and args.profile in ("full", "workflow"):
            workflow_metric = GEval(
                name="Golden case compliance",
                criteria="Evaluate whether the answer satisfies every requirement below, uses only supported evidence, and avoids every forbidden claim.\n" + expected,
                evaluation_params=[
                    SingleTurnParams.INPUT,
                    SingleTurnParams.ACTUAL_OUTPUT,
                    SingleTurnParams.RETRIEVAL_CONTEXT,
                    SingleTurnParams.EXPECTED_OUTPUT,
                ],
                model=judge,
                threshold=0.5,
                async_mode=False,
            )
            entry["workflow"]["case_compliance"] = measure(workflow_metric, test_case)
        per_case.append(entry)
        pipe = ", ".join(f"{k}:{v.get('score')}" for k, v in entry["pipeline"].items())
        wf = entry["workflow"].get("case_compliance", {}).get("score")
        print(f"[{i}/{len(rows)}] {cid}: component={det} pipeline={{{pipe}}} workflow={wf}", flush=True)

    def scores(level, key):
        return [e[level][key]["score"] for e in per_case if isinstance(e.get(level, {}).get(key, {}).get("score"), (int, float))]

    summary = {
        "cases": len(per_case),
        "splits": splits,
        "judge": None if args.no_llm else {"provider": "deepseek", "model": os.environ.get("DEEPEVAL_MODEL", "deepseek-flash")},
        "component": {
            "memory_selection": mean([e["component"]["memory_selection"] for e in per_case]),
            "search_behavior": mean([e["component"]["search_behavior"] for e in per_case]),
            "source_coverage": mean([e["component"]["source_coverage"] for e in per_case]),
            "citation_url_membership": mean([e["component"]["citation_url_membership"] for e in per_case]),
            "contextual_recall": mean(scores("component", "contextual_recall")),
        },
        "pipeline": {
            "faithfulness": mean(scores("pipeline", "faithfulness")),
            "answer_relevancy": mean(scores("pipeline", "answer_relevancy")),
        },
        "workflow": {
            "case_compliance": mean(scores("workflow", "case_compliance")),
            "route_match": mean([1.0 if e["route"] == e["expected_route"] else 0.0 for e in per_case]),
            "pass_count": sum(1 for e in per_case if (e.get("workflow", {}).get("case_compliance", {}).get("score") or 0) >= 0.5),
        },
        "telemetry": {
            key: {"p50": p50([e["telemetry"].get(key) for e in per_case]), "p95": p95([e["telemetry"].get(key) for e in per_case])}
            for key in ("agent_ms", "first_answer_text_ms", "input_tokens", "output_tokens", "search_evidence_tokens", "model_calls")
        },
        "cost_usd_total": round(sum(e["telemetry"].get("cost_usd") or 0 for e in per_case), 6),
    }
    pairs = {}
    for e in per_case:
        if e.get("pair_id"):
            pairs.setdefault(e["pair_id"], {})[e.get("prompt_style") or "unknown"] = bool((e.get("workflow", {}).get("case_compliance", {}).get("score") or 0) >= 0.5)
    outcomes = {"both_pass": 0, "polished_only": 0, "chat_only": 0, "both_fail": 0}
    for pair in pairs.values():
        if set(pair) != {"polished", "chat"}:
            continue
        p, c = pair["polished"], pair["chat"]
        outcomes["both_pass" if p and c else "polished_only" if p else "chat_only" if c else "both_fail"] += 1
    summary["workflow"]["wording_pairs"] = outcomes

    out = {"generated_at": datetime.now(timezone.utc).isoformat(), "summary": summary, "per_case": per_case}
    Path(args.out).write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n")
    Path(str(args.out) + ".md").write_text(
        "# DeepEval — Minimi golden v2\n\n"
        f"Generated: {out['generated_at']}\n\n"
        f"Cases: {summary['cases']}\n\n"
        "## Level summary\n\n"
        f"- Component: memory={summary['component']['memory_selection']}, search={summary['component']['search_behavior']}, "
        f"source={summary['component']['source_coverage']}, contextual_recall={summary['component']['contextual_recall']}\n"
        f"- Pipeline: faithfulness={summary['pipeline']['faithfulness']}, answer_relevancy={summary['pipeline']['answer_relevancy']}\n"
        f"- Workflow: case_compliance={summary['workflow']['case_compliance']}, route_match={summary['workflow']['route_match']}, "
        f"pass={summary['workflow']['pass_count']}/{summary['cases']}, pairs={summary['workflow']['wording_pairs']}\n"
        f"- Latency p50/p95: {summary['telemetry']['agent_ms']}\n"
        f"- Tokens in/out p50: {summary['telemetry']['input_tokens']['p50']}/{summary['telemetry']['output_tokens']['p50']}\n"
        f"- Cost total: ${summary['cost_usd_total']}\n"
    )
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
