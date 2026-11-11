# Notices

This prototype composes **DeepSeek Harness** (`@deepseek-ai/dsh`, MIT). Upstream packages retain their LICENSE files; a copy of DSH's notice is in `docs/DSH-LICENSE`.

`scripts/build.mjs` changes three English UI strings in the installed DSH conversation client. The theme and brand use supported plugin APIs. The upstream server and loop are not patched.

The digest, billing parser, timezone helpers, and recorded abstract benchmark reuse code/data from the earlier Minimi implementation. The benchmark excerpts are recorded research material, not freshly fetched search results; their inclusion does not establish their accuracy or any paper's performance for this prototype.

DeepSeek Search/Fetch uses the reviewer's server-side platform key. The Minimi name and mark in `client/lib/client.js` are this prototype's branding.
