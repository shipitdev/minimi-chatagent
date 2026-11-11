/**
 * Durable memory.
 *
 * Storage choice: `node:sqlite` (built into Node ≥22.5). It gives real SQL,
 * transactions and indexes with **zero native compilation**, which is what makes
 * `npm install && npm run dev` work on a clean machine without a compiler
 * toolchain. The alternative, better-sqlite3, is faster but needs node-gyp.
 *
 * Timezone model: every instant is stored as UTC epoch milliseconds, and every
 * row that a human might refer to by date also stores the IANA zone it was
 * observed in. "Show me yesterday" therefore resolves to a different UTC window
 * per timezone, which is the whole point — a naive `stored_date = '2026-11-10'`
 * column would silently return the wrong conversation for anyone who travelled.
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { Citation, Fact } from "./digest.js";
import type { Usage } from "./config.js";

export type Role = "user" | "assistant";

export interface ConversationRow {
  id: string;
  title: string;
  tz: string;
  tzOffsetMin: number;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface MessageRow {
  id: number;
  conversationId: string;
  role: Role;
  content: string;
  openuiLang: string | null;
  citations: Citation[];
  digestStats: DigestStatsRow | null;
  usage: Usage | null;
  createdAt: number;
}

export interface DigestStatsRow {
  inputTokens: number;
  digestTokens: number;
  ratio: number;
  factsExtracted: number;
  duplicatesRemoved: number;
}

export interface ImportedTurn {
  id: string;
  threadId: string;
  /** UTC epoch ms of the original turn. */
  ts: number;
  tz: string;
  user: string;
  assistant: string;
  evidence: EvidenceDoc[];
}

/** A cited source that came with imported history or a replayed search. */
export interface EvidenceDoc {
  id: string;
  url: string;
  title: string;
  excerpt: string;
  aliases: string[];
  observedAt: string | null;
  effectiveAt: string | null;
}

export interface MemoryRow {
  id: number;
  conversationId: string | null;
  entity: string;
  attribute: string;
  value: string;
  kind: string;
  source: "user" | "web";
  url: string | null;
  observedAt: number;
  tz: string;
}

export interface ShortlistRow {
  id: string;
  conversationId: string | null;
  name: string;
  tz: string;
  createdAt: number;
  updatedAt: number;
  itemCount?: number;
}

export interface ShortlistItemRow {
  id: string;
  shortlistId: string;
  label: string;
  query: string;
  baselineFacts: Fact[];
  baselineCitations: Citation[];
  lastCheckedAt: number | null;
  lastStatus: string | null;
}

export type RunStatus = "queued" | "running" | "done" | "partial" | "failed";

export interface RunRow {
  id: string;
  shortlistId: string;
  status: RunStatus;
  createdAt: number;
  finishedAt: number | null;
  total: number;
  done: number;
  failed: number;
}

export interface RunItemRow {
  runId: string;
  itemId: string;
  status: "pending" | "checking" | "done" | "failed";
  changes: unknown[];
  citations: Citation[];
  error: string | null;
  digestRatio: number | null;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  tz TEXT NOT NULL,
  tz_offset_min INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_created ON conversations(created_at);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  openui_lang TEXT,
  citations TEXT,
  digest_stats TEXT,
  usage TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS imported_turns (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  tz TEXT NOT NULL,
  user TEXT NOT NULL,
  assistant TEXT NOT NULL,
  evidence TEXT
);
CREATE INDEX IF NOT EXISTS idx_imported_ts ON imported_turns(ts);

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT,
  entity TEXT NOT NULL,
  attribute TEXT NOT NULL,
  value TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other',
  source TEXT NOT NULL DEFAULT 'user',
  url TEXT,
  observed_at INTEGER NOT NULL,
  tz TEXT NOT NULL,
  UNIQUE(entity, attribute, value, observed_at)
);
CREATE INDEX IF NOT EXISTS idx_mem_entity ON memories(entity);
CREATE INDEX IF NOT EXISTS idx_mem_observed ON memories(observed_at);

