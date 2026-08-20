import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

const GENOME_META = document.getElementById('genome-meta');
const HISTORY_LIST = document.getElementById('history-list');

// ---------- 场景 ----------
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(32, innerWidth / innerHeight, 0.1, 50);
camera.position.set(0, 1.35, 3.2);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.getElementById('scene').appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.15, 0);
controls.enableDamping = true;
controls.minDistance = 1.4;
controls.maxDistance = 6;

scene.add(new THREE.AmbientLight(0xffffff, 0.9));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.4);
keyLight.position.set(1, 2, 2);
scene.add(keyLight);
const rimLight = new THREE.DirectionalLight(0x88aaff, 0.6);
rimLight.position.set(-1.5, 0.5, -1);
scene.add(rimLight);

// ---------- Avatar Controller（唯一允许修改 3D 状态的模块） ----------
const avatar = {
  vrm: null,
  clock: new THREE.Clock(),
  blinkTimer: 0,
  blinkPhase: 'idle',
  emotion: 'neutral',
  emotionWeight: 0,
  speaking: false,
  breathPhase: 0,
};

function setExpression(presetName, weight) {
  const vrm = avatar.vrm;
  if (!vrm) return;
  // VRM1：expressionManager；VRM0：blendShapeProxy
  const manager = vrm.expressionManager ?? vrm.blendShapeProxy;
  if (!manager?.setValue) return;
  // 把 preset 名归一化后尝试
  const candidates = [presetName, presetName.toLowerCase(), presetName[0].toUpperCase() + presetName.slice(1)];
  for (const name of candidates) {
    if (typeof manager.setValue === 'function') {
      try {
        manager.setValue(name, weight);
        return;
      } catch {
        // 尝试下一个候选名
      }
    }
  }
}

function setEmotion(name) {
  avatar.emotion = name;
  avatar.emotionWeight = 1;
}

function updateExpressions(dt) {
  // 眨眼
  avatar.blinkTimer -= dt;
  if (avatar.blinkTimer <= 0) {
    avatar.blinkPhase = avatar.blinkPhase === 'idle' ? 'closing' : 'idle';
    avatar.blinkTimer = avatar.blinkPhase === 'closing' ? 0.12 : 1.8 + Math.random() * 3;
  }
  const blink = avatar.blinkPhase === 'closing' ? 1 : 0;
  setExpression('blink', blink);

  // 情绪：瞬时状态，随时间衰减到平静
  if (avatar.emotionWeight > 0.02) {
    const weight = avatar.emotionWeight;
    if (avatar.emotion !== 'neutral') setExpression(avatar.emotion, weight);
    avatar.emotionWeight = Math.max(0, avatar.emotionWeight - dt * 0.8);
  } else {
    setExpression(avatar.emotion === 'neutral' ? 'neutral' : 'neutral', 0);
  }

  // 说话：简单口型（Phase 3 再换 FFT viseme）
  if (avatar.speaking) {
    const mouth = (Math.sin(avatar.clock.elapsedTime * 9) + 1) / 2;
    setExpression('aa', mouth * 0.8);
    setExpression('oh', (1 - mouth) * 0.4);
  } else {
    setExpression('aa', 0);
    setExpression('oh', 0);
  }
}

function updateBreathing(dt) {
  const vrm = avatar.vrm;
  if (!vrm?.humanoid) return;
  avatar.breathPhase += dt * 1.4;
  const breath = Math.sin(avatar.breathPhase) * 0.012;
  const chest = vrm.humanoid.getNormalizedBoneNode?.('chest');
  if (chest) chest.rotation.x = breath * 0.6;
  const head = vrm.humanoid.getNormalizedBoneNode?.('head');
  if (head) {
    head.rotation.z = Math.sin(avatar.breathPhase * 0.5) * 0.01;
    head.rotation.y = Math.sin(avatar.breathPhase * 0.25) * 0.03;
  }
}

// ---------- 外观：基因组参数 → 材质（Phase 2 启发式映射） ----------
function materialName(name) {
  return (name ?? '').toLowerCase();
}

