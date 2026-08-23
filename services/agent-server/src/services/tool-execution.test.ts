import { describe, expect, it } from 'vitest';
import { missingConfigHint } from './tool-execution.js';
import { DSH_NOT_FOUND_MESSAGE } from './coding-tool.js';

describe('missingConfigHint（Leon 工具可用性显式化的务实版：报错即给指引）', () => {
  it('生成"缺什么/配置位置/如何补"统一后缀', () => {
    const hint = missingConfigHint(
      'DEEPSEEK_API_KEY',
      '环境变量 .env',
      '在 .env 设置 DEEPSEEK_API_KEY=xxx',
    );
    expect(hint).toContain('缺什么：DEEPSEEK_API_KEY');
    expect(hint).toContain('配置位置：环境变量 .env');
    expect(hint).toContain('如何补：在 .env 设置 DEEPSEEK_API_KEY=xxx');
    expect(hint.startsWith('（')).toBe(true);
    expect(hint.endsWith('）')).toBe(true);
  });
});

describe('DSH_NOT_FOUND_MESSAGE（缺 dsh 报错，覆盖 ops.delegate / coding.run / engineer.delegate）', () => {
  it('报错信息包含"缺什么/去哪补/怎么补"完整指引，而不是只报"未找到"', () => {
    expect(DSH_NOT_FOUND_MESSAGE).toContain('未找到 dsh');
    expect(DSH_NOT_FOUND_MESSAGE).toContain('缺什么');
    expect(DSH_NOT_FOUND_MESSAGE).toContain('配置位置');
    expect(DSH_NOT_FOUND_MESSAGE).toContain('如何补');
    expect(DSH_NOT_FOUND_MESSAGE).toContain('@deepseek-ai/dsh');
  });
});
