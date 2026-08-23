// 火山方舟 Seedream 5.0 Pro 文生图
// 用法: node scripts/gen-image.mjs <prompt文件> <输出png> [size]
// 依赖环境变量 ARK_API_KEY
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const [promptFile, outFile, size = '1024x1536'] = process.argv.slice(2);
const apiKey = process.env.ARK_API_KEY;
if (!apiKey) throw new Error('缺少 ARK_API_KEY');
if (!promptFile || !outFile) throw new Error('用法: gen-image.mjs <prompt文件> <输出png> [size]');

const prompt = readFileSync(promptFile, 'utf8').trim();
console.log(`[gen-image] size=${size} prompt=${prompt.slice(0, 40)}...`);

const res = await fetch('https://ark.cn-beijing.volces.com/api/v3/images/generations', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
  body: JSON.stringify({
    model: 'doubao-seedream-5-0-pro-260628',
    prompt,
    size,
    output_format: 'png',
    response_format: 'b64_json',
    watermark: false,
    optimize_prompt_options: { mode: 'standard' },
  }),
});

const body = await res.json();
if (!res.ok || !body.data?.[0]?.b64_json) {
  console.error('[gen-image] 失败:', res.status, JSON.stringify(body).slice(0, 800));
  process.exit(1);
}
mkdirSync(dirname(outFile), { recursive: true });
const buf = Buffer.from(body.data[0].b64_json, 'base64');
writeFileSync(outFile, buf);
console.log(`[gen-image] OK -> ${outFile} (${(buf.length / 1024).toFixed(0)} KB)`);
