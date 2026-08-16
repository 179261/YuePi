# 阅批 · Android 原生 PDF 渲染版构建说明

> 架构：**双渲染引擎** —— APK 里 PDF 页面由 **Android 系统内置 PdfRenderer** 渲染（原生 Skia，快且稳定，
> 不占用 WebView canvas，天然兼容 16KB 页面设备）；浏览器/网页版仍用 pdf.js。
> 所有 UI（工具栏/批注/侧栏/AI/白板/设置）共用一套 React 代码。

## 目录结构

```
android/                      # Capacitor 原生 Android 工程
  app/src/main/java/com/yuepi/app/
    MainActivity.java          # 入口（注册 YuepiPDF 插件）
    YuepiPDFPlugin.java        # 原生 PDF 引擎插件（PdfRenderer：打开/尺寸/渲染/字节/文件导入）
  app/build.gradle             # 无第三方原生依赖（系统 PdfRenderer），APK 小、16KB 兼容
src/core/renderEngine.ts       # 双引擎抽象：APK→原生，网页→pdf.js（PdfViewer 只依赖此接口）
src/ui/SettingsModal.tsx       # 设置：背景主题 + AI 路由（按需显示配置）
src/ui/ChatSettingsModal.tsx   # AI 助手页精简设置（路由 + 对话管理）
```

## 首次构建（Android Studio）

1. 安装 [Android Studio](https://developer.android.com/studio)（含 Android SDK / JDK 17）
2. 用 Android Studio 打开本项目下的 **`android/`** 目录（不是项目根目录）
3. 等待 Gradle 同步完成（无第三方依赖，同步很快）
4. 连接平板（开启 USB 调试）→ 点 Run ▶ 直接装机测试；
   或 Build → Build APK(s) → 生成 `android/app/build/outputs/apk/` 下的 APK

> ✅ 使用系统 PdfRenderer 后，不再有 Pdfium 的 .so 文件，**不会出现 "not compatible with 16 KB devices" 警告**。

## 更新网页代码后重新打包

```bash
npm run build                 # 构建最新 dist
npx cap sync android          # 把 dist 同步进 android 工程
# 回到 Android Studio 重新 Run / Build
```

## 原生 PDF 插件能力（YuepiPDFPlugin）

| 方法 | 说明 |
|---|---|
| `open({ data })` | 打开 PDF（base64，中小文件）→ PdfRenderer 解析 |
| `getInfo()` | 页数 + 全部页面尺寸（PDF points，直接映射批注坐标） |
| `renderPage({ page, scale })` | 渲染页面 → JPEG base64 交给网页显示 |
| `pickFile()` | **系统文件选择器**：选择 PDF → 复制到 app 私有目录 → 返回 { id, name, size, path }（大文件导入走这里，不经 base64/IndexedDB） |
| `openByPath({ path })` | 按绝对路径打开（原生直接读文件）→ 返回页数 + 尺寸 |
| `getBytes()` | 返回原始 PDF 字节（导出带批注 PDF 用） |
| `deleteFile({ path })` | 删除 app 私有目录里的 PDF 文件（删除文档时） |
| `close()` | 释放文档 |

> 文本提取（"发 AI 文字"）由网页端 pdf.js 完成（PdfRenderer 无文本 API；数据在 JS 侧，仅解析文本不渲染）。

## 大文件导入说明

- **APK**：点「导入 PDF」→ 原生系统文件选择器 → 文件直存 app 私有目录（`files/docs/`），IndexedDB 只存元数据——**几百 MB 的 PDF 也不占 WebView 内存**
- **网页**：浏览器文件选择器 → 存 IndexedDB（原有逻辑）

## 已知限制

- **加密 PDF**：系统 PdfRenderer 不支持加密 PDF（打开会提示失败）。有密码保护的 PDF 需转出密码或用其他工具
- **文本提取依赖 pdf.js**：发 AI 文字时需要 JS 侧有 PDF 字节（大文件导入的文档，文本提取会临时读原生文件）

## 注意事项

- **精度**：APK 默认 2x，工具栏 💠 按钮可调 1.5~4x（PdfRenderer 原生渲染很快，可放心调高）
- **渲染策略**：当前页 ±1 预渲染 + 位图缓存，翻页零等待；滚动时低清跟随
- **设置**：背景主题（整套 UI 换色）+ AI 路由（DeepSeek/火山方舟/硅基流动/智谱AI/其它，选中才显示配置）
- **批注/白板/AI**：与网页版完全一致，数据存本机 IndexedDB
- **旧 APK 卸载重装**（避免旧 Service Worker 缓存干扰）

## 诊断

- 渲染失败会在页面上弹出提示（含页号）
- 网页版（浏览器）自动走 pdf.js 引擎，不受本次改动影响
