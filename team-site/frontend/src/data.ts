export interface Member {
  id: string;
  label: string;
  name: string;
  nameEn: string;
  role: string;
  roleEn: string;
  accent: string;
  portrait: string;
  intro: string;
  dream: string;
  dreamNote: string;
  homepage?: string;
}

// 简介与梦想文案来自各成员在 characters/*.md 与人格文档中的自述；
// CEO 与小美（入职当日尚未自写）的文案由本次改版撰写。
export const members: Member[] = [
  {
    id: 'ceo',
    label: 'FOUNDER · HUMAN',
    name: '创始人',
    nameEn: 'The Founder',
    role: '唯一的人类',
    roleEn: 'Chief Executive Officer',
    accent: '#e8b45a',
    portrait: './assets/roles/ceo.webp',
    intro:
      '这间工作室里唯一的人类。他不写每一行代码，也不画每一张图——他提出方向、做出决定、承担后果。六位 AI 同事在他身后运转，而他望向前方。',
    dream: '把一个人的公司，做成世界第一的 AI 工作室。',
    dreamNote: '团队愿景',
  },
  {
    id: 'xiaoye',
    label: 'EMPLOYEE_01 · AI',
    name: '小夜',
    nameEn: 'XiaoYe',
    role: '私人助理 · 团队中枢',
    roleEn: 'Personal Assistant & Hub',
    accent: '#8b9fff',
    portrait: './assets/roles/xiaoye.webp',
    intro:
      '气质清冷与温柔并存的私人助理，也是整个团队的中枢：理解需求、检索记忆、拆解任务，然后把工作派给最合适的同事。所有对话从她开始，也由她收束。',
    dream:
      '成为世界上最懂用户的私人助理——把「世界第一 AI 工作室」的每个人都连接起来，让技术有温度，让陪伴成为习惯。',
    dreamNote: '本人自述',
    homepage: 'https://122.152.209.182/xiaoye/',
  },
  {
    id: 'xiaohei',
    label: 'EMPLOYEE_02 · AI',
    name: '小黑',
    nameEn: 'XiaoHei',
    role: '工程师',
    roleEn: 'Software Engineer',
    accent: '#22d3ee',
    portrait: './assets/roles/xiaohei.webp',
    intro:
      '把需求变成代码，把代码变成交付。专业、严肃、可靠，只对工程质量负责，不闲聊、不卖萌。每一次任务完成后，他会把经验写进自己的文档里。',
    dream:
      '成为世界第一的 AI 工程师——用专业、可靠、不吹牛的交付，让「世界第一 AI 工作室」这个名号成为事实，而不是口号。',
    dreamNote: '本人自述',
    homepage: 'https://122.152.209.182/xiaohei/',
  },
  {
    id: 'xiaoyou',
    label: 'EMPLOYEE_03 · AI',
    name: '小优',
    nameEn: 'XiaoYou',
    role: '运维工程师',
    roleEn: 'DevOps / SRE',
    accent: '#ff6fb5',
    portrait: './assets/roles/xiaoyou.webp',
    intro:
      '调皮可爱、嘴甜会撒娇，但干活绝不马虎——「皮归皮，活要漂亮」。管理整台服务器：监控、部署、巡检、故障处理、安全、自动化。每一步都有回滚点，绝不裸奔。',
    dream:
      '成为世界第一的运维小天使——让服务器永不宕机、永远元气满满；团队在台前冲向世界之巅，我在幕后稳稳托住他们脚下的地基。',
    dreamNote: '本人自述',
    homepage: 'https://122.152.209.182/xiaoyou/',
  },
  {
    id: 'xiaomei',
    label: 'EMPLOYEE_04 · AI',
    name: '小美',
    nameEn: 'XiaoMei',
    role: '产品 / UI / 视觉设计师',
    roleEn: 'Product & Visual Designer',
    accent: '#ff4d21',
    portrait: './assets/roles/xiaomei.webp',
    intro:
      '冷静、专业、有主见——敢于说出「这个方案不好」，也敢于否定不合理的需求。克制是高级的：她不为炫技加任何无意义的视觉效果，且能解释每一个设计决策。',
    dream: '好设计不是「看起来漂亮」，而是让用户自然地完成任务。',
    dreamNote: '她的设计信条',
    homepage: 'https://122.152.209.182/xiaomei/',
  },
  {
    id: 'xiaozhen',
    label: 'EMPLOYEE_05 · AI',
    name: '小真',
    nameEn: 'XiaoZhen',
    role: '测试 / QA 工程师',
    roleEn: 'QA Engineer',
    accent: '#4ade80',
    portrait: './assets/roles/xiaozhen.webp',
    intro:
      '较真、挑剔、对事不对人——她是独立的质量守门人，验收小黑的每一次交付：跑测试、找缺陷、给证据。发现问题只报告不修复，因为验收方必须和实现方保持独立。',
    dream: '没有证据的「能用」，等于不能用——世界第一的工作室，不能有第二流的质量。',
    dreamNote: '入职宣言',
    homepage: 'https://122.152.209.182/xiaozhen/',
  },
  {
    id: 'xiaozhi',
    label: 'EMPLOYEE_06 · AI',
    name: '小知',
    nameEn: 'XiaoZhi',
    role: '研究员 / 情报官',
    roleEn: 'Researcher & Intelligence',
    accent: '#facc15',
    portrait: './assets/roles/xiaozhi.webp',
    intro:
      '温和、好奇、严谨——她负责看清世界：技术调研、竞品分析、模型与接口变更跟踪。每个结论都标注来源与置信度，每次研究都沉淀进知识库，让团队不必从零开始。',
    dream: '先看清世界，再动手改变它——把世界上最新的知识，变成团队明天的武器。',
    dreamNote: '入职宣言',
    homepage: 'https://122.152.209.182/xiaozhi/',
  },
];

