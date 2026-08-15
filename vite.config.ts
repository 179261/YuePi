import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// 构建产物使用相对路径，可部署到任意静态托管（GitHub Pages / Netlify / 本地服务器 / 局域网）
export default defineConfig({
  base: './',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: '阅批 - PDF批注与AI助手',
        short_name: '阅批',
        description: 'PDF手写批注 + 无限画布白板 + 豆包/DeepSeek AI 助手（数据本地存储）',
        lang: 'zh-CN',
        theme_color: '#1e293b',
        background_color: '#0f172a',
        display: 'standalone',
        start_url: '.',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,bcmap}'],
        maximumFileSizeToCacheInBytes: 10 * 1024 * 1024
      }
    })
  ],
  build: {
    chunkSizeWarningLimit: 5000,
    target: 'es2020',
    rollupOptions: {
      output: {
        manualChunks: {
          pdf: ['pdfjs-dist', 'pdf-lib'],
          whiteboard: ['tldraw'],
          react: ['react', 'react-dom']
        }
      }
    }
  }
})
