import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { App } from './ui/App'
import { testPlayRole } from './ui/board/useTestPlay'

// テストプレイの2窓は題名で見分ける（起動スクリプトが題名でウィンドウを左右に並べる）
const role = testPlayRole()
if (role) document.title = role === 'host' ? 'LF TestPlay - HOST (A)' : 'LF TestPlay - GUEST (B)'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
