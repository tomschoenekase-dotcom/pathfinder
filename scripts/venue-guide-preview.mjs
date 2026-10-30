import { writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

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
  // Resolve an installed local loader only. No package-manager or network fallback.
  let loader
  for (const anchor of [
    'packages/api/package.json',
    'package.json',
    'node_modules/.pnpm/node_modules/package.json',
  ]) {
    try {
      loader = createRequire(resolve(root, anchor)).resolve('tsx')
      break
    } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error
    }
  }
  if (!loader) throw new Error('Installed local tsx renderer loader is unavailable')
  const code = `import { readFileSync } from 'node:fs'; import { createHash } from 'node:crypto'; const native = await import('./src/lib/venue-package-guide-preview.ts'); const {previewVenuePackageGuide} = native.default ?? native; const source = readFileSync(process.argv[1]); process.stdout.write(JSON.stringify({...previewVenuePackageGuide(JSON.parse(source.toString('utf8')), process.argv[2]), packageSha256: createHash('sha256').update(source).digest('hex')}))`
  // Run the renderer in the direct child so timeout termination cannot orphan a shell grandchild.
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      pathToFileURL(loader).href,
      '--input-type=module',
      '-e',
      code,
      packagePath,
      options['--as-of'],
    ],
    {
      windowsHide: true,
      timeout: 30_000,
      cwd: resolve(root, 'packages/api'),
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    },
  )
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
