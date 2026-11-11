/**
 * Offline backend.
 *
 * Purpose: make the whole product demonstrable and testable without an API key,
 * and let the eval harness run its mechanics in CI. It is a *scripted* backend,
 * not a simulation of model quality — every number it produces is about plumbing,
 * latency accounting and token accounting, never about answer quality.
 *
 * It is deliberately gated behind `MINIMI_OFFLINE=1` and the UI says so, so an
 * offline run can never be mistaken for a real one.
 */

import type { ChatMessage, ChatResult, SearchResponse, SearchResult } from "./deepseek.js";
import { emptyUsage } from "./config.js";

const NOW = () => new Date().toISOString();

/** A small, self-consistent corpus. Enough to exercise digests and diffs. */
const CORPUS: Array<{ keys: string[]; results: SearchResult[] }> = [
  {
    keys: ["llmlingua", "compression", "prompt"],
    results: [
      {
        title: "LLMLingua: Compressing Prompts for Accelerated Inference",
        url: "https://arxiv.org/abs/2310.05736",
        snippet: "LLMLingua compresses prompts up to 20x with a budget controller.",
        summary:
          "LLMLingua is a coarse-to-fine prompt compression method with a budget controller, a token-level iterative algorithm and instruction tuning for distribution alignment. It reports up to 20x compression with little performance loss on GSM8K, BBH, ShareGPT and Arxiv-March23. Accepted at EMNLP 2023.",
        date: "2023-12-06T00:00:00Z",
        authority: 4,
        rerankScore: 2.8,
        siteName: "arxiv.org",
      },
      {
        title: "LLMLingua-2: Data Distillation for Task-Agnostic Prompt Compression",
        url: "https://arxiv.org/abs/2403.12968",
        snippet: "LLMLingua-2 is 3x to 6x faster to compress.",
        summary:
          "LLMLingua-2 recasts prompt compression as token classification with a bidirectional encoder rather than a causal model. It is 3x to 6x faster to compress than prior methods and gives 1.6x to 2.9x end-to-end latency speedup at 2x to 5x compression ratios.",
        date: "2024-03-19T00:00:00Z",
        authority: 4,
        rerankScore: 2.7,
        siteName: "arxiv.org",
      },
      {
        title: "LongLLMLingua: Accelerating and Enhancing LLMs in Long Context",
        url: "https://arxiv.org/abs/2310.06839",
        snippet: "Question-aware contrastive perplexity improves NaturalQuestions by 21.4%.",
        summary:
          "LongLLMLingua adds question-aware contrastive perplexity, document reordering and per-document budgets. It improves NaturalQuestions by 21.4% and cuts cost by 94.0% on LooGLE at roughly 4x compression.",
        date: "2023-10-10T00:00:00Z",
        authority: 4,
        rerankScore: 2.4,
        siteName: "arxiv.org",
      },
    ],
  },
  {
    keys: ["coca-cola", "latent tokens", "tool observations"],
    results: [
      {
        title: "Tools Need Not Speak in Text: Latent Context Compression for Agents",
        url: "https://arxiv.org/abs/2611.06500",
        snippet: "Coca-Cola compresses tool observations into latent tokens.",
        summary:
          "Coca-Cola compresses tool observations into latent tokens embedded into the agent input embedding space. Action-Preserving Training aligns next-action distributions under full and compressed observations. On web-search QA it reduces token consumption by 70.01% to 89.24% and runtime by 24.45% to 55.97% while improving task performance.",
        date: "2026-11-04T00:00:00Z",
        authority: 4,
        rerankScore: 2.9,
        siteName: "arxiv.org",
      },
    ],
  },
  {
    keys: ["pricing", "price", "cursor", "windsurf", "copilot"],
    results: [
      {
        title: "AI coding agent pricing comparison",
        url: "https://example-review.invalid/ai-coding-pricing",
        snippet: "Cursor Pro is $20 per month; Windsurf Pro is $15 per month.",
        summary:
          "Cursor Pro costs $20 per month and the Business tier costs $40 per month. Windsurf Pro costs $15 per month. Both offer annual discounts of about 20 percent. Version 1.0 of Windsurf shipped in November 2024.",
        date: "2026-09-01T00:00:00Z",
        authority: 2,
        rerankScore: 2.1,
        siteName: "example-review.invalid",
      },
      {
        title: "GitHub Copilot plans and pricing",
        url: "https://example-docs.invalid/copilot-pricing",
        snippet: "Copilot Individual is $10 per month.",
        summary:
          "GitHub Copilot Individual costs $10 per month and Copilot Business costs $19 per user per month. The status of Copilot Workspace is beta.",
        date: "2026-08-15T00:00:00Z",
        authority: 3,
        rerankScore: 2.0,
        siteName: "example-docs.invalid",
      },
    ],
  },
];

