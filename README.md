# ✒️ 阅批 —— PDF 手写批注 + 无限白板 + 多 AI 助手

一款面向 平板 的本地网页应用（PWA）。暖黄纸面主题，所有数据只存在本机，无广告、无云端、完全免费。

---

## ✨ 功能一览

### 📄 PDF 阅读 + 手写批注
- 导入 PDF（本机存储），触控笔/手指直接书写，**压力感应粗细**
- 画笔 / 荧光笔 / 橡皮 / 撤销 / 重做；工具栏可折叠、可随滚动自动隐藏
- **✂️ 框选发 AI**：在页面上拖拽框选任意区域，松手即把该区域截图发给 AI
- 导出：**带批注的 PDF** 或当前页 **PNG**
- 跳页输入框、**自动记忆阅读位置**（下次打开回到原页）
- 窗口化渲染 + 分档清晰度 + 离屏高清升级：长文档流畅、翻页不白屏

### 🧻 白板（叠加 & 独立）
- 无限画布（tldraw）：画笔/荧光笔/文字/插入图片
- **叠加模式**：在 PDF 上方显示半透明草稿白板（「🧻 白板」开关）
- PDF 页截图一键导入白板（「📋 到白板」）

### 🤖 AI 助手（多提供商 + 双路由）
- **应用内对话**：文字提问 + 图片提问（截图 / 框选 / 拍照 / 相册 / **Ctrl+V 粘贴** / 拖拽），流式回答、聊天历史
- **提供商**：DeepSeek、豆包（火山方舟）、自定义①（如硅基流动）、自定义②（如智谱AI）——全部 OpenAI 兼容，可手填任意平台
- **双路由**：文字提问与图片提问可**分别指定**走哪个提供商（自动 / 手动）
- **悬浮 / 分屏**：AI 面板可停靠右侧（可调宽）或悬浮（可拖动/缩放）
- **网页版内嵌**：「🌐 网页版」标签内嵌打开各平台网页版（禁内嵌的网站会引导用小窗口打开）
- 无 API Key 也能用：一键打开豆包 / DeepSeek 网页版

### 🎨 界面
- 暖黄纸面主题（纸 + 墨 + 琥珀），顶栏/侧栏/工具栏均可收起
- 竖屏窄屏下侧栏自动变浮层，可随时呼出

---

## 🚀 快速开始（开发 / 构建）

要求：Node.js ≥ 18

```bash
npm install
npm run dev        # 本地开发 http://localhost:5173
npm run build      # 产出 dist/（含 PWA 离线缓存与中文 CMap）
npm run preview    # 本地预览构建产物
```

## 📱 部署到平板（三选一）

> 产物是 ES Module，**必须通过 HTTP 打开**，不能双击本地文件。

| 方案 | 做法 | 适合 |
|---|---|---|
| **A. 免费静态托管**（推荐） | `npm run build` → 把 `dist/` 拖到 GitHub Pages / Netlify / Vercel → 平板浏览器打开 → 「添加到桌面」变独立应用 | 一劳永逸 |
| **B. 局域网直连** | 电脑执行 `npx serve dist`（或 `python -m http.server 8080 -d dist`）→ 平板同 Wi-Fi 打开 `http://电脑IP:8080` | 无需注册，临时用 |
| **C. 自有服务器 / NAS** | 把 `dist/` 放到任意静态站点目录 | 长期自托管 |

> 💡 更新版本后平板若显示旧界面：完全关闭标签页重开，或浏览器设置里清除该网站站点数据。

## ⚙️ AI 配置指南

打开应用 → 「⚙️ 设置」：

