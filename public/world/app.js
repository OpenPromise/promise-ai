import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

const ACTIVITY_EL = document.getElementById('activity');
const META_EL = document.getElementById('meta');
const EVENTS_LIST = document.getElementById('events-list');
const ACT_INPUT = document.getElementById('act-input');
const ACT_BTN = document.getElementById('act-btn');

// ---------- 场景 ----------
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x10131a, 8, 18);
const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.1, 50);
camera.position.set(2.6, 2.1, 4.6);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.getElementById('scene').appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.0, 0);
controls.enableDamping = true;
controls.minDistance = 1.6;
controls.maxDistance = 9;
controls.maxPolarAngle = Math.PI * 0.52;

// 灯光
const ambient = new THREE.AmbientLight(0xffeedd, 0.55);
scene.add(ambient);
const sun = new THREE.DirectionalLight(0xffe8cc, 1.5);
sun.position.set(3, 4, 2);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
scene.add(sun);
const fill = new THREE.DirectionalLight(0x88aaff, 0.35);
fill.position.set(-2, 1.5, -2);
scene.add(fill);

// ---------- 房间 ----------
const roomGroup = new THREE.Group();

function mesh(geometry, color, x, y, z, rx = 0, rz = 0, cast = true) {
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.8 });
  const o = new THREE.Mesh(geometry, m);
  o.position.set(x, y, z);
  o.rotation.set(rx, 0, rz);
  o.castShadow = cast;
  o.receiveShadow = true;
  roomGroup.add(o);
  return o;
}

// 地板
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(7, 7),
  new THREE.MeshStandardMaterial({ color: 0x8a6f5a, roughness: 0.9 }),
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = 0;
floor.receiveShadow = true;
roomGroup.add(floor);
// 地毯
const rug = new THREE.Mesh(
  new THREE.CircleGeometry(1.4, 32),
  new THREE.MeshStandardMaterial({ color: 0x6d7fa8, roughness: 1 }),
);
rug.rotation.x = -Math.PI / 2;
rug.position.set(0, 0.005, 0.2);
rug.receiveShadow = true;
roomGroup.add(rug);
// 后墙 + 侧墙
const wallMat = new THREE.MeshStandardMaterial({ color: 0x4d5468, roughness: 0.95 });
const backWall = new THREE.Mesh(new THREE.PlaneGeometry(7, 3.4), wallMat);
backWall.position.set(0, 1.7, -3.5);
roomGroup.add(backWall);
const leftWall = new THREE.Mesh(new THREE.PlaneGeometry(7, 3.4), wallMat);
leftWall.position.set(-3.5, 1.7, 0);
leftWall.rotation.y = Math.PI / 2;
roomGroup.add(leftWall);
// 窗户（发光）
const windowGlow = new THREE.Mesh(
  new THREE.PlaneGeometry(1.7, 1.5),
  new THREE.MeshBasicMaterial({ color: 0xaedcff }),
);
windowGlow.position.set(-1.5, 1.9, -3.48);
roomGroup.add(windowGlow);
const windowFrame = new THREE.Mesh(
  new THREE.BoxGeometry(1.85, 1.65, 0.08),
  new THREE.MeshStandardMaterial({ color: 0x2b2f3a }),
);
windowFrame.position.set(-1.5, 1.9, -3.44);
roomGroup.add(windowFrame);
// 床
mesh(new THREE.BoxGeometry(1.7, 0.35, 1.1), 0x3c4f6e, -2.55, 0.175, -2.2);
mesh(new THREE.BoxGeometry(1.62, 0.18, 0.95), 0xe8e2d8, -2.55, 0.44, -2.2);
mesh(new THREE.BoxGeometry(0.45, 0.22, 0.28), 0x9fb3d9, -3.28, 0.53, -2.2);
// 书桌 + 显示器 + 台灯
mesh(new THREE.BoxGeometry(1.5, 0.08, 0.75), 0x5a4636, 2.2, 0.74, -2.4);
mesh(new THREE.BoxGeometry(0.06, 0.74, 0.7), 0x5a4636, 1.5, 0.37, -2.4);
mesh(new THREE.BoxGeometry(0.06, 0.74, 0.7), 0x5a4636, 2.9, 0.37, -2.4);
mesh(new THREE.BoxGeometry(0.72, 0.46, 0.05), 0x1b1e26, 2.2, 1.05, -2.02);
mesh(new THREE.BoxGeometry(0.14, 0.22, 0.05), 0x333845, 1.72, 1.02, -2.02);
// 书架
mesh(new THREE.BoxGeometry(1.4, 1.9, 0.35), 0x6b4f3a, -0.4, 0.95, -3.28);
const bookColors = [0xc94f4f, 0x4f7ac9, 0x58a86b, 0xd9b45c, 0x9b6bbf];
for (let row = 0; row < 4; row++) {
  for (let i = 0; i < 8; i++) {
    const book = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 0.3 - row * 0.035, 0.12),
      new THREE.MeshStandardMaterial({ color: bookColors[(row + i) % bookColors.length] }),
    );
    book.position.set(-0.4 + (i - 3.5) * 0.17, 1.62 - row * 0.42, -3.05);
    roomGroup.add(book);
  }
}
// 绿植
const pot = new THREE.Mesh(
  new THREE.CylinderGeometry(0.2, 0.15, 0.28),
  new THREE.MeshStandardMaterial({ color: 0x9a6a4f }),
);
pot.position.set(3.0, 0.14, 2.4);
roomGroup.add(pot);
const leaves = new THREE.Mesh(
  new THREE.ConeGeometry(0.45, 0.9, 8),
  new THREE.MeshStandardMaterial({ color: 0x4e8f5a }),
);
leaves.position.set(3.0, 0.68, 2.4);
roomGroup.add(leaves);
// 挂画
const painting = new THREE.Mesh(
  new THREE.PlaneGeometry(0.9, 0.65),
  new THREE.MeshBasicMaterial({ color: 0x6f86b8 }),
);
painting.position.set(1.4, 2.2, -3.47);
roomGroup.add(painting);

