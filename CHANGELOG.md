# Changes

## 2026-11-12 — Reviewable commit history and README

- Split the prototype publication into runtime, regression tests, evaluation infrastructure/results, and documentation commits on top of the existing bootstrap commit.
- Set repository-local author and committer identity to `shipitdev <harshsinghrajpoot07@gmail.com>`.
- Expanded README with startup prerequisites, configuration, state location, example interactions, host budgets, test/eval commands, result scopes and deployment limits.
- Retained the original publication commit on a local backup branch; replacing the published commit uses an explicit expected-main lease.
- Documentation links and the final tree comparison are checked before publishing. No runtime behavior changed or live model evaluations rerun for this split.

## 2026-11-12 — DSH prototype and submission documentation

- Replaced the stale repository overview with the current local DSH project, preserving the existing main-branch history.
- Added the supplied DESIGN.md draft, architecture.md describing the implemented flow, and decisions.md separating experiments from unmeasured alternatives.
- Included the host/client plugins, profiles, launchers, tests, golden dataset, saved synthetic evaluation runs and upstream license notices.
- Excluded credentials, private runtime data, deployment keys, caches and local source archives. Temporary public deployment remains separately configured.
- Made evaluation commands use the current Node executable and a project-local Python environment rather than machine-specific sibling paths.

Verification on Node 24.11.0 / npm 11.6.1 / DSH 0.2.2-rc.1:

- Clean `npm ci --no-audit --no-fund`: 661 packages installed; postinstall build passed. Initial optional audit was interrupted after slow registry requests; no complete dependency-security audit is claimed.
- `npm test`: 25/25 passed with local sockets enabled. The sandbox-only run failed two gateway tests with listen EPERM before the successful rerun.
- `npm run bench:digest`: full tool-text estimates reproduced 30.0%, 60.2%, 68.9% reductions.
- Golden dataset validation: 18 dev / 40 holdout / 6 live.
- Clean local launcher reached DSH's authentication boundary (HTTP 401 without browser authorization). This is startup evidence, not a fresh browser/model conversation.
- Markdown relative links, balanced code fences and a credential-pattern scan checked before commit.

The historical 8/8 browser suite and saved LLM evaluations were not rerun for this publication. Subject matching, date parsing, semantic completeness, currency rendering and the temporary shared-profile gateway retain the limitations described in the design documents and browser review.
