# Minimi evaluations

This directory holds the golden-v2 adapter, LangSmith/local trace trees, DeepEval
harness, and result artifacts. The browser app is evaluated separately by
`tests/e2e.mjs` and `tests/public.mjs`.

## Golden v2 adapter

`adapter.mjs` reads one case JSON from stdin and writes one result JSON to stdout,
matching `golden-v2/run.py`'s contract. It imports the product's real
`MemoryStore`, `runSearchBatch`, digest, billing, time, prompt, and budget code.
It uses a DeepSeek tool-calling loop for the model because the golden runner needs
frozen clocks, imported history, and replay search fixtures; **it is not the DSH
web loop**. The DSH browser path is covered by the browser suites.

What the adapter handles:

- imports history with original timestamps and thread IDs;
- freezes `now` for replay cases and resolves dates in the case timezone;
- closes/reopens SQLite before the prompt when `restart_before_prompt` is set;
- binds replay fixtures to the search/fetch seams (alias matching and provider
  errors) and uses live DeepSeek Search/Fetch for `live` cases;
- adds official `projectminimi.com` / `binary.so` pages for live cases;
- emits route, selected turn IDs, search queries, citations, tokens, latency,
  evidence tokens, cost, and a local trace tree.

Run:

```sh
npm run eval:golden                 # dev
npm run eval:golden:all             # dev, holdout, live
# direct:
python3 evals/golden-v2/run.py run \
  --split dev \
  --adapter "node $PWD/evals/adapter.mjs" \
  --out evals/runs/dev.json
```

## LangSmith

`tracing.mjs` creates one `minimi.golden.case` root per case with
`minimi.memory.import`, `minimi.memory.recall`, `minimi.llm` (usage/cost/latency),
and `minimi.tool.web_search` children. It preflights the key once and caches the
result; a forbidden/expired key falls back to a local JSON tree under
`evals/runs/traces/` so evaluation never depends on the tracing service.

The corrected key now works. Current panel objects:

- Golden project: https://smith.langchain.com/o/b0755f15-5c97-4053-8e80-456075377917/projects/p/0c475f47-77ba-434d-8843-32608252c0bb
- Live project: https://smith.langchain.com/o/b0755f15-5c97-4053-8e80-456075377917/projects/p/dffb19cb-00a6-4a55-ac1f-b1e02ab560a2
- Azure live project (current, metrics-enabled): https://smith.langchain.com/o/b0755f15-5c97-4053-8e80-456075377917/projects/p/ba2e4a76-fcbd-4083-983d-c75f04f08167
- Older Azure live project retained as history: https://smith.langchain.com/o/b0755f15-5c97-4053-8e80-456075377917/projects/p/cd08d93e-9b9e-4f2e-b0c5-a8305db8c4ac
- Golden dataset (64 examples): https://smith.langchain.com/o/b0755f15-5c97-4053-8e80-456075377917/datasets/c4b4362d-35cd-430e-a8ae-39e586f5e11e

Commands:

```sh
npm run langsmith:export      # upload local golden trees
npm run langsmith:feedback    # attach DeepEval + structural/telemetry scores to golden roots
npm run observability:export  # upload live turns; --watch for continuous
```

The public runner supervises `evals/observability-export.mjs --watch`, so new
live turns are uploaded automatically once the key is present. LangSmith
endpoint/project come from `LANGSMITH_ENDPOINT` and `LANGSMITH_PROJECT`
(default `minimi-golden-v2`). Never commit a key. A cached failed preflight
lasts one hour; set `LANGSMITH_FORCE=1` (or delete
`evals/.langsmith-status.json`) after replacing the key.

## DeepEval

`deepeval/run_deepeval.py` implements three levels with `DeepSeekModel` as judge:

- **Component:** deterministic memory selection, search behavior, source
  coverage, citation URL membership; `ContextualRecallMetric`.
- **Pipeline:** `FaithfulnessMetric` and `AnswerRelevancyMetric`.
- **Workflow:** one `GEval` per case over the golden criteria/forbidden claims,
  plus route match and polished/chat pair outcomes.

Run with the eval Python environment (DeepEval 4.3.3):

```sh
python3 -m venv .venv-eval
.venv-eval/bin/pip install -r evals/requirements.txt
set -a; . ./.env; set +a
.venv-eval/bin/python \
  evals/deepeval/run_deepeval.py --splits dev,holdout,live --profile full
```

The judge can be slow and can hit provider timeouts on long retrieval contexts;
use `--profile workflow`, `--case-ids`, or `--max-cases` for a bounded run.
`evals/requirements.txt` records the tested package version.

## Results

See [`runs/REPORT.md`](runs/REPORT.md) for the current structural replay,
telemetry, LangSmith status, and DeepEval sample. The golden structural suite
answers all 64 cases; 62/64 pass every non-null structural check. DeepEval LLM
judging covers a 16-case representative sample because of judge latency. Scores
are semantic and intentionally strict about unsupported dates/details; low
scores are not automatically wrong answers.

## Live app observability

Live trace trees include `retriever.memory.recall` beside `llm.step.*` and `tool.web_search`. The recall span carries the query, timezone, the three SQLite statements used, resolved date window, selected turn/fact/snapshot records, result counts, and rendered context size.

`plugin/src/observability.ts` writes one JSONL row and one JSON turn file per live
turn under `data/observability/`: duration, first committed answer text,
model/tool calls, token split, estimated cost, citations, and spans. Aggregate:

```sh
npm run observability
```

`first_answer_text_ms` currently records the first **committed** assistant text;
the eval adapter is non-streaming, so there it equals total turn latency. A true
first-token measurement for the live DSH stream remains a follow-up.
