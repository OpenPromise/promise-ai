import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

/**
 * Interactive voice demo against a running agent-server.
 *
 *   npx tsx scripts/voice-demo.ts          # full STT -> LLM -> TTS round trip
 *   npx tsx scripts/voice-demo.ts --interrupt   # interrupt right after the agent starts
 *
 * The agent's spoken reply is saved to scripts/out/voice-demo-reply.mp3.
 */

const baseUrl = process.env.AGENT_URL ?? 'http://127.0.0.1:3000';
const wsBase = process.env.AGENT_WS_URL ?? 'ws://127.0.0.1:3000';
const doInterrupt = process.argv.includes('--interrupt');

const sessionResponse = await fetch(`${baseUrl}/api/sessions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({}),
});
if (!sessionResponse.ok) {
  console.error(`无法创建会话：HTTP ${sessionResponse.status}`);
  process.exit(1);
}
const session = (await sessionResponse.json()) as { id: string };
console.log(`会话已创建：${session.id}`);

const pcm = await readFile(path.join(import.meta.dirname, 'out', 'sample.pcm'));
const silence = Buffer.alloc(16000 * 2 * 2);
const audio = Buffer.concat([pcm, silence]);

const ws = new WebSocket(`${wsBase}/ws/voice/${session.id}`);
const audioChunks: Buffer[] = [];
const events: string[] = [];
let interrupted = false;

const timer = setTimeout(() => {
  console.error('超时：60 秒内未完成');
  ws.close();
  process.exit(2);
}, 60000);

ws.on('message', async (data, isBinary) => {
  if (isBinary) return;
  const message = JSON.parse(data.toString()) as {
    type?: string;
    payload?: { text?: string; data?: string };
  };
  const type = message.type ?? '';
  const payload = message.payload ?? {};

  if (type === 'audio.chunk') {
    audioChunks.push(Buffer.from(payload.data ?? '', 'base64'));
    return;
  }

  events.push(type);
  const text = typeof payload.text === 'string' ? payload.text : '';

  switch (type) {
    case 'voice.ready':
      console.log('语音连接就绪，发送音频…');
      {
        let offset = 0;
        const sendNext = (): void => {
          if (offset >= audio.length) return;
          ws.send(audio.subarray(offset, offset + 3200));
          offset += 3200;
          setTimeout(sendNext, 40);
        };
        sendNext();
      }
      break;
    case 'transcript.partial':
      console.log(`  听到（实时）：${text}`);
      break;
    case 'transcript.final':
      console.log(`  你说了：${text}`);
      break;
    case 'agent.thinking':
      console.log('  AI 思考中…');
      if (doInterrupt) {
        console.log('  发送 interrupt…');
        ws.send(JSON.stringify({ type: 'interrupt' }));
      }
      break;
    case 'tts.start':
      console.log(`  开始说话：${text}`);
      break;
    case 'tts.end':
      console.log(`  说完了（完整回复）：${text}`);
      break;
    case 'tts.interrupted':
      interrupted = true;
      console.log(`  已打断（原因：${(payload as { reason?: string }).reason}）`);
      break;
    case 'agent.done':
      console.log('  AI 回复完成');
      break;
    case 'voice.error':
      console.error(`  语音错误：${text}`);
      break;
  }

  if (type === 'tts.end' || (interrupted && type === 'tts.interrupted')) {
    clearTimeout(timer);
    const totalBytes = Buffer.concat(audioChunks).length;
    if (totalBytes > 0) {
      const outDir = path.join(import.meta.dirname, 'out');
      await mkdir(outDir, { recursive: true });
      const outFile = path.join(
        outDir,
        doInterrupt ? 'voice-demo-interrupted.mp3' : 'voice-demo-reply.mp3',
      );
      await writeFile(outFile, Buffer.concat(audioChunks));
      console.log(
        `\nAI 语音已保存：${outFile}（${audioChunks.length} 个音频块，${totalBytes} 字节）`,
      );
    } else {
      console.log('\n（打断时 AI 尚未开始说话，没有生成音频文件）');
    }
    console.log(`事件流：${events.join(' → ')}`);
    ws.close();
    process.exit(0);
  }
});

ws.on('error', (error) => {
  console.error(`WebSocket 错误：${error.message}`);
  process.exit(3);
});
