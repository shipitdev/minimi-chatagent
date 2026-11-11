/**
 * The component library, defined once and shared.
 *
 * Both the server (which needs only names/props/descriptions, to generate the
 * OpenUI Lang prompt) and the client (which needs real React renderers) build
 * their library from these same schemas. Keeping one source of truth means the
 * prompt can never promise a prop the renderer does not have — a divergence that
 * fails at render time, for the user, rather than at build time.
 *
 * ## Why the lists are column-oriented
 *
 * Every component takes parallel arrays (`labels`, `statuses`, `notes`, …) rather
 * than an array of objects. This is the same choice OpenUI's own Table makes with
 * `Col(...)`, and it is a direct token optimisation: for N rows, an object array
 * repeats every key N times, while parallel arrays write each key once. For a
 * 12-item shortlist that is roughly a 3x reduction in the generated payload — the
 * same action-preserving instinct as the search digest, applied to the UI payload.
 *
 * ## Why the library is deliberately small
 *
 * The library's signatures are embedded verbatim in the system prompt on every
 * call. Seven components is ~2.4k characters of prompt; the 40-component library
 * that ships with OpenUI is an order of magnitude more. Every component we add is
 * a permanent tax on every request and one more choice a small model can get
 * wrong. These seven cover every view the product needs.
 */

import { z } from "zod";

export const COMPONENT_NAMES = [
  "Note",
  "AnswerCard",
  "ChangeList",
  "RecallTimeline",
  "StatStrip",
  "QuickChips",
] as const;

/** The root container's name, kept separate because it is built from refs. */
export const REPORT_NAME = "Report";

export const REPORT_DESCRIPTION =
  "Root container. Stacks blocks vertically. Every visible block must be listed in blocks.";

export type ComponentName = (typeof COMPONENT_NAMES)[number];

export interface ComponentSpec {
  name: ComponentName;
  description: string;
  /** Returns a fresh schema; never share a single instance across libraries. */
  schema: () => z.ZodObject;
}

export const componentSpecs: ComponentSpec[] = [
  {
    name: "Note",
    description: "A short plain-text block. Use for caveats, empty results, or simple answers.",
    schema: () => z.object({ body: z.string() }),
  },
  {
    name: "AnswerCard",
    description:
      "A researched answer with an inline citation ledger. `body` is prose containing [n] markers; " +
      "the citation arrays are parallel and must be the same length.",
    schema: () =>
      z.object({
        body: z.string(),
        citeIds: z.array(z.number()),
        citeTitles: z.array(z.string()),
        citeDomains: z.array(z.string()),
        citeUrls: z.array(z.string()),
      }),
  },
  {
    name: "ChangeList",
    description:
      "Column-oriented list of what changed per covered item. All arrays are parallel and the same " +
      "length. `status` is one of updated, new, unchanged, missing. `sourceIds` is a comma-separated " +
      'string of citation ids such as "1,3". `from`/`to` hold the old and new values.',
    schema: () =>
      z.object({
        heading: z.string(),
        labels: z.array(z.string()),
        statuses: z.array(z.string()),
        notes: z.array(z.string()),
        froms: z.array(z.string()),
        tos: z.array(z.string()),
        sourceIds: z.array(z.string()),
      }),
  },
  {
    name: "RecallTimeline",
    description:
      "Recovered conversations from a date range, with the timezone each was recorded in. " +
      "All arrays are parallel and the same length.",
    schema: () =>
      z.object({
        heading: z.string(),
        window: z.string(),
        titles: z.array(z.string()),
        whens: z.array(z.string()),
        tzs: z.array(z.string()),
        counts: z.array(z.number()),
        snippets: z.array(z.string()),
        ids: z.array(z.string()),
      }),
  },
  {
    name: "StatStrip",
    description:
      "A row of labelled metrics. All arrays are parallel. `hints` may be empty strings.",
    schema: () =>
      z.object({
        labels: z.array(z.string()),
        values: z.array(z.string()),
        hints: z.array(z.string()),
      }),
  },
  {
    name: "QuickChips",
    description: "Suggested next prompts the user can click.",
    schema: () => z.object({ chips: z.array(z.string()) }),
  },
];
