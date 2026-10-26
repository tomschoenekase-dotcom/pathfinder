import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RELEASE269_QUEUE_BASE_NAMES,
  RELEASE269_QUEUE_COUNTS_LUA,
} from './lib/release269-queue-readback.mjs'
import {
  readPreservedQueues,
  PRESERVED_JOBS_LUA,
  assertPreservedQueueProof,
} from './lib/release269-queue-preservation.mjs'

function fixture({ mutate = () => {}, failure, target = 'production' } = {}) {
  let time = Date.parse('2026-10-26T22:00:00.000Z')
  let reads = 0
  const calls = []
  const prefix = target === 'staging' ? 'staging--' : ''
  const name = prefix + 'gmail-sync'
  const counts = Object.fromEntries(
    RELEASE269_QUEUE_BASE_NAMES.map((n) => [
      prefix + n,
      { waiting: 0, active: 0, delayed: 0, prioritized: 0, waitingChildren: 0, failed: 0 },
    ]),
  )
  counts[name].waiting = 1
  const jobs = Object.fromEntries(Object.keys(counts).map((n) => [n, []]))
  jobs[name] = [
    {
      id: 'fixture-id',
      name: 'gmail-sync-reconciliation',
      state: 'wait',
      attemptsMade: '0',
      ats: '0',
      processedOn: null,
    },
  ]
  const state = {
    counts,
    jobs,
    clients: 'id=1 name= age=0\n',
    content: 'preserved',
    ttl: -1,
    keys: [`bull:${name}:fixture-id`],
  }
  const connection = {
    call: async (command, ...args) => {
      calls.push(command)
      if (command === failure) throw new Error('private driver detail')
      if (command === 'SCAN') return ['0', state.keys]
      if (command === 'EVAL_RO' && args[0] === RELEASE269_QUEUE_COUNTS_LUA) {
        mutate(state, ++reads)
        return JSON.stringify(state.counts)
      }
      if (command === 'EVAL_RO' && args[0] === PRESERVED_JOBS_LUA) return JSON.stringify(state.jobs)
      if (command === 'CLIENT') {
        assert.deepEqual(args, ['LIST'])
        return state.clients
      }
      if (command === 'TYPE') return 'string'
      if (command === 'PTTL') return String(state.ttl)
      if (command === 'GET') return state.content
      throw new Error('unexpected command')
    },
  }
  return {
    calls,
    run: () =>
      readPreservedQueues({
        connection,
        target,
        releaseSha: 'a'.repeat(40),
        resourceIdentity: 'synthetic',
        now: () => time,
        sleep: async (ms) => {
          time += ms
        },
      }),
  }
}

test('preserves stable dormant jobs with two reads 30 seconds apart on one read-only connection', async () => {
  const f = fixture()
  const proof = await f.run()
  assertPreservedQueueProof(proof)
  assert.equal(proof.waiting, 1)
  assert.equal(Date.parse(proof.observedAt) - Date.parse(proof.firstObservedAt), 30000)
  assert.equal(f.calls.filter((c) => c === 'CLIENT').length, 2)
  assert.ok(f.calls.every((c) => ['SCAN', 'EVAL_RO', 'CLIENT', 'TYPE', 'PTTL', 'GET'].includes(c)))
  assert.ok(!JSON.stringify(proof).includes('fixture-id'))
})
test('handles the staging prefix without relaxing its job-name allowlist', async () => {
  assertPreservedQueueProof(await fixture({ target: 'staging' }).run())
})
for (const command of ['EVAL_RO', 'CLIENT', 'SCAN', 'GET'])
  test(`refuses ${command} permission/transport errors without exposing details`, async () => {
    await assert.rejects(fixture({ failure: command }).run(), {
      message: 'release269-queue-preservation-refused',
    })
  })
const unsafe = {
  active: (s) => {
    s.counts['gmail-sync'].active = 1
  },
  prioritized: (s) => {
    s.counts['gmail-sync'].prioritized = 1
  },
  children: (s) => {
    s.counts['gmail-sync'].waitingChildren = 1
  },
  'worker on empty queue': (s) => {
    s.clients = `id=1 name=bull:${Buffer.from('send-email').toString('base64')}:w:fixture age=0\n`
  },
  'legacy worker name': (s) => {
    s.clients = `id=1 name=bull:${Buffer.from('gmail-sync').toString('base64')} age=0\n`
  },
  'unknown name': (s) => {
    s.jobs['gmail-sync'][0].name = 'gmail-sync-notification'
  },
  paused: (s) => {
    s.jobs['gmail-sync'][0].state = 'paused'
  },
  attempted: (s) => {
    s.jobs['gmail-sync'][0].attemptsMade = '1'
  },
  started: (s) => {
    s.jobs['gmail-sync'][0].ats = '1'
  },
  processed: (s) => {
    s.jobs['gmail-sync'][0].processedOn = '123'
  },
  'missing job': (s) => {
    s.jobs['gmail-sync'] = []
  },
  'missing queue': (s) => {
    delete s.counts['send-email']
  },
  'invalid counts': (s) => {
    s.counts['gmail-sync'].waiting = -1
  },
  'row cap': (s) => {
    s.jobs = { overflow: true }
  },
  'expiring key': (s) => {
    s.ttl = 30000
  },
  'missing key': (s) => {
    s.ttl = -2
  },
  'empty client response': (s) => {
    s.clients = ''
  },
  'error client response': (s) => {
    s.clients = 'NOPERM CLIENT denied'
  },
}
for (const [name, mutate] of Object.entries(unsafe))
  test(`refuses ${name} in either snapshot`, async () => {
    for (const snapshot of [1, 2])
      await assert.rejects(
        fixture({
          mutate: (state, read) => {
            if (read === snapshot) mutate(state)
          },
        }).run(),
      )
  })
for (const [name, mutate] of Object.entries({
  content: (s) => {
    s.content = 'changed payload'
  },
  id: (s) => {
    s.jobs['gmail-sync'][0].id = 'replacement-id'
  },
  history: (s) => {
    s.counts['gmail-sync'].failed = 1
  },
}))
  test(`refuses changed ${name} between reads`, async () => {
    await assert.rejects(
      fixture({
        mutate: (state, read) => {
          if (read === 2) mutate(state)
        },
      }).run(),
    )
  })
test('proof validator refuses forged preservation claims and missing registry coverage', async () => {
  const proof = await fixture().run()
  for (const change of [
    { workers: 1 },
    { preserved: false },
    { approval: 'other' },
    { canonicalSha256: '' },
    { firstObservedAt: proof.observedAt },
    { registry: [] },
    { waiting: 2000 },
    { active: 1 },
  ]) {
    assert.throws(() => assertPreservedQueueProof({ ...proof, ...change }))
  }
})
