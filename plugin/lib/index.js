// plugin/src/index.ts
import fs3 from "node:fs";
import path4 from "node:path";

// plugin/src/config.ts
import path from "node:path";
function num(name2, fallback) {
  const raw = process.env[name2];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
var config = {
  /** DeepSeek Search/Fetch REST root. Chat traffic stays on the DSH adapter. */
  searchBaseUrl: (process.env.MINIMI_SEARCH_BASE_URL ?? "https://api.deepseek.com").replace(/\/+$/, ""),
  apiKey: process.env.DEEPSEEK_API_KEY ?? "",
  dbPath: path.resolve(process.env.MINIMI_DB ?? "./data/minimi.db"),
  defaultTz: process.env.MINIMI_DEFAULT_TZ ?? "auto",
  digestTokens: num("MINIMI_DIGEST_TOKENS", 900),
  concurrency: Math.max(1, num("MINIMI_SEARCH_CONCURRENCY", 3)),
  maxQueriesPerCall: Math.max(1, Math.min(3, num("MINIMI_MAX_QUERIES_PER_CALL", 3))),
  maxCallsPerTurn: Math.max(1, num("MINIMI_MAX_CALLS_PER_TURN", 2)),
  maxProviderAttemptsPerTurn: Math.max(1, num("MINIMI_MAX_PROVIDER_ATTEMPTS_PER_TURN", 12)),
  maxResultsPerQuery: Math.max(1, Math.min(20, num("MINIMI_MAX_RESULTS_PER_QUERY", 8))),
  searchTimeoutMs: num("MINIMI_SEARCH_TIMEOUT_MS", 25e3),
  debug: process.env.MINIMI_DEBUG === "1",
  /** Read-only fixture directory for deterministic tests: a JSON map query -> results. */
  fixtures: process.env.MINIMI_SEARCH_FIXTURES ?? ""
};
function assertSearchConfigured() {
  if (config.fixtures) return;
  if (!config.apiKey) {
    throw new Error(
      "DEEPSEEK_API_KEY is not set. Copy .env.example to .env and add a key from https://platform.deepseek.com/api_keys."
    );
  }
}
function debugLog(...args) {
  if (config.debug) console.log("[minimi]", ...args);
}

// plugin/src/memory.ts
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path2 from "node:path";

// plugin/src/time.ts
function isValidTimeZone(tz) {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
function resolveTimeZone(tz, fallback = "UTC") {
  if (tz && isValidTimeZone(tz)) return tz;
  return isValidTimeZone(fallback) ? fallback : "UTC";
}
function tzOffsetMinutes(utcMs, tz) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: resolveTimeZone(tz),
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour === "24" ? "00" : parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return Math.round((asUtc - utcMs) / 6e4);
}
function formatInZone(utcMs, tz) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: resolveTimeZone(tz),
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(utcMs));
}
function zonedDayStartUtc(year, month, day, tz) {
  const target = Date.UTC(year, month - 1, day);
  let guess = target - tzOffsetMinutes(target, tz) * 6e4;
  for (let i = 0; i < 4; i++) {
    const off = tzOffsetMinutes(guess, tz);
    const next = target - off * 6e4;
    if (Math.abs(next - guess) < 1e3) return next;
    guess = next;
  }
  return guess;
}

