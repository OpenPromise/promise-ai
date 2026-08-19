/**
 * 移植自 jarvis-orb (https://github.com/TheStack-ai/jarvis-orb) 的 createOrb：
 * Three.js 流体着色器光球 + 精灵光晕 + 环境粒子 + 状态动画机。
 * 按本助手的状态（idle/listening/thinking/speaking/approval）与语音音量做了适配，
 * 配色保持 Apple-Siri 风格的低饱和青/紫 + 全息虹彩。
 */
import * as THREE from 'three';

const vertexShader = `
  uniform float uTime;
  uniform float uDisplacement;
  uniform float uScale;
  varying vec3 vNormal;
  varying vec3 vPosition;
  varying float vDisplacement;

  vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
  vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

  float snoise(vec3 v) {
    const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;
    i = mod289(i);
    vec4 p = permute(permute(permute(
      i.z + vec4(0.0, i1.z, i2.z, 1.0))
      + i.y + vec4(0.0, i1.y, i2.y, 1.0))
      + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);
    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);
    vec4 norm = taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m*m, vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
  }

  void main() {
    vNormal = normal;
    vPosition = position;

    // Single octave — smooth, not busy
    float noise = snoise(position * 1.8 + uTime * 0.3);
    vDisplacement = noise;

    vec3 newPosition = position + normal * noise * uDisplacement;
    newPosition *= uScale;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(newPosition, 1.0);
  }
`;

const fragmentShader = `
  uniform float uTime;
  uniform vec3 uColor1;
  uniform vec3 uColor2;
  uniform vec3 uGlowColor;
  uniform float uGlowIntensity;
  uniform float uAlertMix;
  uniform vec3 uAlertColor;
  varying vec3 vNormal;
  varying vec3 vPosition;
  varying float vDisplacement;

  void main() {
    vec3 viewDir = normalize(cameraPosition - vPosition);
    // Gentle fresnel — not aggressive
    float fresnel = pow(1.0 - max(dot(viewDir, vNormal), 0.0), 2.0);

    // Smooth gradient
    float gradient = (vPosition.y + 1.0) * 0.5;
    vec3 baseColor = mix(uColor1, uColor2, gradient + vDisplacement * 0.15);

    // Alert overlay
    baseColor = mix(baseColor, uAlertColor, uAlertMix);

    // Subtle edge glow only
    vec3 glow = uGlowColor * fresnel * uGlowIntensity;

    // Holographic iridescence — shifts with position + viewing angle
    float iriBase = fresnel * 0.3 + 0.05;
    float iriPhase = vPosition.y * 4.0 + vPosition.x * 3.0 + uTime * 0.6;
    vec3 iriColor = vec3(
      sin(iriPhase) * iriBase,
      sin(iriPhase + 2.094) * iriBase,
      sin(iriPhase + 4.189) * iriBase
    );

    vec3 finalColor = baseColor + glow + iriColor;
    float alpha = 0.9;

    gl_FragColor = vec4(finalColor, alpha);
  }
`;

// 状态配色（低饱和 Apple 风格；approval 用暖琥珀色提示）
const STATE_COLORS = {
  idle: {
    color1: 0x4a9ebf,
    color2: 0x6b4fa0,
    glow: 0x5bb8d4,
    alert: 0xf59e0b,
    alertMix: 0.0,
    scale: 1.0,
    displacement: 0.07,
    glowIntensity: 0.28,
  },
  listening: {
    color1: 0x5bc8e8,
    color2: 0x8b6fd8,
    glow: 0x7fd8ff,
    alert: 0xf59e0b,
    alertMix: 0.0,
    scale: 1.12,
    displacement: 0.12,
    glowIntensity: 0.5,
  },
  thinking: {
    color1: 0x9b60ff,
    color2: 0xbb80ff,
    glow: 0x8a7bff,
    alert: 0xf59e0b,
    alertMix: 0.0,
    scale: 0.92,
    displacement: 0.18,
    glowIntensity: 0.55,
  },
  speaking: {
    color1: 0x00d4ff,
    color2: 0xa78bfa,
    glow: 0x67e8f9,
    alert: 0xf59e0b,
    alertMix: 0.0,
    scale: 1.15,
    displacement: 0.12,
    glowIntensity: 0.5,
  },
  approval: {
    color1: 0xf8b04a,
    color2: 0xf472b6,
    glow: 0xfb923c,
    alert: 0xf59e0b,
    alertMix: 0.85,
    scale: 1.05,
    displacement: 0.2,
    glowIntensity: 0.7,
  },
};

/** 径向渐变光晕贴图（替代 UnrealBloomPass 后处理，透明背景友好）。 */
function makeGlowTexture() {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,0.85)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.4)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.14)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

