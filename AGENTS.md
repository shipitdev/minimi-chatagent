# AGENTS.md

## Assignment

Implement the Minimi prototype in this new workspace using [DESIGN.md](DESIGN.md) as the product spec. Take it from an empty workspace to a runnable browser demo with test evidence. Continue through ordinary setup and test failures, and report an exact blocker when a dependency prevents further progress.

## Build order

1. Inspect the pinned DeepSeek Harness package and its plugin examples. Prove that the root npm commands launch the intended DSH profile and web UI in a clean checkout.
2. Register Minimi's `web_search` tool and prove that a real browser turn reaches it through the DSH loop. Wire in parallel search, the compact digest, and final clickable citations.
3. Add dated SQLite recall, shortlist snapshots, and restart coverage. Verify how DSH session IDs map to Minimi records.
4. Run the conversation matrix in DESIGN.md and the relevant existing golden cases. Fix regressions and rerun the affected checks. Compare with the current app where the same live model and provider are available.

## Working rules

- Keep all implementation changes in this workspace. Use the old Minimi checkout as read-only reference. Reuse proven modules when they fit, especially search, digest, billing qualifiers, and persistence. If the old checkout is unavailable, document that and proceed from DESIGN.md.
- Use one agent loop, owned by DSH. Keep tool permissions and budgets in server code. Inspect the runtime configuration to confirm `web_search` is the only model-callable tool. Load only the plugins the local prototype needs.
- Keep secrets server-side, out of commits, logs, fixtures, and screenshots. Use the project's npm scripts and lockfile for a reproducible install. Preserve applicable upstream license notices when rebranding.
- Use a local prototype for review. Preserve the baseline and leave merging and deployment to the project owner.

## Handoff

Provide the exact run commands, tested Node and DSH versions, and the local URL. List the browser and eval cases run with actual results, including which runs used the live model. Include the runtime tool list, material upstream patches or adapter code, and any unresolved gap with a reproduction. A successful install or headless turn is a setup milestone. The deliverable is a browser conversation with working Minimi search, citations, and dated memory.

## Change record

Record meaningful changes and actual verification results in CHANGELOG.md. Keep credentials, private runtime data and conversation transcripts out of commits.
