# Agent-Loop Architectures for a One-Tool, Cheap-Model Search Agent

Scope: 2022–2026 literature, filtered for transfer to **one tool (web search) + a cheap small model**, across factual QA / self-history recall / open-ended research.

## 1. Techniques

| Technique | arXiv | Mechanism | Reported result (base model) | Transfers to small/cheap? |
|---|---|---|---|---|
| **ReAct** (baseline) | 2210.03629 | Thought→act→observe; every step re-reads the whole trajectory. | HotpotQA EM (PaLM-540B): Standard 28.7, CoT 29.4, CoT-SC 33.4, **ReAct 27.4**, CoT-SC→ReAct 34.2, ReAct→CoT-SC 35.1, supervised SoTA 67.5. | **No.** Largest models only; ReAct *loses to plain CoT alone*. Failures (n=50): reasoning 47% (unrecovered repetitive steps), search 23%, ambiguity 29%, hallucination 0%. |
| **ReWOO** | 2305.18323 | Planner emits the full query blueprint up-front; Worker executes; Solver answers from observations only. | gpt-3.5-turbo HotpotQA: ReAct 40.8 acc / 9795 tok / $21.29 per 1k → **ReWOO 42.4 / 1986 tok / $3.97** (≈5×). 6-benchmark avg **−64% tokens, +4.4% acc**; SOTUQA +8% acc, −43% tokens. | **Yes — strongest.** A LoRA **LLaMA-7B Planner on one RTX4090 matched the 25× larger GPT-3.5** on HotpotQA/TriviaQA/StrategyQA. Total tool failure: ReAct −40.8 acc, ReWOO −29.2. |
| **Reflexion / Self-Refine** | 2303.11366 / 2303.17651 | Self-critique loop: episodic verbal reflection, or generate→critique→rewrite. | Reflexion 91% pass@1 HumanEval (GPT-4-class, unit-test feedback); Self-Refine ~20% abs avg gain, 7 tasks (GPT-3.5/4). | **No / untested.** Reflexion needs an external signal; Self-Refine untested below GPT-3.5. |
| **Plan-and-Solve / α-UMi** | 2305.04091 / 2401.07324 | PS: zero-shot plan-then-execute. α-UMi: separate planner/caller/summarizer. | PS beats Zero-shot-CoT on all 10 datasets, matching 8-shot CoT on math (GPT-3). α-UMi (LLaMA-2-chat 7B/13B) beats single-LLM across model & data sizes. | Likely yes; α-UMi needs fine-tuning, PS does not. |
| **Self-RAG** | 2310.11511 | Trains reflection tokens (Retrieve/IsRel/IsSup/IsUse) for on-demand retrieval and self-critique. | Llama2-7B/13B, 150k pairs + GPT-4 critic labels; beats retrieval-augmented ChatGPT on 4 tasks. | **No as-is** — needs its checkpoint; behaviors copyable as prompt gates. |
| **CRAG** | 2401.15884 | T5-large (**0.77B**) doc evaluator → Correct/Incorrect/Ambiguous; latter two trigger web search; decompose-then-recompose. | LLaMA2-hf-7b PopQA: RAG 37.7 → **CRAG 39.8**. SelfRAG-LLaMA2-7b: RAG 40.3 → **CRAG 59.3**, Self-CRAG **61.8**; Biography FactScore 59.2→74.1. | **Yes.** Cheap 0.77B gate; the confidence gate transfers. |
| **Adaptive-RAG** | 2403.14403 | T5-Large classifier predicts query complexity → no-retrieval / single-step / multi-step. | FLAN-T5-XL (3B) SQuAD F1 (steps, time×): single 39.3 (1.00, 1.00); multi-step 35.6 (4.52, 9.03); **Adaptive-RAG 38.3 (1.37, 2.02)**; LLM-judged 23.1; Self-RAG* 11.2; oracle 56.3. | **Yes — but only the *trained classifier*.** LLM self-judgment is far worse. |
| **Search-R1** | 2503.09516 | RL (PPO/GRPO) with outcome reward over multi-turn search; retrieved tokens masked from loss. | Qwen2.5-**7B +41%**, **3B +20%** relative avg over RAG baselines, 7 datasets. | No for a frozen API model; shows 3B models *can* learn search use. |
| **Search-o1** | 2501.05366 | Search fired at uncertainty points; **Reason-in-Documents** compresses docs before re-injection; explicit `MAX_SEARCH_LIMIT`. | QwQ-32B: **+23.2% avg EM over standard RAG on multi-hop**; **no single-hop gain (47.8 vs 47.6)**. | Partially — doc condensation transfers, the LRM backbone doesn't. |
| **SKR** | 2310.05002 | "Do I know this?" via direct prompt / ICL / trained classifier / kNN over seen questions. | **kNN best**: +4.08%/+2.91% over Manual-CoT / CoT-IR (InstructGPT); +4.02%/+4.20% (ChatGPT). **Direct prompting performs poorly.** | **Yes**, and the negative result matters: don't ask the model to introspect. |
| **Mallen adaptive retrieval** | 2212.10511 | Per-relationship popularity threshold decides retrieval. | PopQA 46.5% (GPT-3 davinci-003), +5.3% over any non-adaptive method. | **No for <10B**: gains "much smaller… models smaller than 10 billion"; small LMs almost always retrieve. |
| **Multi-agent debate** | 2305.14325 | N instances propose → critique each other R rounds → consensus. | Arithmetic 67.0→**81.8**; GSM8K 77.0→**85.0**; Chess +91.4→+122.9. Plain majority vote only 69.0/81.0. Base model UNVERIFIED. | **No.** 2–3× cost; see next row. |
| **Compound-system scaling** | **2403.02419** | Vote/Filter-Vote performance vs #LM calls. | **Non-monotonic**: rises then falls; more calls help "easy" queries and **hurt "hard" ones** (GPT-3.5, MMLU college math). | **Yes — decisive.** Ensembling is not a safe default across mixed difficulty. |
| **MAST** | 2503.13657 | 14 failure modes, 3 categories: spec/design, inter-agent misalignment, verification & termination (κ=0.88). | ChatDev correctness as low as **25%**; role-spec + orchestration fixes give only **+14%** and don't resolve failures. | Yes, as a design checklist. |
| **HyDE / Self-Ask** | 2212.10496 / 2210.03350 | HyDE: generate a hypothetical doc, embed, retrieve by similarity. Self-Ask: explicit follow-up sub-questions. | HyDE BEIR nDCG@10 (Contriever→HyDE): Scifact 64.9→69.1, Arguana 37.9→46.6, Trec-Covid 27.3→59.3, FiQA 24.5→27.3, DBPedia 29.2→36.8, TREC-NEWS 34.8→44.0. Self-Ask beats CoT; deltas UNVERIFIED. | Yes — prompt-only, model-agnostic. |

