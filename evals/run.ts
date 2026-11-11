/**
 * Eval runner.
 *
 *   npm run eval:offline                 # in-process, scripted backend, no key
 *   npm run eval                        # against a running server (live model)
 *   npm run eval -- --testset mine.jsonl --out runs/mine
 *
 * The offline mode runs the real pipeline — real agent, real digests, real memory,
 * real SQL — with only the model and search backend swapped for a script. So it
 * measures recall accuracy, citation support, change detection and token savings
 * faithfully. What it cannot measure is answer *quality*; those numbers are marked
 * as scripted in the report.
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { Store } from "../src/server/memory.js";
import { Agent } from "../src/server/agent.js";
import { recheckShortlist } from "../src/server/shortlist.js";
import { estimateTokens } from "../src/server/digest.js";
import { costOf } from "../src/server/config.js";
import { dayRange } from "../src/server/time.js";
import {
  citationReport,
  mean,
  percentile,
  scoreChanges,
  type CitationReport,
  type PlantedChange,
} from "./metrics.js";

process.env.MINIMI_OFFLINE = process.env.MINIMI_OFFLINE ?? "1";

const zSeed = z.object({ daysAgo: z.number().int().min(0).max(400), title: z.string() });
const zPlanted = z.object({ label: z.string(), attribute: z.string(), to: z.string() });
const zItem = z.object({
  id: z.string(),
  category: z.enum(["answer", "recall", "change", "honest", "chat"]),
  tz: z.string(),
  question: z.string(),
  seed: z.array(zSeed).optional(),
  planted: z.array(zPlanted).optional(),
  expect: z
    .object({
      intent: z.enum(["answer", "recall", "change", "chat"]).optional(),
      keywords: z.array(z.string()).optional(),
      minCitations: z.number().optional(),
      minSupport: z.number().optional(),
      allSeeded: z.boolean().optional(),
      excludesOtherDays: z.boolean().optional(),
      minChangeRecall: z.number().optional(),
      minPrecision: z.number().optional(),
      refusal: z.boolean().optional(),
    })
    .default({}),
});
type Item = z.infer<typeof zItem>;

interface ItemResult {
  id: string;
  category: Item["category"];
  question: string;
  passed: boolean;
  failures: string[];
  intent: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  costUsd: number;
  citations: number;
  citation: CitationReport | null;
  digestSaved: number | null;
  detail: Record<string, unknown>;
}

const REFUSAL_CUES = [
  "could not find",
  "couldn't find",
  "cannot find",
  "no usable",
  "not able to",
  "will not guess",
  "don't have",
  "do not have",
  "nothing",
  "no sources",
  "unable to",
  "no information",
];

async function loadTestset(file: string): Promise<Item[]> {
  const raw = fs.readFileSync(file, "utf8");
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.map((line, i) => {
    const parsed = zItem.safeParse(JSON.parse(line));
    if (!parsed.success) {
      throw new Error(`testset line ${i + 1} invalid: ${parsed.error.issues.map((x) => x.message).join("; ")}`);
    }
    return parsed.data;
  });
}

/** Seed conversations at controlled dates, then force their timestamps. */
function seedConversations(store: Store, item: Item, now: number): { ids: string[]; otherIds: string[] } {
  const ids: string[] = [];
  const otherIds: string[] = [];
  for (const seed of item.seed ?? []) {
    const id = `seed-${item.id}-${ids.length}`;
    store.createConversation({ id, title: seed.title, tz: item.tz, tzOffsetMin: 0 });
    store.addMessage({ conversationId: id, role: "user", content: `About ${seed.title}`, createdAt: now });
    store.addMessage({ conversationId: id, role: "assistant", content: `Notes on ${seed.title}`, createdAt: now });
    const when = now - seed.daysAgo * 86_400_000;
    store.db.prepare(`UPDATE conversations SET created_at = ?, updated_at = ? WHERE id = ?`).run(when, when, id);
    const day = dayRange(now, item.tz);
    const seedDay = dayRange(when, item.tz);
    if (item.expect.excludesOtherDays) {
      // A conversation on a different local day must not be returned.
      if (seedDay.isoDate === day.isoDate || seed.daysAgo <= 7) ids.push(id);
      else otherIds.push(id);
    } else {
      ids.push(id);
    }
  }
  return { ids, otherIds };
}

