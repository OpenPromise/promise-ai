import { describe, expect, it } from 'vitest';
import { markdownToPlain, splitLongText } from './markdown.js';

describe('markdownToPlain', () => {
  it('strips markdown syntax while keeping text', () => {
    const input = [
      '# 标题',
      '',
      '这是 **加粗** 和 *斜体*，还有 `code`。',
      '- 列表项',
      '> 引用',
      '',
      '[链接](https://example.com) 和 ~~删除线~~',
    ].join('\n');
    const out = markdownToPlain(input);
    expect(out).toContain('标题');
    expect(out).toContain('加粗');
    expect(out).toContain('斜体');
    expect(out).toContain('code');
    expect(out).toContain('列表项');
    expect(out).toContain('引用');
    expect(out).toContain('链接（https://example.com）');
    expect(out).not.toContain('**');
    expect(out).not.toContain('```');
  });
});

describe('splitLongText', () => {
  it('splits long replies on newline boundaries', () => {
    const text = Array.from({ length: 20 }, (_, i) => `第${i}行：${'字'.repeat(120)}`).join('\n');
    const parts = splitLongText(text, 300);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join('').replace(/\n/g, '')).toBe(text.replace(/\n/g, ''));
  });

  it('returns empty array for empty text', () => {
    expect(splitLongText('')).toEqual([]);
  });

  it('硬切分支不拆开 emoji（UTF-16 代理对保护）', () => {
    // 无换行可切 → 走硬切；切点正好落在 emoji 中间
    const text = 'a'.repeat(99) + '😀' + 'b'.repeat(60);
    const parts = splitLongText(text, 100);
    expect(parts.length).toBeGreaterThan(1);
    // 任何一段都不能以孤立高代理结尾、或以孤立低代理开头
    for (const part of parts) {
      expect(/[\uD800-\uDBFF]$/.test(part)).toBe(false);
      expect(/^[\uDC00-\uDFFF]/.test(part)).toBe(false);
    }
    expect(parts.join('')).toBe(text);
  });
});