## 2. What does NOT work on small / cheap models

1. **Intrinsic self-correction (Reflexion/Self-Refine shape).** 2310.01798: "LLMs struggle to self-correct their responses without external feedback, and at times their performance might even degrade post self-correction." Prior gains came from **oracle** labels that vanish at deployment; "multi-agent debate… efficacy is no better than self-consistency when considering an equivalent number of responses." Tested at GPT-3.5/GPT-4 class; worse on cheaper models.
2. **Model self-judged retrieval.** Mallen: gains "much smaller… models smaller than 10 billion". Adaptive-RAG: LLM-judged 23.1 F1 vs trained classifier 38.3 F1. SKR: direct prompting "relatively poor".
3. **More samples / ensembling.** 2403.02419: vote accuracy non-monotone in #calls, degrading on hard queries. Debate costs 2–3×.
4. **Multi-agent.** MAST: 25% correctness for a SOTA MAS; obvious fixes recover only +14%.
5. **Tool-call fidelity.** MemGPT: "significantly degraded performance using GPT-3.5, due to its limited function calling capabilities, and performs best using GPT-4."
6. **Learned reflection tokens.** CRAG's reproduction: Self-RAG on LLaMA2-hf-7b collapses to 29.0 PopQA vs CRAG 39.8.
7. **Big retrieved context.** LongMemEval: "Llama 3.1 8B Instruct's performance drops sharply beyond **3k** retrieved tokens; GPT-4o continues to improve even with over **20k**."
8. **Summarization instead of history.** LongMemEval: replacing sessions with "extracted summaries or facts negatively impacts QA performance due to information loss" — sole exception: multi-session reasoning.
9. **Tool breadth.** ReWOO: agents worsen as tools are added; of 20 cases where 2-tool ReWOO succeeded and 7-tool failed, **17/20 were tool misuse**.

