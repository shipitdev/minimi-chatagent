/**
 * Deterministic evidence selection inspired by Coca-Cola (arXiv:2611.06500).
 * This is readable text extraction, not the paper's trained latent compressor.
 * Clauses are ranked for lexical relevance and explicit values, bound to subjects,
 * and deduplicated. Selected claims retain citations and billing qualifiers.
 * Token estimates measure text size; they do not prove next-action preservation.
 */

export interface Citation {
  id: number;
  url: string;
  title: string;
  domain: string;
  date: string | null;
  authority: number;
}

export type FactKind =
  | "version"
  | "date"
  | "percentage"
  | "money"
  | "quantity"
  | "status"
  | "name"
  | "other";

export interface Fact {
  /** The subject the value belongs to — usually the shortlist item or entity. */
  entity: string;
  /** What is being measured: "version", "price", "release date", "status", ... */
  attribute: string;
  /** The value, kept verbatim so it can be diffed and quoted. */
  value: string;
  kind: FactKind;
  /** Citation id this value came from. */
  citationId: number;
  /** The source sentence, retained so the claim can be checked by a human. */
  evidence: string;
  observedAt: string | null;
}

export interface DigestStats {
  inputChars: number;
  inputTokens: number;
  digestTokens: number;
  /** digestTokens / inputTokens — retained fraction; savings are 1 minus this value. */
  ratio: number;
  sentencesKept: number;
  sentencesDropped: number;
  duplicatesRemoved: number;
  factsExtracted: number;
  budgetExhausted: boolean;
}

export interface Digest {
  /** The compact, prompt-ready evidence block. */
  block: string;
  facts: Fact[];
  citations: Citation[];
  stats: DigestStats;
  /** Raw text per citation, for the eval's citation-support check. */
  evidenceByCitation: Map<number, string[]>;
}

export interface DigestInput {
  question: string;
  results: Array<{
    title: string;
    url: string;
    summary: string;
    snippet: string;
    date: string | null;
    authority: number;
    rerankScore: number;
  }>;
  budgetTokens?: number;
  /** Which decision the digest must support. Changes the salience weighting. */
  intent?: "answer" | "change" | "recall";
  /** For a change check: the values recorded last time, to bias toward them. */
  priorFacts?: Array<{ attribute: string; value: string }>;
  /**
   * The entity the digest is *about* — a shortlist item's label. Sentences that
   * name it are preferred, and with `requireSubject` only those sentences may
   * contribute facts.
   */
  subject?: string;
  requireSubject?: boolean;
}

// ---------------------------------------------------------------------------
// Text utilities
// ---------------------------------------------------------------------------

/** Rough English token estimate; provider token counts may differ. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.6) + 2;
}

const SENTENCE_SPLIT = /(?<=[.!?])\s+(?=[A-Z0-9"“(])|\n+/;

export function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(SENTENCE_SPLIT)
    .map((s) => s.trim())
    // 12, not 20: "Minimum: 20 seats." is 18 characters and is a qualifier that
    // changes what a price means. Length is a poor proxy for usefulness; salience
    // decides what survives.
    .filter((s) => s.length > 12);
}

const STOP = new Set(
  `the a an and or but if of to in on for with is are was were be been it its this that these
   those as at by from we you they he she my your our their me us them do does did so than then
   there here what which who when where how why can could should would will just about into not
   no yes also more most other such only own same very s t don now`.split(/\s+/),
);

export function terms(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9'’-]*/g) ?? []).filter(
    (t) => t.length > 1 && !STOP.has(t),
  );
}

