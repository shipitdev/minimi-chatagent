#!/usr/bin/env python3
"""
Assemble the V2 private report.

Input: the raw run files, the DeepEval files, and the frozen build manifest.
Output: `.private-evals/v2/summary.md`, `trace_ids.json`, and a leak check.

Pass definition: a case passes when **every structural check the runner scored is
1.0** (route, required history, search-when-needed, entity coverage, expected
sources). The runner's other pass definition — rubric criteria met, citations
supported, no forbidden claim — requires a human review file that does not exist
for this run, so this report does not claim it. Pair outcomes are therefore
*structural* outcomes, and are labelled that way.
"""

from __future__ import annotations

import json
import re
from collections import Counter
from pathlib import Path

OUT = Path(".private-evals/v2")
CASES = json.loads(Path("evals/golden-v2/cases.json").read_text())
BY_ID = {c["id"]: c for c in CASES}
SPLITS = ["dev", "holdout", "live"]


def passed(row: dict) -> bool:
    checks = {k: v for k, v in (row.get("checks") or {}).items() if v is not None}
    return bool(checks) and all(v >= 1 for v in checks.values())


def load(split: str) -> dict:
    return json.loads((OUT / f"{split}-raw.json").read_text())


def load_deepeval(split: str) -> dict | None:
    p = OUT / f"{split}-deepeval.json"
    return json.loads(p.read_text()) if p.exists() else None


lines: list[str] = []
lines.append("# Minimi golden eval V2 — results\n")
freeze = json.loads((OUT / "FREEZE.json").read_text())
lines.append(
    f"Frozen build **{freeze['build_hash']}** at {freeze['frozen_at']}"
    + (f" (git `{freeze['git_head']}`)" if freeze.get("git_head") else " (no git)")
    + f", model `{freeze['model']}`.\n"
)
lines.append(
    "Fixes were made against the **dev** split only. The build was hashed immediately "
    "after dev went green, and holdout/live were run once against that hash.\n"
)

# ---------------------------------------------------------------- structural
lines.append("## Structural results (runner-scored)\n")
lines.append("| Split | Cases | Answered | Route | Required history | Search when needed | Entity coverage | Expected sources |")
lines.append("|---|---|---|---|---|---|---|---|")
split_summary: dict[str, dict] = {}
for s in SPLITS:
    d = load(s)
    su = d["summary"]
    st = su["structural"]
    split_summary[s] = su
    def g(k: str) -> str:
        v = st.get(k)
        return f"{v['mean']*100:.0f}% (n={v['n']})" if v else "–"
    lines.append(
        f"| {s} | {su['cases']} | {su['answered']} | {g('route')} | {g('required_history')} | "
        f"{g('search_when_needed')} | {g('entity_search_coverage')} | {g('expected_source_coverage')} |"
    )
lines.append("")

# ---------------------------------------------------------------- telemetry
lines.append("## Telemetry\n")
lines.append("| Split | agent_ms p50 | p95 | model calls p50 | evidence tokens p50 |")
lines.append("|---|---|---|---|---|")
for s in SPLITS:
    t = split_summary[s]["telemetry"]
    se = (t.get("search_evidence_tokens") or {})
    lines.append(
        f"| {s} | {t['agent_ms']['p50']} | {t['agent_ms']['p95']} | {t['model_calls']['p50']} | {se.get('p50')} |"
    )
lines.append("")

# ---------------------------------------------------------------- deepeval
lines.append("## DeepEval groundedness (DeepSeek judge)\n")
lines.append("Judged on cases whose answer used retrieved evidence. Recall answers quote the user's transcript, which is provenance rather than retrieval, so they are not scored here.\n")
lines.append("| Split | n | Faithfulness mean | min | Contextual relevancy | Below 0.7 |")
lines.append("|---|---|---|---|---|---|")
deepeval_summary = {}
for s in SPLITS:
    de = load_deepeval(s)
    if not de:
        lines.append(f"| {s} | – | – | – | – | – |")
        continue
    x = de["summary"]
    deepeval_summary[s] = x
    below = ", ".join(x["below_threshold"]) or "none"
    lines.append(
        f"| {s} | {x['n']} | {x['faithfulness_mean']} | {x['faithfulness_min']} | "
        f"{x['contextual_relevancy_mean']} | {below} |"
    )