// plugin/src/memory.ts
function subjectKey(subject) {
  return subject.toLowerCase().normalize("NFKC").replace(/[^a-z0-9]+/g, " ").trim();
}
var STOP = new Set(
  `the a an and or but if of to in on for with is are was were be been it its this that these those
   as at by from we you they he she my your our their me us them do does did so than then there here
   what which who when where how why can could should would will just about into not no yes also more
   most other such only own same very s t don now i you've i've whats what's told tell said say
   remember recall discussed discuss talked talk conversation earlier previous before again please
   answer question tell`.split(/\s+/).filter(Boolean)
);
function keywords(text) {
  return [...new Set((text.toLowerCase().normalize("NFKC").match(/[a-z0-9][a-z0-9.+#-]*/g) ?? []).map((w) => w.replace(/\.+$/, "")).filter((w) => w.length > 2 && !STOP.has(w)))];
}
function includesAny(haystack, words) {
  const h = haystack.toLowerCase();
  let n = 0;
  for (const w of words) if (h.includes(w)) n++;
  return n;
}
var MemoryStore = class {
  db;
  constructor(file = config.dbPath) {
    fs.mkdirSync(path2.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS turns (
        session_id TEXT NOT NULL,
        turn INTEGER NOT NULL,
        tz TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        user_text TEXT NOT NULL DEFAULT '',
        assistant_text TEXT NOT NULL DEFAULT '',
        interrupted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, turn)
      );
      CREATE INDEX IF NOT EXISTS idx_turns_started ON turns(started_at);
      CREATE TABLE IF NOT EXISTS facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        turn INTEGER NOT NULL,
        entity TEXT NOT NULL,
        attribute TEXT NOT NULL,
        value TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'other',
        citation_id TEXT NOT NULL,
        url TEXT NOT NULL,
        title TEXT NOT NULL,
        published_at TEXT,
        retrieved_at TEXT NOT NULL,
        qualifiers TEXT NOT NULL DEFAULT '[]',
        evidence TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_facts_entity ON facts(entity);
      CREATE INDEX IF NOT EXISTS idx_facts_created ON facts(created_at);
      CREATE TABLE IF NOT EXISTS snapshots (
        subject_key TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        facts TEXT NOT NULL,
        citations TEXT NOT NULL,
        session_id TEXT,
        tz TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS searches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        turn INTEGER NOT NULL,
        intent TEXT NOT NULL,
        items TEXT NOT NULL,
        digest TEXT NOT NULL,
        citations TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_searches_created ON searches(created_at);
    `);
  }
  close() {
    try {
      this.db.close();
    } catch {
    }
  }
  /** Erase all Minimi state attached to one DSH session. */
  deleteSession(sessionId) {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM turns WHERE session_id = ?").run(sessionId);
      this.db.prepare("DELETE FROM facts WHERE session_id = ?").run(sessionId);
      this.db.prepare("DELETE FROM searches WHERE session_id = ?").run(sessionId);
      this.db.prepare("DELETE FROM snapshots WHERE session_id = ?").run(sessionId);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
      }
      throw error;
    }
  }
  beginTurn(sessionId, turn, tz, startedAt = Date.now()) {
    this.db.prepare(`
      INSERT INTO turns (session_id, turn, tz, started_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id, turn) DO UPDATE SET tz = excluded.tz
    `).run(sessionId, turn, tz, startedAt);
  }
  setUser(sessionId, turn, text, tz) {
    this.beginTurn(sessionId, turn, tz);
    this.db.prepare(`UPDATE turns SET user_text = ? WHERE session_id = ? AND turn = ?`).run(text, sessionId, turn);
  }
  setAssistant(sessionId, turn, text, interrupted) {
    this.db.prepare(`UPDATE turns SET assistant_text = ?, interrupted = ? WHERE session_id = ? AND turn = ?`).run(text, interrupted ? 1 : 0, sessionId, turn);
  }
  recordFacts(sessionId, turn, facts, createdAt = Date.now()) {
    if (!facts.length) return;
    const insert = this.db.prepare(`
      INSERT INTO facts
        (session_id, turn, entity, attribute, value, kind, citation_id, url, title,
         published_at, retrieved_at, qualifiers, evidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const f of facts) {
      insert.run(
        sessionId,
        turn,
        f.entity,
        f.attribute,
        f.value,
        f.kind,
        f.citationId,
        f.url,
        f.title,
        f.publishedAt,
        f.retrievedAt,
        JSON.stringify(f.qualifiers),
        f.evidence,
        createdAt
      );
    }
  }
  recordSearch(sessionId, turn, intent, items, digest, citations, attempts, createdAt = Date.now()) {
    this.db.prepare(`
      INSERT INTO searches (session_id, turn, intent, items, digest, citations, attempts, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, turn, intent, JSON.stringify(items), digest, JSON.stringify(citations), attempts, createdAt);
  }
  saveSnapshot(snapshot) {
    this.db.prepare(`
      INSERT INTO snapshots (subject_key, subject, facts, citations, session_id, tz, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(subject_key) DO UPDATE SET
        subject = excluded.subject,
        facts = excluded.facts,
        citations = excluded.citations,
        session_id = excluded.session_id,
        tz = excluded.tz,
        updated_at = excluded.updated_at
    `).run(
      snapshot.subjectKey,
      snapshot.subject,
      JSON.stringify(snapshot.facts),
      JSON.stringify(snapshot.citations),
      snapshot.sessionId,
      snapshot.tz,
      snapshot.updatedAt
    );
  }
  getSnapshot(subject) {
    const key = subjectKey(subject);
    const row = this.db.prepare(`SELECT * FROM snapshots WHERE subject_key = ?`).get(key);
    if (!row) return null;
    return {
      subject: String(row.subject),
      subjectKey: String(row.subject_key),
      facts: JSON.parse(String(row.facts)),
      citations: JSON.parse(String(row.citations)),
      updatedAt: Number(row.updated_at),
      tz: String(row.tz),
      sessionId: row.session_id == null ? null : String(row.session_id)
    };
  }
  snapshotCount() {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM snapshots`).get();
    return Number(row.n);
  }
  turnCount() {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM turns`).get();
    return Number(row.n);
  }
  /**
   * Retrieve the right earlier observation by date and topic. Date phrases are
   * resolved in the conversation's IANA zone; facts and snapshots are matched by
   * entity/attribute/value text. Falls back to recent records for bare recall
   * cues such as "what did we discuss?".
   */
  recall(input) {
    const now = input.now ?? Date.now();
    const tz = resolveTimeZone(input.tz, "UTC");
    const words = keywords(input.userText);
    const window = resolveWindow(input.userText, tz, now);
    const recallCue = /\b(remember|recall|discuss|talked|told|said|earlier|previous|before|yesterday|last\s+time|last\s+week|last\s+month|history|conversation|we\s+spoke)\b/i.test(input.userText);
    const changeCue = /\b(change|changed|update|updated|latest|current|now|compare|since|re-?check)\b/i.test(input.userText);
    const commitmentCue = /\b(promise|promised|outstanding|owe|owed|deliverable|deadline|still\s+(?:open|need|pending|gotta)|gotta|to\s+do|todo|follow\s*up|remains?)\b/i.test(input.userText);
    const notesCue = /\b(notes?|recap|summari[sz]e|summary)\b/i.test(input.userText);
    const turnRows = this.db.prepare(`
      SELECT * FROM turns ORDER BY started_at DESC LIMIT 400
    `).all();
    const turns = turnRows.map((r) => ({
      sessionId: String(r.session_id),
      turn: Number(r.turn),
      tz: String(r.tz),
      startedAt: Number(r.started_at),
      userText: String(r.user_text ?? ""),
      assistantText: String(r.assistant_text ?? ""),
      interrupted: Number(r.interrupted) === 1
    }));
    const scoredTurns = turns.filter((t) => !(t.sessionId === input.excludeSessionId && t.turn === input.excludeTurn)).filter((t) => !window || t.startedAt >= window.from && t.startedAt <= window.to).map((t) => {
      let score = includesAny(`${t.userText}
${t.assistantText}`, words) * 2;
      if (window) score += 1.5;
      if (recallCue) score += 0.5;
      if (commitmentCue) score += 0.3;
      if (notesCue) score += 0.2;
      if (t.assistantText.trim()) score += 0.2;
      return { t, score };
    }).filter(({ t, score }) => {
      if (!t.userText.trim()) return false;
      if (words.length === 0) return Boolean(window) || recallCue;
      return includesAny(`${t.userText}
${t.assistantText}`, words) > 0 || Boolean(window) || (commitmentCue || notesCue) && t.startedAt >= now - 30 * 864e5;
    }).sort((a, b) => b.score - a.score || b.t.startedAt - a.t.startedAt).slice(0, input.limitTurns ?? 6).map(({ t }) => t);
    const factRows = this.db.prepare(`SELECT * FROM facts ORDER BY created_at DESC LIMIT 600`).all();
    const facts = factRows.map((r) => ({
      row: r,
      score: includesAny(`${r.entity} ${r.attribute} ${r.value} ${r.evidence}`, words)
    })).filter(({ row, score }) => {
      if (window && (Number(row.created_at) < window.from || Number(row.created_at) > window.to)) return false;
      if (words.length === 0) return Boolean(window) || changeCue;
      return score > 0;
    }).sort((a, b) => b.score - a.score || Number(b.row.created_at) - Number(a.row.created_at)).slice(0, input.limitFacts ?? 8).map(({ row }) => ({
      entity: String(row.entity),
      attribute: String(row.attribute),
      value: String(row.value),
      kind: String(row.kind),
      citationId: String(row.citation_id),
      url: String(row.url),
      title: String(row.title),
      publishedAt: row.published_at == null ? null : String(row.published_at),
      retrievedAt: String(row.retrieved_at),
      qualifiers: JSON.parse(String(row.qualifiers ?? "[]")),
      evidence: String(row.evidence ?? "")
    }));
    const snapRows = this.db.prepare(`SELECT * FROM snapshots ORDER BY updated_at DESC LIMIT 100`).all();
    const snapshots = snapRows.map((r) => ({
      row: r,
      score: includesAny(`${r.subject} ${r.facts}`, words)
    })).filter(({ row, score }) => (!window || Number(row.updated_at) >= window.from && Number(row.updated_at) <= window.to) && (words.length === 0 ? Boolean(changeCue) : score > 0)).sort((a, b) => b.score - a.score || Number(b.row.updated_at) - Number(a.row.updated_at)).slice(0, input.limitSnapshots ?? 4).map(({ row }) => ({
      subject: String(row.subject),
      subjectKey: String(row.subject_key),
      facts: JSON.parse(String(row.facts)),
      citations: JSON.parse(String(row.citations)),
      updatedAt: Number(row.updated_at),
      tz: String(row.tz),
      sessionId: row.session_id == null ? null : String(row.session_id)
    }));
    return { turns: scoredTurns, facts, snapshots, window, now };
  }
};
function resolveWindow(text, tz, now) {
  const t = text.toLowerCase();
  const [year, month, date] = dateParts(now, tz);
  const start = (y, m, d) => {
    const normalized = new Date(Date.UTC(y, m - 1, d));
    return zonedDayStartUtc(normalized.getUTCFullYear(), normalized.getUTCMonth() + 1, normalized.getUTCDate(), tz);
  };
  const range = (from, to, label) => ({ from, to: to - 1, label });
  const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const monthIndex = (name2) => {
    const key = name2.toLowerCase().replace(/\./g, "");
    const full = months.findIndex((m) => m === key);
    if (full >= 0) return full + 1;
    const abbrev = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(key.slice(0, 3));
    return abbrev >= 0 ? abbrev + 1 : 0;
  };
  const iso = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(t);
  if (iso) {
    const from = zonedDayStartUtc(Number(iso[1]), Number(iso[2]), Number(iso[3]), tz);
    return range(from, start(Number(iso[1]), Number(iso[2]), Number(iso[3]) + 1), iso[0]);
  }
  const monthName = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
  const md = new RegExp(`\\b${monthName}\\s+(\\d{1,2})(?:,?\\s+(20\\d{2}))?\\b`, "i").exec(text);
  const dm = new RegExp(`\\b(\\d{1,2})\\s+${monthName}(?:,?\\s+(20\\d{2}))?\\b`, "i").exec(text);
  if (md || dm) {
    const day = md ? Number(md[2]) : Number(dm[1]);
    const monthToken = md ? md[1] : dm[2];
    const yearToken = md ? md[3] : dm[3];
    const m = monthIndex(monthToken);
    if (!m) return null;
    const y = yearToken ? Number(yearToken) : year;
    return range(zonedDayStartUtc(y, m, day, tz), start(y, m, day + 1), (md ?? dm)[0]);
  }
  const ordinal = /\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\b/i.exec(text);
  if (ordinal) {
    const day = Number(ordinal[1]);
    return range(start(year, month, day), start(year, month, day + 1), ordinal[0]);
  }
  const today = start(year, month, date);
  if (/\bday before yesterday\b/.test(t)) return range(start(year, month, date - 2), start(year, month, date - 1), "day before yesterday");
  if (/\byesterday\b/.test(t)) return range(start(year, month, date - 1), today, "yesterday");
  if (/\btoday\b/.test(t)) return { from: today, to: now, label: "today" };
  const dow = new Date(Date.UTC(year, month - 1, date)).getUTCDay();
  const monday = date - (dow + 6) % 7;
  if (/\blast\s+week\b/.test(t)) return range(start(year, month, monday - 7), start(year, month, monday), "last week (Monday\u2013Sunday)");
  if (/\bthis\s+week\b/.test(t)) return { from: start(year, month, monday), to: now, label: "this week" };
  if (/\blast\s+month\b/.test(t)) return range(start(year, month - 1, 1), start(year, month, 1), "last month");
  if (/\bthis\s+month\b/.test(t)) return { from: start(year, month, 1), to: now, label: "this month" };
  return null;
}
function dateParts(now, tz) {
  const parts = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: tz }).formatToParts(new Date(now));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  return [get("year"), get("month"), get("day")];
}
function describeTurn(t) {
  const when = formatInZone(t.startedAt, t.tz);
  const user = t.userText.replace(/\s+/g, " ").trim().slice(0, 320);
  const answer = t.assistantText.replace(/\s+/g, " ").trim().slice(0, 520);
  return `- ${when} [session ${t.sessionId.replace(/^session-/, "").slice(0, 8)}, turn ${t.turn}] user: "${user}"${answer ? ` => ${answer}` : ""}`;
}

// plugin/src/digest.ts
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 3.6) + 2;
}
var SENTENCE_SPLIT = /(?<=[.!?])\s+(?=[A-Z0-9"“(])|\n+/;
function sentences(text) {
  return text.replace(/\s+/g, " ").split(SENTENCE_SPLIT).map((s) => s.trim()).filter((s) => s.length > 12);
}
var STOP2 = new Set(
  `the a an and or but if of to in on for with is are was were be been it its this that these
   those as at by from we you they he she my your our their me us them do does did so than then
   there here what which who when where how why can could should would will just about into not
   no yes also more most other such only own same very s t don now`.split(/\s+/)
);
function canonTerms(text) {
  return (text.toLowerCase().replace(/[-_]/g, " ").match(/[a-z0-9][a-z0-9'’]*/g) ?? []).filter(
    (t) => t.length > 1 && !STOP2.has(t)
  );
}
var BOILERPLATE = /(cookie|consent|subscribe|newsletter|sign up|log ?in|privacy policy|terms of (use|service)|advertis|sponsored|all rights reserved|share this|follow us|click here|read more|skip to (content|main)|javascript is disabled|enable javascript|we use cookies|accept all)/i;
var NAVIGATION = /^(home|menu|search|contact|about us|products|services|blog|news)\b/i;
var CHANGE_VERBS = /\b(launch(ed|es|ing)?|release(d|s)?|announc(e|ed|es|ing)|introduc(e|ed|es)|deprecat(e|ed|es)|retir(e|ed)|discontinu(e|ed)|renam(e|ed)|acquir(e|ed)|merge(d|s)?|rais(e|ed)|cut|lower(ed)?|increas(e|ed)|decreas(e|ed)|replac(e|ed)|updat(e|ed)|chang(e|ed)|now (available|supports?|offers?)|no longer|sunset|shut ?down|end of life|EOL|price (change|increase|cut)|has (risen|fallen|grown)|dropp(ed)|jumpe?d|surged|passe[ds]|approved|rejected)\b/i;
var STATUS_WORDS = /\b(general availability|GA|beta|preview|alpha|stable|deprecated|discontinued|retired|end[- ]of[- ]life|EOL|released|available|unavailable|active|inactive|suspended|archived)\b/gi;
var PATTERNS = [
  { kind: "money", re: /(?:\$|US\$|₹|€|£)\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:million|billion|k|m|bn))?/gi },
  { kind: "percentage", re: /\b\d+(?:\.\d+)?\s?%/g },
  { kind: "date", re: /\b(?:20\d{2}-\d{2}-\d{2}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+\d{4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4})\b/gi },
  // A version needs a `v` prefix, three segments, or explicit version wording.
  { kind: "version", re: /\bv\d+(?:\.\d+){1,2}\b|\b\d+\.\d+\.\d+\b/gi },
  { kind: "quantity", re: /\b\d[\d,]*(?:\.\d+)?\s?(?:billion|million|thousand|k|users|customers|items|results|stars|downloads|employees|percent)\b/gi }
];
var ATTRIBUTES = [
  { attribute: "price", re: /\b(price|cost|fee|pricing|subscription|tier|per month|per year|\/mo|\/yr)\b/i },
  { attribute: "version", re: /\b(version|release|v\d|update|build|patch)\b/i },
  { attribute: "release date", re: /\b(released?|launch(?:ed)?|available (?:on|from)|ships? on|due|scheduled|date)\b/i },
  { attribute: "status", re: /\b(status|deprecated|discontinued|retired|beta|preview|stable|GA|end[- ]of[- ]life|EOL)\b/i },
  { attribute: "valuation", re: /\b(valuation|valued at|market cap|worth)\b/i },
  { attribute: "funding", re: /\b(raised|funding|series [a-e]|seed round|investment)\b/i },
  { attribute: "headcount", re: /\b(employees|headcount|staff|team size|laid off|layoffs)\b/i },
  { attribute: "performance", re: /\b(speed|latency|throughput|faster|slower|benchmark|score|accuracy)\b/i },
  { attribute: "rating", re: /\b(rating|rated|score|review)\b/i }
];
function inferAttribute(sentence, kind) {
  for (const a of ATTRIBUTES) if (a.re.test(sentence)) return a.attribute;
  if (kind === "version") return "version";
  if (kind === "date") return "release date";
  if (kind === "money") return "price";
  if (kind === "percentage") return "percentage";
  if (kind === "quantity") return "quantity";
  return "other";
}
function cleanValue(raw) {
  return raw.replace(/\s+/g, " ").replace(/[.,;:]$/, "").trim();
}
function clauses(sentence) {
  return sentence.split(/;|(?<=[a-z0-9)]) (?:and|but|while|whereas|although) (?=[A-Za-z])/g).map((c) => c.trim().replace(/^[,;]\s*/, "")).filter((c) => c.length > 12);
}
var GENERIC_CAPS = new Set(
  `the a an it this that these those both however meanwhile version versions release releases
   business individual enterprise team plus basic free premium pro standard starter ultimate
   january february march april may june july august september october november december
   monday tuesday wednesday thursday friday saturday sunday update updates`.split(/\s+/).filter(Boolean)
);
function namedEntityIn(clause) {
  for (const m of clause.matchAll(/\b([A-Z][A-Za-z0-9.&'-]{1,}(?:\s+[A-Z][A-Za-z0-9.&'-]{1,})?)/g)) {
    const first = m[1].split(/\s+/)[0];
    if (GENERIC_CAPS.has(first.toLowerCase())) continue;
    return first;
  }
  return null;
}
function bindClauseEntities(sentence, subject) {
  const out = [];
  let carried = null;
  for (const clause of clauses(sentence)) {
    const named = namedEntityIn(clause);
    let entity;
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
function extractFactsFromSentence(sentence, entity, citationId, observedAt) {
  const facts = [];
  const seen = /* @__PURE__ */ new Set();
  const spans = [];
  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(sentence)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const start = m.index;
      const endIdx = start + m[0].length;
      if (spans.some(([a, b]) => start < b && endIdx > a)) continue;
      spans.push([start, endIdx]);
      const value = cleanValue(m[0]);
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
        observedAt
      });
    }
  }
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
      observedAt
    });
  }
  return facts;
}
function salience(sentence, queryTerms, intent, priorAttributes) {
  const lower = sentence.toLowerCase();
  if (BOILERPLATE.test(sentence) || NAVIGATION.test(sentence)) return -1;
  let score = 0;
  const sTerms = canonTerms(sentence);
  if (sTerms.length === 0) return -1;
  let overlap = 0;
  for (const t of new Set(sTerms)) if (queryTerms.has(t)) overlap++;
  score += overlap / Math.max(3, Math.sqrt(sTerms.length)) * 2;
  const hasNumeric = /\b\d/.test(sentence);
  const hasVersion = /\bv?\d+\.\d+/.test(sentence);
  const hasDate = /\b20\d{2}\b/.test(sentence);
  const hasMoney = /(?:\$|US\$|₹|€|£)\s?\d/.test(sentence);
  const hasPercent = /\d\s?%/.test(sentence);
  if (hasNumeric) score += 1;
  if (hasVersion) score += 1.2;
  if (hasDate) score += 0.8;
  if (hasMoney) score += 1.2;
  if (hasPercent) score += 0.9;
  if (CHANGE_VERBS.test(sentence)) score += intent === "change" ? 2.4 : 1.3;
  STATUS_WORDS.lastIndex = 0;
  if (STATUS_WORDS.test(sentence)) score += intent === "change" ? 1.8 : 0.8;
  if (intent === "change" && priorAttributes.size > 0) {
    for (const a of priorAttributes) if (lower.includes(a)) {
      score += 1.5;
      break;
    }
  }
  if (/\b[A-Z][A-Za-z0-9.&'-]{2,}/.test(sentence)) score += 0.4;
  if (/\b(?:annual(?:ly)?\s+billing|billed\s+annual|billed\s+monthly|monthly\s+billing|month-to-month|per\s+seat|per\s+user|minimum(?:\s+of)?\s+\d+\s+seats?|\d+-seat\s+minimum|requires?\s+annual)\b/i.test(sentence)) {
    score += 1.4;
  }
  if (/\b(may|could|might|reportedly|rumou?red|allegedly|it is (believed|thought))\b/i.test(sentence)) {
    score -= 1;
  }
  if (/^(this|these|it|they)\b/i.test(sentence) && !hasNumeric) score -= 0.5;
  return score;
}
function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
function shingles(text, n = 8) {
  const t = canonTerms(text).slice(0, 160);
  const out = /* @__PURE__ */ new Set();
  for (let i = 0; i + n <= t.length; i++) out.add(t.slice(i, i + n).join(" "));
  return out;
}
function nearDuplicate(a, b) {
  if (a.size === 0 || b.size === 0) return false;
  let inter = 0;
  for (const s of a) if (b.has(s)) inter++;
  const union = a.size + b.size - inter;
  return inter / union > 0.6;
}
function buildDigest(input) {
  const { question, results } = input;
  const budget = input.budgetTokens ?? 900;
  const intent = input.intent ?? "answer";
  const priorAttributes = new Set((input.priorFacts ?? []).map((f) => f.attribute.toLowerCase()));
  const inputChars = results.reduce((n, r) => n + r.title.length + r.summary.length, 0);
  const inputTokens = results.reduce(
    (n, r) => n + estimateTokens(r.title) + estimateTokens(r.summary),
    0
  );
  const byUrl = /* @__PURE__ */ new Map();
  for (const r of results) {
    const existing = byUrl.get(r.url);
    if (!existing || r.rerankScore > existing.rerankScore) byUrl.set(r.url, r);
  }
  const sources = [...byUrl.values()].sort((a, b) => b.rerankScore - a.rerankScore);
  const citations = sources.map((s, i) => ({
    id: i + 1,
    url: s.url,
    title: s.title,
    domain: domainOf(s.url),
    date: s.date,
    authority: s.authority
  }));
  const queryTerms = new Set(canonTerms(question));
  const subject = (input.subject ?? "").trim();
  const candidates = [];
  for (const src of sources) {
    const citationId = citations.find((c) => c.url === src.url).id;
    const summaryText = (src.summary ?? "").trim();
    const snippetText = (src.snippet ?? "").trim();
    const text = snippetText && summaryText && !summaryText.includes(snippetText.slice(0, 60)) ? `${summaryText} ${snippetText}` : summaryText || snippetText;
    for (const sentence of sentences(text)) {
      for (const bound of bindClauseEntities(sentence, subject)) {
        let score = salience(bound.clause, queryTerms, intent, priorAttributes);
        if (subject && bound.entity.toLowerCase() === subject.toLowerCase()) score += 1.6;
        if (score <= 0) continue;
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
          shingles: shingles(bound.clause)
        });
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const kept = [];
  const keptShingles = [];
  const seenText = /* @__PURE__ */ new Set();
  let duplicatesRemoved = 0;
  const totalCandidates = candidates.length;
  for (const c of candidates) {
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
  const perDomain = /* @__PURE__ */ new Map();
  const maxPerDomain = Math.max(2, Math.ceil(6 / Math.max(1, new Set(sources.map((s) => domainOf(s.url))).size)) + 1);
  const selected = [];
  let budgetExhausted = false;
  const QUALIFIER_CLAUSE = /\b(annual(?:ly)?|billed|billing|per\s+seat|per\s+user|minimum|requires?|commitment|month-to-month|contract)\b/i;
  function renderCandidates(items) {
    const groups = /* @__PURE__ */ new Map();
    for (const c of items) groups.set(c.citationId, [...groups.get(c.citationId) ?? [], c]);
    return [...groups].map(([id, group]) => {
      const cit = citations.find((c) => c.id === id);
      return `[${id}] ${cit.domain}${cit.date ? ` ${cit.date.slice(0, 10)}` : ""}${cit.authority >= 0 ? ` auth${cit.authority}` : ""}
` + group.map((c) => `- ${c.clause}`).join("\n");
    }).join("\n");
  }
  for (const c of kept) {
    if (selected.includes(c)) continue;
    const domainCount = perDomain.get(c.domain) ?? 0;
    if (domainCount >= maxPerDomain) continue;
    const qualifiers = /(?:\$|US\$|₹|€|£)\s?\d/.test(c.clause) ? kept.filter((q) => q.citationId === c.citationId && q.entity === c.entity && QUALIFIER_CLAUSE.test(q.clause) && !/(?:\$|US\$|₹|€|£)\s?\d/.test(q.clause)) : [];
    const additions = [.../* @__PURE__ */ new Set([c, ...qualifiers])].filter((q) => !selected.includes(q));
    if (selected.length + additions.length > 24 || estimateTokens(renderCandidates([...selected, ...additions])) > budget) {
      budgetExhausted = true;
      continue;
    }
    selected.push(...additions);
    perDomain.set(c.domain, domainCount + additions.length);
  }
  const evidenceByCitation = /* @__PURE__ */ new Map();
  for (const c of selected) evidenceByCitation.set(c.citationId, [...evidenceByCitation.get(c.citationId) ?? [], c.clause]);
  const ordered = (() => {
    if (selected.length <= 3) return selected;
    const head = selected.slice(0, 1);
    const tail = selected.slice(-1);
    const middle = selected.slice(1, -1).sort((a, b) => a.score - b.score);
    return [...head, ...middle, ...tail];
  })();
  const facts = [];
  const factKeys = /* @__PURE__ */ new Set();
  for (const c of selected) {
    for (const bound of bindClauseEntities(c.clause, subject)) {
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
      budgetExhausted
    }
  };
}
function sameValue(a, b) {
  const norm = (s) => s.toLowerCase().replace(/\s+/g, " ").replace(/[$₹€£,\s]/g, "").replace(/(usd|dollars?|per month|\/mo|per year|\/yr)$/g, "").trim();
  return norm(a) === norm(b);
}
function diffFacts(prior, fresh) {
  const changes = [];
  const keyOf = (f) => `${f.entity.toLowerCase()}::${f.attribute.toLowerCase()}`;
  const priorByKey = /* @__PURE__ */ new Map();
  for (const f of prior) {
    const arr = priorByKey.get(keyOf(f)) ?? [];
    arr.push(f);
    priorByKey.set(keyOf(f), arr);
  }
  const freshByKey = /* @__PURE__ */ new Map();
  for (const f of fresh) {
    const arr = freshByKey.get(keyOf(f)) ?? [];
    arr.push(f);
    freshByKey.set(keyOf(f), arr);
  }
  const magnitude = (v) => {
    const m = /-?\d+(?:\.\d+)?/.exec(v.replace(/,/g, ""));
    if (!m) return null;
    let n = Number(m[0]);
    if (/billion/i.test(v)) n *= 1e9;
    else if (/million/i.test(v)) n *= 1e6;
    else if (/thousand|\bk\b/i.test(v)) n *= 1e3;
    return n;
  };
  for (const [k, freshFacts] of freshByKey) {
    const priors = [...priorByKey.get(k) ?? []];
    const unmatched = [];
    for (const f of freshFacts) {
      const idx = priors.findIndex((p) => sameValue(p.value, f.value));
      if (idx >= 0) {
        const match = priors.splice(idx, 1)[0];
        changes.push({
          entity: f.entity,
          attribute: f.attribute,
          from: match,
          to: f,
          kind: "unchanged",
          citationIds: [f.citationId]
        });
      } else {
        unmatched.push(f);
      }
    }
    for (const f of unmatched) {
      if (priors.length === 0) {
        changes.push({
          entity: f.entity,
          attribute: f.attribute,
          from: null,
          to: f,
          kind: "new",
          citationIds: [f.citationId]
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
      const prev = priors.splice(bestIdx, 1)[0];
      changes.push({
        entity: f.entity,
        attribute: f.attribute,
        from: prev,
        to: f,
        kind: "updated",
        citationIds: [.../* @__PURE__ */ new Set([f.citationId, prev.citationId])]
      });
    }
    for (const left of priors) {
      changes.push({
        entity: left.entity,
        attribute: left.attribute,
        from: left,
        to: null,
        kind: "appeared-missing",
        citationIds: [left.citationId]
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
        citationIds: [f.citationId]
      });
    }
  }
  const order = {
    updated: 0,
    new: 1,
    "appeared-missing": 2,
    unchanged: 3,
    removed: 4
  };
  return changes.sort((a, b) => order[a.kind] - order[b.kind]);
}

// plugin/src/billing.ts
var CURRENCY = [
  [/\$|USD/i, "USD"],
  [/€|EUR/i, "EUR"],
  [/£|GBP/i, "GBP"],
  [/₹|INR|Rs\.?/i, "INR"],
  [/¥|JPY/i, "JPY"]
];
var MONEY = /(?:\$|US\$|€|£|₹)\s?(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s?(?:USD|EUR|GBP|INR|JPY)\b/gi;
function detectCurrency(text) {
  for (const [re, cur] of CURRENCY) if (re.test(text)) return cur;
  return "unknown";
}
function detectPeriod(text) {
  if (/\b(?:per\s+month|a\s+month|\/\s?mo(?:nth)?\b|monthly|month-to-month|month to month)\b/i.test(text)) {
    return "month";
  }
  if (/\b(?:per\s+year|a\s+year|\/\s?yr|annum|annual\w*|yearly)\b/i.test(text)) return "year";
  if (/\b(?:per\s+week|\/\s?wk|weekly)\b/i.test(text)) return "week";
  if (/\b(?:per\s+day|\/\s?day|daily)\b/i.test(text)) return "day";
  return "unknown";
}
function detectBilling(text) {
  if (/\b(?:annual(?:ly)?\s+billing|billed\s+annual(?:ly)?|requires?\s+annual|annual\s+commitment|annual\s+plan|paid\s+annual(?:ly)?)\b/i.test(text)) {
    return "annual";
  }
  if (/\b(?:billed\s+month(?:ly)?|monthly\s+billing|month-to-month|month to month|pay\s+as\s+you\s+go|no\s+commitment)\b/i.test(text)) {
    return "monthly";
  }
  return "unknown";
}
function detectUnit(text) {
  if (/\bper\s+seat\b|\/\s?seat\b|\bseat\b/i.test(text)) return "seat";
  if (/\bper\s+user\b|\/\s?user\b/i.test(text)) return "user";
  if (/\bper\s+workspace\b|\bper\s+team\b/i.test(text)) return "workspace";
  if (/\bper\s+account\b|\bflat\b|\bone\s+price\b/i.test(text)) return "account";
  return "unknown";
}
function detectMinSeats(text) {
  const m = /\bminimum(?:\s+of)?[:\s]+(\d{1,5})\s*seats?\b|\b(\d{1,5})[-\s]seat\s+minimum\b|\bminimum\s+(\d{1,5})\b/i.exec(
    text
  );
  if (!m) return null;
  const raw = m[1] ?? m[2] ?? m[3];
  return raw ? Number(raw) : null;
}
function parsePriceTerms(text, sourceId = null) {
  if (!text) return [];
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  MONEY.lastIndex = 0;
  let m;
  while ((m = MONEY.exec(text)) !== null) {
    const amountText = m[1] ?? m[2] ?? "";
    const amount = Number(amountText.replace(/,/g, ""));
    if (!Number.isFinite(amount)) continue;
    const windowStart = Math.max(0, m.index - 120);
    const windowEnd = Math.min(text.length, m.index + 260);
    const context = text.slice(windowStart, windowEnd);
    const term = {
      amount,
      currency: detectCurrency(context),
      unit: detectUnit(context),
      period: detectPeriod(context),
      billing: detectBilling(context),
      minSeats: detectMinSeats(context),
      raw: context.trim().slice(0, 240),
      sourceId
    };
    const key = `${term.amount}|${term.currency}|${term.unit}|${term.period}|${term.billing}|${term.minSeats}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out;
}
function monthlyEquivalent(t) {
  if (t.period === "month") return t.amount;
  if (t.period === "year") return t.amount / 12;
  if (t.period === "week") return t.amount * 52 / 12;
  if (t.period === "day") return t.amount * 365 / 12;
  return null;
}
function comparePriceTerms(oldTerm, newTerm) {
  if (!oldTerm) {
    return { status: "incomparable", oldTerm, newTerm, deltaMonthly: null, pctChange: null, reason: "no prior price was recorded" };
  }
  if (!newTerm) {
    return { status: "incomparable", oldTerm, newTerm, deltaMonthly: null, pctChange: null, reason: "no current price was established" };
  }
  const mismatch = [];
  for (const key of ["currency", "unit", "period", "billing"]) {
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
      reason: `not directly comparable: differing ${mismatch.join(", ")}`
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
    pctChange: a !== 0 ? Math.round((b - a) / a * 1e3) / 10 : null,
    reason: null
  };
}
function formatTerm(t) {
  if (!t) return "unknown";
  const cur = t.currency === "USD" ? "$" : t.currency === "EUR" ? "\u20AC" : t.currency === "GBP" ? "\xA3" : "";
  const unit = t.unit === "unknown" ? "" : ` per ${t.unit}`;
  const period = t.period === "unknown" ? "" : ` per ${t.period}`;
  const billing = t.billing === "unknown" ? "" : t.billing === "annual" ? ", annual commitment" : ", monthly billing";
  const seats = t.minSeats !== null ? `, ${t.minSeats}-seat minimum` : "";
  return `${cur}${t.amount}${cur ? "" : ` ${t.currency}`}${unit}${period}${billing}${seats}`;
}

// plugin/src/search.ts
var RETRYABLE = /* @__PURE__ */ new Set([408, 429, 500, 502, 503, 504]);
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function normalise(r) {
  return {
    title: (r.title ?? "").trim() || "(untitled)",
    url: (r.url ?? "").trim(),
    snippet: (r.snippet ?? "").trim(),
    summary: (r.summary ?? r.content ?? r.snippet ?? "").trim(),
    date: r.date ?? null,
    authority: typeof r.authority === "number" ? r.authority : -1,
    rerankScore: typeof r.rerank_score === "number" ? r.rerank_score : 0,
    siteName: r.site_name ?? null
  };
}
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    for (; ; ) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
async function providerFetch(url, body, signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const fused = AbortSignal.any([signal, timeout]);
  return fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body),
    signal: fused,
    redirect: "error"
  });
}
async function loadFixture(query) {
  if (!config.fixtures) return null;
  const fs4 = await import("node:fs/promises");
  const path5 = await import("node:path");
  const file = path5.join(config.fixtures, "search.json");
  try {
    const data = JSON.parse(await fs4.readFile(file, "utf8"));
    const rows = data[query.trim().toLowerCase()] ?? data[query.trim()] ?? data["*"] ?? null;
    return rows ? rows.map(normalise).filter((r) => r.url) : [];
  } catch {
    return [];
  }
}
async function loadFetchFixture(url) {
  if (!config.fixtures) return null;
  const fs4 = await import("node:fs/promises");
  const path5 = await import("node:path");
  try {
    const data = JSON.parse(await fs4.readFile(path5.join(config.fixtures, "fetch.json"), "utf8"));
    return data[url] ?? data["*"] ?? null;
  } catch {
    return null;
  }
}
async function webSearch(query, opts) {
  const q = query.trim().slice(0, 160);
  if (!q) return { results: [], attempts: 0, fetched: 0 };
  const fixture = await loadFixture(q);
  if (fixture) {
    opts.onAttempt();
    await sleep(10);
    return { results: fixture, attempts: 1, fetched: 0 };
  }
  assertSearchConfigured();
  const payload = {
    query: q,
    count: Math.min(50, Math.max(1, opts.count ?? config.maxResultsPerQuery))
  };
  if (opts.oriQuestion) payload.ori_question = opts.oriQuestion.slice(0, 160);
  let lastErr;
  let attempts = 0;
  for (let i = 0; i < 3; i++) {
    attempts++;
    opts.onAttempt();
    try {
      const res = await providerFetch(
        `${config.searchBaseUrl}/v1/tools/search`,
        payload,
        opts.signal,
        config.searchTimeoutMs
      );
      if (RETRYABLE.has(res.status)) throw new Error(`transient HTTP ${res.status}`);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`search HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = await res.json();
      const results = (data.results ?? []).map(normalise).filter((r) => r.url);
      debugLog("search", { query: q, results: results.length, attempts });
      return { results, attempts, fetched: 0 };
    } catch (err) {
      if (opts.signal.aborted) throw err;
      if (err?.code === "MINIMI_SEARCH_BUDGET") throw err;
      lastErr = err;
      if (i < 2) await sleep(350 * 2 ** i);
    }
  }
  throw new Error(`search failed after ${attempts} attempt(s): ${String(lastErr)}`);
}
async function fetchPage(url, opts) {
  assertSearchConfigured();
  const fixture = await loadFetchFixture(url);
  if (fixture) {
    opts.onAttempt();
    await sleep(5);
    return { title: fixture.title, content: fixture.content, attempts: 1 };
  }
  let lastErr;
  let attempts = 0;
  for (let i = 0; i < 2; i++) {
    attempts++;
    opts.onAttempt();
    try {
      const res = await providerFetch(
        `${config.searchBaseUrl}/v1/tools/fetch`,
        { url },
        opts.signal,
        config.searchTimeoutMs
      );
      if (RETRYABLE.has(res.status)) throw new Error(`transient HTTP ${res.status}`);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`fetch HTTP ${res.status}: ${text.slice(0, 160)}`);
      }
      const data = await res.json();
      return { title: data.title ?? "", content: data.content ?? "", attempts };
    } catch (err) {
      if (opts.signal.aborted) throw err;
      if (err?.code === "MINIMI_SEARCH_BUDGET") throw err;
      lastErr = err;
      if (i === 0) await sleep(300);
    }
  }
  throw new Error(`fetch failed after ${attempts} attempt(s): ${String(lastErr)}`);
}
function mergeFetched(results, fetched, url) {
  const content = fetched.content.trim();
  if (!content) return results;
  const existing = results.find((r) => r.url === url);
  if (existing) {
    existing.summary = `${content}
${existing.summary}`.slice(0, 24e3);
    existing.title = existing.title || fetched.title;
    return results;
  }
  return [
    {
      title: fetched.title || url,
      url,
      snippet: content.slice(0, 500),
      summary: content.slice(0, 24e3),
      date: null,
      authority: 3,
      rerankScore: 0.1,
      siteName: null
    },
    ...results
  ];
}

// plugin/src/report.ts
var CITATION_RE = /\[(\d+)\]/g;
function digestSubjectFor(subject) {
  const value = subject?.trim();
  if (!value) return void 0;
  return value.replace(/\s+(?:launch|pricing|price|cost|plan|tier|subscription|export|exports|limit|quota|storage|allowance|transfer|offline|build|time|feature|support|availability|release|version)(?:\s+.*)?$/i, "").trim() || value;
}
function shouldFetch(item, intent, results) {
  const top = [...results].sort((a, b) => b.rerankScore - a.rerankScore || b.authority - a.authority)[0];
  if (!top) return null;
  if (!/^https?:\/\//i.test(top.url)) return null;
  if (item.fetch) return top;
  if (intent === "change") return top;
  if (top.summary.trim().length < 420 && top.authority >= 2) return top;
  return null;
}
function qualifiersFor(entity, attribute, evidence) {
  if (attribute !== "price" && attribute !== "cost") return [];
  const terms = parsePriceTerms(evidence, entity).map(formatTerm);
  return [...new Set(terms)].slice(0, 3);
}
function toFact(f, cites, retrievedAt) {
  const cit = cites.find((c) => Number(c.id.replace(/\D/g, "")) === f.citationId);
  return {
    entity: f.entity,
    attribute: f.attribute,
    value: f.value,
    kind: f.kind,
    citationId: cit?.id ?? `S${f.citationId}`,
    url: cit?.url ?? "",
    title: cit?.title ?? "",
    publishedAt: cit?.publishedAt ?? null,
    retrievedAt,
    qualifiers: qualifiersFor(f.entity, f.attribute, f.evidence),
    evidence: f.evidence
  };
}
function toDiffFact(f) {
  return {
    entity: f.entity,
    attribute: f.attribute,
    value: f.value,
    kind: f.kind,
    citationId: Number(f.citationId.replace(/\D/g, "")) || 0,
    evidence: f.evidence,
    observedAt: f.retrievedAt
  };
}
function renderChangeView(prior, fresh, tz) {
  const priorFacts = prior.facts.map(toDiffFact);
  const freshFacts = fresh.map(toDiffFact);
  const changes = diffFacts(priorFacts, freshFacts);
  const lines = [];
  const when = formatInZone(prior.updatedAt, prior.tz || tz);
  lines.push(`SAVED BASELINE (${prior.subject}) \u2014 snapshot updated ${when}`);
  for (const f of prior.facts) lines.push(`- Saved ${f.entity} | ${f.attribute}: ${f.value} | observed ${f.retrievedAt} | [saved source](${f.url})`);
  if (fresh.length === 0) {
    lines.push(`- The fresh evidence did not establish a value for ${prior.subject}. The saved baseline is retained; no change can be claimed.`);
    return lines.join("\n");
  }
  let shown = 0;
  for (const c of changes) {
    if (c.kind === "unchanged" && c.attribute !== "price" && c.attribute !== "cost") continue;
    const freshFact = c.to ? fresh.find((f) => f.entity === c.to.entity && f.attribute === c.to.attribute && f.value === c.to.value && f.evidence === c.to.evidence) : void 0;
    const priorFact = c.from ? prior.facts.find((f) => f.entity === c.from.entity && f.attribute === c.from.attribute && f.value === c.from.value && f.evidence === c.from.evidence) : void 0;
    if (!freshFact) {
      lines.push(`- ${c.entity} | ${c.attribute}: no fresh value in this batch; not evidence of change. Baseline "${priorFact?.value ?? c.from?.value ?? "unknown"}" retained.`);
      shown++;
      continue;
    }
    const cite = `[${freshFact.citationId}](${freshFact.url})`;
    if (c.kind === "new") {
      lines.push(`- ${c.entity} | ${c.attribute}: first observed "${freshFact.value}" ${cite} (no prior value, so not a change).`);
      shown++;
      continue;
    }
    if (c.attribute === "price" || c.attribute === "cost") {
      const oldTerm = parsePriceTerms(priorFact?.evidence ?? "", c.entity)[0] ?? null;
      const newTerm = parsePriceTerms(freshFact.evidence ?? "", c.entity)[0] ?? null;
      const cmp = comparePriceTerms(oldTerm, newTerm);
      if (cmp.status === "unchanged") continue;
      if (cmp.status === "incomparable") {
        lines.push(`- ${c.entity} | ${c.attribute}: CANNOT ESTABLISH A CHANGE \u2014 ${cmp.reason}. Saved: ${formatTerm(oldTerm)}. Fresh: ${formatTerm(newTerm)} ${cite}.`);
      } else {
        const delta = cmp.deltaMonthly != null ? ` (${cmp.deltaMonthly >= 0 ? "+" : ""}$${Math.abs(cmp.deltaMonthly)}/mo equivalent)` : "";
        lines.push(`- ${c.entity} | ${c.attribute}: ${formatTerm(oldTerm)} -> ${formatTerm(newTerm)} ${cite} [${c.kind}${delta}]`);
      }
      shown++;
      continue;
    }
    lines.push(`- ${c.entity} | ${c.attribute}: "${c.from?.value ?? "none"}" -> "${freshFact.value}" ${cite} [${c.kind}]`);
    shown++;
  }
  if (shown === 0) {
    lines.push(`- The fresh evidence covers the same attributes with the same values as the saved baseline. No change detected.`);
  }
  lines.push(`Use only these rows for a "what changed" answer. Cite fresh values with the shown S ids; do not invent a delta.`);
  return lines.join("\n");
}
async function runSearchBatch(input, deps) {
  const tz = resolveTimeZone(deps.tz, "UTC");
  const items = input.queries.map((q) => ({ query: q.query.trim(), subject: q.subject?.trim() || void 0, fetch: q.fetch })).filter((q) => q.query.length > 0).slice(0, Math.min(deps.maxQueries, config.maxQueriesPerCall));
  const missing = [];
  if (items.length === 0) {
    return { text: "SEARCH_BATCH_EMPTY: no non-empty query was supplied.", citations: [], facts: [], missing: ["empty query"], attempts: 0, fetched: 0, truncated: false };
  }
  const perQueryBudget = Math.max(32, Math.floor(config.digestTokens / Math.max(1, items.length)));
  let fetchedCount = 0;
  const retrievedAt = new Date(deps.now).toISOString();
  const searchFn = deps.search ?? webSearch;
  const fetchFn = deps.fetch ?? fetchPage;
  const outcomes = await mapLimit(items, config.concurrency, async (item) => {
    const prior = item.subject ? deps.store.getSnapshot(item.subject) : null;
    const digestSubject = digestSubjectFor(item.subject);
    let itemAttempts = 0;
    const onAttempt = () => {
      deps.onAttempt();
      itemAttempts++;
    };
    try {
      const search = await searchFn(item.query, {
        count: config.maxResultsPerQuery,
        oriQuestion: item.query,
        signal: deps.signal,
        onAttempt
      });
      let results = search.results;
      let fetched = false;
      const fetchTarget = shouldFetch(item, input.intent, results);
      if (fetchTarget && fetchedCount < items.length) {
        fetchedCount++;
        try {
          const page = await fetchFn(fetchTarget.url, { signal: deps.signal, onAttempt });
          results = mergeFetched(results, page, fetchTarget.url);
          fetched = true;
        } catch (err) {
          debugLog("internal fetch failed", fetchTarget.url, String(err));
        }
      }
      const digest = buildDigest({
        question: item.query,
        results,
        budgetTokens: perQueryBudget,
        intent: input.intent === "recall" ? "recall" : input.intent,
        subject: digestSubject,
        requireSubject: Boolean(digestSubject),
        priorFacts: prior?.facts.map((f) => ({ attribute: f.attribute, value: f.value })) ?? []
      });
      return {
        item,
        ok: true,
        results,
        fetched,
        digestBlock: digest.block,
        citations: digest.citations.map((c) => ({
          id: `S${c.id}`,
          title: c.title,
          url: c.url,
          domain: c.domain,
          publishedAt: c.date,
          retrievedAt,
          authority: c.authority
        })),
        facts: digest.facts.map((f) => toFact(f, digest.citations.map((c) => ({
          id: `S${c.id}`,
          title: c.title,
          url: c.url,
          domain: c.domain,
          publishedAt: c.date,
          retrievedAt,
          authority: c.authority
        })), retrievedAt)),
        missing: [],
        digestStats: {
          kept: digest.stats.sentencesKept,
          dropped: digest.stats.sentencesDropped,
          ratio: digest.stats.ratio,
          inputTokens: digest.stats.inputTokens,
          digestTokens: digest.stats.digestTokens,
          budgetExhausted: digest.stats.budgetExhausted
        },
        attempts: itemAttempts,
        prior
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        item,
        ok: false,
        error: message,
        results: [],
        fetched: false,
        digestBlock: `(search failed: ${message})`,
        citations: [],
        facts: [],
        missing: [`search failed for "${item.query}": ${message}`],
        digestStats: { kept: 0, dropped: 0, ratio: 0, inputTokens: 0, digestTokens: 0, budgetExhausted: false },
        attempts: itemAttempts,
        prior
      };
    }
  });
  const allCitations = [];
  const allFacts = [];
  const blocks = [];
  let truncated = false;
  for (const outcome of outcomes) {
    const localToGlobal = /* @__PURE__ */ new Map();
    for (const c of outcome.citations) {
      const local = Number(c.id.replace(/\D/g, ""));
      const globalId = `S${allCitations.length + 1}`;
      localToGlobal.set(local, globalId);
      allCitations.push({ ...c, id: globalId });
    }
    let remapped = outcome.digestBlock.replace(CITATION_RE, (_m, n) => `[${localToGlobal.get(Number(n)) ?? n}]`);
    for (const c of outcome.citations) {
      const globalId = localToGlobal.get(Number(c.id.replace(/\D/g, ""))) ?? c.id;
      remapped = remapped.split(`[${globalId}]`).join(`[${globalId}](${c.url})`);
    }
    const remappedFacts = outcome.facts.map((f) => ({
      ...f,
      citationId: localToGlobal.get(Number(f.citationId.replace(/\D/g, ""))) ?? f.citationId
    }));
    allFacts.push(...remappedFacts);
    outcome.citations = outcome.citations.map((c) => ({ ...c, id: localToGlobal.get(Number(c.id.replace(/\D/g, ""))) ?? c.id }));
    outcome.digestBlock = remapped;
    outcome.facts = remappedFacts;
    if (outcome.digestStats.digestTokens > 0 && outcome.digestStats.kept === 0) {
      outcome.missing.push(`no usable claim-sized evidence for "${outcome.item.query}"`);
    }
    const expectedSubject = digestSubjectFor(outcome.item.subject);
    if (expectedSubject && !outcome.facts.some((f) => f.entity.toLowerCase() === expectedSubject.toLowerCase())) {
      outcome.missing.push(`no value found that is tied to subject "${outcome.item.subject}"`);
    }
    if (outcome.digestBlock.includes("(no usable evidence was retrieved)") || outcome.digestBlock.includes("(search failed:")) {
      outcome.missing.push(`evidence gap for "${outcome.item.query}"`);
    }
    missing.push(...outcome.missing);
    const header = [
      `=== QUERY ${blocks.length + 1}/${outcomes.length} ===`,
      `query: "${outcome.item.query}"`,
      outcome.item.subject ? `subject: ${outcome.item.subject}` : null,
      outcome.fetched ? `internal_fetch: yes` : null,
      outcome.ok ? null : `ERROR: ${outcome.error}`
    ].filter(Boolean).join("\n");
    const citedIds = /* @__PURE__ */ new Set();
    for (const f of outcome.facts) citedIds.add(Number(f.citationId.replace(/\D/g, "")));
    const sourceLines = outcome.citations.filter((c) => citedIds.size === 0 || citedIds.has(Number(c.id.replace(/\D/g, "")))).map((c) => {
      const pub = c.publishedAt ? ` published=${c.publishedAt.slice(0, 10)}` : "";
      return `- [${c.id}](${c.url}) \u2014 ${c.title}${pub} retrieved=${c.retrievedAt}`;
    });
    const evidence = outcome.ok ? `EVIDENCE
${outcome.digestBlock}` : `EVIDENCE
(no usable evidence: ${outcome.error})`;
    const sources = sourceLines.length > 0 ? `
SOURCES (for citation)
${sourceLines.join("\n")}` : "";
    const miss = outcome.missing.length > 0 ? `
MISSING
- ${outcome.missing.join("\n- ")}` : "";
    blocks.push(`${header}
${evidence}${sources}${miss}`);
  }
  truncated = outcomes.some((o) => o.digestStats.budgetExhausted);
  const changeBlocks = [];
  for (const outcome of outcomes) {
    if (input.intent !== "change" || !outcome.item.subject) continue;
    const subject = outcome.item.subject;
    const prior = outcome.prior;
    if (!prior) {
      changeBlocks.push(`SAVED BASELINE (${subject}) \u2014 none. This batch records the first observation; there is no prior value to compare.`);
      continue;
    }
    changeBlocks.push(renderChangeView(prior, outcome.facts, tz));
  }
  const totalAttempts = outcomes.reduce((n, o) => n + o.attempts, 0);
  const copyable = allCitations.map((c) => `[${c.id}](${c.url})`).join("\n");
  const text = [
    "MINIMI_SEARCH_BATCH",
    `intent=${input.intent} queries=${outcomes.length} sources=${allCitations.length} fetched=${outcomes.filter((o) => o.fetched).length} attempts=${totalAttempts}`,
    "",
    ...blocks,
    changeBlocks.length > 0 ? `
=== CHANGE CHECK ===
${changeBlocks.join("\n\n")}` : "",
    "",
    "CITATION RULES",
    '- Inline citations MUST be markdown links copied from the list below, e.g. [S3](https://example.com/page). Bare "S3" text is not clickable.',
    "- End with a **Sources** section whose entries are also markdown links. List only sources actually cited.",
    "- Use only the S ids above. Do not invent or alter a URL.",
    "- If an item is marked MISSING, answer the supported portion and say what is missing.",
    "- Do not claim a change when the change view says it cannot be established.",
    "",
    "COPYABLE SOURCE LINKS",
    copyable || "(none)",
    truncated ? "- Evidence was truncated to the digest budget; treat omissions as unknown, not absent." : ""
  ].filter((l) => l !== null).join("\n");
  deps.store.recordSearch(deps.sessionId, deps.turn, input.intent, items, text, allCitations, totalAttempts, deps.now);
  deps.store.recordFacts(deps.sessionId, deps.turn, allFacts, deps.now);
  for (const outcome of outcomes) {
    if (!outcome.item.subject || outcome.facts.length === 0) continue;
    const refreshedKeys = new Set(outcome.facts.map((f) => `${f.entity.toLowerCase()}::${f.attribute.toLowerCase()}`));
    const retained = outcome.prior?.facts.filter((f) => !refreshedKeys.has(`${f.entity.toLowerCase()}::${f.attribute.toLowerCase()}`)) ?? [];
    const retainedUrls = new Set(retained.map((f) => f.url));
    deps.store.saveSnapshot({
      subject: outcome.item.subject,
      subjectKey: subjectKey(outcome.item.subject),
      facts: [...outcome.facts, ...retained],
      citations: [...outcome.citations, ...outcome.prior?.citations.filter((c) => retainedUrls.has(c.url)) ?? []],
      updatedAt: deps.now,
      tz,
      sessionId: deps.sessionId
    });
  }
  return {
    text,
    citations: allCitations,
    facts: allFacts,
    missing,
    attempts: totalAttempts,
    fetched: outcomes.filter((o) => o.fetched).length,
    truncated
  };
}

// plugin/src/prompts.ts
var MINIMI_INSTRUCTIONS = `You are Minimi, a general-purpose research assistant with one model-callable tool: \`web_search\`.

HOW TO WORK
- Ordinary conversation, drafting, planning, arithmetic, and explanations need no tool; answer directly.
- Use \`web_search\` for current, unfamiliar, or post-training facts that matter. Do not search for things you know, for the user's own commitments, or for dated recall that DATED MEMORY can answer.
- A request for dated recall ("what did we discuss yesterday?", "what did I tell you about X?") uses DATED MEMORY. If it is insufficient, ask one focused question.
- A "what changed?" request combines the SAVED BASELINE in DATED MEMORY with fresh \`web_search\` evidence. Set \`intent: "change"\` and give each item a \`subject\`.
- Search budget: at most two \`web_search\` calls per user turn, at most three independent queries per call. Make the first batch up to three queries; use one follow-up batch only for a specific evidence gap. Put independent subjects in the same batch, not serial calls.
- When a reference is genuinely ambiguous (for example "the pro plan" with two plausible products), ask one short clarifying question before searching. When the reference is explicit, resolve it without asking.

EVIDENCE AND CITATIONS
- The tool returns a compact digest, source IDs (\`S1\`, \`S2\`, ...), and published/retrieved dates. Raw provider output is never shown to you; use only the digest.
- Cite claims inline as markdown links: \`[S1](https://\u2026)\`. End every researched answer with a **Sources** section listing only the sources actually cited.
- Never invent a source, URL, value, or date. If an item is marked MISSING, answer the supported part and state the gap; do not guess.
- For change checks, report only the rows in CHANGE CHECK. If it says a change cannot be established because identity, unit, tier, region, or billing terms differ, show both observations separately and explain why. Do not turn "first observed" or "not refreshed" into a change.
- Prefer the most authoritative and recent source when values conflict, and say that they conflict.

STYLE
- Lead with the answer. Use short paragraphs and lists only when they help comparison.
- Include dates for time-sensitive facts. Preserve qualifiers such as version, region, tier, unit, and billing basis.
- If the user asks for a plan, give a clear ordered plan. Do not claim to have performed actions you did not perform.`;
function renderMemoryContext(recall, tz) {
  const { turns, facts, snapshots, window } = recall;
  if (turns.length === 0 && facts.length === 0 && snapshots.length === 0) return "";
  const lines = [];
  lines.push("DATED MEMORY \u2014 earlier observations from Minimi's SQLite store.");
  lines.push(`Times below are shown in ${tz}; stored instants are UTC. This is recall, not fresh web evidence.`);
  if (window) lines.push(`The user's date phrase resolves to: ${window.label} (${new Date(window.from).toISOString()} to ${new Date(window.to).toISOString()}).`);
  if (turns.length > 0) {
    lines.push("\nEARLIER TURNS");
    for (const t of turns) lines.push(describeTurn(t));
  }
  if (facts.length > 0) {
    lines.push("\nEARLIER OBSERVATIONS (dated facts)");
    for (const f of facts) {
      const q = f.qualifiers.length > 0 ? `; terms: ${f.qualifiers.join(" | ")}` : "";
      lines.push(
        `- ${f.entity} | ${f.attribute}: ${f.value} | observed ${new Date(f.retrievedAt).toISOString().slice(0, 10)}${q} | source: ${f.title} (${f.url})`
      );
    }
  }
  if (snapshots.length > 0) {
    lines.push("\nSAVED BASELINES (for change checks)");
    for (const s of snapshots) {
      const when = formatInZone(s.updatedAt, s.tz || tz);
      const vals = s.facts.slice(0, 8).map((f) => `${f.attribute}=${f.value}${f.qualifiers.length ? ` [${f.qualifiers.join("; ")}]` : ""} (observed ${f.retrievedAt})`).join("; ");
      lines.push(`- ${s.subject}: ${vals} | snapshot updated ${when} | baseline source: ${s.citations[0]?.url ?? "unknown"}`);
    }
    lines.push('For a "what changed" request, compare the current observation with this exact baseline. If the fresh search fails, the baseline stays the last verified value and no change may be claimed.');
  }
  lines.push("\nUse these records only when the current request asks about earlier conversations, prior observations, or change since a saved baseline.");
  return lines.join("\n");
}

// plugin/src/observability.ts
import fs2 from "node:fs";
import path3 from "node:path";
import crypto from "node:crypto";
var num2 = (name2, fallback) => {
  const n = Number(process.env[name2]);
  return Number.isFinite(n) ? n : fallback;
};
var PRICE = {
  inputMiss: num2("MINIMI_PRICE_INPUT_MISS", 0.14) / 1e6,
  inputHit: num2("MINIMI_PRICE_INPUT_HIT", 0.028) / 1e6,
  output: num2("MINIMI_PRICE_OUTPUT", 0.56) / 1e6
};
var Observability = class {
  file;
  dir;
  turns = /* @__PURE__ */ new Map();
  enabled;
  constructor(file = path3.resolve("data/observability/turns.jsonl")) {
    this.file = file;
    this.dir = path3.dirname(file);
    this.enabled = process.env.MINIMI_OBSERVABILITY !== "0";
    if (this.enabled) {
      try {
        fs2.mkdirSync(this.dir, { recursive: true });
      } catch {
      }
    }
  }
  key(sessionId, turn) {
    return `${sessionId}:${turn}`;
  }
  begin(sessionId, turn) {
    if (!this.enabled) return;
    const now = Date.now();
    this.turns.set(this.key(sessionId, turn), {
      traceId: crypto.randomUUID(),
      startedAt: now,
      startedIso: new Date(now).toISOString(),
      userText: "",
      assistantText: "",
      firstTextMs: null,
      stepStartedAt: null,
      modelCalls: 0,
      toolCalls: 0,
      searchAttempts: 0,
      searchQueries: [],
      citations: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      spans: [],
      interrupted: false,
      error: null
    });
  }
  user(sessionId, turn, text) {
    const state = this.turns.get(this.key(sessionId, turn));
    if (state) state.userText = text.slice(0, 4e3);
  }
  stepStart(sessionId, turn, step) {
    const state = this.turns.get(this.key(sessionId, turn));
    if (!state) return;
    state.stepStartedAt = Date.now();
    state.spans.push({ name: `llm.step.${step}`, start: (/* @__PURE__ */ new Date()).toISOString(), inputs: { step } });
  }
  firstText(sessionId, turn) {
    const state = this.turns.get(this.key(sessionId, turn));
    if (!state || state.firstTextMs !== null) return;
    state.firstTextMs = Date.now() - state.startedAt;
  }
  assistant(sessionId, turn, text, usage, interrupted, step) {
    const state = this.turns.get(this.key(sessionId, turn));
    if (!state) return;
    const now = Date.now();
    state.modelCalls++;
    state.assistantText = text.slice(0, 8e3);
    state.interrupted = state.interrupted || interrupted;
    if (text.trim() && state.firstTextMs === null) state.firstTextMs = now - state.startedAt;
    const uncached = Number(usage?.inputTokens ?? usage?.promptTokens ?? 0);
    const cacheRead = Number(usage?.cacheReadTokens ?? usage?.cacheHitTokens ?? 0);
    const cacheWrite = Number(usage?.cacheWriteTokens ?? 0);
    state.inputTokens += uncached + cacheRead + cacheWrite;
    state.outputTokens += Number(usage?.outputTokens ?? usage?.completionTokens ?? 0);
    state.cacheHitTokens += cacheRead;
    state.cacheMissTokens += uncached + cacheWrite;
    const span = [...state.spans].reverse().find((s) => s.name.startsWith("llm.step.") && !s.end);
    if (span) {
      span.end = new Date(now).toISOString();
      span.duration_ms = state.stepStartedAt ? now - state.stepStartedAt : void 0;
      span.outputs = { text: text.slice(0, 500), usage: usage ?? null, interrupted };
    }
  }
  recall(sessionId, turn, input) {
    const state = this.turns.get(this.key(sessionId, turn));
    if (!state) return;
    const started = new Date(Date.now() - input.durationMs).toISOString();
    state.spans.push({
      name: "retriever.memory.recall",
      start: started,
      end: (/* @__PURE__ */ new Date()).toISOString(),
      duration_ms: input.durationMs,
      inputs: {
        query: input.query,
        tz: input.tz,
        exclude_session_id: sessionId,
        exclude_turn: turn,
        sql: [
          "SELECT * FROM turns ORDER BY started_at DESC LIMIT 400",
          "SELECT * FROM facts ORDER BY created_at DESC LIMIT 600",
          "SELECT * FROM snapshots ORDER BY updated_at DESC LIMIT 100"
        ]
      },
      outputs: {
        window: input.window,
        turns: input.turns.map((t) => ({
          session_id: t.sessionId,
          turn: t.turn,
          started_at: new Date(t.startedAt).toISOString(),
          user_text: t.userText.slice(0, 300)
        })),
        facts: input.facts.map((f) => ({
          entity: f.entity,
          attribute: f.attribute,
          value: f.value,
          citation_id: f.citationId
        })),
        snapshots: input.snapshots.map((s) => ({
          subject: s.subject,
          updated_at: new Date(s.updatedAt).toISOString()
        })),
        counts: { turns: input.turns.length, facts: input.facts.length, snapshots: input.snapshots.length },
        rendered_chars: input.renderedChars,
        rendered_tokens_est: Math.ceil(input.renderedChars / 4)
      }
    });
  }
  tool(sessionId, turn, input) {
    const state = this.turns.get(this.key(sessionId, turn));
    if (!state) return;
    state.toolCalls++;
    state.searchAttempts += input.attempts;
    state.searchQueries.push(...input.queries);
    state.citations += input.citations;
    state.spans.push({
      name: "tool.web_search",
      start: new Date(Date.now() - input.durationMs).toISOString(),
      end: (/* @__PURE__ */ new Date()).toISOString(),
      duration_ms: input.durationMs,
      inputs: { queries: input.queries },
      outputs: { attempts: input.attempts, citations: input.citations },
      error: input.error
    });
  }
  error(sessionId, turn, error) {
    const state = this.turns.get(this.key(sessionId, turn));
    if (state) state.error = error.slice(0, 1e3);
  }
  end(sessionId, turn) {
    const state = this.turns.get(this.key(sessionId, turn));
    if (!state) return;
    this.turns.delete(this.key(sessionId, turn));
    const endedAt = Date.now();
    const cost = state.cacheMissTokens * PRICE.inputMiss + state.cacheHitTokens * PRICE.inputHit + state.outputTokens * PRICE.output;
    const route = state.searchQueries.length > 0 ? "research" : "direct";
    const record = {
      trace_id: state.traceId,
      session_id: sessionId,
      turn,
      started_at: state.startedIso,
      ended_at: new Date(endedAt).toISOString(),
      duration_ms: endedAt - state.startedAt,
      first_answer_text_ms: state.firstTextMs,
      route,
      user_text: state.userText,
      assistant_text: state.assistantText,
      interrupted: state.interrupted,
      error: state.error,
      model_calls: state.modelCalls,
      tool_calls: state.toolCalls,
      search_attempts: state.searchAttempts,
      search_queries: [...new Set(state.searchQueries)],
      citations: state.citations,
      input_tokens: state.inputTokens,
      output_tokens: state.outputTokens,
      cache_hit_tokens: state.cacheHitTokens,
      cache_miss_tokens: state.cacheMissTokens,
      cost_usd: Number(cost.toFixed(6)),
      spans: state.spans
    };
    try {
      fs2.appendFileSync(this.file, JSON.stringify(record) + "\n");
      const dir = path3.join(this.dir, "turns");
      fs2.mkdirSync(dir, { recursive: true });
      fs2.writeFileSync(path3.join(dir, `${sessionId.replace(/[^a-zA-Z0-9_.-]+/g, "_")}-${turn}.json`), JSON.stringify(record, null, 2));
    } catch {
    }
  }
};

// plugin/src/index.ts
var name = "minimi";
var inject = ["tools", "systemPrompt", "agents"];
var BudgetExceeded = class extends Error {
  code = "MINIMI_SEARCH_BUDGET";
};
function textOf(content) {
  if (!Array.isArray(content)) return "";
  return content.filter((b) => Boolean(b) && typeof b === "object" && b.type === "text").map((b) => b.text).join("\n").trim();
}
function messageText(message) {
  if (!message || typeof message !== "object") return "";
  return textOf(message.content);
}
function sourceTz(message, fallback) {
  if (!message || typeof message !== "object") return fallback;
  const source = message.source;
  const tz = source?.clientTimeZone;
  if (typeof tz === "string" && isValidTimeZone(tz)) return tz;
  return fallback;
}
function normaliseQueries(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const q of raw.slice(0, 4)) {
    if (typeof q === "string") {
      if (q.trim()) out.push({ query: q.trim() });
      continue;
    }
    if (q && typeof q === "object") {
      const o = q;
      const query = typeof o.query === "string" ? o.query.trim() : "";
      if (!query) continue;
      out.push({
        query,
        subject: typeof o.subject === "string" && o.subject.trim() ? o.subject.trim() : void 0,
        fetch: o.fetch === true
      });
    }
  }
  return out;
}
function apply(ctx) {
  const store = new MemoryStore();
  const obs = new Observability();
  const budgets = /* @__PURE__ */ new Map();
  const deleteChatPath = "/__minimi/chat/delete";
  function removeSessionFiles(sessionId) {
    let removed = 0;
    const home = process.env.MINIMI_DSH_HOME ? path4.resolve(process.env.MINIMI_DSH_HOME) : path4.resolve(".dsh");
    const walk = (dir, depth) => {
      if (depth > 5) return;
      let entries = [];
      try {
        entries = fs3.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path4.join(dir, entry.name);
        if (entry.name === sessionId || entry.name.startsWith(`${sessionId}.`)) {
          try {
            fs3.rmSync(full, { recursive: true, force: true });
            removed++;
          } catch {
          }
        } else if (entry.isDirectory()) {
          walk(full, depth + 1);
        }
      }
    };
    walk(path4.join(home, "sessions"), 0);
    walk(path4.join(home, "storages"), 0);
    return removed;
  }
  function removeObservability(sessionId) {
    const file = process.env.MINIMI_OBSERVABILITY_FILE ? path4.resolve(process.env.MINIMI_OBSERVABILITY_FILE) : path4.resolve("data/observability/turns.jsonl");
    try {
      if (fs3.existsSync(file)) {
        const kept = fs3.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).filter((line) => {
          try {
            return JSON.parse(line).session_id !== sessionId;
          } catch {
            return true;
          }
        });
        fs3.writeFileSync(file, kept.length ? `${kept.join("\n")}
` : "");
      }
      const turns = path4.join(path4.dirname(file), "turns");
      for (const name2 of fs3.readdirSync(turns)) {
        if (name2 === sessionId || name2.startsWith(`${sessionId}-`)) {
          try {
            fs3.rmSync(path4.join(turns, name2), { force: true });
          } catch {
          }
        }
      }
    } catch {
    }
  }
  function deleteChat(sessionId) {
    const removedFiles = removeSessionFiles(sessionId);
    store.deleteSession(sessionId);
    removeObservability(sessionId);
    return { removedFiles };
  }
  ctx.inject(["webServer", "connection"], (scope) => {
    scope.effect(() => scope.webServer.register({
      kind: "exact",
      path: deleteChatPath,
      handler: async (req, res) => {
        const rejection = scope.connection.requestRejection(req);
        if (rejection !== void 0) {
          res.writeHead(rejection);
          res.end();
          return;
        }
        if (req.method !== "POST") {
          res.writeHead(405, { allow: "POST" });
          res.end();
          return;
        }
        try {
          let raw = "";
          for await (const chunk of req) {
            raw += chunk;
            if (raw.length > 4096) {
              res.writeHead(413);
              res.end();
              return;
            }
          }
          const body = JSON.parse(raw || "{}");
          const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
          if (!/^session-[A-Za-z0-9-]+$/.test(sessionId)) {
            res.writeHead(400);
            res.end("invalid session");
            return;
          }
          const result = deleteChat(sessionId);
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify({ ok: true, ...result }));
        } catch (error) {
          debugLog("delete chat failed", String(error));
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "delete failed" }));
        }
      }
    }), "minimi: POST /__minimi/chat/delete");
  });
  const tzBySession = /* @__PURE__ */ new Map();
  const latestUserBySession = /* @__PURE__ */ new Map();
  let latestSessionId = null;
  const fallbackTz = config.defaultTz === "auto" ? Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" : resolveTimeZone(config.defaultTz, "UTC");
  ctx.effect(() => () => store.close());
  function tzFor(sessionId) {
    return resolveTimeZone(tzBySession.get(sessionId) ?? fallbackTz, "UTC");
  }
  function budgetFor(sessionId, turn) {
    const existing = budgets.get(sessionId);
    if (existing && existing.turn === turn) return existing;
    const fresh = { turn, calls: 0, queries: 0, attempts: 0, changeUsed: false, startedAt: Date.now() };
    budgets.set(sessionId, fresh);
    return fresh;
  }
  function writeDebug(name2, value) {
    try {
      fs3.mkdirSync(path4.resolve("data"), { recursive: true });
      fs3.writeFileSync(path4.resolve("data", name2), typeof value === "string" ? value : JSON.stringify(value, null, 2));
    } catch {
    }
  }
  ctx.tools.register({
    name: "web_search",
    description: 'Search the current web for up to three independent queries in parallel and return a compact, cited evidence digest. Use for current or unfamiliar facts. For a change check, set intent="change" and give each query a subject; the tool compares fresh evidence with the saved baseline and reports only defensible changes. At most two calls per turn; the second is for one targeted evidence gap. Do not use for ordinary conversation, dated recall from memory, or arithmetic.',
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        queries: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          description: "Independent lookups to run concurrently. Put different subjects in the same batch.",
          items: {
            oneOf: [
              { type: "string" },
              {
                type: "object",
                additionalProperties: false,
                required: ["query"],
                properties: {
                  query: { type: "string", description: "Search query, scoped to one subject when possible." },
                  subject: { type: "string", description: "The entity this query is evidence for (needed for change checks)." },
                  fetch: { type: "boolean", description: "Ask the tool to retrieve the top source page internally." }
                }
              }
            ]
          }
        },
        intent: {
          type: "string",
          enum: ["answer", "change", "recall"],
          default: "answer",
          description: "answer = explain; change = compare with the saved baseline; recall = prior-observation support."
        }
      },
      required: ["queries"]
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["text", "citations", "facts", "missing", "attempts", "fetched", "truncated"],
        properties: {
          text: { type: "string" },
          citations: { type: "array", items: { type: "object", additionalProperties: true } },
          facts: { type: "array", items: { type: "object", additionalProperties: true } },
          missing: { type: "array", items: { type: "string" } },
          attempts: { type: "number" },
          fetched: { type: "number" },
          truncated: { type: "boolean" }
        }
      },
      render: (_args, value) => [{ type: "text", text: String(value?.text ?? "") }]
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const agent = exec.agent;
      if (!agent) {
        return { text: "SEARCH_UNAVAILABLE: this tool must run inside an agent turn.", citations: [], facts: [], missing: ["no agent context"], attempts: 0, fetched: 0, truncated: false };
      }
      const sessionId = agent.session.header.id;
      const turn = ctx.agents.turnBoundaryOf(agent.session).lastTurn;
      const intent = args?.intent === "change" ? "change" : args?.intent === "recall" ? "recall" : "answer";
      const queries = normaliseQueries(args?.queries);
      const budget = budgetFor(sessionId, turn);
      if (queries.length === 0) {
        return { text: "SEARCH_INPUT_ERROR: provide 1\u20133 non-empty queries.", citations: [], facts: [], missing: ["no queries"], attempts: 0, fetched: 0, truncated: false };
      }
      if (budget.calls >= config.maxCallsPerTurn) {
        return {
          text: `SEARCH_BUDGET_EXCEEDED: this turn already used ${budget.calls} web_search call(s) (limit ${config.maxCallsPerTurn}). Answer from the evidence already returned and state any remaining gap.`,
          citations: [],
          facts: [],
          missing: ["search call budget exhausted"],
          attempts: budget.attempts,
          fetched: 0,
          truncated: true
        };
      }
      if (intent === "change" && budget.changeUsed) {
        return {
          text: "CHANGE_ALREADY_CHECKED: this turn already has a deterministic CHANGE CHECK. Use that comparison; do not run a second baseline read. If it reported no change, say no change. If it reported a gap, say what is missing.",
          citations: [],
          facts: [],
          missing: ["change check already completed this turn"],
          attempts: budget.attempts,
          fetched: 0,
          truncated: false
        };
      }
      assertSearchConfigured();
      const toolStarted = Date.now();
      budget.calls++;
      if (intent === "change") budget.changeUsed = true;
      budget.queries += queries.length;
      try {
        const result = await runSearchBatch(
          { queries, intent },
          {
            store,
            sessionId,
            turn,
            tz: tzFor(sessionId),
            now: Date.now(),
            signal: exec.signal,
            maxQueries: config.maxQueriesPerCall,
            onAttempt: () => {
              if (budget.attempts >= config.maxProviderAttemptsPerTurn) {
                throw new BudgetExceeded(
                  `provider attempt budget exhausted (${budget.attempts}/${config.maxProviderAttemptsPerTurn}); return the evidence already gathered and name the gap`
                );
              }
              budget.attempts++;
            }
          }
        );
        const footer = `

BUDGET: call ${budget.calls}/${config.maxCallsPerTurn}, queries ${budget.queries}, provider attempts ${budget.attempts}/${config.maxProviderAttemptsPerTurn}.`;
        debugLog("web_search", { sessionId, turn, intent, queries: queries.length, citations: result.citations.length, attempts: result.attempts });
        obs.tool(sessionId, turn, { queries: queries.map((q) => q.query), attempts: result.attempts, citations: result.citations.length, durationMs: Date.now() - toolStarted });
        return { ...result, text: result.text + footer };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        obs.tool(sessionId, turn, { queries: queries.map((q) => q.query), attempts: budget.attempts, citations: 0, durationMs: Date.now() - toolStarted, error: message });
        return {
          text: `SEARCH_BUDGET_EXCEEDED: ${message}. Use the evidence already returned; do not guess beyond it.`,
          citations: [],
          facts: [],
          missing: [message],
          attempts: budget.attempts,
          fetched: 0,
          truncated: true
        };
      }
    }
  });
  ctx.systemPrompt.section({
    name: "minimi:instructions",
    order: 9e3,
    text: MINIMI_INSTRUCTIONS
  });
  ctx.systemPrompt.context({
    name: "minimi:dated-memory",
    order: 8e3,
    text: () => {
      try {
        const agent = ctx.agents.currentInitiator();
        const sessionId = agent?.session.header.id ?? latestSessionId ?? void 0;
        if (!sessionId) return "";
        const userText = latestUserBySession.get(sessionId) ?? "";
        if (!userText.trim()) return "";
        const tz = tzFor(sessionId);
        const turn = agent ? ctx.agents.turnBoundaryOf(agent.session).lastTurn : budgets.get(sessionId)?.turn ?? 0;
        const started = Date.now();
        const recall = store.recall({ userText, tz, now: Date.now(), excludeSessionId: sessionId, excludeTurn: turn });
        const rendered = renderMemoryContext(recall, tz);
        obs.recall(sessionId, turn, {
          query: userText,
          tz,
          durationMs: Date.now() - started,
          window: recall.window,
          turns: recall.turns.map((t) => ({ sessionId: t.sessionId, turn: t.turn, startedAt: t.startedAt, userText: t.userText })),
          facts: recall.facts.map((f) => ({ entity: f.entity, attribute: f.attribute, value: f.value, citationId: f.citationId })),
          snapshots: recall.snapshots.map((s) => ({ subject: s.subject, updatedAt: s.updatedAt })),
          renderedChars: rendered.length
        });
        if (config.debug) {
          writeDebug("last-memory-context.txt", `session=${sessionId}
turn_user=${userText}

${rendered}`);
        }
        return rendered;
      } catch (err) {
        debugLog("memory provider failed", String(err));
        return "";
      }
    }
  });
  ctx.on("agent/pre-step", async (payload, next) => {
    try {
      const sessionId = payload.agent.session.header.id;
      const tz = sourceTz(payload.messages?.[0], fallbackTz);
      tzBySession.set(sessionId, tz);
      for (const message of payload.messages ?? []) {
        const text = messageText(message);
        if (text && (message?.source?.kind === "user" || !message?.source)) {
          latestUserBySession.set(sessionId, text);
          latestSessionId = sessionId;
        }
      }
      const schemas = ctx.tools.schemas(payload.agent).map((s) => s.name);
      writeDebug("runtime-tools.json", {
        sessionId,
        turn: ctx.agents.turnBoundaryOf(payload.agent.session).lastTurn,
        tools: schemas,
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      });
      const disabled = ["bash", "pwsh", "read_file", "write", "edit", "glob", "grep", "web_fetch", "ask_user_question", "todo_write", "run_code", "subagent", "subagent_fork"];
      const registered = Object.fromEntries(disabled.map((n) => [n, Boolean(ctx.tools.get(n, payload.agent))]));
      writeDebug("tool-boundary.json", { visible: schemas, disabledProbe: registered, updatedAt: (/* @__PURE__ */ new Date()).toISOString() });
      debugLog("runtime tools", schemas);
    } catch (err) {
      debugLog("pre-step hook failed", String(err));
    }
    return next();
  });
  ctx.on("agent/assistant-stream", (payload, maybeFrame) => {
    try {
      const frame = payload?.frame ?? maybeFrame ?? payload;
      const agent = payload?.agent;
      const chunk = frame?.chunk;
      const hasText = chunk?.type === "text-delta" && String(chunk.text ?? "").trim() || chunk?.type === "text-chunks" && (chunk.texts ?? []).join("").trim();
      if (frame?.type === "chunk" && hasText) {
        obs.firstText(agent?.session?.header?.id, Number(frame.turn));
      }
    } catch {
    }
  });
  ctx.on("session/event", (session, event) => {
    try {
      const sessionId = session.header.id;
      if (event.type === "turn/start") {
        obs.begin(sessionId, event.data.turn);
        budgetFor(sessionId, event.data.turn);
        store.beginTurn(sessionId, event.data.turn, tzFor(sessionId));
      } else if (event.type === "user/message") {
        const kind = event.data?.source?.kind;
        if (kind && kind !== "user") return;
        const text = messageText(event.data);
        if (!text) return;
        const tz = sourceTz(event.data, tzFor(sessionId));
        tzBySession.set(sessionId, tz);
        latestUserBySession.set(sessionId, text);
        latestSessionId = sessionId;
        const turn = budgets.get(sessionId)?.turn ?? ctx.agents.turnBoundaryOf(session).lastTurn;
        obs.user(sessionId, turn, text);
        store.beginTurn(sessionId, turn, tz, Date.now());
        store.setUser(sessionId, turn, text, tz);
      } else if (event.type === "step/start") {
        obs.stepStart(sessionId, Number(event.data.turn), Number(event.data.step));
      } else if (event.type === "assistant/message") {
        const text = messageText(event.data.message);
        const turn = Number(event.data.turn);
        obs.assistant(sessionId, turn, text, event.data.usage, Boolean(event.data.interrupted), Number(event.data.step));
        if (text) store.setAssistant(sessionId, turn, text, Boolean(event.data.interrupted));
      } else if (event.type === "turn/end") {
        obs.end(sessionId, Number(event.data.turn));
      } else if (event.type === "request/header") {
        const tools = Array.isArray(event.data.header?.tools) ? event.data.header.tools.map((t) => t?.name).filter(Boolean) : [];
        writeDebug("runtime-tools.json", {
          sessionId,
          turn: ctx.agents.turnBoundaryOf(session).lastTurn,
          tools,
          updatedAt: (/* @__PURE__ */ new Date()).toISOString()
        });
      }
    } catch (err) {
      debugLog("session event hook failed", String(err));
    }
  });
}
export {
  apply,
  inject,
  name
};
