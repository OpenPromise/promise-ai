// 把 assets-src 原图压缩为 web 用 webp，输出到 site/public/assets
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';

const jobs = [
  // 立绘：显示宽度 ~560px，输出 2x
  ...['ceo', 'xiaoye', 'xiaohei', 'xiaoyou', 'xiaomei'].map((id) => ({
    src: `assets-src/roles/${id}.png`,
    out: `site/public/assets/roles/${id}.webp`,
    width: 1120,
    quality: 82,
  })),
  // 同框场景：愿景背景 + 视频 poster
  { src: 'assets-src/scenes/group.png', out: 'site/public/assets/scenes/group.webp', width: 1920, quality: 76 },
];

mkdirSync('site/public/assets/roles', { recursive: true });
mkdirSync('site/public/assets/scenes', { recursive: true });

for (const j of jobs) {
  const info = await sharp(j.src).resize({ width: j.width }).webp({ quality: j.quality }).toFile(j.out);
  console.log(`${j.out} ${(info.size / 1024).toFixed(0)} KB`);
}