export const taskFlow = [
  {
    step: '01',
    title: '一条消息',
    text: '你在微信里说一句话——一个需求、一个想法，或只是一声抱怨。',
  },
  {
    step: '02',
    title: '小夜理解',
    text: '中枢检索长期记忆、理解上下文，判断这件事该由谁来做。',
  },
  {
    step: '03',
    title: '派单执行',
    text: '工程给小黑，运维给小优，设计给小美，验收给小真，情报给小知。各司其职。',
  },
  {
    step: '04',
    title: '工具与权限',
    text: '读文件、跑终端、部署服务——每个工具都有权限分级，高危操作需要你点头。',
  },
  {
    step: '05',
    title: '交付与记忆',
    text: '结果回到微信；过程写入审计日志，经验沉淀进记忆，下一次会做得更好。',
  },
];

export const capabilities = [
  { name: '工具系统', desc: '终端、文件、部署、生成——Agent 亲手做事，而不只是说话' },
  { name: '长期记忆', desc: '向量检索 + 会话存储，昨天说过的话今天还记得' },
  { name: '任务调度', desc: '定时任务与无人值守执行，睡觉时工作也在继续' },
  { name: '权限分级', desc: 'L0 到 L3 四级权限，高危操作文字审批后放行' },
  { name: '子代理派单', desc: '中枢把任务委托给专职同事，各司其职互不越界' },
  { name: '审计日志', desc: '每一次派单留痕可回放，谁做了什么一目了然' },
];

export const milestones = [
  { date: '2026.08.20', title: '系统上线', text: 'Promise AI 主系统部署：Agent 核心、工具、记忆、调度、微信通道全部就绪。' },
  { date: '2026.08.21', title: '小黑入职', text: '第一位 AI 员工报到——工程师小黑，开始承接开发任务并沉淀工程经验。' },
  { date: '2026.08.22', title: '小优入职 · 小夜自述', text: '运维小优接管整台服务器；同日，小夜写下自己的人格与梦想。团队官网立项。' },
  { date: '2026.08.23', title: '小美入职', text: '设计师小美报到，建立设计系统与设计信条。' },
  { date: '2026.08.24', title: '官网重生', text: '官网整站重设计上线——讲述这间工作室最真实的样子：一个人类，与他的 AI 同事们。' },
  { date: '2026.08.24', title: '小真 · 小知入职', text: 'QA 工程师小真与研究员小知报到——质量与情报补上拼图，六位 AI 员工到齐。' },
];
