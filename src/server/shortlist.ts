/**
 * Shortlists: a set of things the user asked to watch, re-checked in parallel.
 *
 * The important design decisions:
 *
 * 1. **Durable and resumable.** A run is a first-class row with per-item rows.
 *    If the process dies mid-run, resuming picks up only the items that were not
 *    finished, instead of re-paying for all of them. This matters because a
 *    re-check is the most expensive routine action in the product.
 * 2. **Parallel, but bounded.** Items are independent so they fan out; the
 *    limiter keeps the burst under the search API's account-level QPS so we get
 *    throughput instead of 429s and retries.
 * 3. **Diffs are deterministic.** The model never decides what changed. It diffs
 *    nothing, compares nothing, and cannot invent a change. It receives the
 *    computed diff and writes one summary sentence. That separation is what makes
 *    "cite evidence for what changed" trustworthy: the citation attached to a
 *    change comes from the fact row, not from prose.
 * 4. **Baselines advance only on success.** A failed item keeps its old baseline,
 *    so the next run still has something meaningful to compare against.
 */

import { randomUUID } from "node:crypto";
import { zodText } from "./structured.js";
import { webSearch } from "./deepseek.js";
import { buildDigest, diffFacts, type Citation, type Fact, type FactChange } from "./digest.js";
import { shortlistPrompt } from "./prompts.js";
import { chat } from "./deepseek.js";
import { emptyUsage, addUsage, logDebug, type Usage } from "./config.js";
import type { Store, ShortlistItemRow, RunRow } from "./memory.js";

export interface RecheckItemResult {
  itemId: string;
  label: string;
  status: "updated" | "new" | "unchanged" | "missing" | "failed";
  changes: FactChange[];
  citations: Citation[];
  evidence: string;
  error: string | null;
  digestRatio: number;
  usage: Usage;
}

export interface RecheckResult {
  runId: string;
  shortlistId: string;
  shortlistName: string;
  since: number;
  items: RecheckItemResult[];
  usage: Usage;
  latencyMs: number;
}

export type ProgressEvent =
  | { type: "run_started"; runId: string; shortlistId: string; total: number }
  | { type: "item_done"; runId: string; itemId: string; label: string; index: number; total: number; status: string }
  | { type: "run_finished"; runId: string; done: number; failed: number };

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreatedShortlist {
  id: string;
  name: string;
  items: Array<{ id: string; label: string; query: string }>;
  usage: Usage;
}

/**
 * Turn a natural-language request into a shortlist and capture the first baseline.
 *
 * The baseline capture runs the same digests a re-check will, so the two snapshots
 * are produced by identical code. If baseline and re-check used different extraction
 * they would disagree for reasons that have nothing to do with the world.
 */
