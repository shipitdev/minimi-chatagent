#!/usr/bin/env python3
"""
DeepEval citation/groundedness check over a golden run.

DeepEval does not ship a metric literally named "Citation"; the one that answers
the same question is **Faithfulness** — is every claim in the answer supported by
the retrieved evidence — with **ContextualPrecision** as a companion (were the
retrieved passages actually relevant). Both are run here with DeepSeek Flash as the
judge, so the judge is the same model family as the agent (a known limitation,
reported as such).

Input is a golden run JSON produced by `evals/golden/run.py run`, whose adapter
results carry `retrieval_context` (the evidence each answer was allowed to use).

Usage:
    .venv-eval/bin/python evals/deepeval_citations.py runs/golden/dev.json
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from deepeval.metrics import FaithfulnessMetric, ContextualRelevancyMetric
from deepeval.models import DeepEvalBaseLLM
from deepeval.test_case import LLMTestCase

load_dotenv()


class DeepSeekJudge(DeepEvalBaseLLM):
    """DeepEval judge backed by the DeepSeek API (OpenAI-compatible)."""

    def __init__(self) -> None:
        self.api_key = os.environ["DEEPSEEK_API_KEY"]
        self.base_url = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
        self.model_name = os.environ.get("DEEPEVAL_JUDGE_MODEL", "deepseek-flash")

    def load_model(self) -> Any:  # noqa: D401 - DeepEval interface
        import httpx

        self._client = httpx.Client(timeout=90.0)
        return self._client

    def generate(self, prompt: str) -> str:
        import httpx

        resp = httpx.post(
            f"{self.base_url}/chat/completions",
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": self.model_name,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0,
                "max_tokens": 1200,
                "response_format": {"type": "json_object"},
                "thinking": {"type": "disabled"},
            },
            timeout=90.0,
        )
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"]

    async def a_generate(self, prompt: str) -> str:
        return self.generate(prompt)

    def get_model_name(self) -> str:
        return self.model_name


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: deepeval_citations.py <run.json> [out.json]")
        return 2
    run_path = Path(sys.argv[1])
    out_path = Path(sys.argv[2]) if len(sys.argv) > 2 else run_path.with_suffix(".deepeval.json")
    cases_arg = None
    if "--cases" in sys.argv:
        cases_arg = sys.argv[sys.argv.index("--cases") + 1]

    data = json.loads(run_path.read_text())
    cases_path = Path(cases_arg) if cases_arg else Path("evals/golden/cases.json")
    prompts = {}
    if cases_path.exists():
        prompts = {c["id"]: c["prompt"] for c in json.loads(cases_path.read_text())}
    judge = DeepSeekJudge()

    rows: list[dict[str, Any]] = []
    faithful: list[float] = []
    precision: list[float] = []

    for row in data["results"]:
        if row.get("status") != "answered":
            continue
        res = row["result"]
        context = [c for c in (res.get("retrieval_context") or []) if c and len(c) > 40]
        answer = res.get("answer") or ""
        if not context:
            rows.append({"id": row["id"], "skipped": "no retrieval context"})
            continue

        case = LLMTestCase(
            input=row.get("prompt") or prompts.get(row["id"], ""),
            actual_output=answer,
            retrieval_context=context,
        )
        entry: dict[str, Any] = {"id": row["id"]}

        # Faithfulness = citation support: every claim traceable to the evidence.
        try:
            f = FaithfulnessMetric(threshold=0.7, model=judge, include_reason=True)
            f.measure(case)
            entry["faithfulness"] = round(float(f.score), 4)
            entry["faithfulness_reason"] = (f.reason or "")[:300]
            faithful.append(float(f.score))
        except Exception as exc:  # a judge failure must not abort the run
            entry["faithfulness_error"] = str(exc)[:200]

        # Contextual relevancy = were the retrieved passages on-topic. Used instead
        # of ContextualPrecision because the golden set grades against rubrics, not
        # a reference answer, and precision requires `expected_output`.
        try:
            r = ContextualRelevancyMetric(threshold=0.7, model=judge, include_reason=False)
            r.measure(case)
            entry["contextual_relevancy"] = round(float(r.score), 4)
            precision.append(float(r.score))
        except Exception as exc:
            entry["contextual_relevancy_error"] = str(exc)[:200]

        rows.append(entry)
        print(
            f"  {row['id']:4} faithful={entry.get('faithfulness', 'ERR')} "
            f"relevancy={entry.get('contextual_relevancy', 'ERR')}"
        )

    def mean(xs: list[float]) -> float | None:
        return round(sum(xs) / len(xs), 4) if xs else None

    summary = {
        "run": str(run_path),
        "judge": judge.get_model_name(),
        "n": len(faithful),
        "faithfulness_mean": mean(faithful),
        "faithfulness_min": round(min(faithful), 4) if faithful else None,
        "contextual_relevancy_mean": mean(precision),
        "below_threshold": [r["id"] for r in rows if r.get("faithfulness", 1) < 0.7],
    }
    out_path.write_text(json.dumps({"summary": summary, "rows": rows}, indent=1))
    print("\n" + json.dumps(summary, indent=1))
    print(f"\nwritten: {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
