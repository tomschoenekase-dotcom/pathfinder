import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('../../', import.meta.url))
export const GUEST_DISPOSITION_RUNTIME_TARGETS = Object.freeze([
  'packages/config/src/guest-conversation-disposition-policy',
  'packages/contracts/src/guest-conversation-disposition',
])

export function renderGuestDispositionRuntime(source, filename) {
  assert.equal(ts.version, '5.9.3', 'Runtime artifact compiler version drift')
  const result = ts.transpileModule(source.replaceAll('\r\n', '\n'), {
    fileName: filename,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      newLine: ts.NewLineKind.LineFeed,
      removeComments: false,
      sourceMap: false,
      declaration: false,
    },
  })
  assert.equal(
    result.diagnostics?.filter((row) => row.category === ts.DiagnosticCategory.Error).length,
    0,
  )
  return (
    '// Generated from canonical TypeScript; do not edit.\n// Regenerate: node scripts/generate-guest-disposition-runtime.mjs --write\n' +
    result.outputText
  )
}

export function assertGuestDispositionRuntimeBytes(source, actual, filename) {
  assert.equal(
    actual,
    renderGuestDispositionRuntime(source, filename),
    `Stale runtime artifact: ${filename}`,
  )
}

export async function verifyGuestDispositionRuntimeArtifacts({ write = false } = {}) {
  assert.equal(typeof write, 'boolean')
  for (const stem of GUEST_DISPOSITION_RUNTIME_TARGETS) {
    const sourcePath = resolve(root, `${stem}.ts`)
    const outputPath = resolve(root, `${stem}.runtime.mjs`)
    const source = await readFile(sourcePath, 'utf8')
    if (write)
      await writeFile(outputPath, renderGuestDispositionRuntime(source, `${stem}.ts`), 'utf8')
    assertGuestDispositionRuntimeBytes(source, await readFile(outputPath, 'utf8'), `${stem}.ts`)
  }
}
