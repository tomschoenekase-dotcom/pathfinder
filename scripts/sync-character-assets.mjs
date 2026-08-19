import { copyFile, mkdir, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { repositoryRoot, verifyCharacterAssets } from './verify-character-assets.mjs'

export const CHARACTER_ASSET_APP_TARGETS = ['apps/dashboard/public', 'apps/web/public']

export async function syncCharacterAssets({
  root = repositoryRoot,
  targetRoots = CHARACTER_ASSET_APP_TARGETS.map((target) => path.join(root, target)),
} = {}) {
  const verified = await verifyCharacterAssets(root)
  const copied = []

  for (const targetRoot of targetRoots) {
    for (const pack of verified) {
      const destination = path.resolve(targetRoot, pack.manifest.publicBasePath.replace(/^\//, ''))
      const expectedTargetRoot = path.resolve(targetRoot)
      if (!destination.startsWith(`${expectedTargetRoot}${path.sep}`)) {
        throw new Error(`Character asset destination escaped target root: ${destination}`)
      }
      await mkdir(destination, { recursive: true })
      for (const file of pack.files) {
        const source = path.join(pack.packRoot, file)
        const target = path.join(destination, file)
        await copyFile(source, target)
        const [sourceMetadata, targetMetadata] = await Promise.all([stat(source), stat(target)])
        if (sourceMetadata.size !== targetMetadata.size) {
          throw new Error(`Character asset copy size mismatch: ${target}`)
        }
        copied.push(target)
      }

      const targetEntries = await readdir(destination, { withFileTypes: true })
      for (const entry of targetEntries) {
        if (!entry.isFile() || !pack.files.includes(entry.name)) {
          throw new Error(`Unexpected file in synchronized character pack: ${entry.name}`)
        }
      }
    }
  }

  return copied
}

const executedDirectly = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false

if (executedDirectly) {
  const copied = await syncCharacterAssets()
  process.stdout.write(`${JSON.stringify({ ok: true, copied: copied.length })}\n`)
}
