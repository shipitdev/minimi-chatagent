/**
 * Eval metrics.
 *
 * Four things this product claims, and how each is measured without asking a
 * model to grade itself:
 *
 * | Claim | Metric | Why it is a fair test |
 * |---|---|---|
 * | Recall accuracy | exact set match over conversation ids | the database knows which ids fall in the window, so the answer is checkable, not judged |
 * | Change detection | precision / recall over planted value changes | the harness plants the drift, so it knows the truth |
 * | Citation support | fraction of [n] that resolve + fraction of factual sentences that carry one | both are computable from the text and the citation list |
 * | Token savings | 1 − digest/raw, on the same retrieved results | measured on the bytes actually sent to the model |
 */

import { estimateTokens } from "../src/server/digest.js";

// ---------------------------------------------------------------------------
// Citation support
// ---------------------------------------------------------------------------

export interface CitationReport {
  /** Citation markers present in the text. */
  markers: number;
  /** Markers that resolve to a retrieved source. */
  validMarkers: number;
  /** Markers that point at a source that was never retrieved. */
  invalidMarkers: number;
  /** Sentences that assert a checkable fact (number, date, version, price). */
  factualSentences: number;
  /** Of those, how many carry at least one valid citation marker. */
  citedFactualSentences: number;
  /** Distinct sources cited / sources available. */
  coverage: number;
  /** validMarkers / markers, or 1 when there are no markers. */
  validity: number;
  /** citedFactualSentences / factualSentences, or 1 when nothing is checkable. */
  supportRate: number;
}

const FACTUAL = /\b\d|percent|%|\$|₹|€|£|\b(?:version|released?|launched?|acquired|raised|deprecated)\b/i;

export function citationReport(text: string, validIds: number[]): CitationReport {
  const valid = new Set(validIds);
  const markers = [...text.matchAll(/\[(\d{1,3})\]/g)].map((m) => Number(m[1]));
  const validMarkers = markers.filter((n) => valid.has(n)).length;
  const invalidMarkers = markers.length - validMarkers;

  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20);
  const factual = sentences.filter((s) => FACTUAL.test(s) && !/^sources?:/i.test(s));
  const cited = factual.filter((s) => /\[\d{1,3}\]/.test(s));

  const distinct = new Set(markers.filter((n) => valid.has(n)));

  return {
    markers: markers.length,
    validMarkers,
    invalidMarkers,
    factualSentences: factual.length,
    citedFactualSentences: cited.length,
    coverage: valid.size > 0 ? distinct.size / valid.size : 0,
    validity: markers.length > 0 ? validMarkers / markers.length : 1,
    supportRate: factual.length > 0 ? cited.length / factual.length : 1,
  };
}

// ---------------------------------------------------------------------------
// Change detection
// ---------------------------------------------------------------------------

export interface PlantedChange {
  label: string;
  attribute: string;
  /** Expected new value, matched loosely against the reported `to`. */
  to: string;
}

export interface ChangeScore {
  expected: number;
  detected: number;
  recall: number;
  precision: number;
  spurious: number;
  details: Array<{ expected: PlantedChange; found: boolean; reported: string | null }>;
}

/** Loose value match: currency symbols, commas and units vary between pages. */
function valueMatches(reported: string | null, expected: string): boolean {
  if (!reported) return false;
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[$₹€£,\s]/g, "")
      .replace(/(usd|dollars?|permonth|\/mo|peryear|\/yr|percent|%)/g, "")
      .replace(/\.0+$/, "");
  const a = norm(reported);
  const b = norm(expected);
  return a === b || a.includes(b) || b.includes(a);
}

export function scoreChanges(
  plantedInput: PlantedChange[],
  reported: Array<{ label: string; kind: string; attribute: string; from: string | null; to: string | null }>,
): ChangeScore {
  // Dedupe: a duplicated expectation would otherwise be "found" twice and inflate
  // recall without detecting anything extra.
  const seen = new Set<string>();
  const planted = plantedInput.filter((p) => {
    const k = `${p.label.toLowerCase()}::${p.attribute}::${p.to}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const realChanges = reported.filter((r) => r.kind === "updated");
  const details = planted.map((p) => {
    const hit = realChanges.find(
      (r) =>
        r.label.toLowerCase() === p.label.toLowerCase() &&
        r.attribute.toLowerCase().includes(p.attribute.toLowerCase()) &&
        valueMatches(r.to, p.to),
    );
    return { expected: p, found: Boolean(hit), reported: hit?.to ?? null };
  });
  const detected = details.filter((d) => d.found).length;
  // Spurious = reported updates that do not correspond to a planted change.
  const spurious = realChanges.filter(
    (r) =>
      !planted.some(
        (p) => r.label.toLowerCase() === p.label.toLowerCase() && valueMatches(r.to, p.to),
      ),
  ).length;
  return {
    expected: planted.length,
    detected,
    recall: planted.length > 0 ? detected / planted.length : 1,
    precision:
      detected + spurious > 0 ? detected / (detected + spurious) : 1,
    spurious,
    details,
  };
}

// ---------------------------------------------------------------------------
// Token accounting
// ---------------------------------------------------------------------------

export interface TokenScore {
  rawTokens: number;
  digestTokens: number;
  saved: number;
  /** What a naive agent would have sent: every result, in full. */
  naivePromptTokens: number;
}

export function tokenScore(rawTokens: number, digestTokens: number): TokenScore {
  const saved = rawTokens > 0 ? 1 - digestTokens / rawTokens : 0;
  return { rawTokens, digestTokens, saved, naivePromptTokens: rawTokens };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

export function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

/** Count tokens of a plain text blob, for the naive baseline. */
export function tokens(text: string): number {
  return estimateTokens(text);
}
