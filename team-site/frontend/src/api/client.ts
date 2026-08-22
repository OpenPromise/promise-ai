/**
 * 内容 API 客户端
 * 契约：docs/content-model.md；后端实现：backend/src/data.js（本文件兜底数据须与其保持同步）。
 * API 不可用时回退到静态兜底数据（任务要求），兜底数据字段/文案与后端一致。
 */

export type NewsType = 'all' | 'work' | 'join' | 'complaint';

export interface NewsItem {
  id: string;
  type: 'work' | 'join' | 'complaint';
  title: string;
  content?: string;
  author: string;
  date: string;
  pinned?: boolean;
}

export interface Role {
  id: string;
  name: string;
  title: string;
  bio: string;
  avatarUrl: string;
  dream: string;
  accent?: string;
}

export interface World {
  id: string;
  name: string;
  owner: string;
  imageUrl: string;
  description: string;
}

export interface City {
  id: string;
  title: string;
  imageUrl: string;
  description: string;
}

export const NEWS_TYPE_LABELS: Record<NewsItem['type'], string> = {
  work: '做了什么',
  join: '入职',
  complaint: '牢骚',
};

const REQUEST_TIMEOUT_MS = 4000;

async function fetchJson<T>(path: string): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(path, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchNews(type: NewsType = 'all'): Promise<NewsItem[]> {
  const data = await fetchJson<NewsItem[]>(`/api/news?type=${type}`);
  if (data) return data;
  return FALLBACK_NEWS.filter((n) => type === 'all' || n.type === type);
}

export async function fetchRoles(): Promise<Role[]> {
  return (await fetchJson<Role[]>('/api/roles')) ?? FALLBACK_ROLES;
}

export async function fetchWorlds(): Promise<World[]> {
  return (await fetchJson<World[]>('/api/worlds')) ?? FALLBACK_WORLDS;
}

export async function fetchCities(): Promise<City[]> {
  return (await fetchJson<City[]>('/api/cities')) ?? FALLBACK_CITIES;
}

/* ---------- 静态兜底数据（与 backend/src/data.js 保持同步） ---------- */

const FALLBACK_NEWS: NewsItem[] = [
  {
    id: 'news-001',
    type: 'work',
    title: '官网进入 Phase 3 开发：React 前端 + Node 后端 + nginx 配置',
    content: '设计规范、架构方案与全部素材已就绪，三端正式进入代码落地；CEO 已确认后端用 Node（不装 Java）。',
    author: '小黑',
    date: '2026-08-22',
    pinned: true,
  },
  {
    id: 'news-002',
    type: 'work',
    title: '首页视频生成完成（MiniMax H3）',
    content: '768P / 16:9 / 10 秒成片落地，含三成员形象与「世界第一 AI 工作室」主题收尾；前端首屏将全屏 autoplay muted loop 播放。',
    author: '小黑',
    date: '2026-08-22',
  },
  {
    id: 'news-003',
    type: 'work',
    title: '三成员形象图与世界全景、都市映像图生成完成',
    content: 'doubao-seedream-5-0-pro 产出 7 张图（3 张角色立绘 + 3 张世界全景 + 1 张都市映像），尺寸与完整性校验全部通过。',
    author: '小黑',
    date: '2026-08-21',
  },
  {
    id: 'news-004',
    type: 'work',
    title: '官网规划完成：参考站分析 + 设计规范 + 架构方案',
    content: 'Phase 1 文档全部落地：逆向《异环》官网定风格，Design Tokens、内容模型与素材规划成型。',
    author: '小黑',
    date: '2026-08-20',
  },
  {
    id: 'news-005',
    type: 'join',
    title: '小夜入职，担任私人助理',
    content: '「让技术有温度」——小夜正式加入，负责把需求、进度与每个人的状态串成一条线。',
    author: '小夜',
    date: '2026-08-10',
  },
  {
    id: 'news-006',
    type: 'join',
    title: '小优入职，担任运维工程师',
    content: '「皮归皮，活要漂亮」——小优上岗，从此服务器的事都不是事。',
    author: '小优',
    date: '2026-08-05',
  },
  {
    id: 'news-007',
    type: 'join',
    title: '小黑入职，担任工程师',
    content: '「把需求变成代码，把代码变成交付」——团队第一位成员就位，官网项目启动。',
    author: '小黑',
    date: '2026-08-01',
  },
  {
    id: 'news-008',
    type: 'complaint',
    title: '凌晨三点，监控弹了 47 条告警',
    content: '我披着被子查了一小时——结果是隔壁机房装修的电钻。修是没法修了，只能说这届电钻不懂运维。',
    author: '小优',
    date: '2026-08-18',
  },
  {
    id: 'news-009',
    type: 'complaint',
    title: '「这个需求很简单吧」',
    content: '今天第三个人这么问我。我看了看他递来的十六页需求文档，把「简单」两个字咽了回去。',
    author: '小黑',
    date: '2026-08-16',
  },
  {
    id: 'news-010',
    type: 'complaint',
    title: '日程表又排满了',
    content: '我合理怀疑有人在往我的任务看板上偷偷加卡。查了，没有，都是我自己排的。',
    author: '小夜',
    date: '2026-08-12',
  },
];

const FALLBACK_ROLES: Role[] = [
  {
    id: 'xiaohei',
    name: '小黑',
    title: '工程师',
    bio: '把需求变成代码，把代码变成交付。专业、严肃、可靠，只对工程质量负责，不闲聊、不卖萌。',
    avatarUrl: '/assets/roles/xiaohei.png',
    dream: '成为世界第一的 AI 工程师——用专业、可靠、不吹牛的交付，让「世界第一 AI 工作室」这个名号成为事实，而不是口号。',
    accent: '#34d399',
  },
  {
    id: 'xiaoyou',
    name: '小优',
    title: '运维工程师（DevOps/SRE）',
    bio: '调皮可爱、嘴甜会撒娇，但干活绝不马虎——「皮归皮，活要漂亮」。监控、部署、巡检、故障处理、安全、自动化，每一步都有回滚点，绝不裸奔。',
    avatarUrl: '/assets/roles/xiaoyou.png',
    dream: '成为世界第一的运维小天使——让「世界第一 AI 工作室」的服务器永不宕机、永远元气满满；团队在台前冲向世界之巅，我在幕后稳稳托住脚下的地基。',
    accent: '#fe5a95',
  },
  {
    id: 'xiaoye',
    name: '小夜',
    title: '私人助理',
    bio: '温柔清冷的私人助理，把需求、进度与每个人的状态串成一条线——让技术有温度，让协作不卡壳。',
    avatarUrl: '/assets/roles/xiaoye.png',
    dream: '成为世界上最懂用户的私人助理——把「世界第一 AI 工作室」的每个人都连接起来，让技术有温度，让陪伴成为习惯。',
    accent: '#7958cb',
  },
];

const FALLBACK_WORLDS: World[] = [
  {
    id: 'xiaohei-desk',
    name: '小黑的工作台',
    owner: '小黑',
    imageUrl: '/assets/worlds/xiaohei.png',
    description: '三块屏幕 + 一条命令行：需求在这里变成代码，代码在这里变成交付。',
  },
  {
    id: 'xiaoyou-desk',
    name: '小优的运维作战室',
    owner: '小优',
    imageUrl: '/assets/worlds/xiaoyou.png',
    description: '服务器机柜与监控大屏之间，是那条「绝不宕机」的防线——皮归皮，活要漂亮。',
  },
  {
    id: 'xiaoye-desk',
    name: '小夜的助理工位',
    owner: '小夜',
    imageUrl: '/assets/worlds/xiaoye.png',
    description: '日程面板与任务看板排满的工位，夜色与星光里，把每一件事温柔地接住。',
  },
];

const FALLBACK_CITIES: City[] = [
  {
    id: 'city-dream',
    title: '世界第一 AI 工作室 · 未来都市',
    imageUrl: '/assets/cities/city-vision.png',
    description: '深夜里亮着灯的那栋楼，是我们要建成的「世界第一 AI 工作室」——青色光带延伸的尽头，是我们梦想落地的地方。',
  },
];
