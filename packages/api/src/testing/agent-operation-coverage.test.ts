import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

// The developer-tool implementation is intentionally executable JavaScript so the inspect-only
// CLI can run without a TypeScript loader.
// @ts-expect-error -- the repository-local .mjs module has no separate declaration file.
import { buildToolCoverageReport } from '../../../../scripts/lib/torchiko-developer-tools.mjs'
import { appRouter } from '../root'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')

describe('agent operation coverage inventory', () => {
  it('matches the authoritative mounted tRPC runtime exactly', async () => {
    const report = await buildToolCoverageReport(root)
    const runtimeRouter = appRouter as unknown as {
      _def: { procedures: Record<string, { _def: { type: string } }> }
    }
    const runtime = Object.entries(runtimeRouter._def.procedures)
      .map(([operationPath, procedure]) => ({
        path: operationPath,
        kind: procedure._def.type,
      }))
      .sort((left, right) => left.path.localeCompare(right.path))
    const staticInventory = report.operations.entries.map(
      ({ path: operationPath, kind }: { path: string; kind: string }) => ({
        path: operationPath,
        kind,
      }),
    )

    expect(staticInventory).toEqual(runtime)
    expect(report.operations.reviewedInventory.matches).toBe(true)
    expect(report.operations.unresolved).toEqual([])
    expect(report.operations.unclassified).toEqual([])
    expect(report.operations.ambiguous).toEqual([])
    expect(report.operations.bindings.healthy).toBe(true)
    expect(report.operations.bindings.validation.unknownOperations).toEqual([])
    expect(report.operations.bindings.validation.unknownSurfaces).toEqual([])
    expect(report.operations.bindings.validation.duplicateOperations).toEqual([])
    expect(report.operations.bindings.validation.unavailableSurfaces).toEqual([])
    expect(report.operations.bindings.validation.digestMatches).toBe(true)
    expect(report.healthy).toBe(true)
  }, 15_000)
})
