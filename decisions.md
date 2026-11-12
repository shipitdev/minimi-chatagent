# Decisions and experimental evidence

The design choices below describe the current DSH prototype. They do not imply that every alternative was implemented or benchmarked. See [Architecture](architecture.md) for the actual flow.

## Reuse an agent loop rather than own orchestration

The earlier implementation owned routing, planning and answering. We retained its useful search/digest/persistence ideas but adopted pinned DSH for sessions, tool dispatch and streaming. This concentrates project-specific logic in a host plugin and avoids maintaining another transport and model loop.

The tradeoff is upstream coupling: client hooks support branding, while three English strings need a checked build patch. The alternative custom loop is present in the older repository history, but there is **no paired same-model, same-provider head-to-head result** demonstrating that DSH improves latency, cost or answer quality. The choice is about ownership and implementation scope.

## Dated records rather than a rolling summary

An old recommendation is an observation made at a time, under specific terms. SQLite preserves source turns, dates, extracted facts and shortlist snapshots. A rolling summary can lose which version was said when; it was considered as a design alternative, not measured as an ablation.

Bounded lexical selection is inspectable and local. A vector service or hybrid retrieval might improve paraphrase recall, but adds another component; neither has a head-to-head result here. Current limits include a 400-turn candidate horizon, incomplete weekday parsing and unresolved correction precedence across broader conversations. Date filters apply before ranking only when a window resolves.

## Batch independent research within host budgets

Concurrent query execution avoids deliberately serializing independent lookups. Selective Fetch adds original-page evidence without exposing another model tool. Retry attempts consume the host budget, and per-query errors retain partial success.

The offline timeout/concurrency test exercises the real search/digest/SQLite path with mocked HTTP. It proves overlap, attempt counting and failure isolation in that setup. It does **not** measure a live-provider serial-versus-parallel speedup. ReWOO is an influence on independent lookup batching, not an installed planner or a reproduced benchmark.

## Extract passages in code rather than add a compression model

Deterministic extraction avoids an extra model call and makes retained clauses inspectable. Coca-Cola motivates the evidence-budget experiment; this code is not its trained latent compressor. A second-model summarizer, latent compressor and uncompressed-answer baseline have not been compared on matched end-to-end tasks.

The offline [digest benchmark](tests/digest-bench.ts) replays recorded research excerpts:

| Results | Raw JSON estimate | Full tool-text estimate | Reduction |
| --- | ---: | ---: | ---: |
| 3 | 890 | 623 | 30.0% |
| 6 | 1,860 | 741 | 60.2% |
| 8 | 2,452 | 763 | 68.9% |

These character-based estimates explain the draft's rounded 30%, 60%, 69%. Full tool text includes report metadata, URLs and citation rules, but excludes DSH context, runtime wrappers and the final budget footer. Digest-only reductions were larger (61.3%, 83.0%, 87.1%) and use a different raw-excerpt denominator. Neither establishes billed savings, faster turns or equivalent answer quality.

A saved semantic case retains a 100 GB quota but drops its calendar reset. Other cases lose available prices through subject gating. The next experiment should hold model, queries and retrieved results fixed, vary evidence budget, and grade completeness, qualifier retention, citation support, actual usage and latency together.

## Compare terms before numbers

Typed billing terms prevent comparing a monthly offer against an annual commitment as though the difference were a price change. Partial snapshot updates retain untouched verified attributes. Offline tests cover selected currency/billing/unit/seat-minimum cases and partial refreshes; this is not a complete parser for every offer qualifier. Region/tier identity and model-supplied subject keys remain important limitations.

## Evaluate at several levels

| Evidence | Saved result | What it establishes |
| --- | --- | --- |
| Local browser suite, recorded November 11 | 8/8 | Branded UI, direct chat, live search/citations, fixture change view, restart recall in that suite |
| Golden v2 adapter | 64/64 answered; 62/64 structural passes | Applicable history/search/entity/source checks under the adapter |
| DeepEval sample | 16 cases; workflow 10/16 at threshold 0.5 | Rubric-based sampled completeness, not a population pass rate |
| Available semantic metrics | Recall .7292; faithfulness .9762; relevancy .8433 | Means over available metric samples; coverage differs |
| Manual challenge walkthroughs | Owner reports 3/3 acceptance | Manual acceptance, distinct from diagnostic grading |

The curated suite has 18 dev, 40 holdout and 6 live prompts. Sixteen paired scenarios share evidence and criteria across explicit/casual wording; those are correlated variants. Synthetic replay uses frozen clocks, dated history and retrieval fixtures, with the live answering model. Live cases also call the provider's retrieval services. References are withheld from answering prompts. Inspected holdout cases are exposed and should not be reused as untouched confirmation.

The [saved report](evals/runs/REPORT.md) and [DeepEval summary](evals/runs/deepeval-summary.json) contain counts and reasons. The adapter differs from DSH in routing, instructions and model settings; its route score is not proof of autonomous website routing. Judge context sometimes omits metadata visible to the answer model.

The exact-prompt browser diagnostic independently found the successes stated in DESIGN.md: five CRM identities and two updates, November 3 recall and a price increase, and Tuesday's earlier Postgres provider. It also found missing current prices, older-thread leakage, overconfident stability wording and currency rendering errors. Manual acceptance does not erase those observations. See [browser review](docs/challenge-chat-review.md).

## What still needs a head-to-head result

- Custom loop versus DSH with identical model, provider, histories and tasks.
- Raw evidence versus extraction at several budgets, including a simple baseline, on answer quality and latency.
- Lexical dated recall versus summary/vector/hybrid retrieval on exact-turn recovery and corrections.
- Serial versus parallel provider lookups on matched successful and partial-failure workloads.
- Reasoning settings under the production profile, including true streaming TTFT and complete call accounting.

LongMemEval supplies memory-test motivation, not a claimed benchmark result. LangSmith makes traces and feedback inspectable; its presence is not proof of answer quality. Next work should turn bad real conversations into production-path regressions before adding more orchestration or dashboards.
