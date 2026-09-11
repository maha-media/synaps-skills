import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { parse, serialize } from 'parse5'
import { priaReactPlugins } from './pria-adapters/vite-react.mjs'

export default defineConfig(({ command }) => {
  const dev = command === 'serve'
  const port = Number(process.env.PORT)
  const base = process.env.REVISION_BASE
  if (dev && (!Number.isInteger(port) || port < 1 || port > 65535 || !/^\/[a-f0-9]{24}\/d\/[^/]+\/$/.test(base || ''))) {
    throw Error('managed supervisor PORT and REVISION_BASE required')
  }
  return {
    plugins: priaReactPlugins({ react, parse, serialize }),
    base: dev ? base : './',
    server: { host: '127.0.0.1', port: dev ? port : undefined, strictPort: true, ws: { path: 'hmr' } },
    build: { outDir: 'dist', sourcemap: false }
  }
})
