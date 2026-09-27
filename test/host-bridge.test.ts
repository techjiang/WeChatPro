import { describe, expect, it, vi } from 'vitest';
import { HOST_CAPABILITIES, HostGateway, type HostBridge } from '../src/core/host-bridge.js';

/**
 * 宿主反向调用桥的测试重点不是「能调到」，而是「调不到时怎么办」。
 *
 * PC 客户端插件必须在能力缺失的环境里照常工作，所以每个用例都在验证降级路径：
 * 返回值而不是抛错、调用统计准确、通知限流生效。
 */

function bridge(overrides: Partial<HostBridge> = {}): HostBridge {
  return { host: 'test-host', ...overrides };
}

describe('HostGateway', () => {
  it('未挂载宿主时所有调用安全降级', async () => {
    const gateway = new HostGateway();
    expect(gateway.host).toBe('none');
    expect(gateway.capabilities()).toEqual([]);
    await expect(gateway.notify({ title: 'a', body: 'b' })).resolves.toBe(false);
    await expect(gateway.setBadge(3)).resolves.toBe(false);
    await expect(gateway.openPanel('#/guard')).resolves.toBe(false);
    await expect(gateway.toast('hi')).resolves.toBe(false);
    await expect(gateway.openExternal('https://a.b')).resolves.toBe(false);
    await expect(gateway.pickFile()).resolves.toBeNull();
    await expect(gateway.exportFile({ filename: 'a', content: 'b' })).resolves.toBeNull();
    await expect(gateway.readClipboard()).resolves.toBeNull();
    await expect(gateway.writeClipboard('x')).resolves.toBe(false);
    await expect(gateway.contacts()).resolves.toEqual([]);
    await expect(gateway.nativeSend({ conversationId: 'c', kind: 'text' })).resolves.toBe(false);
  });

  it('能力清单只反映真实实现，空函数不算能力', () => {
    const gateway = new HostGateway();
    gateway.attach(bridge({ notify: vi.fn(), setBadge: vi.fn() }));
    expect(gateway.capabilities().sort()).toEqual(['notify', 'setBadge']);
    expect(gateway.has('notify')).toBe(true);
    expect(gateway.has('toast')).toBe(false);
  });

  it('能力清单覆盖全部声明的能力名', () => {
    const gateway = new HostGateway();
    const all: Partial<HostBridge> = {};
    for (const name of HOST_CAPABILITIES) {
      (all as Record<string, unknown>)[name] = vi.fn();
    }
    gateway.attach(bridge(all));
    expect(gateway.capabilities().sort()).toEqual([...HOST_CAPABILITIES].sort());
  });

  it('宿主抛错被隔离，不向上传播', async () => {
    const gateway = new HostGateway();
    gateway.attach(
      bridge({
        notify: () => {
          throw new Error('宿主通知模块崩了');
        },
        contacts: () => Promise.reject(new Error('通讯录不可用')),
      }),
    );
    await expect(gateway.notify({ title: 'a', body: 'b' })).resolves.toBe(false);
    await expect(gateway.contacts()).resolves.toEqual([]);
    const stats = gateway.callStats();
    expect(stats.find((s) => s.capability === 'notify')?.failed).toBe(1);
    expect(stats.find((s) => s.capability === 'contacts')?.failed).toBe(1);
  });

  it('通知按 dedupeKey 限流，窗口外恢复', async () => {
    vi.useFakeTimers();
    try {
      const gateway = new HostGateway({ dedupeWindowMs: 1000 });
      const notify = vi.fn();
      gateway.attach(bridge({ notify }));

      await gateway.notify({ title: 'a', body: 'b', dedupeKey: 'k1' });
      await gateway.notify({ title: 'a', body: 'b', dedupeKey: 'k1' });
      expect(notify).toHaveBeenCalledTimes(1);

      await gateway.notify({ title: 'a', body: 'b', dedupeKey: 'k2' });
      expect(notify).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(1500);
      await gateway.notify({ title: 'a', body: 'b', dedupeKey: 'k1' });
      expect(notify).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('openExternal 只放行 http(s)，挡住其它协议', async () => {
    const gateway = new HostGateway();
    const openExternal = vi.fn(() => true);
    gateway.attach(bridge({ openExternal }));
    await expect(gateway.openExternal('file:///etc/passwd')).resolves.toBe(false);
    await expect(gateway.openExternal('javascript:alert(1)')).resolves.toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
    await expect(gateway.openExternal('https://docs.asoe.cn')).resolves.toBe(true);
    expect(openExternal).toHaveBeenCalledWith('https://docs.asoe.cn');
  });

  it('替换宿主后调用统计保留，便于热重载观察', async () => {
    const gateway = new HostGateway();
    gateway.attach(bridge({ setBadge: vi.fn() }));
    await gateway.setBadge(1);
    expect(gateway.callStats().find((s) => s.capability === 'setBadge')?.ok).toBe(1);

    // 换成新的宿主实现：统计接着累加，而不是从零开始——
    // 热重载后要能看到「这个能力到底被调用过几次」的完整历史。
    gateway.attach(bridge({ setBadge: vi.fn() }));
    await gateway.setBadge(2);
    expect(gateway.callStats().find((s) => s.capability === 'setBadge')?.ok).toBe(2);

    gateway.detach();
    expect(gateway.host).toBe('none');
    await expect(gateway.setBadge(3)).resolves.toBe(false);
  });
});

/**
 * 通知去重窗口的运行时调整。
 *
 * 窗口来自配置，早期实现只在构造时读一次——「把窗口调小」这种调整
 * 要重启插件才生效，属于典型的「改了没反应」。这里钉住运行时可对齐，
 * 以及调整时窗口会被清空（新旧窗口混用会让新告警被旧记录压住）。
 */
describe('结构化宿主调用', () => {
  it('未挂载宿主桥时所有能力都判定为不可用', () => {
    const gateway = new HostGateway();
    expect(gateway.host).toBe('none');
    expect(gateway.capabilities()).toEqual([]);
    expect(gateway.has('notify')).toBe(false);
  });

  it('空实现（声明了字段但不是函数）不算能力', () => {
    const gateway = new HostGateway();
    // 插件壳常见写法：把没实现的方法声明成字段。
    gateway.attach({ host: 'shell', notify: undefined } as never);
    expect(gateway.has('notify')).toBe(false);
    expect(gateway.capabilities()).toEqual([]);
  });

  it('三态结果区分「能力缺失」与「调用失败」', async () => {
    const gateway = new HostGateway();
    gateway.attach({
      host: 'shell',
      openPanel: () => {
        throw new Error('客户端拒绝');
      },
    });
    // 缺失：ok=false 且无 error
    const missing = await gateway.invoke('notify');
    expect(missing.ok).toBe(false);
    expect(missing.error).toBeUndefined();
    // 失败：ok=false 且带 error
    const failed = await gateway.invoke('openPanel');
    expect(failed.ok).toBe(false);
    expect(failed.error).toBeInstanceOf(Error);
  });

  it('不返回值的能力仍然算成功（openPanel / setBadge）', async () => {
    const gateway = new HostGateway();
    let opened = 0;
    gateway.attach({
      host: 'shell',
      openPanel: () => {
        opened += 1;
      },
    });
    await expect(gateway.openPanel('#/dashboard')).resolves.toBe(true);
    expect(opened).toBe(1);
  });

  it('外链只放行 http(s)，file/javascript 一律拒绝', async () => {
    const gateway = new HostGateway();
    let opened: string | null = null;
    gateway.attach({
      host: 'shell',
      openExternal: (url) => {
        opened = url;
        return true;
      },
    });
    await expect(gateway.openExternal('file:///etc/passwd')).resolves.toBe(false);
    await expect(gateway.openExternal('javascript:alert(1)')).resolves.toBe(false);
    await expect(gateway.openExternal('https://docs.asoe.cn')).resolves.toBe(true);
    expect(opened).toBe('https://docs.asoe.cn');
  });

  it('通知去重窗口可在运行时对齐，并对齐后清空旧记录', async () => {
    const gateway = new HostGateway({ dedupeWindowMs: 60_000 });
    let calls = 0;
    gateway.attach({
      host: 'shell',
      notify: () => {
        calls += 1;
      },
    });

    await gateway.notify({ title: 't', body: 'b', dedupeKey: 'k' });
    await gateway.notify({ title: 't', body: 'b', dedupeKey: 'k' });
    expect(calls).toBe(1);

    // 把窗口调到 0 附近：旧记录必须被清掉，否则下一条还是被压住。
    gateway.setDedupeWindow(1);
    expect(gateway.dedupeWindowMs).toBe(1);
    await gateway.notify({ title: 't', body: 'b', dedupeKey: 'k' });
    expect(calls).toBe(2);
  });

  it('非法的去重窗口被忽略，不会把窗口变成 0（等于永久静音）', () => {
    const gateway = new HostGateway({ dedupeWindowMs: 1_000 });
    gateway.setDedupeWindow(0);
    gateway.setDedupeWindow(Number.NaN);
    gateway.setDedupeWindow(-5);
    expect(gateway.dedupeWindowMs).toBe(1_000);
  });

  it('替换宿主后去重窗口清空，新会话首批告警不会被静默吃掉', async () => {
    const gateway = new HostGateway();
    let calls = 0;
    const notify = (): void => {
      calls += 1;
    };
    gateway.attach({ host: 'a', notify });
    await gateway.notify({ title: 't', body: 'b', dedupeKey: 'k' });
    gateway.attach({ host: 'a', notify });
    await gateway.notify({ title: 't', body: 'b', dedupeKey: 'k' });
    // 同一个宿主标识：去重窗口保留（这是刻意的，避免同宿主重复告警刷屏）
    expect(calls).toBe(1);

    gateway.attach({ host: 'b', notify });
    await gateway.notify({ title: 't', body: 'b', dedupeKey: 'k' });
    expect(calls).toBe(2);
  });
});
