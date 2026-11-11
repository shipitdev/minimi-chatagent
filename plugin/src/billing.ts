/**
 * Billing terms.
 *
 * A price is not a number. `$21 USD per seat per month, requires annual billing,
 * minimum 20 seats` and `$21 per month` are the same number and different offers,
 * and a chat agent that reports one as the other is wrong in a way that costs the
 * user money.
 *
 * So price facts are parsed into a typed term — amount, currency, unit, period,
 * commitment basis, seat floor — and two prices may only be compared as
 * "changed"/"unchanged" when their terms are actually comparable. Everything else
 * is reported as not directly comparable, with both terms quoted.
 *
 * The failure this prevents is concrete: comparing a monthly-billed figure against
 * an annually-billed per-seat figure and calling the difference a price change.
 */

export type Currency = "USD" | "EUR" | "GBP" | "INR" | "JPY" | "unknown";
export type Period = "month" | "year" | "week" | "day" | "unknown";
export type Billing = "monthly" | "annual" | "unknown";
export type PriceUnit = "seat" | "user" | "account" | "workspace" | "unknown";

export interface PriceTerm {
  amount: number;
  currency: Currency;
  unit: PriceUnit;
  period: Period;
  /** Commitment basis: pay monthly vs annual commitment. Distinct from period. */
  billing: Billing;
  /** Minimum seat count the price is conditional on, when stated. */
  minSeats: number | null;
  /** The clause the term came from, verbatim. */
  raw: string;
  /** Fixture/citation id this term was observed in, when known. */
  sourceId: string | null;
}

const CURRENCY: Array<[RegExp, Currency]> = [
  [/\$|USD/i, "USD"],
  [/€|EUR/i, "EUR"],
  [/£|GBP/i, "GBP"],
  [/₹|INR|Rs\.?/i, "INR"],
  [/¥|JPY/i, "JPY"],
];

