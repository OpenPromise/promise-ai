const {
  app,
  BrowserWindow,
  globalShortcut,
  Tray,
  Menu,
  ipcMain,
  nativeImage,
  screen,
  Notification,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

const AGENT_URL = process.env.AGENT_URL ?? 'http://127.0.0.1:3000';
const WAKE_HOTKEY = process.env.WAKE_HOTKEY ?? 'CommandOrControl+Alt+Space';

let win = null;
let tray = null;
let chatWin = null;
let mouseButtonState = false;
let buttonWatcher = null;
let clickMonitor = null;
let clickCandidate = null;
let saveTimer = null;

function dragConfigPath() {
  return path.join(app.getPath('userData'), 'orb-position.json');
}

function loadDragPosition() {
  try {
    const raw = fs.readFileSync(dragConfigPath(), 'utf8');
    const saved = JSON.parse(raw);
    if (typeof saved.x === 'number' && typeof saved.y === 'number') {
      return { x: Math.round(saved.x), y: Math.round(saved.y) };
    }
  } catch {
    // 首次运行或文件损坏，使用默认位置
  }
  return null;
}

function saveDragPosition(x, y) {
  try {
    fs.mkdirSync(path.dirname(dragConfigPath()), { recursive: true });
    fs.writeFileSync(dragConfigPath(), JSON.stringify({ x, y }));
  } catch {
    // 保存失败不影响主流程
  }
}

/** 长驻 PowerShell：输出左键真实按下状态流（GetAsyncKeyState）。 */
function startButtonWatcher() {
  if (buttonWatcher) return;
  const script = [
    'Add-Type -TypeDefinition \'using System;using System.Runtime.InteropServices;public static class K{[DllImport("user32.dll")]public static extern short GetAsyncKeyState(int vKey);}\'',
    "while($true){ if([K]::GetAsyncKeyState(0x01) -band 0x8000){'1'}else{'0'}; Start-Sleep -Milliseconds 8 }",
  ].join(';');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    if (line === '1') mouseButtonState = true;
    else if (line === '0') mouseButtonState = false;
  });
  buttonWatcher = child;
}

function stopButtonWatcher() {
  if (buttonWatcher) {
    buttonWatcher.kill();
    buttonWatcher = null;
  }
  mouseButtonState = false;
}

/** 光标是否在光球圆形命中区内（窗口 setShape 的圆形区域）。 */
function isCursorOverOrb(cursor) {
  if (!win || win.isDestroyed() || !win.isVisible()) return false;
  const { x, y, width, height } = win.getBounds();
  const cx = x + width / 2;
  const cy = y + height / 2;
  const radius = Math.min(width, height) / 2;
  const dx = cursor.x - cx;
  const dy = cursor.y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

/**
 * 点击监测：窗口移动完全交给 Windows 原生拖动（-webkit-app-region: drag，
 * 与 jarvis-orb 的 startDragging 同机制，零延迟零漂移）。
 * 这里只做「被动观察」：左键按下→松开的位移 < 5px 判定为点击（唤醒/批准），
 * 否则判定为拖动（只保存位置）。监测不移动窗口，因此不可能引入漂移。
 */
function startClickMonitor() {
  if (clickMonitor) return;
  startButtonWatcher();
  clickMonitor = setInterval(() => {
    if (!win || win.isDestroyed()) {
      stopClickMonitor();
      return;
    }
    const cursor = screen.getCursorScreenPoint();
    if (mouseButtonState) {
      if (!clickCandidate) {
        clickCandidate = {
          startX: cursor.x,
          startY: cursor.y,
          overOrb: isCursorOverOrb(cursor),
        };
      }
    } else if (clickCandidate) {
      const dx = cursor.x - clickCandidate.startX;
      const dy = cursor.y - clickCandidate.startY;
      const moved = Math.hypot(dx, dy);
      if (clickCandidate.overOrb && moved <= 5) {
        // 原位松开 = 点击
        win.webContents.send('orb-click');
      } else {
        // 有位移 = 拖动结束，保存位置
        const [x, y] = win.getPosition();
        saveDragPosition(x, y);
      }
      clickCandidate = null;
    }
  }, 15);
  clickMonitor.unref?.();
}

function stopClickMonitor() {
  if (clickMonitor) {
    clearInterval(clickMonitor);
    clickMonitor = null;
  }
  clickCandidate = null;
}

function schedulePositionSave() {
  if (!win || win.isDestroyed()) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const [x, y] = win.getPosition();
    saveDragPosition(x, y);
  }, 400);
}

const WINDOW_SIZES = {
  idle: { width: 170, height: 190 },
  active: { width: 320, height: 340 },
};