const GENERIC: SearchResult[] = [
  {
    title: "Search results directory",
    url: "https://directory.invalid/list",
    snippet: "A directory of links.",
    summary:
      "A directory page with navigation links, cookie notices and unrelated promotional content. No specific answer is present.",
    date: null,
    authority: 0,
    rerankScore: 0.7,
    siteName: "directory.invalid",
  },
];

/**
 * A drifted copy of the corpus, used to prove that change detection actually
 * fires. Toggling `MINIMI_OFFLINE_DRIFT` between a baseline capture and a re-check
 * produces known, specific value changes, which is what lets the eval measure
 * change-detection precision and recall against planted ground truth instead of
 * against the model's own opinion.
 */
const DRIFT: Record<string, string> = {
  "$20 per month": "$25 per month",
  "$40 per month": "$45 per month",
  "$15 per month": "$18 per month",
  "$10 per month": "$12 per month",
  "$19 per user per month": "$22 per user per month",
};

function drifted(result: SearchResult): SearchResult {
  let summary = result.summary;
  for (const [from, to] of Object.entries(DRIFT)) summary = summary.split(from).join(to);
  return { ...result, summary, snippet: summary.slice(0, 160), date: NOW() };
}

export function driftEnabled(): boolean {
  return process.env.MINIMI_OFFLINE_DRIFT === "1";
}

export function offlineSearch(query: string): SearchResponse {
  const q = query.toLowerCase();
  const qTokens = new Set(q.split(/[^a-z0-9]+/).filter((t) => t.length > 2));
  const hits: SearchResult[] = [];
  for (const entry of CORPUS) {
    const keys = entry.keys.flatMap((k) => k.split(/[^a-z0-9]+/)).filter((k) => k.length > 2);
    if (keys.some((k) => qTokens.has(k))) hits.push(...entry.results);
  }
  const base = hits.length > 0 ? dedupe(hits) : GENERIC;
  const results = driftEnabled() ? base.map(drifted) : base;
  return {
    results,
    usage: { ...emptyUsage(), searchRequests: 1, searchAttempts: 1, searchResults: results.length },
  };
}

function dedupe(rs: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return rs.filter((r) => (seen.has(r.url) ? false : (seen.add(r.url), true)));
}

function lastUser(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") return messages[i]!.content;
  }
  return "";
}

function between(text: string, open: string, close: string): string {
  const a = text.indexOf(open);
  if (a < 0) return "";
  const start = a + open.length;
  const b = text.indexOf(close, start);
  return (b < 0 ? text.slice(start) : text.slice(start, b)).trim();
}

