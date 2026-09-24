#!/usr/bin/env node
import path from 'node:path'
import { createOutreachMcp, outreachBridgeStatus } from './lib/torchiko-outreach-mcp.mjs'
import { createOutreachRetryArtifacts } from './lib/torchiko-outreach-retry.mjs'
const root = path.resolve(import.meta.dirname, '..')
if (process.argv[2] === 'doctor') console.log(JSON.stringify(outreachBridgeStatus(), null, 2))
else if (process.argv.length !== 2) { console.error('Use stdio mode or doctor. No credential values are accepted on command lines.'); process.exitCode = 1 }
else {
  let adapter
  try {
    const retry = createOutreachRetryArtifacts(root)
    adapter = await createOutreachMcp({ root, retainResult: result => retry.retain(result),
      recoverResult: async ({ taskId, sha256 }) => sha256 ? { result: await retry.read(taskId, sha256), nativeFreshnessProven: false, SEND_AUTHORIZED: false } : retry.locate(taskId) })
    let buffer = ''; process.stdin.setEncoding('utf8')
    for await (const chunk of process.stdin) {
      buffer += chunk
      if (Buffer.byteLength(buffer) > 250000) throw Error('BOUNDED_STDIO_INPUT_EXCEEDED')
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n'), line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
        if (!line.trim()) continue
        let request
        try { request = JSON.parse(line) } catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'); continue }
        const response = await adapter.handle(request)
        if (response) process.stdout.write(JSON.stringify(response) + '\n')
      }
    }
    if (buffer.trim()) throw Error('INCOMPLETE_STDIO_MESSAGE')
  } catch { console.error('OUTREACH_STDIO_HELD'); process.exitCode = 1 }
  finally { await adapter?.close() }
}