function openChatWindow() {
  if (chatWin && !chatWin.isDestroyed()) {
    chatWin.show();
    chatWin.focus();
    return;
  }
  chatWin = new BrowserWindow({
    width: 400,
    height: 340,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: true,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  chatWin.setAlwaysOnTop(true, 'screen-saver');
  chatWin.loadFile(path.join(__dirname, 'renderer', 'chat.html'));
  // Float near the bottom-right corner of the primary display.
  const { workArea } = screen.getPrimaryDisplay();
  chatWin.once('ready-to-show', () => {
    const bounds = chatWin.getBounds();
    chatWin.setPosition(
      workArea.x + workArea.width - bounds.width - 24,
      workArea.y + workArea.height - bounds.height - 24,
    );
    chatWin.show();
    chatWin.focus();
  });
  chatWin.on('closed', () => {
    chatWin = null;
  });
}

function createWindow() {
  const savedPos = loadDragPosition();
  const primary = screen.getPrimaryDisplay();
  const defaultX = Math.round(
    primary.workArea.x + (primary.workArea.width - WINDOW_SIZES.idle.width) / 2,
  );
  const defaultY = Math.round(
    primary.workArea.y + (primary.workArea.height - WINDOW_SIZES.idle.height) / 2,
  );
  const startX = savedPos?.x ?? defaultX;
  const startY = savedPos?.y ?? defaultY;
  win = new BrowserWindow({
    width: WINDOW_SIZES.idle.width,
    height: WINDOW_SIZES.idle.height,
    x: startX,
    y: startY,
    transparent: true,
    // 显式透明背景：消除 Windows 透明窗口可能出现的方形底色/边框
    backgroundColor: '#00000000',
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required',
      // 窗口隐藏时语音链路（麦克风/WebSocket/播放）不能因后台节流被暂停
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.webContents.on('console-message', (event) => {
    console.log(`[renderer:${event.level}] ${event.message}`);
  });
  // Allow microphone access (getUserMedia) for voice conversations.
  win.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'media');
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 拖动/移动过程中保存位置（防抖），重启后光球回到上次位置
  win.on('move', schedulePositionSave);

  win.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });
}

function createTray() {
  // Minimal 1x1 placeholder icon; a real tray icon arrives with the desktop polish phase.
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  );
  tray = new Tray(icon);
  tray.setToolTip('私人 AI 助理');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示 / 唤醒', click: () => wake() },
      { label: '文字聊天', click: () => openChatWindow() },
      {
        label: '切换主题',
        submenu: [
          { label: '流光光球', click: () => win?.webContents.send('theme', 'orb') },
          { label: '柔光光晕', click: () => win?.webContents.send('theme', 'aura') },
        ],
      },
      {
        label: '将光球移回屏幕中央',
        click: () => {
          if (!win) return;
          const { workArea } = screen.getDisplayMatching(win.getBounds());
          const size = WINDOW_SIZES.idle;
          win.setBounds({
            x: Math.round(workArea.x + (workArea.width - size.width) / 2),
            y: Math.round(workArea.y + (workArea.height - size.height) / 2),
            width: size.width,
            height: size.height,
          });
        },
      },
      {
        label: '隐藏',
        click: () => {
          win?.hide();
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          app.isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function wake() {
  if (!win) return;
  win.show();
  win.focus();
  resizeTo('active');
  win.webContents.send('wake');
}

function resizeTo(mode) {
  const size = WINDOW_SIZES[mode] ?? WINDOW_SIZES.active;
  const { workArea } = screen.getDisplayMatching(win.getBounds());
  const bounds = win.getBounds();
  // Keep the user's position (clamped to the display) instead of recentering.
  const x = Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - size.width);
  const y = Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - size.height);
  win.setBounds({ x, y, width: size.width, height: size.height });
  applyCircleShape();
  // The orb must always be interactive (drag to move, click to talk).
  win.setIgnoreMouseEvents(false);
}

// Windows transparent windows are still rectangular; setShape() carves the
// window region into a circle so no square border or invisible corners show.
function applyCircleShape() {
  if (!win || typeof win.setShape !== 'function') return;
  const { width, height } = win.getBounds();
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) / 2;
  const rects = [];
  const stripHeight = 2;
  for (let y = 0; y < height; y += stripHeight) {
    const dy = y + stripHeight / 2 - cy;
    if (Math.abs(dy) >= radius) continue;
    const half = Math.sqrt(Math.max(0, radius * radius - dy * dy));
    const x0 = Math.max(0, Math.round(cx - half));
    const x1 = Math.min(width, Math.round(cx + half));
    if (x1 > x0) rects.push({ x: x0, y, width: x1 - x0, height: stripHeight });
  }
  if (rects.length > 0) win.setShape(rects);
}

app.whenReady().then(() => {
  createWindow();
  createTray();

  // Shape the window as a circle right away (before the renderer reports idle).
  setTimeout(() => applyCircleShape(), 500);

  const registered = globalShortcut.register(WAKE_HOTKEY, () => wake());
  if (!registered) {
    console.warn(`[desktop-ui] hotkey registration failed: ${WAKE_HOTKEY}`);
  }

  ipcMain.handle('get-config', () => ({ agentUrl: AGENT_URL, hotkey: WAKE_HOTKEY }));
  ipcMain.on('sleep', () => {
    win?.webContents.send('sleep');
  });
  ipcMain.on('hide', () => {
    win?.hide();
  });
  ipcMain.on('set-orb-icon', (event, dataUrl) => {
    if (typeof dataUrl !== 'string' || !tray) return;
    const image = nativeImage.createFromDataURL(dataUrl);
    if (!image.isEmpty()) {
      tray.setImage(image);
      tray.setToolTip('私人 AI 助理');
    }
  });
  ipcMain.on('notify', (event, title, body) => {
    new Notification({ title: title ?? '私人 AI 助理', body: body ?? '' }).show();
  });
  ipcMain.on('set-window-mode', (event, mode) => {
    if (mode === 'idle' || mode === 'active') {
      resizeTo(mode);
    }
  });
  ipcMain.handle('get-window-bounds', () => {
    return win ? win.getBounds() : { x: 0, y: 0, width: 0, height: 0 };
  });
  // 光球移动 = Windows 原生拖动（CSS -webkit-app-region: drag），
  // 点击 = 主进程被动监测（见 startClickMonitor），这里只启动监测。
  startClickMonitor();
  app.on('window-all-closed', () => {
    // Keep running in the tray.
  });
});

app.on('will-quit', () => {
  stopClickMonitor();
  stopButtonWatcher();
  globalShortcut.unregisterAll();
  if (win && !win.isDestroyed()) {
    const [x, y] = win.getPosition();
    saveDragPosition(x, y);
  }
});
