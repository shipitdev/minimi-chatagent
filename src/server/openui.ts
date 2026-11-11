/**
 * Server-side OpenUI: the prompt, the Lang composers, and validation.
 *
 * ## The reliability decision this file encodes
 *
 * OpenUI's model is that the LLM writes OpenUI Lang itself. That is the most
 * flexible option and it is what we offer for the *narrative* block, where the
 * model is choosing prose anyway. It is a bad idea for the data-heavy views.
 *
 * A change report over 12 shortlist items requires the model to emit seven
 * parallel arrays of exactly equal length, with citation ids correctly threaded
 * into a comma-separated string per row. A small model will get that wrong some
 * of the time, and a wrong-length array is not a degraded view — it is an
 * unrenderable one. And we already *own* the data: the diffs are computed
 * deterministically in `digest.ts`.
 *
 * So: **the model authors the answer; code authors the tables.** Every generated
 * document is validated against the library's own parser before it is stored, and
 * an invalid one is replaced by a deterministic composition rather than being sent
 * to a renderer that will throw.
 */

import { z } from "zod";
import { createLibrary, defineComponent, createParser } from "@openuidev/react-lang";
import { componentSpecs, REPORT_DESCRIPTION, REPORT_NAME } from "../library/schema.js";
import type { Citation } from "./digest.js";

/**
 * Stub renderers: the server only needs names, props and descriptions to build
 * the prompt. Report is constructed last because its `blocks` prop is a union of
 * the other components' schemas, which is what lets the prompt show
 * `Report(blocks: (Note | AnswerCard | ...)[])` instead of a bare `any[]`.
 */
const stubs = componentSpecs.map((spec) =>
  defineComponent({
    name: spec.name,
    description: spec.description,
    props: spec.schema(),
    component: (() => null) as never,
  }),
);

const ReportStub = defineComponent({
  name: REPORT_NAME,
  description: REPORT_DESCRIPTION,
  props: z.object({ blocks: z.array(z.union(stubs.map((d) => d.ref))) }),
  component: (() => null) as never,
});

export const serverLibrary = createLibrary({
  components: [ReportStub, ...stubs],
  root: REPORT_NAME,
});

/**
 * The OpenUI Lang contract, generated from the library rather than hand-written.
 * Regenerating it from the schemas means the prompt cannot drift from the renderer.
 */
export function openuiPrompt(): string {
  return serverLibrary.prompt();
}

/** Cheap: memoised because it is embedded in every system prompt. */
let cachedPrompt: string | null = null;
export function openuiPromptCached(): string {
  cachedPrompt ??= openuiPrompt();
  return cachedPrompt;
}

// ---------------------------------------------------------------------------
// String + Lang serialisation
// ---------------------------------------------------------------------------

/** Escape for an OpenUI Lang double-quoted string. */
export function lang(s: string): string {
  return `"${String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, "\\n")
    .replace(/\t/g, " ")}"`;
}

function num(n: number): string {
  return Number.isFinite(n) ? String(n) : "0";
}

function strArray(items: string[]): string {
  return `[${items.map(lang).join(", ")}]`;
}

function numArray(items: number[]): string {
  return `[${items.map(num).join(", ")}]`;
}

/** Pad every parallel column to the same length so a short array cannot misalign. */
function columns<T>(rows: T[], extractors: Array<(r: T) => unknown>): unknown[][] {
  const cols = extractors.map(() => [] as unknown[]);
  for (const row of rows) {
    extractors.forEach((fn, i) => cols[i]!.push(fn(row)));
  }
  return cols;
}

// ---------------------------------------------------------------------------
// Deterministic composers
// ---------------------------------------------------------------------------

export interface ReportBlock {
  lang: string;
}

export interface AnswerCardInput {
  body: string;
  citations: Citation[];
}

export function composeAnswerCard(input: AnswerCardInput): string {
  const cits = input.citations.slice(0, 12);
  const v = "answer";
  return [
    `${v} = AnswerCard(${lang(input.body)}, ${numArray(cits.map((c) => c.id))}, ${strArray(
      cits.map((c) => c.title),
    )}, ${strArray(cits.map((c) => c.domain))}, ${strArray(cits.map((c) => c.url))})`,
  ].join("\n");
}

