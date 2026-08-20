// 临时调试：Electron 加载 /world，连拍对比画面差异，验证动画在跑。用完删除。
import { app, BrowserWindow } from 'electron';

function diffRatio(a, b) {
  let diff = 0;
  let total = 0;
  for (let i = 0; i < a.length; i += 4) {
    total++;
    const dr = Math.abs(a[i] - b[i]);
    const dg = Math.abs(a[i + 1] - b[i + 1]);
    const db = Math.abs(a[i + 2] - b[i + 2]);
    if (dr + dg + db > 24) diff++;
  }
  return (diff / total) * 100;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: { offscreen: true },
  });
  const logs = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2 && !message.includes('Electron Security Warning')) {
      logs.push(`[${level}] ${message}`);
    }
  });
  await win.loadURL('http://122.152.209.182:3000/world');
  await new Promise((resolve) => setTimeout(resolve, 25_000));
  const frames = [];
  for (let i = 0; i < 4; i++) {
    const image = await win.webContents.capturePage();
    frames.push(image.toBitmap());
    await new Promise((resolve) => setTimeout(resolve, 2200));
  }
  const ratios = [];
  for (let i = 1; i < frames.length; i++) {
    ratios.push(Number(diffRatio(frames[i - 1], frames[i]).toFixed(3)));
  }
  console.log(JSON.stringify({ logs, frameDiffPct: ratios }, null, 2));
  app.exit(0);
});
