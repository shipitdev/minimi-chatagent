/**
 * Timezone-aware time handling.
 *
 * Rule for the whole app: **store instants in UTC epoch milliseconds, store the
 * timezone alongside**. Never store a wall-clock string as the source of truth —
 * a user who says "yesterday" means yesterday *where they were when they said
 * it*, and that turns into two different UTC windows for two users.
 */

export interface ZonedInstant {
  /** UTC epoch milliseconds — the only durable representation of an instant. */
  utc: number;
  /** IANA zone the user was in, e.g. "Asia/Calcutta". */
  tz: string;
}

export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function resolveTimeZone(tz: string | undefined, fallback = "UTC"): string {
  if (tz && isValidTimeZone(tz)) return tz;
  return isValidTimeZone(fallback) ? fallback : "UTC";
}

/** Minutes east of UTC at the given instant (positive for Asia, negative for US). */
export function tzOffsetMinutes(utcMs: number, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: resolveTimeZone(tz),
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour === "24" ? "00" : parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return Math.round((asUtc - utcMs) / 60000);
}

/** Format an instant for display in a zone, e.g. "Tue 11 Nov 2026, 17:12". */
export function formatInZone(utcMs: number, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: resolveTimeZone(tz),
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(utcMs));
}

/** ISO date (YYYY-MM-DD) of an instant as seen in a zone. */
export function isoDateInZone(utcMs: number, tz: string): string {
  const off = tzOffsetMinutes(utcMs, tz);
  const shifted = new Date(utcMs + off * 60000);
  return shifted.toISOString().slice(0, 10);
}

/**
 * Convert a wall-clock date (Y-M-D) in a zone to the UTC instant of its midnight.
 * Done by search rather than arithmetic because fixed offsets are wrong across DST
 * boundaries: we walk to the point where the zone's local date changes.
 */
export function zonedDayStartUtc(year: number, month: number, day: number, tz: string): number {
  const target = Date.UTC(year, month - 1, day);
  // Start from an approximation using the offset at that instant, then correct.
  let guess = target - tzOffsetMinutes(target, tz) * 60000;
  for (let i = 0; i < 4; i++) {
    const off = tzOffsetMinutes(guess, tz);
    const next = target - off * 60000;
    if (Math.abs(next - guess) < 1000) return next;
    guess = next;
  }
  return guess;
}

export interface DayRange {
  /** Inclusive start, UTC ms. */
  startUtc: number;
  /** Exclusive end, UTC ms. */
  endUtc: number;
  /** The local calendar date this range represents. */
  isoDate: string;
}

export function dayRange(utcMs: number, tz: string): DayRange {
  const off = tzOffsetMinutes(utcMs, tz);
  const local = new Date(utcMs + off * 60000);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth() + 1;
  const d = local.getUTCDate();
  const startUtc = zonedDayStartUtc(y, m, d, tz);
  // Next day's start is found by advancing the local date, not by adding 24h:
  // a DST transition day is 23 or 25 hours long.
  const nextLocal = new Date(Date.UTC(y, m - 1, d + 1));
  const endUtc = zonedDayStartUtc(
    nextLocal.getUTCFullYear(),
    nextLocal.getUTCMonth() + 1,
    nextLocal.getUTCDate(),
    tz,
  );
  const isoDate = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return { startUtc, endUtc, isoDate };
}

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

export interface ResolvedTimeRange {
  startUtc: number;
  endUtc: number;
  /** Human label, already expressed in the zone, for citing back to the user. */
  label: string;
  /** The phrase that produced this range, for the audit trail. */
  matched: string;
  confidence: number;
}

/**
 * Resolve a natural-language time reference to a UTC window in a zone.
 *
 * Deliberately a deterministic parser rather than a model call: date arithmetic
 * is exactly the kind of thing a small model gets subtly wrong, and a wrong window
 * silently returns the wrong conversation, which is unrecoverable downstream.
 * Cases not handled here fall through to a model-assisted range, which is flagged
 * with lower confidence.
 */
