/**
 * 轻量事件总线。
 *
 * 引擎内部只走这一条通路：适配器 → 归一化 → 总线 → 各订阅者（统计、检测、AI、落库）。
 * 用同步派发保证同一消息在各订阅者间看到的顺序一致；慢订阅者需自己排队，
 * 不要在这里加 await 串行，否则一个插件卡住整条链路。
 */

export type EventName =
  | 'message'
  | 'message.revoked'
  | 'member.join'
  | 'member.leave'
  | 'alert'
  | 'command'
  | 'engine.error';

export interface BusEvent {
  name: EventName;
  /** 毫秒时间戳。 */
  at: number;
  payload: unknown;
}

export type Listener = (event: BusEvent) => void;

export interface BusError {
  /** 出错的订阅者标识，便于定位是哪个插件。 */
  subscriber: string;
  event: BusEvent;
  error: unknown;
}

export class EventBus {
  #listeners = new Map<EventName, Map<string, Listener>>();
  #onError: (e: BusError) => void;

  constructor(onError?: (e: BusError) => void) {
    this.#onError = onError ?? (() => {});
  }

  /**
   * 订阅事件。
   *
   * `id` 用于去重与退订：同一 id 重复订阅会替换旧监听器，插件重载时无需手动清理。
   */
  on(name: EventName, id: string, listener: Listener): () => void {
    let bucket = this.#listeners.get(name);
    if (!bucket) {
      bucket = new Map();
      this.#listeners.set(name, bucket);
    }
    bucket.set(id, listener);
    return () => this.off(name, id);
  }

  off(name: EventName, id: string): void {
    this.#listeners.get(name)?.delete(id);
  }

  /** 移除某个订阅者的全部监听，插件卸载时调用。 */
  offAll(id: string): void {
    for (const bucket of this.#listeners.values()) bucket.delete(id);
  }

  /**
   * 同步派发。单个订阅者抛错不影响其他订阅者——一个统计插件写库失败
   * 不应该让风控插件漏掉这条消息。
   */
  emit(name: EventName, payload: unknown): void {
    const bucket = this.#listeners.get(name);
    if (!bucket || bucket.size === 0) return;
    const event: BusEvent = { name, at: Date.now(), payload };
    for (const [id, listener] of bucket) {
      try {
        listener(event);
      } catch (error) {
        this.#onError({ subscriber: id, event, error });
      }
    }
  }

  /** 当前订阅者数量，测试与健康检查用。 */
  listenerCount(name?: EventName): number {
    if (name) return this.#listeners.get(name)?.size ?? 0;
    let total = 0;
    for (const bucket of this.#listeners.values()) total += bucket.size;
    return total;
  }
}
