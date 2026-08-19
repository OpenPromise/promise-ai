import { createOrb } from './orb.js';

// ===========================================================================
// 主题系统（OpenDex use-amplitude 思路的极简版）：
// 每个主题是一个"完整界面"，由 ThemeManager 挂载/切换/销毁，
// 统一接收 setState（idle/listening/thinking/speaking/approval）
// 与 setVolume（0..1 麦克风/播放振幅），主题自行决定怎么动。
// ===========================================================================

export const orbTheme = {
  id: 'orb',
  label: '流光光球',
  create(host) {
    const canvas = document.createElement('canvas');
    canvas.id = 'orb-canvas';
    const wrap = document.createElement('div');
    wrap.id = 'orb-wrap';
    wrap.innerHTML = '<div id="orb-click" title="点按开始对话"></div>';
    host.append(canvas, wrap);
    const orb = createOrb(canvas);
    orb.animate();
    return {
      setState(state) {
        orb.setState(state);
      },
      setVolume(volume) {
        orb.setVolume(volume);
      },
      resize(w, h) {
        orb.resize(w, h);
      },
      destroy() {
        host.replaceChildren();
      },
    };
  },
};

const AURA_COLORS = {
  idle: { r: 96, g: 165, b: 250 }, // 蓝
  listening: { r: 34, g: 211, b: 238 }, // 青
  thinking: { r: 167, g: 139, b: 250 }, // 紫
  speaking: { r: 244, g: 114, b: 182 }, // 粉
  approval: { r: 251, g: 191, b: 36 }, // 琥珀
};

/**
 * 柔光光晕：纯 2D Canvas 的流动光体（多层径向渐变 + 高光 + 细环 + 音量涟漪），
 * 呼吸节奏与振幅实时驱动，状态切换平滑变色。不依赖 three.js，轻量稳定。
 */
export const auraTheme = {
  id: 'aura',
  label: '柔光光晕',
  create(host) {
    const canvas = document.createElement('canvas');
    canvas.className = 'aura-canvas';
    host.append(canvas);
    const ctx = canvas.getContext('2d');
    let state = 'idle';
    let volume = 0;
    let current = { ...AURA_COLORS.idle };
    let raf = 0;
    let dpr = 1;
    const start = performance.now();

    const resize = (w, h) => {
      dpr = Math.min(2, window.devicePixelRatio ?? 1);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const draw = (now) => {
      const t = (now - start) / 1000;
      const w = canvas.width / dpr;
      const h = canvas.height / dpr;
      const cx = w / 2;
      const cy = h / 2;
      const R = Math.min(w, h) / 2;

      // 状态颜色平滑过渡
      const target = AURA_COLORS[state] ?? AURA_COLORS.idle;
      current.r += (target.r - current.r) * 0.05;
      current.g += (target.g - current.g) * 0.05;
      current.b += (target.b - current.b) * 0.05;

      const amp = Math.min(1, volume);
      const active = state === 'idle' ? 0.45 : 1;
      const breathe = 1 + Math.sin(t * 1.5) * 0.04;
      const pulse = active + amp * 0.55 + (state === 'thinking' ? 0.3 * Math.sin(t * 6) : 0);
      const alpha = (a) =>
        `rgba(${Math.round(current.r)},${Math.round(current.g)},${Math.round(current.b)},${a})`;

      ctx.clearRect(0, 0, w, h);

      // Layer 1：宽范围柔光
      const outer = ctx.createRadialGradient(
        cx,
        cy,
        R * 0.25,
        cx,
        cy,
        R * breathe * (1 + amp * 0.3),
      );
      outer.addColorStop(0, alpha(0.22 * pulse));
      outer.addColorStop(0.55, alpha(0.1 * pulse));
      outer.addColorStop(1, alpha(0));
      ctx.fillStyle = outer;
      ctx.fillRect(0, 0, w, h);

      // Layer 2：核心光体
      const coreR = R * 0.42 * breathe;
      const core = ctx.createRadialGradient(
        cx - coreR * 0.3,
        cy - coreR * 0.35,
        coreR * 0.05,
        cx,
        cy,
        coreR,
      );
      core.addColorStop(0, 'rgba(255,255,255,0.95)');
      core.addColorStop(0.25, alpha(0.95));
      core.addColorStop(0.7, alpha(0.6));
      core.addColorStop(1, alpha(0.12));
      ctx.beginPath();
      ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
      ctx.fillStyle = core;
      ctx.fill();

      // Layer 3：高光点（立体感）
      const spec = ctx.createRadialGradient(
        cx - coreR * 0.35,
        cy - coreR * 0.42,
        0,
        cx - coreR * 0.35,
        cy - coreR * 0.42,
        coreR * 0.5,
      );
      spec.addColorStop(0, 'rgba(255,255,255,0.8)');
      spec.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.beginPath();
      ctx.arc(cx - coreR * 0.35, cy - coreR * 0.42, coreR * 0.5, 0, Math.PI * 2);
      ctx.fillStyle = spec;
      ctx.fill();

      // Layer 4：细环
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.78, 0, Math.PI * 2);
      ctx.strokeStyle = alpha(0.16 + amp * 0.2);
      ctx.lineWidth = 1.2;
      ctx.stroke();

      // Layer 5：音量涟漪（有声音时向外扩散）
      if (amp > 0.08) {
        for (let i = 0; i < 3; i++) {
          const phase = (t * 1.2 + i / 3) % 1;
          ctx.beginPath();
          ctx.arc(cx, cy, R * (0.5 + phase * 0.5), 0, Math.PI * 2);
          ctx.strokeStyle = alpha((1 - phase) * 0.35 * amp);
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }

      raf = requestAnimationFrame(draw);
    };

    resize(window.innerWidth, window.innerHeight);
    raf = requestAnimationFrame(draw);
    return {
      setState(next) {
        state = next;
      },
      setVolume(value) {
        volume = Math.max(0, Math.min(1, value));
      },
      resize,
      destroy() {
        cancelAnimationFrame(raf);
        host.replaceChildren();
      },
    };
  },
};

/** 主题管理器：挂载当前主题、转发状态与振幅、支持运行时切换并持久化。 */
export function createThemeManager(host) {
  const themes = [orbTheme, auraTheme];
  let name = 'orb';
  try {
    const saved = localStorage.getItem('promise-ai:theme');
    if (themes.some((theme) => theme.id === saved)) name = saved;
  } catch {
    // localStorage 不可用时保持默认
  }
  let current = null;
  let lastState = 'idle';
  let lastVolume = 0;

  function apply(nextName) {
    const theme = themes.find((candidate) => candidate.id === nextName) ?? themes[0];
    name = theme.id;
    try {
      localStorage.setItem('promise-ai:theme', name);
    } catch {
      // 持久化失败不影响本次切换
    }
    current?.destroy?.();
    current = theme.create(host);
    current.setState?.(lastState);
    current.setVolume?.(lastVolume);
    return theme;
  }

  return {
    get name() {
      return name;
    },
    list: () => themes.map((theme) => ({ id: theme.id, label: theme.label })),
    apply,
    setState(state) {
      lastState = state;
      current?.setState?.(state);
    },
    setVolume(volume) {
      lastVolume = volume;
      current?.setVolume?.(volume);
    },
    resize(w, h) {
      current?.resize?.(w, h);
    },
    destroy() {
      current?.destroy?.();
      current = null;
    },
  };
}
