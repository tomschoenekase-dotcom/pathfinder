import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const runtimeDockerfiles = ['Dockerfile', 'Dockerfile.web', 'Dockerfile.web.staging']

test('Next runtime images use a stable Prisma engine path', async () => {
  for (const relativePath of runtimeDockerfiles) {
    const dockerfile = await readFile(path.join(root, relativePath), 'utf8')

    assert.doesNotMatch(
      dockerfile,
      /@prisma\+client@\d/,
      `${relativePath} must not encode the pnpm Prisma dependency key`,
    )
    assert.match(
      dockerfile,
      /cp \/app\/node_modules\/\.pnpm\/@prisma\+client@\*\/node_modules\/\.prisma\/client\/libquery_engine-linux-musl-openssl-3\.0\.x\.so\.node \/app\/prisma-engine\/query-engine\.node/,
      `${relativePath} normalizes the generated Linux engine`,
    )
    assert.match(
      dockerfile,
      /^ENV PRISMA_QUERY_ENGINE_LIBRARY=\/app\/prisma-engine\/query-engine\.node$/mu,
      `${relativePath} directs Prisma to the stable runtime file`,
    )
    assert.match(
      dockerfile,
      /^COPY --from=builder --chown=node:node \/app\/prisma-engine\/query-engine\.node \/app\/prisma-engine\/query-engine\.node$/mu,
      `${relativePath} copies the stable engine into the runtime image with non-root ownership`,
    )
  }
})
