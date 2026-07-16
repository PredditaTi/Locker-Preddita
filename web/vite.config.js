import { defineConfig, loadEnv } from 'vite'
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
  "connect-src 'self' https: wss: http://127.0.0.1:* http://localhost:*",
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

export function assertNoBundledDeviceCredential(value) {
  if (String(value ?? '').trim()) {
    throw new Error('VITE_PREDDITA_DEVICE_KEY must not be bundled; provision it through Android Keystore.')
  }
}

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  if (command === 'build') {
    assertNoBundledDeviceCredential(
      process.env.VITE_PREDDITA_DEVICE_KEY || env.VITE_PREDDITA_DEVICE_KEY
    )
  }

  return {
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
  }
})
