/**
 * Golden-eval adapter.
 *
 * The golden runner starts this process once per case, writes one JSON object to
 * stdin and reads one JSON object from stdout. So this file is a thin boundary: it
 * translates the runner's protocol into the product's real entry point (`Agent`),
 * and translates the result back. No answer logic lives here.
 *
 * Protocol obligations this file honours:
 *
 *  - **Fresh namespace per case.** The runner starts a process per case; each gets
 *    its own SQLite file in a temp dir, so nothing leaks between cases.
 *  - **Original ids and timestamps.** Imported turns keep their `id`, `thread_id`
 *    and timestamp so `selected_turn_ids` can be reported as observed.
 *  - **Frozen clock.** Replay cases carry `now`; the agent is given that instant, so
 *    "yesterday" means the case's yesterday, not today.
 *  - **Restart.** When `restart_before_prompt` is set, the store is closed and
 *    reopened before the final turn, proving memory is durable rather than resident.
 *  - **Replay search.** `search_fixtures` are bound to the agent's search seam using
 *    the runner's own alias-matching rule, and a fixture carrying `error` is raised
 *    as a provider failure.
 *  - **Route normalisation.** Internal intents are mapped to the runner's allowed
 *    route names at this boundary.
 *
 * Run: node --import tsx evals/adapter.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store, type EvidenceDoc, type ImportedTurn } from "../src/server/memory.js";
import { Agent, type Intent } from "../src/server/agent.js";
import type { SearchResponse, SearchResult } from "../src/server/deepseek.js";

interface FixtureDoc {
  id?: string;
  url?: string;
  title?: string;
  excerpt?: string;
  aliases?: string[];
  observed_at?: string | null;
  effective_at?: string | null;
  error?: string;
}

interface HistoryTurn {
  id: string;
  thread_id: string;
  timestamp: string;
  user: string;
  assistant: string;
  evidence?: FixtureDoc[];
}

interface Request {
  id: string;
  mode: "replay" | "live";
  timezone: string;
  now?: string;
  history: HistoryTurn[];
  prompt: string;
  search_fixtures: FixtureDoc[];
  restart_before_prompt: boolean;
}

/** The runner's matching rule, mirrored exactly: alias as an alnum substring. */
function alnum(s: string): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function matchingFixtures(query: string, fixtures: FixtureDoc[]): FixtureDoc[] {
  const q = alnum(query);
  return fixtures.filter((f) => (f.aliases ?? []).some((a) => alnum(a) && q.includes(alnum(a))));
}

function toSearchResult(f: FixtureDoc): SearchResult {
  const excerpt = f.excerpt ?? "";
  return {
    title: f.title ?? f.url ?? "source",
    url: f.url ?? "",
    snippet: excerpt.slice(0, 180),
    summary: excerpt,
    date: f.observed_at ?? null,
    authority: 3,
    rerankScore: 2.5,
    siteName: null,
  };
}

function makeReplaySearch(fixtures: FixtureDoc[]) {
  return async (query: string): Promise<SearchResponse> => {
    const matched = matchingFixtures(query, fixtures);
    const usable = matched.filter((m) => !m.error && m.excerpt);
    // A fixture with `error` means the provider failed. If that is all we matched,
    // raise it: the agent is required to disclose the failure, not to invent data.
    if (usable.length === 0 && matched.length > 0) {
      throw new Error(matched[0]!.error ?? "provider error");
    }
    const results = usable.map(toSearchResult);
    return {
      results,
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        modelCalls: 0,
        searchRequests: 1,
        searchAttempts: 1,
        searchResults: results.length,
      },
    };
  };
}

function toEvidenceDoc(f: FixtureDoc): EvidenceDoc {
  return {
    id: f.id ?? f.url ?? "",
    url: f.url ?? "",
    title: f.title ?? "",
    excerpt: f.excerpt ?? "",
    aliases: f.aliases ?? [],
    observedAt: f.observed_at ?? null,
    effectiveAt: f.effective_at ?? null,
  };
}