scene.add(roomGroup);

// 飘浮尘埃粒子（让房间有"空气感"）
const DUST_COUNT = 70;
const dustPositions = new Float32Array(DUST_COUNT * 3);
for (let i = 0; i < DUST_COUNT; i++) {
  dustPositions[i * 3] = (Math.random() - 0.5) * 6;
  dustPositions[i * 3 + 1] = 0.2 + Math.random() * 2.4;
  dustPositions[i * 3 + 2] = (Math.random() - 0.5) * 6;
}
const dustGeo = new THREE.BufferGeometry();
dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3));
const dustMat = new THREE.PointsMaterial({
  color: 0xfff2d8,
  size: 0.022,
  transparent: true,
  opacity: 0.55,
});
const dust = new THREE.Points(dustGeo, dustMat);
scene.add(dust);

// ---------- Avatar Controller（她） ----------
const avatar = {
  vrm: null,
  clock: new THREE.Clock(),
  blinkTimer: 1.2,
  blinkPhase: 'idle',
  breathPhase: 0,
  gesture: null,
  gestureTime: 0,
  pose: { headX: 0 },
};

// 周期性小动作：让她看起来"有自己的想法"，每 5~12 秒随机触发一个
const IDLE_GESTURES = [
  { headX: 0.3, headY: 0.0, label: '低头看书' },
  { headX: 0.16, headY: 0.24, label: '望向窗外' },
  { headX: 0.0, headY: -0.32, label: '向右看看' },
  { headX: 0.0, headY: 0.32, label: '向左看看' },
  { headX: 0.22, headY: -0.12, label: '整理思绪' },
  { headX: -0.12, headY: 0.18, label: '抬头舒展' },
];
const GESTURE_DURATION = 1.8;

function setExpression(presetName, weight) {
  const vrm = avatar.vrm;
  if (!vrm) return;
  const manager = vrm.expressionManager ?? vrm.blendShapeProxy;
  if (!manager?.setValue) return;
  const candidates = [presetName, presetName.toLowerCase(), presetName[0].toUpperCase() + presetName.slice(1)];
  for (const name of candidates) {
    try {
      manager.setValue(name, weight);
      return;
    } catch {
      // 尝试下一个候选名
    }
  }
}

function updateAvatar(dt) {
  const vrm = avatar.vrm;
  if (!vrm) return;
  const t = avatar.clock.elapsedTime;

  // 眨眼：2~5.5 秒一次，闭眼 0.15 秒
  avatar.blinkTimer -= dt;
  if (avatar.blinkTimer <= 0) {
    avatar.blinkPhase = avatar.blinkPhase === 'idle' ? 'closing' : 'idle';
    avatar.blinkTimer = avatar.blinkPhase === 'closing' ? 0.15 : 2 + Math.random() * 3.5;
  }
  setExpression('blink', avatar.blinkPhase === 'closing' ? 1 : 0);

  // 小动作调度：空闲时随机触发，平滑进出
  if (!avatar.gesture && avatar.gestureTime <= 0) {
    if (Math.random() < dt / 8) {
      avatar.gesture = IDLE_GESTURES[Math.floor(Math.random() * IDLE_GESTURES.length)];
      avatar.gestureTime = GESTURE_DURATION;
    }
  } else if (avatar.gesture) {
    avatar.gestureTime -= dt;
    if (avatar.gestureTime <= 0) avatar.gesture = null;
  }
  let gestureX = 0;
  let gestureY = 0;
  if (avatar.gesture) {
    const p = 1 - Math.max(0, avatar.gestureTime) / GESTURE_DURATION;
    const ease = p < 0.18 ? p / 0.18 : p > 0.82 ? (1 - p) / 0.18 : 1;
    gestureX = avatar.gesture.headX * ease;
    gestureY = avatar.gesture.headY * ease;
  }

  // 呼吸：胸腔起伏，幅度更明显
  avatar.breathPhase += dt * 1.3;
  const breath = Math.sin(avatar.breathPhase) * 0.025;
  const chest = vrm.humanoid?.getNormalizedBoneNode?.('chest');
  if (chest) chest.rotation.x = breath * 0.6;
  // 身体轻摆（自然站立感）
  const hips = vrm.humanoid?.getNormalizedBoneNode?.('hips');
  if (hips) hips.rotation.z = Math.sin(t * 0.5) * 0.02;
  // 头部：扫视 + 小动作 + 活动姿态
  const head = vrm.humanoid?.getNormalizedBoneNode?.('head');
  if (head) {
    const lookY = Math.sin(t * 0.45) * 0.14; // 左右张望
    const lookX = Math.sin(t * 0.32) * 0.04; // 微微点头
    head.rotation.y = lookY + gestureY;
    head.rotation.x = lookX + gestureX + (avatar.pose?.headX ?? 0);
    head.rotation.z = Math.sin(t * 0.2) * 0.03;
  }
  vrm.update(dt);
}

