# Design

A chat agent on **DeepSeek V4.1 Flash** with **exactly one tool (`web_search`)**, a
generative-UI surface (OpenUI), durable timezone-aware memory, and a parallel
shortlist re-checker that reports what changed with per-item evidence.

**The idea.** Three jobs run on the same retrieved text — answer, recover an old
conversation, say what changed since last time — and they need different slices of
it. So the pipeline never sends raw results to the model. Retrieval is decomposed
into claim-sized clauses, each bound to the entity it is about, and projected into
a compact *action-preserving* digest. The model answers, or the diff is computed,
from that digest. The UI layout, change table and citation ledger are composed by
code from schemas, not written freehand by a small model.

## Porting Coca-Cola

[Coca-Cola](https://arxiv.org/abs/2611.06500) (THU-Agent) compresses tool
observations into **continuous latent tokens** in the agent's embedding space,
trained with **Action-Preserving Training** — aligning the next-action distribution
under full and compressed observations rather than reconstructing text. It reports
**70–89% fewer tokens, 24–56% less runtime**, with accuracy rising.

We cannot do that on a hosted API (no embedding-space access). The *objective*
transfers: **compress toward what determines the next action, not what reconstructs
the observation.** `src/server/digest.ts` is that projection in text:

| Coca-Cola | Here |
|---|---|
| observation → latent tokens | observation → **claim clauses** |
| action-preserving objective | **salience on value-bearing clauses** |
| retains decision-critical info | retained `(entity, attribute, value)` triples, change markers |
| learned compressor | deterministic, model-free |

1. **Clause granularity, not sentence.** "Cursor Pro is $20; Windsurf Pro is $15" is
   one sentence with two subjects. Splitting and binding each clause to the entity it
   names (inheriting on elision) stops a value being attributed to the wrong item —
   the first version shipped sentence-level and produced a fabricated
   "Cursor changed 70.01 → 1.0" from an unrelated page.
2. **Values outrank fluency.** Numbers, versions, dates, prices, percentages and
   status transitions score high; vague hedges are penalised. A summarizer keeps the
   fluent version; this keeps the checkable one.
3. **Subject gating for change checks.** With a subject set, only clauses resolving
   to it are selected. Another product's price on the same page is not evidence.

**Measured** (`npm run bench:digest`, verbatim abstracts, not synthetic):

| scenario | results | naive tok | digest tok | saved |
|---|---|---|---|---|
| single query | 3 | 783 | 303 | **61.3%** |
| typical query | 6 | 1,650 | 281 | **83.0%** |
| over-fetch (count=8) | 8 | 2,173 | 281 | **87.1%** |
| change intent, subject-gated | 8 | – | 206 | **90.5%** |

Same *order* of saving as Coca-Cola, by a different mechanism. We do not claim their
trajectory-level figures — theirs includes re-reads in a multi-step loop this
pipeline does not have.

## Three levels of optimisation

**Component.** Seven components, not forty: the library's signatures are in *every*
prompt, and the whole contract is 3.8 KB. Lists are column-oriented (each key
written once for N rows, ~3× smaller). Code composes data views, the model composes
prose: seven parallel arrays with per-row citation ids is exactly what a small model
gets wrong, and a mis-length array is unrenderable rather than degraded. Every
generated document is validated against the library's own parser before it leaves
the server.

**Pipeline.** `gate(1) → plan(1) → search(1–3 ∥) → digest(free) → answer(1)`.
One job per call; a model asked to decide and compose does both worse. Planning
happens before observation exists (ReWOO, [2305.18323](https://arxiv.org/abs/2305.18323):
5× fewer tokens, +4.4% accuracy, a 7B planner matching GPT-3.5). `count` is unbilled,
so we over-fetch 8 and rank locally instead of paying for more requests. Retrieval is
capped near **3k tokens** — LongMemEval ([2410.10813](https://arxiv.org/abs/2410.10813))
measures 8B readers collapsing past that while GPT-4o improves to 20k. A
deterministic relevance gate (rank + lexical overlap) runs *before* generation, so an
unanswerable question is declined instead of answered. The system prompt is
byte-identical for the process lifetime because the disk cache needs a full
prefix-unit match and a hit costs ⅕ of a miss. The model is never handed a tool
schema: the plan is the tool call.

**Workflow.** Shortlist runs are first-class rows with per-item status and resume only
unfinished items. Baselines advance only on success. Fan-out is bounded so a burst
does not trip account QPS and retry. Baseline and re-check use identical extraction
settings *by construction* — they originally differed, and the baseline absorbed other
items' values, so every later run reported a spurious disappearance. Instants are UTC
milliseconds with the IANA zone stored beside them, and day boundaries are computed by
walking the zone, not by adding 24 h (a DST day is 23 or 25 hours). A date window is
the selector and keywords are only a hint, because filtering a window by the words
"discuss"/"yesterday" discards every conversation that does not repeat them.

## Tradeoffs accepted

| Decision | Cost | Why |
|---|---|---|
| Deterministic extraction, no learned compressor | Some recall loss on odd phrasing | No extra model to ship; cost and latency predictable; every fact inspectable |
| Code composes data views | Less freeform UI | Invalid documents are unrenderable; model-authored tables fail totally, not gracefully |
| 900-token digest cap | Long answers can lose nuance | Readers measurably degrade past ~3k retrieved tokens |
| Deterministic date parser | Odd phrasings fall back to "last 7 days" | A wrong window silently returns the wrong conversation; the fallback is visible |
| `node:sqlite` (experimental) | Boot warning; Node ≥ 22.5 | Zero native compilation is what makes `npm install` work on a clean machine |
| Single tool | No page fetch | ReWOO: 17 of 20 two-tool-vs-seven-tool failures were tool misuse |

## Evals

```bash
npm run eval:offline   # 12 items, real pipeline, scripted model+search, no key
npm run eval           # same suite, live model (needs .env)
npm run bench:digest   # token savings on realistic evidence
npm run test:ui        # renders every component through the real OpenUI runtime
```

| Claim | Metric | Why it is fair |
|---|---|---|
| **Recall accuracy** | exact set match over conversation **ids** | the DB knows which ids fall in the window — checkable, not judged |
| **Change detection** | precision/recall over **planted** changes | the harness plants the drift, so truth is known |
| **Citation support** | share of factual sentences with a valid `[n]`; marker validity | computable from text + citation list |
| **Evidence on changes** | share of changed rows with ≥1 source id | "cite evidence for what changed", measured directly |
| **Latency** | p50 / p95 | wall clock |
| **Token savings** | `1 − digest/raw` on the same results | measured on bytes actually sent |

**Current (scripted backend, 12 items): 100% pass · recall 100% · citation validity
100% · change recall/precision 100%/100% over 5 planted changes, 0 spurious · token
savings 38.9% on the small fixture corpus and 61–87% on realistic evidence.** The two
savings figures differ honestly: at ~120 input tokens the per-citation header
dominates, so the bench uses production-length abstracts. **Answer quality is not
measured** by the scripted backend — its answers derive from its own evidence.

The harness found **twelve defects before producing a score**, ten of them product
bugs: facts attributed to the query's entity rather than the clause's; sentence-level
gating merging two products' prices; entity identity flipping between runs; baseline
and re-check settings diverging; recall matching the *current* conversation; recall's
keyword filter discarding the whole window; the relevance gate missing from this
implementation entirely; a `version` regex matching any decimal; the diff pairing a
new value with the wrong previous one ("$20 → $45" instead of "$40 → $45"); and
"what changed?" re-running the check that had just completed, doubling spend and then
reporting no change.

**Known limits.** "Track X" with a shortlist present re-checks the most recent one
rather than creating a second. The digest is extractive, so a value stated only in
prose contributes no fact. All quality numbers require `.env`.

## Where to look

[`digest.ts`](src/server/digest.ts) the port · [`agent.ts`](src/server/agent.ts) the
pipeline and gate · [`shortlist.ts`](src/server/shortlist.ts) parallel re-check and
durable runs · [`memory.ts`](src/server/memory.ts) the store ·
[`time.ts`](src/server/time.ts) zone-correct windows ·
[`openui.ts`](src/server/openui.ts) prompt, composers, validation ·
[`schema.ts`](src/library/schema.ts) the seven components ·
[`metrics.ts`](evals/metrics.ts) the graders.
