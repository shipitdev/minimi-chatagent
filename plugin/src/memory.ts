/**
 * Durable dated memory for Minimi.
 *
 * SQLite is the source of truth for Minimi's dated turns, observations, and
 * shortlist baselines. DSH's own JSONL session log remains the transcript the
 * web UI replays; `session_id` here is the exact DSH SessionId, and `turn` is
 * the loop's turn number. That pair is the join key between the two stores.
 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.ts'
import { formatInZone, resolveTimeZone, zonedDayStartUtc } from './time.ts'

export interface MemoryCitation {
  id: string
  title: string
  url: string
  domain: string
  publishedAt: string | null
  retrievedAt: string
  authority: number
}

export interface StoredFact {
  entity: string
  attribute: string
  value: string
  kind: string
  citationId: string
  url: string
  title: string
  publishedAt: string | null
  retrievedAt: string
  qualifiers: string[]
  evidence: string
}

export interface TurnRecord {
  sessionId: string
  turn: number
  tz: string
  startedAt: number
  userText: string
  assistantText: string
  interrupted: boolean
}

export interface SnapshotRecord {
  subject: string
  subjectKey: string
  facts: StoredFact[]
  citations: MemoryCitation[]
  updatedAt: number
  tz: string
  sessionId: string | null
}

export interface RecallResult {
  turns: TurnRecord[]
  facts: StoredFact[]
  snapshots: SnapshotRecord[]
  window: { from: number; to: number; label: string } | null
  now: number
}

export function subjectKey(subject: string): string {
  return subject.toLowerCase().normalize('NFKC').replace(/[^a-z0-9]+/g, ' ').trim()
}

const STOP = new Set(
  `the a an and or but if of to in on for with is are was were be been it its this that these those
   as at by from we you they he she my your our their me us them do does did so than then there here
   what which who when where how why can could should would will just about into not no yes also more
   most other such only own same very s t don now i you've i've whats what's told tell said say
   remember recall discussed discuss talked talk conversation earlier previous before again please
   answer question tell`
    .split(/\s+/)
    .filter(Boolean),
)

export function keywords(text: string): string[] {
  return [...new Set((text.toLowerCase().normalize('NFKC').match(/[a-z0-9][a-z0-9.+#-]*/g) ?? [])
    .map((w) => w.replace(/\.+$/, ''))
    .filter((w) => w.length > 2 && !STOP.has(w)))]
}

function includesAny(haystack: string, words: string[]): number {
  const h = haystack.toLowerCase()
  let n = 0
  for (const w of words) if (h.includes(w)) n++
  return n
}

