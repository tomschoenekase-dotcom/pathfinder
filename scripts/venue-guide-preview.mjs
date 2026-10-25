import { writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { delimiter, resolve } from 'node:path'

try {
  const args = process.argv.slice(2)
  const options = {}
  for (let i = 0; i < args.length; i += 2) {
    if (
      !['--package', '--as-of', '--output'].includes(args[i]) ||
      !args[i + 1] ||
      options[args[i]]
    ) {
      throw new Error(
        'Usage: node scripts/venue-guide-preview.mjs --package <file> --as-of YYYY-MM-DD [--output <file>]',
      )
    }
    options[args[i]] = args[i + 1]
  }
  if (!options['--package'] || !options['--as-of'])
    throw new Error('--package and --as-of are required')
  const packagePath = resolve(options['--package'])
  const root = fileURLToPath(new URL('../', import.meta.url))
  const code = `import { readFileSync } from 'node:fs'; import { createHash } from 'node:crypto'; import { previewVenuePackageGuide } from './src/lib/venue-package-guide-preview.ts'; const source = readFileSync(process.argv[1]); process.stdout.write(JSON.stringify({...previewVenuePackageGuide(JSON.parse(source.toString('utf8')), process.argv[2]), packageSha256: createHash('sha256').update(source).digest('hex')}))`
  const rendererArgs = [
    '--dir',
    'packages/api',
    'exec',
    'tsx',
    '-e',
    code,
    packagePath,
    options['--as-of'],
  ]
  // Windows .cmd launch needs a shell; encode PowerShell literals instead of interpolating cmd text.
  const windowsScript = `& pnpm ${rendererArgs.map((arg) => `'${arg.replaceAll("'", "''")}'`).join(' ')}; exit $LASTEXITCODE`
  const spawnOptions = {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      PATH: `${resolve(root, 'node_modules/.pnpm/node_modules/.bin')}${delimiter}${process.env.PATH ?? ''}`,
    },
  }
  const child =
    process.platform === 'win32'
      ? spawnSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            Buffer.from(windowsScript, 'utf16le').toString('base64'),
          ],
          spawnOptions,
        )
      : spawnSync('pnpm', rendererArgs, spawnOptions)
  if (child.error) throw child.error
  if (child.status !== 0) throw new Error(child.stderr || `Renderer exited ${child.status}`)
  const report = JSON.parse(child.stdout)
  const output = `${JSON.stringify(report, null, 2)}\n`
  if (options['--output']) {
    if (resolve(options['--output']) === packagePath)
      throw new Error('Output must not overwrite package input')
    writeFileSync(resolve(options['--output']), output, { flag: 'wx' })
  }
  process.stdout.write(output)
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
