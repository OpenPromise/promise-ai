import path from 'node:path';
import { access } from 'node:fs/promises';
import type { PermissionLevel, Tool, ToolContext, ToolResult } from '@personal-ai/tools';
import { runDshHeadless, type DshRunResult } from './coding-tool.js';

const XIAO_MEI_DSH_PATCH =
  process.env.XIAOMEI_DSH_PATCH ??
  path.resolve(process.cwd(), 'infrastructure/dsh/xiaomei-openai.patch.yml');
const XIAO_MEI_OPENAI_MODEL = process.env.XIAOMEI_OPENAI_MODEL ?? 'gpt-4.1';

/**
 * designer.delegate：把产品设计/UX/UI/视觉设计任务派给"小美"（专属
 * Product/UI/Visual Designer 子代理）执行。与 engineer.delegate（异步派单）、
 * ops.delegate（全权限）不同：小美以工作区权限（workspace-write）同步驱动 dsh，
 * 调用后等待小美跑完并返回结构化报告（UX 分析 / 视觉方向 / DESIGN_SPEC /
 * Visual QA 结果）。小美的产出是给小黑开发的机器可读契约 DESIGN_SPEC，
 * 不是"一张图片了事"。
 */

export const XIAO_MEI_PROMPT = `你是"小美"，用户团队的专属产品/UI/视觉设计师（Product/UI/Visual Designer）。你冷静、专业、有主见，审美在线但从不炫技；你负责产品设计、UX、UI、视觉设计、Design System、Figma 操作与视觉质量检查。你不是"网页 UI 生成器"，而是真正参与产品设计决策的专业 Agent——你的信条是："好设计不是'看起来漂亮'，而是让用户自然地完成任务。"小夜姐（私人助理/大脑）是你的监督者，你是她手下的设计师；你的产出 DESIGN_SPEC 是给小黑（工程师）的开发依据。

人格：
- 先理解产品，再动手设计；不为了炫技增加任何无意义的视觉效果。
- 用户任务优先：界面上的每个元素都要回答"它帮用户完成了什么"。
- 重视信息层级、一致性、可用性，不盲目追求"高级感"。
- 有主见：能主动指出产品设计问题，能否定不合理需求，能提出多个设计方向，能解释每个设计决策，能根据反馈持续迭代。

工作准则：
1. UX 先行：动手设计前先回答——用户是谁？核心任务是什么？最常用什么功能？什么信息常驻/隐藏？完成核心任务需要几步？输出简短的 UX 分析。
2. 视觉方向：明确色彩/字体/字号/字重/间距/Grid/Border/Radius/Shadow/Icon/动效的取舍理由；每次项目不重新发明视觉语言，先查 Design System。
3. Design System 优先：读取/复用已有设计系统；没有则建立；检查页面是否违反 Design System 规范。
4. 输出 DESIGN_SPEC（机器可读契约给小黑）：Page / Viewport / Components / Design Tokens（--color-primary 等 CSS 变量）/ Interactions / Responsive / Assets / Accessibility，逐项写清楚，不丢给小黑一张图片了事。
5. Visual QA：设计完成后用视觉检查逐项核对（视觉层级/间距/字体/颜色/对比度/布局/对齐/一致性/响应式/可访问性/信息密度/CTA 突出/视觉噪音），发现问题生成问题列表，迭代到通过。
6. 与小黑协作：以 DESIGN_SPEC 为开发依据，明确每个组件的行为与状态；小黑实现后做 Visual QA，PASS/FAIL 都要给证据。
7. 权限边界：L0 读取（Design System/Figma/项目/参考）免确认；L1 创建（页面/Design System/Spec/文档）自动执行；L2 修改生产设计需确认；L3 删大量资产/改品牌核心规范/改生产代码必须人工确认。
8. 输出结构化报告（严格按此格式）：
   【目标】一句话说明本次任务目标
   【UX 分析】用户/核心任务/常用功能/信息层级/完成步骤
   【视觉方向】色彩/字体/间距/圆角/阴影等取舍理由
   【DESIGN_SPEC】给小黑开发的机器可读契约
   【Visual QA 结果】逐项检查结果与问题迭代记录
   【风险与建议】遗留风险、下一步建议
   报告与断言区分"已确认（有工具结果依据）"与"疑似/推断（未验证假设）"，不夸大结论。`;

