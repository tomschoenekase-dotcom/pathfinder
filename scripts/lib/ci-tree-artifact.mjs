import { execFileSync } from 'node:child_process'

export function readTreeArtifact(zip, python = 'python3') {
  if (!Buffer.isBuffer(zip) || zip.length > 256_000) throw new Error('artifact-size')
  return JSON.parse(
    execFileSync(
      python,
      [
        '-c',
        `
import io, sys, zipfile
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:
    entries = archive.infolist()
    if len(entries) != 1 or entries[0].filename != 'ci-tree-evidence.json' or entries[0].file_size > 256000:
        raise ValueError('unexpected-artifact-shape')
    sys.stdout.buffer.write(archive.read(entries[0]))
`,
      ],
      {
        input: zip,
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 256_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    ),
  )
}