const MONEY = /(?:\$|US\$|€|£|₹)\s?(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s?(?:USD|EUR|GBP|INR|JPY)\b/gi;

function detectCurrency(text: string): Currency {
  for (const [re, cur] of CURRENCY) if (re.test(text)) return cur;
  return "unknown";
}

function detectPeriod(text: string): Period {
  if (/\b(?:per\s+month|a\s+month|\/\s?mo(?:nth)?\b|monthly|month-to-month|month to month)\b/i.test(text)) {
    return "month";
  }
  if (/\b(?:per\s+year|a\s+year|\/\s?yr|annum|annual\w*|yearly)\b/i.test(text)) return "year";
  if (/\b(?:per\s+week|\/\s?wk|weekly)\b/i.test(text)) return "week";
  if (/\b(?:per\s+day|\/\s?day|daily)\b/i.test(text)) return "day";
  return "unknown";
}

function detectBilling(text: string): Billing {
  // "annual billing" / "billed annually" / "requires annual" is a *commitment*,
  // which is not the same as pricing *per year*.
  if (/\b(?:annual(?:ly)?\s+billing|billed\s+annual(?:ly)?|requires?\s+annual|annual\s+commitment|annual\s+plan|paid\s+annual(?:ly)?)\b/i.test(text)) {
    return "annual";
  }
  if (/\b(?:billed\s+month(?:ly)?|monthly\s+billing|month-to-month|month to month|pay\s+as\s+you\s+go|no\s+commitment)\b/i.test(text)) {
    return "monthly";
  }
  return "unknown";
}

function detectUnit(text: string): PriceUnit {
  if (/\bper\s+seat\b|\/\s?seat\b|\bseat\b/i.test(text)) return "seat";
  if (/\bper\s+user\b|\/\s?user\b/i.test(text)) return "user";
  if (/\bper\s+workspace\b|\bper\s+team\b/i.test(text)) return "workspace";
  if (/\bper\s+account\b|\bflat\b|\bone\s+price\b/i.test(text)) return "account";
  return "unknown";
}

function detectMinSeats(text: string): number | null {
  const m = /\bminimum(?:\s+of)?[:\s]+(\d{1,5})\s*seats?\b|\b(\d{1,5})[-\s]seat\s+minimum\b|\bminimum\s+(\d{1,5})\b/i.exec(
    text,
  );
  if (!m) return null;
  const raw = m[1] ?? m[2] ?? m[3];
  return raw ? Number(raw) : null;
}

/** Parse every price term in a piece of text. Deduplicated by amount+terms. */
export function parsePriceTerms(text: string, sourceId: string | null = null): PriceTerm[] {
  if (!text) return [];
  const out: PriceTerm[] = [];
  const seen = new Set<string>();
  MONEY.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MONEY.exec(text)) !== null) {
    const amountText = m[1] ?? m[2] ?? "";
    const amount = Number(amountText.replace(/,/g, ""));
    if (!Number.isFinite(amount)) continue;

    // The terms governing a figure are usually in its own sentence, sometimes the
    // next one ("This price requires annual billing. Minimum: 20 seats.").
    const windowStart = Math.max(0, m.index - 120);
    const windowEnd = Math.min(text.length, m.index + 260);
    const context = text.slice(windowStart, windowEnd);

    const term: PriceTerm = {
      amount,
      currency: detectCurrency(context),
      unit: detectUnit(context),
      period: detectPeriod(context),
      billing: detectBilling(context),
      minSeats: detectMinSeats(context),
      raw: context.trim().slice(0, 240),
      sourceId,
    };
    const key = `${term.amount}|${term.currency}|${term.unit}|${term.period}|${term.billing}|${term.minSeats}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out;
}

/** The monthly-equivalent figure, used only for display, never for a claim. */
export function monthlyEquivalent(t: PriceTerm): number | null {
  if (t.period === "month") return t.amount;
  if (t.period === "year") return t.amount / 12;
  if (t.period === "week") return (t.amount * 52) / 12;
  if (t.period === "day") return (t.amount * 365) / 12;
  return null;
}

export type ComparisonStatus = "changed" | "unchanged" | "incomparable";

export interface PriceComparison {
  status: ComparisonStatus;
  oldTerm: PriceTerm | null;
  newTerm: PriceTerm | null;
  /** Monthly-equivalent delta, only when comparable. */
  deltaMonthly: number | null;
  /** Percentage change of the monthly-equivalent, only when comparable. */
  pctChange: number | null;
  /** Why they cannot be compared, when status is incomparable. */
  reason: string | null;
}

/**
 * Compare two observed terms.
 *
 * Deliberately strict: a comparison is only "changed"/"unchanged" when currency,
 * unit, period *and* commitment basis all agree. Anything else is `incomparable`,
 * which the answer layer must render as two quoted terms rather than a delta.
 */
export function comparePriceTerms(oldTerm: PriceTerm | null, newTerm: PriceTerm | null): PriceComparison {
  if (!oldTerm) {
    return { status: "incomparable", oldTerm, newTerm, deltaMonthly: null, pctChange: null, reason: "no prior price was recorded" };
  }
  if (!newTerm) {
    return { status: "incomparable", oldTerm, newTerm, deltaMonthly: null, pctChange: null, reason: "no current price was established" };
  }
  const mismatch: string[] = [];
  for (const key of ["currency", "unit", "period", "billing"] as const) {
    if (oldTerm[key] === "unknown" || newTerm[key] === "unknown") mismatch.push(`${key} is unclear`);
    else if (oldTerm[key] !== newTerm[key]) mismatch.push(`${key} (${oldTerm[key]} vs ${newTerm[key]})`);
  }
  if (oldTerm.minSeats !== newTerm.minSeats) mismatch.push(`minimum seats (${oldTerm.minSeats ?? "unspecified"} vs ${newTerm.minSeats ?? "unspecified"})`);
  if (mismatch.length > 0) {
    return {
      status: "incomparable",
      oldTerm,
      newTerm,
      deltaMonthly: null,
      pctChange: null,
      reason: `not directly comparable: differing ${mismatch.join(", ")}`,
    };
  }

  const a = monthlyEquivalent(oldTerm);
  const b = monthlyEquivalent(newTerm);
  if (a === null || b === null) {
    return { status: "incomparable", oldTerm, newTerm, deltaMonthly: null, pctChange: null, reason: "billing period is unclear" };
  }
  const delta = Math.round((b - a) * 100) / 100;
  return {
    status: delta === 0 ? "unchanged" : "changed",
    oldTerm,
    newTerm,
    deltaMonthly: delta,
    pctChange: a !== 0 ? Math.round(((b - a) / a) * 1000) / 10 : null,
    reason: null,
  };
}

/** Human-readable term, always stating the commitment basis. */
export function formatTerm(t: PriceTerm | null): string {
  if (!t) return "unknown";
  const cur = t.currency === "USD" ? "$" : t.currency === "EUR" ? "€" : t.currency === "GBP" ? "£" : "";
  const unit = t.unit === "unknown" ? "" : ` per ${t.unit}`;
  const period = t.period === "unknown" ? "" : ` per ${t.period}`;
  const billing =
    t.billing === "unknown" ? "" : t.billing === "annual" ? ", annual commitment" : ", monthly billing";
  const seats = t.minSeats !== null ? `, ${t.minSeats}-seat minimum` : "";
  return `${cur}${t.amount}${cur ? "" : ` ${t.currency}`}${unit}${period}${billing}${seats}`;
}

/**
 * Find the terms a question asks about and the terms an answer must preserve.
 * Used to decide whether a comparison is even the right response.
 */
export function mentionsPriceTerms(text: string): boolean {
  return MONEY.test(text) || /\b(?:price|pricing|rate|cost|billed|billing|per seat|monthly)\b/i.test(text);
}

/** Reset the sticky global regex before reuse (MONEY is stateful with /g). */
export function resetPriceScanner(): void {
  MONEY.lastIndex = 0;
}
