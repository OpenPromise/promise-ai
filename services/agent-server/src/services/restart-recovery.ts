import type { SessionStore } from '@personal-ai/memory';
import type { ChatMessage } from '@personal-ai/types';

export const RESTART_RECOVERY_MARKER = '服务在工具执行期间重启';
export const RESTART_RECOVERY_NOTE =
  '[系统] 服务在工具执行期间重启，上一次任务被中断。请告知用户任务已中断，并在必要时请用户重新发起。';

/**
 * 统计会话中"有 assistant tool_calls 但缺对应 tool result"的悬空调用数。
 * 悬空调用通常意味着该轮任务在工具执行时被服务重启打断（OpenCrabs 重启恢复上报思路）。
 */
export function countDanglingToolCalls(messages: ChatMessage[]): number {
  const pendingIds = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant' && message.toolCalls) {
      for (const call of message.toolCalls) pendingIds.add(call.id);
    } else if (message.role === 'tool' && message.toolCallId) {
      pendingIds.delete(message.toolCallId);
    }
  }
  return pendingIds.size;
}

export interface RecoverInterruptedSessionsOptions {
  /** 只检查最近 N 分钟内更新过的会话（默认 24 小时）。 */
  recentMinutes?: number;
  now?: Date;
}

/**
 * 启动恢复：扫描最近会话，为存在中断工具调用的会话注入一条系统提示，
 * 让下一轮对话知道任务曾被服务重启打断（幂等：已注入过的会话跳过）。
 */
export async function recoverInterruptedSessions(
  store: SessionStore,
  options: RecoverInterruptedSessionsOptions = {},
): Promise<{ recovered: number; sessionIds: string[] }> {
  const now = options.now ?? new Date();
  const recentMinutes = options.recentMinutes ?? 24 * 60;
  const cutoff = now.getTime() - recentMinutes * 60_000;
  const sessionIds: string[] = [];

  const sessions = await store.listSessions();
  for (const session of sessions) {
    if (new Date(session.updatedAt).getTime() < cutoff) continue;
    if (countDanglingToolCalls(session.messages) === 0) continue;
    const alreadyNoted = session.messages.some(
      (message) => message.role === 'system' && message.content.includes(RESTART_RECOVERY_MARKER),
    );
    if (alreadyNoted) continue;
    await store.addMessage(session.id, { role: 'system', content: RESTART_RECOVERY_NOTE });
    sessionIds.push(session.id);
  }

  return { recovered: sessionIds.length, sessionIds };
}