const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));
loader.load(
  '/avatar/base-avatar.vrm',
  (gltf) => {
    avatar.vrm = gltf.userData.vrm;
    VRMUtils.rotateVRM0(avatar.vrm);
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    avatar.vrm.scene.position.set(0, 0, 0.35);
    avatar.vrm.scene.scale.setScalar(1);
    scene.add(avatar.vrm.scene);
  },
  undefined,
  (error) => {
    ACTIVITY_EL.textContent = `模型加载失败：${error?.message ?? error}`;
  },
);

// ---------- 世界状态 ----------
async function loadWorld() {
  try {
    const res = await fetch('/api/avatar/world');
    const json = await res.json();
    if (json?.ok && json.data) renderState(json.data);
  } catch {
    ACTIVITY_EL.textContent = '世界状态获取失败';
  }
}

function renderState(state) {
  const a = state.activity;
  if (a) {
    ACTIVITY_EL.textContent = `${a.emoji} 在${a.location}${a.label}`;
    // 活动影响姿态：看书/工作时微微低头
    avatar.pose = a.kind === 'reading' || a.kind === 'working' ? { headX: -0.14 } : { headX: 0 };
  } else {
    ACTIVITY_EL.textContent = '✨ 正在安顿自己…';
    avatar.pose = { headX: 0 };
  }
  const now = new Date();
  META_EL.innerHTML =
    `🕐 ${now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` +
    ` · 第 ${Math.max(1, state.daysLived)} 天` +
    ` · 行动 ${state.totalActions} 次<br/>` +
    (a ? `⏳ 持续到 ${new Date(a.until).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '');
}

async function loadEvents() {
  try {
    const res = await fetch('/api/avatar/world/events?limit=20');
    const json = await res.json();
    const events = json?.data?.events ?? [];
    EVENTS_LIST.innerHTML = events.length
      ? events
          .map(
            (e) =>
              `<li><span class="t">${(e.createdAt ?? '').slice(5, 16).replace('T', ' ')}</span>${e.summary}</li>`,
          )
          .join('')
      : '<li>她今天还没有留下足迹</li>';
  } catch {
    EVENTS_LIST.innerHTML = '<li>活动流加载失败</li>';
  }
}

const stream = new EventSource('/api/avatar/world/stream');
stream.addEventListener('world.update', (event) => {
  try {
    renderState(JSON.parse(event.data));
    loadEvents();
  } catch {
    // 忽略坏事件
  }
});

ACT_BTN.addEventListener('click', async () => {
  const label = ACT_INPUT.value.trim();
  if (!label) return;
  try {
    await fetch('/api/avatar/world/act', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label, durationMin: 30 }),
    });
    ACT_INPUT.value = '';
    loadWorld();
    loadEvents();
  } catch {
    // 忽略
  }
});
ACT_INPUT.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') ACT_BTN.click();
});

loadWorld();
loadEvents();

// ---------- 渲染循环 ----------
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(avatar.clock.getDelta(), 0.05);
  if (avatar.vrm) updateAvatar(dt);
  // 房间氛围：尘埃漂移 + 窗户光呼吸
  dust.rotation.y += dt * 0.015;
  dust.position.y = Math.sin(avatar.clock.elapsedTime * 0.15) * 0.06;
  windowGlow.material.color.setHSL(
    0.56,
    0.55,
    0.48 + Math.sin(avatar.clock.elapsedTime * 0.3) * 0.14,
  );
  controls.update();
  renderer.render(scene, camera);
}
animate();

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
