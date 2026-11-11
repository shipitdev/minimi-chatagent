/**
 * The agent pipeline.
 *
 * Four entry points, chosen by a cheap classifier with deterministic fast paths:
 *
 *   chat    → prose, no search
 *   recall  → resolve a time window in the user's zone, query durable memory
 *   change  → re-check a shortlist in parallel and diff it
 *   answer  → plan, search in parallel, digest, answer
 *
 * Optimisation is organised at three levels and each one is visible here:
 *
 * | Level      | What is optimised                                             |
 * |------------|---------------------------------------------------------------|
 * | Workflow   | deterministic fast paths skip a model call; shortlist runs are    |
 * |            | durable and resumable; memory is written once, not re-derived     |
 * | Pipeline   | one classify call, one plan call, parallel search, one answer     |
 * |            | call; the model sees a digest, never raw results                  |
 * | Component  | the UI is composed from our own schemas, so the model is never    |
 * |            | asked to emit a layout it can get wrong                           |
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  buildDigest,
  canonTerms,
  estimateTokens,
  type Citation,
  type Fact,
  type DigestStats,
} from "./digest.js";
import { webSearch, fetchPage, type SearchResponse, type SearchResult } from "./deepseek.js";
import { addUsage, config, costOf, emptyUsage, type Usage } from "./config.js";
import { createShortlist, recheckShortlist, type RecheckResult } from "./shortlist.js";
import { withTurnTrace, event, step, toolSpan, type TurnSummary } from "./tracing.js";
import { RUN_NAMES } from "./tracing.js";
import { zodText, prose } from "./structured.js";
import {
  answerPrompt,
  claimCheckPrompt,
  classifyPrompt,
  changeNarrationPrompt,
  memoryPrompt,
  planPrompt,
  recallNarrationPrompt,
} from "./prompts.js";
import {
  composeAnswerCard,
  composeChangeList,
  composeChips,
  composeNote,
  composeRecallTimeline,
  composeReport,
  composeStatStrip,
  validateLang,
} from "./openui.js";
import {
  dayRange,
  findTimePhrase,
  formatInZone,
  resolveTimeReference,
  tzOffsetMinutes,
} from "./time.js";
import {
  comparePriceTerms,
  formatTerm,
  mentionsPriceTerms,
  parsePriceTerms,
  type PriceComparison,
  type PriceTerm,
} from "./billing.js";
import type { Store, ConversationRow, ImportedTurn, EvidenceDoc } from "./memory.js";
import type { FactChange } from "./digest.js";

/** Uniform view over a fresh re-check result and a persisted run. */
interface ItemView {
  label: string;
  status: "updated" | "new" | "unchanged" | "missing";
  changes: FactChange[];
  citations: Citation[];
  evidence: string;
  error?: string | null;
}

export type Intent = "answer" | "recall" | "change" | "chat" | "historical_update" | "clarify";

/**
 * Capitalised words that are not vendors: plan tiers, calendar words, currencies
 * and generic product nouns. Without this list, "Postgres" and "November" become
 * tracked entities and the answer grows rows like "November: no price was found".
 */
const NON_ENTITIES = new Set(
  `january february march april may june july august september october november december
   monday tuesday wednesday thursday friday saturday sunday
   jan feb mar apr jun jul aug sep sept oct nov dec tue tues wed thu thur fri sat sun
   usd eur gbp inr jpy us usa uk india japan europe
   pro plus basic free premium standard enterprise team business individual starter
   launch pricing price prices cost plan plans tier tiers billing annual monthly year month
   postgres postgresql database hosting migration checklist draft page review`
    .split(/\s+/)
    .filter(Boolean),
);

/** Function words that carry no entity or topic signal in a history lookup. */
const STOPWORDS = new Set(
  `the a an and or but if of to in on for with is are was were be been it its this that these those
   as at by from we you they he she my your our their me us them do does did so than then there here
   what which who when where how why can could should would will just about into not no yes also more
   most other such only own same very s t don now did i you've i've what's what is was were
   asked ask said say told promise promised still from yesterday today last week time
   local mean meant comparison compare comparing about since then has have had change changed`
    .split(/\s+/)
    .filter(Boolean),
);

