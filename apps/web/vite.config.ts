import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 127.0.0.1 rather than localhost: the manager binds IPv4 loopback, and on Windows
// `localhost` can resolve to ::1 first, which makes the proxy fail with ECONNREFUSED
// against a manager that is plainly running.
const MANAGER = process.env.WT_MANAGER_URL ?? 'http://127.0.0.1:7777'

export default defineConfig({
  plugins: [react()],
  // Built straight into the manager's static dir so `npm start` serves the
  // dashboard and the API from one origin.
  build: {
    outDir: '../manager/public',
    emptyOutDir: true,
  },
  server: {
    port: 7788,
    proxy: {
      '/api': {
        target: MANAGER,
        changeOrigin: true,
        // Log streaming is SSE; buffering it would defeat the point.
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              proxyRes.headers['cache-control'] = 'no-cache, no-transform'
            }
          })
        },
      },
    },
  },
})
