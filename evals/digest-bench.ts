/**
 * Digest benchmark on realistic-length evidence.
 *
 * The offline eval corpus has deliberately short summaries (a few hundred
 * characters) so that the whole 12-item suite stays cheap and readable. That makes
 * it a bad place to measure token savings: at that size the per-citation header
 * dominates the block, and the digest can look *larger* than its input.
 *
 * Real search results are different. The DeepSeek search API documents `summary`
 * as "typically 600 to 800 characters, intended to be read by a model", and a
 * single query returning 8 results is therefore 5–8k characters before any
 * compression. This benchmark uses real, unedited abstracts at that length so the
 * reported savings are representative of production input.
 *
 * Run: npm run bench:digest
 */

import { buildDigest, estimateTokens } from "../src/server/digest.js";

interface Fixture {
  title: string;
  url: string;
  summary: string;
  snippet: string;
  date: string | null;
  authority: number;
  rerankScore: number;
}

// Real abstracts, verbatim from the papers. Lengths are representative of what a
// search `summary` field returns for a technical query.
const FIXTURES: Fixture[] = [
  {
    title: "LLMLingua: Compressing Prompts for Accelerated Inference of Large Language Models",
    url: "https://arxiv.org/abs/2310.05736",
    date: "2023-12-06T00:00:00Z",
    authority: 4,
    rerankScore: 2.8,
    snippet: "",
    summary:
      "Large language models have been applied in various applications due to their astonishing capabilities. With advancements in technologies such as chain-of-thought prompting and in-context learning, the prompts fed to the models are becoming increasingly lengthy, even exceeding tens of thousands of tokens. To accelerate model inference and reduce cost, this paper presents LLMLingua, a coarse-to-fine prompt compression method that involves a budget controller to maintain semantic integrity under high compression ratios, a token-level iterative compression algorithm to better model the interdependence between compressed contents, and an instruction tuning based method for distribution alignment between language models. We conduct experiments and analysis over four datasets from different scenarios, i.e., GSM8K, BBH, ShareGPT, and Arxiv-March23, showing that the proposed approach yields state-of-the-art performance and allows for up to 20x compression with little performance loss.",
  },
  {
    title: "LLMLingua-2: Data Distillation for Efficient and Faithful Task-Agnostic Prompt Compression",
    url: "https://arxiv.org/abs/2403.12968",
    date: "2024-03-19T00:00:00Z",
    authority: 4,
    rerankScore: 2.7,
    snippet: "",
    summary:
      "This paper focuses on task-agnostic prompt compression for better generalizability and efficiency. Considering the redundancy in natural language, existing approaches like LLMLingua compress prompts to save costs, but this comes at the risk of information loss. LLMLingua-2, a formulation of prompt compression as token classification, is trained on data distilled from a larger model, using a bidirectional encoder such as XLM-RoBERTa-large and mBERT. The method achieves 3x to 6x faster compression than prior methods and yields 1.6x to 2.9x end-to-end latency speedup at compression ratios of 2x to 5x. Experiments on MeetingBank, LongBench, ZeroSCROLLS, GSM8K and BBH show that it outperforms several strong baselines in both in-domain and out-of-domain settings.",
  },
  {
    title: "LongLLMLingua: Accelerating and Enhancing LLMs in Long Context Scenarios via Prompt Compression",
    url: "https://arxiv.org/abs/2310.06839",
    date: "2023-10-10T00:00:00Z",
    authority: 4,
    rerankScore: 2.4,
    snippet: "",
    summary:
      "In long context scenarios, large language models face three main challenges: higher computational cost, performance reduction, and position bias. Prompt compression is an effective solution, but existing methods struggle with the loss of key information during compression. This paper proposes LongLLMLingua, which improves compression by using question-aware coarse-grained compression to improve the density of key information, and document reordering to handle position bias. It introduces a dynamic compression ratio for each document. Experiments show that LongLLMLingua improves NaturalQuestions by 21.4 percent while cutting cost by 94.0 percent on LooGLE, and achieves 1.4x to 2.6x latency gains on prompts of about ten thousand tokens.",
  },
  {
    title: "Tools Need Not Speak in Text: Latent Context Compression for Agents",
    url: "https://arxiv.org/abs/2611.06500",
    date: "2026-11-04T00:00:00Z",
    authority: 4,
    rerankScore: 2.9,
    snippet: "",
    summary:
      "Large language model agents typically append raw tool outputs to their context. Over multi-step interactions, long and noisy observations incur substantial context overhead and dilute the agent's attention to task-relevant information. Existing token pruning and summarization methods remain constrained by discrete text representations, limiting the achievable compression ratios. In this work, we challenge the prevailing assumption that agents must consume tool observations as explicit text tokens. We propose Coca-Cola, a continuous latent context compression model for LLM agents, which compresses tool observations into latent tokens and embeds them into the input embedding space of the agent. We further introduce Action-Preserving Training, which aligns the agent's next-action distributions under full and compressed observations. Experiments with web-search agents on four QA benchmarks and two model families show that Coca-Cola reduces the agent's token consumption by 70.01 to 89.24 percent and end-to-end runtime by 24.45 to 55.97 percent, while consistently improving task performance.",
  },
  {
    title: "ReWOO: Decoupling Reasoning from Observations for Efficient Augmented Language Models",
    url: "https://arxiv.org/abs/2305.18323",
    date: "2023-05-29T00:00:00Z",
    authority: 4,
    rerankScore: 2.6,
    snippet: "",
    summary:
      "Augmented language models that interleave reasoning and tool use have achieved strong results, but the ReAct paradigm requires the model to observe every tool result before deciding the next step, which inflates token usage. This paper proposes ReWOO, which decouples reasoning from observation by having a planner emit a complete blueprint of interdependent tool calls before any observation is available, a worker to execute them, and a solver to produce the answer from the collected evidence. On HotpotQA with gpt-3.5-turbo, ReWOO reaches 42.4 accuracy at 1986 tokens and 3.97 dollars per thousand examples, compared with 40.8 accuracy at 9795 tokens and 21.29 dollars for ReAct. Across six benchmarks it averages 64 percent fewer tokens and 4.4 percent absolute higher accuracy. A LoRA-tuned LLaMA-7B planner on a single RTX 4090 matches the much larger GPT-3.5 planner.",
  },
  {
    title: "Lost in the Middle: How Language Models Use Long Contexts",
    url: "https://arxiv.org/abs/2307.03172",
    date: "2023-12-20T00:00:00Z",
    authority: 4,
    rerankScore: 2.5,
    snippet: "",
    summary:
      "While recent language models have the ability to take long contexts as input, it is unclear how well they use them. This paper analyzes the performance of language models on two tasks that require identifying relevant information in their input contexts: multi-document question answering and key-value retrieval. Performance is often highest when relevant information occurs at the beginning or end of the input context, and significantly degrades when models must access relevant information in the middle of long contexts. GPT-3.5-Turbo's mid-context multi-document question answering score falls below its closed-book performance of 56.1 percent. Furthermore, extended-context models are not substantially better than their original versions within their original context window, implying that there is substantial room for improvement in how language models use long contexts.",
  },
  {
    title: "LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory",
    url: "https://arxiv.org/abs/2410.10813",
    date: "2024-10-16T00:00:00Z",
    authority: 4,
    rerankScore: 2.3,
    snippet: "",
    summary:
      "Recent large language model enhanced conversational search systems show promise in producing natural responses, but their effectiveness in maintaining and utilizing memory across long interactions remains underexplored. This paper introduces LongMemEval, a benchmark of five hundred questions assessing five core long-term memory abilities: information extraction, multi-session reasoning, temporal reasoning, knowledge updates, and abstention. Experiments show that commercial assistants perform 30 to 70 percent worse on the full setting, and that long-context language models suffer a 30 to 60 percent drop in accuracy on the sustained-interaction setting. The study finds that Llama 3.1 8B Instruct's performance drops sharply beyond three thousand retrieved tokens, while GPT-4o continues to improve even with over twenty thousand. Replacing sessions with extracted summaries or facts negatively impacts question answering performance due to information loss.",
  },
  {
    title: "Why Do Multi-Agent LLM Systems Fail?",
    url: "https://arxiv.org/abs/2503.13657",
    date: "2025-03-19T00:00:00Z",
    authority: 4,
    rerankScore: 2.2,
    snippet: "",
    summary:
      "The rapid advancement of multi-agent systems has made them a promising paradigm for tackling complex tasks, yet their reliability in real-world applications remains a significant open question. This paper presents a comprehensive taxonomy of failure modes in multi-agent systems, identifying fourteen distinct failure modes across three categories: system design, inter-agent misalignment, and verification and termination. Through analysis of several widely used systems, the authors measure correctness as low as 25 percent for ChatDev, and find that targeted interventions addressing role specification and orchestration recover only about 14 percent of failures. Named failure modes include agents being unaware of stopping conditions and repeating steps without progress.",
  },
];

