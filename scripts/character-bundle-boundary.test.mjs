import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(scriptsDirectory, '..')

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const resolved = path.join(directory, entry.name)
      if (entry.isDirectory()) return sourceFiles(resolved)
      return /\.(?:ts|tsx)$/u.test(entry.name) ? [resolved] : []
    }),
  )
  return nested.flat()
}

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
