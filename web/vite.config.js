import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const KIOSK_CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' https: http://127.0.0.1:* http://localhost:*",
].join('; ')

const kioskCspPlugin = {
  name: 'preddita-kiosk-csp',
  apply: 'build',
  transformIndexHtml() {
    return [{
      tag: 'meta',
      attrs: {
        'http-equiv': 'Content-Security-Policy',
        content: KIOSK_CSP,
      },
      injectTo: 'head-prepend',
    }]
  },
}

export default defineConfig({
  plugins: [react(), kioskCspPlugin],
  base: './',          // caminhos relativos — essencial para WebView Android
  build: {
    outDir: '../android/app/src/main/assets/www',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: undefined   // bundle único para WebView offline
      }
    }
  }
})
