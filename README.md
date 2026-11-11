# minimi

A chat agent on **DeepSeek V4.1 Flash** with **exactly one tool — `web_search`** —
that answers questions, **recovers dated conversations** from durable memory, and
**re-checks a whole shortlist in parallel** to report what changed, with evidence
attached to every change.

Answers arrive as **generative UI** ([OpenUI](https://www.openui.com/)) — citation
ledgers, change tables, recall timelines — not just text.

> **Start with [`Design.md`](Design.md).** It explains the architecture, the
> Coca-Cola port (arXiv [2611.06500](https://arxiv.org/abs/2611.06500)), the
> tradeoffs, and the measured results.

```bash
npm install
cp .env.example .env      # add DEEPSEEK_API_KEY
npm run dev               # → http://localhost:5173
```

Requires **Node ≥ 22.5** (uses the built-in `node:sqlite`, so there is nothing to
compile).

## No API key? It still runs

```bash
npm run demo              # dev server on a scripted backend, no network
```

Every label in the UI is real; only the model and search calls are scripted, and
the server says so on boot. This is how the eval harness runs in CI.

## What it does

| Ask | What happens |
|---|---|
| “What did Coca-Cola report for token reduction?” | plans queries → searches in parallel → digests → answers with `[n]` citations and a source ledger |
| “What did we discuss yesterday?” | resolves *yesterday* **in your timezone** → returns the matching conversations as a timeline |
| “Track the pricing of AI coding agents” | builds a shortlist with a baseline snapshot of each item's values |
| “What changed?” | re-checks **every item in parallel**, diffs the values deterministically, and reports what changed with the citation for each row |

## Commands

```bash
npm run dev              # server (8787) + client (5173), hot reload
npm run demo             # same, scripted backend, no key needed
npm run build            # production client bundle
npm run typecheck        # tsc --noEmit
npm run test:ui          # renders every component through the real OpenUI runtime
npm run eval:offline     # 12-item suite on the scripted backend
npm run eval             # same suite against the live model
npm run bench:digest     # token savings on realistic-length evidence
npm run smoke            # one live Flash turn, 10 assertions, real search
npm run eval:golden -- --split holdout --out runs/golden/holdout.json   # golden set
npm run eval:citations   # DeepEval groundedness over the golden runs
```

## How it is put together

```
src/server/
  index.ts      HTTP + SSE (staged progress for slow turns and re-checks)
  agent.ts      the four-way pipeline, relevance gate, trace
  digest.ts     ★ action-preserving digest: clauses, salience, facts, diffs
  shortlist.ts  parallel re-check, durable/resumable runs, baseline parity
  memory.ts     durable timezone-aware store (node:sqlite)
  time.ts       zone-correct day windows, "yesterday" resolution
  openui.ts     OpenUI prompt generation, deterministic composers, validation
src/library/    the seven components, shared by server and client
src/client/     React shell + OpenUI renderers
evals/          test set, metrics, runner, digest benchmark
```

## Results (scripted backend, 12 items)

| Metric | Value |
|---|---|
| Pass rate | 100% (12/12) |
| Recall accuracy (conversation-set exact match) | 100% |
| Citation validity | 100% |
| Change detection recall / precision | 100% / 100%, 0 spurious |
| Token savings, realistic evidence | **61–87%** |

Answer *quality* is not measured by the scripted backend — see
[`Design.md` §5](Design.md).

## Golden eval

`evals/golden/` is an external 32-case golden set (10 dev / 16 holdout / 6 live)
driven through the product's real entry point by [`evals/adapter.ts`](evals/adapter.ts):
it imports history with original ids and timestamps, replays `search_fixtures`
through the search seam, freezes the clock, honours `restart_before_prompt`, and
reports routes, selected turn ids, queries, citations and telemetry.

Latest results: [`docs/eval-results.md`](docs/eval-results.md).

| Split | Answered | Route | Required history | Search when needed | Expected sources |
|---|---|---|---|---|---|
| dev | 10/10 | 100% | 100% | 100% | 100% |
| holdout | 16/16 | 100% | 100% | 100% | 100% |
| live | 6/6 | 100% | – | 100% | 83% |

DeepEval groundedness (DeepSeek judge): faithfulness 0.925 / 0.924 / 0.931.

## Observability (LangSmith)

Tracing is only useful if it is reviewable, so names and metric keys are fixed in
[`src/server/tracing.ts`](src/server/tracing.ts) and checked by an audit.

| Run name | Type | Emits |
|---|---|---|
| `minimi.turn` | chain | all 13 turn metrics below |
| `minimi.llm.chat` | llm | `input_tokens`, `output_tokens`, `total_tokens`, `cache_hit_tokens`, `cost_usd`, `latency_ms`, `usage_metadata` |
| `minimi.tool.web_search` | tool | `results`, `cost_usd`, `latency_ms`, `urls` |
| `minimi.tool.fetch_page` | tool | `results`, `cost_usd`, `latency_ms`, `chars` |

Turn metrics: `route, model_calls, search_calls, input_tokens, output_tokens,
total_tokens, cache_hit_tokens, cost_usd, latency_ms, citations,
selected_turn_ids, search_queries, ui_validation`.

```bash
npm run smoke           # produces a traced turn
npm run trace:audit     # reads the turns back from LangSmith and fails on any gap
npm run ls:experiment -- --split holdout   # dataset + experiment with per-case scores
```

`trace:audit` re-reads traces from LangSmith (not local state) and fails if a metric
is missing, a span name is unknown, or the turn's aggregate disagrees with the spans
beneath it — that last check is what catches an under-reported model call. Traces
declare `observability_contract`; the audit ignores pre-contract history instead of
reporting it as a defect.

`ls:experiment` uploads each split as a dataset and logs an experiment whose
per-case feedback is `route_match`, `history_recall`, `search_when_needed`,
`source_coverage` — visible in LangSmith's Datasets & Experiments view.

## Test set

`evals/testset.jsonl` is JSONL, one item per line, and the runner accepts your own:
`npm run eval -- --testset mine.jsonl`. Categories: `answer`, `recall`, `change`,
`honest`, `chat`. Grading is deterministic wherever possible (conversation ids,
planted value changes, citation resolution) and never asks a model to grade itself.

## Notes

- **Single tool by design.** `web_search` only — and the model is never handed a
  tool schema. It writes a plan; the harness executes the one tool. ReWOO's failure
  analysis found 17 of 20 tool-count failures were tool misuse, so a narrow action
  surface is deliberate.
- **Timezone-aware.** Instants are UTC ms; the IANA zone is stored beside them, so
  “yesterday” is per-user and DST-correct.
- **`node:sqlite` is experimental** in Node 22 and prints a warning at boot. The
  tradeoff is deliberate: zero native compilation.
- **`.npmrc` points the npm cache at the project.** The machine this was built on
  has root-owned files in `~/.npm`, which makes any global-cache write fail with
  `EPERM`. A project-local cache keeps `npm install` working without a
  `sudo chown`. Delete `.npmrc` if your global cache is healthy.
