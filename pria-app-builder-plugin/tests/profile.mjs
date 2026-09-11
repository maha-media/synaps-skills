// Focused real prepared-profile test. Existing dependencies only; never installs.
import assert from 'node:assert/strict'
import { mkdtemp, cp, writeFile, symlink, rm, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createServer as createNetServer } from 'node:net'

// timeout owns the command process group, including npm's shell/build descendants.
function run(command, args, options = {}) {
  return execFileSync('timeout', ['--kill-after=5s', '60s', command, ...args], options)
}
async function bounded(label, operation, ms = 15000) {
  let timer
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    })])
  } finally { clearTimeout(timer) }
}
async function privatePort() {
  const reservation = createNetServer()
  try {
    await new Promise((resolve, reject) => {
      reservation.once('error', reject)
      reservation.listen(0, '127.0.0.1', resolve)
    })
    return reservation.address().port
  } finally {
    await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
  }
}
const deps = resolve(process.argv[2])
const root = fileURLToPath(new URL('../', import.meta.url))
const temp = await mkdtemp(join(tmpdir(), 'pria-profile-'))
const plugin = join(temp, 'plugin'), app = join(temp, 'app')
const { createServer } = await import(pathToFileURL(join(deps, 'vite/dist/node/index.js')))
let server
const originalEnv = { PORT: process.env.PORT, REVISION_BASE: process.env.REVISION_BASE }
try {
  await cp(root, plugin, { recursive: true })
  if (process.argv.includes('--snapshot')) {
    await writeFile(join(plugin, 'pack.json'), run('python3', [join(plugin, 'scripts/pack.py')]))
    console.log('INTERIM SNAPSHOT descriptor regenerated only in disposable copy; NOT final pack verification')
  }
  await mkdir(app)
  const versions = { vite: '8.2.0', '@vitejs/plugin-react': '6.0.5', parse5: '7.3.0' }
  for (const [name, version] of Object.entries(versions)) {
    assert.equal(JSON.parse(await readFile(join(deps, name, 'package.json'))).version, version)
  }
  const pkg = { type: 'module', devDependencies: versions, pria: { requiredChecks: ['test'] }, scripts: {
    dev: 'vite --configLoader runner', build: 'vite build --configLoader runner', test: 'node --test profile.test.cjs'
  } }
  await writeFile(join(app, 'package.json'), JSON.stringify(pkg))
  // Synthetic lock for helper validation, not an installed dependency integrity claim.
  await writeFile(join(app, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {
    '': pkg, ...Object.fromEntries(Object.entries(versions).map(([name, version]) => ['node_modules/'+name, { version }]))
  } }))
  run('python3', [join(plugin, 'scripts/prepare-profile.py'), app])
  await symlink(deps, join(app, 'node_modules'))
  await writeFile(join(app, 'index.html'), '<html><head></head><body><div id="root"></div><script type="module" src="/src.jsx"></script></body></html>')
  await writeFile(join(app, 'src.jsx'), 'import React from "react"; import {createRoot} from "react-dom/client"; createRoot(document.getElementById("root")).render(<p>profile</p>)')
  await writeFile(join(app, 'profile.test.cjs'), 'const assert=require("node:assert/strict"); const fs=require("node:fs"); assert.match(fs.readFileSync("src.jsx","utf8"), /createRoot/);')
  const env = { PATH: '/usr/bin:/bin', HOME: app, RAYON_NUM_THREADS: '2' }
  run('npm', ['test', '--', '--run'], { cwd: app, env, stdio: 'pipe' })
  const output = join(temp, 'output')
  // Actual npm build script + runner, with a fresh separate output (not guest sandbox certification).
  run('npm', ['run', 'build', '--', '--outDir', output], { cwd: app, env, stdio: 'pipe' })
  assert.match(await readFile(join(output, 'index.html'), 'utf8'), /data-pria-react-entry="v1"/)
  const options = { root: app, configLoader: 'runner', configFile: join(app, 'vite.config.mjs'), envFile: false, logLevel: 'silent' }
  delete process.env.PORT; delete process.env.REVISION_BASE
  await assert.rejects(() => bounded('unmanaged createServer', createServer(options)), /managed supervisor/)
  process.env.PORT = String(await privatePort()); process.env.REVISION_BASE = '/'+'a'.repeat(24)+'/d/test-cap/'
  server = await createServer(options)
  await bounded('listen', server.listen())
  const url = `http://127.0.0.1:${server.httpServer.address().port}${process.env.REVISION_BASE}`
  const html = await (await fetch(url, { signal: AbortSignal.timeout(15000) })).text()
  assert.match(html, /src.jsx/)
  const module = await fetch(url+'src.jsx', { signal: AbortSignal.timeout(15000) })
  assert.equal(module.status, 200)
  assert.match(await module.text(), /createRoot/)
  assert.equal(server.config.server.ws.path, 'hmr')
} finally {
  try {
    if (server) {
      try {
        // HTTP completion is not optimizer/crawl completion. Closing during the
        // crawl can leave Vite 8 optimizer cancellation pending with no active I/O.
        await bounded('request crawl readiness', server.waitForRequestsIdle())
      } finally {
        server.httpServer?.closeAllConnections()
        await bounded('Vite close', server.close())
      }
    }
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(temp, { recursive: true, force: true })
  }
}
console.log('PASS: helper-prepared output actual npm tests/build, unmanaged refusal, managed dev HTTP module; cleanup complete')