async function runItem(store: Store, item: Item, now: number): Promise<ItemResult> {
  // One store per item. Sharing a database made later items inherit earlier
  // items' shortlists and conversations: a change item re-checked the shortlist
  // a previous change item had already advanced, so it saw no diff at all.
  const agent = new Agent(store);
  const conversationId = `eval-${item.id}`;
  const seeded = seedConversations(store, item, now);

  const reply = await agent.respond({ conversationId, text: item.question, tz: item.tz });
  const failures: string[] = [];

  if (item.expect.intent && reply.intent !== item.expect.intent) {
    failures.push(`intent ${reply.intent} != ${item.expect.intent}`);
  }

  let citation: CitationReport | null = null;
  if (item.category === "answer" || item.category === "honest") {
    citation = citationReport(reply.text, reply.citations.map((c) => c.id));
    if (item.expect.minCitations && reply.citations.length < item.expect.minCitations) {
      failures.push(`citations ${reply.citations.length} < ${item.expect.minCitations}`);
    }
    if (citation.invalidMarkers > 0) failures.push(`${citation.invalidMarkers} invalid citation markers`);
    if (item.expect.minSupport && citation.supportRate < item.expect.minSupport) {
      failures.push(`citation support ${citation.supportRate.toFixed(2)} < ${item.expect.minSupport}`);
    }
  }

  if (item.expect.keywords && item.expect.keywords.length > 0) {
    const lower = reply.text.toLowerCase();
    const hits = item.expect.keywords.filter((k) => lower.includes(k.toLowerCase()));
    if (hits.length === 0) failures.push(`none of ${item.expect.keywords.join(",")} present`);
  }

  if (item.category === "honest" && item.expect.refusal) {
    const lower = reply.text.toLowerCase();
    const refused = REFUSAL_CUES.some((c) => lower.includes(c)) || reply.citations.length === 0;
    if (!refused) failures.push("did not decline when evidence was unavailable");
  }

  let changeDetail: Record<string, unknown> = {};
  if (item.category === "change") {
    const shortlists = store.listShortlists();
    const shortlist = shortlists[0];
    if (!shortlist) {
      failures.push("no shortlist was created");
    } else {
      // Flip the scripted corpus to its drifted state, then re-check.
      const previous = process.env.MINIMI_OFFLINE_DRIFT;
      process.env.MINIMI_OFFLINE_DRIFT = "1";
      let run;
      try {
        run = await recheckShortlist(store, { shortlistId: shortlist.id, tz: item.tz });
      } finally {
        if (previous === undefined) delete process.env.MINIMI_OFFLINE_DRIFT;
        else process.env.MINIMI_OFFLINE_DRIFT = previous;
      }
      const reported = run.items.flatMap((i) =>
        i.changes.map((c) => ({
          label: i.label,
          kind: c.kind,
          attribute: c.attribute,
          from: c.from?.value ?? null,
          to: c.to?.value ?? null,
        })),
      );
      const planted = (item.planted ?? []) as PlantedChange[];
      const score = scoreChanges(planted, reported);
      // "Cite evidence for what changed" is the headline claim, so it gets its own
      // metric: the share of changed rows that carry at least one source id.
      const changedRows = run.items.filter((i) =>
        i.changes.some((c) => c.kind === "updated"),
      );
      const withEvidence = changedRows.filter((i) =>
        i.changes.some((c) => c.kind === "updated" && c.citationIds.length > 0),
      );
      const evidenceRate = changedRows.length > 0 ? withEvidence.length / changedRows.length : 1;
      changeDetail = { ...score, evidenceRate, changedRows: changedRows.length };
      if (evidenceRate < 1) failures.push(`only ${(evidenceRate * 100).toFixed(0)}% of changed rows cite evidence`);
      if (item.expect.minChangeRecall && score.recall < item.expect.minChangeRecall) {
        failures.push(`change recall ${score.recall.toFixed(2)} < ${item.expect.minChangeRecall}`);
      }
      if (item.expect.minPrecision && score.precision < item.expect.minPrecision) {
        failures.push(`change precision ${score.precision.toFixed(2)} < ${item.expect.minPrecision}`);
      }
    }
  }

  if (item.category === "recall" && item.expect.allSeeded) {
    const foundIds = ((reply.trace.recall as { foundIds?: string[] })?.foundIds ?? []) as string[];
    const missing = seeded.ids.filter((id) => !foundIds.includes(id));
    const leaked = seeded.otherIds.filter((id) => foundIds.includes(id));
    if (missing.length > 0) failures.push(`missed ${missing.length} seeded conversation(s)`);
    if (leaked.length > 0) failures.push(`returned ${leaked.length} conversation(s) outside the window`);
    changeDetail = { found: foundIds.length, seeded: seeded.ids.length, missing, leaked };
  }

  const totalTokens = reply.usage.promptTokens + reply.usage.completionTokens;
  return {
    id: item.id,
    category: item.category,
    question: item.question,
    passed: failures.length === 0,
    failures,
    intent: reply.intent,
    latencyMs: reply.latencyMs,
    promptTokens: reply.usage.promptTokens,
    completionTokens: reply.usage.completionTokens,
    cacheHitTokens: reply.usage.cacheHitTokens,
    costUsd: costOf(reply.usage),
    citations: reply.citations.length,
    citation,
    digestSaved: reply.digest ? 1 - reply.digest.ratio : null,
    detail: {
      ...changeDetail,
      promptTokensTotal: totalTokens,
      digestTokens: reply.digest?.digestTokens ?? null,
      rawTokens: reply.digest?.inputTokens ?? null,
      facts: reply.digest?.factsExtracted ?? null,
    },
  };
}

