import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { copyNextStandaloneAssets } from './copy-next-standalone-assets.mjs'

function fixture(distDir) {
  const cwd = mkdtempSync(join(tmpdir(), 'pathfinder standalone copy '))
  mkdirSync(join(cwd, distDir, 'standalone', 'app'), { recursive: true })
  mkdirSync(join(cwd, distDir, 'static'), { recursive: true })
  mkdirSync(join(cwd, 'public'), { recursive: true })
  writeFileSync(join(cwd, distDir, 'standalone', 'app', 'server.js'), 'server')
  writeFileSync(join(cwd, distDir, 'static', 'asset.js'), 'asset')
  writeFileSync(join(cwd, 'public', 'fixture.svg'), 'fixture')
  return cwd
}

describe('copyNextStandaloneAssets', () => {
  for (const distDir of ['.next', '.next-fixture'])
    it(`copies static and public assets for ${distDir}`, () => {
      const cwd = fixture(distDir)
      copyNextStandaloneAssets(cwd, distDir)

      assert.equal(
        readFileSync(join(cwd, distDir, 'standalone', 'app', 'server.js'), 'utf8'),
        'server',
      )
      assert.equal(
        readFileSync(
          join(cwd, distDir, 'standalone', 'app', distDir, 'static', 'asset.js'),
          'utf8',
        ),
        'asset',
      )
      assert.equal(
        readFileSync(join(cwd, distDir, 'standalone', 'app', 'public', 'fixture.svg'), 'utf8'),
        'fixture',
      )
    })
})

it('runs the CLI with a custom distDir from a path containing spaces', () => {
  const cwd = fixture('.next-fixture cli')
  const sourceScript = resolve(dirname(fileURLToPath(import.meta.url)), 'copy-next-standalone-assets.mjs')
  const script = join(cwd, 'copy standalone assets.mjs')
  cpSync(sourceScript, script)
  const result = spawnSync(process.execPath, [script], {
    cwd,
    env: { NEXT_DIST_DIR: '.next-fixture cli' },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(
    readFileSync(
      join(
        cwd,
        '.next-fixture cli',
        'standalone',
        'app',
        '.next-fixture cli',
        'static',
        'asset.js',
      ),
      'utf8',
    ),
    'asset',
  )
})
