import { readFileSync } from 'node:fs'
const opaqueRuntime = readFileSync(new URL('./opaque-dev-runtime.js', import.meta.url), 'utf8')
// Reusable react-spa-relative-v1 HTML packaging, not JavaScript rewriting.
const relative = value => /^\.\/assets\/[A-Za-z0-9_./-]+$/.test(value) && !value.split('/').includes('..')
export function packageReactHtml(html, { parse, serialize }) {
  const doc = parse(html)
  const visit = node => {
    for (const child of [...(node.childNodes || [])]) {
      const attrs = Object.fromEntries((child.attrs || []).map(a => [a.name, a.value]))
      const module = child.tagName === 'script' && attrs.type === 'module'
      const link = child.tagName === 'link' && ['modulepreload', 'stylesheet'].includes(attrs.rel)
      if (module || link) {
        const url = attrs[module ? 'src' : 'href']
        if (!relative(url || '')) throw Error('relative React profile requires ./assets/ module and link URLs')
        if (module && child.childNodes?.some(n => n.value?.trim())) throw Error('inline modules unsupported')
        const template = { nodeName: 'template', tagName: 'template', namespaceURI: 'http://www.w3.org/1999/xhtml', attrs: [{ name: 'data-pria-react-entry', value: 'v1' }], childNodes: [], parentNode: node }
        template.content = { nodeName: '#document-fragment', childNodes: [child], parentNode: template }
        child.parentNode = template.content
        node.childNodes[node.childNodes.indexOf(child)] = template
      } else visit(child)
    }
  }
  visit(doc)
  return serialize(doc)
}
export function relativeReactPackagingPlugin(parser) {
  return { name: 'pria-relative-react-packaging', transformIndexHtml: { order: 'post', handler: html => packageReactHtml(html, parser) } }
}

// Dependencies are supplied by the consuming project: never resolve a second Vite
// or React installation from the plugin installation directory.
export function priaReactPlugins({ react, parse, serialize }) {
  const runtimes = ['/_pria/v1/pria-agentspace-react.js', '/_pria/v1/pria-agentspace-sdk.js']
  let base, preamble
  const walk = (node, fn) => {
    for (const child of [...(node.childNodes || [])]) { fn(child, node); walk(child, fn) }
  }
  return [react(), {
    name: 'pria-react-dev-csp',
    apply: 'serve',
    configResolved(config) {
      base = config.base
      if (!/^\/[a-f0-9]{24}\/d\/[^/]+\/$/.test(base)) throw Error('supervisor dev base required')
      if (typeof react.preambleCode !== 'string') throw Error('unsupported React preamble API')
      preamble = react.preambleCode.replace('__BASE__', base)
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = req.url?.split('?')[0]
        if (![base + '@pria-refresh-preamble', base + '@pria-opaque-env'].includes(pathname)) return next()
        if (!['GET', 'HEAD'].includes(req.method)) { res.statusCode = 405; return res.end() }
        res.setHeader('Content-Type', 'text/javascript')
        res.setHeader('Cache-Control', 'no-store')
        // Opaque frames cannot create SharedWorker. Advertise this actual lack of
        // capability so Vite uses its built-in window-side reconnect polling.
        const body = pathname.endsWith('@pria-opaque-env') ? opaqueRuntime : preamble
        res.end(req.method === 'HEAD' ? undefined : body)
      })
    },
    transformIndexHtml: { order: 'pre', handler(html) {
      const doc = parse(html)
      walk(doc, (node, parent) => {
        if (node.tagName === 'script' && runtimes.includes(node.attrs?.find(a => a.name === 'src')?.value)) {
          parent.childNodes.splice(parent.childNodes.indexOf(node), 1)
        }
      })
      return serialize(doc)
    } }
  }, {
    name: 'pria-react-dev-external-runtime', apply: 'serve',
    transformIndexHtml: { order: 'post', handler(html) {
      const doc = parse(html)
      let found = 0
      walk(doc, node => {
        if (node.tagName !== 'script' || node.attrs?.some(a => a.name === 'src')) return
        const code = (node.childNodes || []).map(n => n.value || '').join('')
        if (code.trim() !== preamble.trim()) throw Error('unsupported inline script in dev profile')
        node.childNodes = []
        node.attrs.push({ name: 'src', value: base + '@pria-refresh-preamble' })
        found++
      })
      if (found !== 1) throw Error('expected installed React refresh preamble')
      return { html: serialize(doc), tags: [base + '@pria-opaque-env', ...runtimes].map(src => ({ tag: 'script', attrs: { src }, injectTo: 'head-prepend' })) }
    } }
  }, { ...relativeReactPackagingPlugin({ parse, serialize }), apply: 'build' }]
}
