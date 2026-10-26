import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(scriptsDirectory, '..')

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      // Next standalone traces contain copies of other apps; they are not web source.
      if (entry.isDirectory() && ['.next', 'node_modules'].includes(entry.name)) return []
      const resolved = path.join(directory, entry.name)
      if (entry.isDirectory()) return sourceFiles(resolved)
      return /\.(?:ts|tsx)$/u.test(entry.name) ? [resolved] : []
    }),
  )
  return nested.flat()
}

test('source discovery retains nested application files and excludes generated copies', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'character-boundary-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const files = [
    'components/Nested.tsx',
    'app/deep/page.tsx',
    '.custom/StillSource.ts',
    '.next/standalone/apps/dashboard/Generated.tsx',
    'node_modules/library/Dependency.ts',
  ]
  for (const file of files) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await writeFile(path.join(root, file), "import { Character } from '@pathfinder/ui/character'\n")
  }
  assert.deepEqual(
    (await sourceFiles(root)).map((file) => path.relative(root, file).replaceAll('\\', '/')).sort(),
    files.slice(0, 3).sort(),
  )
})

test('the character renderer remains behind an explicit package subpath', async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(repositoryRoot, 'packages', 'ui', 'package.json'), 'utf8'),
  )
  assert.equal(packageJson.exports['./character'], './src/character/index.ts')

  const rootBarrel = await readFile(
    path.join(repositoryRoot, 'packages', 'ui', 'src', 'index.ts'),
    'utf8',
  )
  assert.doesNotMatch(rootBarrel, /['"]\.\/character(?:\/index)?['"]/u)
})

test('Classic visitor surfaces cannot statically import the character renderer', async () => {
  const webRoot = path.join(repositoryRoot, 'apps', 'web')
  const files = await sourceFiles(webRoot)
  const productionFiles = files.filter((file) => !/\.test\.tsx?$/u.test(file))
  const characterImporters = []

  for (const file of productionFiles) {
    const source = await readFile(file, 'utf8')
    if (source.includes("from '@pathfinder/ui/character'")) {
      characterImporters.push(path.relative(repositoryRoot, file).replaceAll('\\', '/'))
    }
  }

  assert.deepEqual(characterImporters, ['apps/web/components/VenueCharacterStage.tsx'])

  const shell = await readFile(path.join(webRoot, 'components', 'VenueChatShell.tsx'), 'utf8')
  assert.match(shell, /dynamic\(\s*\(\) => import\('\.\/VenueCharacterStage'\)/u)
  assert.doesNotMatch(shell, /from '@pathfinder\/ui\/character'/u)
})
