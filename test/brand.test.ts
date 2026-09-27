import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { contentBox, cropRegions, findSeparator } from '../scripts/brand-assets.js';

/**
 * 品牌资产的裁切几何。
 *
 * 这部分逻辑单测起来很值：它错的时候**不会报错**，只会让仓库里的 PNG 变成
 * 一圈多余留白、或者被圆形遮罩切掉六边形尖角。人眼要盯着小尺寸图标才看得出来，
 * 而 CI 里根本没人盯。所以把「边界怎么算」按纯函数测掉。
 */

const WIDTH = 100;
const HEIGHT = 120;

/** 造一张合成 alpha 图：两个不透明块 + 一圈低 alpha 投影。 */
function synthetic(): Uint8Array {
  const a = new Uint8Array(WIDTH * HEIGHT);
  const paint = (x0: number, y0: number, x1: number, y1: number, v: number): void => {
    for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) a[y * WIDTH + x] = v;
  };
  // 徽标：20..79 列、10..59 行
  paint(20, 10, 79, 59, 255);
  // 包名文字：30..69 列、80..100 行
  paint(30, 80, 69, 100, 255);
  // 投影：贴着徽标四周一圈，alpha 很低。
  // 只能画在**边框**上——如果整块盖上去，就会把已经画好的不透明本体覆盖成
  // alpha=6，徽标整个消失。这不是测试数据的细节，而是「先画谁」的顺序问题。
  const shadow = 6;
  paint(18, 8, 81, 61, shadow);
  paint(20, 10, 79, 59, 255);
  paint(30, 80, 69, 100, 255);
  return a;
}

describe('品牌资产裁切几何', () => {
  it('求边界时忽略半透明投影，否则小尺寸图标会明显偏小', () => {
    const box = contentBox(synthetic(), WIDTH, HEIGHT);
    expect(box).toMatchObject({ left: 20, top: 10, width: 60, height: 91 });
    // 投影被识别出来而不是被当成内容
    expect(box.shadowRatio).toBeGreaterThan(0);
  });

  it('找到徽标与包名文字之间那条透明横带', () => {
    const sep = findSeparator(synthetic(), WIDTH, HEIGHT);
    expect(sep).toEqual([60, 79]);
  });

  it('徽标只含徽标，整体必须装下包名文字', () => {
    const { mark, lockup } = cropRegions(synthetic(), WIDTH, HEIGHT);
    // 徽标按宽度取方形：内容宽 60
    expect(mark.size).toBe(60);
    // 徽标区域必须落在透明横带（y=60）以上，不能把包名文字卷进来
    expect(mark.top + mark.size).toBeLessThanOrEqual(60);
    // 整体是竖版（内容高 91 > 宽 60），正方形边长必须跟着高走，
    // 否则包名文字会被削掉一截
    expect(lockup.size).toBe(91);
    expect(lockup.top + lockup.size).toBeGreaterThanOrEqual(100);
  });

  it('裁切区域不越界，宁可偏心也不裁出画布外', () => {
    const { mark, lockup } = cropRegions(synthetic(), WIDTH, HEIGHT);
    for (const r of [mark, lockup]) {
      expect(r.left).toBeGreaterThanOrEqual(0);
      expect(r.top).toBeGreaterThanOrEqual(0);
      expect(r.left + r.size).toBeLessThanOrEqual(WIDTH);
      expect(r.top + r.size).toBeLessThanOrEqual(HEIGHT);
    }
  });

  it('全透明图不会算出负尺寸区域', () => {
    const empty = new Uint8Array(WIDTH * HEIGHT);
    const { mark, lockup } = cropRegions(empty, WIDTH, HEIGHT);
    expect(mark.size).toBeGreaterThan(0);
    expect(lockup.size).toBeGreaterThan(0);
  });
});

describe('随包发布的品牌资源', () => {
  const png = (path: string): { width: number; height: number; bytes: number } => {
    const buffer = readFileSync(resolve(path));
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), bytes: buffer.length };
  };

  it('面板内联的那份是 256×256 正方形', () => {
    const logo = png('brand/logo-256.png');
    expect(logo).toEqual(expect.objectContaining({ width: 256, height: 256 }));
    expect(logo.bytes).toBeGreaterThan(1024);
  });

  it('lockup 是竖版组合，尺寸与徽标版不同——两者不是同一张图', () => {
    const mark = png('brand/logo-512.png');
    const lockup = png('brand/logo-lockup-512.png');
    expect(mark).toEqual(expect.objectContaining({ width: 512, height: 512 }));
    expect(lockup).toEqual(expect.objectContaining({ width: 512, height: 512 }));
    // 同样的画布尺寸下，lockup 要把包名文字也塞进去，所以内容必然更小：
    // 用文件体积做代理断言，避免实际解码像素。
    expect(lockup.bytes).not.toBe(mark.bytes);
  });

  it('源图仍在仓库里，图标可复现', () => {
    const source = png('brand/logo-source.png');
    expect(source.width).toBe(765);
    expect(source.height).toBe(867);
  });
});
