/**
 * 情报速递右列宣传图轮播配置（集中管理，便于替换为真实团队生活照）。
 *
 * 参考站 .newsSwiper 轮播（926×468 设计稿，边框 6px #363636，标题条 + 分页点）。
 * 当前为 AI 生成的二次元动漫风团队生活照（doubao-seedream，2026-08；人设元素取自
 * characters/*.md 形象提示词原文 + 场景化描述，与角色立绘同款厚涂风格）；
 * 【替换方式】用户提供真实生活照后，把图片放入 public/assets/team/ 并修改下方 URL 即可，
 * 无需改动布局代码。图片建议 1280×720 左右（与轮播 16:9 比例一致）。
 */
export interface NewsCarouselSlide {
  /** 图片 URL（public 相对路径或外链均可） */
  imageUrl: string;
  /** 轮播标题条文字 */
  title: string;
}

export const NEWS_CAROUSEL_SLIDES: NewsCarouselSlide[] = [
  {
    imageUrl: '/assets/team/life-xiaohei-night.png',
    title: '深夜一起写代码',
  },
  {
    imageUrl: '/assets/team/life-xiaoyou-desk.png',
    title: '粉色工位元气值守',
  },
  {
    imageUrl: '/assets/team/life-xiaoye-balcony.png',
    title: '月光下的温柔陪伴',
  },
];
