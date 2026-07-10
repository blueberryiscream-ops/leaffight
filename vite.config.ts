import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// GitHub Pages はリポジトリ名のサブパスで配信されるため、本番ビルドだけ base を付ける。
// CI からは VITE_BASE=/leaffight/ が渡ってくる（.github/workflows/deploy.yml）。
export default defineConfig(({ command }) => ({
  base: command === 'build' ? (process.env.VITE_BASE ?? '/leaffight/') : '/',
  server: {
    // 開発ポートは 5300 固定。tcg-companion が 5200 を使うため衝突を避ける。
    host: true,
    port: 5300,
    strictPort: true,
  },
  plugins: [react(), tailwindcss()],
}))
