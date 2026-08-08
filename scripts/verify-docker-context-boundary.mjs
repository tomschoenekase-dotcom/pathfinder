import { readdirSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DockerContextBoundaryError,
  verifyDockerContextBoundary,
  verifyDockerIgnoreInventory,
  verifyDockerfileContextGuard,
} from './lib/docker-context-boundary.mjs'

const dockerIgnorePath = fileURLToPath(new URL('../.dockerignore', import.meta.url))
const workerDockerfilePath = fileURLToPath(new URL('../Dockerfile.workers', import.meta.url))
const repositoryRoot = dirname(dockerIgnorePath)
const skippedDirectories = new Set(['.git', '.next', '.turbo', 'coverage', 'dist', 'node_modules'])

function findDockerIgnoreFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return skippedDirectories.has(entry.name)
        ? []
        : findDockerIgnoreFiles(resolve(directory, entry.name))
    }
    return entry.isFile() &&
      (entry.name === '.dockerignore' || entry.name.endsWith('.dockerignore'))
      ? [relative(repositoryRoot, resolve(directory, entry.name))]
      : []
  })
}

try {
  const result = verifyDockerContextBoundary(readFileSync(dockerIgnorePath, 'utf8'))
  verifyDockerIgnoreInventory(findDockerIgnoreFiles(repositoryRoot))
  verifyDockerfileContextGuard(readFileSync(workerDockerfilePath, 'utf8'))
  console.log(
    `Verified Docker context boundary with ${result.protectedRuleCount} protected-path rules and a pre-install image guard.`,
  )
} catch (error) {
  if (error instanceof DockerContextBoundaryError) {
    console.error(`Docker context boundary verification failed: ${error.message}`)
    process.exitCode = 1
  } else {
    throw error
  }
}
