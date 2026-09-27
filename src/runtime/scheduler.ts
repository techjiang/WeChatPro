import { schedule, validate, type ScheduledTask } from 'node-cron';
import { buildDigest, previousDayWindow, type DigestWindow } from '../analytics/digest.js';
import type { Logger } from 'pino';
import type { Store } from '../core/store.js';

/**
 * 定时任务调度。
 *
 * 只用「按 cron 触发一个回调」这一件事，因此直接把 `node-cron` 收在这一层：
 * 领域层与插件层只认「周期性执行某个动作」，换调度器（或换成容器里的
 * sidecar / K8s CronJob）都不需要动业务代码。
 *
 * 三条容易踩的坑，在这里一次性挡掉：
 *
 * 1. **非法 cron 直接拒绝**，而不是让进程在夜里静默不执行。`node-cron` 的
 *    `schedule()` 对无法解析的表达式会抛错，但不同版本行为不一致，所以先 `validate()`。
 * 2. **同一次任务不允许叠加**。日报要跑几秒到几十秒，若上次还没跑完下次就触发，
 *    会给群里推两份、还会把 AI 调用叠起来打爆限流。
 * 3. **任务不能拖住进程退出**。定时器全部 `unref()`，否则 CI 与 CLI 会因为
 *    一个后台 cron 永远不结束。
 */

export interface ScheduledJob {
  name: string;
  /** cron 表达式（5 或 6 段）。 */
  expression: string;
  /** 单次执行的实现。抛错会被捕获并记账，不影响后续触发。 */
  run(): void | Promise<void>;
}

export interface JobStatus {
  name: string;
  expression: string;
  runs: number;
  failures: number;
  /** 上次执行耗时（毫秒），未执行过为 `null`。 */
  lastDurationMs: number | null;
  lastError: string | null;
  /** 上次执行结束时间。 */
  lastFinishedAt: number | null;
}

