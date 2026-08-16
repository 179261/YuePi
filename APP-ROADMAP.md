# 阅批 —— 打包为 Android APK / 鸿蒙应用的路线规划

> 目标：把当前 PWA 网页版打包为可安装的平板 App（Android APK 或鸿蒙 HAP）。
> 原则：**尽量零改造复用现有 Web 代码**，只在原生壳层做最小适配。

---

## 一、现状评估（哪些能直接用，哪些是风险点）

### ✅ 可以直接复用的
| 部分 | 说明 |
|---|---|
| React + TypeScript 业务代码 | 全部保留，壳层只是 WebView |
| pdf.js 3.11（经典 Worker） | Android WebView / 鸿蒙 ArkWeb 均为 Chromium 内核，完全兼容（当初回退 3.11 正是为了这个） |
| pdf-lib / tldraw / marked | 纯前端库，无 Node 依赖 |
| IndexedDB 本地存储 | WebView 原生支持，零改造 |
| PWA 离线资源（dist 全静态） | 打包时直接内嵌，天然离线 |
| AI 请求（直连官方 API） | WebView 可正常联网，API Key 仍只存本机 |

### ⚠️ 需要适配的风险点
| 风险 | 说明 | 对策 |
|---|---|---|
| **大 PDF 存 IndexedDB 容量** | Android WebView 的 IndexedDB 配额可能小于桌面浏览器（几百 MB 大文件可能超限） | 方案 A：继续用 IndexedDB（绝大多数场景够用）；方案 B：改用原生文件系统（见 §四） |
| **文件导入体验** | 网页版用 `<input type=file>`，WebView 里会调起系统文件选择器，能用但不"原生" | 可保留；进阶用 Capacitor DocumentPicker 插件 |
| **状态栏/全屏** | 需要沉浸式（隐藏系统状态栏、安全区适配） | 原生壳配置（Capacitor StatusBar 插件 / 鸿蒙沉浸式配置） |
| **鸿蒙 ArkWeb 加载本地资源** | 部分旧 ArkWeb 对 `file://` 下的 fetch/Worker 有限制 | 用 `rawfile` + `web.loadUrl` 或配置 WebView 权限（见 §五） |
| **Android 上架签名** | 需要签名 keystore（个人自用可直接侧载，不上架 Play） | 生成自签 keystore 即可 |

---

## 二、方案对比

| 方案 | 平台 | 工作量 | 说明 |
|---|---|---|---|
| **A. Capacitor（推荐首选）** | Android（可顺带 iOS） | 小 | 官方框架，`npx cap add android` 一条命令出壳，`dist/` 打包进 APK；生态成熟、文档全 |
| **B. 鸿蒙 ArkWeb 包装** | HarmonyOS | 中 | DevEco Studio 建 ArkTS 空工程，用 `Web` 组件加载内嵌 `dist/`；需要处理本地资源加载细节 |
| C. PWA + TWA | Android | 中 | 需要上架 Play 才完整，且要求 HTTPS 托管；与"本地优先"目标不符，不推荐 |
| D. Capacitor 鸿蒙社区适配 | HarmonyOS | 不确定 | 社区有 `@hmscore/capacitor-*` 等，但成熟度低，不建议作为主线 |

**结论：Android 走 Capacitor；鸿蒙走 ArkWeb 包装。两条线互不冲突，Web 代码完全共用。**

---

## 三、Android 路线（Capacitor，推荐先做）

### 前置
- Node.js（已有）
- Android Studio + Android SDK（需安装，免费）
- JDK 17

### 步骤
```bash
# 1. 项目内安装 Capacitor（仅开发依赖）
npm i -D @capacitor/cli @capacitor/core @capacitor/android

# 2. 初始化（appId 用你拥有的域名反写，如 com.yuepi.app）
npx cap init "阅批" com.yuepi.app --web-dir=dist

# 3. 构建网页产物 + 同步到原生工程
npm run build
npx cap sync android

# 4. 生成 android/ 原生工程后，用 Android Studio 打开：
#    - 配 App 图标/名称/主题色（android/app/src/main/res/）
#    - 生成签名 keystore（Build → Generate Signed Bundle/APK）
#    - 打包 APK 或 AAB

# 5. 装机：USB 调试或传 APK 侧载
npx cap run android   # 真机直接运行调试
```

### 预期改动量
- **Web 代码：零改动**（`dist/` 直接内嵌）
- 原生配置：图标、名称、签名（半天内可出包）

---

## 四、Android 进阶（可选，按需做）

