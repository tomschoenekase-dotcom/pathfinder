import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const workDir = mkdtempSync(join(tmpdir(), 'pathfinder-docker-context-'))
const imageTag = `pathfinder-context-boundary-${process.pid}-${Date.now()}`
const archivePath = join(workDir, 'context.tar')
let containerId = ''

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    windowsHide: true,
    ...options,
  })
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed while verifying the effective Docker context.`)
  }
  return result.stdout.trim()
}

try {
  copyFileSync(join(repositoryRoot, '.dockerignore'), join(workDir, '.dockerignore'))
  writeFileSync(join(workDir, 'Dockerfile'), 'FROM scratch\nCOPY . /context\n')
  writeFileSync(join(workDir, 'safe.txt'), 'safe context marker\n')
  writeFileSync(join(workDir, '.env'), 'synthetic root sentinel\n')
  mkdirSync(join(workDir, '.claude'))
  writeFileSync(join(workDir, '.claude', 'settings.local.json'), '{}\n')
  mkdirSync(join(workDir, 'nested', '.claude'), { recursive: true })
  writeFileSync(join(workDir, 'nested', '.env'), 'synthetic nested sentinel\n')
  writeFileSync(join(workDir, 'nested', 'local.env.test'), 'synthetic suffix sentinel\n')
  writeFileSync(join(workDir, 'nested', '.claude', 'settings.local.json'), '{}\n')

  run('docker', ['build', '--quiet', '--tag', imageTag, workDir])
  containerId = run('docker', ['create', imageTag, 'noop'])
  run('docker', ['export', '--output', archivePath, containerId])
  const entries = run('tar', ['-tf', archivePath])
    .split(/\r?\n/u)
    .map((entry) => entry.replace(/^\.\//u, ''))

  if (!entries.includes('context/safe.txt')) {
    throw new Error('Effective Docker context did not retain the safe control file.')
  }
  if (
    entries.some(
      (entry) =>
        entry === 'context/.env' ||
        entry.includes('/.env') ||
        entry.includes('.env.') ||
        entry.includes('/.claude/') ||
        entry.endsWith('/.claude'),
    )
  ) {
    throw new Error('Effective Docker context retained a protected synthetic path.')
  }

  console.log('Verified effective Docker context excludes protected synthetic paths.')
} finally {
  if (containerId) spawnSync('docker', ['rm', '--force', containerId], { windowsHide: true })
  spawnSync('docker', ['image', 'rm', '--force', imageTag], { windowsHide: true })
  rmSync(workDir, { recursive: true, force: true })
}
