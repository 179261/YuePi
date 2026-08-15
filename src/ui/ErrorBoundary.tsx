// ============ 错误边界：应用崩溃时给出可读提示，而不是白屏 ============
import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('应用错误', error, info)
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 28, fontFamily: 'system-ui, sans-serif', color: '#433422', background: '#fbf3d9', minHeight: '100vh' }}>
          <h2 style={{ color: '#b91c1c' }}>⚠️ 应用出错了</h2>
          <p>请把下面的错误信息发给我，方便定位问题：</p>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: '#fffdf4', border: '1px solid #e3d5a8', padding: 14, borderRadius: 10, fontSize: 12 }}>
            {String(this.state.error.stack || this.state.error)}
            {'\n\nUA: ' + navigator.userAgent}
          </pre>
          <button style={{ marginRight: 8, padding: '10px 18px', borderRadius: 8, border: 'none', cursor: 'pointer', background: '#d97706', color: '#fff', fontWeight: 700 }} onClick={() => location.reload()}>
            刷新重试
          </button>
          <button style={{ padding: '10px 18px', borderRadius: 8, border: '1px solid #d9c9a0', cursor: 'pointer', background: '#fffdf4', color: '#433422' }}
            onClick={() => {
              try {
                localStorage.clear()
                location.reload()
              } catch {
                location.reload()
              }
            }}>
            清除本地数据并重载
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
