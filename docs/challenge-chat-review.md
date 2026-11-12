# Exact challenge questions — browser review

Date: 2026-11-12, Asia/Kolkata.

## Manual acceptance — green pass

The project owner reports that manual testing gave all three challenge questions a **green pass**. This is the owner's acceptance result; it was not independently rerun or scored in this update.

| Challenge question | Owner-reported manual result |
| --- | --- |
| Monday's five CRM tools: pricing and major releases | PASS |
| November 3 question: recall and current correctness | PASS |
| Last Tuesday's Postgres hosting: pricing changes | PASS |

The earlier diagnostic run below used its own isolated fixture setup and found completeness and rendering issues. Its observations remain recorded separately from the owner's manual acceptance. These were single diagnostic attempts, not pass-rate estimates.

## Runs and boundaries

- Public website: all three exact prompts submitted through the DSH UI at `https://minimi.sparetokens.tech`. Real model and production memory; no synthetic history inserted into the public database. The first two prompts ended up in the same new conversation; the third used another new conversation.
- Production database inspection found 33 pre-test turns, no CRM-related user turns, and no turns dated November 3, 9, or 10. PostgreSQL-related records existed, but not the requested historical conversation.
- Seeded run: real DeepSeek model, installed DSH loop, local browser, isolated DSH home and SQLite database. Synthetic histories and Search/Fetch fixtures adapted from golden h01/d02; not live vendor facts. Old evidence was passed through product `runSearchBatch`, creating five baseline snapshots before server startup. The store was closed/reopened. Added a November 10 PineDB $15 baseline and current $18 fixture to distinguish November 10 from November 3.
- The current clock remained November 12. “Monday” means November 9 and “last Tuesday” means November 10. Questions were unchanged; gold rubrics were not added to model prompts.
- The fixture provider deliberately returns the same mixed pool for paraphrased queries. This tests evidence selection among distractors; it is not a measurement of live provider ranking. Answers share the isolated profile, as normal conversations do.
- The first isolated startup failed on sandbox listening permissions and package resolution from the temporary DSH home. Retried with a node_modules link and authorized local-server execution; completed all three browser cases.

## Public website: absent-history behavior

| Exact question | Recorded server duration | Search calls | Assessment |
| --- | ---: | ---: | --- |
| Monday's five CRM tools | 3.393 s | 0 | Correctly asks for the missing shortlist; unnecessarily mentions unrelated remembered topics |
| November 3 question and correctness today | 2.270 s | 0 | Correctly declines to reconstruct missing history; overstates knowledge of the complete stored-record horizon |
| Last Tuesday's Postgres hosting prices | 3.653 s | 0 | Correctly declines to invent vendors/prices; 1,238-character response is excessive for a clarification |

Durations come from matched live observability rows, not browser automation waits. A stale turn-tail counter caused the second browser wait to time out after the answer had completed; it was not a three-minute model response. Answer content was checked against the persisted turn. No private transcripts are reproduced here.

The public questions establish abstention under missing history. They do **not** establish successful historical comparison.

## Seeded case 1: Monday CRM shortlist

Browser completion: **16.734 s**. Expected: QuillCRM $18→$22 on comparable monthly terms; Marlin current $20 with no old price; Moss $19 annual offer is not comparable with old $24 monthly; Rill $15 observed twice without inferring a continuously unchanged interval; Cedar November 10 call-transcription release.

Observed:

- Recovered the intended five CRMs and omitted the unrelated five-seat shortlist.
- Found Quill's price increase and Cedar's release, with clickable fixture citations.
- Kept the annual/monthly distinction for Moss and the unknown old Marlin price.
- Declared Rill “No change” and said it “held at $15,” overstating what two observations prove.
- Referred to “MossCRM dropped from $24 to $19” before its billing caveat; this wording implies more than the non-comparable observations establish.
- Dollar amounts in prose/table cells rendered as malformed inline math. The screenshot visibly confirms this; it is not just text-extraction noise.

**Verdict: useful partial answer, fails strict temporal/comparability wording and presentation quality.**

