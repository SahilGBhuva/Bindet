import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
// Shared primitives load before any page stylesheet so pages can refine them.
import './styles/ui.css'
import App from './App.tsx'
import { pruneOfflineCards } from './lib/offlineCards'
import { listenForInstallPrompt, registerServiceWorker } from './lib/pwa'
import { applyTheme, watchSystemTheme } from './lib/theme'

applyTheme()
watchSystemTheme()
listenForInstallPrompt()
registerServiceWorker()
pruneOfflineCards()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
