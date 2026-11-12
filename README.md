# MiniChat

**A chat assistant that remembers what you asked, checks current sources, and helps you revisit earlier decisions.**

MiniChat combines dated SQLite memory with one model-callable tool, `web_search`. Independent lookups run in parallel; a deterministic evidence extractor keeps relevant passages and source links before the model answers. DeepSeek Harness owns the agent loop, sessions, and streaming.

The interesting question is a follow-up: *“On Monday we shortlisted five CRM tools. Has anything changed since?”* That requires the right historical conversation, fresh evidence about the same tools, and compatible terms before declaring a change.

[Design](DESIGN.md) · [Architecture](architecture.md) · [Decisions and experiments](decisions.md) · [Evaluation results](evals/runs/REPORT.md)

## Run locally

Requires **Node.js 24.9+** and a **DeepSeek API key** with access to the configured model and Search/Fetch services. Tested with Node 24.11.0, npm 11.6.1, and DeepSeek Harness 0.2.2-rc.1. No global DSH installation or separate database server is needed.

```sh
git clone https://github.com/shipitdev/minimi-chatagent.git
cd minimi-chatagent
npm install
cp .env.example .env
```

Set `DEEPSEEK_API_KEY` in `.env`, then start the app:

```sh
npm run dev
```

Open the local entry URL printed by the launcher. The default port is **8787**; use the printed authorization link if DSH requires one. `DEEPSEEK_MODEL` defaults to `deepseek-flash`. The key powers chat, Search, and Fetch and remains server-side. Live conversations consume provider usage; this is not an offline model demo.

All configuration placeholders are in [.env.example](.env.example). LangSmith is optional. Local application state lives in ignored `.dsh/` and `data/` directories; the default memory database is `data/minimi.db`. Stop the server with Ctrl+C.

## What to try

- Ask an ordinary question or request a draft: the agent can answer without searching.
- Research a current fact and open the citations to inspect its sources.
- Return in a new session and ask about an earlier discussion or a supported calendar date.
- Revisit a saved shortlist and ask whether its prices, features, or recommendations still hold.

Historical questions need actual prior records. An empty checkout cannot reconstruct a conversation it never stored. When the subject or comparison terms are unclear, the appropriate response is clarification or an explicit evidence gap.

## How a research turn works

1. The host selects relevant dated memory and supplies it to DSH.
2. The model calls `web_search` when fresh evidence is needed.
3. Host code runs bounded parallel Search requests and selectively fetches pages.
4. The digest extracts evidence, preserves source references, and identifies gaps.
5. Change checks compare compatible saved and current observations; the model streams a cited answer.

Default limits are **three queries per call**, **two calls per turn**, and **twelve provider attempts including retries**. The selected-evidence budget is **900 estimated tokens per batch**; report metadata is additional. These limits live in server code. See [architecture.md](architecture.md) for persistence, subject matching, citations, and comparison details.

## Tests and evaluations

| Command | What it runs | Provider calls |
| --- | --- | --- |
| `npm test` | Offline memory, date, digest, comparison, tool-boundary, gateway and client checks | None |
| `npm run bench:digest` | Recorded-corpus compression-size experiment | None |
| `npm run test:e2e` | DSH browser conversations, citations, change view and restart recall | Live model; live and fixture retrieval |
| `npm run eval:golden` | Dev split through the standalone evaluation adapter | Live model; fixture retrieval |
| `npm run eval:golden:all` | Dev, holdout and live golden splits | Live model; live retrieval on live split |
| `npm run observability` | Local turn-metric summary | None |

Browser tests require Google Chrome. Golden evaluation requires Python 3.10+; LangSmith and DeepEval setup is documented in [evals/README.md](evals/README.md). The optional eval SDK has its own dependencies:

```sh
npm ci --prefix evals
```

Saved evidence includes **25/25 offline checks**, a historical **8/8 browser suite**, and **62/64 applicable structural golden passes**. A separate 16-case semantic sample passed **10/16 workflow checks**. The golden adapter reuses product modules but runs a different model loop and routing policy; its structural score is not full website-answer accuracy. Read the [results](evals/runs/REPORT.md) and [experimental limits](decisions.md) before comparing scores.

On three recorded inputs, full tool-response size estimates fell **30.0%, 60.2%, and 68.9%**. These are character-based size estimates, not measured billing or answer-quality gains.

## Project layout

```text
plugin/src/   DSH hooks, memory, search, evidence, comparisons, telemetry
client/       DSH branding and theme
profile/      Local, headless and optional review profiles
scripts/      Build, startup, telemetry summary, optional demo gateway
tests/        Offline checks and browser diagnostics
evals/        Golden cases, adapter, DeepEval, trace exporters, saved runs
```

## Scope and known limits

This is a **single-user prototype**. Sessions in one profile share recall and subject snapshots. Keyword retrieval, incomplete weekday parsing, subject normalization, qualifier retention, and currency rendering have documented gaps. See the [challenge walkthrough review](docs/challenge-chat-review.md).

`npm run demo` is a separately provisioned laptop/Cloudflare deployment helper; it needs local tunnel credentials, TLS files, and a connector binary that are intentionally absent from the repository. The shared-profile public gateway is not a multi-tenant authorization boundary. Use normal local startup for review.

Upstream attribution is preserved in [NOTICE.md](NOTICE.md) and the [DSH license](docs/DSH-LICENSE). Publication checks and their limits are recorded in [CHANGELOG.md](CHANGELOG.md).
