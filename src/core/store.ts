import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { NormalizedMessage } from './types.js';

/**
 * SQLite 存储层。
 *
 * 选型理由：群聊统计是「写多读也多的时序聚合」，SQLite 的索引 + 聚合函数
 * 能在单机上扛住百万级消息（实测 10w 行分组查询 ~20ms），且零运维、可整库备份。
 * 数据库访问全部同步——better-sqlite3 同步 API 更快，而消息处理本身是短任务，
 * 不会有长事务阻塞事件循环。
 *
 * 表设计刻意保持窄表 + 覆盖索引：`messages` 高频写入，任何多余字段都会放大写放大。
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  name          TEXT NOT NULL,
  owner_id      TEXT,
  member_count  INTEGER,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS members (
  id             TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  display_name   TEXT NOT NULL,
  group_alias    TEXT,
  alias          TEXT,
  first_seen_at  INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,
  message_count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, id)
);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sender_id       TEXT NOT NULL,
  kind            TEXT NOT NULL,
  direction       TEXT NOT NULL,
  ts              INTEGER NOT NULL,
  text            TEXT NOT NULL,
  summary         TEXT NOT NULL,
  mentions        TEXT NOT NULL,
  quote_id        TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_conv_ts ON messages (conversation_id, ts);
CREATE INDEX IF NOT EXISTS idx_messages_conv_sender_ts ON messages (conversation_id, sender_id, ts);

-- 按天/小时预聚合。热力图与趋势查询不必扫描全表 messages。
CREATE TABLE IF NOT EXISTS activity_buckets (
  conversation_id TEXT NOT NULL,
  bucket_start    INTEGER NOT NULL,
  bucket_ms       INTEGER NOT NULL,
  sender_id       TEXT NOT NULL,
  kind            TEXT NOT NULL,
  count           INTEGER NOT NULL DEFAULT 0,
  char_count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, bucket_start, sender_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_activity_conv_bucket ON activity_buckets (conversation_id, bucket_start);

CREATE TABLE IF NOT EXISTS word_stats (
  conversation_id TEXT NOT NULL,
  word            TEXT NOT NULL,
  count           INTEGER NOT NULL DEFAULT 0,
  last_seen_at    INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, word)
);

CREATE INDEX IF NOT EXISTS idx_word_conv_count ON word_stats (conversation_id, count DESC);

-- 风控事件与 AI 结论都需要留痕，合并成一张事件表，用 type 区分。
CREATE TABLE IF NOT EXISTS events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  member_id       TEXT NOT NULL,
  type            TEXT NOT NULL,
  severity        TEXT NOT NULL,
  score           REAL NOT NULL DEFAULT 0,
  detail          TEXT NOT NULL,
  ts              INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_conv_ts ON events (conversation_id, ts);

CREATE TABLE IF NOT EXISTS kv (
  scope TEXT NOT NULL,
  key   TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);
`;

export interface StoreOptions {
  path: string;
  wal?: boolean;
}

export interface ConversationRow {
  id: string;
  kind: string;
  name: string;
  owner_id: string | null;
  member_count: number | null;
  first_seen_at: number;
  last_seen_at: number;
  message_count: number;
}

export interface MemberRow {
  id: string;
  conversation_id: string;
  display_name: string;
  group_alias: string | null;
  alias: string | null;
  first_seen_at: number;
  last_seen_at: number;
  message_count: number;
}

export interface ActivityBucketRow {
  conversation_id: string;
  bucket_start: number;
  bucket_ms: number;
  sender_id: string;
  kind: string;
  count: number;
  char_count: number;
}

export interface WordStatRow {
  conversation_id: string;
  word: string;
  count: number;
  last_seen_at: number;
}

export interface EventRow {
  id: number;
  conversation_id: string;
  member_id: string;
  type: string;
  severity: string;
  score: number;
  detail: string;
  ts: number;
}

export class Store {
  readonly db: Database.Database;

  constructor(options: StoreOptions) {
    if (options.path !== ':memory:') {
      mkdirSync(dirname(options.path), { recursive: true });
    }
    this.db = new Database(options.path);
    if (options.wal && options.path !== ':memory:') {
      this.db.pragma('journal_mode = WAL');
    }
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  /**
   * 写入一条消息并同步更新会话/成员/时段桶/词频。
   *
   * 包在一个事务里：统计口径要求这些表互相自洽，部分写入会让「消息数对不上
   * 成员消息数」这类问题极难排查。返回 `false` 表示消息 ID 已存在（协议重投）。
   */
  insertMessage(message: NormalizedMessage, tokens: readonly string[], bucketMs: number): boolean {
    const tx = this.db.transaction((): boolean => {
      const inserted = this.db
        .prepare(
          `INSERT OR IGNORE INTO messages
             (id, conversation_id, sender_id, kind, direction, ts, text, summary, mentions, quote_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          message.id,
          message.conversation.id,
          message.sender.id,
          message.kind,
          message.direction,
          message.timestamp,
          message.text,
          message.summary,
          JSON.stringify(message.mentions),
          message.quoteId ?? null,
        );
      if (inserted.changes === 0) return false;

      this.#upsertConversation(message);
      this.#upsertMember(message);
      this.#upsertBucket(message, bucketMs);
      this.#upsertWords(message, tokens);
      return true;
    });
    return tx();
  }

  #upsertConversation(message: NormalizedMessage): void {
    this.db
      .prepare(
        `INSERT INTO conversations (id, kind, name, owner_id, member_count, first_seen_at, last_seen_at, message_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(id) DO UPDATE SET
           name          = excluded.name,
           owner_id      = COALESCE(excluded.owner_id, conversations.owner_id),
           member_count  = COALESCE(excluded.member_count, conversations.member_count),
           last_seen_at  = MAX(conversations.last_seen_at, excluded.last_seen_at),
           message_count = conversations.message_count + 1`,
      )
      .run(
        message.conversation.id,
        message.conversation.kind,
        message.conversation.name,
        message.conversation.ownerId ?? null,
        message.conversation.memberCount ?? null,
        message.timestamp,
        message.timestamp,
      );
  }

  #upsertMember(message: NormalizedMessage): void {
    this.db
      .prepare(
        `INSERT INTO members (id, conversation_id, display_name, group_alias, alias, first_seen_at, last_seen_at, message_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(conversation_id, id) DO UPDATE SET
           display_name  = excluded.display_name,
           group_alias   = COALESCE(excluded.group_alias, members.group_alias),
           alias         = COALESCE(excluded.alias, members.alias),
           last_seen_at  = MAX(members.last_seen_at, excluded.last_seen_at),
           message_count = members.message_count + 1`,
      )
      .run(
        message.sender.id,
        message.conversation.id,
        message.sender.displayName,
        message.sender.groupAlias ?? null,
        message.sender.alias ?? null,
        message.timestamp,
        message.timestamp,
      );
  }

  #upsertBucket(message: NormalizedMessage, bucketMs: number): void {
    const bucketStart = Math.floor(message.timestamp / bucketMs) * bucketMs;
    this.db
      .prepare(
        `INSERT INTO activity_buckets (conversation_id, bucket_start, bucket_ms, sender_id, kind, count, char_count)
         VALUES (?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(conversation_id, bucket_start, sender_id, kind) DO UPDATE SET
           count      = activity_buckets.count + 1,
           char_count = activity_buckets.char_count + excluded.char_count`,
      )
      .run(
        message.conversation.id,
        bucketStart,
        bucketMs,
        message.sender.id,
        message.kind,
        message.text.length,
      );
  }

  #upsertWords(message: NormalizedMessage, tokens: readonly string[]): void {
    if (tokens.length === 0) return;
    // 同一条消息内的重复词只计一次「出现该词的消息数」，避免刷屏式重复词刷高排名。
    const statement = this.db.prepare(
      `INSERT INTO word_stats (conversation_id, word, count, last_seen_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(conversation_id, word) DO UPDATE SET
         count        = word_stats.count + 1,
         last_seen_at = MAX(word_stats.last_seen_at, excluded.last_seen_at)`,
    );
    for (const word of new Set(tokens)) statement.run(message.conversation.id, word, message.timestamp);
  }

  listConversations(): ConversationRow[] {
    return this.db
      .prepare(`SELECT * FROM conversations ORDER BY last_seen_at DESC`)
      .all() as ConversationRow[];
  }

  getConversation(id: string): ConversationRow | undefined {
    return this.db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id) as
      | ConversationRow
      | undefined;
  }

  listMembers(conversationId: string): MemberRow[] {
    return this.db
      .prepare(`SELECT * FROM members WHERE conversation_id = ? ORDER BY message_count DESC`)
      .all(conversationId) as MemberRow[];
  }

  getMember(conversationId: string, memberId: string): MemberRow | undefined {
    return this.db
      .prepare(`SELECT * FROM members WHERE conversation_id = ? AND id = ?`)
      .get(conversationId, memberId) as MemberRow | undefined;
  }

  /**
   * 按发送者聚合活跃量。
   *
   * `from`/`to` 传毫秒时间戳闭区间；`to` 传 0 表示不限上界，便于「全量排行」。
   */
  activityBySender(
    conversationId: string,
    from: number,
    to: number,
  ): Array<{ sender_id: string; count: number; char_count: number; kinds: string }> {
    return this.db
      .prepare(
        `SELECT sender_id,
                SUM(count)      AS count,
                SUM(char_count) AS char_count,
                GROUP_CONCAT(DISTINCT kind) AS kinds
           FROM activity_buckets
          WHERE conversation_id = ? AND bucket_start >= ? AND (? = 0 OR bucket_start <= ?)
          GROUP BY sender_id
          ORDER BY count DESC`,
      )
      .all(conversationId, from, to, to) as Array<{
      sender_id: string;
      count: number;
      char_count: number;
      kinds: string;
    }>;
  }

  /** 时段热力：按 bucket_start 聚合，交给上层换算成「星期 × 小时」。 */
  activityTimeline(
    conversationId: string,
    from: number,
    to: number,
  ): Array<{ bucket_start: number; count: number }> {
    return this.db
      .prepare(
        `SELECT bucket_start, SUM(count) AS count
           FROM activity_buckets
          WHERE conversation_id = ? AND bucket_start >= ? AND (? = 0 OR bucket_start <= ?)
          GROUP BY bucket_start
          ORDER BY bucket_start`,
      )
      .all(conversationId, from, to, to) as Array<{ bucket_start: number; count: number }>;
  }

  kindBreakdown(
    conversationId: string,
    from: number,
    to: number,
  ): Array<{ kind: string; count: number }> {
    return this.db
      .prepare(
        `SELECT kind, SUM(count) AS count
           FROM activity_buckets
          WHERE conversation_id = ? AND bucket_start >= ? AND (? = 0 OR bucket_start <= ?)
          GROUP BY kind
          ORDER BY count DESC`,
      )
      .all(conversationId, from, to, to) as Array<{ kind: string; count: number }>;
  }

  topWords(conversationId: string, limit: number): WordStatRow[] {
    return this.db
      .prepare(
        `SELECT * FROM word_stats WHERE conversation_id = ? ORDER BY count DESC, word ASC LIMIT ?`,
      )
      .all(conversationId, limit) as WordStatRow[];
  }

  /** 取最近 N 条文本消息，供 AI 摘要与 RAG 检索使用（倒序取再翻转回正序）。 */
  recentMessages(conversationId: string, limit: number, kinds: readonly string[] = ['text']): NormalizedMessage[] {
    const placeholders = kinds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
          WHERE conversation_id = ? AND kind IN (${placeholders})
          ORDER BY ts DESC, rowid DESC
          LIMIT ?`,
      )
      .all(conversationId, ...kinds, limit) as Array<{
      id: string;
      conversation_id: string;
      sender_id: string;
      kind: string;
      direction: string;
      ts: number;
      text: string;
      summary: string;
      mentions: string;
      quote_id: string | null;
    }>;
    return rows.reverse().map((row) => this.#toMessage(row));
  }

  /**
   * 关键词检索历史消息，给 AI 做「群内上下文」。
   *
   * 用 LIKE 而非 FTS：群聊口语化、分词效果不稳定，且这里数据量级（单群十万级）
   * 下 LIKE 全表扫描仍在毫秒级。真需要时再换 FTS5，接口不变。
   */
  searchMessages(conversationId: string, keyword: string, limit: number): NormalizedMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
          WHERE conversation_id = ? AND kind = 'text' AND text LIKE ?
          ORDER BY ts DESC
          LIMIT ?`,
      )
      .all(conversationId, `%${keyword}%`, limit) as Array<{
      id: string;
      conversation_id: string;
      sender_id: string;
      kind: string;
      direction: string;
      ts: number;
      text: string;
      summary: string;
      mentions: string;
      quote_id: string | null;
    }>;
    return rows.reverse().map((row) => this.#toMessage(row));
  }

  #toMessage(row: {
    id: string;
    conversation_id: string;
    sender_id: string;
    kind: string;
    direction: string;
    ts: number;
    text: string;
    summary: string;
    mentions: string;
    quote_id: string | null;
  }): NormalizedMessage {
    const conversation = this.getConversation(row.conversation_id);
    const member = this.getMember(row.conversation_id, row.sender_id);
    return {
      id: row.id,
      conversation: {
        id: row.conversation_id,
        kind: (conversation?.kind ?? 'group') as NormalizedMessage['conversation']['kind'],
        name: conversation?.name ?? row.conversation_id,
      },
      sender: {
        id: row.sender_id,
        displayName: member?.display_name ?? row.sender_id,
      },
      kind: row.kind as NormalizedMessage['kind'],
      direction: row.direction as NormalizedMessage['direction'],
      timestamp: row.ts,
      text: row.text,
      summary: row.summary,
      mentions: JSON.parse(row.mentions) as string[],
      quoteId: row.quote_id ?? undefined,
    };
  }

  insertEvent(event: Omit<EventRow, 'id'>): void {
    this.db
      .prepare(
        `INSERT INTO events (conversation_id, member_id, type, severity, score, detail, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.conversation_id,
        event.member_id,
        event.type,
        event.severity,
        event.score,
        event.detail,
        event.ts,
      );
  }

  recentEvents(conversationId: string, limit: number, type?: string): EventRow[] {
    if (type) {
      return this.db
        .prepare(
          `SELECT * FROM events WHERE conversation_id = ? AND type = ? ORDER BY ts DESC LIMIT ?`,
        )
        .all(conversationId, type, limit) as EventRow[];
    }
    return this.db
      .prepare(`SELECT * FROM events WHERE conversation_id = ? ORDER BY ts DESC LIMIT ?`)
      .all(conversationId, limit) as EventRow[];
  }

  /** 成员在窗口内的风险分累计，风控滑动窗口用。 */
  riskScoreSince(conversationId: string, memberId: string, since: number): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(score), 0) AS total FROM events
          WHERE conversation_id = ? AND member_id = ? AND ts >= ? AND type = 'guard'`,
      )
      .get(conversationId, memberId, since) as { total: number };
    return row.total;
  }

  getKv(scope: string, key: string): string | undefined {
    const row = this.db
      .prepare(`SELECT value FROM kv WHERE scope = ? AND key = ?`)
      .get(scope, key) as { value: string } | undefined;
    return row?.value;
  }

  setKv(scope: string, key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO kv (scope, key, value) VALUES (?, ?, ?)
         ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
      )
      .run(scope, key, value);
  }

  /** 裁剪历史消息，控制磁盘占用。返回删除条数。 */
  pruneMessages(conversationId: string, keep: number, now: number): number {
    if (keep <= 0) return 0;
    const result = this.db
      .prepare(
        `DELETE FROM messages
          WHERE conversation_id = ?
            AND id NOT IN (
              SELECT id FROM messages WHERE conversation_id = ? ORDER BY ts DESC, rowid DESC LIMIT ?
            )`,
      )
      .run(conversationId, conversationId, keep);
    // 会话级计数不随裁剪回退——它是「历史累计」口径，与留存窗口是两件事。
    this.setKv('prune', conversationId, String(now));
    return result.changes;
  }

  close(): void {
    this.db.close();
  }
}
