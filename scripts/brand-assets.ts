/**
 * 品牌图标生成。
 *
 * 从仓库里那份**无背景原图**派生出全部尺寸的图标，避免手工维护一堆 PNG
 * （手工维护的下场是某天某个尺寸忘了更新，客户端里就出现一个旧版图标）。
 *
 * 用法：
 *   npm i -D sharp
 *   npx tsx scripts/brand-assets.ts brand/logo-source.png
 *
 * 原图是「六边形徽标 + 下方的包名文字」，并且**带投影**。所以这里不能像
 * 早期版本那样直接套一个圆形遮罩：徽标不是圆的，圆形遮罩会切掉六边形的
 * 左右尖角。正确做法是逐像素求 alpha 边界（忽略半透明投影，避免把投影
 * 当成图形本体而多留白），再按边界裁成正方形。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

interface RawImage {
  data: Buffer;
  info: { width: number; height: number; channels: number };
}

interface SharpPipeline {
  ensureAlpha(): SharpPipeline;
  raw(): { toBuffer(options: { resolveWithObject: true }): Promise<RawImage> } & SharpPipeline;
  extract(region: { left: number; top: number; width: number; height: number }): SharpPipeline;
  resize(width: number, height?: number, options?: Record<string, unknown>): SharpPipeline;
  composite(inputs: Array<{ input: Buffer; top?: number; left?: number; blend?: string }>): SharpPipeline;
  png(options?: Record<string, unknown>): SharpPipeline;
  toBuffer(): Promise<Buffer>;
}

interface Sharp {
  (input: Buffer | string): SharpPipeline;
}

/** 原图里的清晰矩形区域（相对像素坐标）。 */
export interface ContentBox {
  left: number;
  top: number;
  width: number;
  height: number;
  /** 被忽略的半透明投影像素占比，仅用于日志与诊断。 */
  shadowRatio: number;
}

/**
 * 原图的信息性分界线：徽标在上、包名文字在下，中间有一条完全透明的横带。
 * 返回该横带的行区间（上界、下界，含）。
 *
 * 只看**夹在内容之间**的空白带。顶部与底部的留白同样是全透明的，如果不过滤掉，
 * 第一个返回的就是页眉留白，徽标区域会变成「整张图上半部分」——小尺寸图标里
 * 于是混进一截包名文字，糊成一团。
 */
export function findSeparator(alpha: Uint8Array, width: number, height: number): [number, number] | null {
  const rowHasContent = (y: number): boolean => {
    for (let x = 0; x < width; x += 1) if ((alpha[y * width + x] as number) > 16) return true;
    return false;
  };

  let firstContent = -1;
  let lastContent = -1;
  for (let y = 0; y < height; y += 1) {
    if (rowHasContent(y)) {
      if (firstContent < 0) firstContent = y;
      lastContent = y;
    }
  }
  if (firstContent < 0) return null;

  let run: number | null = null;
  for (let y = firstContent; y <= lastContent; y += 1) {
    if (!rowHasContent(y)) {
      if (run === null) run = y;
    } else if (run !== null) {
      return [run, y - 1];
    }
  }
  return null;
}

/**
 * 求不透明内容的边界框。
 *
 * 关键是阈值：原图带半透明投影（alpha 低但非零）。若用 `alpha > 0`，
 * 边界会外扩到投影的外沿，裁出来的图四周多出一圈看不到的留白，
 * 小尺寸下表现为图标明显偏小。取 `alpha > 16` 只认本体。
 */
export function contentBox(alpha: Uint8Array, width: number, height: number, top = 0, bottom = height - 1): ContentBox {
  let left = width;
  let right = -1;
  let topRow = -1;
  let bottomRow = -1;
  let shadow = 0;
  for (let y = top; y <= bottom; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const a = alpha[y * width + x] as number;
      if (a > 16) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (topRow < 0) topRow = y;
        bottomRow = y;
      } else if (a > 0) {
        shadow += 1;
      }
    }
  }
  if (right < 0) return { left: 0, top: 0, width: 0, height: 0, shadowRatio: 0 };
  return {
    left,
    top: topRow,
    width: right - left + 1,
    height: bottomRow - topRow + 1,
    shadowRatio: shadow / (width * height),
  };
}

export interface CropRegion {
  left: number;
  top: number;
  size: number;
  /** 信息来源：徽标单独成图，还是连文字一起。 */
  kind: 'mark' | 'lockup';
}

/**
 * 计算正方形裁切区域。
 *
 * `lockup` 保留「徽标 + 文字」完整组合，适合 README、商店页这类需要看到
 * 项目名的地方；`mark` 只取六边形徽标，适合 16~64px 的任务栏、插件图标 ——
 * 那个尺寸下包名文字只会糊成一团噪点。
 *
 * 二者按同一个尺度口径（统一以宽度为基准）取正方形，保证 `mark` 是 `lockup`
 * 在垂直方向上的放大视图，视觉上不会互相跳。
 */
