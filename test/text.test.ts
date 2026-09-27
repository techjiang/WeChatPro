import { describe, expect, it } from 'vitest';
import { filterTokens, normalizeText, summarize, tokenize } from '../src/core/text.js';

describe('tokenize', () => {
  it('把中文切成 2-gram', () => {
    expect(tokenize('今天开会')).toEqual(['今天', '天开', '开会']);
  });

  it('单字句保留原字', () => {
    expect(tokenize('好')).toEqual(['好']);
  });

  it('拉丁词小写且过滤单字母', () => {
    expect(tokenize('Hello A World')).toEqual(['hello', 'world']);
  });

  it('中文与英文混排都能取到', () => {
    const tokens = tokenize('项目进度 ok');
    expect(tokens).toContain('项目');
    expect(tokens).toContain('ok');
  });

  it('去掉 URL，避免地址霸榜', () => {
    expect(tokenize('看这个 https://example.com/abc')).not.toContain('https');
  });

  it('空输入返回空数组', () => {
    expect(tokenize('')).toEqual([]);
  });
});

describe('normalizeText', () => {
  it('去掉 @ 提及', () => {
    expect(normalizeText('@张三 你好')).toBe('你好');
  });

  it('去掉零宽字符', () => {
    expect(normalizeText('ab\u200bc')).toBe('abc');
  });
});

describe('filterTokens', () => {
  it('过滤停用词、过短 token 与纯数字', () => {
    const tokens = ['项目', '的', '12', 'a', '进度'];
    expect(filterTokens(tokens, new Set(['的']))).toEqual(['项目', '进度']);
  });
});

describe('summarize', () => {
  it('压缩空白并截断', () => {
    expect(summarize('  多个   空格  ')).toBe('多个 空格');
    expect(summarize('x'.repeat(100), 10)).toBe('xxxxxxxxxx…');
  });
});