/** Map internal intents to the runner's allowed route vocabulary. */
function normaliseRoute(intent: Intent): string {
  switch (intent) {
    case "chat":
      return "direct";
    case "answer":
      return "research";
    case "historical_update":
      return "historical_update";
    case "change":
      // A shortlist re-check is the same shape of question: what is true now vs
      // what we recorded before.
      return "historical_update";
    case "clarify":
      return "clarify";
    case "recall":
    default:
      return "recall";
  }
}

async function main(): Promise<void> {
  const raw = await new Promise<string>((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (buf += chunk));
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
  });

  const req = JSON.parse(raw) as Request;
  const nowMs = req.now ? Date.parse(req.now) : Date.now();
  const tz = req.timezone || "UTC";

  const dir = mkdtempSync(path.join(os.tmpdir(), "minimi-eval-"));
  const dbPath = path.join(dir, "agent.db");
  let store = new Store(dbPath);

  try {
    // Import prior exchanges with their original identity and timestamps.
    for (const turn of req.history ?? []) {
      const imported: ImportedTurn = {
        id: turn.id,
        threadId: turn.thread_id,
        ts: Date.parse(turn.timestamp),
        tz,
        user: turn.user,
        assistant: turn.assistant,
        evidence: (turn.evidence ?? []).map(toEvidenceDoc),
      };
      store.importTurn(imported);
    }

    if (req.restart_before_prompt) {
      // Durability check: everything above must survive a close/reopen.
      store.close();
      store = new Store(dbPath);
    }

    const agent = new Agent(store, {
      now: () => nowMs,
      ...(req.mode === "replay"
        ? {
            search: makeReplaySearch(req.search_fixtures ?? []),
            // Replay must be hermetic: grounding guesses domains, and a recorded
            // case that quietly reached the live web would not be a replay.
            fetch: async (url: string) => {
              throw new Error(`replay: no network fetch for ${url}`);
            },
          }
        : {}),
    });

    const reply = await agent.respond({
      conversationId: `eval-${req.id}`,
      text: req.prompt,
      tz,
      now: nowMs,
    });

    // Citations must come back as the *fixture* ids so the runner can verify that
    // the evidence rendered to the user is the evidence it planted.
    const urlToId = new Map<string, string>();
    for (const turn of req.history ?? []) {
      for (const doc of turn.evidence ?? []) {
        if (doc.url && doc.id) urlToId.set(doc.url, doc.id);
      }
    }
    for (const doc of req.search_fixtures ?? []) {
      if (doc.url && doc.id) urlToId.set(doc.url, doc.id);
    }
    const citations = reply.citations.map((c) => ({
      id: urlToId.get(c.url) ?? c.url,
      url: c.url,
    }));

    const trace = reply.trace as Record<string, unknown>;
    const out = {
      answer: reply.text,
      route: normaliseRoute(reply.intent),
      selected_turn_ids: reply.selectedTurnIds,
      search_queries: reply.searchQueries,
      citations,
      agent_ms: Math.round(reply.latencyMs),
      // Answers are not token-streamed, so first text equals completion.
      first_answer_text_ms: Math.round(reply.latencyMs),
      input_tokens: reply.usage.promptTokens,
      output_tokens: reply.usage.completionTokens,
      search_evidence_tokens:
        typeof trace.evidenceTokens === "number" ? trace.evidenceTokens : null,
      model_calls: reply.usage.modelCalls,
      // Evidence the answer was permitted to use. Not part of the runner's
      // contract; consumed by the DeepEval groundedness pass.
      retrieval_context: reply.evidenceTexts,
      // Correlates this case with its LangSmith trace for review.
      trace_id: reply.traceId ?? null,
    };
    process.stdout.write(JSON.stringify(out));
  } finally {
    try {
      store.close();
    } catch {
      /* already closed */
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  // Diagnostics go to stderr: stdout is the protocol channel and must stay clean.
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