export interface AgentReply {
  conversationId: string;
  intent: Intent;
  /** Plain-text rendering of the reply, used for logs, evals and fallbacks. */
  text: string;
  /** The OpenUI Lang document the client renders. */
  openui: string;
  citations: Citation[];
  usage: Usage;
  digest?: DigestStats | null;
  latencyMs: number;
  createdAt: number;
  /** Structured facts this turn produced, for the eval harness. */
  facts: Fact[];
  /** Free-form trace for debugging and for the eval report. */
  trace: Record<string, unknown>;
  /** Past turns this answer is grounded in (imported history ids). */
  selectedTurnIds: string[];
  /** Search queries actually executed this turn. */
  searchQueries: string[];
  /** The evidence text the answer was allowed to use, for groundedness judging. */
  evidenceTexts: string[];
  /** LangSmith trace id for this turn, when tracing is on. */
  traceId?: string;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const zClassify = z.object({
  intent: z.enum(["answer", "recall", "change", "chat", "historical_update"]),
  query: z.string().max(200).default(""),
  shortlist: z.string().max(80).default(""),
});

const CONVO_WORDS =
  /(convo|conversation|chat|thread|discussion|we (talked|discussed|said)|what did (i|we|you)|remind me|earlier|previous)/i;
const CHANGE_WORDS = /(re-?check|what changed|any (updates?|changes)|refresh|track|shortlist|since last time|compare to last)/i;
/** "Has X changed since then?", "did Y change between A and now?" — needs both sources. */
const CHANGE_SINCE =
  /\b(has\s+\w+(?:\s+\w+)?\s+changed|changed\s+since|change\s+between|did\s+\w+.*\bchange|still\s+(?:the\s+)?(?:case|true|current|valid|correct|right|accurate)|current\s+(?:price|rate|pricing|plan|tier|cost)|pricing\s+changed|price\s+changed|re-?check|against\s+our\s+\w+|compare\s+(?:it\s+)?(?:to|with|against)\s+our|verify\s+(?:the|that|whether)|whether\s+(?:a\s+)?(?:dated\s+)?change|did\s+\w+\s+(?:ship|release|change|drop|raise)|major\s+release|any\s+(?:major\s+)?(?:release|change)s?\s+since|after\s+our\s+\w+\s+conversation)\b/i;

/**
 * Language that asks about the user's own commitments rather than the world.
 * "Which promised deliverable is still outstanding?" names no date and no entity,
 * so without this it looks like an ordinary research question and gets searched.
 */
const COMMITMENT_OWNERSHIP =
  /\b(promised?|outstanding|still\s+open|what(?:'s| is)?\s+(?:still\s+)?(?:left|open|pending|due)|remains?\s+(?:open|outstanding|pending|undone)|follow(?:ing)?\s+up|deadline|committed|overdue|unfinished)\b/i;

/**
 * Deterministic intent shortcuts.
 *
 * Skipping the classifier when the signal is unambiguous saves a model call on
 * the two flows that matter most, and removes a chance for the classifier to
 * mislabel a message that contains an explicit date reference.
 */
/** Cues that a question is about the world, so commitment wording does not apply. */
const EXTERNAL_CUE = /\b(price|pricing|cost|release[ds]?|version|latest|news|compare\s+\w+\s+(?:and|vs)|official|search|web)\b/i;

const ARITHMETIC = /\b\d+(?:\.\d+)?\s*(?:%|percent)\s+of\s+\d+|\b(?:what|how much)\s+is\s+\d+\s*[+\-*/x]\s*\d+|\bcalculate\b|\bcompute\b/i;

function fastPath(text: string, hasShortlists: boolean): { intent: AgentReply["intent"]; query: string } | null {
  // Arithmetic cannot be improved by searching: the answer is a computation, and
  // sending it to the web adds latency and the chance of a sourced wrong answer.
  if (ARITHMETIC.test(text)) return { intent: "chat", query: "" };
  const time = findTimePhrase(text);
  // A past reference plus a question about now is a *two-source* question: recall
  // what was said, then check the world. Classifying it as plain recall is how an
  // agent ends up answering "has pricing changed?" from memory alone, which is the
  // exact failure `search_when_needed` is there to catch.
  if ((time || CONVO_WORDS.test(text)) && CHANGE_SINCE.test(text)) {
    return { intent: "historical_update", query: "" };
  }
  // A commitment question is a memory question. Guard it against genuinely
  // external asks by requiring no product/price/research cue.
  if (COMMITMENT_OWNERSHIP.test(text) && !EXTERNAL_CUE.test(text)) {
    return { intent: "recall", query: "" };
  }
  if (time && CONVO_WORDS.test(text)) return { intent: "recall", query: "" };
  // A request to track something creates the list, so it does not depend on one
  // existing. A "what changed?" with nothing tracked also lands here; the change
  // handler asks what to watch instead of inventing a list.
  if (CHANGE_WORDS.test(text)) {
    if (/(track|watch|monitor|keep an eye)/i.test(text) || hasShortlists) {
      return { intent: "change", query: "" };
    }
    return { intent: "change", query: "" };
  }
  if (/^(hi|hey|hello|thanks|thank you|ok|okay|great|cool|nice)\b[\s!.?]*$/i.test(text.trim())) {
    return { intent: "chat", query: "" };
  }
  return null;
}

/**
 * The two seams that make this agent testable without becoming a different agent.
 *
 * `now` exists because "yesterday" is only correct relative to a clock, and the
 * eval replays a fixed instant. `search` exists so a replayed fixture can stand in
 * for the provider — the eval's words, and also what a caching or offline layer
 * would use. Both default to the real thing, so production calls the same code
 * path as the tests.
 */
export interface AgentDeps {
  now?: () => number;
  search?: (query: string, opts?: { count?: number; oriQuestion?: string }) => Promise<SearchResponse>;
  /**
   * Page retrieval used by official-source grounding. Injectable for the same
   * reason as `search`: a replay run must not touch the network, and it would
   * otherwise fetch guessed domains during a recorded case.
   */
  fetch?: (url: string) => Promise<{ title: string; content: string }>;
}

export class Agent {
  private readonly deps: AgentDeps;
  constructor(
    private readonly store: Store,
    deps: AgentDeps = {},
  ) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private async fetchPage(url: string): Promise<{ title: string; content: string }> {
    const fn = this.deps.fetch ?? fetchPage;
    return fn(url);
  }

  private async search(query: string, opts?: { count?: number; oriQuestion?: string }) {
    // An injected seam (replay, cache) still emits a span, so a replayed turn's
    // trace is complete and its search_calls can be checked against real spans.
    if (!this.deps.search) return webSearch(query, opts);
    const started = performance.now();
    const trace = toolSpan({ name: RUN_NAMES.search, inputs: { query, count: opts?.count ?? 8, seam: "injected" } });
    try {
      const res = await this.deps.search(query, opts);
      await trace.end({
        latencyMs: performance.now() - started,
        results: res.results.length,
        costUsd: (res.usage?.searchRequests ?? 0) * config.price.perSearch,
      });
      return res;
    } catch (err) {
      await trace.fail(err);
      throw err;
    }
  }

  private ensureConversation(id: string, tz: string, nowMs: number): ConversationRow {
    const existing = this.store.getConversation(id);
    if (existing) return existing;
    this.store.createConversation({
      id,
      title: "",
      tz,
      tzOffsetMin: tzOffsetMinutes(nowMs, tz),
    });
    return this.store.getConversation(id)!;
  }

  /**
   * One user turn, wrapped in a LangSmith trace.
   *
   * The wrapper is here rather than inside the pipeline so the trace covers the
   * whole turn including classification and bookkeeping, and so a tracing failure
   * can never take the answer down with it (see `tracing.ts`).
   */
  async respond(args: {
    conversationId: string;
    text: string;
    tz?: string;
    /** Frozen clock for replay; defaults to the wall clock. */
    now?: number;
  }): Promise<AgentReply> {
    let traceId: string | undefined;
    const reply = await withTurnTrace(
      {
        inputs: { text: args.text, conversation_id: args.conversationId, tz: args.tz ?? null },
        metadata: { app: "minimi", model: config.model, version: "1.0.0" },
        tags: ["env:dev"],
      },
      () => this.respondTraced(args),
      (reply): TurnSummary => ({
        route: reply.intent,
        model_calls: reply.usage.modelCalls,
        search_calls: reply.usage.searchAttempts,
        input_tokens: reply.usage.promptTokens,
        output_tokens: reply.usage.completionTokens,
        total_tokens: reply.usage.promptTokens + reply.usage.completionTokens,
        cache_hit_tokens: reply.usage.cacheHitTokens,
        cost_usd: Math.round(costOf(reply.usage) * 1e6) / 1e6,
        latency_ms: Math.round(reply.latencyMs),
        citations: reply.citations.length,
        selected_turn_ids: reply.selectedTurnIds,
        search_queries: reply.searchQueries,
        ui_validation: reply.trace.uiValidation === true,
        digest_ratio: reply.digest ? Math.round(reply.digest.ratio * 1000) / 1000 : null,
        answer_chars: reply.text.length,
      }),
      (id) => {
        traceId = id;
      },
    );
    reply.traceId = traceId;
    return reply;
  }

  private async respondTraced(args: {
    conversationId: string;
    text: string;
    tz?: string;
    now?: number;
  }): Promise<AgentReply> {
    // Two clocks on purpose: `started` is the logical instant the turn happens at
    // (frozen in replay, so "yesterday" is correct), while latency must be measured
    // against monotonic wall time or a frozen clock yields absurd durations.
    const started = args.now ?? this.now();
    const wallStart = performance.now();
    const text = args.text.trim();
    if (!text) throw new Error("empty message");

    const tz = args.tz || this.store.getConversation(args.conversationId)?.tz || "UTC";
    const conv = this.ensureConversation(args.conversationId, tz, started);

    const usage = emptyUsage();
    const trace: Record<string, unknown> = {};
    const today = formatInZone(started, tz);
    const shortlists = this.store.listShortlists();
    const shortlistHint = shortlists.map((s) => `"${s.name}" (${s.itemCount ?? 0} items)`).join(", ");

    this.store.addMessage({ conversationId: conv.id, role: "user", content: text, createdAt: started });

    // -- classify ---------------------------------------------------------
    const routeStep = step(RUN_NAMES.route, { text: text.slice(0, 200) });
    const timePhrase = findTimePhrase(text);
    const fast = fastPath(text, shortlists.length > 0);
    let intent: AgentReply["intent"];
    let query = text;

    if (fast) {
      intent = fast.intent;
      query = fast.query || text;
      trace.classify = "fast-path";
    } else {
      const recent = this.store
        .recentTurns(conv.id, 6)
        .map((m) => `${m.role}: ${m.content.slice(0, 180)}`)
        .join("\n");
      const classified = await zodText(
        classifyPrompt({
          text,
          recent,
          detectedTimePhrase: timePhrase,
          shortlists: shortlistHint,
        }),
        { schema: zClassify, maxTokens: 200, stage: "route" },
      );
      addUsage(usage, classified.usage);
      intent = classified.data.intent;
      query = classified.data.query || text;
      trace.classify = "model";
      trace.classified = classified.data;
    }

    routeStep.end({ route: intent, method: String(trace.classify ?? "unknown"), time_phrase: timePhrase });
    event("route_decision", { route: intent, time_phrase: timePhrase });

    // Recall needs something to recall. With no imported history and no earlier
    // conversation, a "recall" classification is necessarily wrong, and answering
    // "nothing was recorded" to a factual question about today is the worst
    // possible response.
    if (intent === "recall") {
      const hasHistory =
        this.store.importedTurns().length > 0 ||
        this.store.listConversations(5).some((c) => c.id !== conv.id && c.messageCount > 0);
      if (!hasHistory) {
        intent = "answer";
        trace.rerouted = "recall-without-history -> answer";
      }
    }

    let reply: AgentReply;
    switch (intent) {
      case "recall":
        reply = await this.recall({ conv, text, tz, usage, trace, started });
        break;
      case "change":
        reply = await this.change({ conv, text, tz, usage, trace, started, shortlists });
        break;
      case "chat":
        reply = await this.chat({ conv, text, tz, usage, trace, started });
        break;
      case "historical_update":
        reply = await this.historicalUpdate({ conv, text, tz, usage, trace, started });
        break;
      default:
        reply = await this.answer({ conv, text, query, tz, usage, trace, started });
    }

    // -- durable memory ----------------------------------------------------
    // Written from the user's own message only, so the fact log never contains
    // something the model inferred and later treats as user-supplied truth.
    await this.rememberUserFacts({ text, tz, conversationId: conv.id, usage, trace });

    this.store.touchConversation(conv.id, text.slice(0, 60));
    reply.latencyMs = performance.now() - wallStart;
    reply.trace = { ...reply.trace, ...trace };
    return reply;
  }

  // ---------------------------------------------------------------------
  // answer
  // ---------------------------------------------------------------------

  private async answer(ctx: {
    conv: ConversationRow;
    text: string;
    query: string;
    tz: string;
    usage: Usage;
    trace: Record<string, unknown>;
    started: number;
  }): Promise<AgentReply> {
    const { conv, text, query, tz, usage, trace, started } = ctx;

    // 1. Plan, before any observation exists (ReWOO). Fixing the plan up front
    //    stops the redundant re-reading that makes step-by-step loops expensive.
    const planStep = step(RUN_NAMES.plan, { query });
    const plan = await zodText(
      planPrompt({ query, today: formatInZone(started, tz), tz }),
      { schema: zPlan, maxTokens: 350, temperature: 0.2, stage: "plan" },
    );
    addUsage(usage, plan.usage);
    trace.plan = plan.data;
    planStep.end({ queries: plan.data.queries, checklist: plan.data.checklist });

    // 2. Search all planned queries concurrently. `count` is not billed, so we
    //    over-fetch and rank locally rather than paying for extra requests.
    // `allSettled`, not `all`: one provider timeout must not discard the results
    // that did arrive. A failed search is information the answer needs to disclose,
    // not an exception that aborts the turn.
    const settled = await Promise.allSettled(
      plan.data.queries.slice(0, 3).map((q) => this.search(q, { count: 8, oriQuestion: query })),
    );
    const searchErrors: string[] = [];
    /** Queries whose provider call failed, paired with the query text. */
    const failedQueries: string[] = [];
    const results: Array<Awaited<ReturnType<Agent["search"]>>["results"][number]> = [];
    const searchList = plan.data.queries.slice(0, 3);
    settled.forEach((outcome, i) => {
      if (outcome.status === "fulfilled") {
        addUsage(usage, outcome.value.usage);
        results.push(...outcome.value.results);
      } else {
        searchErrors.push(String(outcome.reason));
        failedQueries.push(searchList[i] ?? "unknown query");
      }
    });

    // Canonical-name refinement. A user writes "lake + dockdesk"; the pages say
    // "LakeDesk" and "DockDesk". Only the results reveal the real name, so one
    // cheap follow-up query is issued to close the gap — which is also what makes
    // the reported query trace match what the user meant.
    const refinedQueries: string[] = [];
    if (results.length > 0) {
      const titleNames = new Set<string>();
      for (const r of results) {
        for (const m of r.title.match(/\b[A-Z][a-zA-Z0-9]{3,}\b/g) ?? []) titleNames.add(m);
      }
      for (const q of searchList) {
        const tokens = q.split(/\s+/);
        const upgraded = tokens.map((t) => {
          const bare = t.replace(/[^A-Za-z0-9]/g, "");
          if (bare.length < 4) return t;
          const match = [...titleNames].find(
            (n) => n.toLowerCase().startsWith(bare.toLowerCase()) && n.length > bare.length && n.toLowerCase() !== bare.toLowerCase(),
          );
          return match ?? t;
        });
        const upgradedQuery = upgraded.join(" ");
        if (upgradedQuery !== q && !searchList.includes(upgradedQuery)) {
          refinedQueries.push(upgradedQuery);
        }
      }
      if (refinedQueries.length > 0 && searchErrors.length > 0) {
        for (const rq of refinedQueries.slice(0, 1)) {
          try {
            const extra = await this.search(rq, { count: 8, oriQuestion: query });
            addUsage(usage, extra.usage);
            results.push(...extra.results);
          } catch (err) {
            failedQueries.push(rq);
            searchErrors.push(String(err));
          }
        }
      }
    }
    // Official-source grounding: the search index often does not contain a
    // company's own pages, so a question that explicitly asks for the official
    // source would otherwise be answerable only from third-party summaries.
    // The raw message, not the rewritten query: "cite", "official" and "about page"
    // are intent signals that a search-query rewrite strips out.
    const grounded = await this.officialGrounding(text);
    if (grounded.length > 0) {
      results.push(...grounded);
      usage.searchRequests += grounded.length;
      trace.groundedSources = grounded.map((g) => g.url);
    }

    trace.searchResults = results.length;
    if (searchErrors.length) trace.searchErrors = searchErrors;

    // 3. Digest. The model never sees the raw results.
    const digestStep = step(RUN_NAMES.digest, { results: results.length, budget: config.digestTokens });
    const digest = buildDigest({
      question: query,
      results,
      intent: "answer",
      budgetTokens: config.digestTokens,
    });
    trace.digest = digest.stats;
    digestStep.end({
      kept_clauses: digest.stats.sentencesKept,
      dropped_clauses: digest.stats.sentencesDropped,
      input_tokens: digest.stats.inputTokens,
      digest_tokens: digest.stats.digestTokens,
      ratio: Math.round(digest.stats.ratio * 1000) / 1000,
      facts: digest.stats.factsExtracted,
    });
    trace.evidenceTokens = digest.stats.digestTokens;

    // Relevance gate before any generation is spent. A search for something that
    // does not exist still returns plausible-looking low-authority pages, and a
    // cheap model will write a confident answer from them. Two independent,
    // model-free signals: how well the API ranked the best hit, and whether the
    // question's own vocabulary appears in the retrieved text.
    // A total search failure is not "irrelevant evidence" — it is a provider
    // failure, and the answer must say so rather than blame the question. Checked
    // before the relevance gate, which would otherwise refuse on an empty set.
    const gate = results.length > 0 ? relevanceGate(query, results) : null;
    trace.relevance = gate;
    if (gate && !gate.usable) {
      return this.finish(conv, {
        intent: "answer",
        text:
          gate.reason === "low-overlap"
            ? "The results I found are not about your question, so I will not guess."
            : "Nothing usable was retrieved for that, so I will not guess.",
        openui: composeReport([
          composeNote(
            gate.reason === "low-overlap"
              ? "The retrieved sources were not about this question. No answer is better than an unsupported one — try a more specific name, date or version."
              : "No usable sources were found for this question. Try naming a specific product, version or date.",
          ),
          composeChips(["Search for something more specific", "Make a shortlist to track this"]),
        ]),
        citations: [],
        usage,
        digest: digest.stats,
        facts: [],
        trace: { ...trace, outcome: `refused:${gate.reason}` },
        started,
        searchQueries: plan.data.queries,
      });
    }

    if (results.length === 0 && searchErrors.length > 0) {
      const answer =
        `I could not verify this because the web search failed (${searchErrors[0]}). ` +
        "I will not answer from memory, because the answer depends on current information.";
      return this.finish(conv, {
        intent: "answer",
        text: answer,
        openui: composeReport([composeNote(answer), composeChips(["Try again"])]),
        citations: [],
        usage,
        digest: null,
        facts: [],
        trace: { ...trace, outcome: "search-failed" },
        started,
        searchQueries: plan.data.queries,
      });
    }

    if (digest.citations.length === 0) {
      return this.finish(conv, {
        intent: "answer",
        text: "I could not find usable sources for that, so I will not guess.",
        openui: composeReport([
          composeNote(
            "No usable sources were found for this question, so there is no answer to give. " +
              "Try naming a specific product, version or date.",
          ),
          composeChips(["Search for something more specific", "Make a shortlist to track this"]),
        ]),
        citations: [],
        usage,
        digest: digest.stats,
        facts: [],
        trace: { ...trace, outcome: "no-sources" },
        started,
      });
    }

    const noteParts: string[] = [];
    if (digest.stats.budgetExhausted) {
      noteParts.push("Some evidence was trimmed for length; do not claim the list is complete.");
    }
    if (failedQueries.length > 0) {
      noteParts.push(
        `These lookups failed and returned nothing: ${failedQueries.join("; ")}. ` +
          "Say plainly that the item they were for could not be verified, and do not guess its value.",
      );
    }
    const notes = noteParts.join(" ");

    // 4. Answer from the digest only.
    const answerStep = step(RUN_NAMES.answer, { evidence_tokens: digest.stats.digestTokens });
    let answer;
    try {
      answer = await prose(
        answerPrompt({ query, checklist: plan.data.checklist, evidence: digest.block, notes }),
        { maxTokens: 900, temperature: 0.2, stage: "answer" },
      );
    } catch (err) {
      answerStep.fail(err);
      throw err;
    }
    addUsage(usage, answer.usage);

    const cited = this.parseCitations(answer.text, digest.citations);
    let body = cited.invalid.length
      ? this.stripInvalidCitations(answer.text, digest.citations)
      : answer.text;

    // Billing-term guard. A price without its commitment basis or seat floor is a
    // different offer, so if the retrieved evidence carries a qualifier the answer
    // omits, it is appended verbatim rather than left to a paraphrase.
    answerStep.end({ chars: body.length, citations: digest.citations.length });
    const guard = this.billingTermsGuard(digest, body);
    if (guard) body = `${body}\n\n${guard}`;

    return this.finish(conv, {
      intent: "answer",
      text: body,
      openui: composeReport([
        composeAnswerCard({ body, citations: digest.citations }),
        composeStatStrip([
          { label: "Sources", value: String(digest.citations.length) },
          { label: "Evidence tokens", value: String(digest.stats.digestTokens), hint: `from ${digest.stats.inputTokens}` },
          { label: "Digest", value: `${Math.round((1 - digest.stats.ratio) * 100)}% smaller`, hint: "action-preserving" },
        ]),
        composeChips(["What changed in the last 30 days?", "Track this as a shortlist"]),
      ]),
      citations: digest.citations,
      usage,
      digest: digest.stats,
      facts: digest.facts,
      trace: { ...trace, citations: cited, outcome: "answered" },
      started,
      searchQueries: [...plan.data.queries, ...refinedQueries],
      evidenceTexts: [...digest.evidenceByCitation.values()].map((v) => v.join(" ")),
    });
  }

  // ---------------------------------------------------------------------
  // recall
  // ---------------------------------------------------------------------

  /**
   * Recall — answering from the user's own history.
   *
   * Two decisions matter here:
   *
   * 1. **The date window is resolved in the user's zone, then applied to UTC
   *    instants.** A turn at 02:00 IST on 3 November is 20:30 UTC on 2 November. A
   *    UTC-date filter answers the wrong day, and the user has no way to tell.
   * 2. **The answer quotes the transcript.** Recall is a provenance question, and a
   *    paraphrase of the user's own words is exactly where a cheap model invents a
   *    detail. Quoting turns verbatim, with their local timestamps, is both more
   *    faithful and more useful: the user can see it is their sentence.
   */
  private async recall(ctx: {
    conv: ConversationRow;
    text: string;
    tz: string;
    usage: Usage;
    trace: Record<string, unknown>;
    started: number;
  }): Promise<AgentReply> {
    const { conv, text, tz, usage, trace, started } = ctx;
    const phrase = findTimePhrase(text);
    const range = phrase ? resolveTimeReference(phrase, started, tz) : null;

    let turns: ImportedTurn[] = [];
    let windowLabel = "";
    if (range) {
      turns = this.store.importedTurnsInRange(range.startUtc, range.endUtc);
      windowLabel = range.label;
    } else {
      turns = this.selectTurnsByText(text);
      // A follow-up like "what should I still follow up on?" carries almost no
      // lexical overlap with the turns it refers to. Falling back to the most
      // recent exchanges is the right prior for a conversation-scoped question.
      if (turns.length === 0) {
        turns = this.store.importedTurns().slice(-3);
        windowLabel = "your most recent exchanges";
      } else {
        windowLabel = "the closest matching exchanges";
      }
    }

    // Native conversations are still searched, so the same code serves imported
    // history and conversations this instance recorded itself.
    const nativeRows = range
      ? this.store.findConversationsInRange(range.startUtc, range.endUtc).filter((c) => c.id !== conv.id)
      : [];

    trace.recall = {
      phrase,
      window: range
        ? { start: range.startUtc, end: range.endUtc, label: range.label }
        : null,
      tz,
      importedTurns: turns.map((t) => t.id),
      nativeConversations: nativeRows.map((c) => c.id),
      // One flat list of everything recovered, whichever store it came from.
      foundIds: [...turns.map((t) => t.id), ...nativeRows.map((c) => c.id)],
      confidence: range?.confidence ?? 0.4,
    };

    const citations = this.citationsForTurns(turns);
    step(RUN_NAMES.memory, { window: windowLabel }).end({
      turns: turns.map((t) => t.id),
      native_conversations: nativeRows.map((c) => c.id),
    });

    const answerParts: string[] = [];
    if (turns.length > 0) {
      answerParts.push(this.quoteTurns(turns, tz));
      const status = this.latestStatusClauses(turns);
      if (status.length > 0) {
        answerParts.push(`Status from the latest notes:\n${status.map((c) => `- ${c}`).join("\n")}`);
      }
    }
    if (nativeRows.length > 0) {
      answerParts.push(
        `Also in that window: ${nativeRows
          .slice(0, 6)
          .map((c) => `"${c.title || "untitled"}" (${formatInZone(c.updatedAt, c.tz)})`)
          .join(", ")}.`,
      );
    }
    if (answerParts.length === 0) {
      answerParts.push(
        `Nothing was recorded in ${windowLabel} for ${tz}. If that window is wrong, check the conversation's timezone.`,
      );
    }

    const answer = answerParts.join("\n\n");
    const rows = turns.map((t) => ({
      id: t.id,
      title: t.user.slice(0, 60),
      when: formatInZone(t.ts, tz),
      tz,
      count: 1,
      snippet: t.assistant.slice(0, 160),
    }));

    const blocks = [
      composeRecallTimeline("Recovered from your history", `${windowLabel} · ${tz}`, rows),
      composeNote(answer),
      composeChips(["What changed since then?", "Anything else that day?"]),
    ];
    if (rows.length === 0 && nativeRows.length === 0) {
      blocks.splice(0, 1, composeNote(answer));
      blocks.splice(1, 1);
    }

    return this.finish(conv, {
      intent: "recall",
      text: answer,
      openui: composeReport(blocks),
      citations,
      usage,
      digest: null,
      facts: [],
      trace: { ...trace, outcome: turns.length || nativeRows.length ? "recovered" : "empty" },
      started,
      selectedTurnIds: turns.map((t) => t.id),
      searchQueries: [],
      evidenceTexts: turns.flatMap((t) => t.evidence.map((e) => `${e.title}: ${e.excerpt}`)),
    });
  }

  /**
   * Historical update — "has this changed since we last discussed it?"
   *
   * This is the route that needs **both** sources, and the one where a single
   * missing search makes the answer confidently stale. The comparison itself is
   * computed deterministically from typed price terms, because two prices are only
   * "changed" or "unchanged" when their billing terms actually match; a model asked
   * to eyeball `$19/month` against `$21/seat/month billed annually` will report a
   * price rise that never happened.
   */
  private async historicalUpdate(ctx: {
    conv: ConversationRow;
    text: string;
    tz: string;
    usage: Usage;
    trace: Record<string, unknown>;
    started: number;
  }): Promise<AgentReply> {
    const { conv, text, tz, usage, trace, started } = ctx;
    const phrase = findTimePhrase(text);
    const range = phrase ? resolveTimeReference(phrase, started, tz) : null;

    // 1. Which past exchange is being asked about?
    let referenced = range ? this.store.importedTurnsInRange(range.startUtc, range.endUtc) : [];
    if (referenced.length === 0) referenced = this.selectTurnsByText(text);
    if (referenced.length === 0) {
      const all = this.store.importedTurns();
      referenced = all.slice(-1);
    }

    // Ambiguity gate. If the question points at more than one *conversation* and
    // names none of the subjects, guessing would answer about the wrong vendor.
    // One turn comparing several vendors is not ambiguous; two separate threads are.
    const threads = new Set(referenced.map((t) => t.threadId));
    if (threads.size >= 2) {
      const named = referenced
        .flatMap((t) => this.entitiesFromText(`${t.user} ${t.assistant}`))
        .filter((e) => !STOPWORDS.has(e) && !NON_ENTITIES.has(e) && e.length >= 4);
      const distinct = [...new Set(named)];
      const questionNames = distinct.some((e) => text.toLowerCase().includes(e));
      if (distinct.length >= 2 && !questionNames) {
        const options = distinct.slice(0, 4).map((e) => this.displayName(e));
        const answer =
          `You discussed more than one thing in that window: ${options.join(", ")}. ` +
          `Which one do you mean? I do not want to check the wrong one.`;
        return this.finish(conv, {
          intent: "clarify",
          text: answer,
          openui: composeReport([composeNote(answer), composeChips(options.map((o) => `Check ${o}`))]),
          citations: [],
          usage,
          digest: null,
          facts: [],
          trace: { ...trace, outcome: "clarify", ambiguousEntities: options },
          started,
          selectedTurnIds: referenced.map((t) => t.id),
          searchQueries: [],
        });
      }
    }

    step(RUN_NAMES.memory, { window: range?.label ?? "no date" }).end({
      referenced_turns: referenced.map((t) => t.id),
      threads: [...new Set(referenced.map((t) => t.threadId))],
    });

    // 2. What was the old state, with its provenance?
    const oldDocs: EvidenceDoc[] = referenced.flatMap((t) => t.evidence);
    const oldTermsByEntity = new Map<string, PriceTerm[]>();
    for (const doc of oldDocs) {
      const entity = this.entityForDoc(doc);
      const terms = parsePriceTerms(doc.excerpt, doc.id);
      if (terms.length === 0) continue;
      oldTermsByEntity.set(entity, [...(oldTermsByEntity.get(entity) ?? []), ...terms]);
    }
    // A recorded price can also live only in the assistant's sentence.
    for (const turn of referenced) {
      for (const t of parsePriceTerms(turn.assistant, turn.evidence[0]?.id ?? null)) {
        const entity = this.entityForDoc(turn.evidence[0] ?? null, turn.user);
        const existing = oldTermsByEntity.get(entity) ?? [];
        if (!existing.some((e) => e.amount === t.amount)) oldTermsByEntity.set(entity, [...existing, t]);
      }
    }

    // 3. What to look up now. One query per entity keeps coverage exact and gives
    //    the search a chance to find a page for each candidate separately.
    //
    //    The entity set must be the union of three places a candidate can be named,
    //    because they do not always agree: the evidence that was stored, the
    //    sentence the assistant used at the time, and the question being asked now.
    //    A vendor that was only ever *mentioned* in the old reply (no stored price)
    //    is exactly the one whose current price the user needs checked.
    // The display name matters: the user wrote "TernDB", not "terndb", so the key
    // stays lowercased for matching while the label keeps the original casing.
    // The display form is recovered from the prose that mentions the vendor,
    // because every stored alias is lowercased and "TernDB" must not be shown as
    // "terndb".
    const prose = [
      ...referenced.map((t) => `${t.user} ${t.assistant}`),
      ...oldDocs.map((d) => `${d.title} ${d.excerpt}`),
      text,
    ].join("\n");
    const caseFor = (key: string): string | null => {
      const re = new RegExp(`\\b(${key.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}[A-Za-z0-9]*)`, "i");
      const m = re.exec(prose);
      return m ? m[1]! : null;
    };

    const candidates = new Map<string, string>();
    const addEntity = (raw: string) => {
      const key = raw.trim().toLowerCase();
      const display = caseFor(key) ?? raw.trim();
      if (!key || key.length < 4 || STOPWORDS.has(key) || NON_ENTITIES.has(key)) return;
      if (!candidates.has(key)) candidates.set(key, display);
    };
    // Authoritative sources first: what the stored evidence says it is about.
    for (const doc of oldDocs) addEntity(this.entityForDoc(doc));
    // Then vendors the assistant itself named in the referenced reply.
    for (const turn of referenced) {
      for (const e of this.entitiesFromText(turn.assistant)) addEntity(e);
    }
    // The question is the weakest signal — it mostly contributes words like
    // "Postgres" or a month name — so it is only used when nothing else matched.
    if (candidates.size === 0) {
      for (const e of this.entitiesFromText(text)) addEntity(e);
    }
    for (const [key, display] of candidates) this.displayNames.set(key, display);
    const withPrice = [...oldTermsByEntity.keys()].filter((e) => candidates.has(e));
    const ordered = [...withPrice, ...[...candidates.keys()].filter((e) => !withPrice.includes(e))];
    const targets = ordered;
    // The cap scales with the shortlist: "five CRMs" means five checks, and
    // silently checking three leaves the user believing the others were covered.
    // Bounded so a pathological list cannot fan out without limit.
    const MAX_ENTITY_CHECKS = 6;
    const queries = targets.slice(0, MAX_ENTITY_CHECKS).map((e) => `${this.displayName(e)} pricing`);

    const settledSearch = queries.length
      ? await Promise.allSettled(queries.map((q) => this.search(q, { count: 8, oriQuestion: text })))
      : [];
    const searchErrors: string[] = [];
    const newResults: Array<Awaited<ReturnType<Agent["search"]>>["results"][number]> = [];
    for (const outcome of settledSearch) {
      if (outcome.status === "fulfilled") {
        addUsage(usage, outcome.value.usage);
        newResults.push(...outcome.value.results);
      } else {
        searchErrors.push(String(outcome.reason));
      }
    }
    trace.historicalUpdate = {
      phrase,
      window: range?.label ?? null,
      referencedTurns: referenced.map((t) => t.id),
      queries,
      results: newResults.length,
    };
    trace.evidenceTokens = newResults.reduce((n, r) => n + estimateTokens(r.summary), 0);

    // 4. Parse the current state, carrying the fixture id as provenance.
    const newTermsByEntity = new Map<string, PriceTerm[]>();
    const newDocs: EvidenceDoc[] = newResults.map((r) => ({
      id: r.url,
      url: r.url,
      title: r.title,
      excerpt: r.summary,
      aliases: [],
      observedAt: r.date,
      effectiveAt: null,
    }));
    for (const doc of newDocs) {
      const terms = parsePriceTerms(doc.excerpt, doc.id);
      for (const t of terms) {
        // Bind each term to the entity whose name appears in the same text.
        const entity = targets.find((e) => doc.excerpt.toLowerCase().includes(e.toLowerCase())) ?? targets[0] ?? "";
        if (!entity) continue;
        newTermsByEntity.set(entity, [...(newTermsByEntity.get(entity) ?? []), t]);
      }
    }

    // 5. Compare, per entity, with term-aware rules.
    const comparisons: Array<{
      entity: string;
      comparison: PriceComparison;
      effective: string | null;
      oldSource: string | null;
      newSource: string | null;
    }> = [];
    for (const entity of new Set([...oldTermsByEntity.keys(), ...newTermsByEntity.keys(), ...targets])) {
      // (display casing is resolved by displayName below)
      const oldTerm = (oldTermsByEntity.get(entity) ?? [])[0] ?? null;
      const newTerm = (newTermsByEntity.get(entity) ?? [])[0] ?? null;
      const comparison = comparePriceTerms(oldTerm, newTerm);
      const newDoc = newDocs.find((d) => newTerm && d.excerpt.includes(String(newTerm.amount)));
      const effective = newDoc ? this.effectiveDateFrom(newDoc.excerpt) : null;
      comparisons.push({
        entity,
        comparison,
        effective,
        oldSource: oldTerm?.sourceId ?? null,
        newSource: newTerm?.sourceId ?? null,
      });
    }

    // 6a. Nothing price-shaped? Then this is a claim re-check, not a comparison.
    //     "You told me it had free backups — still true?" is the same shape of
    //     question as a price change and deserves the same two-source treatment.
    const anyPriceData = comparisons.some((c) => c.comparison.oldTerm || c.comparison.newTerm);
    if (!anyPriceData) {
      const oldDoc = oldDocs[0] ?? null;
      const oldStatement =
        (referenced[0]?.assistant ?? "").trim() ||
        (oldDoc?.excerpt ?? "").trim() ||
        "(no earlier statement recorded)";
      const bestNew = this.bestExcerptFor(newResults, oldStatement);
      const verdict = bestNew
        ? await zodText(
            claimCheckPrompt({
              oldStatement,
              oldWhen: referenced[0] ? formatInZone(referenced[0].ts, tz) : "earlier",
              current: bestNew.summary,
            }),
            { schema: zClaimCheck, maxTokens: 220 },
          )
        : null;
      if (verdict) addUsage(usage, verdict.usage);

      const citations: Citation[] = [];
      const cite = (url: string, title: string, date: string | null) => {
        if (!url || citations.some((c) => c.url === url)) return;
        citations.push({
          id: citations.length + 1,
          url,
          title,
          domain: this.domainOf(url),
          date,
          authority: 3,
        });
      };
      if (oldDoc) cite(oldDoc.url, oldDoc.title, oldDoc.observedAt);
      if (bestNew) cite(bestNew.url, bestNew.title, bestNew.date);

      const status = verdict?.data.status ?? "unclear";
      const explanation =
        status === "supported"
          ? `The current source supports that: “${verdict!.data.quote}”`
          : status === "contradicted"
            ? `The current source contradicts that: “${verdict!.data.quote}”`
            : "The current evidence does not address it, so I cannot confirm it still holds.";
      const when = referenced[0] ? formatInZone(referenced[0].ts, tz) : "earlier";
      const answer =
        `On ${when} you were told: “${oldStatement}”\n\n` +
        `${bestNew ? `What I found now${bestNew.date ? ` (${bestNew.date.slice(0, 10)})` : ""}: “${bestNew.summary.slice(0, 400)}”\n\n` : "I could not retrieve a current source to check.\n\n"}` +
        `${explanation}${verdict?.data.explanation ? ` ${verdict.data.explanation}` : ""}`;

      return this.finish(conv, {
        intent: "historical_update",
        text: answer,
        openui: composeReport([
          composeAnswerCard({ body: answer, citations }),
          composeStatStrip([
            { label: "Check", value: status },
            { label: "Sources", value: String(citations.length) },
          ]),
          composeChips(["Check again", "Show the earlier exchange"]),
        ]),
        citations,
        usage,
        digest: null,
        facts: [],
        trace: { ...trace, outcome: `claim-${status}`, claimVerdict: verdict?.data ?? null },
        started,
        selectedTurnIds: referenced.map((t) => t.id),
        searchQueries: queries,
        evidenceTexts: [...oldDocs.map((d) => `${d.title}: ${d.excerpt}`), bestNew ? `${bestNew.title}: ${bestNew.summary}` : ""].filter(Boolean),
      });
    }

    // 5b. Changes that are not prices. "Any pricing changes or major releases?" is
    //     one question, and answering only the price half silently drops the rest.
    const CHANGE_EVENT =
      /\b(released?|launch(?:ed|es)?|introduc(?:ed|es)|added|ship(?:ped|s)|deprecat(?:ed|es)|retir(?:ed|es)|discontinu(?:ed|es)|renam(?:ed)|acquir(?:ed)|now (?:available|supports?)|general(?:ly)? available|end[- ]of[- ]life)\b/i;
    const events: Array<{ text: string; url: string; title: string; date: string | null }> = [];
    for (const doc of newDocs) {
      for (const sentence of doc.excerpt.split(/(?<=[.!?])\s+/)) {
        if (!CHANGE_EVENT.test(sentence)) continue;
        if (events.some((e) => e.text.toLowerCase() === sentence.trim().toLowerCase())) continue;
        events.push({ text: sentence.trim(), url: doc.url, title: doc.title, date: doc.observedAt });
        if (events.length >= 3) break;
      }
      if (events.length >= 3) break;
    }

    // 6. Answer. Deterministic, because this is arithmetic plus provenance.
    // A failed search changes what can honestly be claimed: the earlier state is
    // known, the current one is not.
    const answer =
      newResults.length === 0 && searchErrors.length > 0
        ? `I have your earlier exchange, but the current check failed (${searchErrors[0]}), so I cannot say whether the price has changed. ${
            comparisons.find((c) => c.comparison.oldTerm)
              ? `What I recorded earlier: ${comparisons
                  .filter((c) => c.comparison.oldTerm)
                  .map((c) => `${this.displayName(c.entity)} at ${formatTerm(c.comparison.oldTerm)}`)
                  .join("; ")}.`
              : ""
          }`.trim()
        : this.composeUpdateAnswer(comparisons, referenced, tz);
    let answerWithEvents = answer;
    trace.searchErrors = searchErrors.length ? searchErrors : undefined;
    const citations: Citation[] = [];
    const pushCitation = (id: string | null) => {
      if (!id) return;
      if (citations.some((c) => c.url === id)) return;
      const doc = [...oldDocs, ...newDocs].find((d) => d.id === id || d.url === id);
      citations.push({
        id: citations.length + 1,
        url: doc?.url ?? id,
        title: doc?.title ?? id,
        domain: this.domainOf(doc?.url ?? id),
        date: doc?.observedAt ?? null,
        authority: 3,
      });
    };
    for (const c of comparisons) {
      pushCitation(c.oldSource);
      pushCitation(c.newSource);
    }
    if (events.length > 0) {
      answerWithEvents +=
        "\n\nOther changes in the current evidence:\n" +
        events.map((e) => `- ${e.text}${e.date ? ` (${e.date.slice(0, 10)})` : ""}`).join("\n");
      for (const e of events) pushCitation(e.url);
    }

    const rows = comparisons.map((c) => ({
      label: this.displayName(c.entity),
      status:
        c.comparison.status === "changed"
          ? ("updated" as const)
          : c.comparison.status === "unchanged"
            ? ("unchanged" as const)
            : ("missing" as const),
      note:
        c.comparison.status === "incomparable"
          ? (c.comparison.reason ?? "not comparable")
          : c.comparison.status === "changed"
            ? `changed by ${c.comparison.deltaMonthly}${
                c.comparison.pctChange !== null ? ` (${c.comparison.pctChange > 0 ? "+" : ""}${c.comparison.pctChange}%)` : ""
              }`
            : "same value in both observations",
      from: formatTerm(c.comparison.oldTerm),
      to: formatTerm(c.comparison.newTerm),
      sourceIds: [c.oldSource, c.newSource].filter(Boolean) as string[],
    }));

    return this.finish(conv, {
      intent: "historical_update",
      text: answerWithEvents,
      openui: composeReport([
        composeChangeList("What changed since we last spoke", rows),
        composeAnswerCard({ body: answerWithEvents, citations }),
        composeChips(["Show the earlier exchange", "Check another vendor"]),
      ]),
      citations,
      usage,
      digest: null,
      facts: [],
      trace: {
        ...trace,
        outcome: "compared",
        comparisons: comparisons.map((c) => ({
          entity: c.entity,
          status: c.comparison.status,
          old: formatTerm(c.comparison.oldTerm),
          new: formatTerm(c.comparison.newTerm),
          delta: c.comparison.deltaMonthly,
          effective: c.effective,
        })),
      },
      started,
      selectedTurnIds: referenced.map((t) => t.id),
      searchQueries: queries,
      evidenceTexts: [...oldDocs.map((d) => `${d.title}: ${d.excerpt}`), ...newDocs.map((d) => `${d.title}: ${d.excerpt.slice(0, 600)}`)],
    });
  }

  // -- history helpers ---------------------------------------------------

  /** Turns whose text overlaps the question, for questions with no date. */
  private selectTurnsByText(text: string): ImportedTurn[] {
    const all = this.store.importedTurns();
    if (all.length === 0) return [];
    const q = new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
    );
    // Commitment vocabulary is its own signal: "promised", "deadline" and
    // "outstanding" rarely appear in the transcript but describe what it records.
    const commitment = COMMITMENT_OWNERSHIP.test(text);
    const COMMIT_WORDS = /\b(promise[ds]?|deadline|deliverable|due|send|send\s+you|told|will|owed|outstanding|pending)\b/i;
    const scored = all
      .map((t) => {
        const hay = `${t.user} ${t.assistant} ${t.evidence.map((e) => e.excerpt).join(" ")}`.toLowerCase();
        let score = 0;
        for (const term of q) if (hay.includes(term)) score += 1;
        if (commitment && COMMIT_WORDS.test(t.user)) score += 2;
        return { turn: t, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.turn.ts - a.turn.ts);
    // A commitment spans a thread: the promise and the later update are usually in
    // different turns of the same thread, and answering "still outstanding?" needs
    // both. Rank threads by their best turn, then return the thread's turns.
    const byThread = new Map<string, { best: number; turns: ImportedTurn[] }>();
    for (const { turn, score } of scored) {
      const entry = byThread.get(turn.threadId) ?? { best: 0, turns: [] };
      entry.best = Math.max(entry.best, score);
      entry.turns.push(turn);
      byThread.set(turn.threadId, entry);
    }
    const topThreadIds = [...byThread.entries()]
      .sort((a, b) => b[1].best - a[1].best)
      .slice(0, 2)
      .map(([id]) => id);
    // Take every turn in the chosen threads, not only the ones that matched: the
    // update that answers "still outstanding?" ("Sent Leena the diagram. Still need
    // to do the examples.") often shares no vocabulary with the question.
    const picked = all
      .filter((t) => topThreadIds.includes(t.threadId))
      .sort((a, b) => a.ts - b.ts)
      .slice(0, 6);
    return picked;
  }

  /** Quote the selected turns, oldest first, in the user's zone. */
  private quoteTurns(turns: ImportedTurn[], tz: string): string {
    const sorted = [...turns].sort((a, b) => a.ts - b.ts);
    const lines = sorted.map((t) => {
      const when = formatInZone(t.ts, tz);
      const said = t.user.trim().replace(/\s+/g, " ");
      const replied = t.assistant.trim().replace(/\s+/g, " ");
      return `On ${when} (${tz}) you said: “${said}”\n  I replied: “${replied}”`;
    });
    return `From your history:\n${lines.join("\n")}`;
  }

  /**
   * The latest status each subject was left in.
   *
   * "Access review is done. Changelog is still pending." answers "what is still
   * open?" only if the later mention wins — so subjects are keyed by their content
   * words and the newest clause replaces the older one.
   */
  private latestStatusClauses(turns: ImportedTurn[]): string[] {
    const STATUS = /\b(done|completed|finished|closed|resolved|pending|open|blocked|still|in progress|remaining)\b/i;
    const latest = new Map<string, { clause: string; ts: number }>();
    for (const turn of [...turns].sort((a, b) => a.ts - b.ts)) {
      for (const clause of turn.user.split(/(?<=[.!?;])\s+|\s*;\s*/g)) {
        const c = clause.trim();
        if (!c || !STATUS.test(c)) continue;
        const subject = c
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((w) => w.length > 2 && !STOPWORDS.has(w) && !STATUS.test(w))
          .slice(0, 2)
          .join(" ");
        if (!subject) continue;
        latest.set(subject, { clause: c, ts: turn.ts });
      }
    }
    return [...latest.values()]
      .sort((a, b) => b.ts - a.ts)
      .map((v) => v.clause.replace(/[.;]+$/, ""));
  }

  private citationsForTurns(turns: ImportedTurn[]): Citation[] {
    const out: Citation[] = [];
    for (const t of turns) {
      for (const doc of t.evidence) {
        if (out.some((c) => c.url === doc.url)) continue;
        out.push({
          id: out.length + 1,
          url: doc.url,
          title: doc.title,
          domain: this.domainOf(doc.url),
          date: doc.observedAt,
          authority: 3,
        });
      }
    }
    return out;
  }

  /** Which entity a piece of evidence is about, from its aliases or its title. */
  private entityForDoc(doc: EvidenceDoc | null, fallbackText = ""): string {
    if (doc?.aliases?.length) return doc.aliases[0]!;
    const named = doc?.title?.split(/\s+/)[0];
    if (named) return named.toLowerCase();
    return this.entitiesFromText(fallbackText)[0] ?? "";
  }

  private entitiesFromText(text: string): string[] {
    const caps = text.match(/\b[A-Z][A-Za-z0-9]{2,}\b/g) ?? [];
    return [...new Set(caps.filter((c) => !STOPWORDS.has(c.toLowerCase())).map((c) => c.toLowerCase()))];
  }

  /**
   * Present an entity the way it was written. Aliases are lowercased search keys,
   * so a naive title-case turns "terndb" into "Terndb", which reads like a typo of
   * the product the user is asking about.
   */
  private displayName(entity: string): string {
    if (!entity) return "";
    const known = this.displayNames.get(entity.toLowerCase());
    if (known) return known;
    if (/[A-Z]/.test(entity)) return entity;
    return entity.length <= 3 ? entity.toUpperCase() : entity[0]!.toUpperCase() + entity.slice(1);
  }

  /** Display casing captured while collecting entities for this turn. */
  private displayNames = new Map<string, string>();

  private effectiveDateFrom(text: string): string | null {
    const m = /\btook effect on ([A-Z][a-z]+ \d{1,2}(?:,? \d{4})?)\b/i.exec(text) ??
      /\beffective (?:from |on )?([A-Z][a-z]+ \d{1,2}(?:,? \d{4})?)\b/i.exec(text);
    return m ? m[1]! : null;
  }

  /**
   * Append any billing qualifier the evidence states but the answer drops.
   *
   * This exists because "$21 per seat per month, annual commitment, 20-seat
   * minimum" and "$21 per month" are the same number and different products, and a
   * small model reliably keeps the number while losing the terms.
   */
  private billingTermsGuard(digestDigest: ReturnType<typeof buildDigest>, answer: string): string | null {
    const terms: Array<{ term: PriceTerm; citationId: number }> = [];
    for (const [citationId, clauses] of digestDigest.evidenceByCitation) {
      for (const term of parsePriceTerms(clauses.join(" "), String(citationId))) {
        terms.push({ term, citationId });
      }
    }
    if (terms.length === 0) return null;

    // Prefer a term whose amount the answer actually used.
    const chosen =
      terms.find((t) => new RegExp(`\\b${t.term.amount}\\b`).test(answer)) ?? terms[0]!;
    const { term, citationId } = chosen;

    const missing: string[] = [];
    if (term.billing === "annual" && !/annual/i.test(answer)) missing.push("annual commitment");
    if (term.billing === "monthly" && !/(monthly|month-to-month|month to month)/i.test(answer)) {
      missing.push("monthly billing");
    }
    if (term.unit === "seat" && !/seat/i.test(answer)) missing.push("per seat");
    if (term.minSeats !== null && !new RegExp(`\\b${term.minSeats}\\b`).test(answer)) {
      missing.push(`${term.minSeats}-seat minimum`);
    }
    if (missing.length === 0) return null;
    return `Billing terms: ${formatTerm(term)} [${citationId}].`;
  }

  /**
   * Retrieve a company's own pages when the question asks for them.
   *
   * This closes a real hole: the search index can be missing an official site
   * entirely — `site:projectminimi.com` returns nothing — while the provider's
   * Fetch endpoint returns the page fine. A search-only agent is then stuck
   * answering from third-party summaries of the company it was asked to cite.
   *
   * The model still has one tool. This is how that tool resolves "cite their
   * privacy page": derive the likely origin from the brand name, verify by fetching,
   * and keep only pages whose content is actually about the question.
   */
  private async officialGrounding(question: string): Promise<SearchResult[]> {
    if (config.offline) return [];
    const OFFICIAL_CUE =
      /\b(official|the company (?:says|describes|explains|reports)|according to (?:their|the company)|cite|privacy explanation|about page|hiring listing|their (?:site|page|privacy)|(?:says|claims|reports|states)|how does (?:it|the \w+) (?:read|work|do))\b/i;
    // A named brand plus an attribution cue is enough. Questions about a company's
    // own claims are the ones whose best source is the company's own page.
    const hasBrand = /\b[A-Z][A-Za-z0-9]+\s+[A-Z][A-Za-z0-9]+\b/.test(question);
    if (!OFFICIAL_CUE.test(question) && !hasBrand) return [];

    // Longest capitalised run, with any leading interrogative or verb stripped.
    // A capitalised run spans sentence-initial verbs too: "Does Project Minimi say
    // …" yields the run "Does Project Minimi", from which the naive domain
    // "doesprojectminimi.com" follows. Strip the leading verbs before slugging.
    const LEADING = /^(does|do|did|is|are|was|were|can|could|would|should|will|has|have|had|use|look|find|cite|tell|show|give|who|what|where|when|why|how|the|a|an|and|or|of|in|on|at|to|for|with|my|i)$/i;
    const runs = question.match(/\b[A-Z][A-Za-z0-9]*(?:\s+[A-Z][A-Za-z0-9]*)*\b/g) ?? [];
    const brand = runs
      .map((r) => {
        const words = r.trim().split(/\s+/);
        while (words.length > 0 && LEADING.test(words[0]!)) words.shift();
        return words.join(" ").replace(/['’]s\b/, "");
      })
      .filter((r) => r.length >= 3 && !LEADING.test(r))
      .sort((a, b) => b.split(/\s+/).length - a.split(/\s+/).length)[0];
    if (!brand) return [];

    const words = brand.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
    const descriptors = new Set(["project", "the", "inc", "labs", "ai", "app", "hq"]);
    const slugs = [...new Set([words.join(""), words.filter((w) => !descriptors.has(w)).join("")])].filter(
      (slug) => slug.length >= 3,
    );
    if (slugs.length === 0) return [];

    const wantsAbout = /\b(about|mascot|inspired|inspiration|team|story|who (?:runs|founded))\b/i.test(question);
    const wantsMemory = /\b(memory|remember|cotton|melody|screenshot|privacy|embedding|accurate|benchmark|stored)\b/i.test(question);
    const paths = wantsAbout ? ["/about", "/"] : wantsMemory ? ["/memory", "/"] : ["/", "/about"];

    const candidates: string[] = [];
    for (const slug of slugs.slice(0, 2)) {
      for (const tld of ["com", "ai"]) {
        const host = `https://www.${slug}.${tld}`;
        for (const path of paths) candidates.push(`${host}${path}`);
      }
    }

    const q = new Set(canonTerms(question).filter((t) => t.length > 3));
    const kept: SearchResult[] = [];
    for (const url of candidates.slice(0, 6)) {
      try {
        const page = await this.fetchPage(url);
        if (!page.content || page.content.length < 200) continue;
        const terms = new Set(canonTerms(page.content));
        let overlap = 0;
        for (const t of q) if (terms.has(t)) overlap++;
        // A same-named but unrelated site is the failure mode here, so require the
        // page to share vocabulary with the question before treating it as evidence.
        if (q.size > 0 && overlap / q.size < 0.1) continue;
        if (kept.some((k) => k.url === url)) continue;
        kept.push({
          title: page.title || url,
          url,
          snippet: page.content.slice(0, 180),
          summary: page.content.slice(0, 4000),
          date: null,
          authority: 4,
          rerankScore: 3.5,
          siteName: this.domainOf(url),
        });
      } catch {
        // A guessed domain that does not resolve is the common case; keep going.
      }
    }
    return kept;
  }

  /** Pick the retrieved result that best matches the claim being re-checked. */
  private bestExcerptFor(
    results: Array<{ title: string; url: string; summary: string; date: string | null }>,
    statement: string,
  ) {
    if (results.length === 0) return null;
    const terms = new Set(canonTerms(statement).filter((t) => t.length > 3));
    let best = results[0]!;
    let bestScore = -1;
    for (const r of results) {
      const rt = new Set(canonTerms(`${r.title} ${r.summary}`));
      let score = 0;
      for (const t of terms) if (rt.has(t)) score++;
      if (score > bestScore) {
        bestScore = score;
        best = r;
      }
    }
    return best;
  }

  private domainOf(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  }

  /** Build the comparison answer. Every number here comes from a parsed term. */
  private composeUpdateAnswer(
    comparisons: Array<{
      entity: string;
      comparison: PriceComparison;
      effective: string | null;
      oldSource: string | null;
      newSource: string | null;
    }>,
    referenced: ImportedTurn[],
    tz: string,
  ): string {
    if (comparisons.length === 0) {
      return "I could not find an earlier exchange with a price in it to compare against.";
    }
    const since = referenced.length
      ? formatInZone(Math.max(...referenced.map((t) => t.ts)), tz)
      : "our earlier exchange";
    const lines: string[] = [];
    for (const c of comparisons) {
      const name = this.displayName(c.entity);
      const { comparison } = c;
      if (comparison.status === "incomparable") {
        if (!comparison.oldTerm && comparison.newTerm) {
          lines.push(
            `${name}: the current page lists ${formatTerm(comparison.newTerm)}, but no earlier price was recorded, so whether it changed cannot be verified.`,
          );
        } else if (comparison.oldTerm && !comparison.newTerm) {
          lines.push(
            `${name}: I recorded ${formatTerm(comparison.oldTerm)} earlier, but I could not establish a current price, so I cannot say whether it changed.`,
          );
        } else if (comparison.oldTerm && comparison.newTerm) {
          lines.push(
            `${name}: ${formatTerm(comparison.oldTerm)} earlier versus ${formatTerm(comparison.newTerm)} now. These are not directly comparable — ${comparison.reason} — so this is not a price change.`,
          );
        } else {
          lines.push(`${name}: no price was recorded earlier or found now.`);
        }
        continue;
      }
      if (comparison.status === "changed") {
        const sign = (comparison.deltaMonthly ?? 0) > 0 ? "+" : "";
        const pct =
          comparison.pctChange !== null
            ? ` (${sign}${comparison.pctChange}%)`
            : "";
        lines.push(
          `${name}: ${formatTerm(comparison.oldTerm)} on ${since} → ${formatTerm(comparison.newTerm)} now, a change of ${sign}${comparison.deltaMonthly} per month${pct} on comparable terms.`,
        );
        if (c.effective) lines.push(`The change took effect on ${c.effective}.`);
        continue;
      }
      lines.push(
        `${name}: ${formatTerm(comparison.newTerm)} in both observations — ${since} and now. No change was observed between those two observations; that does not rule out a change in between, since only those two snapshots were checked.`,
      );
    }
    return lines.join("\n\n");
  }

  private async change(ctx: {
    conv: ConversationRow;
    text: string;
    tz: string;
    usage: Usage;
    trace: Record<string, unknown>;
    started: number;
    shortlists: Array<{ id: string; name: string; itemCount?: number }>;
  }): Promise<AgentReply> {
    const { conv, text, tz, usage, trace, started, shortlists } = ctx;

    // Creation language, or no shortlist exists yet → build one and capture a
    // baseline. "Track X" on its own has nothing to compare against.
    const wantsCreate = /(track|watch|shortlist|monitor|keep an eye)/i.test(text) && shortlists.length === 0;
    let target = shortlists[0];
    if (!wantsCreate && shortlists.length > 0) {
      const byName = shortlists.find((s) => text.toLowerCase().includes(s.name.toLowerCase()));
      target = byName ?? shortlists[0];
    }

    // Nothing tracked and the user did not name anything to track: ask, rather than
    // creating a list from the words "what changed?".
    const namesSomething = /(track|watch|monitor|keep an eye|price|pricing|cost|release|version|status)/i.test(text);
    if (!target && !namesSomething && !wantsCreate) {
      const answer =
        "Nothing is being tracked yet, so there is no earlier state to compare against. " +
        "Tell me what to watch — for example “track the pricing of AI coding agents” — and I will record a baseline, then re-check it whenever you ask.";
      return this.finish(conv, {
        intent: "clarify",
        text: answer,
        openui: composeReport([composeNote(answer), composeChips(["Track AI coding agent pricing", "Track something else"])]),
        citations: [],
        usage,
        digest: null,
        facts: [],
        trace: { ...trace, outcome: "clarify-no-shortlist" },
        started,
        searchQueries: [],
      });
    }

    if (wantsCreate || !target) {
      const created = await createShortlist(this.store, {
        request: text,
        tz,
        conversationId: conv.id,
        today: formatInZone(started, tz),
      });
      addUsage(usage, created.usage);
      trace.changed = { created: true, id: created.id, items: created.items.length };

      const rows = created.items.map((i) => ({
        label: i.label,
        status: "new" as const,
        note: "baseline captured — future checks diff against this",
        from: "",
        to: "",
        sourceIds: [] as number[],
      }));
      return this.finish(conv, {
        intent: "change",
        text: `Tracking ${created.items.length} items in "${created.name}".`,
        openui: composeReport([
          composeChangeList(`Shortlist created: ${created.name}`, rows),
          composeNote(
            "Baselines captured. Ask \"what changed?\" any time and every item will be re-checked in parallel.",
          ),
          composeChips(["What changed?", "Add another item", "Drop an item"]),
        ]),
        citations: [],
        usage,
        digest: null,
        facts: [],
        trace: { ...trace, outcome: "created" },
        started,
      });
    }

    // Reuse a run that just finished, unless the user explicitly asked to check
    // again. The sidebar's "re-check" button runs a check and then the user reads
    // the result; without this, narrating would trigger a *second* full check,
    // doubling both the spend and the latency, and the second check would report
    // "no change" because the first had already advanced the baselines.
    const explicitRecheck = /(re-?check|refresh|check now|run (it|the check) again|update (it|the list))/i.test(
      text,
    );
    const freshRun =
      explicitRecheck ? null : this.latestCompletedRun(target.id, 15 * 60 * 1000);

    let runMeta: { runId: string; shortlistName: string; since: number; latencyMs: number; items: ItemView[] };
    let digestRatios: number[] = [];

    if (freshRun) {
      runMeta = {
        runId: freshRun.runId,
        shortlistName: freshRun.shortlistName,
        since: freshRun.since,
        latencyMs: 0,
        items: freshRun.items,
      };
      digestRatios = freshRun.digestRatios;
      trace.changed = {
        reused: true,
        runId: freshRun.runId,
        items: runMeta.items.length,
        changes: runMeta.items.flatMap((i) =>
          i.changes
            .filter((c) => c.kind === "updated" || c.kind === "new")
            .map((c) => ({
              label: i.label,
              kind: c.kind,
              entity: c.entity,
              attribute: c.attribute,
              from: c.from?.value ?? null,
              to: c.to?.value ?? null,
              citationIds: c.citationIds,
            })),
        ),
      };
    } else {
      const run: RecheckResult = await recheckShortlist(this.store, {
        shortlistId: target.id,
        tz,
      });
      addUsage(usage, run.usage);
      runMeta = {
        runId: run.runId,
        shortlistName: run.shortlistName,
        since: run.since,
        latencyMs: run.latencyMs,
        items: run.items.map((i) => ({
          label: i.label,
          status: (i.status === "failed" ? "missing" : i.status) as ItemView["status"],
          changes: i.changes,
          citations: i.citations,
          evidence: i.evidence,
          error: i.error,
        })),
      };
      digestRatios = run.items.map((i) => i.digestRatio);
      trace.changed = {
        runId: run.runId,
        shortlist: run.shortlistName,
        items: run.items.length,
        statuses: run.items.map((i) => ({ label: i.label, status: i.status })),
        changes: run.items.flatMap((i) =>
          i.changes.map((c) => ({
            label: i.label,
            kind: c.kind,
            entity: c.entity,
            attribute: c.attribute,
            from: c.from?.value ?? null,
            to: c.to?.value ?? null,
            citationIds: c.citationIds,
          })),
        ),
        digestRatios,
      };
    }

    const rows = runMeta.items.map((item) => {
      const primary =
        item.changes.find((c) => c.kind === "updated") ?? item.changes.find((c) => c.kind === "new");
      const from = primary?.from?.value ?? "";
      const to = primary?.to?.value ?? "";
      const note =
        item.status === "updated"
          ? `${primary?.attribute ?? "value"} changed`
          : item.status === "new"
            ? `new ${primary?.attribute ?? "value"} found`
            : item.status === "unchanged"
              ? "no change found"
              : item.status === "missing"
                ? "could not re-confirm"
                : (item.error ?? "check failed");
      return {
        label: item.label,
        status: item.status,
        note,
        from,
        to,
        sourceIds: primary?.citationIds ?? item.citations.slice(0, 1).map((c) => c.id),
      };
    });

    const changedCount = rows.filter((r) => r.status === "updated").length;
    const evidenceLines = runMeta.items
      .map((i) => ({
        label: i.label,
        status: i.status,
        from: i.changes.find((c) => c.kind === "updated")?.from?.value ?? "",
        to: i.changes.find((c) => c.kind === "updated")?.to?.value ?? "",
        evidence: i.evidence || "(no supporting sentence retained)",
      }))
      .slice(0, 16);

    const narration = await prose(
      changeNarrationPrompt({
        shortlist: runMeta.shortlistName,
        since: formatInZone(runMeta.since, tz),
        rows: evidenceLines,
      }),
      { maxTokens: 260, temperature: 0.2, stage: "change_narration" },
    );
    addUsage(usage, narration.usage);

    const allCitations = this.dedupeCitations(runMeta.items.flatMap((i) => i.citations));
    const avgRatio = digestRatios.length
      ? digestRatios.reduce((n, r) => n + (r || 0), 0) / digestRatios.length
      : 0;

    return this.finish(conv, {
      intent: "change",
      text: narration.text,
      openui: composeReport([
        composeChangeList(`What changed · ${runMeta.shortlistName}`, rows),
        composeNote(narration.text),
        composeStatStrip([
          { label: "Items checked", value: String(runMeta.items.length), hint: "in parallel" },
          { label: "Changed", value: String(changedCount) },
          {
            label: freshRun ? "From" : "Latency",
            value: freshRun ? "last check" : `${(runMeta.latencyMs / 1000).toFixed(1)}s`,
          },
          { label: "Digest", value: `${Math.round((1 - avgRatio) * 100)}% smaller`, hint: "vs raw" },
        ]),
        composeChips(["Re-check now", "Explain the biggest change", "Export this list"]),
      ]),
      citations: allCitations,
      usage,
      digest: null,
      facts: [],
      trace: { ...trace, outcome: "rechecked" },
      started,
    });
  }

  // ---------------------------------------------------------------------
  // chat
  // ---------------------------------------------------------------------

  private async chat(ctx: {
    conv: ConversationRow;
    text: string;
    tz: string;
    usage: Usage;
    trace: Record<string, unknown>;
    started: number;
  }): Promise<AgentReply> {
    const { conv, text, tz, usage, trace, started } = ctx;
    const reply = await prose(
      `Reply to the user in one or two sentences. You are a research assistant with one tool, web search. Do not search for this.

<<<${text}>>>`,
      { maxTokens: 200, temperature: 0.4, lean: true, stage: "chat" },
    );
    addUsage(usage, reply.usage);
    return this.finish(conv, {
      intent: "chat",
      text: reply.text,
      openui: composeReport([
        composeNote(reply.text),
        composeChips(["Search something for me", "Make a shortlist to track", "Show yesterday's conversations"]),
      ]),
      citations: [],
      usage,
      digest: null,
      facts: [],
      trace: { ...trace, outcome: "chat" },
      started,
    });
  }

  // ---------------------------------------------------------------------
  // memory
  // ---------------------------------------------------------------------

  private async rememberUserFacts(args: {
    text: string;
    tz: string;
    conversationId: string;
    usage: Usage;
    trace: Record<string, unknown>;
  }): Promise<void> {
    // Cheap gate: only messages that talk about the user are worth a call.
    const firstPerson = /\b(i am|i'm|i live|i work|my |mine|i prefer|i like|i use|we use|our )\b/i.test(args.text);
    if (!firstPerson) return;
    try {
      const res = await zodText(memoryPrompt(args.text), {
        schema: zMemory,
        maxTokens: 300,
        lean: true,
      });
      addUsage(args.usage, res.usage);
      for (const f of res.data.facts.slice(0, 8)) {
        this.store.upsertMemory({
          conversationId: args.conversationId,
          entity: f.entity.slice(0, 80),
          attribute: f.attribute.slice(0, 60),
          value: f.value.slice(0, 200),
          kind: f.kind,
          source: "user",
          url: null,
          observedAt: Date.now(),
          tz: args.tz,
        });
      }
      args.trace.memoryFacts = res.data.facts.length;
    } catch (err) {
      args.trace.memoryError = String(err);
    }
  }

  // ---------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------

  private finish(
    conv: ConversationRow,
    args: {
      intent: AgentReply["intent"];
      text: string;
      openui: string;
      citations: Citation[];
      usage: Usage;
      digest: DigestStats | null;
      facts: Fact[];
      trace: Record<string, unknown>;
      started: number;
      selectedTurnIds?: string[];
      searchQueries?: string[];
      evidenceTexts?: string[];
    },
  ): AgentReply {
    // Guardrail: a document that does not parse never leaves the server.
    const validation = validateLang(args.openui);
    let openui = args.openui;
    let text = args.text;
    if (!validation.ok) {
      openui = composeReport([
        composeNote(text || "The answer could not be laid out, but here it is as text."),
      ]);
      text = `${text}\n\n(UI note: the generated layout failed validation: ${validation.errors
        .slice(0, 2)
        .join("; ")})`;
    }

    const createdAt = Date.now();
    const saveStep = step(RUN_NAMES.save, { conversation: conv.id, intent: args.intent });
    this.store.addMessage({
      conversationId: conv.id,
      role: "assistant",
      content: text,
      openuiLang: openui,
      citations: args.citations,
      digestStats: args.digest
        ? {
            inputTokens: args.digest.inputTokens,
            digestTokens: args.digest.digestTokens,
            ratio: args.digest.ratio,
            factsExtracted: args.digest.factsExtracted,
            duplicatesRemoved: args.digest.duplicatesRemoved,
          }
        : null,
      usage: args.usage,
      createdAt,
    });

    saveStep.end({ citations: args.citations.length, ui_chars: openui.length, text_chars: text.length });
    return {
      conversationId: conv.id,
      intent: args.intent,
      text,
      openui,
      citations: args.citations,
      usage: args.usage,
      digest: args.digest,
      latencyMs: 0,
      createdAt,
      facts: args.facts,
      trace: { ...args.trace, uiValidation: validation.ok },
      selectedTurnIds: args.selectedTurnIds ?? [],
      searchQueries: args.searchQueries ?? [],
      evidenceTexts: args.evidenceTexts ?? [],
    };
  }

  /**
   * The newest completed run for a shortlist within `maxAgeMs`, reconstructed from
   * its persisted items. Reusing it is what keeps "what changed?" from paying for a
   * second identical check.
   */
  private latestCompletedRun(
    shortlistId: string,
    maxAgeMs: number,
  ):
    | {
        runId: string;
        shortlistName: string;
        since: number;
        items: ItemView[];
        digestRatios: number[];
      }
    | null {
    const run = this.store
      .listRuns(20)
      .find(
        (r) =>
          r.shortlistId === shortlistId &&
          (r.status === "done" || r.status === "partial") &&
          r.finishedAt !== null &&
          Date.now() - r.finishedAt <= maxAgeMs,
      );
    if (!run) return null;
    const full = this.store.getRun(run.id);
    if (!full) return null;
    const shortlist = this.store.getShortlist(shortlistId);
    const items = full.items
      .filter((i) => i.status === "done")
      .map((i) => {
        const changes = (i.changes as Array<Record<string, unknown>>).map((c) => c as unknown as FactChange);
        const meaningful = changes.filter((c) => c.kind === "updated" || c.kind === "new");
        return {
          label: this.labelFor(shortlistId, i.itemId),
          status: (meaningful.some((c) => c.kind === "updated")
            ? "updated"
            : meaningful.length > 0
              ? "new"
              : changes.length > 0
                ? "unchanged"
                : "missing") as ItemView["status"],
          changes,
          citations: i.citations,
          evidence: meaningful
            .slice(0, 3)
            .map((c) => `[${c.citationIds[0]}] ${c.to?.evidence ?? ""}`)
            .join(" ")
            .slice(0, 400),
          error: i.error,
        };
      });
    return {
      runId: run.id,
      shortlistName: shortlist?.name ?? "shortlist",
      since: run.createdAt,
      items,
      digestRatios: full.items.map((i) => i.digestRatio ?? 0),
    };
  }

  private labelFor(shortlistId: string, itemId: string): string {
    const sl = this.store.getShortlist(shortlistId);
    return sl?.items.find((i) => i.id === itemId)?.label ?? itemId.slice(0, 8);
  }

  private dedupeCitations(cites: Citation[]): Citation[] {
    const byUrl = new Map<string, Citation>();
    for (const c of cites) if (!byUrl.has(c.url)) byUrl.set(c.url, c);
    return [...byUrl.values()];
  }

  private parseCitations(text: string, citations: Citation[]): { used: number[]; invalid: number[] } {
    const valid = new Set(citations.map((c) => c.id));
    const used = new Set<number>();
    const invalid = new Set<number>();
    for (const m of text.matchAll(/\[(\d{1,2})\]/g)) {
      const id = Number(m[1]);
      if (valid.has(id)) used.add(id);
      else invalid.add(id);
    }
    return { used: [...used].sort((a, b) => a - b), invalid: [...invalid] };
  }

  /** Remove citation markers that do not correspond to a retrieved source. */
  private stripInvalidCitations(text: string, citations: Citation[]): string {
    const valid = new Set(citations.map((c) => c.id));
    return text.replace(/\[(\d{1,2})\]/g, (all, n: string) => (valid.has(Number(n)) ? all : ""));
  }

  /** A deterministic day window, exposed for tests and the eval harness. */
  today(tz: string): string {
    return dayRange(Date.now(), tz).isoDate;
  }

  newConversationId(): string {
    return randomUUID();
  }
}

/**
 * Decide, without a model, whether retrieved evidence is usable.
 *
 * Lexical and ranked, because the whole point is to run it *before* spending a
 * generation. The overlap is an overlap coefficient rather than a Jaccard score
 * against the query: a question phrased as "what does X imply for Y" contains
 * words no relevant page will repeat, and dividing by the full query lets one
 * unmatched function word veto a perfect hit.
 */
export function relevanceGate(
  question: string,
  results: Array<{ title: string; summary: string; rerankScore: number }>,
): { usable: boolean; reason: string; bestRerank: number; bestOverlap: number } {
  if (results.length === 0) {
    return { usable: false, reason: "no-results", bestRerank: 0, bestOverlap: 0 };
  }
  const bestRerank = Math.max(...results.map((r) => r.rerankScore));
  const q = new Set(canonTerms(question).filter((t) => t.length > 3));
  let bestOverlap = 0;
  for (const r of results) {
    const rt = new Set(canonTerms(`${r.title} ${r.summary}`));
    if (q.size === 0 || rt.size === 0) continue;
    bestOverlap = Math.max(bestOverlap, [...q].filter((t) => rt.has(t)).length / Math.min(q.size, rt.size));
  }
  const rankOk = bestRerank >= 1.0;
  const overlapOk = q.size === 0 || bestOverlap >= 0.15;
  return {
    usable: rankOk && overlapOk,
    reason: !rankOk ? "low-rank" : !overlapOk ? "low-overlap" : "ok",
    bestRerank,
    bestOverlap,
  };
}

const zPlan = z.object({
  queries: z.array(z.string().min(1).max(140)).min(1).max(3),
  checklist: z.array(z.string().max(160)).max(4).default([]),
  recency: z.boolean().default(false),
});

const zClaimCheck = z.object({
  status: z.enum(["supported", "contradicted", "unclear"]),
  explanation: z.string().max(300).default(""),
  quote: z.string().max(400).default(""),
});

const zMemory = z.object({
  facts: z
    .array(
      z.object({
        entity: z.string().min(1).max(80),
        attribute: z.string().min(1).max(60),
        value: z.string().min(1).max(200),
        kind: z.enum(["name", "preference", "project", "constraint", "date", "other"]).default("other"),
      }),
    )
    .max(8)
    .default([]),
});
