"""Validate fixtures, collect chatbot outputs, and score independent reviews."""
import argparse
import json
import math
import shlex
import subprocess
import time
from collections import Counter
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

ROOT = Path(__file__).parent

def read(path):
    return json.loads(Path(path).read_text())

def write(path, value):
    Path(path).write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")

def unique(values):
    if len(values) != len(set(values)):
        raise ValueError(f"Duplicate IDs in {values}")

def validate(cases):
    unique([case["id"] for case in cases])
    for case in cases:
        ZoneInfo(case["timezone"])
        now = datetime.fromisoformat(case["now"].replace("Z", "+00:00"))
        turns = case["history"]
        unique([turn["id"] for turn in turns])
        assert all(datetime.fromisoformat(t["timestamp"].replace("Z", "+00:00")) < now for t in turns)
        assert set(case["gold"]["required_turn_ids"]) <= {t["id"] for t in turns}
        docs = [d for t in turns for d in t["evidence"]] + case["search_fixtures"]
        ids = [d["id"] for d in docs if "id" in d]
        unique(ids)
        assert case["gold"]["criteria"]
        for criterion in case["gold"]["criteria"]:
            assert set(criterion["evidence_ids"]) <= set(ids)
        if case["mode"] == "live":
            assert not case["search_fixtures"]
        for entity in case["gold"]["query_entities"]:
            assert any(entity.casefold() in [a.casefold() for a in d["aliases"]]
                       for d in case["search_fixtures"])

def query_hits(query, fixtures):
    """Example deterministic search adapter. Preserve order and return text only via search."""
    text = "".join(c for c in query.casefold() if c.isalnum())
    return [item for item in fixtures if any(
        "".join(c for c in alias.casefold() if c.isalnum()) in text
        for alias in item["aliases"]
    )]

def canonical_url(url):
    parts = urlsplit(url)
    return (parts.netloc.lower().removeprefix("www."), parts.path.rstrip("/"))

def structural(case, result):
    gold = case["gold"]
    out = {}
    route = result.get("route")
    out["route"] = None if route is None else route == gold["expected_route"]
    selected = result.get("selected_turn_ids")
    if gold["required_turn_ids"]:
        out["required_history"] = None if selected is None else (
            set(gold["required_turn_ids"]) <= set(selected))
    queries = result.get("search_queries")
    expected_search = gold["expected_route"] in ("research", "historical_update")
    out["search_when_needed"] = None if queries is None else bool(queries) == expected_search
    if gold["query_entities"]:
        query_text = ["".join(c for c in q.casefold() if c.isalnum()) for q in (queries or [])]
        terms = ["".join(c for c in e.casefold() if c.isalnum()) for e in gold["query_entities"]]
        out["entity_search_coverage"] = None if queries is None else (
            sum(any(e in q for q in query_text) for e in terms) / len(terms))
    cited = result.get("citations")
    required = [c for c in gold["criteria"] if c["evidence_ids"] or c["acceptable_urls"]]
    if required:
        cited_ids = {c.get("id") for c in cited or []}
        urls = {canonical_url(c["url"]) for c in cited or [] if c.get("url")}
        out["expected_source_coverage"] = None if cited is None else sum(
            set(c["evidence_ids"]) <= cited_ids if c["evidence_ids"]
            else any(canonical_url(url) in urls for url in c["acceptable_urls"])
            for c in required) / len(required)
    return out

def run(cases, command, timeout):
    rows = []
    for case in cases:
        payload = {key: value for key, value in case.items()
                   if key not in ("gold", "split", "category", "pair_id", "prompt_style")}
        if case["mode"] == "live":
            # The adapter uses the real clock for live questions.
            payload.pop("now")
        start = time.perf_counter()
        try:
            process = subprocess.run(shlex.split(command), input=json.dumps(payload), text=True,
                                     capture_output=True, timeout=timeout, check=True)
            result = json.loads(process.stdout)
            if not isinstance(result.get("answer"), str) or not result["answer"].strip():
                raise ValueError("Adapter must return a nonempty answer")
            checks = structural(case, result)
        except (subprocess.SubprocessError, ValueError, OSError, TypeError, AttributeError) as exc:
            # Adapter stdout/stderr can contain credentials. Keep diagnostics local.
            rows.append(dict(id=case["id"], status="adapter_error", error=type(exc).__name__))
            continue
        rows.append(dict(id=case["id"], status="answered", result=result, checks=checks,
                         wall_ms=round((time.perf_counter() - start) * 1000, 1)))
    return rows

def quantile(values, q):
    return round(sorted(values)[math.ceil(q * len(values)) - 1], 1) if values else None

