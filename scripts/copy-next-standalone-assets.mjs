import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

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

const standaloneRoot = join(process.cwd(), '.next', 'standalone')
const serverDir = existsSync(standaloneRoot) ? findStandaloneServer(standaloneRoot) : null

if (!serverDir) {
  throw new Error('Could not find standalone Next.js server.js')
}

const publicDir = join(process.cwd(), 'public')
if (existsSync(publicDir)) {
  cpSync(publicDir, join(serverDir, 'public'), { recursive: true })
}

const nextOutputDir = join(serverDir, '.next')
mkdirSync(nextOutputDir, { recursive: true })
cpSync(join(process.cwd(), '.next', 'static'), join(nextOutputDir, 'static'), { recursive: true })
