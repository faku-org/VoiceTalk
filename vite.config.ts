import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
    babel({ presets: [reactCompilerPreset()] }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    // Loopback only; Tauri's devUrl points here (see src-tauri/tauri.conf.json).
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    // The voice sidecar creates voice/.venv inside the repo; its files must not
    // trigger page reloads in the webview.
    watch: { ignored: ['**/voice/.venv/**', '**/src-tauri/target/**'] },
  },
})