export function createOrb(canvas) {
  // Three.js 渲染到离屏 WebGL 画布，再逐帧拷贝到可见的 2D Canvas。
  // 这台机器上 WebGL 画布直接进透明窗口会被合成成不透明黑（真实屏幕黑底），
  // 而 2D Canvas 能正确透明（老版光球已验证），所以用 blit 方式绕开该问题。
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const glCanvas = document.createElement('canvas');
  const renderer = new THREE.WebGLRenderer({
    canvas: glCanvas,
    alpha: true,
    antialias: true,
    preserveDrawingBuffer: true,
  });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(dpr);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.7;

  const ctx2d = canvas.getContext('2d', { alpha: true });

  function applySize(w, h) {
    const cw = Math.max(1, Math.round(w ?? window.innerWidth));
    const ch = Math.max(1, Math.round(h ?? window.innerHeight));
    glCanvas.width = Math.round(cw * dpr);
    glCanvas.height = Math.round(ch * dpr);
    renderer.setSize(cw, ch, false);
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    camera.aspect = cw / ch;
    camera.updateProjectionMatrix();
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.z = 3;

  const uniforms = {
    uTime: { value: 0 },
    uDisplacement: { value: 0.07 },
    uScale: { value: 1.0 },
    uColor1: { value: new THREE.Color(STATE_COLORS.idle.color1) },
    uColor2: { value: new THREE.Color(STATE_COLORS.idle.color2) },
    uGlowColor: { value: new THREE.Color(STATE_COLORS.idle.glow) },
    uGlowIntensity: { value: STATE_COLORS.idle.glowIntensity },
    uAlertMix: { value: 0.0 },
    uAlertColor: { value: new THREE.Color(STATE_COLORS.idle.alert) },
  };

  const geometry = new THREE.SphereGeometry(0.75, 128, 128);
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms,
    transparent: true,
  });
  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);

  // 环境光晕精灵：柔和的大范围辉光（替代后处理 bloom）
  const glowSprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: makeGlowTexture(),
      color: STATE_COLORS.idle.glow,
      transparent: true,
      opacity: 0.3,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    }),
  );
  glowSprite.position.z = -0.6;
  // 光晕铺满整个圆形窗口：即使窗口合成层仍有暗色，也不会有黑边露出来
  glowSprite.scale.set(3.9, 3.9, 1);
  scene.add(glowSprite);

  // 环境粒子 — 绕球缓慢旋转的微光
  const ambientCount = 30;
  const ambientGeo = new THREE.BufferGeometry();
  const ambientPos = new Float32Array(ambientCount * 3);
  const ambientSpeeds = [];
  for (let i = 0; i < ambientCount; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = 1.1 + Math.random() * 0.6;
    ambientPos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    ambientPos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    ambientPos[i * 3 + 2] = r * Math.cos(phi);
    ambientSpeeds.push(0.1 + Math.random() * 0.3);
  }
  ambientGeo.setAttribute('position', new THREE.BufferAttribute(ambientPos, 3));
  const ambientMat = new THREE.PointsMaterial({
    color: 0x5bb8d4,
    size: 0.012,
    transparent: true,
    opacity: 0.25,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const ambientParticles = new THREE.Points(ambientGeo, ambientMat);
  scene.add(ambientParticles);

  // 状态切换时迸发的能量粒子
  const particleCount = 50;
  const particleGeo = new THREE.BufferGeometry();
  const particlePositions = new Float32Array(particleCount * 3);
  const particleVelocities = [];
  for (let i = 0; i < particleCount; i++) {
    particlePositions[i * 3] = 0;
    particlePositions[i * 3 + 1] = 0;
    particlePositions[i * 3 + 2] = 0;
    particleVelocities.push(new THREE.Vector3());
  }
  particleGeo.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));
  const particleMat = new THREE.PointsMaterial({
    color: 0x80e0ff,
    size: 0.05,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const particles = new THREE.Points(particleGeo, particleMat);
  scene.add(particles);

  const timer = new THREE.Timer();
  const targets = {
    scale: 1.0,
    displacement: 0.07,
    glowIntensity: 0.28,
    alertMix: 0.0,
  };
  let currentState = 'idle';
  let volume = 0;

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function applyState(state) {
    currentState = state;
    const c = STATE_COLORS[state] ?? STATE_COLORS.idle;
    uniforms.uColor1.value.set(c.color1);
    uniforms.uColor2.value.set(c.color2);
    uniforms.uGlowColor.value.set(c.glow);
    uniforms.uAlertColor.value.set(c.alert);
    targets.alertMix = c.alertMix;
    targets.displacement = c.displacement;
    if (state !== 'speaking') {
      targets.glowIntensity = c.glowIntensity;
      targets.scale = c.scale;
    }
    // 状态切换迸发粒子
    emitParticles();
  }

  function setState(state) {
    if (state === currentState) return;
    applyState(state);
  }

  function setVolume(v) {
    volume = Math.min(1, Math.max(0, v));
  }

  function emitParticles() {
    const pos = particles.geometry.attributes.position.array;
    particleMat.opacity = 0.8;
    for (let i = 0; i < particleCount; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const r = 1.8 + Math.random() * 0.6;
      pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      pos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      pos[i * 3 + 2] = r * Math.cos(phi);
      particleVelocities[i].set(-pos[i * 3] * 1.2, -pos[i * 3 + 1] * 1.2, -pos[i * 3 + 2] * 1.2);
    }
    particles.geometry.attributes.position.needsUpdate = true;
  }

  function updateParticles(delta) {
    const pos = particles.geometry.attributes.position.array;
    for (let i = 0; i < particleCount; i++) {
      const vel = particleVelocities[i];
      pos[i * 3] = (pos[i * 3] + vel.x * delta) * 0.985;
      pos[i * 3 + 1] = (pos[i * 3 + 1] + vel.y * delta) * 0.985;
      pos[i * 3 + 2] = (pos[i * 3 + 2] + vel.z * delta) * 0.985;
    }
    particles.geometry.attributes.position.needsUpdate = true;
    if (particleMat.opacity > 0) particleMat.opacity *= 0.992;
  }

  function animate() {
    requestAnimationFrame(animate);

    timer.update();
    const delta = timer.getDelta();
    const elapsed = timer.getElapsed();
    uniforms.uTime.value = elapsed;

    // Very slow rotation
    mesh.rotation.y = elapsed * 0.06;
    mesh.rotation.x = Math.sin(elapsed * 0.03) * 0.05;

    // Idle 呼吸；speaking 由音量驱动脉动
    const breathe = Math.sin(elapsed * 0.6) * 0.025 + 1.0;
    if (currentState === 'idle') {
      targets.scale = breathe;
      targets.glowIntensity = STATE_COLORS.idle.glowIntensity + Math.sin(elapsed * 1.3) * 0.05;
    } else if (currentState === 'speaking') {
      const c = STATE_COLORS.speaking;
      targets.scale = c.scale + volume * 0.12;
      targets.glowIntensity = c.glowIntensity + volume * 0.55;
      targets.displacement = c.displacement + volume * 0.18;
    }

    // Smooth transitions (slower lerp = more graceful)
    uniforms.uScale.value = lerp(uniforms.uScale.value, targets.scale, 0.03);
    uniforms.uDisplacement.value = lerp(uniforms.uDisplacement.value, targets.displacement, 0.03);
    uniforms.uGlowIntensity.value = lerp(
      uniforms.uGlowIntensity.value,
      targets.glowIntensity,
      0.03,
    );
    uniforms.uAlertMix.value = lerp(uniforms.uAlertMix.value, targets.alertMix, 0.03);

    // 光晕精灵：颜色跟随光球，大小/透明度随状态与音量呼吸
    glowSprite.material.color.copy(uniforms.uGlowColor.value);
    const glowScale = 3.9 + uniforms.uGlowIntensity.value * 1.2 + volume * 0.5;
    glowSprite.scale.set(glowScale, glowScale, 1);
    glowSprite.material.opacity = lerp(
      glowSprite.material.opacity,
      Math.min(0.75, uniforms.uGlowIntensity.value * 0.95),
      0.03,
    );

    // 环境粒子缓慢公转
    const aPos = ambientParticles.geometry.attributes.position.array;
    for (let i = 0; i < ambientCount; i++) {
      const speed = ambientSpeeds[i];
      const x = aPos[i * 3];
      const z = aPos[i * 3 + 2];
      const angle = Math.atan2(z, x) + speed * delta * 0.15;
      const r = Math.sqrt(x * x + z * z);
      aPos[i * 3] = Math.cos(angle) * r;
      aPos[i * 3 + 2] = Math.sin(angle) * r;
    }
    ambientParticles.geometry.attributes.position.needsUpdate = true;

    updateParticles(delta);
    renderer.render(scene, camera);
    // 离屏 WebGL → 可见 2D Canvas（alpha 保留，透明合成可靠）
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    ctx2d.drawImage(glCanvas, 0, 0, canvas.width, canvas.height);
  }

  function resize(w, h) {
    applySize(w, h);
  }

  applySize(canvas.clientWidth, canvas.clientHeight);

  return { animate, setState, setVolume, resize };
}