/** Comparison tokens: hyphen/underscore split so `lost-in-the-middle` matches `lost in the middle`. */
export function canonTerms(text: string): string[] {
  return (text.toLowerCase().replace(/[-_]/g, " ").match(/[a-z0-9][a-z0-9'’]*/g) ?? []).filter(
    (t) => t.length > 1 && !STOP.has(t),
  );
}

const BOILERPLATE =
  /(cookie|consent|subscribe|newsletter|sign up|log ?in|privacy policy|terms of (use|service)|advertis|sponsored|all rights reserved|share this|follow us|click here|read more|skip to (content|main)|javascript is disabled|enable javascript|we use cookies|accept all)/i;

const NAVIGATION = /^(home|menu|search|contact|about us|products|services|blog|news)\b/i;

const CHANGE_VERBS =
  /\b(launch(ed|es|ing)?|release(d|s)?|announc(e|ed|es|ing)|introduc(e|ed|es)|deprecat(e|ed|es)|retir(e|ed)|discontinu(e|ed)|renam(e|ed)|acquir(e|ed)|merge(d|s)?|rais(e|ed)|cut|lower(ed)?|increas(e|ed)|decreas(e|ed)|replac(e|ed)|updat(e|ed)|chang(e|ed)|now (available|supports?|offers?)|no longer|sunset|shut ?down|end of life|EOL|price (change|increase|cut)|has (risen|fallen|grown)|dropp(ed)|jumpe?d|surged|passe[ds]|approved|rejected)\b/i;

const STATUS_WORDS =
  /\b(general availability|GA|beta|preview|alpha|stable|deprecated|discontinued|retired|end[- ]of[- ]life|EOL|released|available|unavailable|active|inactive|suspended|archived)\b/gi;

// ---------------------------------------------------------------------------
// Fact extraction
// ---------------------------------------------------------------------------

/**
 * Number-bearing patterns, applied in priority order.
 *
 * Order matters and the spans are tracked: `70.01%` must be read as a percentage,
 * not as version `70.01`, and a value already claimed by a higher-priority pattern
 * must not be re-emitted as a lower-priority one. Getting this wrong produces
 * fabricated "version changed" rows out of ordinary statistics.
 */
const PATTERNS: Array<{ kind: FactKind; re: RegExp }> = [
  { kind: "money", re: /(?:\$|US\$|₹|€|£)\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:million|billion|k|m|bn))?/gi },
  { kind: "percentage", re: /\b\d+(?:\.\d+)?\s?%/g },
  { kind: "date", re: /\b(?:20\d{2}-\d{2}-\d{2}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+\d{4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4})\b/gi },
  // A version needs a `v` prefix, three segments, or explicit version wording.
  { kind: "version", re: /\bv\d+(?:\.\d+){1,2}\b|\b\d+\.\d+\.\d+\b/gi },
  { kind: "quantity", re: /\b\d[\d,]*(?:\.\d+)?\s?(?:billion|million|thousand|k|users|customers|items|results|stars|downloads|employees|percent)\b/gi },
];

/** Attribute hint words, in priority order. The first match names the fact. */
const ATTRIBUTES: Array<{ attribute: string; re: RegExp }> = [
  { attribute: "price", re: /\b(price|cost|fee|pricing|subscription|tier|per month|per year|\/mo|\/yr)\b/i },
  { attribute: "version", re: /\b(version|release|v\d|update|build|patch)\b/i },
  { attribute: "release date", re: /\b(released?|launch(?:ed)?|available (?:on|from)|ships? on|due|scheduled|date)\b/i },
  { attribute: "status", re: /\b(status|deprecated|discontinued|retired|beta|preview|stable|GA|end[- ]of[- ]life|EOL)\b/i },
  { attribute: "valuation", re: /\b(valuation|valued at|market cap|worth)\b/i },
  { attribute: "funding", re: /\b(raised|funding|series [a-e]|seed round|investment)\b/i },
  { attribute: "headcount", re: /\b(employees|headcount|staff|team size|laid off|layoffs)\b/i },
  { attribute: "performance", re: /\b(speed|latency|throughput|faster|slower|benchmark|score|accuracy)\b/i },
  { attribute: "rating", re: /\b(rating|rated|score|review)\b/i },
];

function inferAttribute(sentence: string, kind: FactKind): string {
  for (const a of ATTRIBUTES) if (a.re.test(sentence)) return a.attribute;
  if (kind === "version") return "version";
  if (kind === "date") return "release date";
  if (kind === "money") return "price";
  if (kind === "percentage") return "percentage";
  if (kind === "quantity") return "quantity";
  return "other";
}

function cleanValue(raw: string): string {
  return raw.replace(/\s+/g, " ").replace(/[.,;:]$/, "").trim();
}

/**
 * Split a sentence into claim-sized clauses.
 *
 * The atom of extraction has to be the clause, not the sentence. "Cursor Pro is
 * $20 per month; Windsurf Pro is $15 per month." is one sentence carrying two
 * different subjects, and treating it as one unit is what attributed Windsurf's
 * price to Cursor.
 */
