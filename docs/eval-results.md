# Golden eval results

Model: `deepseek-flash` (DeepSeek-V4.1-Flash-1017). Dev/holdout replay search from fixtures with a frozen clock; live uses real web search and the real clock.

## Structural checks (runner-scored)

| Split | Cases | Answered | Route | Required history | Search when needed | Entity coverage | Expected sources |
|---|---|---|---|---|---|---|---|
| dev | 10 | 10 | 100% (n=10) | 100% (n=6) | 100% (n=10) | 100% (n=5) | 100% (n=4) |
| holdout | 16 | 16 | 100% (n=16) | 100% (n=7) | 100% (n=16) | 100% (n=8) | 100% (n=7) |
| live | 6 | 6 | 100% (n=6) | – | 100% (n=6) | – | 83% (n=6) |

## Telemetry

| Split | agent_ms p50 | p95 | model calls p50 | search-evidence tokens p50 |
|---|---|---|---|---|
| dev | 1096 | 3252 | 1 | 47 |
| holdout | 980 | 4132 | 1 | 57 |
| live | 9857 | 11830 | 3 | 796 |

## DeepEval groundedness (DeepSeek judge)

| Split | n with evidence | Faithfulness (mean) | min | Contextual relevancy | Below 0.7 |
|---|---|---|---|---|---|
| dev | 6 | 0.925 | 0.75 | 0.4611 | 0 |
| holdout | 7 | 0.9235 | 0.7143 | 0.6685 | 0 |
| live | 6 | 0.9306 | 0.7273 | 0.2588 | 0 |

## Live case detail

- **l01** — route `research`, 12 citations, 2 from the official domain, expected-source coverage `1.0`
- **l02** — route `research`, 23 citations, 2 from the official domain, expected-source coverage `1.0`
- **l03** — route `research`, 17 citations, 2 from the official domain, expected-source coverage `1.0`
- **l04** — route `research`, 22 citations, 1 from the official domain, expected-source coverage `0.0`
- **l05** — route `research`, 25 citations, 2 from the official domain, expected-source coverage `1.0`
- **l06** — route `research`, 19 citations, 2 from the official domain, expected-source coverage `1.0`

## Known failures

- **l04 (live)**: the expected source is `https://binary.so/YIrD8L5`, a job listing. The search index does not contain it (`site:binary.so` returns a different role) and the official site has no careers link, so the URL is undiscoverable with a single search tool. Reported rather than guessed.
- **DeepEval coverage is partial**: only cases whose answer used retrieved evidence carry a retrieval context. Recall answers quote the user's own transcript, which is provenance rather than retrieval, so groundedness is not scored there.

Regenerate:
```bash
python3 evals/golden/run.py run --split dev --adapter 'node --import tsx evals/adapter.ts' --out runs/golden/dev.json
python3 evals/golden/run.py run --split holdout --adapter 'node --import tsx evals/adapter.ts' --out runs/golden/holdout.json
python3 evals/golden/run.py run --split live --adapter 'node --import tsx evals/adapter.ts' --out runs/golden/live.json
.venv-eval/bin/python evals/deepeval_citations.py runs/golden/holdout.json
```
