import { createThemeManager } from './themes.js';

let config = { agentUrl: 'http://127.0.0.1:3000', hotkey: '' };
void window.desktop.getConfig().then((value) => {
  config = value;
  startEventStream();
});

function wsBase() {
  return config.agentUrl.replace(/^http/, 'ws');
}

/** 订阅 Agent Server 的 SSE 事件流：定时任务结果、提醒到期弹系统通知。 */
function startEventStream() {
  try {
    const events = new EventSource(`${config.agentUrl}/api/events`);
    events.addEventListener('task.run', (event) => {
      try {
        const data = JSON.parse(event.data);
        const name = data.taskName || data.action || '定时任务';
        const title = data.status === 'error' ? `定时任务失败：${name}` : `定时任务完成：${name}`;
        const body = (data.output || data.error || '（无输出）').slice(0, 200);
        window.desktop.notify(title, body);
      } catch {
        // 忽略格式异常的事件
      }
    });
    events.addEventListener('reminder.due', (event) => {
      try {
        const data = JSON.parse(event.data);
        window.desktop.notify('⏰ 提醒', data.text || '时间到了');
      } catch {
        // 忽略格式异常的事件
      }
    });
  } catch {
    // EventSource 不可用时通知为尽力而为
  }
}

const appEl = document.getElementById('app');
const statusEl = document.getElementById('status-text');
const transcriptEl = document.getElementById('transcript');

const STATE_LABELS = {
  idle: '点按光球开始对话',
  listening: '我在听…',
  thinking: '思考中…',
  speaking: '正在说…',
  approval: '需要确认',
};

let state = 'idle';
let ws = null;
let sessionId = null;
function sessionStorageKey() {
  return `promise-ai:session:${config.agentUrl}`;
}

