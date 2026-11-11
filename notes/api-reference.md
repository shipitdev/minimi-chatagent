# DeepSeek API — verified facts (fetched 2026-11-11)

All facts below were read directly from the official docs. Source URLs at the bottom.

## Models

| Param | Value |
| --- | --- |
| base_url (OpenAI-compatible) | `https://api.deepseek.com` |
| base_url (beta features) | `https://api.deepseek.com/beta` |
| base_url (Anthropic-compatible) | `https://api.deepseek.com/anthropic` |
| model | `deepseek-flash` → served by **DeepSeek-V4.1-Flash-1017** |
| model | `deepseek-v4-pro` |

Legacy names `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are **retired**; requests to them
are served by V4.1-Flash-1017 and billed at Flash price. So `deepseek-flash` is the correct, stable id.

Chat request extras (non-standard, via `extra_body` in the OpenAI SDK):

```json
{ "thinking": {"type": "enabled"|"disabled"}, "reasoning_effort": "high" }
```

Thinking mode supports tool use (since V3.2). We keep `thinking: disabled` for planning/deciding
steps (latency) and can enable it for the final synthesis step.

## Search API (our single tool)

```
POST https://api.deepseek.com/v1/tools/search
Authorization: Bearer <key>, Content-Type: application/json
```

| Field | Type | Req | Default | Notes |
| --- | --- | --- | --- | --- |
| `query` | string | yes | – | 1–128 unicode chars, not all whitespace, supports operators |
| `count` | int | no | 10 | 1–50. **Does not affect price.** |
| `ori_question` | string | no | – | 1–128 chars; the user's original question, improves query understanding |
| `localization` | string | no | `""` | IP used for localization |
| `need_content` | bool | no | false | when true, returns full page content in `content` |

Response item: `rerank_score` (0–3, **≥1.5 = high quality**), `title`, `url`, `snippet` (100–200 ch,
for UI), `summary` (**600–800 ch, "intended to be read by a model"** — this is the goldilocks field),
`content` (full page, only if `need_content`), `site_name`, `site_icon`, `date` (RFC3339 UTC),
`authority` (0–4, **≥3 = highly authoritative**, -1 = unknown).

Query operators supported: `site:`, `-site:`, `-term`, `-"exact phrase"`, `"exact phrase"`,
`lang:zh,en`, `after:2025-01-01`, `before:2026-06-01`. Multiple `site:` must be joined with `OR`.

## Fetch API

```
POST https://api.deepseek.com/v1/tools/fetch   { "url": "..." }
→ { "title": ..., "content": "<page as Markdown>" }
```

Design note: Search already returns a model-oriented `summary`. Fetch is a *second* round trip and
therefore a second tool in the agent's loop. **We expose only `web_search` to the model** and use
`need_content`/Fetch internally behind that single tool, keeping the tool surface at exactly one.

## Billing

| API | Unit | Price |
| --- | --- | --- |
| Search | per 1,000 **successful** requests | $0.75 |
| Fetch | per 1,000 **successful** requests | $0.75 |

Billable only on HTTP 200 with a non-empty `results` array (Search) / returned content (Fetch).
Failures, empty results and timeouts are **not** billed. `count` is free — so ask for **more results
than you need and filter client-side**; that is strictly cheaper than issuing a second search.

## Rate limits

| API | QPS (per account, all keys) |
| --- | --- |
| Search | 100 |
| Fetch | 25 (plus a per-domain limit) |

Retry on 408/429/5xx. Do **not** retry other 4xx.

## Context Caching (critical for our budget)

Enabled by default, disk-based, **best-effort**, no code changes needed.

Cache hits require a **full match of a "cache prefix unit"**, not merely a shared prefix. Prefix
units are persisted at: (1) the end of user input and the end of model output on every request,
(2) automatically detected common prefixes across requests, (3) fixed token intervals on long I/O.

Implications we designed around:
- **Never rewrite earlier messages.** Rewriting turn 3 of 10 invalidates every prefix unit from turn 3
  onward. Our compactor therefore never mutates the message log in place — it maintains a separate
  rolling summary block and drops whole turns from the *front* only.
- The system prompt is the only 100%-stable prefix, so anything stable (tool schema, output contract,
  long-lived user profile) belongs there rather than in the first user turn.
- Usage reports `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`; we log both to measure this.

## Tool calling

- `strict: true` per-function JSON-schema adherence is supported in **both** thinking and
  non-thinking mode, but requires `base_url="https://api.deepseek.com/beta"`.
- In strict mode every `object` must list **all** properties in `required` and set
  `additionalProperties: false`. Supported types: object, string, number, integer, boolean, array,
  enum, anyOf. Supports `$def`/`$ref`, `pattern`, `format` (email/hostname/ipv4/ipv6/uuid),
  `minimum`/`maximum`, `multipleOf`. **Unsupported:** `minLength`, `maxLength`, `minItems`, `maxItems`.
  → we must encode length limits in `description`/`pattern`, never in `minLength`.
- **Chat Completions cannot accept client-inserted tool calls mid-conversation.** Anthropic and
  Responses APIs can. This blocks "prefill the search result as if the model had called the tool".
  Our fix: inject tool output as a `system` message (explicitly supported mid-conversation) or use a
  plain `user`/`assistant` evidence block. We use a dedicated `system`-role "EVIDENCE" block, which is
  both supported and cache-friendly.

## Sources

- https://api-docs.deepseek.com/
- https://api-docs.deepseek.com/guides/search
- https://api-docs.deepseek.com/guides/tool_calls
- https://api-docs.deepseek.com/guides/kv_cache
