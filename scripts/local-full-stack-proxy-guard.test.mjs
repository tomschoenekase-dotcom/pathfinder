import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const compose = readFileSync(new URL('../compose.local-full-stack.yml', import.meta.url), 'utf8')
const proxyCommand = compose.match(/command:\s*\n\s+- node\s*\n\s+- -e\s*\n\s+- >-\s*\n([\s\S]*?)\n\s+depends_on:/u)?.[1]

function makeProxyNet() {
  const upstreamCalls = []
  const listeners = []
  class Socket {
    connect(...args) {
      upstreamCalls.push({ api: 'Socket.connect', args })
      return this
    }
  }
  const connect = (...args) => {
    upstreamCalls.push({ api: 'connect', args })
    return new Socket()
  }
  const createConnection = (...args) => {
    upstreamCalls.push({ api: 'createConnection', args })
    return new Socket()
  }
  const net = {
    Socket,
    connect,
    createConnection,
    createServer(handler) {
      listeners.push(handler)
      return { listen() {} }
    },
  }
  return { net, upstreamCalls, listeners }
}

test('proxy guard denies every Node TCP connection entry point before socket creation', () => {
  assert.ok(proxyCommand, 'compose must keep the proxy node command inline and inspectable')
  const source = proxyCommand.split(/\r?\n/u).map((line) => line.replace(/^        /u, '')).join('\n')
  const { net, upstreamCalls } = makeProxyNet()
  new Function('require', source)((name) => {
    assert.equal(name, 'node:net')
    return net
  })

  assert.throws(() => net.connect(80, '203.0.113.17'), /local proxy destination denied/u)
  assert.throws(() => net.createConnection({ port: 80, host: '203.0.113.17' }), /local proxy destination denied/u)
  assert.throws(() => new net.Socket().connect({ port: 80, host: '203.0.113.17' }), /local proxy destination denied/u)
  assert.throws(() => new net.Socket().connect([{ port: 80, host: '203.0.113.17' }]), /local proxy destination denied/u)
  assert.deepEqual(upstreamCalls, [], 'denied destinations must not reach Node socket APIs')

  net.connect(5432, 'postgres')
  net.createConnection({ port: 6379, host: 'redis' })
  new net.Socket().connect(9000, 'minio')
  new net.Socket().connect([{ port: 3310, host: 'clamav' }])
  assert.deepEqual(upstreamCalls.map(({ api }) => api), ['connect', 'createConnection', 'Socket.connect', 'Socket.connect'])
})
