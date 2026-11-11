# Minimi golden eval v2

## Why these cases

Minimi describes its Mac product as an assistant that notices commitments and follows the user's open tasks. Its memory page calls the memory feature **Cotton** and the commitment feature **Melody**. The hiring listing separately asks for a fast, accurate single-tool web-search chat agent that can remember what you asked and when. The linked challenge brief demonstrates dated recall and checking whether old recommendations still hold. The eval therefore stresses both halves of that experience: recovering exactly what the user said, then checking the current world where needed. The chat agent uses conversation data supplied in each fixture. No Mac screen capture, notification delivery, or third-party app access is needed. [Product](https://www.projectminimi.com/) · [Memory](https://www.projectminimi.com/memory) · [Hiring listing](https://binary.so/YIrD8L5) · [Challenge brief](https://app.notion.com/p/minimi-hiring-challenge-build-a-chat-agent-4100a8b933b181b98277d8ea5a534d6f)

Minimi also describes local memory storage and Gemini API-based embeddings. Its 54% vs. 36% comparison is a company-reported benchmark result, corresponding to an 18 percentage-point difference. Treat it as a live source-reading question. [Official memory page](https://www.projectminimi.com/memory) · [Team and mascot story](https://www.projectminimi.com/about)

| Set | Cases | Use |
| --- | ---: | --- |
| Dev | 18 | Fix routing, date resolution, evidence selection, and abstention. |
| Holdout | 40 | Run after freezing the design. Includes five CRM checks, restart and timezone cases, changed commitments, conflicting sources, and a timeout. |
| Live | 6 | Verify official Minimi facts against real search and measure production-like latency. Revalidate source expectations if a page or job listing changes. |

## How the hiring signals shaped the tests

| Public signal | What we infer the engineers may value | How we test it |
| --- | --- | --- |
| Fast, accurate search that remembers what you asked and when | Correct behavior when recall and current search are needed in the same turn | Similar old threads, local-date boundaries, restart, and per-item checks of a dated shortlist |
| The product helps users follow through on commitments | Remembering who owns the work and which items are still open | Completed tasks, withdrawn requests, changed deadlines, and another person's promise |
| Nudges should arrive at the right moment | Restraint and clear recovery when the intent or evidence is unclear | Clarify ambiguous references, avoid needless search, and return partial results after a vendor timeout |
| They care about system design | Evidence the implementation behaves consistently | Fixed-clock replay, auditable citations, and paired wording comparisons |

These are interpretations of public product and hiring materials. We do not have Minimi's private evaluation criteria. [Hiring listing](https://binary.so/YIrD8L5) · [Product](https://www.projectminimi.com/)

V2 preserves all 32 original cases and adds **16 scenarios with two prompts each**. Each pair shares the same history, evidence, and rubric. One prompt is polished and explicit, like a typical generated test question. The other uses shorthand, informal phrasing, or references that depend on context. Both styles were authored for this eval. They are not samples of actual reviewer behavior. The grader reports **both pass, polished only, chat only, and both fail** for fully reviewed pairs. Report pair counts alongside case counts since the two prompts in a pair share evidence.

Replay history, vendors, and web excerpts are synthetic. The gold criteria in `cases.json` are for grading and should stay out of model prompts. Keep the holdout private and avoid tuning against individual holdout cases. Replay uses a fixed clock and explicit timezone. The runner sends no reference answers to the adapter. The live cases use the current clock. Live sources were reviewed on November 11, 2026. These are our cases inspired by the public brief.

## Run it

Requires Python 3.10+ and a timezone database. The runner uses only the standard library. Validate from the extracted folder.

```sh
python3 run.py validate
python3 run.py run --split dev --adapter 'node /path/to/minimi-eval-adapter.mjs' --out baseline-dev.json
python3 run.py run --split holdout --adapter 'node /path/to/minimi-eval-adapter.mjs' --out final-holdout.json
python3 run.py run --split live --adapter 'node /path/to/minimi-eval-adapter.mjs' --out final-live.json
```

The adapter is the integration point for the chatbot's turn handler. Run each case in a fresh namespace. Import the provided exchanges with their original IDs, thread IDs, timestamps, and source evidence through your test seam. Preserve the chosen timezone and frozen clock for replay. If `restart_before_prompt` is true, close and reopen the agent or its storage before the final turn. Capture telemetry for the final turn only.

The runner starts the adapter command once per case and writes a JSON request to its stdin. For replay, connect `search_fixtures` only to the test implementation of `web_search`. Return matching excerpts in fixture order for a query. Return a specified timeout as a provider error for that lookup. In h23, LakeDesk succeeds and DockDesk times out, so use separate provider lookups or expose partial per-entity outcomes. Use the same query-matching behavior across all candidate architectures. The `query_hits` helper in `run.py` illustrates the matching rule. For live, use the actual provider. The model gets normal chat and tool results through the application's own pipeline.

Emit one JSON object on stdout. Write diagnostic logs to stderr. Normalize internal route names at the adapter boundary.

```json
{
  "answer": "The answer the user sees",
  "route": "historical_update",
  "selected_turn_ids": ["history-id"],
  "search_queries": ["vendor Team pricing"],
  "citations": [{"id": "evidence-id", "url": "https://vendor.example/pricing"}],
  "agent_ms": 900,
  "first_answer_text_ms": 700,
  "input_tokens": 1000,
  "output_tokens": 160,
  "search_evidence_tokens": 360,
  "model_calls": 2
}
```

Allowed routes are `direct`, `recall`, `research`, `historical_update`, and `clarify`. Supply citations actually rendered to the user, mapped back to fixture IDs on replay. Supply the search query trace and selected turn IDs as observed, even if empty. Use `null` or omit unavailable telemetry. The runner records subprocess wall time separately from agent latency. First-answer text excludes status messages. Input and output token totals should cover every model call for the final turn. Search-evidence tokens are the subset attributable to retrieved evidence actually sent to the model. Measure the same quantities for each version.

## Grade it

Each run creates a review template next to the output. Match each review entry to the criteria for its case ID in `cases.json`. Mark whether each criterion was met, whether the answer's actual citation supports it, and whether any forbidden claim appeared. For a criterion that requires both old and new evidence, inspect both. A right answer without supporting evidence fails the citation check. Record live source changes separately before comparing versions. Review answers blind to the system version where practical.

```sh
python3 run.py grade --run final-holdout.json --review final-holdout.json.review.json
```

The automatic report shows route, correct history selection, search behavior, entity coverage, expected source presence and telemetry, with the measured denominator. Expected source presence checks identifiers or URLs. Semantic claim support comes from the review. An adapter error remains in the attempted-case denominator. Report both whole-case pass rate and claim-level evidence support, plus p50/p95 latency, model calls and token use. With this sample size, read p95 as a tail observation and keep the case counts alongside it.

Compare the same held-out cases and report paired wins and losses. For the Coca-Cola-inspired experiment, keep the model, search provider, and retrieved evidence fixed and switch only how much of that evidence is sent into the model. Track whether the shorter excerpts preserve each supported change and qualifier, as well as search-evidence tokens and response latency. [Coca-Cola paper](https://arxiv.org/abs/2611.06500)

## Files

- `cases.json` is the machine-readable golden set, including per-case rubrics and replay fixtures.
- `run.py` validates the dataset, invokes the adapter, reports telemetry, and scores completed reviews.
- `build_fixtures.py` defines the original cases. Run `python3 enrich.py` to regenerate the full v2 dataset.
