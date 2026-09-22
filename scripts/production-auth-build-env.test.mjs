import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const images = [
  [
    'Dockerfile',
    '@pathfinder/dashboard',
    ['NEXT_PUBLIC_WEB_URL', 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'NEXT_PUBLIC_AFTER_SIGN_OUT_URL'],
  ],
  [
    'Dockerfile.web',
    '@pathfinder/web',
    ['NEXT_PUBLIC_WEB_URL', 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY'],
  ],
  [
    'Dockerfile.web.staging',
    '@pathfinder/web',
    ['NEXT_PUBLIC_WEB_URL', 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY'],
  ],
]

for (const [filename, application, publicKeys] of images) {
  test(`${filename} admits branded public settings before the application build, never private auth`, async () => {
    const source = (await readFile(path.join(root, filename), 'utf8')).replaceAll('\r\n', '\n')
    const start = source.indexOf('FROM base AS builder')
    const end = source.indexOf('FROM base AS runner')
    assert.ok(start >= 0 && end > start)
    const builder = source.slice(start, end)
    const build = builder.indexOf(`RUN pnpm --filter ${application} build`)
    assert.ok(build >= 0)
    for (const key of publicKeys) {
      const argument = builder.indexOf(`ARG ${key}\n`)
      assert.ok(
        argument >= 0 && argument < build,
        `${filename} must admit ${key} before Next.js inlines it`,
      )
    }
    assert.doesNotMatch(
      source,
      /^(?:ARG|ENV)\s+(?:CLERK_SECRET_KEY|CLERK_WEBHOOK_SECRET|CLERK_IDENTITY_BINDING)(?:\s|=|$)/mu,
    )
  })
}