lines.append("")

# ---------------------------------------------------------------- pairs
lines.append("## Wording pairs (polished vs casual)\n")
lines.append(
    "V2 adds 16 scenarios with two prompts each. Pass here is the structural pass defined "
    "above; a rubric-level comparison needs the review file, which was not produced.\n"
)
pair_rows = []
for s in SPLITS:
    d = load(s)
    per_case = {r["id"]: passed(r) for r in d["results"] if r.get("status") == "answered"}
    pairs: dict[str, dict[str, bool]] = {}
    for cid, ok in per_case.items():
        c = BY_ID.get(cid)
        if not c or not c.get("pair_id"):
            continue
        pairs.setdefault(c["pair_id"], {})[c["prompt_style"]] = ok
    counts = Counter()
    for pid, res in sorted(pairs.items()):
        if set(res) != {"polished", "chat"}:
            continue
        pol, chat = res["polished"], res["chat"]
        outcome = (
            "both_pass" if pol and chat else
            "polished_only" if pol else
            "chat_only" if chat else
            "both_fail"
        )
        counts[outcome] += 1
        pair_rows.append((s, pid, outcome, pol, chat))
    if counts:
        lines.append(f"**{s}**: " + ", ".join(f"{k} {v}" for k, v in sorted(counts.items())) + "\n")

flagged = [r for r in pair_rows if r[2] == "polished_only"]
lines.append("### Cases where the polished prompt passed and the casual prompt failed\n")
if flagged:
    for s, pid, _outcome, _pol, _chat in flagged:
        c = next((x for x in CASES if x.get("pair_id") == pid and x["split"] == s), None)
        chat_case = next((x for x in CASES if x.get("pair_id") == pid and x.get("prompt_style") == "chat"), None)
        lines.append(f"- **{pid}** ({s}) — casual prompt: “{chat_case['prompt'] if chat_case else '?'}”")
        if c:
            lines.append(f"  - category `{c['category']}`, expected route `{c['gold']['expected_route']}`")
else:
    lines.append("None: every pair that passed structurally, passed in both wordings.")
lines.append("")

# ---------------------------------------------------------------- failures
lines.append("## Failing cases (structural)\n")
for s in SPLITS:
    d = load(s)
    fails = []
    for r in d["results"]:
        if r.get("status") != "answered":
            fails.append((r["id"], [f"adapter_error: {r.get('error')}"]))
            continue
        bad = [f"{k}={v:.2f}" for k, v in (r["checks"] or {}).items() if v is not None and v < 1]
        if bad:
            fails.append((r["id"], bad))
    lines.append(f"**{s}** — {len(fails)} failing of {split_summary[s]['cases']}\n")
    for cid, why in fails:
        lines.append(f"- `{cid}` — {', '.join(why)}")
    if not fails:
        lines.append("- none")
    lines.append("")

# ---------------------------------------------------------------- traces + leak check
trace_ids = {}
for s in SPLITS:
    for r in load(s)["results"]:
        tid = (r.get("result") or {}).get("trace_id")
        if tid:
            trace_ids[r["id"]] = tid
(OUT / "trace_ids.json").write_text(json.dumps(trace_ids, indent=1))

lines.append("## LangSmith traces\n")
lines.append(f"{len(trace_ids)} of {sum(len(load(s)['results']) for s in SPLITS)} cases have a trace id, listed in `trace_ids.json`.\n")

secret_pattern = re.compile(r"(sk-[A-Za-z0-9]{8,}|lsv2_[A-Za-z0-9_]{8,}|x-api-key)")
leaks = []
for p in OUT.rglob("*"):
    if p.is_file() and p.suffix in {".json", ".md"}:
        if secret_pattern.search(p.read_text(errors="ignore")):
            leaks.append(p.name)
lines.append("## Export hygiene\n")
lines.append(
    "- API keys: **none found** in this directory." if not leaks
    else f"- **WARNING** possible secret material in: {', '.join(sorted(leaks))}"
)
lines.append("- `.private-evals/` is git-ignored; raw results stay local.\n")

(OUT / "summary.md").write_text("\n".join(lines))
print("\n".join(lines[:60]))
print(f"\nwritten: {OUT/'summary.md'} and {OUT/'trace_ids.json'}")
