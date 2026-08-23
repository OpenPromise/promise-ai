/**
 * 首页（Studio Editorial / 方向 A）静态文案与素材配置。
 *
 * 数据来源约定（DESIGN_SPEC §6.11）：
 * - 品牌名、H1、素材 URL 与情报/角色/世界/都市内容均来自项目已有内容与现有 API 数据，
 *   不在本文件复制 Role/News/World/City 字段；
 * - 带「建议/推断」注释的文案来自 DESIGN_SPEC §2.3 / §6.3 的推荐措辞，
 *   正式上线前需内容负责人确认（见 DESIGN_SPEC §15 待外部研究清单）；
 * - 禁止在此添加客户案例、服务范围、招聘、SLA、在线率等无项目证据的内容。
 */

export const HOME_CONTENT = {
  /** 首屏 H1：团队正式名称（与导航/加载页一致） */
  headline: '世界第一 AI 工作室',
  /** 首屏 kicker（装饰性辅助，不承担唯一语义） */
  heroKicker: 'AI° STUDIO',
  /**
   * 工作方式说明（建议/推断文案，DESIGN_SPEC §2.3 推荐措辞，需内容确认）。
   * 只描述已确认的协作结构（工程、运维、助理），不写未经证实的能力承诺。
   */
  heroSub: '工程、运维与助理协作，把想法推进到可交付状态。',
  /** 主 CTA（动作文字，指向角色板块；每屏只保留一个主 CTA） */
  primaryCta: '认识团队',
  primaryCtaTarget: 'roles',
  /** 次级入口（低干扰文字链接，指向情报板块） */
  secondaryLink: '查看最新动态',
  secondaryLinkTarget: 'news',
  /** 首屏章节索引（纯装饰，告知还有内容） */
  heroIndex: '01 / 05',
  /** Hero 视频与 poster（现有素材，poster 同时是视频失败/减动效时的降级背景） */
  videoUrl: '/assets/videos/home-video.mp4',
  posterUrl: '/assets/cities/city-vision.png',

  /** 团队目录区块（People index） */
  people: {
    kicker: 'TEAM INDEX',
    title: '团队目录',
    /** 区块说明（建议/推断，需内容确认） */
    desc: '工程、运维与助理——三个角色，一套协作。点击条目进入角色介绍。',
    /** 条目进入动作文字 */
    cta: '查看角色',
  },

  /** 最新情报区块（Selected signal：一条真实动态作为工作证据） */
  signal: {
    kicker: 'LATEST SIGNAL',
    title: '最新情报',
    /** 区块说明（建议/推断，需内容确认） */
    desc: '一条来自项目内的真实动态，作为「不是只有口号」的工作证据。',
    /** 进入情报板块的动作文字 */
    cta: '查看全部情报',
    /** 加载中（结构占位，说明正在读取动态） */
    loading: '正在读取动态…',
    /** 空状态（现有数据为空时显示，并提供去角色/世界的下一步） */
    empty: '暂时没有新的动态。',
  },

  /** 工作场景区块（Working worlds） */
  worlds: {
    kicker: 'WORKING WORLDS',
    title: '工作场景',
    /** 区块说明（建议/推断，需内容确认） */
    desc: '成员各自的工作空间：工作对象不同，交付标准一致。',
    /** 进入世界板块的动作文字 */
    cta: '进入世界全景',
    loading: '加载中…',
    empty: '暂时没有工作场景内容。',
  },

  /** 未来都市愿景收束（Mission horizon：愿景，不是当前现状） */
  mission: {
    /** kicker 明确「愿景/未来」语义，与当前工作证据区分 */
    kicker: 'VISION · NEXT',
    note: '未来愿景',
    loading: '加载中…',
    empty: '愿景内容暂未就绪。',
    /** 进入都市映像板块的动作文字（低干扰） */
    cta: '都市映像',
  },

  /** 团队目录加载态文案（复用现有「加载中…」惯例） */
  loading: '加载中…',
} as const;