1. **DeepSeek**：到 [platform.deepseek.com](https://platform.deepseek.com) 创建 Key。模型可用 `deepseek-chat` / `deepseek-reasoner` / `deepseek-4v-flash`（视觉）/ `deepseek-pro`，也可手填
2. **豆包**：到 [console.volcengine.com/ark](https://console.volcengine.com/ark) 创建 Key，模型填视觉模型名或接入点 `ep-xxx`
3. **自定义①**：如硅基流动（默认预填 `https://api.siliconflow.cn/v1`，模型 `deepseek-ai/DeepSeek-V3`）、Kimi、OpenRouter 等任意 OpenAI 兼容平台
4. **自定义②**：如智谱AI（默认预填 `https://open.bigmodel.cn/api/paas/v4`，模型 `glm-4-flash`）
5. **提问路由**：分别设置「文字提问 → 路由到」与「图片提问 → 路由到」（自动链：文字 DeepSeek→①→②→豆包；图片 豆包→DeepSeek视觉→①视觉→②视觉）
6. 每项可「测试连接」

费用：应用免费；AI 用你自己的 Key 按量计费（DeepSeek 极便宜、豆包/硅基流动新用户有免费额度）。

## 📖 使用小贴士

- **批注**：PDF 工具栏「✏️ 画笔 ▾」展开选画笔/荧光笔/橡皮、颜色、粗细；再点一次当前工具或点「👆」回到阅读滚动模式
- **滚动自动隐藏工具栏**：向下滑动收起，向上滑动恢复；顶栏「📄 ▾」也可手动切换
- **发 AI**：工具栏「🤖 发AI ▾」→ 当前页截图 / 本页文字 / 全文文字；或「✂️ 框选发AI」拖框选区域
- **保存位置**：自动记录，重开同 PDF 回到原页；也可输入页码 + GO 直接跳转
- **白板叠加**：PDF 工具栏「🧻 白板」在页面上方开半透明草稿层；「📋 到白板」把当前页截图存成新白板
- **悬浮 AI**：面板右上「🪟 / 📐」切换悬浮与分屏；悬浮窗口可拖头移动、拖右下角缩放

## 🔒 隐私说明

- 所有文件（PDF、批注、白板、对话、设置）只存本机浏览器的 IndexedDB，**不上传任何内容**
- AI 请求直接发往你配置的官方 API 接口；API Key 仅存本机
- 应用开源可审查

## 📁 目录结构

```
src/
  main.tsx              # 入口（polyfill → 错误边界 → 应用）
  polyfills.ts          # 旧浏览器 API 补丁（withResolvers 等）
  App.tsx               # 主框架：文件管理 / 视图切换 / AI 调度
  core/
    types.ts            # 数据类型（含 AI 设置与双路由）
    db.ts               # IndexedDB 存储（PDF 懒加载 / 阅读位置）
    pdfEngine.ts        # pdf.js v3 渲染（CMap 中文支持 / 画布封顶）
    annotate.ts         # 手写批注引擎（压感 / 荧光笔 / 橡皮 / 撤销）
    exportPdf.ts        # 批注压平导出（pdf-lib）
    ai/providers.ts     # DeepSeek / 豆包 / 自定义①② 客户端（流式）
    ai/chat.ts          # 提供商路由（文字/图片分离）/ 图文组装
    md.ts / download.ts # Markdown 渲染（XSS 净化）/ 下载工具
  ui/
    PdfViewer.tsx       # PDF 阅读 + 批注 + 框选发AI（窗口化渲染）
    WhiteboardView.tsx  # tldraw 白板（截图导入 / 截图发AI）
    ChatPanel.tsx       # AI 面板（对话 / 内嵌网页版 / 悬浮分屏）
    SettingsModal.tsx   # 设置（4 提供商 + 双路由 + 测试连接 + 诊断）
    FileSidebar.tsx     # 文件栏（PDF / 白板 / 对话，二次确认删除）
    ErrorBoundary.tsx   # 错误边界
scripts/
  make-icons.mjs        # 生成 PWA 图标
  prepare-cmaps.mjs     # 复制 pdf.js 中文 CMap 到构建产物
  serve.mjs             # 本地静态服务器（无依赖）
```

## 🛠 技术栈

Vite · React 18 · TypeScript · pdf.js 3.11（经典 Worker + 中文 CMap）· pdf-lib · tldraw 2.x · IndexedDB(idb) · vite-plugin-pwa（离线）· marked + DOMPurify

## ❓ 常见问题

| 问题 | 解决 |
|---|---|
| 平板导入大 PDF 崩溃 | 导入阶段已不做全文解析；超大文件（>80MB）会提示内存风险，建议拆分 |
| 翻页出现白页/黑页 | 已内置离屏升级与自愈重查；仍有问题请把「设置 → 诊断信息」发我 |
| DeepSeek/豆包网页版内嵌空白 | 网站禁止 iframe（X-Frame-Options），点「⧉ 小窗口打开」或配置 API Key |
| 图片提问失败 | 确认"图片路由"指向支持视觉的提供商（勾选视觉的自定义） |
| 界面还是旧版 | 清站点数据或换 URL（Service Worker 缓存） |

---

*阅批 —— 让 PDF 阅读、书写与 AI 在同一张"纸"上完成。*