def summary(rows):
    checks = {}
    for row in rows:
        for key, value in row.get("checks", {}).items():
            checks.setdefault(key, [])
            if value is not None:
                checks[key].append(float(value))
    telemetry = {}
    for key in ("agent_ms", "first_answer_text_ms", "input_tokens", "output_tokens", "search_evidence_tokens", "model_calls"):
        values = [r["result"][key] for r in rows if isinstance(r.get("result", {}).get(key), (int, float))]
        telemetry[key] = dict(n=len(values), p50=quantile(values, .50), p95=quantile(values, .95))
    return dict(cases=len(rows), answered=sum(r["status"] == "answered" for r in rows),
                structural={k: dict(n=len(v), mean=round(sum(v) / len(v), 3) if v else None)
                            for k, v in checks.items()}, telemetry=telemetry)

def review_template(cases, rows):
    ids = {r["id"] for r in rows if r["status"] == "answered"}
    return {c["id"]: dict(criteria=[
        dict(met=None, supported=None if rule["evidence_ids"] or rule["acceptable_urls"] else "n/a")
        for rule in c["gold"]["criteria"]], forbidden_claim_seen=None)
        for c in cases if c["id"] in ids}

def grade(cases, rows, reviews):
    by_id = {c["id"]: c for c in cases}
    totals = Counter()
    per_case = {}
    slices = {}
    for row in rows:
        case_id = row["id"]
        case = by_id[case_id]
        bucket = slices.setdefault(case["category"], Counter())
        bucket["cases"] += 1
        review = reviews.get(case_id)
        if row["status"] != "answered" or review is None:
            continue
        rules = case["gold"]["criteria"]
        answers = review["criteria"]
        if len(rules) != len(answers):
            raise ValueError(f"{case_id}: wrong criterion count")
        if type(review["forbidden_claim_seen"]) is not bool:
            raise ValueError(f"{case_id}: complete the forbidden-claim review")
        met, supported, support_count = 0, 0, 0
        for rule, entry in zip(rules, answers):
            if type(entry["met"]) is not bool:
                raise ValueError(f"{case_id}: mark each criterion true or false")
            met += entry["met"]
            if rule["evidence_ids"] or rule["acceptable_urls"]:
                if type(entry["supported"]) is not bool:
                    raise ValueError(f"{case_id}: review citation support")
                supported += entry["supported"] and entry["met"]
                support_count += 1
        passed = met == len(rules) and supported == support_count and not review["forbidden_claim_seen"]
        bucket["graded"] += 1
        bucket["passed"] += passed
        totals.update(dict(graded=1, passed=int(passed), criteria_met=met,
                           criteria_total=len(rules), supported=supported, source_criteria=support_count,
                           forbidden_cases=int(review["forbidden_claim_seen"])))
        per_case[case_id] = dict(passed=passed, met=met, criteria=len(rules),
                                 supported=supported, source_criteria=support_count)
    paired = {}
    for case in cases:
        if case.get("pair_id") and case["id"] in per_case:
            paired.setdefault(case["pair_id"], {})[case["prompt_style"]] = per_case[case["id"]]["passed"]
    pair_results = {}
    pair_counts = Counter()
    for pair_id, results in paired.items():
        if set(results) != {"polished", "chat"}:
            continue
        polished, chat = results["polished"], results["chat"]
        outcome = ("both_pass" if polished and chat else "polished_only" if polished
                   else "chat_only" if chat else "both_fail")
        pair_results[pair_id] = outcome
        pair_counts[outcome] += 1
    return dict(attempted=len(rows), totals=dict(totals), by_category=slices, by_case=per_case,
                wording_pairs=dict(scored=len(pair_results), outcomes=dict(pair_counts), by_pair=pair_results))

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    commands.add_parser("validate")
    execute = commands.add_parser("run")
    execute.add_argument("--split", choices=("dev", "holdout", "live"), required=True)
    execute.add_argument("--adapter", required=True)
    execute.add_argument("--out", required=True)
    execute.add_argument("--timeout", type=float, default=90)
    scoring = commands.add_parser("grade")
    scoring.add_argument("--run", required=True)
    scoring.add_argument("--review", required=True)
    args = parser.parse_args()
    cases = read(ROOT / "cases.json")
    validate(cases)
    if args.action == "validate":
        print(json.dumps(Counter(c["split"] for c in cases), sort_keys=True))
    elif args.action == "run":
        selected = [case for case in cases if case["split"] == args.split]
        rows = run(selected, args.adapter, args.timeout)
        stats = summary(rows)
        write(args.out, dict(split=args.split, results=rows, summary=stats))
        write(str(args.out) + ".review.json", review_template(selected, rows))
        print(json.dumps(stats, indent=2))
        if stats["answered"] != stats["cases"]:
            raise SystemExit(1)
    else:
        print(json.dumps(grade(cases, read(args.run)["results"], read(args.review)), indent=2))

if __name__ == "__main__":
    main()
