// Disposable emulator fixture. It exercises shell wiring, not a Torchiko guide route.
const http = require('node:http')

const page = `<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Shell-only fixture</title>
<style>body{font:18px system-ui;margin:24px;color:#142b39}button{font:inherit;padding:12px}</style>
<h1>Shell-only fixture</h1>
<p>This page has no Torchiko guide or backend.</p>
<p id="params"></p>
<button id="close">Request native close</button>
<script>
  const params = new URLSearchParams(location.search)
  document.querySelector('#params').textContent =
    'header=' + params.get('header') + '; ask=' + params.get('ask')
  document.querySelector('#close').onclick = () =>
    window.ReactNativeWebView.postMessage(JSON.stringify({
      source: 'torchiko', v: 1, type: 'close-requested', payload: null
    }))
</script>`

http.createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  response.end(page)
}).listen(4175, '127.0.0.1', () => console.log('Shell-only fixture on 127.0.0.1:4175'))