export function cropRegions(alpha: Uint8Array, width: number, height: number): { mark: CropRegion; lockup: CropRegion } {
  const lockup = contentBox(alpha, width, height);
  const separator = findSeparator(alpha, width, height);
  const separatorTop = separator ? separator[0] : height;
  const markBox = separator ? contentBox(alpha, width, height, 0, separatorTop - 1) : lockup;

  // 空图上没有内容可框，退化成整张画布，避免算出 0 尺寸区域。
  if (lockup.width === 0) {
    const fallback: CropRegion = { left: 0, top: 0, size: Math.min(width, height), kind: 'lockup' };
    return { mark: { ...fallback, kind: 'mark' }, lockup: fallback };
  }

  const fit = (box: ContentBox, kind: 'mark' | 'lockup'): CropRegion => {
    if (box.width === 0) {
      return { left: 0, top: 0, size: Math.min(width, height), kind };
    }
    // 边长基准取宽度，但**不允许正方形装不下内容**：竖版 lockup（徽标 + 包名）
    // 的高远大于宽，按宽度裁会把包名文字削掉一截。所以下限取高边。
    // 这样 mark 仍以宽度为基准（徽标近似方形，视觉上更满），
    // lockup 则被内容顶着长高，两者不共用最终边长是有意的。
    const size = Math.min(Math.max(box.width, box.height), width, height);
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    // 贴边：宁可偏心也不能裁到画布外。
    let left = Math.round(Math.max(0, Math.min(cx - size / 2, width - size)));
    let top = Math.round(Math.max(0, Math.min(cy - size / 2, height - size)));

    // mark 不能越过透明横带：越过了就会把包名文字裁进来。
    // 上下空间不够时优先往上收（徽标顶部留白通常比底部多），收到顶还不够就
    // 让正方形往上溢出，反正那部分只是透明画布外的留白。
    if (kind === 'mark' && box.height <= separatorTop) {
      top = Math.min(top, separatorTop - size);
    }
    void left;
    return { left, top: Math.round(top), size, kind };
  };

  return { mark: fit(markBox, 'mark'), lockup: fit(lockup, 'lockup') };
}

export interface GenerateOptions {
  /** 输出目录，默认 `brand`。 */
  outDir?: string;
  /** 面板内联用的尺寸，默认 256。 */
  panelSize?: number;
}

/** 生成全套图标。返回生成的文件清单，便于日志与测试断言。 */
export async function generate(sharp: Sharp, sourcePath: string, options: GenerateOptions = {}): Promise<string[]> {
  const outDir = resolve(options.outDir ?? 'brand');
  const iconsDir = join(outDir, 'icons');
  mkdirSync(iconsDir, { recursive: true });

  const source = readFileSync(sourcePath);
  const { data, info } = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i += 1) alpha[i] = data[i * channels + 3] as number;

  const { mark, lockup } = cropRegions(alpha, width, height);
  const lockupBox = contentBox(alpha, width, height);
  process.stdout.write(
    `原图 ${width}×${height}｜内容 ${lockupBox.width}×${lockupBox.height} @(${lockupBox.left},${lockupBox.top})` +
      `｜投影像素 ${(lockupBox.shadowRatio * 100).toFixed(1)}%\n` +
      `裁切：徽标 ${mark.size}px @(${mark.left},${mark.top})｜整体 ${lockup.size}px @(${lockup.left},${lockup.top})\n`,
  );

  const cut = (region: CropRegion): SharpPipeline =>
    sharp(source).ensureAlpha().extract({ left: region.left, top: region.top, width: region.size, height: region.size });

  const master = await cut(mark).png({ compressionLevel: 9 }).toBuffer();
  const masterLockup = await cut(lockup).png({ compressionLevel: 9 }).toBuffer();

  const written: string[] = [];
  const write = (path: string, buffer: Buffer): void => {
    writeFileSync(path, buffer);
    written.push(path);
  };

  write(join(outDir, 'logo.png'), master);
  write(join(outDir, 'logo-lockup.png'), masterLockup);
  for (const size of [512, 256, 128, 64, 32, 16]) {
    write(join(outDir, `logo-${size}.png`), await sharp(master).resize(size, size).png().toBuffer());
  }
  for (const size of [512, 256]) {
    write(join(outDir, `logo-lockup-${size}.png`), await sharp(masterLockup).resize(size, size).png().toBuffer());
  }
  write(join(outDir, 'avatar-512.png'), await sharp(master).resize(512, 512).png().toBuffer());

  for (const size of [16, 24, 32, 48, 64, 128, 256]) {
    write(join(iconsDir, `icon-${size}.png`), await sharp(master).resize(size, size).png().toBuffer());
  }
  // ICO 直接内嵌 256 PNG：Windows 从 Vista 起支持 PNG 压缩的 ICO，
  // 比多尺寸位图 ICO 更小且不失真。
  write(join(iconsDir, 'icon-256.ico'), await sharp(master).resize(256, 256).png().toBuffer());

  const panelSize = options.panelSize ?? 256;
  write(join(iconsDir, 'panel-24.png'), await sharp(master).resize(24, 24).png().toBuffer());
  write(join(iconsDir, 'panel-48.png'), await sharp(master).resize(48, 48).png().toBuffer());

  return written;
}

/** CLI 入口。 */
async function main(): Promise<void> {
  const sourcePath = process.argv[2];
  if (!sourcePath) {
    process.stderr.write('用法: npx tsx scripts/brand-assets.ts <源图路径> [--out brand]\n');
    process.exitCode = 2;
    return;
  }
  const outIndex = process.argv.indexOf('--out');
  const outDir = outIndex >= 0 ? (process.argv[outIndex + 1] as string) : 'brand';

  let sharpModule: Sharp;
  try {
    // sharp 只在生成资源时需要，作为可选依赖按需加载——
    // 运行时（引擎、面板）只读现成的 PNG，不该被原生依赖拖累。
    ({ default: sharpModule } = (await import('sharp')) as unknown as { default: Sharp });
  } catch {
    process.stderr.write('缺少依赖 sharp。先执行：npm i -D sharp\n');
    process.exitCode = 1;
    return;
  }

  const files = await generate(sharpModule, sourcePath, { outDir });
  process.stdout.write(`已生成 ${files.length} 个文件到 ${dirname(files[0] as string)}\n`);
}

if (process.argv[1] && /brand-assets\.(ts|js)$/.test(process.argv[1])) {
  void main();
}
