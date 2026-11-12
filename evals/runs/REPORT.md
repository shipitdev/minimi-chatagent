# Minimi observability and evaluation report

## Golden v2 structural replay

- Cases answered: **64/64**
- Whole-case structural pass (all non-null checks): **62/64**
- Split details:
  - dev: 18/18; route 1.0, history 1.0, search 1.0, source 1.0
  - holdout: 40/40; route 1.0, history 1.0, search 1.0, entity 0.977, source 0.99
  - live: 6/6; route 1.0, search 1.0, source 1.0
- Telemetry total: input 154,168 tokens, output 14,613 tokens, estimated cost $0.018785
- Local trace trees: **64** files under `evals/runs/traces/`

Remaining structural misses are partial credit only: h01 source 0.8 and h23-chat entity coverage 0.5 (a vendor timeout/abbreviation).

## LangSmith

Live integration is active with the corrected key:

- golden project: 64 trace roots (plus children) at https://smith.langchain.com/o/b0755f15-5c97-4053-8e80-456075377917/projects/p/0c475f47-77ba-434d-8843-32608252c0bb
- live project: public turns uploaded by the supervised watcher at https://smith.langchain.com/o/b0755f15-5c97-4053-8e80-456075377917/projects/p/dffb19cb-00a6-4a55-ac1f-b1e02ab560a2
- golden dataset: 64 reference examples at https://smith.langchain.com/o/b0755f15-5c97-4053-8e80-456075377917/datasets/c4b4362d-35cd-430e-a8ae-39e586f5e11e
- Feedback: 232 scores attached to golden roots (38 DeepEval + 66 structural + 128 telemetry) (`deepeval.component.contextual_recall`, `deepeval.pipeline.*`, `deepeval.workflow.compliance`, `golden.*`, `telemetry.*`)
- local traces remain under `evals/runs/traces/` as a fallback

## Live app observability

`plugin/src/observability.ts` writes one JSONL row and one JSON turn file per live turn under `data/observability/`, including duration, first committed answer text, model/tool calls, token split, cost, citations, and spans. `npm run observability` aggregates them. Latest observed aggregate (28 public turns): p50 3,385 ms / p95 14,138 ms, first committed text p50 2,655 ms (27 turns), 223,017 input / 19,008 output tokens, 149,504 cache-hit / 73,513 cache-miss tokens, estimated $0.0251, 20 tool calls, 208 citations, 1 interrupted turn.

## DeepEval sample

- Cases judged: 16 (16 unique; deterministic component checks cover all sampled cases)
- Component contextual recall: 0.7292
- Pipeline faithfulness / answer relevancy: 0.9762 / 0.8433
- Workflow case compliance: 0.625 (10/16 pass)
- Route match in judged sample: 1.0
- Wording pairs: {'both_pass': 0, 'polished_only': 0, 'chat_only': 0, 'both_fail': 1}

DeepEval LLM metrics were sampled because judge calls are slow and can hit provider timeouts on long retrieval contexts. Semantic scores are intentionally strict about unsupported dates/details; see `deepeval-*.json` reasons.
