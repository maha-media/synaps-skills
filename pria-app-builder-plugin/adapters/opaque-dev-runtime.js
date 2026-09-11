/* Blocking, external dev-only bootstrap. No authority is granted here. */
;(function () {
  'use strict'
  var match = location.pathname.match(/^\/[a-f0-9]{24}\/d\/[^/]+\//)
  if (!match) throw new Error('Invalid preview context')
  // Vite 8 selects a SharedWorker by API presence, but opaque origins cannot
  // construct one. Select its supported window-side reconnect implementation.
  if (globalThis.origin === 'null') Object.defineProperty(globalThis, 'SharedWorker', { value: undefined, configurable: true })
  var NativeWebSocket = globalThis.WebSocket
  class PreviewWebSocket extends NativeWebSocket {
    constructor(url, protocols) {
      var target = new URL(url, location.href)
      var expectedProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      if (target.protocol !== expectedProtocol || target.host !== location.host || target.pathname !== match[0] + 'hmr') throw new Error('Preview WebSocket must use the authorized gateway')
      super(url, protocols)
      this.addEventListener('close', function (event) {
        if (event.code !== 1008) return
        // Policy revocation is terminal, unlike a restart/disconnect. Do not
        // let Vite's restart polling retry an expired/revoked capability.
        event.stopImmediatePropagation()
        var notice = document.createElement('p')
        notice.setAttribute('role', 'status')
        notice.textContent = 'Preview access ended. Reopen preview to continue.'
        document.body.replaceChildren(notice)
      })
    }
  }
  globalThis.WebSocket = PreviewWebSocket
})()
