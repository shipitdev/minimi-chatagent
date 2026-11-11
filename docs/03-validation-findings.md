# Validation findings

Nine defects found by the scripted-backend drills, in the order they surfaced.
Every one had passed the 33 offline self-tests that existed at the time, and
several would have been invisible to answer-quality grading. This file exists
because the *method* matters more than the fixes: what caught each bug, and what
would have caught it earlier.

| # | Defect | Class | Caught by |
|---|---|---|---|
| 1 | Mock parsed the planner prompt with the wrong casing, silently using the whole prompt as a query | test-infrastructure | full-suite run (3 searches on a no-search item) |
| 2 | `max_search_requests` equalled `max_queries_per_plan`, so the corrective pass could never fire | counter sizing | unit test asserting the intended behaviour |
| 3 | `HarnessState` defaults drifted from `Settings` | duplicated default | unit test |
| 4 | Refusal grader's cue list omitted the agent's own honest-failure wording | grader fidelity | honest-category run |
| 5 | `must_contain` graded as a conjunction, so `["12,000","12000"]` required *both* spellings | data-model | recall drill |
| 6 | Compaction trigger measured the trimmed window, so it could never fire | **design bug** | stress drill |
| 7 | `registry or SourceRegistry()` discarded the caller's registry because `__len__` makes it falsy | **design bug** | citation drill |
| 8 | Relevance gate rejected a rerank-2.9 result because one question word was absent from the page | **design bug** | citation drill turn 2 |
| 9 | Tokeniser kept `lost-in-the-middle` and `ordering.` as single tokens, so comparisons failed | **design bug** | relevance-gate trace |
| 10 | `usage_delta()` read key `calls`; `Usage.as_dict()` emits `completion_calls` — so LLM-calls-per-item was 0.00 in every run | **metric corruption** | inspecting a per-item row for an unrelated reason |

---

## The three that mattered

### 6. The compaction trigger could never fire

`Compactor.enforce()` did:

```python
if not self.should_trim(messages):      # messages = the TRIMMED window
    return produced
```

`_base_messages()` returns only the last `keep_recent_turns` turns. So the token
count being compared against the threshold was the size of a window that had
already been bounded. Once it was small, the condition was permanently false:
compaction stopped happening and conversation growth went unnoticed.

**Fix:** compare the *full uncompacted* history against the thresholds
(`full_history_tokens()`), keeping the trimmed window only as what gets sent.

**Why it matters beyond this bug:** it is the difference between a mechanism that
runs and one that only appears to. The stress drill reported "6/6 identifiers
survived" while compaction never fired — a green result that proved nothing. The
drill now records `vacuous: not bool(layers)` and would flag that.

### 7. A falsy registry silently discarded

```python
self.registry = registry or SourceRegistry()     # WRONG
```

`SourceRegistry` defines `__len__` to report how many sources it knows. Python
therefore treats an **empty** registry as falsy, so `or` substituted a fresh one.
Every `EvidenceStore` got its own registry, the conversation-level registry stayed
empty, and — worst — citations looked correct *within* a single turn, because a
fresh registry numbers from 1 anyway. Turn 1 cited `[1,2,3]` and the check passed.
Only cross-turn checking exposed it: the drill reported `registry size 0` while
three sources had been cited.

**Fix:** explicit `if registry is not None`, with a comment recording the trap.

**Why it matters beyond this bug:** it is the strongest argument in this project
for checking *internal invariants* rather than only end-to-end outputs. No amount
of answer-quality grading would have surfaced a registry that is right by
accident.

### 8. The relevance gate rejected perfect results

Added in response to the `honest` items failing: with only irrelevant results
retrieved, the agent wrote a confident answer from a directory listing. The gate
compares the best `rerank_score` and the lexical overlap between question and
evidence. First implementation divided the overlap by the **full query**:

```python
overlap = len(qterms & rterms) / len(qterms)
```

Asked "what does lost in the middle **imply** for prompt **ordering**", the
top-ranked result — *Lost in the Middle: How Language Models Use Long Contexts*,
rerank 2.9, authority 4 — was discarded because the page never uses the word
"imply". One unmatched function word vetoed a correct answer.

**Fix:** the *overlap coefficient* — `len(q ∩ r) / min(len(q), len(r))` — which
asks how much of the result's vocabulary the question reaches into. That is the
question actually being asked: is this page about the query. Threshold 0.15.

Defect 9 was neatly stacked underneath it: `terms()` keeps hyphens and internal
periods so identifiers like `eu-west-2` and `gpt-3.5` survive as single units
(which is right for indexing), but that made `lost-in-the-middle` one token that
matched nothing. A separate `canon_terms()` now hyphen-splits and strips
punctuation for *comparison*, while `terms()` keeps identifiers intact for
*indexing*.

### 10. A metric that read zero for every run

`usage_delta()` built its delta from a hardcoded key list containing `calls`.
`Usage.as_dict()` emits `completion_calls`. Since `dict.get(k, 0)` returns 0 for a
missing key, **`llm calls/item` reported 0.00 in every configuration** while token
counts, cost and cache figures were all correct — which made the discrepancy
invisible, because the surrounding numbers looked plausible.

It was caught only by inspecting an individual result row while investigating
something else. The ablation table had been used to argue that planning costs 29%;
the actual figure is 5.75 vs 4.0 model calls per item, i.e. the planner's cost was
understated as zero.

**Fix:** a `_USAGE_KEYS` constant shared by the producer and consumer, plus an
explicit `raise KeyError` when a snapshot is missing expected keys, plus a
self-test pinning the key list.

**Why it matters:** this is the most dangerous class of defect in an evaluation
harness. A wrong number invites scrutiny; a *missing* number silently reads as
zero and blends into the table. Any metric derived by key lookup should fail
loudly rather than default.

---

## Ablations that argue for deleting code

Two ablation results point at removing features rather than fixing them:

- **`no_corrective` — no measurable benefit, 3% extra cost, 0.9 extra calls per
  item.** The corrective re-query is the component closest to the self-critique
  shape the literature condemns. It fired and changed nothing.
- **`no_planning` — 29% cheaper and 1.75 fewer model calls per item, with no
  measurable accuracy loss.** This *contradicts* ReWOO's published 5× token win,
  and the contradiction is informative: the mock returns a fixed corpus per topic,
  so a single well-chosen query finds what a three-query plan finds. ReWOO's
  advantage comes from avoiding re-read observations in a multi-step loop, and
  this harness has no such loop — it is structurally incapable of measuring the
  effect it is being used to judge.

The scripted backend structurally cannot test the planning claim. Both findings
are parked pending a live run rather than acted on.

## What this implies for the evaluation design

Every defect above was found by asserting on an **internal invariant** — a
registry size, a counter firing, a decision flag — not by grading an answer. The
harness drill was worth more than tripling the item count would have been.

The corresponding risk is that the scripted backend is now tuned to the agent. A
mock that has been debugged until it agrees with its subject is no longer an
independent check, which is exactly why the `mock` flag is recorded in every
result file and why every number in §6.3 is labelled as a harness baseline rather
than a quality measurement.
