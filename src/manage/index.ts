import type { Store, ConversationRow, MemberRow, EventRow } from '../core/store.js';
import type { NormalizedMessage } from '../core/types.js';
import { DAY_MS } from '../analytics/index.js';

/**
 * 群聊信息管理与长期记忆。
 *
 * 职责边界：analytics 负责「算指标」，这里负责「管实体」——
 * 群档案、成员台账、群知识（长期记忆）、以及基于这些数据的运营动作
 * （沉默成员名单、新人欢迎、知识注入问答）。
 *
 * 群知识是 RAG 的语料来源：把聊天记录里值得长期保留的事实沉淀成条目，
 * 后续问答不必依赖原始消息（原始消息会被裁剪，知识不会）。
 */

export interface KnowledgeEntry {
  id: number;
  conversationId: string;
  category: '规则' | '资源' | 'FAQ' | '决定' | '其他';
  content: string;
  /** 来源消息 ID，可追溯到原始上下文。 */
  sourceMessageId?: string;
  createdBy?: string;
  createdAt: number;
  /** 被检索命中的次数，用于淘汰低价值知识。 */
  hits: number;
}

export interface GroupDigest {
  conversation: ConversationRow;
  topMembers: Array<{ member: MemberRow; share: number }>;
  newMembers: MemberRow[];
  silentMembers: Array<{ member: MemberRow; silentDays: number }>;
  recentAlerts: EventRow[];
}

export interface MemberLifecycle {
  member: MemberRow;
  /** 入群天数。 */
  tenureDays: number;
  /** 沉默天数。 */
  silentDays: number;
  /** 最近 7 天发言数。 */
  lastWeekMessages: number;
  /** 生命周期阶段，用于分层运营。 */
  stage: 'newcomer' | 'active' | 'core' | 'dormant' | 'churned';
}

const KNOWLEDGE_SCOPE = 'knowledge';

export class GroupManager {
  #store: Store;

  constructor(store: Store) {
    this.#store = store;
  }

  /** 群档案总览。 */
  conversationProfile(conversationId: string): ConversationRow | null {
    return this.#store.getConversation(conversationId) ?? null;
  }

  listConversations(): ConversationRow[] {
    return this.#store.listConversations();
  }

  listMembers(conversationId: string): MemberRow[] {
    return this.#store.listMembers(conversationId);
  }

  /**
   * 分层运营数据源。
   *
   * 阶段判定刻意用「近期发言 + 历史发言」两个维度：
   * 只看近期会把刚进群还在观望的新人误判为流失；
   * 只看历史则会把已潜水的大佬一直当核心。
   */
  memberLifecycle(conversationId: string, memberId: string, now = Date.now()): MemberLifecycle | null {
    const member = this.#store.getMember(conversationId, memberId);
    if (!member) return null;

    const recent = this.#store.activityBySender(conversationId, now - 7 * DAY_MS, 0);
    const lastWeekMessages = recent.find((row) => row.sender_id === memberId)?.count ?? 0;
    const tenureDays = Math.max(0, Math.floor((now - member.first_seen_at) / DAY_MS));
    const silentDays = Math.max(0, Math.floor((now - member.last_seen_at) / DAY_MS));

    return {
      member,
      tenureDays,
      silentDays,
      lastWeekMessages,
      stage: classifyStage({ tenureDays, silentDays, lastWeekMessages, total: member.message_count }),
    };
  }

  /** 群日报所需的全部素材。 */
  digest(conversationId: string, now = Date.now()): GroupDigest | null {
    const conversation = this.#store.getConversation(conversationId);
    if (!conversation) return null;

    const members = this.#store.listMembers(conversationId);
    const totalMessages = members.reduce((sum, member) => sum + member.message_count, 0);
    const topMembers = members
      .slice(0, 10)
      .map((member) => ({
        member,
        share: totalMessages > 0 ? Number((member.message_count / totalMessages).toFixed(4)) : 0,
      }));

    const latest = this.#store.activityTimeline(conversationId, 0, 0);
    const newestAt = latest.length > 0 ? (latest[latest.length - 1] as { bucket_start: number }).bucket_start : now;

    return {
      conversation,
      topMembers,
      newMembers: members
        .filter((member) => now - member.first_seen_at <= 3 * DAY_MS)
        .sort((a, b) => b.first_seen_at - a.first_seen_at),
      silentMembers: members
        .filter((member) => member.message_count >= 5 && now - member.last_seen_at > 14 * DAY_MS)
        .map((member) => ({
          member,
          silentDays: Math.floor((now - member.last_seen_at) / DAY_MS),
        }))
        .sort((a, b) => b.silentDays - a.silentDays),
      recentAlerts: this.#store.recentEvents(conversationId, 10, 'guard'),
    };
  }

