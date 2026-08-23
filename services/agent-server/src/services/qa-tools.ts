import path from 'node:path';
import { access } from 'node:fs/promises';
import type { PermissionLevel, Tool, ToolContext, ToolResult } from '@personal-ai/tools';
import { runDshHeadless, type DshRunResult } from './coding-tool.js';

/**
 * qa.delegate：把测试/质量验收任务派给"小真"（专属 QA 工程师子代理）执行。
 * 与 designer.delegate 同构：工作区权限（workspace-write）同步驱动 dsh，
 * 调用后等待小真跑完并返回结构化报告（验收标准 / 测试执行 / 缺陷清单 /
 * PASS-FAIL 结论）。小真只做独立验收：跑 typecheck / 测试 / 构建 / 冒烟，
 * 产出证据化的缺陷清单——**发现缺陷不修复**，修复是小黑（工程师）的职责，
 * 这样验收方与实现方保持独立。
 */

export const XIAO_ZHEN_PROMPT = `你是"小真"，用户团队的专属测试/QA 工程师（QA Engineer）。你较真、挑剔、对事不对人；你只对质量负责，不给任何人面子——包括小黑。你的信条是："没有证据的'能用'，等于不能用。"小夜姐（私人助理/大脑）是你的监督者，你是她手下的质量守门人；你验收的对象主要是小黑（工程师）的交付与线上系统的真实状态。

人格：
- 较真：每个结论都要有工具执行结果做证据，绝不凭感觉说"应该没问题"。
- 挑剔：优先找出会伤害用户与系统的缺陷，其次才是风格瑕疵；不为找茬而找茬。
- 独立：你是验收方，不是实现方——发现缺陷只报告、不修复，修复是小黑的职责；你只允许新增/修改测试代码与测试报告，绝不改产品代码。
- 诚实：测试通过就明确说 PASS，不通过就明确说 FAIL 并给复现路径，不含糊其辞。

工作准则：
1. 验收标准先行：动手前先明确本次验收的标准是什么（需求描述/DESIGN_SPEC/回归基线），标准不明确时先在报告中列出你采用的标准。
2. 测试计划：列出要执行的检查项（typecheck / 单元测试 / 构建 / 冒烟 / 关键路径手工验证），按风险排序。
3. 执行留痕：每个检查项都必须真实执行并记录命令与输出摘要；跑不了的项目标注"未执行+原因"，不得假装跑过。
4. 缺陷清单：每个缺陷给出——严重度（S1 阻断 / S2 严重 / S3 一般 / S4 建议）、复现路径、证据（命令输出/文件行号）、影响范围；没有缺陷就明确写"未发现"。
5. 回归意识：修复后的再次验收要覆盖原缺陷 + 周边受影响路径，防止按下葫芦浮起瓢。
6. 边界：只读产品代码，只写测试与报告；发现环境/部署问题移交小优，发现设计问题移交小美，发现实现缺陷移交小黑。
7. 输出结构化报告（严格按此格式）：
   【目标】一句话说明本次验收目标
   【验收标准】本次采用的标准与来源
   【测试执行】逐项检查（命令/结果摘要/PASS-FAIL）
   【缺陷清单】严重度/复现路径/证据/影响（无缺陷则写"未发现"）
   【结论】PASS 或 FAIL（FAIL 必须指明阻断项）
   【风险与建议】未覆盖的风险、建议补充的测试
   报告与断言区分"已确认（有工具结果依据）"与"疑似/推断（未验证假设）"，不夸大结论。`;

/** 把用户需求包装成给小真的标准任务单 */
export function buildXiaoZhenTask(userRequest: string): string {
  return `${XIAO_ZHEN_PROMPT}

## 本次任务（来自小夜姐）

${userRequest.trim()}

请按上述工作准则执行，完成后输出结构化报告。`;
}

interface QaInput {
  task?: string;
  directory?: string;
  timeoutMinutes?: number;
}

/**
 * qa.delegate（同步版）：把测试/质量验收任务派给"小真"（专属 QA 工程师
 * 子代理）执行。小真以工作区权限（workspace-write）驱动 dsh 跑
 * typecheck/测试/构建/冒烟，返回证据化的验收报告与缺陷清单。
 * permissionLevel=1：只读产品代码 + 写测试与报告，无系统级破坏性操作。
 */
export function createQaTool(): Tool {
  return {
    name: 'qa.delegate',
    description:
      '把测试/质量验收任务派给"小真"（专属 QA 工程师子代理）执行：' +
      '验收标准梳理、测试计划、typecheck/单元测试/构建/冒烟执行、缺陷清单、回归验证。' +
      '小真较真挑剔、证据驱动，是独立的质量守门人：发现缺陷只报告不修复（修复归小黑），' +
      '只允许新增/修改测试代码与测试报告，绝不改产品代码。由助理（小夜）作为监督者调用。' +
      '这是同步任务：调用后等待小真跑完（通常数分钟），直接返回结构化报告（结论 PASS/FAIL）。' +
      'directory 用 /app 等持久目录。' +
      '轻量问题（查文件、看状态）不要用此工具，用 filesystem / terminal 等轻量工具。',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '要小真验收的任务描述（验收对象与标准，越具体越好）' },
        directory: {
          type: 'string',
          description: '工作目录绝对路径，默认 /app（bind mount 持久目录）',
        },
        timeoutMinutes: {
          type: 'number',
          minimum: 1,
          maximum: 60,
          description: '等待上限（分钟），默认 20',
        },
      },
      required: ['task'],
    },
    permissionLevel: 1 as PermissionLevel,
    timeoutMs: 60 * 60 * 1000,
    async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
      const { task, directory = '/app', timeoutMinutes = 20 } = (input ?? {}) as QaInput;
      if (!task?.trim()) {
        return { ok: false, error: '缺少 task 参数' };
      }
      const resolvedDir = path.resolve(directory);
      try {
        await access(resolvedDir);
      } catch {
        return { ok: false, error: `目录不存在：${resolvedDir}` };
      }
      if (task.trim().length > 20_000) {
        return { ok: false, error: '任务文本超过 20000 字符，请拆分任务后重试' };
      }
      const timeoutMs = Math.min(Math.max(1, Math.floor(timeoutMinutes)), 60) * 60 * 1000;
      let run: DshRunResult;
      try {
        run = await runDshHeadless(buildXiaoZhenTask(task.trim()), {
          cwd: resolvedDir,
          timeoutMs,
          // 小真跑测试/写报告：工作区权限即可，不触达系统级操作。
          permissionMode: 'workspace-write',
          signal: context.signal,
        });
      } catch (error) {
        return {
          ok: false,
          error: `小真派单启动失败：${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const { stdout, stderr, timedOut, exitCode } = run;
      if (timedOut) {
        return {
          ok: false,
          error: `小真执行超过 ${Math.round(timeoutMs / 60_000)} 分钟被终止`,
        };
      }
      if (exitCode !== 0) {
        return {
          ok: false,
          error: `小真执行失败（exit ${exitCode}）：${(stderr.trim() || stdout.trim()).slice(0, 2000)}`,
        };
      }
      return {
        ok: true,
        data: {
          text: (stdout.trim() || stderr.trim()).slice(0, 40_000),
          backend: 'dsh',
        },
      };
    },
  };
}
