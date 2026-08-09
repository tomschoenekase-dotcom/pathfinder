import { access, readdir } from 'node:fs/promises'
import path from 'node:path'

const WORKSPACE_GROUPS = ['apps', 'packages']

export function parsePnpmWorkspacePackagePatterns(yaml) {
  const packagesHeading = /^packages:\s*$/mu.exec(yaml)
  if (!packagesHeading) {
    throw new Error('pnpm-workspace.yaml is missing a packages section')
  }

  const remainder = yaml.slice(packagesHeading.index + packagesHeading[0].length)
  const nextTopLevelKeyIndex = remainder.search(/^\S[^:]*:\s*$/mu)
  const section = nextTopLevelKeyIndex === -1 ? remainder : remainder.slice(0, nextTopLevelKeyIndex)
  const patterns = []

  for (const line of section.split(/\r?\n/u)) {
    if (!line.trim()) continue
    const match = line.match(/^\s+-\s+(?:(['"])([^'"]+)\1|([^'"\s#][^\s#]*))(?:\s+#.*)?\s*$/u)
    const pattern = match?.[2] ?? match?.[3]
    if (!pattern) {
      throw new Error(`Malformed pnpm workspace package pattern: ${line}`)
    }
    patterns.push(pattern)
  }

  return patterns
}

export function parseReadmeWorkspaceInventory(markdown) {
  const heading = /^## Workspaces\s*$/mu.exec(markdown)
  if (!heading) {
    throw new Error('README is missing a Workspaces section')
  }
  const remainder = markdown.slice(heading.index + heading[0].length)
  const nextHeadingIndex = remainder.search(/^##\s/mu)
  const section = nextHeadingIndex === -1 ? remainder : remainder.slice(0, nextHeadingIndex)

  const paths = []
  for (const line of section.split(/\r?\n/u)) {
    if (!line.trimStart().startsWith('-')) continue
    if (!line.startsWith('- ')) {
      throw new Error(`Malformed README workspace entry: ${line}`)
    }
    const workspacePath = line.match(/^- `((?:apps|packages)\/[^`]+)`(?:\s+—\s+.+)?$/u)?.[1]
    if (!workspacePath || workspacePath !== workspacePath.trim()) {
      throw new Error(`Malformed README workspace entry: ${line}`)
    }
    paths.push(workspacePath)
  }

  return paths
}

export async function discoverWorkspaceManifestPaths(repositoryRoot) {
  const paths = []

  for (const group of WORKSPACE_GROUPS) {
    const groupPath = path.join(repositoryRoot, group)
    let entries
    try {
      entries = await readdir(groupPath, { withFileTypes: true })
    } catch (error) {
      throw new Error(`Workspace group directory is unavailable: ${group}`, { cause: error })
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const manifestPath = path.join(groupPath, entry.name, 'package.json')
      try {
        await access(manifestPath)
      } catch {
        continue
      }
      paths.push(`${group}/${entry.name}`)
    }
  }

  return paths.sort()
}

export function auditReadmeWorkspaceInventory(documentedPaths, manifestPaths) {
  const documented = [...new Set(documentedPaths)].sort()
  const manifests = [...new Set(manifestPaths)].sort()

  return {
    duplicates: documentedPaths.filter((item, index) => documentedPaths.indexOf(item) !== index),
    missing: manifests.filter((item) => !documented.includes(item)),
    unexpected: documented.filter((item) => !manifests.includes(item)),
    documented,
    manifests,
  }
}
