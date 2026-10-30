import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

// Local paid evaluation entrypoint only. No global or production configuration changes.
export function torchikoEvaluationEnvironment(parent) {
  const key = parent.TORCHIKO_OPENAI_API_KEY
  if (!key || key !== key.trim() || /[\r\n]/u.test(key)) {
    throw new Error('TORCHIKO_OPENAI_API_KEY is required and must be unpadded; generic OPENAI_API_KEY is not a fallback')
  }
  for (const name of ['OPENAI_BASE_URL', 'OPENAI_API_BASE', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID']) {
    if (parent[name]) throw new Error(`Review routing override before evaluation: ${name}`)
  }
  return { ...parent, OPENAI_API_KEY: key }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2)
    if (args.shift() !== '--' || !args.length) throw new Error('Usage: node scripts/with-torchiko-openai.mjs -- <executable> [arguments]')
    const env = torchikoEvaluationEnvironment(process.env)
    const result = spawnSync(args.shift(), args, { env, stdio: 'inherit', shell: false })
    if (result.error) throw new Error('Evaluation command could not start')
    process.exitCode = result.status ?? 1
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
