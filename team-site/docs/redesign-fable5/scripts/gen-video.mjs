// MiniMax H3 视频生成 V2（异步任务：创建 -> 轮询 -> 下载）
// 用法: node scripts/gen-video.mjs create <prompt文件> [首帧图片png]   -> 输出 TASK_ID=xxx
//       node scripts/gen-video.mjs poll <task_id> <输出mp4>
// 依赖环境变量 MINIMAX_API_KEY
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const apiKey = process.env.MINIMAX_API_KEY;
if (!apiKey) throw new Error('缺少 MINIMAX_API_KEY');
const BASE = 'https://api.minimaxi.com/v2';
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };

const [mode, ...args] = process.argv.slice(2);

if (mode === 'create') {
  const [promptFile, firstFrame] = args;
  const content = [{ type: 'text', text: readFileSync(promptFile, 'utf8').trim() }];
  const payload = { model: 'MiniMax-H3', content, resolution: '768P', duration: 10 };
  if (firstFrame) {
    const b64 = readFileSync(firstFrame).toString('base64');
    content.push({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${b64}` },
      role: 'first_frame',
    });
    // 图生视频：宽高比由首帧图片决定，不传 ratio
  } else {
    payload.ratio = '16:9'; // 文生视频必填且不能 adaptive
  }
  const res = await fetch(`${BASE}/video_generation`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  console.log(JSON.stringify(body).slice(0, 600));
  if (body.task_id) console.log(`TASK_ID=${body.task_id}`);
  else process.exit(1);
} else if (mode === 'poll') {
  const [taskId, outFile] = args;
  for (let i = 0; i < 180; i++) {
    const res = await fetch(`${BASE}/query/video_generation/${taskId}`, { headers });
    const body = await res.json();
    const status = body.task?.status ?? body.status;
    console.log(`[poll ${i}] status=${status}`);
    if (status === 'succeeded') {
      const url = body.task?.content?.url;
      if (!url) {
        console.error('无下载地址:', JSON.stringify(body).slice(0, 800));
        process.exit(1);
      }
      const vid = await fetch(url);
      const buf = Buffer.from(await vid.arrayBuffer());
      mkdirSync(dirname(outFile), { recursive: true });
      writeFileSync(outFile, buf);
      console.log(`[gen-video] OK -> ${outFile} (${(buf.length / 1048576).toFixed(1)} MB)`);
      process.exit(0);
    }
    if (status === 'failed' || status === 'cancelled' || status === 'expired') {
      console.error('任务失败:', JSON.stringify(body).slice(0, 800));
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 10000));
  }
  console.error('轮询超时');
  process.exit(1);
} else {
  throw new Error('mode 必须是 create 或 poll');
}
