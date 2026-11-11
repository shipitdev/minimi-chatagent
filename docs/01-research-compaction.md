# Context Compaction & Prompt Compression — Source-Backed Brief
**Target:** multi-turn chat agent + web-search tool, small context window, cheap tokens, DeepSeek V4.1 Flash (single cheap model, black-box API).

## 1. Taxonomy

**(a) Hard prompt compression / token pruning.** Drop tokens/lexical units by importance score. *LLMLingua* (arXiv 2310.05736) uses GPT-2-small/LLaMA-7B perplexity + budget controller + iterative token-level compression; up to **20x** compression "with little performance loss" (GSM8K, BBH, ShareGPT, Arxiv-March23). *LongLLMLingua* (2310.06839) adds question-aware **contrastive perplexity** (perplexity with vs. without the query = conditional PMI), coarse doc-level filtering via `p(question|doc)`, dynamic per-doc budget, doc **reordering**, and post-hoc subsequence recovery. *LLMLingua-2* (2403.12968) reformulates compression as **token classification** with XLM-RoBERTa-large/mBERT (small BERT-sized encoder, bidirectional), trained on GPT-4-distilled MeetingBank data. Cost: LLMLingua needs a causal LM scoring pass; LLMLingua-2 needs only an encoder pass (3x–6x faster than prior compression methods, 1.6x–2.9x end-to-end latency gain at 2x–5x ratios). Separate model: **yes**, but small CPU-runnable.

**(b) Soft prompt / gist tokens.** *Gist tokens* (2304.08467) trains the LM to compress a prompt into cached gist tokens with modified attention masks: **26x** compression, "minimal loss in output quality," 40% FLOPs reduction, only 4.2% wall-time speedup. *AutoCompressor* (2305.14788) fine-tunes OPT/Llama-2 up to 30,720 tokens into summary vectors that beat plain-text demos on ICL. *xRAG* (2405.13792) reuses retriever embeddings as a modality bridge, **1 token per document**, +10% over six knowledge-intensive tasks and 3.53x FLOP reduction — only the bridge is trainable. All require **white-box model access / fine-tuning**. Disqualified for a hosted API agent.

**(c) LLM-summarization compaction.** Summarize history, reinitialize context (Anthropic "compaction"). Cost: one extra LLM call that is *blocking* and *lossy*. Needs no separate model — the same cheap model does it — but quality is fragile (§3).

**(d) External memory + retrieval.** MemGPT (2310.08560) virtualizes context into paged memory tiers with interrupts; LongMemEval (2410.10813, ICLR 2025) shows commercial assistants/long-context LLMs suffer a **30% accuracy drop** on sustained-interaction memory, and that session decomposition + fact-augmented keys + time-aware query expansion fix much of it. Cost: infra, not tokens. Note the inversion for our case: retrieval *is* the agent's tool, so this is already partly present.

**(e) Structured extraction.** Replace raw tool output with typed records (title/URL/date/claim/snippet). Dense X Retrieval (2312.06648) shows indexing/prompting at **proposition** granularity beats passage granularity in both retrieval and downstream QA at a fixed compute budget. Cheapest per token, no model needed, but lossy by construction.

**KV-cache compression** (H2O, SnapKV, KVzip-class) is orthogonal and requires white-box access to the served model — not usable on a hosted API. The prompt-compression survey (2410.12388) splits the field into hard vs. soft prompt methods and explicitly lists optimizing the compression encoder and combining hard+soft as open directions.

## 2. Numbers that matter (compression ratio vs. retention)

