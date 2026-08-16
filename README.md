# ✒️ 阅批 —— PDF 手写批注 + 无限白板 + 多 AI 助手（网页版 + Android 原生渲染）

一款面向**平板**的本地笔记应用：PDF 阅读与手写批注、无限白板、多提供商 AI 问答，在同一张"纸"上完成。
暖黄纸面主题（可换背景色）、数据只存本机、无广告、无云端、完全免费。

> **双引擎架构**：网页版（浏览器）用 pdf.js 渲染；**Android APK 用系统内置 PdfRenderer 原生渲染**（快、稳定、16KB 兼容）。同一套 React 代码，两端自动切换。

---

## ✨ 功能一览

### 📄 PDF 阅读 + 手写批注
- 导入 PDF（网页版本机文件 / **APK 系统文件选择器，大文件直存原生**）
- 触控笔/手指书写，**压力感应粗细**；画笔 / 荧光笔 / 橡皮 / 撤销重做
- 工具按钮随所选工具切换（画笔/荧光笔/橡皮）
- **渲染精度可调**（工具栏 💠 按钮：1.5x~4x，跟随屏幕像素密度；批注层同步）
- **✂️ 框选发 AI**：拖拽框选任意区域，松手即把截图发给 AI
- 导出：带批注 PDF（pdf-lib 压平）或当前页 PNG
- 跳页、**自动记忆阅读位置**；虚拟滚动 + 位图缓存，长文档流畅

### 🧻 白板（叠加 & 独立）
- 无限画布（tldraw）：画笔/荧光笔/文字/插入图片
- **叠加模式**：PDF 上方半透明草稿白板；PDF 页截图一键导入白板

### 🤖 AI 助手（多提供商 + 双路由）
- 应用内对话：文字 + 图片提问（截图/框选/拍照/相册/Ctrl+V/拖拽），流式回答、聊天历史
- **4 个固定提供商**：DeepSeek / 豆包（火山方舟）/ 硅基流动 / 智谱AI——接口地址自动填充，只需填 API Key
- **双路由**：文字提问与图片提问可分别指定提供商（自动 / 手动）
- 悬浮 / 分屏面板（可拖动/缩放）；内嵌网页版入口（禁止内嵌的网站引导用小窗口/浏览器打开）
- 无 API Key 也能用：一键打开各平台网页版

### 🎨 界面
- 暖黄纸面主题，**背景颜色可换**（纸黄/米白/浅绿/浅蓝，整套 UI 换色）
- 顶栏/侧栏/工具栏均可收起；窄屏侧栏自动变浮层
- 设置界面：外观 / 4 提供商 Key 与模型 / 双路由 / 历史对话
- AI 面板精简设置：AI 路由 + 对话选择/删除

---

## 🛠 技术栈

Vite 5 · React 18 · TypeScript · pdf.js 3.11（网页引擎，Blob 内联 Worker）· pdf-lib · tldraw 2.x · IndexedDB(idb) · vite-plugin-pwa · marked + DOMPurify · **Capacitor 8 + Android PdfRenderer（APK 原生引擎）**

## 🏗 架构（双渲染引擎）

```
src/core/renderEngine.ts   ← 统一渲染接口（PdfViewer 只依赖它）
  ├─ APK（Capacitor WebView）→ NativeEngine：Capacitor 插件 → Android 系统 PdfRenderer
  │    渲染/尺寸/大文件导入/导出字节 全走原生；文本提取用 pdf.js（原生无文本 API）
  └─ 浏览器/网页 → PdfJsEngine：pdf.js（Blob 内联 Worker，file:// 与 https 均可用）
```

- 页面尺寸一次到位（APK 原生秒出全部尺寸），批注坐标直接映射 PDF points
- 两级渲染（低清快速上屏 → 高清升级）、LRU 位图缓存、虚拟滚动
- 渲染失败自动降档重试，不会出现"某页空白"

## 📁 目录结构

```
src/
  main.tsx / polyfills.ts / App.tsx / styles.css
  core/
    renderEngine.ts   # 双引擎抽象（APK 原生 / 网页 pdf.js）
    pdfEngine.ts      # pdf.js 引擎实现（网页端）
    db.ts             # IndexedDB（批注/白板/对话/设置）
    types.ts / annotate.ts / exportPdf.ts / md.ts / download.ts
    ai/               # providers.ts（4 提供商 + 流式调用）/ chat.ts（双路由）
  ui/
    PdfViewer.tsx     # PDF 阅读 + 批注 + 框选发 AI（虚拟滚动 + 缓存）
    WhiteboardView.tsx / ChatPanel.tsx / ChatSettingsModal.tsx
    SettingsModal.tsx / FileSidebar.tsx / ErrorBoundary.tsx
android/              # Capacitor 原生工程（android 分支）
  app/src/main/java/com/yuepi/app/YuepiPDFPlugin.java  # 原生 PDF 插件
scripts/              # 图标 / CMap / 静态服务器
```

## 🚀 快速开始（网页版开发 / 构建）

要求：Node.js ≥ 18

```bash
npm install
npm run dev        # 本地开发 http://localhost:5173
npm run build      # 产出 dist/（PWA 离线缓存 + 中文 CMap）
npm run preview    # 预览构建产物
```

> 产物是 ES Module，必须通过 HTTP 打开（GitHub Pages / 局域网 serve 等）。

## 📱 Android 打包（APK）

见 **[BUILD-ANDROID.md](BUILD-ANDROID.md)**：用 Android Studio 打开 `android/` 目录直接构建。
（原生引擎为系统 PdfRenderer，无第三方 .so，天然兼容 Android 15+ 16KB 页面设备。）

## 🌿 分支说明

| 分支 | 内容 |
|---|---|
| `main` | 网页版完整源码（含双引擎 JS，不含 `android/` 原生目录） |
| `android` | 网页版 + Android 原生工程（从这里用 Android Studio 打包） |
| `gh-pages` | 网页版构建产物（GitHub Pages 部署源：https://179261.github.io/YuePi/） |

## ⚙️ AI 配置

打开应用 → ⚙️ 设置：
1. **DeepSeek**：platform.deepseek.com 创建 Key；模型 `deepseek-v4-flash`（默认，支持图片提问）/ `deepseek-v4-pro`
2. **豆包**：console.volcengine.com/ark 创建 Key；模型填视觉模型名或接入点 `ep-xxx`
3. **硅基流动**：cloud.siliconflow.cn 创建 Key（接口地址已自动填充）
4. **智谱AI**：open.bigmodel.cn 创建 Key（接口地址已自动填充）
5. 每项可「测试连接」；文字/图片提问可分别路由到不同提供商（自动 / 手动）

费用：应用免费；AI 用你自己的 Key 按量计费。

## 🔒 隐私说明

- 所有文件（PDF、批注、白板、对话、设置）只存本机（IndexedDB + APK 私有目录），**不上传任何内容**
- AI 请求直接发往你配置的官方 API；API Key 仅存本机
- 应用开源可审查

## ❓ 常见问题

| 问题 | 解决 |
|---|---|
| APK 里网页版小窗口没反应 | WebView 不支持 window.open；建议配置 API Key 或用系统浏览器打开 |
| 加密 PDF 打不开（APK） | PdfRenderer 不支持加密 PDF；网页版可用 pdf.js 打开 |
| 导入大文件（APK） | 走系统文件选择器直存原生，不占 WebView 内存 |
| 界面还是旧版 | 清站点数据 / 重新部署（Service Worker 缓存） |

---

*阅批 —— 让 PDF 阅读、书写与 AI 在同一张"纸"上完成。*