## 3. Termination heuristics in the literature

- **Answer-signal stop** (IRCoT 2212.10509): stop when the reasoning reports an answer, else at max steps.
- **Hard search cap** (Search-o1): `MAX_SEARCH_LIMIT` injected into the prompt.
- **Named failure modes**: MAST FM-1.5 "Unaware of stopping conditions", FM-1.3 "Step repetition"; ReAct folds unrecovered repetitive steps into its 47% reasoning-error bucket.
- **Retrieval-budget stop** (LongMemEval): bound by reader capacity (~3k tokens at 8B), not steps.
- **Confidence gate** (CRAG): evaluate docs *before* generating — Correct = answer now, else re-search once.

**Meta-lesson: all of these work as harness counters, never as instructions to a cheap model.**

## 4. Query rewriting — concrete comparison

- **HyDE (2212.10496):** largest consistent single-query win on low-resource BEIR (+4.4 to +32.0 nDCG@10 over Contriever); one extra generation per search.
- **Planner-emitted multi-query (ReWOO):** −64% tokens while *raising* accuracy 4.4%, with no observation feedback.
- **Self-Ask (2210.03350):** structured follow-ups beat CoT; search plug-in easy.
- **Iterative refinement (IRCoT):** needs the expensive ReAct interleaving shape. **Doc-side refinement (Search-o1):** +23.2% avg EM on multi-hop, ~0 on single-hop.
- **Read:** rewrite cheaply (one planner call, 1–3 self-contained queries), then refine on the *document* side, not by looping the query. HyDE helps only if you control the retriever embedding; over a plain web-search API, planner-emitted queries dominate.

## 5. Memory recall ("what did I tell you earlier?")

**Verdict: retrieval over verbatim history is necessary; summarization alone is not sufficient.**

- **LongMemEval (2410.10813)** — 500 questions, five abilities incl. **abstention**. Long-context LLMs drop **30–60%** on LongMemEval S (~115k tokens); commercial assistants score **30–70%** on an easier setting. Fact-augmented key expansion and chain-of-note reading help across 7+ models; time-aware query expansion is needed for temporal questions.
- **LoCoMo (2402.17753)** — 300 turns / ~9k tokens / up to 35 sessions. RAG is "a balanced compromise," best "when dialogues are transformed into a database of assertions (observations) about each speaker's life and persona." Both still lag humans.
- **MemGPT (2310.08560)** — paginated search over the *full* history beats a recursive-summarization baseline on Deep Memory Retrieval, but degrades badly on GPT-3.5.

**Implication:** verbatim turn log, indexed as *facts + keyphrases*, retrieved at turn granularity, capped ~2–3k tokens, quoted verbatim — never replaced by summaries. Abstention is an explicit output class.

## 6. Recommended loop

```
# turns[] verbatim log; facts[] (fact+keyphrase index); MAX_SEARCHES=3; BUDGET=3000 tok
def respond(user_msg):
  # [S0] Route gate: 1 call, strict JSON enum out.                   ~250 tok
  r = llm(ROUTE, user_msg, last_k_turns)   # {"route":"recall|direct|research","query":...}
  if r.route == "direct":
      return llm(ANSWER, user_msg)                                     # ~400 tok
  if r.route == "recall":
      hits = retrieve(facts, r.query, k=5)          # no LLM cost
      return llm(ANSWER_RECALL, verbatim(hits),
                 "quote the turns; if absent say 'I don't have that'") # ~1400 tok
  # [S1] Plan once, WITHOUT observations (ReWOO).                   ~350 tok
  qs = llm(PLAN, user_msg)                # 1-3 self-contained queries, no answering
  obs = [search(q, k=3) for q in qs]      # no LLM cost; condense to BUDGET
  # [S2] Single corrective pass, then stop.
  a = llm(ANSWER, user_msg, obs, "cite ids; abstain if unsupported")  # ~1800 tok
  if llm(VERIFY, a, obs) == "unsupported" and searches_used < MAX_SEARCHES:
      q = llm(REWRITE, user_msg, a, "one better query")               # ~200 tok
      obs += search(q, k=3); a = llm(ANSWER, user_msg, obs)           # ~1800 tok
  return a
# harness stop: answer emitted | 3 searches used | 2 searches add no new entity
#               | retrieved > 3000 tok | 6 LLM calls
```

