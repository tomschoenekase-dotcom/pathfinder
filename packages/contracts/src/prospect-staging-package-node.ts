import { createHash } from 'node:crypto'

import {
  ProspectStagingPackageV1,
  type ProspectStagingPackageV1Type,
} from './prospect-staging-package'

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(',')}}`
}

export function prospectStagingPackageHash(value: ProspectStagingPackageV1Type): string {
  return createHash('sha256')
    .update(`torchiko-prospect-staging-package-v1\n${canonical(value)}`, 'utf8')
    .digest('hex')
}

export function parseProspectStagingPackage(value: unknown) {
  const parsed = ProspectStagingPackageV1.parse(value)
  return { package: parsed, packageHash: prospectStagingPackageHash(parsed) }
}
