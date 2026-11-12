# DeepEval report — Minimi golden v2

The deterministic golden adapter ran all 64 cases. DeepEval LLM metrics were run on a representative judge sample because the judge is slow and, for long retrieval contexts, can hit provider timeouts.

- Component sample: 8 cases with `ContextualRecall`; deterministic component metrics for all sampled cases.
- Pipeline sample: 6 faithfulness and 8 answer-relevancy cases.
- Workflow sample: 16 case-compliance GEvals.
- Workflow pass: 10/16 (threshold 0.5).
- Route match in sample: 1.0.
- Wording pairs: {'both_pass': 0, 'polished_only': 0, 'chat_only': 0, 'both_fail': 1}.
- Component contextual recall: 0.7292.
- Pipeline faithfulness / answer relevancy: 0.9762 / 0.8433.
- Workflow case compliance: 0.625.

Judge: `deepseek-flash` via `DeepSeekModel`. Semantic scores are noisy and deliberately strict about unsupported dates/details; a low score is not proof the answer is wrong. See `deepeval-*.json` for reasons and per-case data.