CREATE TABLE IF NOT EXISTS shortlists (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  name TEXT NOT NULL,
  tz TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS shortlist_items (
  id TEXT PRIMARY KEY,
  shortlist_id TEXT NOT NULL REFERENCES shortlists(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  query TEXT NOT NULL,
  baseline_facts TEXT,
  baseline_citations TEXT,
  last_checked_at INTEGER,
  last_status TEXT
);
CREATE INDEX IF NOT EXISTS idx_item_shortlist ON shortlist_items(shortlist_id);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  shortlist_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  total INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS run_items (
  run_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  status TEXT NOT NULL,
  changes TEXT,
  citations TEXT,
  error TEXT,
  digest_ratio REAL,
  PRIMARY KEY (run_id, item_id)
);
`;

export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // -- conversations -----------------------------------------------------

  createConversation(args: { id: string; title: string; tz: string; tzOffsetMin: number }): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO conversations (id, title, tz, tz_offset_min, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(args.id, args.title, args.tz, args.tzOffsetMin, now, now);
  }

  touchConversation(id: string, title?: string): void {
    const now = Date.now();
    if (title) {
      this.db
        .prepare(`UPDATE conversations SET updated_at = ?, title = CASE WHEN title = '' THEN ? ELSE title END WHERE id = ?`)
        .run(now, title, id);
    } else {
      this.db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(now, id);
    }
  }

  getConversation(id: string): ConversationRow | null {
    const row = this.db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
         FROM conversations c WHERE c.id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    return row ? mapConversation(row) : null;
  }

  listConversations(limit = 50): ConversationRow[] {
    const rows = this.db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
         FROM conversations c ORDER BY c.updated_at DESC LIMIT ?`,
      )
      .all(limit) as Record<string, unknown>[];
    return rows.map(mapConversation);
  }

  /**
   * Find conversations in a UTC window. `hasQuery` filtering happens in JS over
   * messages because SQL `LIKE` cannot express the tokenised match we want, and
   * the row counts here are small by construction (a window is days, not years).
   */
  findConversationsInRange(startUtc: number, endUtc: number, termFilter?: string[]): ConversationRow[] {
    const rows = this.db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
         FROM conversations c
         WHERE c.updated_at >= ? AND c.updated_at < ?
         ORDER BY c.updated_at DESC`,
      )
      .all(startUtc, endUtc) as Record<string, unknown>[];
    const convs = rows.map(mapConversation);
    if (!termFilter || termFilter.length === 0) return convs;
    const wanted = new Set(termFilter.map((t) => t.toLowerCase()));
    return convs.filter((c) => {
      if (wanted.has(c.title.toLowerCase())) return true;
      const text = this.conversationText(c.id).toLowerCase();
      let hits = 0;
      for (const t of wanted) if (text.includes(t)) hits++;
      return hits > 0;
    });
  }

  conversationText(id: string): string {
    const rows = this.db
      .prepare(`SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at`)
      .all(id) as Array<{ role: string; content: string }>;
    return rows.map((r) => `${r.role}: ${r.content}`).join("\n");
  }

  // -- messages ----------------------------------------------------------

  addMessage(args: {
    conversationId: string;
    role: Role;
    content: string;
    openuiLang?: string | null;
    citations?: Citation[];
    digestStats?: DigestStatsRow | null;
    usage?: Usage | null;
    createdAt?: number;
  }): number {
    const res = this.db
      .prepare(
        `INSERT INTO messages (conversation_id, role, content, openui_lang, citations, digest_stats, usage, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        args.conversationId,
        args.role,
        args.content,
        args.openuiLang ?? null,
        args.citations ? JSON.stringify(args.citations) : null,
        args.digestStats ? JSON.stringify(args.digestStats) : null,
        args.usage ? JSON.stringify(args.usage) : null,
        args.createdAt ?? Date.now(),
      );
    return Number(res.lastInsertRowid);
  }

  listMessages(conversationId: string, limit = 200): MessageRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC LIMIT ?`,
      )
      .all(conversationId, limit) as Record<string, unknown>[];
    return rows.map(mapMessage);
  }

  recentTurns(conversationId: string, limit = 6): MessageRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(conversationId, limit) as Record<string, unknown>[];
    return rows.reverse().map(mapMessage);
  }

  // -- imported history --------------------------------------------------

  /**
   * Import a prior exchange with its original id and timestamp.
   *
   * Kept in its own table rather than merged into `messages` because an imported
   * turn is evidence with provenance: it keeps its source ids so a later answer can
   * cite "what you were told on 3 November" by the ids it was recorded under.
   */
  importTurn(t: ImportedTurn): void {
    this.db
      .prepare(
        `INSERT INTO imported_turns (id, thread_id, ts, tz, user, assistant, evidence)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           thread_id = excluded.thread_id, ts = excluded.ts, tz = excluded.tz,
           user = excluded.user, assistant = excluded.assistant, evidence = excluded.evidence`,
      )
      .run(t.id, t.threadId, t.ts, t.tz, t.user, t.assistant, JSON.stringify(t.evidence));
  }

  importedTurns(): ImportedTurn[] {
    const rows = this.db
      .prepare(`SELECT * FROM imported_turns ORDER BY ts ASC`)
      .all() as Record<string, unknown>[];
    return rows.map(mapImportedTurn);
  }

  importedTurnsInRange(startUtc: number, endUtc: number): ImportedTurn[] {
    const rows = this.db
      .prepare(`SELECT * FROM imported_turns WHERE ts >= ? AND ts < ? ORDER BY ts ASC`)
      .all(startUtc, endUtc) as Record<string, unknown>[];
    return rows.map(mapImportedTurn);
  }

  importedTurnsByIds(ids: string[]): ImportedTurn[] {
    if (ids.length === 0) return [];
    const marks = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM imported_turns WHERE id IN (${marks}) ORDER BY ts ASC`)
      .all(...ids) as Record<string, unknown>[];
    return rows.map(mapImportedTurn);
  }

  // -- memories ----------------------------------------------------------

  upsertMemory(m: Omit<MemoryRow, "id">): void {
    this.db
      .prepare(
        `INSERT INTO memories (conversation_id, entity, attribute, value, kind, source, url, observed_at, tz)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(entity, attribute, value, observed_at) DO NOTHING`,
      )
      .run(
        m.conversationId,
        m.entity,
        m.attribute,
        m.value,
        m.kind,
        m.source,
        m.url,
        m.observedAt,
        m.tz,
      );
  }

  memoriesForEntity(entity: string, limit = 20): MemoryRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memories WHERE lower(entity) = lower(?) ORDER BY observed_at DESC LIMIT ?`,
      )
      .all(entity, limit) as Record<string, unknown>[];
    return rows.map(mapMemory);
  }

  findMemories(term: string, limit = 20): MemoryRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memories WHERE lower(entity) LIKE ? OR lower(value) LIKE ?
         ORDER BY observed_at DESC LIMIT ?`,
      )
      .all(`%${term.toLowerCase()}%`, `%${term.toLowerCase()}%`, limit) as Record<string, unknown>[];
    return rows.map(mapMemory);
  }

  // -- shortlists --------------------------------------------------------

  createShortlist(args: { id: string; conversationId: string | null; name: string; tz: string }): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO shortlists (id, conversation_id, name, tz, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(args.id, args.conversationId, args.name, args.tz, now, now);
  }

  getShortlist(id: string): (ShortlistRow & { items: ShortlistItemRow[] }) | null {
    const row = this.db.prepare(`SELECT * FROM shortlists WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    const items = this.db
      .prepare(`SELECT * FROM shortlist_items WHERE shortlist_id = ? ORDER BY rowid ASC`)
      .all(id) as Record<string, unknown>[];
    return { ...mapShortlist(row), items: items.map(mapShortlistItem) };
  }

  listShortlists(): ShortlistRow[] {
    const rows = this.db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM shortlist_items i WHERE i.shortlist_id = s.id) AS item_count
         FROM shortlists s ORDER BY s.updated_at DESC`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      ...mapShortlist(r),
      itemCount: Number(r.item_count ?? 0),
    }));
  }

  addShortlistItem(args: {
    id: string;
    shortlistId: string;
    label: string;
    query: string;
    baselineFacts: Fact[];
    baselineCitations: Citation[];
  }): void {
    this.db
      .prepare(
        `INSERT INTO shortlist_items (id, shortlist_id, label, query, baseline_facts, baseline_citations)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        args.id,
        args.shortlistId,
        args.label,
        args.query,
        JSON.stringify(args.baselineFacts),
        JSON.stringify(args.baselineCitations),
      );
    this.db.prepare(`UPDATE shortlists SET updated_at = ? WHERE id = ?`).run(Date.now(), args.shortlistId);
  }

  updateItemBaseline(itemId: string, facts: Fact[], citations: Citation[], status: string): void {
    this.db
      .prepare(
        `UPDATE shortlist_items SET baseline_facts = ?, baseline_citations = ?, last_checked_at = ?, last_status = ? WHERE id = ?`,
      )
      .run(JSON.stringify(facts), JSON.stringify(citations), Date.now(), status, itemId);
  }

  // -- runs --------------------------------------------------------------

  createRun(run: { id: string; shortlistId: string; total: number }): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, shortlist_id, status, created_at, total, done, failed)
         VALUES (?, ?, 'queued', ?, ?, 0, 0)`,
      )
      .run(run.id, run.shortlistId, Date.now(), run.total);
  }

  setRunStatus(id: string, status: RunStatus): void {
    const finished = status === "done" || status === "partial" || status === "failed" ? Date.now() : null;
    this.db
      .prepare(`UPDATE runs SET status = ?, finished_at = COALESCE(?, finished_at) WHERE id = ?`)
      .run(status, finished, id);
  }

  bumpRunCounters(id: string, args: { done?: number; failed?: number }): void {
    this.db
      .prepare(`UPDATE runs SET done = done + ?, failed = failed + ? WHERE id = ?`)
      .run(args.done ?? 0, args.failed ?? 0, id);
  }

  getRun(id: string): (RunRow & { items: RunItemRow[] }) | null {
    const row = this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    const items = this.db
      .prepare(`SELECT * FROM run_items WHERE run_id = ? ORDER BY rowid ASC`)
      .all(id) as Record<string, unknown>[];
    return { ...mapRun(row), items: items.map(mapRunItem) };
  }

  /** Resume support: the set of items a run still has to check. */
  resumableRunItems(runId: string): RunItemRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM run_items WHERE run_id = ? AND status IN ('pending','checking')`)
      .all(runId) as Record<string, unknown>[];
    return rows.map(mapRunItem);
  }

  upsertRunItem(
    item: Pick<RunItemRow, "runId" | "itemId" | "status"> & {
      changes?: unknown[];
      citations?: Citation[];
      error?: string | null;
      digestRatio?: number | null;
    },
  ): void {
    this.db
      .prepare(
        `INSERT INTO run_items (run_id, item_id, status, changes, citations, error, digest_ratio)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, item_id) DO UPDATE SET
           status = excluded.status,
           changes = excluded.changes,
           citations = excluded.citations,
           error = excluded.error,
           digest_ratio = excluded.digest_ratio`,
      )
      .run(
        item.runId,
        item.itemId,
        item.status,
        item.changes ? JSON.stringify(item.changes) : null,
        item.citations ? JSON.stringify(item.citations) : null,
        item.error ?? null,
        item.digestRatio ?? null,
      );
  }

  listRuns(limit = 20): RunRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM runs ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];
    return rows.map(mapRun);
  }
}

// ---------------------------------------------------------------------------
// Row mappers — SQLite returns snake_case and JSON-as-TEXT
// ---------------------------------------------------------------------------

function n(v: unknown, fallback = 0): number {
  return typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : fallback;
}
function s(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function json<T>(v: unknown, fallback: T): T {
  if (typeof v !== "string" || !v) return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

function mapConversation(r: Record<string, unknown>): ConversationRow {
  return {
    id: s(r.id),
    title: s(r.title),
    tz: s(r.tz, "UTC"),
    tzOffsetMin: n(r.tz_offset_min),
    createdAt: n(r.created_at),
    updatedAt: n(r.updated_at),
    messageCount: n(r.message_count),
  };
}

function mapMessage(r: Record<string, unknown>): MessageRow {
  return {
    id: n(r.id),
    conversationId: s(r.conversation_id),
    role: s(r.role) === "assistant" ? "assistant" : "user",
    content: s(r.content),
    openuiLang: typeof r.openui_lang === "string" ? r.openui_lang : null,
    citations: json<Citation[]>(r.citations, []),
    digestStats: json<DigestStatsRow | null>(r.digest_stats, null),
    usage: json<Usage | null>(r.usage, null),
    createdAt: n(r.created_at),
  };
}

function mapImportedTurn(r: Record<string, unknown>): ImportedTurn {
  return {
    id: s(r.id),
    threadId: s(r.thread_id),
    ts: n(r.ts),
    tz: s(r.tz, "UTC"),
    user: s(r.user),
    assistant: s(r.assistant),
    evidence: json<EvidenceDoc[]>(r.evidence, []),
  };
}

function mapMemory(r: Record<string, unknown>): MemoryRow {
  return {
    id: n(r.id),
    conversationId: typeof r.conversation_id === "string" ? r.conversation_id : null,
    entity: s(r.entity),
    attribute: s(r.attribute),
    value: s(r.value),
    kind: s(r.kind),
    source: s(r.source) === "web" ? "web" : "user",
    url: typeof r.url === "string" ? r.url : null,
    observedAt: n(r.observed_at),
    tz: s(r.tz, "UTC"),
  };
}

function mapShortlist(r: Record<string, unknown>): ShortlistRow {
  return {
    id: s(r.id),
    conversationId: typeof r.conversation_id === "string" ? r.conversation_id : null,
    name: s(r.name),
    tz: s(r.tz, "UTC"),
    createdAt: n(r.created_at),
    updatedAt: n(r.updated_at),
  };
}

function mapShortlistItem(r: Record<string, unknown>): ShortlistItemRow {
  return {
    id: s(r.id),
    shortlistId: s(r.shortlist_id),
    label: s(r.label),
    query: s(r.query),
    baselineFacts: json<Fact[]>(r.baseline_facts, []),
    baselineCitations: json<Citation[]>(r.baseline_citations, []),
    lastCheckedAt: typeof r.last_checked_at === "number" ? r.last_checked_at : null,
    lastStatus: typeof r.last_status === "string" ? r.last_status : null,
  };
}

function mapRun(r: Record<string, unknown>): RunRow {
  return {
    id: s(r.id),
    shortlistId: s(r.shortlist_id),
    status: s(r.status, "queued") as RunStatus,
    createdAt: n(r.created_at),
    finishedAt: typeof r.finished_at === "number" ? r.finished_at : null,
    total: n(r.total),
    done: n(r.done),
    failed: n(r.failed),
  };
}

function mapRunItem(r: Record<string, unknown>): RunItemRow {
  return {
    runId: s(r.run_id),
    itemId: s(r.item_id),
    status: s(r.status, "pending") as RunItemRow["status"],
    changes: json<unknown[]>(r.changes, []),
    citations: json<Citation[]>(r.citations, []),
    error: typeof r.error === "string" ? r.error : null,
    digestRatio: typeof r.digest_ratio === "number" ? r.digest_ratio : null,
  };
}