export interface ChangeRow {
  label: string;
  status: "updated" | "new" | "unchanged" | "missing";
  note: string;
  from: string;
  to: string;
  /** Citation numbers, or fixture/source ids when evidence carries its own. */
  sourceIds: Array<string | number>;
}

export function composeChangeList(heading: string, rows: ChangeRow[]): string {
  const [labels, statuses, notes, froms, tos, sourceIds] = columns(rows, [
    (r: ChangeRow) => r.label,
    (r: ChangeRow) => r.status,
    (r: ChangeRow) => r.note,
    (r: ChangeRow) => r.from,
    (r: ChangeRow) => r.to,
    (r: ChangeRow) => r.sourceIds.join(","),
  ]) as [string[], string[], string[], string[], string[], string[]];
  const v = "changes";
  return `${v} = ChangeList(${lang(heading)}, ${strArray(labels)}, ${strArray(
    statuses,
  )}, ${strArray(notes)}, ${strArray(froms)}, ${strArray(tos)}, ${strArray(sourceIds)})`;
}

export interface RecallRow {
  id: string;
  title: string;
  when: string;
  tz: string;
  count: number;
  snippet: string;
}

export function composeRecallTimeline(heading: string, window: string, rows: RecallRow[]): string {
  const [titles, whens, tzs, counts, snippets, ids] = columns(rows, [
    (r: RecallRow) => r.title,
    (r: RecallRow) => r.when,
    (r: RecallRow) => r.tz,
    (r: RecallRow) => r.count,
    (r: RecallRow) => r.snippet,
    (r: RecallRow) => r.id,
  ]) as [string[], string[], string[], number[], string[], string[]];
  const v = "timeline";
  return `${v} = RecallTimeline(${lang(heading)}, ${lang(window)}, ${strArray(titles)}, ${strArray(
    whens,
  )}, ${strArray(tzs)}, ${numArray(counts)}, ${strArray(snippets)}, ${strArray(ids)})`;
}

export function composeStatStrip(items: Array<{ label: string; value: string; hint?: string }>): string {
  const [labels, values, hints] = columns(items, [
    (i: { label: string }) => i.label,
    (i: { value: string }) => i.value,
    (i: { hint?: string }) => i.hint ?? "",
  ]) as [string[], string[], string[]];
  const v = "stats";
  return `${v} = StatStrip(${strArray(labels)}, ${strArray(values)}, ${strArray(hints)})`;
}

export function composeNote(body: string): string {
  return `note = Note(${lang(body)})`;
}

export function composeChips(chips: string[]): string {
  return `chips = QuickChips(${strArray(chips)})`;
}

/**
 * Assemble a document. `root` is written first on purpose: OpenUI Lang hoists
 * references, so the UI shell appears immediately and the data fills in as it
 * streams. That is what makes progressive rendering work rather than showing
 * nothing until the last token arrives.
 */
export function composeReport(blocks: string[]): string {
  const refs = blocks
    .filter(Boolean)
    .map((b) => b.split("=")[0]!.trim())
    .filter((v) => v && v !== "root");
  const root = `root = Report([${refs.join(", ")}])`;
  return [root, ...blocks.filter(Boolean)].join("\n");
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// The parser is built from the library's own JSON schema, so validity is checked
// against exactly the components the client will render.
const parser = createParser(serverLibrary.toJSONSchema(), "Report");

export interface ValidationOutcome {
  ok: boolean;
  errors: string[];
}

/**
 * Validate a generated document against the library before it reaches a browser.
 *
 * This is the guardrail that makes model-authored Lang safe to enable: a
 * document either parses and renders, or it never leaves the server.
 */
export function validateLang(document: string): ValidationOutcome {
  try {
    const result = parser.parse(document) as unknown as {
      success?: boolean;
      errors?: Array<{ message?: string } | string>;
      meta?: { errors?: Array<{ message?: string } | string> };
    };
    const errors = result.meta?.errors ?? result.errors ?? [];
    if (result.success === false || errors.length > 0) {
      return {
        ok: false,
        errors: errors.map((e) => (typeof e === "string" ? e : (e.message ?? "parse error"))),
      };
    }
    return { ok: true, errors: [] };
  } catch (err) {
    return { ok: false, errors: [String(err)] };
  }
}
