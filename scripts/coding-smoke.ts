import { loadConfig } from '@personal-ai/config';

const config = loadConfig();
const base = `http://127.0.0.1:${config.port}`;
const headers = { 'content-type': 'application/json' };

const session = (await fetch(`${base}/api/sessions`, {
  method: 'POST',
  headers,
  body: '{}',
}).then((r) => r.json())) as { id: string };
console.log(`session=${session.id}`);

const response = await fetch(`${base}/api/sessions/${session.id}/chat`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    message:
      '用 coding.run 工具（dsh 后端），在 E:\\Promise_ai 目录只回答一个问题：这个项目的前端界面是用什么技术做的？',
  }),
});
if (!response.ok || !response.body) {
  throw new Error(`chat failed: ${response.status}`);
}

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
let text = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  let index: number;
  while ((index = buffer.indexOf('\n\n')) !== -1) {
    const block = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 2);
    if (!block.startsWith('data: ')) continue;
    const event = JSON.parse(block.slice(6)) as { type: string; payload: unknown };
    if (event.type === 'chat.token') {
      text += (event.payload as { delta: string }).delta;
      process.stdout.write((event.payload as { delta: string }).delta);
    } else if (event.type === 'permission.request') {
      const request = (event.payload as { request: { requestId: string; toolName: string } })
        .request;
      console.log(`\n>>> 需要确认：${request.toolName}，自动批准`);
      await fetch(`${base}/api/sessions/${session.id}/permission`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ requestId: request.requestId, approved: true }),
      });
    } else if (event.type === 'agent.tool_result') {
      const payload = event.payload as {
        name: string;
        result: { ok: boolean; data?: { text?: string; sessionId?: string }; error?: string };
      };
      console.log(
        `\n>>> 工具结果 [${payload.name}] ok=${payload.result.ok} sessionId=${payload.result.data?.sessionId ?? '-'}`,
      );
      console.log(`>>> ${(payload.result.data?.text ?? payload.result.error ?? '').slice(0, 500)}`);
    } else if (event.type === 'chat.error' || event.type === 'voice.error') {
      console.log(`\n!!! ${JSON.stringify(event.payload)}`);
    }
  }
}

console.log(`\n--- 最终回复 ---\n${text}`);
