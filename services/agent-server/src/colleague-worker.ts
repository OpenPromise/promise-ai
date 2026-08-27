/**
 * 同事信箱子进程入口：只跑 COLLEAGUE_ID 这一人的 mailbox worker。
 * 不监听 :3000。ConversationService / tools / postgres 与父进程同环境。
 */
import { parseColleagueId } from './services/colleague-office.js';
import { createAgentCore } from './agent-core.js';

const colleagueId = parseColleagueId(process.env.COLLEAGUE_ID ?? '');
if (!colleagueId) {
  console.error(
    `[colleague-worker] COLLEAGUE_ID 无效或缺失（got ${JSON.stringify(process.env.COLLEAGUE_ID)}）`,
  );
  process.exit(1);
}

const core = await createAgentCore({ role: 'worker', colleagueId });
const sessionId = core.colleagueOffice.getSessionId(colleagueId);
console.log(
  `[colleague-worker] ${colleagueId} ready session=${sessionId?.slice(0, 8) ?? 'none'} pid=${process.pid}`,
);

const shutdown = async (signal: string): Promise<void> => {
  console.log(`[colleague-worker] ${colleagueId} shutting down ${signal}`);
  await core.colleagueOffice.closeAndWait(2_000);
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  console.error(`[colleague-worker] ${colleagueId} unhandledRejection:`, reason);
});
process.on('uncaughtException', (error) => {
  console.error(`[colleague-worker] ${colleagueId} uncaughtException:`, error);
});