  /** 把一条消息沉淀为群知识。 */
  addKnowledge(entry: {
    conversationId: string;
    category: KnowledgeEntry['category'];
    content: string;
    sourceMessageId?: string;
    createdBy?: string;
  }): KnowledgeEntry {
    const now = Date.now();
    const existing = this.listKnowledge(entry.conversationId);
    // 用「类别 + 内容」做去重键：同一条规则被反复讨论不该产生多条知识。
    const duplicate = existing.find(
      (item) => item.category === entry.category && item.content === entry.content,
    );
    if (duplicate) return duplicate;

    const nextId = existing.reduce((max, item) => Math.max(max, item.id), 0) + 1;
    const record: KnowledgeEntry = {
      id: nextId,
      conversationId: entry.conversationId,
      category: entry.category,
      content: entry.content,
      sourceMessageId: entry.sourceMessageId,
      createdBy: entry.createdBy,
      createdAt: now,
      hits: 0,
    };
    this.#store.setKv(KNOWLEDGE_SCOPE, `${entry.conversationId}:${nextId}`, JSON.stringify(record));
    return record;
  }

  listKnowledge(conversationId: string): KnowledgeEntry[] {
    const rows = this.#store.db
      .prepare(`SELECT key, value FROM kv WHERE scope = ? AND key LIKE ? ORDER BY key`)
      .all(KNOWLEDGE_SCOPE, `${conversationId}:%`) as Array<{ key: string; value: string }>;
    const entries: KnowledgeEntry[] = [];
    for (const row of rows) {
      try {
        entries.push(JSON.parse(row.value) as KnowledgeEntry);
      } catch {
        // 单条数据损坏不该让整个知识库不可用，跳过并继续。
      }
    }
    return entries.sort((a, b) => a.id - b.id);
  }

  /** 检索群知识：词法命中优先，同类目次之。返回结果同时累加命中次数。 */
  searchKnowledge(conversationId: string, query: string, limit = 5): KnowledgeEntry[] {
    const entries = this.listKnowledge(conversationId);
    if (entries.length === 0) return [];
    const terms = query
      .toLowerCase()
      .split(/[\s，,。？?！!、]+/)
      .filter((term) => term.length >= 2);
    if (terms.length === 0) return entries.slice(0, limit);

    const scored = entries.map((entry) => {
      const text = `${entry.category} ${entry.content}`.toLowerCase();
      const score = terms.reduce((sum, term) => sum + (text.includes(term) ? term.length : 0), 0);
      return { entry, score };
    });

    const matched = scored
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.entry.hits - a.entry.hits)
      .slice(0, limit);

    for (const item of matched) {
      item.entry.hits += 1;
      this.#store.setKv(
        KNOWLEDGE_SCOPE,
        `${conversationId}:${item.entry.id}`,
        JSON.stringify(item.entry),
      );
    }

    return matched.map((item) => item.entry);
  }

  removeKnowledge(conversationId: string, id: number): boolean {
    const exists = this.listKnowledge(conversationId).some((entry) => entry.id === id);
    if (!exists) return false;
    this.#store.db
      .prepare(`DELETE FROM kv WHERE scope = ? AND key = ?`)
      .run(KNOWLEDGE_SCOPE, `${conversationId}:${id}`);
    return true;
  }

  /** 应用保留策略，返回各会话删除条数。 */
  applyRetention(keep: number, now = Date.now()): Record<string, number> {
    const removed: Record<string, number> = {};
    if (keep <= 0) return removed;
    for (const conversation of this.#store.listConversations()) {
      const count = this.#store.pruneMessages(conversation.id, keep, now);
      if (count > 0) removed[conversation.id] = count;
    }
    return removed;
  }

  /** 导出群档案为可迁移的 JSON（备份 / 跨实例同步）。 */
  exportConversation(conversationId: string): {
    conversation: ConversationRow | null;
    members: MemberRow[];
    knowledge: KnowledgeEntry[];
    exportedAt: number;
  } {
    return {
      conversation: this.#store.getConversation(conversationId) ?? null,
      members: this.#store.listMembers(conversationId),
      knowledge: this.listKnowledge(conversationId),
      exportedAt: Date.now(),
    };
  }

  /** 会话内最近消息，面板展示用。 */
  recentMessages(conversationId: string, limit: number): NormalizedMessage[] {
    return this.#store.recentMessages(conversationId, limit, ['text', 'image', 'link', 'file']);
  }
}

export function classifyStage(input: {
  tenureDays: number;
  silentDays: number;
  lastWeekMessages: number;
  total: number;
}): MemberLifecycle['stage'] {
  if (input.silentDays > 30) return 'churned';
  if (input.silentDays > 14) return 'dormant';
  if (input.tenureDays <= 7 && input.total < 20) return 'newcomer';
  if (input.lastWeekMessages >= 30 || input.total >= 500) return 'core';
  return 'active';
}