| Method | Ratio | Retention / delta | Data + model | arXiv |
|---|---|---|---|---|
| LLMLingua | up to 20x | "little performance loss" | GSM8K, BBH, ShareGPT, Arxiv-March23; GPT-3.5-Turbo | 2310.05736 |
| LLMLingua-2 | 2x–5x | 3x–6x faster compression, 1.6x–2.9x e2e latency gain; beats baselines in-domain and OOD | MeetingBank, LongBench, ZeroSCROLLS, GSM8K, BBH; GPT-3.5-Turbo + Mistral-7B | 2403.12968 |
| LongLLMLingua | ~4x | **+21.4%** (NaturalQuestions), **94.0%** cost cut (LooGLE), 1.4x–2.6x latency gain on ~10k prompts | GPT-3.5-Turbo | 2310.06839 |
| Gist tokens | 26x | minimal quality loss; −40% FLOPs, +4.2% wall time | LLaMA-7B, FLAN-T5-XXL (fine-tuned) | 2304.08467 |
| xRAG | 1 token/doc | +10% avg over 6 tasks; 3.53x FLOPs reduction | 7B dense and 8x7B MoE | 2405.13792 |
| CORE-RAG | **3%** | +3.3 EM points vs. **full** documents | RAG QA | 2508.19282 |
| CompAct-Bench | 10% | **56.7%** avg, **68.5%** best post-compaction accuracy over 12 frontier compactors, from a 100% pre-compaction pass3 baseline | 200 tasks: BrowseComp, SWE-bench, CompanyBench; executor Claude Opus 4.8 / GPT-5.5 Codex | CompAct-Bench (2026) |
| Parallel Compaction | — | summary output grows only **~3x** when input grows **48x** (2k→96k); sync compaction = **up to 62.4%** of E2E wall time at τ=16k (gpt-oss-20B 51.3%); retained fraction falls **48% → ~3%** | Llama-3.1-8B/3.3-70B, gpt-oss-20B/120B; HotpotQA, LoCoMo | 2605.23296 |
| CompactionRL (Tsinghua/Z.AI) | — | summary *agent* choice alone moves SWE-bench Verified **49.0 → 55.5** (+6.5 pts) with the executor fixed; RL-trained compaction +6.6/+4.9 pts over inference-time compaction (GLM-4.5-Air) | SWE-bench Verified, Terminal-Bench 2.0 | 2607.05378 |
| CompactionBench (MSR) | — | 13.5M Copilot sessions / 760M calls: **7.8%** of sessions compact, but they are **44.2%** of token consumption; async progressive compaction (APEC) −25.4% cost, −9.6% time | GitHub Copilot production telemetry | MSR 2026 |

## 3. What the evidence says about position

Lost in the Middle (2307.03172): performance follows a **U-curve** — best when the answer is first or last, worst in the middle; GPT-3.5-Turbo's mid-context multi-doc QA score falls **below its closed-book 56.1%**; extended-context models are no better inside their original window; reader accuracy saturates long before retriever recall (50 vs. 20 docs ≈ +1.5%). LongLLMLingua's reordering contribution is built directly on this and reports the highest recall of any retention metric tested.

Two further position results are decisive for us:

- **CompAct-Bench, by domain:** Search (BrowseComp) **degrades** as the boundary moves later (52.9% → 34.6%), while Coding **improves** (64.0% → 86.1%). The stated cause: in coding a repository is a *second tape* on disk; in search **the conversation is the only tape**. With no history the search continuation collapses to **7.4%** at the late boundary, while a compacted artifact buys back **+26–27 pts**.
- **Parallel Compaction** explains why: compaction is prompt- *and* input-invariant, so longer history is retained at *lower* fraction — 48% at 2k input vs. **~3% at 96k**. Same snapshot, same prompt produces different summaries every run (coefficient of variation up to **42.9%**, pairwise summary cosine similarity down to **0.624** at 96k).

**Implication for search results:** never bury them. Keep the top-ranked result and the newest results at the edges; compress the middle into a stable prefix. Also: adding more retrieved docs is nearly worthless past ~20 (2307.03172) — rank-truncate *before* you compress.

## 4. Small-LM compression vs. LLM summarization — recommendation

**Recommendation: structured extraction + extractive compression as the default; LLM-summarization only for turn history, off the critical path; no second model in the loop.**

Reasoning:

1. **LLMLingua-2 is technically practical** — XLM-RoBERTa-large is ~560M params, CPU-runnable, 3x–6x faster than causal-LM compressors, and is task-agnostic, so one cached compression of a document serves all later queries. But it is trained/distilled against GPT-4-style targets and is **extractive and query-independent**: it cannot know which of 10 search snippets matters for *this* question. LongLLMLingua shows query-aware scoring is worth up to +21.4% — you want that, and you can approximate it far more cheaply with the query itself (§5) than with a perplexity pass.
2. **A second model adds a failure mode and a dependency for a modest gain.** With LLMLingua-2 you get ~2x–5x with quality retention but pay an extra artifact to ship, version, and monitor. Ranking+truncation+extraction is deterministic, debuggable, and free.
3. **Summarization is the weakest option for tool output specifically.** CompAct-Bench attributes failures to *omission* (repeated work +18.2 pts, progress loss +13.8 pts, budget exhaustion) and *distortion* (**56.7%** of early failures show premature commitment vs. 46.0% of budget-exhausted ones; constraint/goal distortion +10.5 pts). Summarizing search evidence converts tentative evidence into "conclusions." Keep tool output extractive; reserve abstractive summarization for chat turns, where the goal is continuity rather than facts.
4. **The single highest-leverage finding:** summary quality, not quantity, decides the outcome (49.0 → 55.5 from the summarizer alone; +25.4% cost / −9.6% time from doing compaction *asynchronously*). So optimize **when** you compact and **what you keep verbatim**, not **how hard** you squeeze.

## 5. Recommended policy (~150 lines Python)

**Budgets.** `WINDOW` = model context (tokens). `BUDGET = 0.70 * WINDOW` (30% headroom for the reply + rare long tool payloads). `T_SOFT = 0.55 * BUDGET` (start trimming), `T_HARD = 0.85 * BUDGET` (force compaction), `T_RESUME = 0.15 * BUDGET` (stop compacting; always keep ≥15% live).

**Per-tool-result pipeline (applied on ingest, in this order).**
1. **Rank-truncate** to top `K=8` results (never scale K with context length; 2307.03172 shows saturation past ~20 and U-curve loss before that).
2. **Extract** each result to `{title, url, domain, date, snippet}`; snippet = the 1–2 sentences with highest query-term overlap, capped at `160` tokens.
3. **Deduplicate** on normalized URL and on snippet 8-gram overlap; drop near-duplicates, keep the higher-ranked.
4. **Evict** results whose score is <0.35 × top score when ≥3 results remain.

**Placement (the U-curve rule).** Assemble as: `[system] [compacted history] [top-1 result] [results 2..n-1, compressed hardest] [results n-1..n by recency] [current user turn]`. Query goes **both** before and after the evidence block — query-aware contextualization makes key-value-style retrieval near-perfect (2307.03172 §4.2) and matches LongLLMLingua's contrastive-perplexity finding.