function applyAppearance(genome) {
  const vrm = avatar.vrm;
  if (!vrm) return;
  const a = genome.appearance;
  const hairHue = 195 + a.hairColor * 135;       // 0=青蓝 → 1=粉
  const clothHue = 220 + a.clothingColor * 100;  // 0=蓝紫 → 1=青
  const sat = Math.max(0.15, 1 - a.minimalStyle * 0.55);
  const lightness = 0.52 - a.minimalStyle * 0.08;
  const emissive = a.cyberStyle * 0.5;

  vrm.scene.traverse((obj) => {
    if (!obj.isMesh) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of mats) {
      if (!mat?.color) continue;
      const n = materialName(mat.name);
      if (n.includes('hair')) {
        mat.color.setHSL(hairHue / 360, sat, lightness);
        mat.emissive?.setHSL(195 / 360, 0.7, emissive);
        mat.emissiveIntensity = emissive > 0.05 ? emissive : 0;
      } else if (n.includes('eye')) {
        mat.color.setHSL((120 + a.eyeColor * 100) / 360, 0.5, 0.35);
      } else if (n.includes('cloth') || n.includes('outfit') || n.includes('wear') || n.includes('skirt')) {
        mat.color.setHSL(clothHue / 360, sat * 0.9, lightness * 0.95);
        mat.emissive?.setHSL(220 / 360, 0.6, emissive * 0.6);
        mat.emissiveIntensity = emissive > 0.05 ? emissive * 0.8 : 0;
      }
    }
  });
  renderGenomeMeta(genome);
}

function renderGenomeMeta(genome) {
  const a = genome.appearance;
  GENOME_META.textContent =
    `Gen ${genome.evolution.generation} · 交互 ${genome.evolution.totalInteractions}\n` +
    `发色 ${a.hairColor.toFixed(2)} · 科技 ${a.cyberStyle.toFixed(2)} · 可爱 ${a.cuteStyle.toFixed(2)} · 极简 ${a.minimalStyle.toFixed(2)}`;
}

// ---------- 加载固定底模 ----------
const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));
loader.load(
  '/avatar/base-avatar.vrm',
  (gltf) => {
    avatar.vrm = gltf.userData.vrm;
    VRMUtils.rotateVRM0(avatar.vrm);
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    scene.add(avatar.vrm.scene);
    loadState();
    loadHistory();
  },
  undefined,
  (error) => {
    GENOME_META.textContent = `模型加载失败：${error?.message ?? error}`;
  },
);

// ---------- 服务端状态 + SSE 同步 ----------
async function loadState() {
  try {
    const res = await fetch('/api/avatar/state');
    const json = await res.json();
    if (json?.ok && json.data) applyAppearance(json.data);
  } catch (error) {
    GENOME_META.textContent = `状态获取失败：${String(error)}`;
  }
}

async function loadHistory() {
  try {
    const res = await fetch('/api/avatar/history?limit=8');
    const json = await res.json();
    const events = json?.data?.events ?? [];
    HISTORY_LIST.innerHTML = events.length
      ? events
          .map(
            (e) =>
              `<li><span class="t">${(e.createdAt ?? '').slice(0, 16)}</span> ${e.parameter} ${e.oldValue.toFixed(2)}→${e.newValue.toFixed(2)}<br/><span style="color:#8b96aa">${e.reason ?? ''}</span></li>`,
          )
          .join('')
      : '<li>还没有进化记录</li>';
  } catch {
    HISTORY_LIST.innerHTML = '<li>历史获取失败</li>';
  }
}

const events = new EventSource('/api/avatar/events');
events.addEventListener('avatar.update', (event) => {
  try {
    applyAppearance(JSON.parse(event.data));
    loadHistory();
  } catch {
    // 忽略坏事件
  }
});

// ---------- 按钮 ----------
document.querySelectorAll('#controls button[data-adj]').forEach((button) => {
  button.addEventListener('click', async () => {
    const { parameter, delta } = JSON.parse(button.dataset.adj ?? '{}');
    try {
      await fetch('/api/avatar/adjust', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ parameter, delta, reason: `${button.textContent.trim()}（手动测试）` }),
      });
    } catch {
      // 忽略
    }
  });
});

document.querySelectorAll('#controls button[data-emotion]').forEach((button) => {
  button.addEventListener('click', () => setEmotion(button.dataset.emotion ?? 'neutral'));
});

const speakButton = document.getElementById('speak');
speakButton.addEventListener('pointerdown', () => {
  avatar.speaking = true;
  speakButton.classList.add('active');
});
speakButton.addEventListener('pointerup', () => {
  avatar.speaking = false;
  speakButton.classList.remove('active');
});
speakButton.addEventListener('pointerleave', () => {
  avatar.speaking = false;
  speakButton.classList.remove('active');
});

// ---------- 渲染循环 ----------
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(avatar.clock.getDelta(), 0.05);
  if (avatar.vrm) {
    avatar.vrm.update(dt);
    updateExpressions(dt);
    updateBreathing(dt);
  }
  controls.update();
  renderer.render(scene, camera);
}
animate();

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
