import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dockerfiles = ['Dockerfile', 'Dockerfile.web', 'Dockerfile.web.staging', 'Dockerfile.workers']
const nodeImage =
  'node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293'

async function sources() {
  return Promise.all(
    dockerfiles.map(async (name) => ({
      name,
      source: await readFile(path.join(repositoryRoot, name), 'utf8'),
    })),
  )
}

test('every application image starts from the exact reviewed Node image index', async () => {
  for (const { name, source } of await sources()) {
    assert.equal(source.split(/\r?\n/u, 1)[0], `FROM ${nodeImage} AS base`, name)
    assert.doesNotMatch(source, /^FROM\s+node:[^@\s]+\s/mu, name)
  }
})

test('every final application stage runs as the built-in non-root Node account', async () => {
  for (const { name, source } of await sources()) {
    const runnerIndex = source.lastIndexOf(' AS runner')
    const userIndex = source.lastIndexOf('\nUSER node\n')
    const commandIndex = source.lastIndexOf('\nCMD ')
    assert.notEqual(runnerIndex, -1, name)
    assert.ok(userIndex > runnerIndex, name)
    assert.ok(commandIndex > userIndex, name)
    assert.doesNotMatch(source.slice(userIndex), /\nUSER\s+(?:0|root)\b/u, name)
  }
})

test('runtime copies explicitly transfer artifact ownership to the non-root account', async () => {
  for (const { name, source } of await sources()) {
    const runner = source.slice(source.lastIndexOf(' AS runner'))
    const runtimeCopies = runner.match(/^COPY\s+--from=.*$/gmu) ?? []
    assert.ok(runtimeCopies.length > 0, name)
    for (const instruction of runtimeCopies) {
      assert.match(instruction, /\s--chown=node:node\s/u, `${name}: ${instruction}`)
    }
  }
})