| 功能 | 插件/方案 | 说明 |
|---|---|---|
| 系统文件选择器 | `@capacitor/filesystem` + `@capacitor/document-picker` | 比 `<input type=file>` 更"原生"的导入体验 |
| 大文件存储 | 改用 `Filesystem.writeFile` 存 PDF 到 App 私有目录，IndexedDB 只存元数据 | 绕开 IndexedDB 容量上限（当前 db.ts 需加一个"文件存储后端"抽象层） |
| 分享/导出 | `@capacitor/share` | 导出的 PDF/PNG 一键分享到其他 App |
| 数据备份 | 导出 IndexedDB 为文件 / `@capacitor/filesystem` 复制 | 换机迁移 |
| 状态栏沉浸 | `@capacitor/status-bar` | 全屏阅读体验 |

> 这些是**增量改造**：在 `src/core/db.ts` 与导入/导出处加一个"平台能力接口"，网页端走原逻辑、原生端走插件，互不影响。

---

## 五、鸿蒙路线（ArkWeb 包装，二选一）

### 方案 B1：ArkTS 空工程 + Web 组件（推荐）
1. DevEco Studio 新建 **Empty Ability** 工程（API 9+）
2. `npm run build` 产出 `dist/`，整体拷贝到 `entry/src/main/resources/rawfile/www/`
3. 页面用 `Web` 组件加载：
   ```ts
   Web({ src: $rawfile('www/index.html'), controller: this.controller })
     .javaScriptAccess(true)
     .domStorageAccess(true)          // IndexedDB 需要
     .fileAccess(true)                // 允许访问本地文件
     .allowFileAccess(true)
   ```
4. 注意点：
   - **Web Worker**：pdf.js 经典 worker 在 ArkWeb 加载本地资源，若 `new Worker(file://...)` 被限制，改在代码里把 worker 代码以 Blob 方式创建（`URL.createObjectURL`），或把 worker 内联进主 bundle（改动集中在 `pdfEngine.ts`）
   - **本地网络**：`Web` 组件默认可能限制本地加载，按官方文档配置 `fileAccess`/`allowFileAccess`
5. 签名：DevEco 自动签名（个人开发者）→ 打包 HAP 侧载

### 方案 B2：等 Capacitor 鸿蒙支持
- 社区适配进度不稳定，先以 B1 为主，B2 作为后续观察项

### 鸿蒙专属可加分项
- 用鸿蒙 ArkUI 写一个"最近文件"启动页，点击直接打开 App 内对应 PDF（通过 URL 参数 / 深链）

---

## 六、架构层面的准备（现在就可以低成本做的）

如果决定走原生路线，建议先把这些"平台能力"抽象出来，避免以后大改：

1. **存储抽象**（`src/core/db.ts` 内）
   - `storePdfBlob(pdfId, arrayBuffer)` / `loadPdfBlob(pdfId)`
   - 网页端实现 = IndexedDB；原生端实现 = Capacitor Filesystem（将来切换只需换实现，业务代码不动）
2. **文件导入**（`src/App.tsx`）
   - 抽出 `pickPdfFile(): Promise<{name, data}>`
   - 网页端 = `<input type=file>`；原生端 = DocumentPicker
3. **导出/分享**（`src/core/download.ts`）
   - 网页端 = a 标签下载；原生端 = Share 插件
4. **构建脚本**：`npm run build` 之后追加 `npx cap sync`（Android）与 rawfile 拷贝（鸿蒙）

> 这三处改动各约 20~40 行，纯增量，不破坏网页版。

---

## 七、推荐里程碑

| 阶段 | 内容 | 预估 |
|---|---|---|
| **M0（当前）** | 网页版功能与性能收尾（渲染精度可调已完成） | ✅ |
| **M1** | Android 出包：Capacitor 壳 + 图标/名称/签名，真机跑通全部功能 | 0.5~1 天 |
| **M2** | 原生体验增强：文件选择器 / 大文件存储 / 分享 | 1~2 天 |
| **M3** | 鸿蒙 HAP：ArkWeb 包装 + worker 本地加载适配 | 1~2 天 |
| **M4** | 打磨：启动屏 / 沉浸式 / 数据备份迁移 / 深链 | 按需 |

**建议顺序：M1 → M3 → M2 → M4**（先两个平台都能装上用起来，再做体验增强）。

---

## 八、一句话结论

> 现有 Web 代码几乎可以原样进壳：**Android 用 Capacitor 一条命令出 APK，鸿蒙用 ArkWeb 加载内嵌 dist**；真正需要动的只有三处小抽象（存储、导入、分享）和一个鸿蒙 worker 加载适配。先做 Android 出包验证全流程，再做鸿蒙。