async function ensureSession() {
  if (!sessionId) {
    try {
      const stored = localStorage.getItem(sessionStorageKey());
      if (stored) sessionId = stored;
    } catch {
      // localStorage may be unavailable; a fresh session is created below
    }
  }
  if (sessionId) {
    try {
      const res = await fetch(`${config.agentUrl}/api/sessions/${sessionId}`);
      if (res.ok) return sessionId;
    } catch {
      // fall through to creating a fresh session
    }
    sessionId = null;
  }
  const res = await fetch(`${config.agentUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) throw new Error(`无法连接 Agent Server（${res.status}），请先运行 npm start`);
  sessionId = (await res.json()).id;
  try {
    localStorage.setItem(sessionStorageKey(), sessionId);
  } catch {
    // localStorage may be unavailable; the session still works for this run
  }
  return sessionId;
}
let audioCtx = null;
let sourceNode = null;
let processorNode = null;
let mediaStream = null;
let collecting = false;
let currentSentence = [];
let playing = false;
let playQueue = [];
let pcmCtx = null;
let pcmNextTime = 0;
let pcmSources = new Set();
let voiceReady = false;
let pendingApproval = null;

// ------------------------------------------------------------- rendering
//
// 主题系统：流光光球（three.js）/ 柔光光晕（2D Canvas）都是可切换主题，
// 统一接收状态与音量（use-amplitude 思路）。托盘可切换并持久化到 localStorage。

const themeHost = document.getElementById('theme-host');
const themeManager = createThemeManager(themeHost);
// -------------------------------------------------------------- volume

let volume = 0;

function setVolume(rms) {
  volume = Math.min(1, rms * 6);
  document.documentElement.style.setProperty('--vol', volume.toFixed(3));
  themeManager.setVolume(volume);
}

// ---------------------------------------------------------------- state

function setState(next) {
  state = next;
  appEl.className = `state-${next}`;
  statusEl.textContent = STATE_LABELS[next] ?? '';
  window.desktop.setWindowMode(next === 'idle' ? 'idle' : 'active');
  themeManager.setState(next);
}

window.desktop.onThemeChange((name) => {
  themeManager.apply(name);
});

// --------------------------------------------------------- tray orb icon

function generateOrbIcon() {
  const size = 64;
  const icon = document.createElement('canvas');
  icon.width = size;
  icon.height = size;
  const g = icon.getContext('2d');
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.42;

  const glow = g.createRadialGradient(cx, cy, r * 0.2, cx, cy, r * 1.7);
  glow.addColorStop(0, 'rgba(167, 139, 250, 0.95)');
  glow.addColorStop(0.5, 'rgba(34, 211, 238, 0.6)');
  glow.addColorStop(1, 'rgba(244, 114, 182, 0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, size, size);

  const orb = g.createRadialGradient(cx - r * 0.35, cy - r * 0.35, r * 0.05, cx, cy, r);
  orb.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
  orb.addColorStop(0.3, 'rgba(125, 211, 252, 0.95)');
  orb.addColorStop(0.65, 'rgba(167, 139, 250, 0.9)');
  orb.addColorStop(1, 'rgba(244, 114, 182, 0.7)');
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.fillStyle = orb;
  g.fill();

  // 高光点：托盘图标也有立体感
  const sparkle = g.createRadialGradient(
    cx - r * 0.38,
    cy - r * 0.42,
    0,
    cx - r * 0.38,
    cy - r * 0.42,
    r * 0.5,
  );
  sparkle.addColorStop(0, 'rgba(255,255,255,0.9)');
  sparkle.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = sparkle;
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.fill();

  window.desktop.setOrbIcon(icon.toDataURL('image/png'));
}

function setTranscript(text) {
  transcriptEl.textContent = text;
}

// ------------------------------------------------------------- websocket

async function startListening() {
  try {
    voiceReady = false;
    setState('listening');
    setTranscript('');

    await ensureSession();

    ws = new WebSocket(`${wsBase()}/ws/voice/${sessionId}`);
    const currentWs = ws;
    await new Promise((resolve, reject) => {
      currentWs.addEventListener('open', resolve, { once: true });
      currentWs.addEventListener('error', reject, { once: true });
    });
    currentWs.addEventListener('message', (event) => handleWsMessage(event.data));
    currentWs.addEventListener('close', () => {
      // Ignore stale connections closed by a newer session.
      if (ws !== currentWs) return;
      voiceReady = false;
      stopMicrophone();
      if (state !== 'idle') {
        setState('idle');
        statusEl.textContent = '连接已断开';
      }
    });

    await startMicrophone();
    ensurePcmCtx();
  } catch (error) {
    const hint =
      error.name === 'NotAllowedError' || error.name === 'SecurityError'
        ? '无法访问麦克风，请检查系统麦克风权限后重试'
        : error.message;
    statusEl.textContent = `出错了：${hint}`;
    stopMicrophone();
    setState('idle');
  }
}

async function startMicrophone() {
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, sampleRate: 16000, echoCancellation: true, noiseSuppression: true },
  });
  audioCtx = new AudioContext({ sampleRate: 16000 });
  sourceNode = audioCtx.createMediaStreamSource(mediaStream);
  processorNode = audioCtx.createScriptProcessor(2048, 1, 1);
  sourceNode.connect(processorNode);
  processorNode.connect(audioCtx.destination);

  processorNode.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    setVolume(Math.sqrt(sum / input.length));

    const pcm = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const sample = Math.max(-1, Math.min(1, input[i]));
      pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    if (ws && ws.readyState === WebSocket.OPEN && voiceReady) {
      ws.send(pcm.buffer);
    }
  };
}

function stopMicrophone() {
  processorNode?.disconnect();
  sourceNode?.disconnect();
  processorNode = null;
  sourceNode = null;
  audioCtx?.close();
  audioCtx = null;
  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = null;
  setVolume(0);
}

// -------------------------------------------------------------- messages

function handleWsMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  const type = message.type ?? '';
  const payload = message.payload ?? {};

  switch (type) {
    case 'voice.ready':
      voiceReady = true;
      break;
    case 'transcript.partial':
      setTranscript(payload.text);
      break;
    case 'transcript.final':
      setTranscript(payload.text);
      break;
    case 'agent.thinking':
      collecting = true;
      setState('thinking');
      break;
    case 'agent.state': {
      const nextState = payload.state;
      if (nextState === 'thinking') {
        collecting = true;
        setState('thinking');
      } else if (nextState === 'awaiting_approval') {
        setState('approval');
      } else if (nextState === 'speaking') {
        setState('speaking');
      } else if (nextState === 'listening') {
        setState('listening');
        statusEl.textContent = '继续说…';
      } else if (nextState === 'idle') {
        setState('idle');
      }
      break;
    }
    case 'permission.request': {
      pendingApproval = {
        requestId: payload.request?.requestId,
        toolName: payload.request?.toolName ?? '未知操作',
      };
      clearQueue();
      clearPcm();
      setState('approval');
      // 光球上不显示文字，用系统通知提示审批请求。
      window.desktop.notify(
        '需要确认',
        `是否允许「${pendingApproval.toolName}」？点击光球允许，60 秒未确认自动拒绝`,
      );
      statusEl.textContent = `是否允许「${pendingApproval.toolName}」？点击光球允许，60 秒未确认自动拒绝`;
      break;
    }
    case 'permission.response':
      if (pendingApproval && payload.requestId === pendingApproval.requestId) {
        pendingApproval = null;
      }
      break;
    case 'tts.sentence':
    case 'tts.start':
      flushCurrentSentence();
      collecting = true;
      setTranscript(payload.text);
      break;
    case 'audio.chunk': {
      if (payload.format === 'pcm') {
        enqueuePcm(payload.data, payload.sampleRate ?? 24000);
      } else {
        if (!collecting) break;
        const bytes = Uint8Array.from(atob(payload.data), (c) => c.charCodeAt(0));
        currentSentence.push(bytes);
      }
      break;
    }
    case 'tts.end': {
      collecting = false;
      flushCurrentSentence();
      break;
    }
    case 'tts.interrupted': {
      collecting = false;
      currentSentence = [];
      clearQueue();
      clearPcm();
      setState('listening');
      break;
    }
    case 'agent.done':
      // Stay in listening mode for continuous conversation.
      setState('listening');
      statusEl.textContent = '继续说…';
      break;
    case 'voice.error':
      voiceReady = false;
      pendingApproval = null;
      clearPcm();
      statusEl.textContent = `语音错误：${payload.error ?? '未知'}`;
      stopMicrophone();
      setState('idle');
      break;
  }
}

/** Plays the accumulated sentence immediately instead of waiting for the full reply. */
function flushCurrentSentence() {
  if (currentSentence.length === 0) return;
  const blob = new Blob(currentSentence, { type: 'audio/mpeg' });
  currentSentence = [];
  if (blob.size > 0) enqueueAudio(blob);
}

// --------------------------------------------------------------- playback

function enqueueAudio(blob) {
  playQueue.push(blob);
  if (!playing) playNext();
}

function clearQueue() {
  playQueue = [];
}

/** Creates/resumes the PCM playback context (must be called from a gesture). */
function ensurePcmCtx(sampleRate = 24000) {
  if (!pcmCtx) pcmCtx = new AudioContext({ sampleRate });
  if (pcmCtx.state === 'suspended') void pcmCtx.resume();
  return pcmCtx;
}

/**
 * Plays a 16-bit PCM chunk the moment it arrives: decode to Float32, append
 * to the output timeline and schedule immediately (no sentence buffering).
 */
function enqueuePcm(base64, sampleRate) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length >> 1);
  if (samples.length === 0) return;

  const floats = new Float32Array(samples.length);
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i] / 32768;
    floats[i] = value;
    sum += value * value;
  }
  setVolume(Math.sqrt(sum / samples.length));

  const ctx = ensurePcmCtx(sampleRate);
  const buffer = ctx.createBuffer(1, floats.length, sampleRate);
  buffer.copyToChannel(floats, 0);

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  pcmSources.add(source);
  source.onended = () => {
    pcmSources.delete(source);
    if (pcmSources.size === 0) setVolume(0);
  };

  if (pcmSources.size === 1) setState('speaking');
  const startAt = Math.max(ctx.currentTime, pcmNextTime);
  source.start(startAt);
  pcmNextTime = startAt + buffer.duration;
}

/** Stops all queued PCM playback (barge-in / disconnect). */
function clearPcm() {
  for (const source of pcmSources) {
    try {
      source.stop();
    } catch {
      // already stopped
    }
  }
  pcmSources.clear();
  pcmNextTime = 0;
  if (pcmCtx) {
    void pcmCtx.close().catch(() => {});
    pcmCtx = null;
  }
  setVolume(0);
}

async function playNext() {
  if (playQueue.length === 0) {
    playing = false;
    setVolume(0);
    return;
  }
  playing = true;
  setState('speaking');
  const blob = playQueue.shift();
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  const playCtx = new AudioContext();
  const sourceNode = playCtx.createMediaElementSource(audio);
  const analyser = playCtx.createAnalyser();
  analyser.fftSize = 512;
  sourceNode.connect(analyser);
  analyser.connect(playCtx.destination);
  const volumeData = new Uint8Array(analyser.fftSize);
  const driveVolume = () => {
    analyser.getByteTimeDomainData(volumeData);
    let sum = 0;
    for (const value of volumeData) {
      const sample = (value - 128) / 128;
      sum += sample * sample;
    }
    setVolume(Math.min(1, Math.sqrt(sum / volumeData.length) * 3.4));
    if (!audio.paused && !audio.ended) requestAnimationFrame(driveVolume);
  };
  driveVolume();
  await new Promise((resolve) => {
    audio.onended = resolve;
    audio.onerror = resolve;
    audio.play().catch(resolve);
  });
  playCtx.close();
  URL.revokeObjectURL(url);
  setVolume(0);
  await playNext();
}

// ------------------------------------------------------------------ input

const orbWrap = document.getElementById('orb-wrap');

function handleOrbClick() {
  if (state === 'approval') {
    if (pendingApproval && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'permission.response',
          requestId: pendingApproval.requestId,
          approved: true,
        }),
      );
      pendingApproval = null;
      setState('listening');
      statusEl.textContent = '已允许，继续…';
    }
  } else if (state === 'idle') {
    void startListening();
  } else if (state === 'listening') {
    // 不想继续说话：停止监听、断开语音、回到待机
    stopMicrophone();
    if (ws) {
      try {
        ws.close();
      } catch {
        // ignore
      }
      ws = null;
    }
    setState('idle');
  } else {
    // thinking/speaking/等待确认之外的状态：点击 = 打断并回到待机
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'interrupt' }));
      ws.close();
    }
    ws = null;
    stopMicrophone();
    clearQueue();
    clearPcm();
    pendingApproval = null;
    setState('idle');
  }
}

// 光球移动由 Windows 原生拖动完成（见 styles.css 的 -webkit-app-region: drag，
// 与 jarvis-orb 的 startDragging 同机制：系统级拖动，零延迟、零漂移）。
// 点击由主进程监测「左键原位松开」后通过 orb-click 事件送达，这里只响应。
window.desktop.onOrbClick(() => handleOrbClick());

window.desktop.onWake(() => {
  if (state === 'idle') void startListening();
  else window.desktop.requestHide();
});

window.desktop.onSleep(() => {
  pendingApproval = null;
  clearQueue();
  clearPcm();
  stopMicrophone();
  if (ws) ws.close();
  ws = null;
  setState('idle');
});

window.addEventListener('resize', () => themeManager.resize(window.innerWidth, window.innerHeight));
themeManager.resize(window.innerWidth, window.innerHeight);
generateOrbIcon();
setState('idle');
