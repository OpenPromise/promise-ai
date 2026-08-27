import { describe, expect, it } from 'vitest';
import { clipPlainText, markdownToPlain, splitLongText } from './markdown.js';

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

  it('converts GFM pipe tables into labeled lines', () => {
    const input = [
      '| 容器 | 状态 |',
      '|---|---|',
      '| assistant-app | Up 6 min |',
      '| weixin-bridge | Up 10 min |',
    ].join('\n');
    const out = markdownToPlain(input);
    expect(out).toContain('容器：assistant-app，状态：Up 6 min');
    expect(out).toContain('容器：weixin-bridge，状态：Up 10 min');
    expect(out).not.toContain('|---|');
    expect(out).not.toContain('| 容器');
  });

  it('skips separator-only rows and still strips cell markdown', () => {
    const input = ['| **容器** | 状态 |', '| :--- | ---: |', '| `assistant-app` | Up 6 min |'].join(
      '\n',
    );
    const out = markdownToPlain(input);
    expect(out).toBe('容器：assistant-app，状态：Up 6 min');
  });
});

describe('clipPlainText', () => {
  it('returns short text unchanged', () => {
    expect(clipPlainText('短报告')).toBe('短报告');
  });

  it('cuts on last newline before max and appends omission note', () => {
    const text = `第一行\n第二行\n${'三'.repeat(2000)}`;
    const out = clipPlainText(text, 1200);
    expect(out).toContain('…（后文已略，要全文跟我说）');
    expect(out.startsWith('第一行\n第二行')).toBe(true);
    expect(out).not.toContain('三'.repeat(50));
  });

  it('does not split emoji (UTF-16 surrogate pair)', () => {
    const text = 'a'.repeat(99) + '😀' + 'b'.repeat(50);
    const out = clipPlainText(text, 100);
    expect(out).toContain('…（后文已略，要全文跟我说）');
    expect(out).not.toContain('\uFFFD');
    const body = out.replace(/\n…（后文已略，要全文跟我说）$/, '');
    expect(/[\uD800-\uDBFF]$/.test(body)).toBe(false);
    expect(body.includes('\uD83D') && !body.includes('\uDE00')).toBe(false);
    expect(body).toBe('a'.repeat(99));
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