export function clauses(sentence: string): string[] {
  return sentence
    .split(/;|(?<=[a-z0-9)]) (?:and|but|while|whereas|although) (?=[A-Za-z])/g)
    .map((c) => c.trim().replace(/^[,;]\s*/, ""))
    .filter((c) => c.length > 12);
}

/** Capitalised words that name a tier or sentence position, not an entity. */
const GENERIC_CAPS = new Set(
  `the a an it this that these those both however meanwhile version versions release releases
   business individual enterprise team plus basic free premium pro standard starter ultimate
   january february march april may june july august september october november december
   monday tuesday wednesday thursday friday saturday sunday update updates`
    .split(/\s+/)
    .filter(Boolean),
);

/** First capitalised run in a clause that plausibly names an entity. */
export function namedEntityIn(clause: string): string | null {
  for (const m of clause.matchAll(/\b([A-Z][A-Za-z0-9.&'-]{1,}(?:\s+[A-Z][A-Za-z0-9.&'-]{1,})?)/g)) {
    const first = m[1]!.split(/\s+/)[0]!;
    if (GENERIC_CAPS.has(first.toLowerCase())) continue;
    return first;
  }
  return null;
}

/**
 * Resolve the entity each clause is about, carrying the subject forward across
 * elision: in "Cursor Pro costs $20 and the business tier costs $40", the second
 * clause has no name of its own and inherits Cursor.
 */
export function bindClauseEntities(sentence: string, subject: string): Array<{ clause: string; entity: string }> {
  const out: Array<{ clause: string; entity: string }> = [];
  let carried: string | null = null;
  for (const clause of clauses(sentence)) {
    const named = namedEntityIn(clause);
    let entity: string;
    if (subject && clause.toLowerCase().includes(subject.toLowerCase())) {
      entity = subject;
    } else if (named) {
      entity = named;
    } else {
      entity = carried ?? subject ?? named ?? "unknown";
    }
    out.push({ clause, entity });
    carried = entity;
  }
  return out;
}

/**
 * Extract decision-bearing facts from one sentence.
 *
 * `subject` is the entity these facts are allowed to be attributed to. When
 * `requireSubject` is set (used for change checks) a sentence that never names
 * the subject contributes nothing — because a number on a page about something
 * else is not a value of this item, and treating it as one manufactures changes
 * that never happened.
 */
function questionFallback(): string {
  return "";
}

export function extractFactsFromSentence(
  sentence: string,
  entity: string,
  citationId: number,
  observedAt: string | null,
): Fact[] {
  const facts: Fact[] = [];
  const seen = new Set<string>();
  const spans: Array<[number, number]> = [];

  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sentence)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const start = m.index;
      const endIdx = start + m[0].length;
      // Skip a match already claimed by a higher-priority pattern.
      if (spans.some(([a, b]) => start < b && endIdx > a)) continue;
      spans.push([start, endIdx]);

      const value = cleanValue(m[0]);
      // A bare decimal with no version marker is a statistic, not a version; the
      // attribute inference below decides what it actually is.
      const attribute = inferAttribute(sentence, kind);
      const key = `${attribute}::${value.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      facts.push({
        entity,
        attribute,
        value,
        kind,
        citationId,
        evidence: sentence,
        observedAt,
      });
    }
  }

  // Status transitions are decision-critical even without a number.
  const statuses = sentence.match(STATUS_WORDS) ?? [];
  for (const st of statuses) {
    const key = `status::${st.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push({
      entity,
      attribute: "status",
      value: st.toLowerCase(),
      kind: "status",
      citationId,
      evidence: sentence,
      observedAt,
    });
  }
  return facts;
}

// ---------------------------------------------------------------------------
// Salience
// ---------------------------------------------------------------------------

/**
 * Score a sentence by how much it can change the next action.
 *
 * The weights approximate decision relevance heuristically: a *value* that can differ
 * from last time outranks a *statement* that sounds important. Prose that reads
 * well but carries no checkable token is worth almost nothing here, which is the
 * main behavioural difference from an LLM summary.
 */
