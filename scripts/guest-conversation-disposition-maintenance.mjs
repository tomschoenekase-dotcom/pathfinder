/* eslint-disable no-console -- This operator CLI emits bounded metadata receipts only. */
import { readFile, mkdir, lstat, realpath } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dispositionSha256 } from './lib/guest-conversation-disposition-journal.mjs'
import {
  validateDispositionMaintenancePlan,
  runDispositionMaintenance,
  retainDispositionMetadata,
} from './lib/guest-conversation-disposition-maintenance.mjs'
import { DispositionPsqlSession } from './lib/guest-conversation-disposition-psql.mjs'

export async function run(argv = process.argv.slice(2)) {
  const flags = new Map()
  let execute = false
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (key === '--execute') {
      if (execute) throw new Error('duplicate execute')
      execute = true
      continue
    }
    if (
      ![
        '--plan',
        '--plan-sha256',
        '--output',
        '--psql',
        '--psql-sha256',
        '--socket',
        '--port',
      ].includes(key) ||
      flags.has(key) ||
      !argv[i + 1]
    )
      throw new Error('unknown/duplicate argument')
    flags.set(key, argv[++i])
  }
  if (!flags.has('--plan') || !flags.has('--plan-sha256'))
    throw new Error('explicit plan and SHA256 required')
  const raw = await readFile(flags.get('--plan'))
  if (raw.length > 1024 * 1024 || dispositionSha256(raw) !== flags.get('--plan-sha256'))
    throw new Error('plan bytes refused')
  const plan = await validateDispositionMaintenancePlan(JSON.parse(raw))
  if (!execute) {
    console.log(
      JSON.stringify({
        status: 'LOCAL_PLAN_CHECKED',
        networkOrDatabaseContact: false,
        planSha256: dispositionSha256(raw),
      }),
    )
    return
  }
  // This command uses existing local peer/socket authentication only. It does not
  // read .env, credential files or URL/password inputs. Hosted prerequisites are
  // deliberate role grants and a stopped-services custody/recovery procedure.
  const socket = flags.get('--socket'),
    executable = flags.get('--psql'),
    output = flags.get('--output'),
    port = flags.get('--port')
  if (
    !socket?.startsWith('/') ||
    !/^\d{1,5}$/u.test(port ?? '') ||
    Number(port) < 1 ||
    Number(port) > 65535 ||
    !executable ||
    !output
  )
    throw new Error('explicit local socket/psql/output required')
  const binary = await readFile(executable)
  if (dispositionSha256(binary) !== flags.get('--psql-sha256'))
    throw new Error('psql source identity refused')
  const outputPath = resolve(output)
  if (resolve(await realpath(dirname(outputPath))) !== dirname(outputPath))
    throw new Error('output path link refused')
  await mkdir(outputPath, { recursive: false }) // Exclusive attempt; never resume or overwrite it.
  const info = await lstat(outputPath)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('output refused')
  await retainDispositionMetadata(resolve(outputPath, 'input-binding.json'), {
    planSha256: dispositionSha256(raw),
    psqlSha256: dispositionSha256(binary),
    scope: 'operator maintenance; no service restart',
  })
  const env = {
    PATH: '/usr/bin:/bin',
    LANG: 'C',
    LC_ALL: 'C',
    PGPASSFILE: '/dev/null',
    PGCONNECT_TIMEOUT: '5',
    PGAPPNAME: 'pathfinder-guest-disposition-maintenance',
    PGOPTIONS:
      '-c statement_timeout=30000 -c lock_timeout=5000 -c idle_in_transaction_session_timeout=45000',
  }
  const connect = (database) =>
    new DispositionPsqlSession(
      executable,
      [
        '-X',
        '--no-psqlrc',
        '-w',
        '-qAt',
        '-v',
        'ON_ERROR_STOP=1',
        '-h',
        socket,
        '-p',
        port,
        '-U',
        plan.target.role,
        '-d',
        database,
      ],
      { env },
    )
  const control = connect('postgres')
  const result = await runDispositionMaintenance({
    plan,
    control,
    connectTarget: async () => {
      const session = connect(plan.target.database)
      await session.query("SELECT jsonb_build_object('connected',true)")
      return session
    },
    outputDirectory: outputPath,
  })
  await retainDispositionMetadata(resolve(outputPath, 'result.json'), result)
  console.log(JSON.stringify(result))
  if (result.status !== 'RECONCILED') process.exitCode = 2
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    console.error(
      JSON.stringify({
        status: 'REFUSED',
        code: error?.code ?? 'INPUT_OR_EXECUTION_REFUSED',
        noAutomaticReopen: true,
      }),
    )
    process.exitCode = 2
  })
}