function randomHex(length: number): string {
  const alphabet = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

/**
 * 带串行保护与状态记账的调度器。
 *
 * 状态记账（执行次数、失败次数、耗时）不是为了好看：定时任务的失败
 * 在客户端插件里完全不可见，面板的「关于」页把它显示出来，用户才可能发现
 * 「日报已经三天没发了」。
 */
export class Scheduler {
  #logger: Logger;
  #tasks: ScheduledTask[] = [];
  #status = new Map<string, JobStatus>();
  #running = new Set<string>();

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  /** 注册一个任务。表达式非法时返回 `false` 并记警告，不抛错——一个配错的 cron 不该让引擎起不来。 */
  add(job: ScheduledJob): boolean {
    if (!validate(job.expression)) {
      this.#logger.warn({ job: job.name, expression: job.expression }, 'cron 表达式非法，已跳过该定时任务');
      return false;
    }
    const status: JobStatus = {
      name: job.name,
      expression: job.expression,
      runs: 0,
      failures: 0,
      lastDurationMs: null,
      lastError: null,
      lastFinishedAt: null,
    };
    this.#status.set(job.name, status);

    // `noOverlap` 交给 node-cron 兜底（它按任务实例判定），我们自己也有一层
    // `#running` 保护——两层都留着，因为「日报叠加推送」在群里是可见的事故。
    const task = schedule(job.expression, () => void this.#run(job, status), {
      name: job.name,
      noOverlap: true,
      // 定时器不参与事件循环存活判定：CLI 与 CI 不该因为一个后台 cron 挂住。
      unref: true,
    });
    this.#tasks.push(task);
    this.#logger.info({ job: job.name, expression: job.expression }, '定时任务已注册');
    return true;
  }

  async #run(job: ScheduledJob, status: JobStatus): Promise<void> {
    // 串行保护：上一次还没跑完就跳过这次触发，并留下痕迹。
    if (this.#running.has(job.name)) {
      this.#logger.warn({ job: job.name }, '上一次执行尚未结束，本次触发已跳过');
      return;
    }
    this.#running.add(job.name);
    const startedAt = Date.now();
    try {
      await job.run();
      status.runs += 1;
      status.lastError = null;
    } catch (error) {
      status.failures += 1;
      status.lastError = error instanceof Error ? error.message : String(error);
      this.#logger.error({ job: job.name, err: error }, '定时任务执行失败');
    } finally {
      status.lastDurationMs = Date.now() - startedAt;
      status.lastFinishedAt = Date.now();
      this.#running.delete(job.name);
    }
  }

  /** 立即执行一次（排障与「现在发一份日报」用），走同一条串行通道。 */
  async runNow(name: string, job: ScheduledJob): Promise<void> {
    const status = this.#status.get(name) ?? {
      name,
      expression: job.expression,
      runs: 0,
      failures: 0,
      lastDurationMs: null,
      lastError: null,
      lastFinishedAt: null,
    };
    this.#status.set(name, status);
    await this.#run(job, status);
  }

  status(): JobStatus[] {
    return [...this.#status.values()];
  }

  /** 停止全部任务。幂等，可重复调用。 */
  stop(): void {
    for (const task of this.#tasks) task.destroy();
    this.#tasks = [];
    this.#running.clear();
  }
}

export interface DigestJobOptions {
  store: Store;
  logger: Logger;
  /** 日报覆盖哪些会话；返回空数组表示「当前没有任何会话」。 */
  conversationIds(): string[];
  /** 日报推送到哪里；返回 `false` 表示没有可用的发送通道。 */
  send(conversationId: string, text: string): Promise<boolean>;
  /** 无消息的群是否也推。 */
  includeEmpty?: boolean;
  /** 单次最多推送几个群，避免首次运行时一次性刷屏。 */
  maxConversations?: number;
  /** 计算区间的方式，测试注入固定时间。 */
  window?: (now: number) => DigestWindow;
}

/**
 * 构造「群日报」任务。
 *
 * 抽成工厂而不是直接写在插件里，是为了让它**可测**：把 `window` 与 `send`
 * 换成桩，就能断言「推了什么、推给谁、空群是否跳过」，而不必等一个真实的
 * 早上九点。
 */
export function createDigestJob(options: DigestJobOptions & { name?: string; expression: string }): {
  job: ScheduledJob;
  runOnce(now?: number): Promise<{ sent: number; skipped: number; failed: number }>;
} {
  const name = options.name ?? 'digest';
  const resolveWindow = options.window ?? previousDayWindow;

  const runOnce = async (now = Date.now()): Promise<{ sent: number; skipped: number; failed: number }> => {
    const window = resolveWindow(now);
    const ids = options.conversationIds().slice(0, options.maxConversations ?? 50);
    let sent = 0;
    let skipped = 0;
    let failed = 0;

    for (const conversationId of ids) {
      const report = buildDigest(options.store, conversationId, window, {
        ...(options.includeEmpty === undefined ? {} : { includeEmpty: options.includeEmpty }),
      });
      if (!report || report.totalMessages === 0) {
        skipped += 1;
        continue;
      }
      // 每个群独立判定成功与否：一个群发送失败不该让后面的群收不到日报。
      const ok = await options.send(conversationId, report.text).catch((error: unknown) => {
        options.logger.warn({ err: error, conversationId }, '日报推送失败');
        return false;
      });
      if (ok) sent += 1;
      else failed += 1;
    }

    if (ids.length === 0) options.logger.info('日报跳过：当前没有任何会话');
    else options.logger.info({ sent, skipped, failed, label: window.label }, '日报推送完成');
    return { sent, skipped, failed };
  };

  return {
    job: {
      name,
      expression: options.expression,
      run: async () => {
        await runOnce();
      },
    },
    runOnce,
  };
}

/** 供测试与排障使用：生成一个不会与真实任务冲突的临时任务名。 */
export function scratchJobName(prefix: string): string {
  return `${prefix}-${randomHex(6)}`;
}
