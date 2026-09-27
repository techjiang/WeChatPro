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
