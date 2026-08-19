import { describe, expect, it } from 'vitest';
import { validateToolArgs } from './validate.js';

describe('validateToolArgs', () => {
  it('accepts valid arguments', () => {
    const issues = validateToolArgs(
      {
        type: 'object',
        properties: {
          command: { type: 'string' },
          count: { type: 'integer', minimum: 1 },
          action: { type: 'string', enum: ['shutdown', 'restart'] },
        },
        required: ['command', 'action'],
      },
      { command: 'Get-Date', count: 3, action: 'restart' },
    );
    expect(issues).toEqual([]);
  });

  it('reports missing required fields', () => {
    const issues = validateToolArgs(
      { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      {},
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('缺少必填参数 command');
  });

  it('rejects a wrong type', () => {
    const issues = validateToolArgs(
      { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      { command: 123 },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('类型必须是 string');
  });

  it('rejects values outside an enum', () => {
    const issues = validateToolArgs(
      {
        type: 'object',
        properties: { action: { type: 'string', enum: ['up', 'down', 'mute'] } },
        required: ['action'],
      },
      { action: 'explode' },
    );
    expect(issues[0]?.message).toContain('"up" / "down" / "mute"');
  });

  it('enforces number bounds and integer type', () => {
    expect(
      validateToolArgs(
        { type: 'object', properties: { x: { type: 'integer', minimum: 0 } }, required: ['x'] },
        { x: 1.5 },
      )[0]?.message,
    ).toContain('类型必须是 integer');
    expect(
      validateToolArgs(
        { type: 'object', properties: { x: { type: 'integer', minimum: 0 } }, required: ['x'] },
        { x: -2 },
      )[0]?.message,
    ).toContain('不能小于 0');
  });

  it('validates nested objects and array items with paths', () => {
    const issues = validateToolArgs(
      {
        type: 'object',
        properties: {
          points: {
            type: 'array',
            items: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
          },
        },
        required: ['points'],
      },
      { points: [{ x: 1 }, { y: 2 }] },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('points[1].x');
    expect(issues[0]?.message).toContain('缺少必填参数');
  });

  it('ignores unknown schema keywords', () => {
    const issues = validateToolArgs(
      { type: 'object', properties: { a: { type: 'string', minLength: 1 } }, required: ['a'] },
      { a: 'ok', extra: true },
    );
    expect(issues).toEqual([]);
  });
});
