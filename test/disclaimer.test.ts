/**
 * 免责声明与风险提示的守门测试。
 *
 * 为什么法律文本也要测：这份声明最容易的失效方式**不是写错，而是被删掉**——
 * 有人在重构面板、精简 README、或做「文案优化」时顺手删了几行，
 * 而没有任何自动化手段会因此报错。等真出事时，才发现当时已经没声明了。
 *
 * 所以这里断言的是**存在性与覆盖度**，不是措辞本身：
 * 五类核心责任必须都被提到，且必须能触达 README / 面板 / CLI / API 四个出口。
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DISCLAIMER_SECTIONS,
  RISK_LEVEL,
  RISK_NOTICE,
  disclaimerPayload,
  disclaimerText,
  shortDisclaimer,
} from '../src/legal/disclaimer.js';

const read = (path: string): string => readFileSync(path, 'utf8');

describe('免责声明', () => {
  it('风险等级为高风险，且明确指出封号风险', () => {
    expect(RISK_LEVEL.level).toBe('high');
    expect(RISK_LEVEL.label).toContain('高风险');
    expect(RISK_LEVEL.summary).toMatch(/封禁|限制/);
  });

  it('风险提示覆盖协议违规、封号、可用性、误判、与腾讯无关联', () => {
    const text = RISK_NOTICE.join('\n');
    expect(text).toContain('微信软件许可及服务协议');
    expect(text).toMatch(/永久封禁/);
    expect(text).toMatch(/无法保证|无法承诺/);
    expect(text).toMatch(/误报/);
    expect(text).toContain('无任何关联');
  });

  it('免责条款分组齐全：作者责任 / 使用者责任 / 数据与隐私 / 许可', () => {
    const titles = DISCLAIMER_SECTIONS.map((s) => s.title);
    expect(titles).toEqual(['作者责任', '使用者责任', '数据与隐私', '许可与二次开发']);
    for (const section of DISCLAIMER_SECTIONS) {
      expect(section.items.length).toBeGreaterThan(0);
      for (const item of section.items) expect(item.length).toBeGreaterThan(10);
    }
  });

  it('作者责任明确写出「不承担任何责任」与「无担保」', () => {
    const author = DISCLAIMER_SECTIONS.find((s) => s.title === '作者责任');
    const text = author?.items.join('\n') ?? '';
    expect(text).toMatch(/不对任何[^。]*损失承担责任/);
    expect(text).toMatch(/明示或默示担保/);
    expect(text).toMatch(/无义务/);
    expect(text).toMatch(/停止维护|下架/);
  });

  it('使用者责任覆盖合规自查、个人信息同意、未成年人、禁止用途、误判不可作为处罚依据', () => {
    const text = DISCLAIMER_SECTIONS.find((s) => s.title === '使用者责任')?.items.join('\n') ?? '';
    expect(text).toMatch(/自行确认/);
    expect(text).toMatch(/未取得群成员同意/);
    expect(text).toMatch(/未成年人/);
    expect(text).toMatch(/骚扰|监控|违法/);
    expect(text).toMatch(/仅供参考|不得/);
  });

  it('数据与隐私说明数据仅本机存储，并点明开启 AI 会导致数据外发', () => {
    const text = DISCLAIMER_SECTIONS.find((s) => s.title === '数据与隐私')?.items.join('\n') ?? '';
    expect(text).toMatch(/仅存储|本机/);
    expect(text).toMatch(/不收集、不上传、不接触/);
    expect(text).toMatch(/数据外发/);
    expect(text).toMatch(/鉴权令牌/);
  });

  it('明文说明不得移除声明（否则二次分发可以合法地把声明删掉）', () => {
    const text = DISCLAIMER_SECTIONS.find((s) => s.title === '许可与二次开发')?.items.join('\n') ?? '';
    expect(text).toMatch(/不得移除|须保留/);
    expect(text).toContain('MIT');
  });

  it('disclaimerText 用于纯文本输出，包含全部分组与结束语', () => {
    const text = disclaimerText();
    for (const section of DISCLAIMER_SECTIONS) expect(text).toContain(section.title);
    expect(text).toContain('停止使用并删除本项目');
    expect(text.split('\n').every((line) => line.length <= 200)).toBe(true);
  });

  it('shortDisclaimer 是一句话版，能塞进横幅与通知栏', () => {
    const text = shortDisclaimer();
    expect(text.length).toBeLessThan(80);
    expect(text).toMatch(/不承担任何责任/);
    expect(text).toMatch(/封禁/);
  });

  it('disclaimerPayload 给 API 用，字段完整且可 JSON 序列化', () => {
    const payload = disclaimerPayload();
    expect(payload.project).toBe('WeChatPro');
    expect(payload.license).toBe('MIT');
    expect(payload.risk.level).toBe('high');
    expect(payload.notice.length).toBe(RISK_NOTICE.length);
    expect(payload.sections.length).toBe(DISCLAIMER_SECTIONS.length);
    expect(JSON.parse(JSON.stringify(payload))).toMatchObject({ project: 'WeChatPro' });
  });
});

describe('免责声明的触达面', () => {
  it('README 有独立章节与顶部警示，且都被同一份文本覆盖', () => {
    const readme = read('README.md');
    expect(readme).toContain('## 免责声明与风险提示');
    expect(readme).toMatch(/高风险提示/);
    expect(readme).toContain('停止使用并删除本项目');
    // 四个分组都要在 README 里出现，否则读者只看 README 会漏掉条款。
    for (const section of DISCLAIMER_SECTIONS) expect(readme).toContain(section.title);
  });

  it('面板「关于」页展示声明，且文本来自接口而非硬编码', () => {
    const panel = read('src/client/panel.ts');
    expect(panel).toContain('renderDisclaimer');
    expect(panel).toContain('免责声明与风险提示');
    // 面板不能自己抄一份声明文本：抄了就会和 src/legal 漂移。
    expect(panel).not.toContain('适销性');
    expect(panel).not.toContain('《个人信息保护法》');
  });

  it('引擎暴露 /api/disclaimer 供面板与脚本取用', () => {
    const server = read('src/api/server.ts');
    expect(server).toContain("app.get('/api/disclaimer'");
    expect(server).toContain('disclaimerPayload');
  });

  it('CLI 提供 disclaimer 子命令，且启动时打印风险提示', () => {
    const cli = read('src/cli.ts');
    expect(cli).toContain("case 'disclaimer'");
    expect(cli).toContain('disclaimerCommand');
    expect(cli).toContain('riskBanner');
    expect(cli).toContain('disclaimerText');
  });

  it('存在独立的免责声明文档并链接自 README', () => {
    const doc = read('docs/disclaimer.md');
    expect(doc).toContain('免责声明与风险提示');
    expect(doc).toMatch(/常见问题/);
    expect(read('README.md')).toContain('docs/disclaimer.md');
  });
});
