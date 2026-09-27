/**
 * 品牌图标生成。
 *
 * 从仓库里那份**无背景原图**派生出全部尺寸的图标，避免手工维护一堆 PNG
 * （手工维护的下场是某天某个尺寸忘了更新，客户端里就出现一个旧版图标）。
 *
 * 用法：
 *   npm i -D sharp
 *   npx tsx scripts/brand-assets.ts brand/logo.png
 *
 * 关键点是圆形遮罩参数的拟合：原图的圆形边界与画布边框不完全重合，
 * 直接按画布尺寸裁会切掉边缘、或留下一圈背景色。这里用全扫描 + 最小化
 * 「实心区域与理论圆的像素差」求出圆心与半径，比目测靠谱得多。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

interface Sharp {
  (input: Buffer | string): {
    ensureAlpha(): SharpPipeline;
    resize(width: number, height?: number, options?: Record<string, unknown>): SharpPipeline;
    png(options?: Record<string, unknown>): SharpPipeline;
    raw(): { toBuffer(options: { resolveWithObject: true }): Promise<{ data: Buffer; info: FrameInfo }> } & SharpPipeline;
    composite(inputs: Array<{ input: Buffer; top?: number; left?: number; blend?: string }>): SharpPipeline;
    toBuffer(options?: { resolveWithObject?: boolean }): Promise<Buffer>;
    stats(): Promise<unknown>;
  };
  create(options: { create: { width: number; height: number; channels: number; background: Record<string, number> } }): SharpPipeline;
}

interface SharpPipeline {
  ensureAlpha(): SharpPipeline;
  resize(width: number, height?: number, options?: Record<string, unknown>): SharpPipeline;
  png(options?: Record<string, unknown>): SharpPipeline;
  raw(): { toBuffer(options: { resolveWithObject: true }): Promise<{ data: Buffer; info: FrameInfo }> } & SharpPipeline;
  composite(inputs: Array<{ input: Buffer; top?: number; left?: number; blend?: string }>): SharpPipeline;
  toBuffer(options?: { resolveWithObject?: boolean }): Promise<Buffer>;
}

interface FrameInfo {
  width: number;
  height: number;
  channels: number;
}

/** 拟合出的圆：圆心在画布内的相对位置 + 相对半径。 */
export interface CircleFit {
  cx: number;
  cy: number;
  r: number;
  /** 失配像素占比，越低越可信；超过 1% 说明原图不是标准圆形裁切。 */
  mismatchRatio: number;
}

/**
 * 拟合原图里「实心圆形」的边界。
 *
 * 做法：对每个候选 (cx, cy, r) 计算「实心像素」与「理论圆内」的对称差，
 * 取失配最少的组合。粒度 0.1 像素、步长 0.1 已经足够（PNG 本身是整数像素），
 * 再细只会更慢而不会更准。
 */
export async function fitCircle(sharp: Sharp, source: Buffer): Promise<CircleFit> {
  const { data, info } = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  let best: CircleFit = { cx: width / 2, cy: height / 2, r: Math.min(width, height) / 2, mismatchRatio: 1 };

  const start = Math.min(width, height) / 2 - 3;
  const end = Math.min(width, height) / 2 + 3;
  for (let r = start; r <= end; r += 0.1) {
    for (let cx = width / 2 - 1; cx <= width / 2 + 1; cx += 0.1) {
      for (let cy = height / 2 - 1; cy <= height / 2 + 1; cy += 0.1) {
        let mismatch = 0;
        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            const solid = (data[(y * width + x) * channels + 3] as number) > 128;
            const inCircle = Math.hypot(x - cx, y - cy) <= r;
            if (solid !== inCircle) mismatch += 1;
          }
        }
        const ratio = mismatch / (width * height);
        if (ratio < best.mismatchRatio) best = { cx, cy, r, mismatchRatio: ratio };
      }
    }
  }
  return best;
}

/** 按拟合结果裁出圆形透明底 PNG。 */
export async function maskCircle(sharp: Sharp, source: Buffer, fit: CircleFit): Promise<Buffer> {
  const meta = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = meta.info;
  const svg = `<svg width="${width}" height="${height}"><circle cx="${fit.cx}" cy="${fit.cy}" r="${fit.r}" fill="#fff"/></svg>`;
  return sharp(source)
    .ensureAlpha()
    .composite([{ input: Buffer.from(svg), blend: 'dest-in' }])
    .png({ compressionLevel: 9 })
    .toBuffer();
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
  const fit = await fitCircle(sharp, source);
  if (fit.mismatchRatio > 0.01) {
    // 只警告不失败：原图可能本来就是方形或非标准圆形，继续生成仍是可用的。
    process.stderr.write(
      `警告：圆形拟合失配 ${(fit.mismatchRatio * 100).toFixed(2)}%，原图可能不是标准圆形裁切。\n`,
    );
  }
  process.stdout.write(
    `圆形拟合：圆心 (${fit.cx.toFixed(2)}, ${fit.cy.toFixed(2)}) 半径 ${fit.r.toFixed(2)}｜失配 ${(fit.mismatchRatio * 100).toFixed(3)}%\n`,
  );

  const master = await maskCircle(sharp, source, fit);
  const written: string[] = [];
  const write = (path: string, buffer: Buffer): void => {
    writeFileSync(path, buffer);
    written.push(path);
  };

  write(join(outDir, 'logo.png'), master);
  for (const size of [512, 256, 128, 64, 32, 16]) {
    write(join(outDir, `logo-${size}.png`), await sharp(master).resize(size, size).png().toBuffer());
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
  write(join(outDir, `logo-${panelSize}.png`), await sharp(master).resize(panelSize, panelSize).png().toBuffer());

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
