import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 品牌资源装载。
 *
 * Logo 是 base64 内联进面板的：PC 客户端插件常常在 `file://` 或受限 CSP 环境下渲染，
 * 外链/相对路径的图片会加载失败（表现为一片空白图标），内联是最稳的做法。
 * 资源文件随包发布（`brand/` 已在 package.json 的 files 白名单内）。
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** 品牌元信息，面板「关于」页与通知模板共用一份，避免散落各处。 */
export const BRAND = {
  name: 'WeChatPro',
  tagline: '微信社群智能引擎',
  author: '科技酱',
  website: 'https://docs.asoe.cn',
  github: 'https://github.com/techjiang/',
  bilibili: 'https://space.bilibili.com/1768832152',
  forum: 'https://forums.asoe.cn/',
  qqGroups: ['291974598', '474819022'],
  license: 'MIT',
} as const;

/**
 * 候选路径：源码目录与构建产物目录的层级不同，两处都试。
 *
 * 用 `logo-256.png`（徽标版）而不是 `logo-lockup-*`：面板顶栏是 24~32px 的小位图，
 * lockup 里的包名文字在这个尺寸下只会糊成一团。需要完整组合（README、商店页）
 * 的地方直接引用 `brand/logo-lockup-512.png`。
 */
const CANDIDATES = [
  resolve(HERE, '../../brand/logo-256.png'),
  resolve(HERE, '../../../brand/logo-256.png'),
  resolve(process.cwd(), 'brand/logo-256.png'),
];

let cachedIcon: string | null | undefined;

/**
 * 返回内联的 Logo data URL。
 *
 * 读不到就返回 `null`，由调用方降级成纯文字标题——品牌资源缺失不该让面板打不开。
 */
export function brandIcon(force = false): string | null {
  if (!force && cachedIcon !== undefined) return cachedIcon;
  for (const path of CANDIDATES) {
    try {
      const buffer = readFileSync(path);
      cachedIcon = `data:image/png;base64,${buffer.toString('base64')}`;
      return cachedIcon;
    } catch {
      continue;
    }
  }
  cachedIcon = null;
  return null;
}

/** 品牌配色：面板 CSS 变量与终端输出共用。 */
export const BRAND_COLORS = {
  deep: '#0b1a33',
  navy: '#123a63',
  cyan: '#2ec5c5',
  ice: '#e8f4fb',
  silver: '#c8d2dc',
} as const;

/** 终端 ASCII 横幅，`wechatpro doctor` 与启动日志用。 */
export function asciiBanner(): string {
  return [
    '  ╭──────────────────────────────────────────╮',
    '  │   WeChatPro · 微信社群智能引擎            │',
    '  │   作者 科技酱 · docs.asoe.cn              │',
    '  ╰──────────────────────────────────────────╯',
  ].join('\n');
}
