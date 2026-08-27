/**
 * Markdown -> 微信纯文本：微信不渲染 Markdown，简单转换后更易读。
 * 只做常见语法，不做完整解析（保持简单）。
 */

function stripInlineMarkdown(line: string): string {
  let out = line.replace(/^#{1,6}\s+/, '').trim();
  out = out.replace(/^\s*>\s?/, '');
  out = out.replace(/`([^`]+)`/g, '$1');
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1');
  out = out.replace(/__([^_]+)__/g, '$1');
  out = out.replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, '$1$2');
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1（$2）');
  out = out.replace(/~~([^~]+)~~/g, '$1');
  return out;
}

function parsePipeRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.includes('|', 1)) return null;
  let inner = trimmed;
  if (inner.startsWith('|')) inner = inner.slice(1);
  if (inner.endsWith('|')) inner = inner.slice(0, -1);
  const cells = inner.split('|').map((cell) => cell.trim());
  return cells.length >= 2 ? cells : null;
}

function isSeparatorCells(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell) || cell === '');
}

function convertTableBlock(blockLines: string[], rows: string[][]): string[] {
  const dataRows = rows.filter((row) => !isSeparatorCells(row));
  if (dataRows.length < 2) {
    return blockLines.map((line) => stripInlineMarkdown(line));
  }
  const headers = dataRows[0]!.map((cell) => stripInlineMarkdown(cell));
  const labeled: string[] = [];
  for (const data of dataRows.slice(1)) {
    const parts: string[] = [];
    for (let i = 0; i < headers.length; i += 1) {
      const header = headers[i] ?? '';
      const value = stripInlineMarkdown(data[i] ?? '');
      if (!header && !value) continue;
      parts.push(`${header}：${value}`);
    }
    if (parts.length > 0) labeled.push(parts.join('，'));
  }
  return labeled;
}

export function markdownToPlain(input: string): string {
  let text = input.replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, '').trim());
  const sourceLines = text.split('\n');
  const outLines: string[] = [];
  let i = 0;
  while (i < sourceLines.length) {
    const row = parsePipeRow(sourceLines[i]!);
    if (!row) {
      outLines.push(stripInlineMarkdown(sourceLines[i]!));
      i += 1;
      continue;
    }
    const blockLines: string[] = [];
    const rows: string[][] = [];
    while (i < sourceLines.length) {
      const next = parsePipeRow(sourceLines[i]!);
      if (!next) break;
      blockLines.push(sourceLines[i]!);
      rows.push(next);
      i += 1;
    }
    outLines.push(...convertTableBlock(blockLines, rows));
  }
  text = outLines.join('\n');
  // 折叠连续空行
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return text;
}

/**
 * 把切点回退到合法 UTF-16 码点边界：index 落在 surrogate pair 中间（低代理项开头）
 * 时往前退一位，避免硬切把 emoji 拆成两个孤立代理项（微信端显示为乱码）。
 * 与 relay.ts 的同名逻辑同一思路，这里只服务 splitLongText / clipPlainText 的硬切分支。
 */
function clampToCharBoundary(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return index;
  const code = text.charCodeAt(index);
  if (code >= 0xdc00 && code <= 0xdfff) return index - 1;
  return index;
}

const CLIP_SUFFIX = '\n…（后文已略，要全文跟我说）';

/**
 * 截断纯文本：优先在 maxLen 前最后一个换行处切开，否则回退到 UTF-16 码点边界。
 * 绝不在 surrogate pair 中间 slice（那会把「容」类字符切成 U+FFFD 乱码）。
 */
export function clipPlainText(text: string, maxLen = 1200): string {
  if (text.length <= maxLen) return text;
  let cut = text.lastIndexOf('\n', maxLen);
  if (cut <= 0) cut = clampToCharBoundary(text, maxLen);
  return `${text.slice(0, cut).trimEnd()}${CLIP_SUFFIX}`;
}

/** 长回复按换行边界切分（微信单条消息有长度限制）。 */
export function splitLongText(text: string, maxLen = 1500): string[] {
  if (text.length <= maxLen) return text.length > 0 ? [text] : [];
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf('\n', maxLen);
    // 没有换行可切时硬切，切点回退到码点边界（不拆 emoji）。
    if (cut <= 0) cut = clampToCharBoundary(remaining, maxLen);
    parts.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining.length > 0) parts.push(remaining);
  return parts;
}
