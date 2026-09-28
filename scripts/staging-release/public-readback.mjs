import { readFile } from 'node:fs/promises'
import { runPublicReadback } from './public-readback-lib.mjs'

const args = process.argv.slice(2)
function value(flag) { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1] }

try {
  const policy = JSON.parse(await readFile(new URL('../release-verification-policy.json', import.meta.url)))
  const result = await runPublicReadback({ baseUrl: value('--base-url'), expectedRevision: value('--expected-revision'), venueSlug: value('--venue-slug'), resources: policy.staging.resources })
  process.stdout.write(`${JSON.stringify(result)}\n`)
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, code: /^[a-z-]+$/u.test(error?.code) ? error.code : 'public-readback-failed' })}\n`)
  process.exitCode = 1
}