export async function createShortlist(
  store: Store,
  args: { request: string; tz: string; conversationId: string | null; today: string },
): Promise<CreatedShortlist> {
  const usage = emptyUsage();
  const spec = await zodText(
    shortlistPrompt({ request: args.request, today: args.today }),
    {
      schema: z_shortlist,
      maxTokens: 700,
    },
  );
  addUsage(usage, spec.usage);

  const id = randomUUID();
  store.createShortlist({
    id,
    conversationId: args.conversationId,
    name: spec.data.name.slice(0, 80) || "Tracked items",
    tz: args.tz,
  });

  const items: Array<{ id: string; label: string; query: string }> = [];
  const seen = new Set<string>();
  for (const item of spec.data.items.slice(0, 12)) {
    const label = item.label.trim().slice(0, 60);
    const query = item.query.trim().slice(0, 120);
    if (!label || !query || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    const itemId = randomUUID();
    store.addShortlistItem({
      id: itemId,
      shortlistId: id,
      label,
      query,
      baselineFacts: [],
      baselineCitations: [],
    });
    items.push({ id: itemId, label, query });
  }

  // Capture baselines in parallel, sharing one limiter with re-checks.
  const captures = await Promise.all(
    items.map(async (item) => {
      const capture = await captureBaseline(item.query, item.label, args.tz);
      return { item, capture };
    }),
  );
  for (const { item, capture } of captures) {
    addUsage(usage, capture.usage);
    if (capture.error) {
      logDebug("baseline failed", item.label, capture.error);
      continue;
    }
    store.updateItemBaseline(item.id, capture.facts, capture.citations, "baseline");
  }

  return { id, name: spec.data.name, items, usage };
}

interface Capture {
  facts: Fact[];
  citations: Citation[];
  usage: Usage;
  error: string | null;
  digestRatio: number;
}

/**
 * Capture the values a future re-check will diff against.
 *
 * This must use exactly the same digest settings as `recheckItem`, including the
 * subject gate. They originally differed, and the effect was not a small error:
 * the baseline picked up values belonging to *other* items on the same page, so
 * every later run reported a spurious "appeared-missing" for a value that had
 * never been that item's value in the first place.
 */
async function captureBaseline(query: string, label: string, tz: string): Promise<Capture> {
  const usage = emptyUsage();
  try {
    const search = await webSearch(query, { count: 8 });
    addUsage(usage, search.usage);
    if (search.results.length === 0) {
      return { facts: [], citations: [], usage, error: "no results", digestRatio: 0 };
    }
    const digest = buildDigest({
      question: query,
      results: search.results,
      intent: "change",
      budgetTokens: 900,
      subject: label,
      requireSubject: true,
    });
    // Attribute with local time in the list's zone, so a later "since yesterday"
    // means the same thing to the user as it does to the diff.
    const observedAt = new Date().toLocaleString("en-CA", { timeZone: tz }).slice(0, 10);
    const facts = digest.facts.map((f) => ({ ...f, observedAt }));
    return {
      facts,
      citations: digest.citations,
      usage,
      error: null,
      digestRatio: digest.stats.ratio,
    };
  } catch (err) {
    return { facts: [], citations: [], usage, error: String(err), digestRatio: 0 };
  }
}

// ---------------------------------------------------------------------------
// Re-check
// ---------------------------------------------------------------------------

/**
 * Re-check every item in a shortlist, in parallel.
 *
 * `resumeRunId` continues an interrupted run: items already marked done are not
 * fetched again.
 */
export async function recheckShortlist(
  store: Store,
  args: {
    shortlistId: string;
    tz: string;
    resumeRunId?: string;
    onProgress?: (e: ProgressEvent) => void;
  },
): Promise<RecheckResult> {
  const shortlist = store.getShortlist(args.shortlistId);
  if (!shortlist) throw new Error(`shortlist not found: ${args.shortlistId}`);

  const startedAt = Date.now();
  const usage = emptyUsage();

  let run: RunRow;
  let items = shortlist.items;

  if (args.resumeRunId) {
    const existing = store.getRun(args.resumeRunId);
    if (!existing) throw new Error(`run not found: ${args.resumeRunId}`);
    run = existing;
    const pending = new Set(store.resumableRunItems(run.id).map((i) => i.itemId));
    items = shortlist.items.filter((i) => pending.has(i.id));
    store.setRunStatus(run.id, "running");
  } else {
    const runId = randomUUID();
    store.createRun({ id: runId, shortlistId: shortlist.id, total: shortlist.items.length });
    store.setRunStatus(runId, "running");
    run = store.getRun(runId)!;
    for (const item of items) {
      store.upsertRunItem({ runId, itemId: item.id, status: "pending" });
    }
    args.onProgress?.({ type: "run_started", runId, shortlistId: shortlist.id, total: items.length });
  }

  const since = Math.max(...shortlist.items.map((i) => i.lastCheckedAt ?? shortlist.createdAt), shortlist.createdAt);

  // Fan out. Each item is independent, so wall-clock is one item's latency plus
  // queueing, not the sum. Concurrency is capped inside the DeepSeek client.
  const results = await Promise.all(
    items.map(async (item, index) => {
      store.upsertRunItem({ runId: run.id, itemId: item.id, status: "checking" });
      const result = await recheckItem(item, args.tz);
      store.upsertRunItem({
        runId: run.id,
        itemId: item.id,
        status: result.status === "failed" ? "failed" : "done",
        changes: result.changes,
        citations: result.citations,
        error: result.error,
        digestRatio: result.digestRatio,
      });
      // Baselines advance only on success, so a transient failure does not erase
      // the values the next run needs to compare against.
      if (result.status !== "failed" && result.status !== "missing") {
        store.updateItemBaseline(item.id, result.freshFacts ?? [], result.citations, result.status);
      }
      store.bumpRunCounters(run.id, {
        done: result.status === "failed" ? 0 : 1,
        failed: result.status === "failed" ? 1 : 0,
      });
      args.onProgress?.({
        type: "item_done",
        runId: run.id,
        itemId: item.id,
        label: item.label,
        index: index + 1,
        total: items.length,
        status: result.status,
      });
      return result;
    }),
  );

  for (const r of results) addUsage(usage, r.usage);

  const failed = results.filter((r) => r.status === "failed").length;
  const finalStatus = failed === 0 ? "done" : failed === results.length ? "failed" : "partial";
  store.setRunStatus(run.id, finalStatus);
  args.onProgress?.({ type: "run_finished", runId: run.id, done: results.length - failed, failed });

  return {
    runId: run.id,
    shortlistId: shortlist.id,
    shortlistName: shortlist.name,
    since,
    items: results,
    usage,
    latencyMs: Date.now() - startedAt,
  };
}

interface ItemCheck extends RecheckItemResult {
  freshFacts?: Fact[];
}

async function recheckItem(item: ShortlistItemRow, tz: string): Promise<ItemCheck> {
  const usage = emptyUsage();
  const base: Omit<ItemCheck, "status" | "changes" | "citations" | "evidence" | "error" | "digestRatio" | "usage"> = {
    itemId: item.id,
    label: item.label,
  };

  try {
    const search = await webSearch(item.query, { count: 8 });
    addUsage(usage, search.usage);
    if (search.results.length === 0) {
      return {
        ...base,
        status: "failed",
        changes: [],
        citations: [],
        evidence: "",
        error: "no results",
        digestRatio: 0,
        usage,
      };
    }

    const priorAttributes = new Set(item.baselineFacts.map((f) => f.attribute));
    const digest = buildDigest({
      question: item.query,
      results: search.results,
      intent: "change",
      budgetTokens: 700,
      priorFacts: item.baselineFacts.map((f) => ({ attribute: f.attribute, value: f.value })),
      // Only sentences that name this item may produce its values. Without this,
      // any number on any retrieved page becomes a "value of this item", which
      // manufactures changes that never happened.
      subject: item.label,
      requireSubject: true,
    });

    const freshFacts: Fact[] = digest.facts.map((f) => ({
      ...f,
      entity: f.entity || item.label,
      observedAt: new Date().toISOString(),
    }));

    const changes = diffFacts(item.baselineFacts, freshFacts);
    const meaningful = changes.filter((c) => c.kind === "updated" || c.kind === "new");

    // The evidence string is built from the *new* facts' own sentences, so it is
    // always traceable to a citation id in the same row.
    const evidence = meaningful
      .slice(0, 3)
      .map((c) => `[${c.citationIds[0]}] ${c.to?.evidence ?? ""}`)
      .join(" ")
      .slice(0, 400);

    const status: ItemCheck["status"] =
      meaningful.some((c) => c.kind === "updated")
        ? "updated"
        : meaningful.some((c) => c.kind === "new")
          ? "new"
          : changes.length > 0
            ? "unchanged"
            : "missing";

    return {
      ...base,
      status,
      changes,
      citations: digest.citations,
      evidence,
      error: null,
      digestRatio: digest.stats.ratio,
      usage,
      freshFacts,
    };
  } catch (err) {
    return {
      ...base,
      status: "failed",
      changes: [],
      citations: [],
      evidence: "",
      error: String(err),
      digestRatio: 0,
      usage,
    };
  }
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

import { z } from "zod";

const z_shortlist = z.object({
  name: z.string().min(1).max(80),
  items: z
    .array(
      z.object({
        label: z.string().min(1).max(60),
        query: z.string().min(1).max(120),
      }),
    )
    .min(1)
    .max(12),
});