function report(results: ItemResult[], label: string, wallMs: number, scripted: boolean): string {
  const byCat = new Map<string, ItemResult[]>();
  for (const r of results) {
    const arr = byCat.get(r.category) ?? [];
    arr.push(r);
    byCat.set(r.category, arr);
  }
  const latencies = results.map((r) => r.latencyMs);
  const saved = results.map((r) => r.digestSaved).filter((v): v is number => v !== null);
  const support = results.map((r) => r.citation?.supportRate).filter((v): v is number => v !== undefined);
  const validity = results.map((r) => r.citation?.validity).filter((v): v is number => v !== undefined);

  const lines: string[] = [];
  lines.push(`# minimi eval — ${label}`);
  lines.push("");
  lines.push(`Backend: **${scripted ? "scripted (offline)" : "live model"}** · items: ${results.length} · wall: ${(wallMs / 1000).toFixed(1)}s`);
  lines.push("");
  lines.push("## Headline");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|---|---|");
  lines.push(`| Pass rate | **${(mean(results.map((r) => (r.passed ? 1 : 0))) * 100).toFixed(1)}%** |`);
  lines.push(`| Recall accuracy (conversation-set exact match) | ${pct(mean(byCat.get("recall")?.map((r) => (r.passed ? 1 : 0)) ?? []))} |`);
  lines.push(`| Citation support (factual sentences with a valid cite) | ${pct(mean(support))} |`);
  lines.push(`| Citation validity (markers resolving to a real source) | ${pct(mean(validity))} |`);
  lines.push(`| Token savings vs raw results (digest) | ${pct(mean(saved))} |`);
  lines.push(`| Latency p50 / p95 | ${(percentile(latencies, 50) / 1000).toFixed(2)}s / ${(percentile(latencies, 95) / 1000).toFixed(2)}s |`);
  lines.push(`| Cost per item | $${mean(results.map((r) => r.costUsd)).toFixed(5)} |`);
  lines.push("");
  lines.push("## By category");
  lines.push("");
  lines.push("| Category | n | Pass | p50 | Mean tokens |");
  lines.push("|---|---|---|---|---|");
  for (const [cat, rs] of [...byCat.entries()].sort()) {
    lines.push(
      `| ${cat} | ${rs.length} | ${pct(mean(rs.map((r) => (r.passed ? 1 : 0))))} | ${(percentile(rs.map((r) => r.latencyMs), 50) / 1000).toFixed(2)}s | ${Math.round(mean(rs.map((r) => r.promptTokens + r.completionTokens)))} |`,
    );
  }
  lines.push("");

  const changeResults = results.filter((r) => r.category === "change" && "recall" in r.detail);
  if (changeResults.length > 0) {
    lines.push("## Change detection (planted ground truth)");
    lines.push("");
    lines.push("| Item | Expected | Detected | Recall | Precision | Spurious |");
    lines.push("|---|---|---|---|---|---|");
    for (const r of changeResults) {
      const d = r.detail as unknown as { expected: number; detected: number; recall: number; precision: number; spurious: number };
      lines.push(`| ${r.id} | ${d.expected} | ${d.detected} | ${pct(d.recall)} | ${pct(d.precision)} | ${d.spurious} |`);
    }
    lines.push("");
  }

  lines.push("## Failures");
  lines.push("");
  const failed = results.filter((r) => !r.passed);
  if (failed.length === 0) lines.push("None.");
  for (const r of failed) {
    lines.push(`- **${r.id}** (${r.category}) — ${r.failures.join("; ")}`);
  }
  lines.push("");
  if (scripted) {
    lines.push("> Scripted backend: token, latency and recall figures are real measurements of the");
    lines.push("> pipeline. Answer *quality* is not measured here.");
    lines.push("");
  }
  return lines.join("\n");
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const testsetPath = get("--testset") ?? path.resolve("evals/testset.jsonl");
  const outDir = path.resolve(get("--out") ?? `runs/eval-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  const scripted = process.env.MINIMI_OFFLINE === "1";

  const items = await loadTestset(testsetPath);
  fs.mkdirSync(outDir, { recursive: true });
  const dbPath = path.join(outDir, "eval.db");
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(f, { force: true });

  const now = Date.now();
  const results: ItemResult[] = [];
  const started = Date.now();

  console.log(`testset: ${testsetPath} (${items.length} items)`);
  console.log(`backend: ${scripted ? "scripted (offline)" : "live"}\n`);

  for (const item of items) {
    const itemDb = path.join(outDir, `eval-${item.id}.db`);
    for (const f of [itemDb, `${itemDb}-wal`, `${itemDb}-shm`]) fs.rmSync(f, { force: true });
    const store = new Store(itemDb);
    let r: ItemResult;
    try {
      r = await runItem(store, item, now);
      results.push(r);
      console.log(
        `  ${r.passed ? "PASS" : "FAIL"} ${r.id.padEnd(4)} ${r.category.padEnd(7)} ` +
          `${r.intent.padEnd(7)} ${(r.latencyMs / 1000).toFixed(2)}s ` +
          `${r.citations} cites${r.digestSaved !== null ? ` ${(r.digestSaved * 100).toFixed(0)}% saved` : ""}` +
          (r.passed ? "" : `  ← ${r.failures.join("; ")}`),
      );
    } catch (err) {
      results.push({
        id: item.id,
        category: item.category,
        question: item.question,
        passed: false,
        failures: [`harness error: ${String(err)}`],
        intent: "error",
        latencyMs: 0,
        promptTokens: 0,
        completionTokens: 0,
        cacheHitTokens: 0,
        costUsd: 0,
        citations: 0,
        citation: null,
        digestSaved: null,
        detail: {},
      });
      console.log(`  ERROR ${item.id} — ${String(err)}`);
    } finally {
      store.close();
    }
  }

  const wallMs = Date.now() - started;
  const md = report(results, path.basename(outDir), wallMs, scripted);
  fs.writeFileSync(path.join(outDir, "report.md"), md, "utf8");
  fs.writeFileSync(
    path.join(outDir, "results.json"),
    JSON.stringify({ label: path.basename(outDir), scripted, wallMs, results }, null, 1),
    "utf8",
  );

  fs.rmSync(dbPath, { force: true });
  console.log(`\nreport: ${path.join(outDir, "report.md")}`);
  console.log(
    `pass ${(mean(results.map((r) => (r.passed ? 1 : 0))) * 100).toFixed(1)}% · ` +
      `token savings ${pct(mean(results.map((r) => r.digestSaved).filter((v): v is number => v !== null)))} · ` +
      `p95 ${(percentile(results.map((r) => r.latencyMs), 95) / 1000).toFixed(2)}s`,
  );
  const failed = results.filter((r) => !r.passed).length;
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
