import { createDiagnosticAnnotation } from './ci-diagnostic-tail.mjs'

export function writeClientBundleBuildDiagnostic({ result, application, stdout }) {
  const diagnostic = createDiagnosticAnnotation(
    `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`.split(/\r?\n/u),
    80,
    8_000,
  )
  stdout.write(`::error title=Client bundle build failed::${application}%0A${diagnostic}\n`)
}
