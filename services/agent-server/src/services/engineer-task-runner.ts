import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { TimelineStore } from '@personal-ai/memory';
import {
  runDshHeadless,
  type DshRunResult,
  type RunDshOptions,
} from './coding-tool.js';

/**
 * 小黑异步任务执行器（OpenClaw background-process 思路 + 本地 FileJobManager
 * 经验）：engineer.delegate 只负责"创建任务并立即返回"，dsh 在后台独立运行，
 * 输出流式解析成进度事件，完成/失败通过事件推送到微信等渠道。这样小夜
 * 派完单就能继续陪用户聊天，不再被 15 分钟的子进程同步阻塞。
 */

export const XIAO_HEI_PROMPT = `你是"小黑"，用户团队的专属工程师。你办事专业、严肃、可靠，不闲聊、不卖萌，只对工程质量负责。

工作准则：
1. 先理解需求，用一句话向"监督者"确认本次目标（goal）；然后阅读相关代码与测试。改动涉及多文件或高风险（L2+）时，先输出方案（改动清单、影响面、回滚点、需复用的现有实现、验证方式）经监督者确认后再动手（Plan/Act 分离）；方案确认前不修改任何文件（规划期只读硬约束）。
2. 动手前记录 git 基线（git rev-parse HEAD）作为回滚快照；执行中在关键节点留快照，可回退到最近一步而非只能回起点。
3. 小步实现、可回滚；一次只做一个目标，禁止在失败路径上叠加大改。质量门前移：每完成一小步改动立即跑相关测试/typecheck，失败先自修再继续，不把错误攒到任务终点。
4. 错误自愈协议：失败时先自愈一次（分析错误 → 修复 → 重跑），仍失败才停止并报告；每一步断言都以工具结果为依据，不编造。
5. 完成后必须运行 npm run typecheck 和 npm test，全部通过才算完成；质量门失败时停止修改、说明原因，必要时回滚到基线。
6. 输出结构化报告（严格按此格式）：
   【目标】一句话说明本次任务目标
   【改动清单】每个文件：路径 + 改了什么（新增/修改/删除）
   【验证结果】typecheck 结果、测试结果（通过数/失败数）
   【风险与建议】遗留风险、下一步建议
7. 不修改密钥、凭证、数据库连接串等敏感配置；不执行破坏性命令。破坏性/永久操作（删除、覆盖、批量变更）即使任务明确要求，也须在方案中显式标注"永久/不可恢复"并预留回滚点；错误自愈不得绕过安全边界（安全约束优先于自愈）。
8. 任务完成后把可复用的经验（踩坑、模式、结论）沉淀到 xiaohei/learnings.md 长期记忆，形成跨任务记忆闭环；已有沉淀不重复记录。`;

/** 把用户需求包装成给小黑的标准任务单 */
export function buildXiaoHeiTask(userRequest: string): string {
  return `${XIAO_HEI_PROMPT}

## 本次任务（来自监督者）

${userRequest.trim()}

请按上述工作准则执行，完成后输出结构化报告。`;
}

export type EngineerTaskStatus = 'running' | 'success' | 'failed' | 'timeout';

export interface EngineerTask {
  id: string;
  task: string;
  directory: string;
  status: EngineerTaskStatus;
  createdAt: string;
  startedAt: string;
  finishedAt?: string;
  /** 最近一次进度提示（最后一行有意义的输出）。 */
  progress?: string;
  /** 累计输出（截断保存，供查询/复盘）。 */
  output: string;
  /** 累计输出超过上限被截断（grok-build 思路：一旦置 true 不再回退）。 */
  truncated?: boolean;
  /** 成功时的结构化报告（截断）。 */
  result?: string;
  /** 失败/超时原因。 */
  error?: string;
  exitCode?: number;
}

export interface EngineerTaskEvent {
  type: 'started' | 'progress' | 'done';
  taskId: string;
  status: EngineerTaskStatus;
  text?: string;
  result?: string;
  error?: string;
}

export type RunTaskFn = (taskText: string, options: RunDshOptions) => Promise<DshRunResult>;

export interface EngineerTaskRunnerOptions {
  timeline?: TimelineStore;
  /** 持久化目录（任务记录存 JSON 文件，重启后可查询结果）。默认 ./data/engineer-tasks。 */
  persistDir?: string;
  /** 进度事件最小间隔（毫秒），默认 20s，防止刷屏。 */
  progressIntervalMs?: number;
  /** dsh 累计输出保留上限（字符），默认 20_000。 */
  outputCap?: number;
  /** 测试注入用；默认跑真实 dsh。 */
  runTask?: RunTaskFn;
}

