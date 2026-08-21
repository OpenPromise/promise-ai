/**
 * Markdown -> 微信纯文本：微信不渲染 Markdown，简单转换后更易读。
 * 只做常见语法，不做完整解析（保持简单）。
 */
export function markdownToPlain(input: string): string {
  let text = input.replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, '').trim());
  text = text
    .split('\n')
    .map((line) => {
      let out = line.replace(/^#{1,6}\s+/, '').trim();
      out = out.replace(/^\s*>\s?/, '');
      out = out.replace(/`([^`]+)`/g, '$1');
      out = out.replace(/\*\*([^*]+)\*\*/g, '$1');
      out = out.replace(/__([^_]+)__/g, '$1');
      out = out.replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, '$1$2');
      out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1（$2）');
      out = out.replace(/~~([^~]+)~~/g, '$1');
      return out;
    })
    .join('\n');
  // 折叠连续空行
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return text;
}

/**
 * 把切点回退到合法 UTF-16 码点边界：index 落在 surrogate pair 中间（低代理项开头）
 * 时往前退一位，避免硬切把 emoji 拆成两个孤立代理项（微信端显示为乱码）。
 * 与 relay.ts 的同名逻辑同一思路，这里只服务 splitLongText 的硬切分支。
 */
function clampToCharBoundary(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return index;
  const code = text.charCodeAt(index);
  if (code >= 0xdc00 && code <= 0xdfff) return index - 1;
  return index;
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