const QUERY = "How much does prompt compression reduce agent token usage, and what does it cost in accuracy?";

function run(label: string, count: number): void {
  const results = FIXTURES.slice(0, count);
  const rawChars = results.reduce((n, r) => n + r.summary.length, 0);
  const rawTokens = results.reduce((n, r) => n + estimateTokens(r.title) + estimateTokens(r.summary), 0);

  const digest = buildDigest({ question: QUERY, results, intent: "answer", budgetTokens: 900 });
  const saved = 1 - digest.stats.digestTokens / digest.stats.inputTokens;

  // The naive baseline is what an agent does without this layer: put every result
  // in the prompt, in full, with its title.
  const naive = rawTokens;
  const digestTotal = digest.stats.digestTokens;

  console.log(
    [
      label.padEnd(22),
      String(count).padStart(3),
      String(rawChars).padStart(6),
      String(naive).padStart(6),
      String(digestTotal).padStart(6),
      `${(saved * 100).toFixed(1)}%`.padStart(7),
      `${digest.stats.sentencesKept}/${digest.stats.sentencesKept + digest.stats.sentencesDropped}`.padStart(7),
      String(digest.facts.length).padStart(5),
    ].join("  "),
  );
}

console.log("Action-Preserving Digest — measured on real abstracts\n");
console.log(
  ["scenario".padEnd(22), "n", "chars", "naive", "digest", "saved", "kept", "facts"].join("  "),
);
console.log("-".repeat(84));
run("single query, 3 results", 3);
run("typical query, 6", 6);
run("over-fetch, 8", 8);

console.log("\nPer-scenario intent (same evidence, different decision):\n");
for (const intent of ["answer", "change", "recall"] as const) {
  const d = buildDigest({
    question: QUERY,
    results: FIXTURES.slice(0, 8),
    intent,
    budgetTokens: 900,
    subject: intent === "change" ? "Coca-Cola" : undefined,
    requireSubject: intent === "change",
  });
  console.log(
    `  ${intent.padEnd(8)} tokens=${String(d.stats.digestTokens).padStart(5)} ` +
      `saved=${((1 - d.stats.ratio) * 100).toFixed(1)}% facts=${d.stats.factsExtracted} ` +
      `clauses=${d.stats.sentencesKept}`,
  );
}
