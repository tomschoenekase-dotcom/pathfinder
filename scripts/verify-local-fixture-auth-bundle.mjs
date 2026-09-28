import { readdir, readFile, stat } from 'node:fs/promises'
import { resolve, relative, sep } from 'node:path'

// Run only after a fresh, fixture-flag-off production build of BOTH apps.
const markers = [
  'torchiko-local-fixture-auth-p14',
  'local-fixture/guard',
  'local-fixture\\guard',
  'local-fixture/server',
  'local-fixture\\server',
  'local-fixture/edge',
  'local-fixture\\edge',
  'local-fixture/client',
  'local-fixture\\client',
]

async function* files(root, directory = root) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) yield* files(root, path)
    else if (entry.isFile() && /\.(?:js|mjs|cjs|json|map)$/u.test(entry.name)) yield path
  }
}

const roots = process.argv.slice(2).map((path) => resolve(path))
if (roots.length !== 2) {
  throw new Error('Expected fresh web and dashboard Next production output paths')
}

let inspected = 0
for (const root of roots) {
  const details = await stat(root)
  if (!details.isDirectory()) throw new Error(`Not a build directory: ${root}`)
  let javascriptFilesInRoot = 0
  for await (const path of files(root)) {
    if (/\.(?:js|mjs|cjs)$/u.test(path)) javascriptFilesInRoot += 1
    inspected += 1
    const source = await readFile(path, 'utf8')
    const found = markers.find((marker) => source.includes(marker))
    if (found) throw new Error(`Fixture auth appeared in production bundle: ${relative(root, path).split(sep).join('/')} (${found})`)
  }
  if (!javascriptFilesInRoot) throw new Error(`No JavaScript found in build directory: ${root}`)
}
process.stdout.write(`Fixture auth absent from ${inspected} production JavaScript and manifest files across both apps.\n`)
