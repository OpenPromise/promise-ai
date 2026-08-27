import type { ColleagueId } from './colleague-office.js';
import type { ColleagueTaskEvent } from './colleague-task-runner.js';

/** 子进程发给父进程的进度/完成（父进程再跑 wrap-up + SSE）。 */
export type ColleagueChildEvent = ColleagueTaskEvent & {
  mailId?: string;
  colleagueId?: ColleagueId;
};

export async function publishColleagueEvent(event: ColleagueChildEvent): Promise<void> {
  const base = (process.env.AGENT_INTERNAL_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
  const token = process.env.AGENT_API_TOKEN?.trim();
  try {
    const response = await fetch(`${base}/api/internal/colleague-events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      console.warn(
        `[colleagues] internal event ${event.type} task=${event.taskId.slice(0, 8)} → HTTP ${response.status}`,
      );
    }
  } catch (error) {
    console.warn(
      `[colleagues] internal event ${event.type} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
