import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'

function findStandaloneServer(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)

    if (entry.isFile() && entry.name === 'server.js' && !path.includes('node_modules')) {
      return dir
    }

    if (entry.isDirectory() && entry.name !== 'node_modules') {
      const found = findStandaloneServer(path)

      if (found) {
        return found
      }
    }
  }

  return null
}

export function copyNextStandaloneAssets(
  cwd = process.cwd(),
  distDir = process.env.NEXT_DIST_DIR || '.next',
) {
  const standaloneRoot = join(cwd, distDir, 'standalone')
  const serverDir = existsSync(standaloneRoot) ? findStandaloneServer(standaloneRoot) : null

  if (!serverDir) {
    throw new Error('Could not find standalone Next.js server.js')
  }

  const publicDir = join(cwd, 'public')
  if (existsSync(publicDir)) {
    cpSync(publicDir, join(serverDir, 'public'), { recursive: true })
  }

  const nextOutputDir = join(serverDir, distDir)
  mkdirSync(nextOutputDir, { recursive: true })
  cpSync(join(cwd, distDir, 'static'), join(nextOutputDir, 'static'), { recursive: true })
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  copyNextStandaloneAssets()
}