**Why.** S0 exists because self-judged retrieval is where small models fail measurably (Mallen; Adaptive-RAG 23.1 vs 38.3; SKR), so the gate must be a *narrow enum* — upgradeable to a trained T5-large-class classifier. S1 is ReWOO's insight: fix the plan before observations arrive, yielding its 5× token win and +4.4% accuracy and stopping the loop re-reading a growing trajectory. S2 is one CRAG-style corrective pass, not Reflexion iteration, because intrinsic self-correction degrades and extra samples are non-monotone. **Typical ~4.2k tokens/turn, worst ~7k** vs ~10k for naive ReAct on HotpotQA. Every stop condition is a harness counter.

**Rejected:** Reflexion/Self-Refine retries, multi-agent debate, vote/ensembling, learned reflection tokens, history summarization, and more than one tool.

## 7. Confidence flags

- **Corrected arXiv id:** 2401.02412 is *"LLM Augmented LLMs: Expanding Capabilities through Composition"* (CALM), **not** "Are More LLM Calls All You Need?" — that paper is **2403.02419**.
- UNVERIFIED: multi-agent debate's base LM; Self-Ask's exact deltas; the 2308.11432 taxonomy.

## Sources

Fetched successfully (abs + html):

- https://arxiv.org/abs/2210.03629 · https://arxiv.org/html/2210.03629v3
- https://arxiv.org/abs/2303.11366
- https://arxiv.org/abs/2303.17651
- https://arxiv.org/abs/2305.04091
- https://arxiv.org/abs/2305.18323 · https://arxiv.org/html/2305.18323v1
- https://arxiv.org/html/2310.11511v1
- https://arxiv.org/html/2401.15884v1 · https://arxiv.org/abs/2401.15884
- https://arxiv.org/html/2403.14403v2 · https://arxiv.org/abs/2403.14403
- https://arxiv.org/html/2503.09516v3 · https://arxiv.org/abs/2503.09516
- https://arxiv.org/html/2501.05366v1 · https://arxiv.org/abs/2501.05366
- https://arxiv.org/html/2310.05002v1 · https://arxiv.org/abs/2310.05002
- https://arxiv.org/html/2212.10511v3
- https://arxiv.org/html/2503.13657v1 · https://arxiv.org/abs/2503.13657
- https://arxiv.org/html/2305.14325v1
- https://arxiv.org/abs/2403.02419 · https://arxiv.org/html/2403.02419v1
- https://arxiv.org/abs/2401.02412 (CALM — id correction evidence)
- https://arxiv.org/html/2410.10813v2 · https://arxiv.org/abs/2410.10813
- https://arxiv.org/abs/2310.08560 · https://arxiv.org/html/2310.08560v2
- https://arxiv.org/html/2402.17753v1
- https://arxiv.org/html/2212.10496v1
- https://arxiv.org/html/2210.03350v1
- https://arxiv.org/html/2212.10509v1
- https://arxiv.org/html/2310.01798v1
- https://arxiv.org/html/2401.07324v1
- https://arxiv.org/html/2305.14283v1
- https://arxiv.org/html/2501.09136v4 · https://arxiv.org/abs/2501.09136
- https://arxiv.org/html/2404.13501v1 · https://arxiv.org/abs/2404.13501
- https://arxiv.org/abs/2308.11432 (exists: "A Survey on Large Language Model based Autonomous Agents")
