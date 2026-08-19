# Desktop UI（Siri 式桌面助理）

Electron 常驻客户端：极简半透明彩色光体（glowing orb）+ 动态粒子光晕，
支持全局热键与语音对话（复用 Agent Server 的 `/ws/voice` 链路）。

## 视觉设计规范

UI 提示词（设计方向，实现必须遵循）：

> Siri-inspired, futuristic luminous orb, glassmorphism, fluid gradient,
> ambient glow, reactive audio visualization, minimal desktop AI assistant UI

对应落地：

- **Siri-inspired**：常驻后台，极简唤醒式交互（idle 小光点 → 唤醒后放大）
- **futuristic luminous orb**：中央发光球体，多层渐变 + 高斯模糊 + 呼吸动画
- **glassmorphism**：玻璃拟态面板（半透明 + backdrop-blur + 细边框高光）
- **fluid gradient**：青/紫/粉流动渐变，色相缓慢旋转
- **ambient glow**：环境光晕（conic-gradient 旋转 + box-shadow 弥散）
- **reactive audio visualization**：麦克风音量实时驱动 orb 波动与粒子强度
- **minimal**：无按钮堆积，只保留 orb、状态文字与最小交互

```bash
npm run desktop:ui
```

配置（环境变量）：

- `AGENT_URL`：Agent Server 地址（默认 `http://127.0.0.1:3000`）
- `WAKE_HOTKEY`：全局唤醒热键（默认 `CommandOrControl+Alt+Space`）
