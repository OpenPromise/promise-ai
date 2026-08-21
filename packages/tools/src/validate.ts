import type { JSONSchema } from './index.js';

export interface ValidationIssue {
  path: string;
  message: string;
}

/**
 * Validates a parsed tool-call argument object against the tool's JSON Schema
 * before execution. Covers the subset the current tools actually declare
 * (object/string/number/integer/boolean/array, required, properties, items,
 * enum, min/max); unknown keywords are ignored so a schema can grow without
 * breaking execution.
 */
export function validateToolArgs(
  schema: JSONSchema | undefined,
  value: unknown,
): ValidationIssue[] {
  if (!schema || typeof schema !== 'object') return [];
  return validateValue(schema, value, '');
}

function validateValue(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const at = (key: string): string => (path ? `${path}.${key}` : key);

  if (schema.enum !== undefined) {
    const allowed = Array.isArray(schema.enum) ? schema.enum : [];
    if (!allowed.some((candidate) => candidate === value)) {
      issues.push({
        path: path || '参数',
        message: `${path || '参数'} 必须是 ${allowed.map((item) => JSON.stringify(item)).join(' / ')} 之一`,
      });
    }
  }

  const type = schema.type;
  if (typeof type !== 'string') return issues;

  const typeOk = matchType(type, value);
  if (!typeOk) {
    issues.push({
      path: path || '参数',
      message: `${path || '参数'} 类型必须是 ${type}，实际是 ${describeType(value)}`,
    });
    return issues;
  }

  if (type === 'number' || type === 'integer') {
    if (typeof schema.minimum === 'number' && (value as number) < schema.minimum) {
      issues.push({
        path: path || '参数',
        message: `${path || '参数'} 不能小于 ${schema.minimum}`,
      });
    }
    if (typeof schema.maximum === 'number' && (value as number) > schema.maximum) {
      issues.push({
        path: path || '参数',
        message: `${path || '参数'} 不能大于 ${schema.maximum}`,
      });
    }
  }

  if (type === 'string') {
    if (typeof schema.minLength === 'number' && (value as string).length < schema.minLength) {
      issues.push({
        path: path || '参数',
        message: `${path || '参数'} 长度不能少于 ${schema.minLength}`,
      });
    }
    if (typeof schema.maxLength === 'number' && (value as string).length > schema.maxLength) {
      issues.push({
        path: path || '参数',
        message: `${path || '参数'} 长度不能超过 ${schema.maxLength}`,
      });
    }
    if (typeof schema.pattern === 'string') {
      try {
        if (!new RegExp(schema.pattern).test(value as string)) {
          issues.push({ path: path || '参数', message: `${path || '参数'} 不符合格式要求` });
        }
      } catch {
        // 非法正则按"未通过校验"处理，返回可读错误而不是让异常穿透上层
        issues.push({
          path: path || '参数',
          message: `${path || '参数'} 的格式规则（pattern）无效`,
        });
      }
    }
  }

  if (type === 'object' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys((schema.properties ?? {}) as Record<string, unknown>));
      for (const key of Object.keys(record)) {
        if (!known.has(key)) {
          issues.push({ path: at(key), message: `${at(key)} 不是允许的参数` });
        }
      }
    }
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    for (const key of required) {
      if (!(key in record)) {
        issues.push({ path: at(key), message: `缺少必填参数 ${at(key)}` });
      }
    }
    const properties =
      schema.properties && typeof schema.properties === 'object'
        ? (schema.properties as Record<string, Record<string, unknown>>)
        : {};
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (key in record) {
        issues.push(...validateValue(propertySchema, record[key], at(key)));
      }
    }
  }

  if (
    type === 'array' &&
    Array.isArray(value) &&
    schema.items &&
    typeof schema.items === 'object'
  ) {
    const itemSchema = schema.items as Record<string, unknown>;
    value.forEach((item, index) => {
      issues.push(...validateValue(itemSchema, item, `${path || '参数'}[${index}]`));
    });
  }

  return issues;
}

function matchType(type: string, value: unknown): boolean {
  switch (type) {
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return true;
  }
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
