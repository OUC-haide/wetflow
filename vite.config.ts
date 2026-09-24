import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  root: '.',
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 4311,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:4310',
      '/health': 'http://127.0.0.1:4310',
    },
  },
})