export function resolveTimeReference(
  phrase: string,
  referenceUtc: number,
  tz: string,
): ResolvedTimeRange | null {
  const q = phrase.toLowerCase().trim();
  if (!q) return null;
  const today = dayRange(referenceUtc, tz);
  const refLocal = new Date(referenceUtc + tzOffsetMinutes(referenceUtc, tz) * 60000);
  const shiftDays = (n: number): DayRange => {
    const base = Date.UTC(refLocal.getUTCFullYear(), refLocal.getUTCMonth(), refLocal.getUTCDate() + n);
    const d = new Date(base);
    const start = zonedDayStartUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), tz);
    const nxt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
    const end = zonedDayStartUtc(nxt.getUTCFullYear(), nxt.getUTCMonth() + 1, nxt.getUTCDate(), tz) ;
    return { startUtc: start, endUtc: end, isoDate: isoDateInZone(start, tz) };
  };
  const span = (from: DayRange, to: DayRange) => ({
    startUtc: from.startUtc,
    endUtc: to.endUtc,
  });

  if (/\btoday\b/.test(q)) {
    return { ...span(today, today), label: `today (${today.isoDate})`, matched: "today", confidence: 1 };
  }
  if (/\byesterday\b/.test(q)) {
    const d = shiftDays(-1);
    return { ...span(d, d), label: `yesterday (${d.isoDate})`, matched: "yesterday", confidence: 1 };
  }
  if (/\bday before yesterday\b/.test(q)) {
    const d = shiftDays(-2);
    return { ...span(d, d), label: `the day before yesterday (${d.isoDate})`, matched: "day before yesterday", confidence: 1 };
  }
  const agoMatch = q.match(/\b(\d{1,3})\s+days?\s+ago\b/);
  if (agoMatch) {
    const n = Number(agoMatch[1]);
    const d = shiftDays(-n);
    return { ...span(d, d), label: `${n} days ago (${d.isoDate})`, matched: agoMatch[0], confidence: 1 };
  }
  if (/\blast week\b|\bthe past week\b|\bprevious week\b/.test(q)) {
    const a = shiftDays(-7);
    return { ...span(a, today), label: "the last 7 days", matched: "last week", confidence: 0.8 };
  }
  if (/\blast month\b|\bthe past month\b|\bprevious month\b/.test(q)) {
    const a = shiftDays(-30);
    return { ...span(a, today), label: "the last 30 days", matched: "last month", confidence: 0.8 };
  }
  if (/\bthis week\b/.test(q)) {
    const dow = refLocal.getUTCDay();
    const mondayOffset = dow === 0 ? -6 : 1 - dow;
    const start = shiftDays(mondayOffset);
    return { ...span(start, today), label: "this week", matched: "this week", confidence: 0.9 };
  }
  const weekday =
    q.match(/\b(?:last|on|this)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thurs|fri|sat)\b/);
  if (weekday && weekday[1]) {
    const want = WEEKDAYS[weekday[1]];
    if (want !== undefined) {
      const dow = refLocal.getUTCDay();
      let back = (dow - want + 7) % 7;
      const explicitLast = /\blast\b/.test(q);
      if (back === 0 && explicitLast) back = 7;
      if (back === 0) back = 0;
      const d = shiftDays(-back);
      return {
        ...span(d, d),
        label: `${explicitLast ? "last " : ""}${weekday[1]} (${d.isoDate})`,
        matched: weekday[0].trim(),
        confidence: explicitLast ? 1 : 0.85,
      };
    }
  }
  // Explicit ISO date.
  const iso = q.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) {
    const y = Number(iso[1]);
    const m = Number(iso[2]);
    const d = Number(iso[3]);
    const start = zonedDayStartUtc(y, m, d, tz);
    const nxt = new Date(Date.UTC(y, m - 1, d + 1));
    const end = zonedDayStartUtc(nxt.getUTCFullYear(), nxt.getUTCMonth() + 1, nxt.getUTCDate(), tz);
    return {
      startUtc: start,
      endUtc: end,
      label: `${iso[1]}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
      matched: iso[0],
      confidence: 1,
    };
  }
  // Month-first ("Nov 3", "November 3rd"). Kept ahead of the day-first form
  // because "Nov 3" is the phrasing people actually use.
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const monthFirst = q.match(
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/,
  );
  if (monthFirst) {
    const mi = months.indexOf(monthFirst[1]!.slice(0, 3)) + 1;
    const d = Number(monthFirst[2]);
    // Resolve to the most recent occurrence that is not in the future.
    let y = refLocal.getUTCFullYear();
    let start = zonedDayStartUtc(y, mi, d, tz);
    if (start > referenceUtc) {
      y -= 1;
      start = zonedDayStartUtc(y, mi, d, tz);
    }
    const nxt = new Date(Date.UTC(y, mi - 1, d + 1));
    const end = zonedDayStartUtc(nxt.getUTCFullYear(), nxt.getUTCMonth() + 1, nxt.getUTCDate(), tz);
    return {
      startUtc: start,
      endUtc: end,
      label: `${d} ${months[mi - 1]} ${y} (${tz})`,
      matched: monthFirst[0],
      confidence: 1,
    };
  }

  const dayMonth = q.match(/\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/);
  if (dayMonth) {
    const mi = months.indexOf(dayMonth[2]!.slice(0, 3)) + 1;
    const d = Number(dayMonth[1]);
    const y = refLocal.getUTCFullYear();
    const start = zonedDayStartUtc(y, mi, d, tz);
    const nxt = new Date(Date.UTC(y, mi - 1, d + 1));
    const end = zonedDayStartUtc(nxt.getUTCFullYear(), nxt.getUTCMonth() + 1, nxt.getUTCDate(), tz);
    return { startUtc: start, endUtc: end, label: `${d} ${months[mi - 1]} ${y}`, matched: dayMonth[0], confidence: 0.9 };
  }
  return null;
}

/** Extract any time phrase present in a message, longest-first. */
export function findTimePhrase(text: string): string | null {
  const q = text.toLowerCase();
  // Explicit dates are resolved before relative ones. "Last Tuesday … I mean the
  // comparison on Nov 3" is a user correcting themselves, and picking the weekday
  // because it appears first silently answers about the wrong day.
  const explicit = [
    /\b\d{4}-\d{1,2}-\d{1,2}\b/,
    /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?\b/,
    /\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/,
  ];
  for (const p of explicit) {
    const m = q.match(p);
    if (m) return m[0];
  }
  const relative = [
    /\b(\d{1,3})\s+days?\s+ago\b/,
    /\bday before yesterday\b/,
    /\byesterday\b/,
    /\btoday\b/,
    /\b(?:the\s+)?(?:past|last)\s+(?:week|month)\b/,
    /\bthis week\b/,
    /\blast\s+(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thurs|fri|sat)\b/,
    /\b(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thurs|fri|sat)\b/,
  ];
  for (const p of relative) {
    const m = q.match(p);
    if (m) return m[0];
  }
  return null;
}