**Keep verbatim (never summarize).** System prompt and tool schemas; the last `2` user turns; the last `2` tool-call/result pairs *in full* (this is CompactionRL's `k=2` resume convention and is also `APEC`'s reason for appending to a stable prefix); all URLs, titles, dates, numbers, proper nouns, and error strings — pruning entities is what breaks downstream generation (2307.03172's role for subsequence recovery).

**Summarize.** Only turns older than the verbatim window, in **chunks of ≤512 tokens** (LLMLingua-2's chunk-wise finding: whole-context summarization silently over-compresses). Compaction prompt must be closed-set: *goal, decisions made, verified facts (with URL), open questions, unresolved errors, next step.*

**Evict.** Raw tool payloads older than the verbatim window **once their extraction is in the fact log**; repeated tool calls to identical normalized args; boilerplate/cookie/nav text; results superseded by a later higher-ranked result on the same domain.

**Trigger & mechanics.**
- On every turn: if `tokens() > T_SOFT`, run steps 1–4 over all past tool results, **most recent last** (never re-compress the newest).
- At `T_HARD`: compact history summarization. Do it **asynchronously** — the MSR result says synchronous compaction both stalls inference tens of seconds and destroys prefix-cache reuse; prepare the summary in the background, append it to a **stable prefix**, and swap it in only after the next turn (APEC: −25.4% cost, −9.6% time; Parallel Compaction: sync compaction is up to 62% of wall time at short thresholds).
- **Determinism:** pin temperature to 0 and cache the summary keyed by a hash of the history chunk. Non-zero-variance summaries (CV up to 42.9%) make agent behaviour irreproducible across identical sessions.
- **Prefer low thresholds' opposite:** use a *high* threshold and *frequent cheap* evictions. Compaction frequency is the cost driver, so make the cheap layers do the work and the expensive layer rare.
- **Instrument:** log `retained_ratio = tokens_after / tokens_before` per layer and assert it stays above ~10%. CompAct-Bench's 10%-retention regime already loses ~43 pts absolute; going below that is measurably worse.

**Structured fact log (the external-memory layer).** Persist one row per verified claim: `{claim, source_url, date, confidence: verified|tentative}`. Inject only rows matching the current query, capped at ~200 tokens, at the **end** of the evidence block. This is LongMemEval's session-decomposition + fact-augmented-key recipe, and it is what keeps compaction *lossy-but-recoverable* rather than lossy-and-terminal.

## Caveats / UNVERIFIED

- LLMLingua's "20x with little performance loss" and Gist tokens' "minimal loss in output quality" are the authors' own summary claims; I fetched abstracts, not the per-dataset result tables, so exact per-task deltas at 20x and 26x are **UNVERIFIED**.
- No published study I found evaluates any of these compressors **on DeepSeek V4.1 Flash specifically**. All retention numbers are from GPT-3.5-Turbo, Mistral-7B, Llama, GLM, or Claude executors. Transfer to a smaller/cheaper model should be assumed *worse*, not equal.
- CompAct-Bench and Parallel Compaction are 2026 preprints (CompAct-Bench submitted to ICLR 2027; Parallel Compaction ICC-style preprint). CompactionBench is an MSR Nov 2026 preprint. Not peer-reviewed as of writing. CompactionRL (2607.05378) is Tsinghua/Z.AI and its compaction gains are RL-training results — **not transferable** to an inference-only hosted-API agent.
- The CompAct-Bench paper PDF itself 404'd on content-type ("unsupported content type application/pdf"); all its numbers above come from the project page, which states them explicitly.
- OpenReview `forum?id=wWuf7GAd1t` returned a browser-verification challenge — no content retrieved.

## Sources

- https://arxiv.org/abs/2310.05736
- https://arxiv.org/abs/2310.06839
- https://arxiv.org/html/2310.06839v2
- https://arxiv.org/abs/2403.12968
- https://arxiv.org/html/2403.12968v2
- https://arxiv.org/abs/2410.12388
- https://arxiv.org/abs/2310.08560
- https://arxiv.org/abs/2410.10813
- https://arxiv.org/abs/2304.08467
- https://arxiv.org/abs/2305.14788
- https://arxiv.org/abs/2305.13304
- https://arxiv.org/abs/2405.13792
- https://arxiv.org/abs/2508.19282
- https://arxiv.org/abs/2312.06648
- https://arxiv.org/abs/2307.03172
- https://arxiv.org/html/2307.03172v3
- https://arxiv.org/html/2605.23296v1
- https://arxiv.org/html/2607.05378
- https://compaction-eval.github.io/CompAct-Bench/
- https://www.microsoft.com/en-us/research/publication/benchmarking-long-horizon-agent-context-compaction-with-compactionbench/
- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents (redirects to /research/effective-context-engineering-for-ai-agents)
- https://html.duckduckgo.com/html/?q=LLMLingua+2025+Tsinghua+prompt+compression
- https://html.duckduckgo.com/html/?q=context+compression+tool+using+agents+2025+arxiv+benchmark+compaction
- https://html.duckduckgo.com/html/?q=arxiv+2025+LLMLingua+follow-up+Tsinghua+%22prompt+compression%22+long+context+agent