export class MemoryStore {
  readonly db: DatabaseSync
  constructor(file = config.dbPath) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
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
    `)
  }

  close(): void {
    try { this.db.close() } catch { /* already closed */ }
  }

  /** Erase all Minimi state attached to one DSH session. */
  deleteSession(sessionId: string): void {
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM turns WHERE session_id = ?').run(sessionId)
      this.db.prepare('DELETE FROM facts WHERE session_id = ?').run(sessionId)
      this.db.prepare('DELETE FROM searches WHERE session_id = ?').run(sessionId)
      this.db.prepare('DELETE FROM snapshots WHERE session_id = ?').run(sessionId)
      this.db.exec('COMMIT')
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* preserve original error */ }
      throw error
    }
  }

  beginTurn(sessionId: string, turn: number, tz: string, startedAt = Date.now()): void {
    this.db.prepare(`
      INSERT INTO turns (session_id, turn, tz, started_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id, turn) DO UPDATE SET tz = excluded.tz
    `).run(sessionId, turn, tz, startedAt)
  }

  setUser(sessionId: string, turn: number, text: string, tz: string): void {
    this.beginTurn(sessionId, turn, tz)
    this.db.prepare(`UPDATE turns SET user_text = ? WHERE session_id = ? AND turn = ?`).run(text, sessionId, turn)
  }

  setAssistant(sessionId: string, turn: number, text: string, interrupted: boolean): void {
    this.db.prepare(`UPDATE turns SET assistant_text = ?, interrupted = ? WHERE session_id = ? AND turn = ?`)
      .run(text, interrupted ? 1 : 0, sessionId, turn)
  }

  recordFacts(sessionId: string, turn: number, facts: StoredFact[], createdAt = Date.now()): void {
    if (!facts.length) return
    const insert = this.db.prepare(`
      INSERT INTO facts
        (session_id, turn, entity, attribute, value, kind, citation_id, url, title,
         published_at, retrieved_at, qualifiers, evidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const f of facts) {
      insert.run(
        sessionId, turn, f.entity, f.attribute, f.value, f.kind, f.citationId, f.url, f.title,
        f.publishedAt, f.retrievedAt, JSON.stringify(f.qualifiers), f.evidence, createdAt,
      )
    }
  }

  recordSearch(
    sessionId: string,
    turn: number,
    intent: string,
    items: unknown,
    digest: string,
    citations: MemoryCitation[],
    attempts: number,
    createdAt = Date.now(),
  ): void {
    this.db.prepare(`
      INSERT INTO searches (session_id, turn, intent, items, digest, citations, attempts, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, turn, intent, JSON.stringify(items), digest, JSON.stringify(citations), attempts, createdAt)
  }

  saveSnapshot(snapshot: SnapshotRecord): void {
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
      snapshot.subjectKey, snapshot.subject, JSON.stringify(snapshot.facts),
      JSON.stringify(snapshot.citations), snapshot.sessionId, snapshot.tz, snapshot.updatedAt,
    )
  }

  getSnapshot(subject: string): SnapshotRecord | null {
    const key = subjectKey(subject)
    const row = this.db.prepare(`SELECT * FROM snapshots WHERE subject_key = ?`).get(key) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      subject: String(row.subject),
      subjectKey: String(row.subject_key),
      facts: JSON.parse(String(row.facts)) as StoredFact[],
      citations: JSON.parse(String(row.citations)) as MemoryCitation[],
      updatedAt: Number(row.updated_at),
      tz: String(row.tz),
      sessionId: row.session_id == null ? null : String(row.session_id),
    }
  }

  snapshotCount(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM snapshots`).get() as { n: number }
    return Number(row.n)
  }

  turnCount(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM turns`).get() as { n: number }
    return Number(row.n)
  }

  /**
   * Retrieve the right earlier observation by date and topic. Date phrases are
   * resolved in the conversation's IANA zone; facts and snapshots are matched by
   * entity/attribute/value text. Falls back to recent records for bare recall
   * cues such as "what did we discuss?".
   */
  recall(input: { userText: string; tz: string; now?: number; limitTurns?: number; limitFacts?: number; limitSnapshots?: number; excludeSessionId?: string; excludeTurn?: number }): RecallResult {
    const now = input.now ?? Date.now()
    const tz = resolveTimeZone(input.tz, 'UTC')
    const words = keywords(input.userText)
    const window = resolveWindow(input.userText, tz, now)
    const recallCue = /\b(remember|recall|discuss|talked|told|said|earlier|previous|before|yesterday|last\s+time|last\s+week|last\s+month|history|conversation|we\s+spoke)\b/i.test(input.userText)
    const changeCue = /\b(change|changed|update|updated|latest|current|now|compare|since|re-?check)\b/i.test(input.userText)
    const commitmentCue = /\b(promise|promised|outstanding|owe|owed|deliverable|deadline|still\s+(?:open|need|pending|gotta)|gotta|to\s+do|todo|follow\s*up|remains?)\b/i.test(input.userText)
    const notesCue = /\b(notes?|recap|summari[sz]e|summary)\b/i.test(input.userText)

    const turnRows = this.db.prepare(`
      SELECT * FROM turns ORDER BY started_at DESC LIMIT 400
    `).all() as Array<Record<string, unknown>>

    const turns: TurnRecord[] = turnRows.map((r) => ({
      sessionId: String(r.session_id),
      turn: Number(r.turn),
      tz: String(r.tz),
      startedAt: Number(r.started_at),
      userText: String(r.user_text ?? ''),
      assistantText: String(r.assistant_text ?? ''),
      interrupted: Number(r.interrupted) === 1,
    }))

    const scoredTurns = turns
      .filter((t) => !(t.sessionId === input.excludeSessionId && t.turn === input.excludeTurn))
      .filter((t) => !window || (t.startedAt >= window.from && t.startedAt <= window.to))
      .map((t) => {
        let score = includesAny(`${t.userText}\n${t.assistantText}`, words) * 2
        if (window) score += 1.5
        if (recallCue) score += 0.5
        if (commitmentCue) score += 0.3
        if (notesCue) score += 0.2
        // Prefer answers that actually contain a fact, not an empty interruption.
        if (t.assistantText.trim()) score += 0.2
        return { t, score }
      })
      .filter(({ t, score }) => {
        if (!t.userText.trim()) return false
        if (words.length === 0) return Boolean(window) || recallCue
        return includesAny(`${t.userText}\n${t.assistantText}`, words) > 0 || Boolean(window) || ((commitmentCue || notesCue) && t.startedAt >= now - 30 * 86_400_000)
      })
      .sort((a, b) => b.score - a.score || b.t.startedAt - a.t.startedAt)
      .slice(0, input.limitTurns ?? 6)
      .map(({ t }) => t)

    const factRows = this.db.prepare(`SELECT * FROM facts ORDER BY created_at DESC LIMIT 600`).all() as Array<Record<string, unknown>>
    const facts: StoredFact[] = factRows
      .map((r) => ({
        row: r,
        score: includesAny(`${r.entity} ${r.attribute} ${r.value} ${r.evidence}`, words),
      }))
      .filter(({ row, score }) => {
        if (window && (Number(row.created_at) < window.from || Number(row.created_at) > window.to)) return false
        if (words.length === 0) return Boolean(window) || changeCue
        return score > 0
      })
      .sort((a, b) => b.score - a.score || Number(b.row.created_at) - Number(a.row.created_at))
      .slice(0, input.limitFacts ?? 8)
      .map(({ row }) => ({
        entity: String(row.entity),
        attribute: String(row.attribute),
        value: String(row.value),
        kind: String(row.kind),
        citationId: String(row.citation_id),
        url: String(row.url),
        title: String(row.title),
        publishedAt: row.published_at == null ? null : String(row.published_at),
        retrievedAt: String(row.retrieved_at),
        qualifiers: JSON.parse(String(row.qualifiers ?? '[]')) as string[],
        evidence: String(row.evidence ?? ''),
      }))

    const snapRows = this.db.prepare(`SELECT * FROM snapshots ORDER BY updated_at DESC LIMIT 100`).all() as Array<Record<string, unknown>>
    const snapshots: SnapshotRecord[] = snapRows
      .map((r) => ({
        row: r,
        score: includesAny(`${r.subject} ${r.facts}`, words),
      }))
      .filter(({ row, score }) => (!window || (Number(row.updated_at) >= window.from && Number(row.updated_at) <= window.to)) && (words.length === 0 ? Boolean(changeCue) : score > 0))
      .sort((a, b) => b.score - a.score || Number(b.row.updated_at) - Number(a.row.updated_at))
      .slice(0, input.limitSnapshots ?? 4)
      .map(({ row }) => ({
        subject: String(row.subject),
        subjectKey: String(row.subject_key),
        facts: JSON.parse(String(row.facts)) as StoredFact[],
        citations: JSON.parse(String(row.citations)) as MemoryCitation[],
        updatedAt: Number(row.updated_at),
        tz: String(row.tz),
        sessionId: row.session_id == null ? null : String(row.session_id),
      }))

    return { turns: scoredTurns, facts, snapshots, window, now }
  }
}

/** Resolve a human date phrase to a UTC window in the user's zone. */
export function resolveWindow(text: string, tz: string, now: number): { from: number; to: number; label: string } | null {
  const t = text.toLowerCase()
  const [year, month, date] = dateParts(now, tz)
  const start = (y: number, m: number, d: number): number => {
    const normalized = new Date(Date.UTC(y, m - 1, d))
    return zonedDayStartUtc(normalized.getUTCFullYear(), normalized.getUTCMonth() + 1, normalized.getUTCDate(), tz)
  }
  const range = (from: number, to: number, label: string) => ({ from, to: to - 1, label })
  const months = ['january','february','march','april','may','june','july','august','september','october','november','december']
  const monthIndex = (name: string): number => {
    const key = name.toLowerCase().replace(/\./g, '')
    const full = months.findIndex((m) => m === key)
    if (full >= 0) return full + 1
    const abbrev = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(key.slice(0, 3))
    return abbrev >= 0 ? abbrev + 1 : 0
  }
  // Explicit calendar references take precedence over a trailing "today" cue:
  // "we said ... on nov 5, true today?" asks about Nov 5, not today.
  const iso = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(t)
  if (iso) {
    const from = zonedDayStartUtc(Number(iso[1]), Number(iso[2]), Number(iso[3]), tz)
    return range(from, start(Number(iso[1]), Number(iso[2]), Number(iso[3]) + 1), iso[0])
  }
  const monthName = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)'
  const md = new RegExp(`\\b${monthName}\\s+(\\d{1,2})(?:,?\\s+(20\\d{2}))?\\b`, 'i').exec(text)
  const dm = new RegExp(`\\b(\\d{1,2})\\s+${monthName}(?:,?\\s+(20\\d{2}))?\\b`, 'i').exec(text)
  if (md || dm) {
    const day = md ? Number(md[2]) : Number(dm![1])
    const monthToken = md ? md[1]! : dm![2]!
    const yearToken = md ? md[3] : dm![3]
    const m = monthIndex(monthToken)
    if (!m) return null
    const y = yearToken ? Number(yearToken) : year
    return range(zonedDayStartUtc(y, m, day, tz), start(y, m, day + 1), (md ?? dm)![0])
  }
  const ordinal = /\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\b/i.exec(text)
  if (ordinal) {
    const day = Number(ordinal[1])
    return range(start(year, month, day), start(year, month, day + 1), ordinal[0])
  }
  const today = start(year, month, date)
  if (/\bday before yesterday\b/.test(t)) return range(start(year, month, date - 2), start(year, month, date - 1), 'day before yesterday')
  if (/\byesterday\b/.test(t)) return range(start(year, month, date - 1), today, 'yesterday')
  if (/\btoday\b/.test(t)) return { from: today, to: now, label: 'today' }
  const dow = new Date(Date.UTC(year, month - 1, date)).getUTCDay()
  const monday = date - ((dow + 6) % 7)
  if (/\blast\s+week\b/.test(t)) return range(start(year, month, monday - 7), start(year, month, monday), 'last week (Monday–Sunday)')
  if (/\bthis\s+week\b/.test(t)) return { from: start(year, month, monday), to: now, label: 'this week' }
  if (/\blast\s+month\b/.test(t)) return range(start(year, month - 1, 1), start(year, month, 1), 'last month')
  if (/\bthis\s+month\b/.test(t)) return { from: start(year, month, 1), to: now, label: 'this month' }
  return null
}

function dateParts(now: number, tz: string): [number, number, number] {
  const parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: tz })
    .formatToParts(new Date(now))
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  return [get('year'), get('month'), get('day')]
}

export function describeTurn(t: TurnRecord): string {
  const when = formatInZone(t.startedAt, t.tz)
  const user = t.userText.replace(/\s+/g, ' ').trim().slice(0, 320)
  const answer = t.assistantText.replace(/\s+/g, ' ').trim().slice(0, 520)
  return `- ${when} [session ${t.sessionId.replace(/^session-/, '').slice(0, 8)}, turn ${t.turn}] user: "${user}"${answer ? ` => ${answer}` : ''}`
}
