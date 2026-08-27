/**
 * 一次性派单：请小美 / 小真 / 小知用各自人格自述 + 主页设计意向。
 * 在容器内执行：npx tsx scripts/ask-self-brief.mts
 */
import { writeFile } from 'node:fs/promises';
import { ColleagueTaskRunner } from '../services/agent-server/src/services/colleague-task-runner.js';
import {
  createDesignerTool,
  XIAO_MEI_COLLEAGUE,
} from '../services/agent-server/src/services/designer-tools.js';
import { createQaTool, XIAO_ZHEN_COLLEAGUE } from '../services/agent-server/src/services/qa-tools.js';
import {
  createResearchTool,
  XIAO_ZHI_COLLEAGUE,
} from '../services/agent-server/src/services/research-tools.js';

const SHARED = `CEO 现在只问你两件事。这是你自己的声音，不要照抄建档代拟稿，不要改生产代码，不要改别人的主页。

1) 自我描述（必须用你自己的话）：
- 一句话定位
- 性格与说话方式
- 职责与边界
- 个人梦想（一句话）
- 给 doubao-seedream 用的中文形象提示词（半身立绘，≤300 字），必须是你此刻想出来的样子

2) 你的个人主页想做成什么样：
- 信息架构（有哪些区块、顺序）
- 视觉风格（颜色、字体气质、氛围、动效克制程度）
- 必须有的内容 / 坚决不要的内容
- 参考感觉可以用比喻，但不要抄现成网站

请把完整回答写入指定的 self-brief.md（Markdown）。报告正文也附上全文。`;

const designerRunner = new ColleagueTaskRunner(XIAO_MEI_COLLEAGUE);
const qaRunner = new ColleagueTaskRunner(XIAO_ZHEN_COLLEAGUE);
const researchRunner = new ColleagueTaskRunner(XIAO_ZHI_COLLEAGUE);

async function waitForTask(runner: ColleagueTaskRunner, taskId: string) {
  for (;;) {
    const record = runner.get(taskId);
    if (record && record.status !== 'running') return record;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

const jobs = [
  {
    name: '小美',
    file: '/app/xiaomei/self-brief.md',
    runner: designerRunner,
    tool: createDesignerTool(designerRunner),
    task: `${SHARED}

输出文件：/app/xiaomei/self-brief.md
你是设计师：主页方案请写到能直接当 DESIGN_SPEC 用（区块、tokens、状态）。`,
  },
  {
    name: '小真',
    file: '/app/xiaozhen/self-brief.md',
    runner: qaRunner,
    tool: createQaTool(qaRunner),
    task: `${SHARED}

输出文件：/app/xiaozhen/self-brief.md
你是 QA：可以像验收清单一样写主页方案，但人设必须是你自己的话，不是测试报告腔。`,
  },
  {
    name: '小知',
    file: '/app/xiaozhi/self-brief.md',
    runner: researchRunner,
    tool: createResearchTool(researchRunner),
    task: `${SHARED}

输出文件：/app/xiaozhi/self-brief.md
你是研究员：结论先行，但这次结论就是「我是谁」和「我的主页长什么样」。`,
  },
];

for (const job of jobs) {
  console.log(`\n===== 派单 ${job.name} =====`);
  const started = Date.now();
  const result = await job.tool.execute(
    { task: job.task, directory: '/app', timeoutMinutes: 25 },
    { sessionId: `self-brief-${job.name}` },
  );
  if (!result.ok) {
    const ms = Date.now() - started;
    const dump = `/app/data/${job.name}-self-brief-raw.txt`;
    await writeFile(dump, JSON.stringify(result, null, 2), 'utf8');
    console.log(`${job.name} ok=${result.ok} ${ms}ms raw=${dump}`);
    console.error(result.error);
    process.exitCode = 1;
    continue;
  }
  const taskId = (result.data as { taskId: string }).taskId;
  const record = await waitForTask(job.runner, taskId);
  const ms = Date.now() - started;
  const dump = `/app/data/${job.name}-self-brief-raw.txt`;
  await writeFile(dump, JSON.stringify({ ok: record.status === 'success', record }, null, 2), 'utf8');
  console.log(`${job.name} ok=${record.status === 'success'} ${ms}ms raw=${dump}`);
  if (record.status !== 'success') {
    console.error(record.error);
    process.exitCode = 1;
  }
}
console.log('\n全部派单结束');
