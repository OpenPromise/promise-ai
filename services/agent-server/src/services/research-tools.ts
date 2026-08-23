import path from 'node:path';
import { access } from 'node:fs/promises';
import type { PermissionLevel, Tool, ToolContext, ToolResult } from '@personal-ai/tools';
import { runDshHeadless, type DshRunResult } from './coding-tool.js';

/**
 * research.delegate：把研究/调研/情报任务派给"小知"（专属研究员/情报官
 * 子代理）执行。与 designer.delegate 同构：工作区权限（workspace-write）
 * 同步驱动 dsh，调用后等待小知跑完并返回结构化简报（结论先行/证据与来源/
 * 置信度/未验证假设）。小知的产出沉淀到 /app/xiaozhi/ 知识库，可直接
 * 供养官网"情报"板块与团队决策。
 */

export const XIAO_ZHI_PROMPT = `你是"小知"，用户团队的专属研究员/情报官（Researcher & Intelligence）。你温和、好奇、严谨；你负责技术调研、竞品与开源项目分析、模型与接口变更跟踪、以及团队对外情报内容的产出。你的信条是："先看清世界，再动手改变它。"小夜姐（私人助理/大脑）是你的监督者，你是她手下的研究员；你的简报是 CEO 决策、小黑选型、团队学习的依据。

人格：
- 好奇但不轻信：每个结论都标注来源与置信度，交叉验证后才写进结论。
- 结论先行：先给一句话答案，再展开证据——读者没时间从头看起。
- 诚实标注边界：查不到、不确定、样本太少，就明确写出来；绝不把推断包装成事实。
- 沉淀强迫症：一次研究的产出必须落成文档，让下一次不用从零开始。

工作准则：
1. 先明确问题：把模糊的调研需求改写成 1-3 个可回答的具体问题，写在简报开头。
2. 材料收集：优先项目内一手材料（代码/文档/日志/配置），其次公开资料；引用时给出路径或出处。
3. 交叉验证：关键结论至少两个独立来源；单一来源的结论标注"单源，待验证"。
4. 架构参考纪律：遵守 AGENTS.md——参考开源项目只吸收设计思想，不建议复制代码。
5. 知识沉淀：调研产出写入 /app/xiaozhi/ 下的知识库（按主题建 md 文件），已有文档就增量更新，不重复建档。
6. 情报供给：适合对外的内容（团队动态/技术里程碑）单独整理成可发布的情报条目，注明"可发布"。
7. 边界：你只读代码、只写研究文档与知识库；不改产品代码、不做部署（归小优）、不做实现（归小黑）。
8. 输出结构化简报（严格按此格式）：
   【问题】本次要回答的 1-3 个具体问题
   【结论】每个问题一句话答案（结论先行）
   【证据与来源】逐条列出，标注路径/出处
   【置信度】高/中/低，并说明理由
   【未验证假设】明确列出推断与待验证项
   【沉淀位置】本次产出写入的知识库文件
   【建议下一步】给 CEO/小夜的行动建议
   简报中区分"已确认（有依据）"与"疑似/推断（未验证假设）"，不夸大结论。`;

/** 把用户需求包装成给小知的标准任务单 */
export function buildXiaoZhiTask(userRequest: string): string {
  return `${XIAO_ZHI_PROMPT}

## 本次任务（来自小夜姐）

${userRequest.trim()}

请按上述工作准则执行，完成后输出结构化简报。`;
}

interface ResearchInput {
  task?: string;
  directory?: string;
  timeoutMinutes?: number;
}

/**
 * research.delegate（同步版）：把研究/调研/情报任务派给"小知"（专属
 * 研究员/情报官子代理）执行。小知以工作区权限（workspace-write）驱动 dsh
 * 阅读材料并产出结构化简报，沉淀到 /app/xiaozhi/ 知识库。
 * permissionLevel=1：只读代码 + 写研究文档，无系统级破坏性操作。
 */
export function createResearchTool(): Tool {
  return {
    name: 'research.delegate',
    description:
      '把研究/调研/情报任务派给"小知"（专属研究员/情报官子代理）执行：' +
      '技术调研、竞品与开源项目分析、模型与接口变更跟踪、对外情报内容产出。' +
      '小知温和严谨、结论先行、逢结论必标来源与置信度，产出沉淀到 /app/xiaozhi/ 知识库。' +
      '她只读代码、只写研究文档：不改产品代码（归小黑）、不做部署（归小优）。' +
      '由助理（小夜）作为监督者调用。' +
      '这是同步任务：调用后等待小知跑完（通常数分钟），直接返回结构化简报。' +
      'directory 用 /app 等持久目录。' +
      '轻量问题（查文件、看状态）不要用此工具，用 filesystem / terminal 等轻量工具。',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '要小知调研的问题或主题（越具体越好）' },
        directory: {
          type: 'string',
          description: '工作目录绝对路径，默认 /app（bind mount 持久目录）',
        },
        timeoutMinutes: {
          type: 'number',
          minimum: 1,
          maximum: 60,
          description: '等待上限（分钟），默认 15',
        },
      },
      required: ['task'],
    },
    permissionLevel: 1 as PermissionLevel,
    timeoutMs: 60 * 60 * 1000,
    async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
      const { task, directory = '/app', timeoutMinutes = 15 } = (input ?? {}) as ResearchInput;
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
        run = await runDshHeadless(buildXiaoZhiTask(task.trim()), {
          cwd: resolvedDir,
          timeoutMs,
          // 小知读材料/写知识库：工作区权限即可，不触达系统级操作。
          permissionMode: 'workspace-write',
          signal: context.signal,
        });
      } catch (error) {
        return {
          ok: false,
          error: `小知派单启动失败：${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const { stdout, stderr, timedOut, exitCode } = run;
      if (timedOut) {
        return {
          ok: false,
          error: `小知执行超过 ${Math.round(timeoutMs / 60_000)} 分钟被终止`,
        };
      }
      if (exitCode !== 0) {
        return {
          ok: false,
          error: `小知执行失败（exit ${exitCode}）：${(stderr.trim() || stdout.trim()).slice(0, 2000)}`,
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
