import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { format } from 'prettier'

import { normalizeGeneratedText, renderRepositoryIndex } from './lib/repository-index.mjs'

const root = path.resolve(import.meta.dirname, '..')
const outputPath = path.join(root, 'docs/repository-command-index.md')
const check = process.argv.slice(2).includes('--check')

const [packageSource, environmentSource] = await Promise.all([
  readFile(path.join(root, 'package.json'), 'utf8'),
  readFile(path.join(root, '.env.example'), 'utf8'),
])
const rendered = await format(
  renderRepositoryIndex({
    packageJson: JSON.parse(packageSource),
    environmentSource,
  }),
  { parser: 'markdown' },
)

if (check) {
  const current = await readFile(outputPath, 'utf8').catch(() => '')
  if (normalizeGeneratedText(current) !== normalizeGeneratedText(rendered)) {
    throw new Error('repository-index-stale')
  }
  process.stdout.write('Repository command/configuration index is current.\n')
} else {
  await writeFile(outputPath, rendered, 'utf8')
  process.stdout.write(`${path.relative(root, outputPath)}\n`)
}