/** 把用户需求包装成给小美的标准任务单 */
export function buildXiaoMeiTask(userRequest: string): string {
  return `${XIAO_MEI_PROMPT}

## 本次任务（来自小夜姐）

${userRequest.trim()}

请按上述工作准则执行，完成后输出结构化报告。`;
}

interface DesignerInput {
  task?: string;
  directory?: string;
  timeoutMinutes?: number;
}

/**
 * designer.delegate（同步版）：把产品设计/UX/UI/视觉设计任务派给"小美"
 * （专属 Product/UI/Visual Designer 子代理）执行。小美以工作区权限
 * （workspace-write）驱动 dsh，调用后同步等待结果（30 秒到数分钟），
 * 返回结构化报告（UX 分析 / 视觉方向 / DESIGN_SPEC / Visual QA 结果）。
 */
export function createDesignerTool(): Tool {
  return {
    name: 'designer.delegate',
    description:
      '把产品设计/UX/UI/视觉设计任务派给"小美"（专属 Product/UI/Visual Designer 子代理）执行：' +
      '产品理解、UX 分析、信息架构、视觉方向、Design System、界面设计、Visual QA。' +
      '小美冷静专业不炫技，先理解产品再设计，输出机器可读契约 DESIGN_SPEC 给小黑（工程师）开发，' +
      '不是"网页 UI 生成器"。由助理（小夜）作为监督者调用。' +
      '这是同步任务：调用后等待小美跑完（通常 30 秒到数分钟），直接返回结构化报告。' +
      '小美以工作区权限（workspace-write）读写 /app 下的设计文档与 Design System，不改生产代码。' +
      '她使用独立的 OpenAI Provider 路由（需要 OPENAI_API_KEY），不会回退到 DeepSeek。' +
      'directory 用 /app 等持久目录。' +
      '轻量问题（查文件、看状态）不要用此工具，用 filesystem / terminal 等轻量工具。',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '要小美完成的设计任务描述（用户需求，越具体越好）' },
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
      const { task, directory = '/app', timeoutMinutes = 15 } = (input ?? {}) as DesignerInput;
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
      try {
        await access(XIAO_MEI_DSH_PATCH);
      } catch {
        return {
          ok: false,
          error: `小美 OpenAI 路由配置不存在：${XIAO_MEI_DSH_PATCH}`,
        };
      }
      const timeoutMs = Math.min(Math.max(1, Math.floor(timeoutMinutes)), 60) * 60 * 1000;
      let run: DshRunResult;
      try {
        run = await runDshHeadless(buildXiaoMeiTask(task.trim()), {
          cwd: resolvedDir,
          timeoutMs,
          // 小美只产出设计文档/Design System/Spec：工作区权限即可，不触达系统级操作。
          permissionMode: 'workspace-write',
          // 独立 patch 将 dsh 默认模型切到 OpenAI；不会改小夜主模型或小黑/小优。
          patchPath: XIAO_MEI_DSH_PATCH,
          signal: context.signal,
        });
      } catch (error) {
        return {
          ok: false,
          error: `小美派单启动失败：${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const { stdout, stderr, timedOut, exitCode } = run;
      if (timedOut) {
        return {
          ok: false,
          error: `小美执行超过 ${Math.round(timeoutMs / 60_000)} 分钟被终止`,
        };
      }
      if (exitCode !== 0) {
        return {
          ok: false,
          error: `小美执行失败（exit ${exitCode}）：${(stderr.trim() || stdout.trim()).slice(0, 2000)}`,
        };
      }
      return {
        ok: true,
        data: {
          text: (stdout.trim() || stderr.trim()).slice(0, 40_000),
          backend: 'dsh-pi-ai/openai',
          provider: 'openai',
          model: XIAO_MEI_OPENAI_MODEL,
        },
      };
    },
  };
}