export function salience(
  sentence: string,
  queryTerms: Set<string>,
  intent: "answer" | "change" | "recall",
  priorAttributes: Set<string>,
): number {
  const lower = sentence.toLowerCase();
  if (BOILERPLATE.test(sentence) || NAVIGATION.test(sentence)) return -1;

  let score = 0;
  const sTerms = canonTerms(sentence);
  if (sTerms.length === 0) return -1;

  // Query overlap, normalised by the sentence so long sentences do not dominate.
  let overlap = 0;
  for (const t of new Set(sTerms)) if (queryTerms.has(t)) overlap++;
  score += (overlap / Math.max(3, Math.sqrt(sTerms.length))) * 2.0;

  // Decision payload: numbers, dates, versions. This is a heuristic, not a learned action objective.
  const hasNumeric = /\b\d/.test(sentence);
  const hasVersion = /\bv?\d+\.\d+/.test(sentence);
  const hasDate = /\b20\d{2}\b/.test(sentence);
  const hasMoney = /(?:\$|US\$|₹|€|£)\s?\d/.test(sentence);
  const hasPercent = /\d\s?%/.test(sentence);
  if (hasNumeric) score += 1.0;
  if (hasVersion) score += 1.2;
  if (hasDate) score += 0.8;
  if (hasMoney) score += 1.2;
  if (hasPercent) score += 0.9;

  // Change language. Strongest single signal that this sentence matters to a
  // "what changed" question.
  if (CHANGE_VERBS.test(sentence)) score += intent === "change" ? 2.4 : 1.3;

  // Status transitions.
  STATUS_WORDS.lastIndex = 0;
  if (STATUS_WORDS.test(sentence)) score += intent === "change" ? 1.8 : 0.8;

  // Prior attributes: for a change check, a sentence about the attribute we
  // recorded last time is exactly what we need to compare against.
  if (intent === "change" && priorAttributes.size > 0) {
    for (const a of priorAttributes) if (lower.includes(a)) { score += 1.5; break; }
  }

  // Named entities (capitalised runs) carry the subject; without them a sentence
  // cannot be attributed to a shortlist item.
  if (/\b[A-Z][A-Za-z0-9.&'-]{2,}/.test(sentence)) score += 0.4;

  // Billing qualifiers are part of the value, not surrounding prose. "Requires
  // annual billing" and "minimum 20 seats" change what the number means, so a
  // digest that keeps `$21` and drops these has not preserved the fact.
  if (/\b(?:annual(?:ly)?\s+billing|billed\s+annual|billed\s+monthly|monthly\s+billing|month-to-month|per\s+seat|per\s+user|minimum(?:\s+of)?\s+\d+\s+seats?|\d+-seat\s+minimum|requires?\s+annual)\b/i.test(sentence)) {
    score += 1.4;
  }

  // Penalise vague hedges that read authoritative but assert nothing checkable.
  if (/\b(may|could|might|reportedly|rumou?red|allegedly|it is (believed|thought))\b/i.test(sentence)) {
    score -= 1.0;
  }
  // Penalise pure definitional filler.
  if (/^(this|these|it|they)\b/i.test(sentence) && !hasNumeric) score -= 0.5;

  return score;
}

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function shingles(text: string, n = 8): Set<string> {
  const t = canonTerms(text).slice(0, 160);
  const out = new Set<string>();
  for (let i = 0; i + n <= t.length; i++) out.add(t.slice(i, i + n).join(" "));
  return out;
}

function nearDuplicate(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  let inter = 0;
  for (const s of a) if (b.has(s)) inter++;
  const union = a.size + b.size - inter;
  return inter / union > 0.6;
}

/**
 * Build the digest.
 *
 * Deterministic and model-free by design. A digest that costs a model call defeats
 * the purpose of saving tokens, and it makes latency and token cost unpredictable —
 * exactly the two things this is supposed to improve.
 */
export function buildDigest(input: DigestInput): Digest {
  const { question, results } = input;
  const budget = input.budgetTokens ?? 900;
  const intent = input.intent ?? "answer";
  const priorAttributes = new Set((input.priorFacts ?? []).map((f) => f.attribute.toLowerCase()));

  const inputChars = results.reduce((n, r) => n + r.title.length + r.summary.length, 0);
  const inputTokens = results.reduce(
    (n, r) => n + estimateTokens(r.title) + estimateTokens(r.summary),
    0,
  );

  // Cite-able sources: dedupe by URL, keep the highest rerank score.
  const byUrl = new Map<string, (typeof results)[number]>();
  for (const r of results) {
    const existing = byUrl.get(r.url);
    if (!existing || r.rerankScore > existing.rerankScore) byUrl.set(r.url, r);
  }
  const sources = [...byUrl.values()].sort((a, b) => b.rerankScore - a.rerankScore);

  const citations: Citation[] = sources.map((s, i) => ({
    id: i + 1,
    url: s.url,
    title: s.title,
    domain: domainOf(s.url),
    date: s.date,
    authority: s.authority,
  }));

  const queryTerms = new Set(canonTerms(question));
  const subject = (input.subject ?? "").trim();

  interface Candidate {
    /** The claim-sized unit that is selected, scored and attributed. */
    clause: string;
    /** The enclosing sentence, kept for the evidence trail. */
    sentence: string;
    /** Entity the clause was bound to; used to filter when a subject is given. */
    entity: string;
    citationId: number;
    score: number;
    domain: string;
    shingles: Set<string>;
  }

  const candidates: Candidate[] = [];
  for (const src of sources) {
    const citationId = citations.find((c) => c.url === src.url)!.id;
    // The API's `snippet` is usually the opening of `summary`. Concatenating both
    // duplicated every clause in the block, which wastes budget exactly where it
    // is scarcest.
    const summaryText = (src.summary ?? "").trim();
    const snippetText = (src.snippet ?? "").trim();
    const text =
      snippetText && summaryText && !summaryText.includes(snippetText.slice(0, 60))
        ? `${summaryText} ${snippetText}`
        : summaryText || snippetText;
    for (const sentence of sentences(text)) {
      // Score and select at clause granularity, but keep the sentence for context.
      for (const bound of bindClauseEntities(sentence, subject)) {
        let score = salience(bound.clause, queryTerms, intent, priorAttributes);
        if (subject && bound.entity.toLowerCase() === subject.toLowerCase()) score += 1.6;
        if (score <= 0) continue;
        // With a subject, clauses about other entities are not evidence for this
        // item — including them lets the model mix two products' values and
        // spends budget on text that cannot change this item's row.
        if (input.requireSubject && subject && bound.entity.toLowerCase() !== subject.toLowerCase()) {
          continue;
        }
        candidates.push({
          clause: bound.clause,
          sentence,
          entity: bound.entity,
          citationId,
          score,
          domain: domainOf(src.url),
          shingles: shingles(bound.clause),
        });
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  const kept: Candidate[] = [];
  const keptShingles: Set<string>[] = [];
  const seenText = new Set<string>();
  let duplicatesRemoved = 0;
  const totalCandidates = candidates.length;

  for (const c of candidates) {
    // Exact repeats first: short clauses produce no 8-gram shingles, so shingle
    // dedupe alone let short duplicated sentences through.
    const norm = c.clause.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (seenText.has(norm)) {
      duplicatesRemoved++;
      continue;
    }
    if (keptShingles.some((k) => nearDuplicate(c.shingles, k))) {
      duplicatesRemoved++;
      continue;
    }
    seenText.add(norm);
    kept.push(c);
    keptShingles.push(c.shingles);
  }

  // Keep complete claims and their terms together; an oversized claim is a gap.
  const perDomain = new Map<string, number>();
  const maxPerDomain = Math.max(2, Math.ceil(6 / Math.max(1, new Set(sources.map((s) => domainOf(s.url))).size)) + 1);
  const selected: Candidate[] = [];
  let budgetExhausted = false;
  const QUALIFIER_CLAUSE = /\b(annual(?:ly)?|billed|billing|per\s+seat|per\s+user|minimum|requires?|commitment|month-to-month|contract)\b/i;
  function renderCandidates(items: Candidate[]): string {
    const groups = new Map<number, Candidate[]>();
    for (const c of items) groups.set(c.citationId, [...(groups.get(c.citationId) ?? []), c]);
    return [...groups].map(([id, group]) => {
      const cit = citations.find((c) => c.id === id)!;
      return `[${id}] ${cit.domain}${cit.date ? ` ${cit.date.slice(0, 10)}` : ""}${cit.authority >= 0 ? ` auth${cit.authority}` : ""}\n` + group.map((c) => `- ${c.clause}`).join("\n");
    }).join("\n");
  }
  for (const c of kept) {
    if (selected.includes(c)) continue;
    const domainCount = perDomain.get(c.domain) ?? 0;
    if (domainCount >= maxPerDomain) continue;
    const qualifiers = /(?:\$|US\$|₹|€|£)\s?\d/.test(c.clause)
      ? kept.filter((q) => q.citationId === c.citationId && q.entity === c.entity && QUALIFIER_CLAUSE.test(q.clause) && !/(?:\$|US\$|₹|€|£)\s?\d/.test(q.clause)) : [];
    const additions = [...new Set([c, ...qualifiers])].filter((q) => !selected.includes(q));
    if (selected.length + additions.length > 24 || estimateTokens(renderCandidates([...selected, ...additions])) > budget) {
      budgetExhausted = true;
      continue;
    }
    selected.push(...additions);
    perDomain.set(c.domain, domainCount + additions.length);
  }
  const evidenceByCitation = new Map<number, string[]>();
  for (const c of selected) evidenceByCitation.set(c.citationId, [...(evidenceByCitation.get(c.citationId) ?? []), c.clause]);

  // Re-order for prompt placement: strongest first and strongest last, because
  // retrieval attention is U-shaped (better at the start and end of the block).
  const ordered = (() => {
    if (selected.length <= 3) return selected;
    const head = selected.slice(0, 1);
    const tail = selected.slice(-1);
    const middle = selected.slice(1, -1).sort((a, b) => a.score - b.score);
    return [...head, ...middle, ...tail];
  })();

  const facts: Fact[] = [];
  const factKeys = new Set<string>();
  for (const c of selected) {
    for (const bound of bindClauseEntities(c.clause, subject)) {
      // With a subject, only clauses that actually resolve to it may contribute.
      // This is the rule that stops "Windsurf Pro is $15" from becoming a Cursor
      // value just because both appear in the retrieved page.
      if (input.requireSubject && subject && bound.entity.toLowerCase() !== subject.toLowerCase()) {
        continue;
      }
      for (const f of extractFactsFromSentence(bound.clause, bound.entity, c.citationId, null)) {
        const key = `${f.entity.toLowerCase()}::${f.attribute}::${f.value.toLowerCase()}`;
        if (factKeys.has(key)) continue;
        factKeys.add(key);
        if (f.kind === "money") {
          const terms = selected.filter((q) => q !== c && q.citationId === c.citationId && q.entity === c.entity && QUALIFIER_CLAUSE.test(q.clause) && !/(?:\$|US\$|₹|€|£)\s?\d/.test(q.clause));
          f.evidence = [f.evidence, ...terms.map((q) => q.clause)].join(" ");
        }
        facts.push(f);
      }
    }
  }

  const block = renderCandidates(ordered) || "(no usable evidence was retrieved)";

  const digestTokens = estimateTokens(block);

  return {
    block,
    facts,
    citations,
    evidenceByCitation,
    stats: {
      inputChars,
      inputTokens,
      digestTokens,
      ratio: inputTokens > 0 ? digestTokens / inputTokens : 0,
      sentencesKept: selected.length,
      sentencesDropped: totalCandidates - selected.length,
      duplicatesRemoved,
      factsExtracted: facts.length,
      budgetExhausted,
    },
  };
}

/** Candidate subject entities for a sentence, capitalised runs first. */
export function entitiesOf(sentence: string, question: string): string[] {
  const caps = sentence.match(/\b[A-Z][A-Za-z0-9.&'’-]{2,}(?:\s+[A-Z][A-Za-z0-9.&'’-]{2,}){0,2}/g) ?? [];
  const qCaps = question.match(/\b[A-Z][A-Za-z0-9.&'’-]{2,}/g) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of [...qCaps, ...caps]) {
    const k = c.toLowerCase();
    if (seen.has(k) || STOP.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Change detection over facts
// ---------------------------------------------------------------------------

export type ChangeKind = "new" | "updated" | "removed" | "unchanged" | "appeared-missing";

export interface FactChange {
  entity: string;
  attribute: string;
  from: Fact | null;
  to: Fact | null;
  kind: ChangeKind;
  /** Which citations support the new value. */
  citationIds: number[];
}

function sameValue(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[$₹€£,\s]/g, "")
      .replace(/(usd|dollars?|per month|\/mo|per year|\/yr)$/g, "")
      .trim();
  return norm(a) === norm(b);
}

/**
 * Diff prior facts against freshly observed ones. Deterministic and model-free.
 *
 * Only *comparable* pairs are diffed: an attribute present in both snapshots. A
 * value that appears on only one side is reported as `new` or `appeared-missing`
 * rather than as a change, because the search backend returning a different subset
 * of pages is not evidence that the world changed. Conflating those two is the
 * single easiest way to produce a confident false "what changed" report.
 */
export function diffFacts(prior: Fact[], fresh: Fact[]): FactChange[] {
  const changes: FactChange[] = [];
  const keyOf = (f: Fact) => `${f.entity.toLowerCase()}::${f.attribute.toLowerCase()}`;

  const priorByKey = new Map<string, Fact[]>();
  for (const f of prior) {
    const arr = priorByKey.get(keyOf(f)) ?? [];
    arr.push(f);
    priorByKey.set(keyOf(f), arr);
  }
  const freshByKey = new Map<string, Fact[]>();
  for (const f of fresh) {
    const arr = freshByKey.get(keyOf(f)) ?? [];
    arr.push(f);
    freshByKey.set(keyOf(f), arr);
  }

  /** Numeric magnitude, for choosing which previous value a new one replaces. */
  const magnitude = (v: string): number | null => {
    const m = /-?\d+(?:\.\d+)?/.exec(v.replace(/,/g, ""));
    if (!m) return null;
    let n = Number(m[0]);
    if (/billion/i.test(v)) n *= 1e9;
    else if (/million/i.test(v)) n *= 1e6;
    else if (/thousand|\bk\b/i.test(v)) n *= 1e3;
    return n;
  };

  for (const [k, freshFacts] of freshByKey) {
    const priors = [...(priorByKey.get(k) ?? [])];
    const unmatched: Fact[] = [];

    // Pass 1: exact matches are unchanged and are removed from both sides, so a
    // value that simply survived cannot be paired with one that did not.
    for (const f of freshFacts) {
      const idx = priors.findIndex((p) => sameValue(p.value, f.value));
      if (idx >= 0) {
        const match = priors.splice(idx, 1)[0]!;
        changes.push({
          entity: f.entity,
          attribute: f.attribute,
          from: match,
          to: f,
          kind: "unchanged",
          citationIds: [f.citationId],
        });
      } else {
        unmatched.push(f);
      }
    }

    // Pass 2: pair each remaining new value with the previous value it most
    // plausibly replaces. Pairing by array position reported "$20 -> $45" when the
    // real change was "$40 -> $45", because two values share one attribute key.
    for (const f of unmatched) {
      if (priors.length === 0) {
        changes.push({
          entity: f.entity,
          attribute: f.attribute,
          from: null,
          to: f,
          kind: "new",
          citationIds: [f.citationId],
        });
        continue;
      }
      const target = magnitude(f.value);
      let bestIdx = 0;
      if (target !== null) {
        let bestDist = Number.POSITIVE_INFINITY;
        priors.forEach((p, i) => {
          const m = magnitude(p.value);
          if (m === null) return;
          const dist = Math.abs(m - target);
          if (dist < bestDist) {
            bestDist = dist;
            bestIdx = i;
          }
        });
      }
      const prev = priors.splice(bestIdx, 1)[0]!;
      changes.push({
        entity: f.entity,
        attribute: f.attribute,
        from: prev,
        to: f,
        kind: "updated",
        citationIds: [...new Set([f.citationId, prev.citationId])],
      });
    }

    for (const left of priors) {
      changes.push({
        entity: left.entity,
        attribute: left.attribute,
        from: left,
        to: null,
        kind: "appeared-missing",
        citationIds: [left.citationId],
      });
    }
  }

  for (const [k, priors] of priorByKey) {
    if (freshByKey.has(k)) continue;
    for (const f of priors) {
      changes.push({
        entity: f.entity,
        attribute: f.attribute,
        from: f,
        to: null,
        kind: "appeared-missing",
        citationIds: [f.citationId],
      });
    }
  }

  const order: Record<ChangeKind, number> = {
    updated: 0,
    new: 1,
    "appeared-missing": 2,
    unchanged: 3,
    removed: 4,
  };
  return changes.sort((a, b) => order[a.kind] - order[b.kind]);
}
