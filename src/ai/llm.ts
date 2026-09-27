import type { Logger } from 'pino';

/**
 * LLM 网关。
 *
 * 只依赖 OpenAI 兼容的 `/chat/completions` 协议——它是事实标准，
 * 国内厂商（通义、豆包、DeepSeek、Moonshot…）与自建 vLLM/Ollama 都实现了它，
 * 因此换模型只改配置不改代码。真实环境里网络与限流是主要故障源，
 * 所以超时、并发闸门、重试都在这一层收口，上层不必关心。
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  /** 覆盖默认模型，如摘要用便宜模型、问答用强模型。 */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** 逐块回调，供流式输出场景使用。 */
  onDelta?: (delta: string) => void;
  signal?: AbortSignal;
}

export interface ChatResult {
  content: string;
  model: string;
  usage?: { promptTokens: number; completionTokens: number };
}

export interface LlmGatewayOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxConcurrency: number;
  logger: Logger;
  /** 测试注入点：替换 fetch。 */
  fetchImpl?: typeof fetch;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retriable = false,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/** 信号量：限制同时飞出的请求数，防止瞬时打爆上游限流。 */
class Semaphore {
  #limit: number;
  #active = 0;
  #waiters: Array<() => void> = [];

  constructor(limit: number) {
    this.#limit = limit;
  }

  async acquire(): Promise<() => void> {
    if (this.#active < this.#limit) {
      this.#active += 1;
      return () => this.#release();
    }
    await new Promise<void>((resolve) => this.#waiters.push(resolve));
    this.#active += 1;
    return () => this.#release();
  }

  #release(): void {
    this.#active -= 1;
    const next = this.#waiters.shift();
    if (next) next();
  }
}

export class LlmGateway {
  #options: LlmGatewayOptions;
  #semaphore: Semaphore;
  #fetch: typeof fetch;

  constructor(options: LlmGatewayOptions) {
    this.#options = options;
    this.#semaphore = new Semaphore(Math.max(1, options.maxConcurrency));
    this.#fetch = options.fetchImpl ?? fetch;
  }

  get defaultModel(): string {
    return this.#options.model;
  }

  /**
   * 发起一次对话补全。
   *
   * 不在这里做自动重试：调用方对「延迟敏感」与否的判断更准（实时应答不该重试，
   * 离线摘要可以）。这里只对网络类错误标记 `retriable`，把决策权交出去。
   */
  async chat(messages: readonly ChatMessage[], options: ChatOptions = {}): Promise<ChatResult> {
    const release = await this.#semaphore.acquire();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#options.timeoutMs);
    const onAbort = (): void => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await this.#fetch(`${this.#options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.#options.apiKey}`,
        },
        body: JSON.stringify({
          model: options.model ?? this.#options.model,
          messages,
          temperature: options.temperature ?? 0.3,
          max_tokens: options.maxTokens,
          stream: Boolean(options.onDelta),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const retriable = response.status === 429 || response.status >= 500;
        throw new LlmError(
          `LLM 请求失败 ${response.status}: ${body.slice(0, 500)}`,
          response.status,
          retriable,
        );
      }

      if (options.onDelta && response.body) {
        return await this.#readStream(response, options.onDelta);
      }

      const payload = (await response.json()) as {
        model?: string;
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const content = payload.choices?.[0]?.message?.content ?? '';
      if (!content) throw new LlmError('LLM 返回空内容');
      return {
        content,
        model: payload.model ?? options.model ?? this.#options.model,
        usage: payload.usage
          ? {
              promptTokens: payload.usage.prompt_tokens ?? 0,
              completionTokens: payload.usage.completion_tokens ?? 0,
            }
          : undefined,
      };
    } catch (error) {
      if (error instanceof LlmError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new LlmError(`LLM 请求超时（${this.#options.timeoutMs}ms）`, undefined, true);
      }
      throw new LlmError(`LLM 请求异常: ${error instanceof Error ? error.message : String(error)}`, undefined, true);
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);
      release();
    }
  }

  /** 解析 SSE 流。只关心 `data:` 行，`[DONE]` 结束。 */
  async #readStream(response: Response, onDelta: (delta: string) => void): Promise<ChatResult> {
    const reader = response.body?.getReader();
    if (!reader) throw new LlmError('响应体不可读，无法流式解析');
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let model = this.#options.model;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      // 最后一段可能是半个 JSON，留在 buffer 里等下一块。
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const chunk = JSON.parse(data) as {
            model?: string;
            choices?: Array<{ delta?: { content?: string } }>;
          };
          if (chunk.model) model = chunk.model;
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) {
            content += delta;
            onDelta(delta);
          }
        } catch {
          // 流里混入非 JSON keep-alive 行属正常现象，跳过即可。
        }
      }
    }

    return { content, model };
  }
}

/**
 * 简易并发重试包装：只对 `retriable` 错误重试，指数退避。
 * 用于离线批处理（日报、批量打标），在线问答不要用。
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: { retries?: number; baseDelayMs?: number } = {},
): Promise<T> {
  const retries = options.retries ?? 2;
  const base = options.baseDelayMs ?? 500;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const retriable =
        error instanceof LlmError ? error.retriable : (error as { retriable?: boolean })?.retriable === true;
      if (!retriable || attempt === retries) throw error;
      await new Promise((resolve) => setTimeout(resolve, base * 2 ** attempt));
    }
  }
  throw lastError;
}
