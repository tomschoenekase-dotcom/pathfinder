import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workflowRoot = path.join(repositoryRoot, '.github', 'workflows')
const immutableActionReference = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/u
const node24ActionReferences = new Map([
  ['actions/checkout', 'actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09'],
  ['actions/setup-node', 'actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444'],
  ['pnpm/action-setup', 'pnpm/action-setup@f520eceda224fe1a4aed5a2a27a194379a409996'],
])

async function workflows() {
  const entries = await readdir(workflowRoot, { withFileTypes: true })
  return Promise.all(
    entries
      .filter(
        (entry) => entry.isFile() && (entry.name.endsWith('.yml') || entry.name.endsWith('.yaml')),
      )
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(async (entry) => ({
        name: entry.name,
        source: await readFile(path.join(workflowRoot, entry.name), 'utf8'),
      })),
  )
}

function externalActionReferences(source) {
  return [...source.matchAll(/^\s*-\s+uses:\s+([^\s#]+)(?:\s+#.*)?$/gmu)]
    .map((match) => match[1])
    .filter((reference) => !reference.startsWith('./') && !reference.startsWith('docker://'))
}

test('every workflow has an explicit read-only repository token ceiling', async () => {
  for (const { name, source } of await workflows()) {
    assert.match(source, /^permissions:\r?\n  contents: read\r?$/mu, name)
    assert.doesNotMatch(source, /^\s{2,}[A-Za-z-]+:\s+write\s*$/mu, name)
  }
})

test('third-party actions use immutable commit references', async () => {
  for (const { name, source } of await workflows()) {
    for (const reference of externalActionReferences(source)) {
      assert.match(reference, immutableActionReference, `${name}: ${reference}`)
    }
  }
})

test('core JavaScript actions stay pinned to reviewed Node 24 releases', async () => {
  for (const { name, source } of await workflows()) {
    for (const reference of externalActionReferences(source)) {
      const action = reference.slice(0, reference.indexOf('@'))
      const expected = node24ActionReferences.get(action)
      if (expected) assert.equal(reference, expected, `${name}: ${reference}`)
    }
  }
})

test('checkout never persists the workflow token', async () => {
  for (const { name, source } of await workflows()) {
    const checkoutSteps = source.split(/^\s*-\s+uses:\s+/mu).slice(1)
    for (const step of checkoutSteps.filter((candidate) =>
      candidate.startsWith('actions/checkout@'),
    )) {
      const stepBody = step.split(/^\s*-\s+(?:name|uses|run):/mu, 1)[0]
      assert.match(stepBody, /^\s+persist-credentials:\s+false\s*$/mu, name)
    }
  }
})

test('branch and pull-request workflows receive no repository secrets', async () => {
  for (const { name, source } of await workflows()) {
    assert.doesNotMatch(source, /\bsecrets\s*\./u, name)
  }
})

test('the immutable-reference parser rejects mutable tags and accepts local or digest-safe forms', () => {
  const source = [
    'steps:',
    '  - uses: actions/checkout@v4',
    '  - uses: owner/action@0123456789abcdef0123456789abcdef01234567 # v4',
    '  - uses: ./local-action',
    '  - uses: docker://tool@sha256:0123',
  ].join('\n')
  assert.deepEqual(externalActionReferences(source), [
    'actions/checkout@v4',
    'owner/action@0123456789abcdef0123456789abcdef01234567',
  ])
  assert.equal(immutableActionReference.test('actions/checkout@v4'), false)
  assert.equal(
    immutableActionReference.test('owner/action@0123456789abcdef0123456789abcdef01234567'),
    true,
  )
})
