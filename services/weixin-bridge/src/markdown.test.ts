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
});