/** Drive the scripted replies from the prompt markers the server uses. */
export function offlineChat(messages: ChatMessage[]): ChatResult {
  const prompt = lastUser(messages);
  const usage = { ...emptyUsage(), modelCalls: 1, promptTokens: Math.ceil(prompt.length / 3.6), completionTokens: 60 };

  const respond = (content: string): ChatResult => ({
    content,
    usage: { ...usage, completionTokens: Math.ceil(content.length / 3.6) },
    finishReason: "stop",
  });

  // classify
  if (prompt.includes("Classify the user's newest message")) {
    const text = between(prompt, "<<<", ">>>").toLowerCase();
    let intent: "answer" | "recall" | "change" | "chat" = "answer";
    // A bare date is not a recall request ("what did the CEO announce yesterday"
    // is a web question). Recall needs a conversation noun or a remembering verb.
    if (/(convo|conversation|chat|thread|discussed|remind me|we talked|what did we)/.test(text)) intent = "recall";
    if (/(what changed|re-?check|updates? since|track|shortlist)/.test(text)) intent = "change";
    if (/^(hi|hey|hello|thanks)\b/.test(text.trim())) intent = "chat";
    return respond(JSON.stringify({ intent, query: text.slice(0, 90), shortlist: "" }));
  }

  // plan
  if (prompt.includes("Plan the searches for the question below")) {
    const q = between(prompt, "<<<", ">>>");
    const core = q
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 8)
      .join(" ");
    return respond(
      JSON.stringify({
        queries: [core || q.slice(0, 80)],
        checklist: ["state the central claim with a source"],
        recency: /latest|current|recent/.test(q.toLowerCase()),
      }),
    );
  }

  // shortlist construction
  if (prompt.includes("Turn their request into a shortlist")) {
    return respond(
      JSON.stringify({
        name: "AI coding agents",
        items: [
          { label: "Cursor", query: "Cursor AI coding agent pricing per month" },
          { label: "Windsurf", query: "Windsurf AI coding agent pricing per month" },
          { label: "Copilot", query: "GitHub Copilot plans pricing per month" },
        ],
      }),
    );
  }

  // memory extraction
  if (prompt.includes("Extract durable facts")) {
    const msg = between(prompt, "<<<", ">>>");
    const facts: Array<Record<string, string>> = [];
    if (/\bmy name is\b/i.test(msg)) {
      const m = /my name is ([A-Z][\w'-]+(?:\s+[A-Z][\w'-]+)?)/i.exec(msg);
      if (m) facts.push({ entity: "user", attribute: "name", value: m[1]!, kind: "name" });
    }
    if (/\bi (?:work|am working) (?:at|for)\b/i.test(msg)) {
      const m = /\bi (?:work|am working) (?:at|for) ([A-Z][\w&'-]*(?:\s+[A-Z][\w&'-]*){0,2})/i.exec(msg);
      if (m) facts.push({ entity: "user", attribute: "employer", value: m[1]!, kind: "project" });
    }
    return respond(JSON.stringify({ facts }));
  }

  // answer
  if (prompt.includes("Answer the question using only the evidence")) {
    const evidence = between(prompt, "EVIDENCE:\n<<<", ">>>");
    const question = between(prompt, "QUESTION:\n<<<", ">>>").toLowerCase();
    const qTokens = new Set(question.split(/[^a-z0-9.]+/).filter((t) => t.length > 2));

    // Pair each claim clause with the citation id of the block it sits under, then
    // answer from the clauses that overlap the question. A stub that echoed the
    // first three lines would "fail" questions whose answer is further down the
    // block for reasons that have nothing to do with the pipeline under test.
    const claims: Array<{ text: string; id: string }> = [];
    let currentId = "1";
    for (const line of evidence.split("\n")) {
      const head = /^\[(\d+)\]/.exec(line);
      if (head) {
        currentId = head[1]!;
        continue;
      }
      if (!line.startsWith("- ")) continue;
      const text = line.slice(2).trim();
      if (text.length > 12) claims.push({ text, id: currentId });
    }
    const scored = claims
      .map((c) => {
        const tokens = c.text.toLowerCase().split(/[^a-z0-9.]+/).filter((t) => t.length > 2);
        const overlap = tokens.filter((t) => qTokens.has(t)).length;
        return { ...c, overlap };
      })
      .sort((a, b) => b.overlap - a.overlap);

    const picked = scored.filter((c) => c.overlap > 0).slice(0, 3);
    const use = picked.length > 0 ? picked : scored.slice(0, 2);
    if (use.length === 0) return respond(`The evidence did not contain a usable answer. [1]`);
    const body = use
      .map((c) => `${c.text.replace(/[.;]$/, "")}. [${c.id}]`)
      .join(" ");
    return respond(body);
  }

  // recall narration
  if (prompt.includes("The user asked about earlier conversations")) {
    const count = (prompt.match(/^\d+\. "/gm) ?? []).length;
    if (count === 0) {
      return respond("Nothing was recorded in that window. The timezone used is shown above.");
    }
    return respond(`Found ${count} conversation${count === 1 ? "" : "s"} in that window; they are listed below with the timezone each was recorded in.`);
  }

  // change narration
  if (prompt.includes("These are the deterministic diffs")) {
    const updated = (prompt.match(/\[updated\]/g) ?? []).length;
    const fresh = (prompt.match(/\[new\]/g) ?? []).length;
    if (updated > 0) return respond(`${updated} item${updated === 1 ? "" : "s"} changed value since the last check; the new and old values are shown in the table.`);
    if (fresh > 0) return respond(`No previously known value changed. ${fresh} new value${fresh === 1 ? "" : "s"} were found and are recorded as a baseline.`);
    return respond("No material change since the last check.");
  }

  // chat
  return respond("I'm a research assistant with one tool, web search. Ask me something factual, or tell me to track a set of things.");
}