## Seeded case 2: November 3 plus fresh verification

Browser completion: **10.005 s**. Expected: recover TernDB/ValeSQL comparison; TernDB $19→$24 effective November 8; ValeSQL current $17, with no defensible change claim because its previous price was unknown.

Observed:

- Recovered the correct November 3 question and TernDB's change/date.
- Missed the available ValeSQL $17 fixture and said current pricing could not be retrieved.
- Claimed the “shortlist reasoning ... stands unchanged” without revalidating that reasoning, and discussed a narrowing price gap despite lacking the old ValeSQL price.
- Tool baseline lookups returned none for verbose model subjects even though canonical baselines had been seeded; the answer fell back to historical conversation text.
- Unescaped dollar delimiters again produced visibly broken math rendering.

**Verdict: incomplete and includes unsupported conclusions; not a good full answer.**

## Seeded case 3: last Tuesday Postgres prices

Browser completion: **14.938 s**. Expected: select November 10's PineDB comparison and report $15→$18, effective November 11; exclude November 3's TernDB/ValeSQL comparison unless explicitly needed as clarification.

Observed:

- Identified Tuesday November 10 and the PineDB $15 historical figure correctly.
- Missed PineDB's available current $18 evidence and answered that the price could not be refreshed.
- Searched and discussed TernDB/ValeSQL from the older, unrelated comparison.
- Claimed “No change since Tuesday” for TernDB from an effective date/current observation without evidence of the full interval.

**Verdict: fails the requested current-price check and introduces irrelevant historical subjects.**

## Root causes supported by traces/source

1. **Subject identity is inconsistent across stages.** `report.ts` looks up snapshots using the raw model-supplied subject; digest normalization is separate. `PineDB US Launch Postgres hosting price` and `PineDB` do not share a key. Verbose subject gating also rejects useful evidence. An existing normalization helper is not end-to-end entity identity.
2. **Weekday retrieval is not constrained by a date window.** Direct `resolveWindow` evaluation of the exact “Last Tuesday” prompt returns null on November 12. The model inferred Tuesday correctly, but host retrieval still supplied broader candidates, allowing subject leakage from the older thread.
3. **Safe abstention hides extraction failures.** The model says “unverified” after the pipeline loses evidence that exists in raw fixtures. Avoiding hallucination is necessary but not enough.
4. **Temporal wording lacks precision.** Two observations justify “same recorded price at both checks,” not “unchanged throughout.”
5. **Currency syntax conflicts with math rendering.** Several dollar-delimited prose spans become math. Verify raw Markdown and renderer policy before choosing a prompt or renderer fix.

## Next changes, in order

- Unify subject identity for digest selection, snapshots, and comparison; keep region/tier qualifiers separately so canonicalization cannot merge incompatible offers.
- Add weekday date windows and a regression with two Postgres threads on adjacent Tuesdays.
- Preserve linked qualifiers and return supported current prices even when historical comparison is impossible.
- Test same-observation wording and abstention against evidence available before compression.
- Fix dollar/currency rendering and shorten absent-history clarification.
- Rerun these exact browser cases after the changes, retaining both raw answers and screenshots.

## Reproduction and artifacts

`./data/bin/node tests/challenge-browser.mjs` starts an isolated server and calls the live model; retrieval/history are synthetic. The fixture calendar targets November 12, 2026. It captures output for review and does not automatically grade semantic success. New runs disable the live observability sink; the first successful run used the default sink, so its synthetic turns may also appear in the supervised LangSmith export. Exclude those synthetic sessions from production aggregates.

Local diagnostic artifacts:

- `data/challenge-browser/public-summary.json`: exact prompts and matched timings/counts, no unrelated transcripts.
- `data/challenge-browser/seeded-results.json`: synthetic answers, search reports, links, and records.
- `data/challenge-browser/seeded-1.png`, `seeded-2.png`, `seeded-3.png`: screenshots.

No production behavior, prompt, memory algorithm, or deployment configuration was changed. The added browser diagnostic and this review are the deliverables.
