// ============ 设置弹窗（API Key / 模型 / 自定义提供商①② / 文字·图片双路由） ============
import { useState } from 'react'
import type { AISettings, AIProvider } from '../core/types'
import { CUSTOM2_MODELS, CUSTOM_MODELS, DEEPSEEK_MODELS, DOUBAO_MODELS } from '../core/types'
import { PROVIDERS, testConnection } from '../core/ai/providers'

const ALL_PROVIDERS: AIProvider[] = ['deepseek', 'doubao', 'custom', 'custom2']

interface Props {
  settings: AISettings
  onSave: (s: AISettings) => void
  onClose: () => void
  onToast: (msg: string) => void
}

export default function SettingsModal({ settings, onSave, onClose, onToast }: Props) {
  const [draft, setDraft] = useState<AISettings>({ ...settings })
  const [testing, setTesting] = useState<AIProvider | null>(null)

  const set = (patch: Partial<AISettings>) => setDraft((d) => ({ ...d, ...patch }))

  const doTest = async (p: AIProvider) => {
    setTesting(p)
    const r = await testConnection(p, draft)
    setTesting(null)
    onToast(r.ok ? `「${PROVIDERS[p].label(draft)}」连接成功：${r.message}` : `「${PROVIDERS[p].label(draft)}」失败：${r.message}`)
  }

  const open = (url: string) => {
    if (url) window.open(url, '_blank')
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>⚙️ 设置</span>
          <button className="tb-btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="settings-note">
            应用完全本地运行、无广告。AI 使用你自己的 API Key（DeepSeek 很便宜、火山方舟新用户送额度、硅基流动等也有免费额度）；
            不填 Key 也可用右下「网页版」入口。Key 仅保存在本机浏览器。
          </div>

          <h3>DeepSeek（文字理解 / 全文问答）</h3>
          <label className="field">
            <span>API Key（<a onClick={() => open(PROVIDERS.deepseek.signupUrl(draft))}>platform.deepseek.com</a> 获取）</span>
            <input type="password" value={draft.deepseekKey} placeholder="sk-…" onChange={(e) => set({ deepseekKey: e.target.value })} />
          </label>
          <label className="field">
            <span>模型（deepseek-4v-flash 等视觉模型支持图片提问；也可手填其它模型名）</span>
            <input type="text" list="deepseek-models" value={draft.deepseekModel} onChange={(e) => set({ deepseekModel: e.target.value })} />
            <datalist id="deepseek-models">
              {DEEPSEEK_MODELS.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>
          <div className="field-row">
            <button className="tb-btn act" disabled={testing === 'deepseek' || !draft.deepseekKey.trim()} onClick={() => void doTest('deepseek')}>
              {testing === 'deepseek' ? '测试中…' : '测试连接'}
            </button>
            <button className="tb-btn act" onClick={() => open(PROVIDERS.deepseek.webUrl(draft))}>打开 DeepSeek 网页版</button>
          </div>

          <h3>豆包 / 火山方舟（视觉模型，支持图片提问）</h3>
          <label className="field">
            <span>API Key（<a onClick={() => open(PROVIDERS.doubao.signupUrl(draft))}>console.volcengine.com/ark</a> 获取）</span>
            <input type="password" value={draft.doubaoKey} placeholder="…（火山方舟的 API Key）" onChange={(e) => set({ doubaoKey: e.target.value })} />
          </label>
          <label className="field">
            <span>模型 / 推理接入点（填模型名或 ep-xxx）</span>
            <select value={draft.doubaoModel} onChange={(e) => set({ doubaoModel: e.target.value })}>
              {DOUBAO_MODELS.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </label>
          <div className="field-row">
            <button className="tb-btn act" disabled={testing === 'doubao' || !draft.doubaoKey.trim()} onClick={() => void doTest('doubao')}>
              {testing === 'doubao' ? '测试中…' : '测试连接'}
            </button>
            <button className="tb-btn act" onClick={() => open(PROVIDERS.doubao.webUrl(draft))}>打开豆包网页版</button>
          </div>

          <h3>自定义提供商①（OpenAI 兼容，如硅基流动 / Kimi / OpenRouter）</h3>
          <label className="field">
            <span>显示名称（如"硅基流动"）</span>
            <input type="text" value={draft.customName} onChange={(e) => set({ customName: e.target.value })} />
          </label>
          <label className="field">
            <span>Base URL（硅基流动：https://api.siliconflow.cn/v1 ）</span>
            <input type="text" value={draft.customBaseUrl} placeholder="https://api.siliconflow.cn/v1" onChange={(e) => set({ customBaseUrl: e.target.value })} />
          </label>
          <label className="field">
            <span>API Key（<a onClick={() => open('https://cloud.siliconflow.cn')}>cloud.siliconflow.cn</a> 等平台获取）</span>
            <input type="password" value={draft.customKey} placeholder="sk-…" onChange={(e) => set({ customKey: e.target.value })} />
          </label>
          <label className="field">
            <span>模型（常用见建议列表）</span>
            <input type="text" list="custom-models" value={draft.customModel} onChange={(e) => set({ customModel: e.target.value })} />
            <datalist id="custom-models">
              {CUSTOM_MODELS.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>
          <label className="field row">
            <input type="checkbox" checked={draft.customVision} onChange={(e) => set({ customVision: e.target.checked })} />
            <span>该模型支持图片输入（视觉模型，如 Qwen2.5-VL；勾选后图片提问可走此提供商）</span>
          </label>
          <label className="field">
            <span>网页版地址（可选，用于「网页版」标签内嵌/打开）</span>
            <input type="text" value={draft.customWebUrl} placeholder="https://siliconflow.cn" onChange={(e) => set({ customWebUrl: e.target.value })} />
          </label>
          <div className="field-row">
            <button className="tb-btn act" disabled={testing === 'custom' || !draft.customKey.trim()} onClick={() => void doTest('custom')}>
              {testing === 'custom' ? '测试中…' : '测试连接'}
            </button>
            {draft.customWebUrl.trim() && (
              <button className="tb-btn act" onClick={() => open(draft.customWebUrl.trim())}>打开网页版</button>
            )}
          </div>

          <h3>自定义提供商②（OpenAI 兼容，如智谱AI / 通义等）</h3>
          <label className="field">
            <span>显示名称（如"智谱AI"）</span>
            <input type="text" value={draft.custom2Name} onChange={(e) => set({ custom2Name: e.target.value })} />
          </label>
          <label className="field">
            <span>Base URL（智谱：https://open.bigmodel.cn/api/paas/v4 ）</span>
            <input type="text" value={draft.custom2BaseUrl} placeholder="https://open.bigmodel.cn/api/paas/v4" onChange={(e) => set({ custom2BaseUrl: e.target.value })} />
          </label>
          <label className="field">
            <span>API Key（<a onClick={() => open('https://open.bigmodel.cn')}>open.bigmodel.cn</a> 等平台获取）</span>
            <input type="password" value={draft.custom2Key} placeholder="…" onChange={(e) => set({ custom2Key: e.target.value })} />
          </label>
          <label className="field">
            <span>模型（常用见建议列表）</span>
            <input type="text" list="custom2-models" value={draft.custom2Model} onChange={(e) => set({ custom2Model: e.target.value })} />
            <datalist id="custom2-models">
              {CUSTOM2_MODELS.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>
          <label className="field row">
            <input type="checkbox" checked={draft.custom2Vision} onChange={(e) => set({ custom2Vision: e.target.checked })} />
            <span>该模型支持图片输入（视觉模型，如 glm-4v-flash；勾选后图片提问可走此提供商）</span>
          </label>
          <label className="field">
            <span>网页版地址（可选）</span>
            <input type="text" value={draft.custom2WebUrl} placeholder="https://open.bigmodel.cn" onChange={(e) => set({ custom2WebUrl: e.target.value })} />
          </label>
          <div className="field-row">
            <button className="tb-btn act" disabled={testing === 'custom2' || !draft.custom2Key.trim()} onClick={() => void doTest('custom2')}>
              {testing === 'custom2' ? '测试中…' : '测试连接'}
            </button>
            {draft.custom2WebUrl.trim() && (
              <button className="tb-btn act" onClick={() => open(draft.custom2WebUrl.trim())}>打开网页版</button>
            )}
          </div>

          <h3>提问路由（文字与图片可分别指定）</h3>
          <label className="field">
            <span>文字提问 → 路由到</span>
            <select value={draft.textRoute ?? 'auto'} onChange={(e) => set({ textRoute: e.target.value as AIProvider | 'auto' })}>
              <option value="auto">自动（DeepSeek → 自定义① → 自定义② → 豆包）</option>
              {ALL_PROVIDERS.map((p) => (
                <option key={p} value={p}>{PROVIDERS[p].label(draft)}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>图片提问 → 路由到（需支持视觉的模型）</span>
            <select value={draft.imageRoute ?? 'auto'} onChange={(e) => set({ imageRoute: e.target.value as AIProvider | 'auto' })}>
              <option value="auto">自动（豆包视觉 → DeepSeek视觉 → 自定义①视觉 → 自定义②视觉）</option>
              {ALL_PROVIDERS.map((p) => (
                <option key={p} value={p}>{PROVIDERS[p].label(draft)}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>温度：{draft.temperature.toFixed(1)}</span>
            <input type="range" min={0} max={1.5} step={0.1} value={draft.temperature} onChange={(e) => set({ temperature: +e.target.value })} />
          </label>

          <div className="settings-note" style={{ marginTop: 14, fontSize: 11 }}>
            <b>诊断信息</b>（遇到问题时可发给我）
            <br />
            UA：{navigator.userAgent}
            <br />
            浏览器特性：withResolvers={typeof (Promise as unknown as { withResolvers?: unknown }).withResolvers} · structuredClone={typeof structuredClone} · 屏幕 {window.screen.width}×{window.screen.height}
          </div>
        </div>
        <div className="modal-footer">
          <button className="tb-btn act" onClick={onClose}>取消</button>
          <button className="send-btn" onClick={() => { onSave(draft); onClose() }}>保存</button>
        </div>
      </div>
    </div>
  )
}
