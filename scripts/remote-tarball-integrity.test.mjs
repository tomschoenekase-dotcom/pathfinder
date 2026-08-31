import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const reviewedSheetJsUrl = 'https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz'
const reviewedSheetJsIntegrity =
  'sha512-oLDq3jw7AcLqKWH2AhCpVTZl8mf6X2YReP+Neh0SJUzV/BdZYjth94tG5toiMB1PPrYtxOCfaoUCkvtuH+3AJA=='

function remoteTarballResolutions(source) {
  return source
    .split(/\r?\n/u)
    .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
    .filter(({ line }) => line.startsWith('resolution: {') && line.includes('tarball: http'))
}

test('every remote lockfile tarball carries a SHA-512 integrity binding', async () => {
  const lockfile = await readFile(path.join(repositoryRoot, 'pnpm-lock.yaml'), 'utf8')
  const resolutions = remoteTarballResolutions(lockfile)
  assert.ok(resolutions.length > 0)
  for (const { line, lineNumber } of resolutions) {
    assert.match(line, /\bintegrity: sha512-[A-Za-z0-9+/]+={0,2}(?:,|\})/u, `line ${lineNumber}`)
    assert.match(line, /\btarball: https:\/\//u, `line ${lineNumber}`)
  }
})

test('the reviewed SheetJS artifact is exact and shared by both workspaces', async () => {
  const [lockfile, dashboardPackage, workersPackage] = await Promise.all([
    readFile(path.join(repositoryRoot, 'pnpm-lock.yaml'), 'utf8'),
    readFile(path.join(repositoryRoot, 'apps', 'dashboard', 'package.json'), 'utf8'),
    readFile(path.join(repositoryRoot, 'apps', 'workers', 'package.json'), 'utf8'),
  ])
  assert.match(
    lockfile,
    new RegExp(
      `resolution: \\{integrity: ${reviewedSheetJsIntegrity.replaceAll('+', '\\+')}, tarball: ${reviewedSheetJsUrl.replaceAll('.', '\\.')}\\}`,
      'u',
    ),
  )
  assert.equal(JSON.parse(dashboardPackage).dependencies.xlsx, reviewedSheetJsUrl)
  assert.equal(JSON.parse(workersPackage).dependencies.xlsx, reviewedSheetJsUrl)
})

test('remote-tarball discovery distinguishes an integrity-bound artifact from a mutable URL', () => {
  const fixture = [
    'resolution: {integrity: sha512-AAAA, tarball: https://example.invalid/pinned.tgz}',
    'resolution: {tarball: https://example.invalid/mutable.tgz}',
    'resolution: {integrity: sha512-BBBB}',
  ].join('\n')
  assert.deepEqual(remoteTarballResolutions(fixture), [
    {
      line: 'resolution: {integrity: sha512-AAAA, tarball: https://example.invalid/pinned.tgz}',
      lineNumber: 1,
    },
    {
      line: 'resolution: {tarball: https://example.invalid/mutable.tgz}',
      lineNumber: 2,
    },
  ])
})