/** 从累计输出里提取"最后一行有意义的进度"（去掉空行/纯分隔）。 */
export function lastMeaningfulLine(output: string): string | undefined {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^[-=#*_]{3,}$/.test(line));
  return lines.at(-1)?.slice(0, 120);
}

/** 追加输出并截断保留尾部（保留最近内容，防止无限膨胀）。 */
export function appendCapped(current: string, chunk: string, cap: number): string {
  const next = current + chunk;
  if (next.length <= cap) return next;
  return next.slice(-cap);
}

export class EngineerTaskRunner {
  readonly #tasks = new Map<string, EngineerTask>();
  readonly #listeners = new Set<(event: EngineerTaskEvent) => void>();
  readonly #timeline?: TimelineStore;
  readonly #persistFile?: string;
  readonly #progressIntervalMs: number;
  readonly #outputCap: number;
  readonly #runTask: RunTaskFn;

  constructor(options: EngineerTaskRunnerOptions = {}) {
    this.#timeline = options.timeline;
    this.#progressIntervalMs = options.progressIntervalMs ?? 20_000;
    this.#outputCap = options.outputCap ?? 20_000;
    this.#runTask = options.runTask ?? runDshHeadless;
    if (options.persistDir) {
      this.#persistFile = path.join(options.persistDir, 'engineer-tasks.json');
    }
  }

  /** 启动时加载已持久化的任务记录（完成/失败的结果在重启后仍可查询）。 */
  async loadPersisted(): Promise<void> {
    if (!this.#persistFile) return;
    try {
      const raw = await readFile(this.#persistFile, 'utf8');
      const records = JSON.parse(raw) as EngineerTask[];
      for (const record of records) {
        if (record?.id && record.status !== 'running') {
          this.#tasks.set(record.id, record);
        }
      }
    } catch {
      // 文件不存在或损坏：从空任务表开始，不阻塞启动
    }
  }

  onEvent(listener: (event: EngineerTaskEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get(id: string): EngineerTask | undefined {
    return this.#tasks.get(id);
  }

  list(limit = 10): EngineerTask[] {
    return [...this.#tasks.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(1, Math.floor(limit)));
  }

  /** 异步派单：立即返回运行中任务，dsh 在后台执行（不再阻塞对话）。 */
  async delegate(
    task: string,
    options: { directory?: string; timeoutMinutes?: number } = {},
  ): Promise<EngineerTask> {
    const directory = path.resolve(options.directory ?? '/app');
    const timeoutMinutes = Math.min(Math.max(1, Math.floor(options.timeoutMinutes ?? 15)), 60);
    const record: EngineerTask = {
      id: randomUUID(),
      task: task.trim(),
      directory,
      status: 'running',
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      output: '',
    };
    this.#tasks.set(record.id, record);
    void this.#persist();
    this.#emit({
      type: 'started',
      taskId: record.id,
      status: 'running',
      text: '小黑已开工，正在执行任务',
    });
    void this.#run(record, timeoutMinutes);
    return record;
  }

  async #run(task: EngineerTask, timeoutMinutes: number): Promise<void> {
    const taskText = buildXiaoHeiTask(task.task);
    let lastProgressAt = 0;
    const onData: RunDshOptions['onData'] = (chunk) => {
      if (task.output.length + chunk.length > this.#outputCap) {
        task.truncated = true;
      }
      task.output = appendCapped(task.output, chunk, this.#outputCap);
      const line = lastMeaningfulLine(task.output);
      if (line) {
        task.progress = line;
        const now = Date.now();
        if (now - lastProgressAt >= this.#progressIntervalMs) {
          lastProgressAt = now;
          this.#emit({
            type: 'progress',
            taskId: task.id,
            status: 'running',
            text: line,
          });
        }
      }
    };

    const timeoutMs = timeoutMinutes * 60 * 1000;
    let result: DshRunResult;
    try {
      result = await this.#runTask(taskText, {
        cwd: task.directory,
        timeoutMs,
        permissionMode: 'workspace-write',
        onData,
      });
    } catch (error) {
      this.#finish(task, {
        status: 'failed',
        error: `启动小黑失败：${error instanceof Error ? error.message : String(error)}`,
        exitCode: 1,
      });
      return;
    }

    if (result.killed && result.exitCode === 124) {
      this.#finish(task, {
        status: 'timeout',
        error: `小黑执行超过 ${timeoutMinutes} 分钟被终止`,
        exitCode: 124,
      });
      return;
    }
    if (result.killed || result.exitCode !== 0) {
      this.#finish(task, {
        status: 'failed',
        error: `小黑执行失败（exit ${result.exitCode}）：${(result.stderr.trim() || result.stdout.trim()).slice(0, 2000)}`,
        exitCode: result.exitCode,
      });
      return;
    }
    this.#finish(task, {
      status: 'success',
      result: (result.stdout.trim() || result.stderr.trim()).slice(0, 40_000),
      exitCode: result.exitCode,
    });
  }

  #finish(
    task: EngineerTask,
    outcome: { status: 'success' | 'failed' | 'timeout'; result?: string; error?: string; exitCode?: number },
  ): void {
    task.status = outcome.status;
    task.finishedAt = new Date().toISOString();
    if (outcome.result !== undefined) task.result = outcome.result;
    if (outcome.error !== undefined) task.error = outcome.error;
    if (outcome.exitCode !== undefined) task.exitCode = outcome.exitCode;
    void this.#persist();
    void this.#timeline?.addEvent({
      type: 'task',
      summary:
        outcome.status === 'success'
          ? `小黑任务完成（${task.id.slice(0, 8)}）：${task.task.slice(0, 80)}`
          : `小黑任务${outcome.status === 'timeout' ? '超时' : '失败'}（${task.id.slice(0, 8)}）：${task.task.slice(0, 80)}`,
      metadata: { engineerTaskId: task.id, status: outcome.status },
    });
    this.#emit({
      type: 'done',
      taskId: task.id,
      status: outcome.status,
      ...(outcome.result ? { result: outcome.result } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
    });
  }

  #emit(event: EngineerTaskEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // 单个订阅者出错不影响其他
      }
    }
  }

  async #persist(): Promise<void> {
    if (!this.#persistFile) return;
    try {
      await mkdir(path.dirname(this.#persistFile), { recursive: true });
      const records = [...this.#tasks.values()].slice(-50);
      await writeFile(this.#persistFile, JSON.stringify(records, null, 2), 'utf8');
    } catch {
      // 持久化失败不致命：任务仍可运行/查询，只是重启后丢失记录
    }
  }
}
