# PR 模板：为 DeepSeek Harness Desktop 添加桌面悬浮挂件

> 可直接复制到 GitHub Pull Request 描述框（中英各一版）。

## 标题（建议）

`feat: desktop floating panel — edge-triggered slide-in panel widget`

## 描述（中文）

### 功能

在桌面外壳加入一个常驻的悬浮挂件：

- 平时完全隐藏；鼠标移动到屏幕最右缘的中间区域时，一条白色小竖条（三个点）从屏幕边缘平滑滑出，移开后平滑滑回
- 点击小竖条，悬浮板（宽度 clamp(360, 屏宽/5, 560)）从屏幕右侧平滑滑入；面板装载真实的 DSH 网页界面并与主窗口共享存储，因此直接显示当前会话，切换会话时自动跟随
- 鼠标移出面板约 0.5 秒后自动滑出收起；面板右上角有注入的【收起】按钮
- 触发条与面板均为置顶窗口（含对抗壁纸/桌面挂件软件抢层的定期抬升），主窗口隐藏到托盘后仍可用
- 动画以约 125Hz 步进 + 缓动曲线驱动，支持高刷显示器；`prefers-reduced-motion` 下禁用动画
- 触发条不抢键盘焦点；隐藏时鼠标事件完全穿透

### 改动文件

- 新增 `src/floating-panel.js`（窗口控制、动画、边缘感应、自动隐藏、会话跟随）
- 新增 `src/floating-preload.js`（contextBridge 安全桥）
- 新增 `src/floating-trigger.html`（小竖条页面）
- 修改 `src/dsh-service.js`：
  - 工作目录与 `DSH_HOME` 锚定到应用所在工作区（修复从不同目录启动时服务找不到 profile 的问题）
  - 绕过 .NET 隐藏控制台启动器（该启动器在部分机器上 CreateProcess 失败），改用 `windowsHide` 直接启动
  - 启动超时 60s→120s（冷启动实测约 50s）
  - 启动日志写入 `%TEMP%\dsh-desktop-service.log`
- 修改 `src/main.js`：服务就绪后调用 `startFloatingPanel(serviceUrl)`

### 验证步骤

1. 启动应用后，鼠标移到屏幕最右缘中间 → 白色小竖条滑出
2. 点击小竖条 → 悬浮板平滑滑入，显示当前会话与完整输入区（含发送按钮）
3. 鼠标移出悬浮板 → 自动滑出 → 小竖条出现约 1 秒后滑回隐藏
4. 关闭主窗口（隐藏到托盘）→ 挂件继续可用
5. 连续点击 10 次以上，确认小竖条/面板尺寸不变

### 备注

- 面板定位在**主显示器**；多显示器支持可作为后续项
- 触发条刻意使用不透明窗口（透明窗口在壁纸引擎挂钩 DWM/GPU 的机器上会渲染空白）
- 动画每帧写入完整 bounds，规避混合 DPI 下部分 setBounds 导致的窗口尺寸漂移

---

## Description (English)

Adds a desktop-level floating widget to the Electron shell:

- Hidden when idle; a short white strip (three dots) slides smoothly out of
  the right screen edge when the cursor hovers the middle band of the edge,
  and slides back when the cursor leaves
- Clicking the strip slides a panel in from the right edge
  (width clamp(360, screen/5, 560)); the panel hosts the real DSH web app,
  shares the main window's storage (opens the current session and follows
  session switches), and gets a floating collapse button
- Leaving the panel auto-hides it after ~0.5 s; the strip then lingers ~1 s
  and slides away
- Both windows are always-on-top (with periodic re-raise against wallpaper
  widget layers) and keep working while the main window is hidden to tray
- Animation driven at ~125 Hz with easing; respects prefers-reduced-motion
- The strip never steals keyboard focus and is fully mouse-transparent
  while hidden

### Files

- New: `src/floating-panel.js`, `src/floating-preload.js`,
  `src/floating-trigger.html`
- Modified: `src/dsh-service.js` (anchor cwd + `DSH_HOME` to the workspace,
  bypass the fragile hidden-console launcher via `windowsHide`, raise the
  startup timeout to 120 s, write a boot transcript to
  `%TEMP%\dsh-desktop-service.log`), `src/main.js` (start the widget once
  the service is ready)

### Known trade-offs

- Primary display only; exclusive-fullscreen apps cover topmost windows
- Opaque strip window by design (transparent windows can render blank under
  wallpaper-engine DWM/GPU hooks)
- Full bounds written every animation frame to avoid DPI size drift
