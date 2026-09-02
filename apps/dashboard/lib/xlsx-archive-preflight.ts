const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50
const ZIP_MAX_COMMENT_BYTES = 65_535
const ZIP_END_RECORD_BYTES = 22

export const MAX_XLSX_EXPANDED_BYTES = 150 * 1024 * 1024
export const MAX_XLSX_ARCHIVE_ENTRIES = 10_000

export class XlsxArchivePreflightError extends Error {
  constructor(readonly code: 'INVALID_ARCHIVE' | 'EXPANDED_TOO_LARGE' | 'TOO_MANY_ENTRIES') {
    super(code)
    this.name = 'XlsxArchivePreflightError'
  }
}

function fail(code: XlsxArchivePreflightError['code']): never {
  throw new XlsxArchivePreflightError(code)
}

export function inspectXlsxArchive(buffer: ArrayBuffer): {
  entries: number
  expandedBytes: number
} {
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)
  const firstEndOffset = Math.max(
    0,
    bytes.byteLength - ZIP_END_RECORD_BYTES - ZIP_MAX_COMMENT_BYTES,
  )
  let endOffset = -1
  for (
    let offset = bytes.byteLength - ZIP_END_RECORD_BYTES;
    offset >= firstEndOffset;
    offset -= 1
  ) {
    if (view.getUint32(offset, true) === ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      endOffset = offset
      break
    }
  }
  if (endOffset < 0) fail('INVALID_ARCHIVE')

  const diskNumber = view.getUint16(endOffset + 4, true)
  const centralDirectoryDisk = view.getUint16(endOffset + 6, true)
  const entriesOnDisk = view.getUint16(endOffset + 8, true)
  const entries = view.getUint16(endOffset + 10, true)
  const centralDirectoryBytes = view.getUint32(endOffset + 12, true)
  const centralDirectoryOffset = view.getUint32(endOffset + 16, true)
  const commentBytes = view.getUint16(endOffset + 20, true)
  if (
    diskNumber !== 0 ||
    centralDirectoryDisk !== 0 ||
    entriesOnDisk !== entries ||
    entries === 0 ||
    entries === 0xffff ||
    centralDirectoryBytes === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff ||
    endOffset + ZIP_END_RECORD_BYTES + commentBytes !== bytes.byteLength ||
    centralDirectoryOffset + centralDirectoryBytes > endOffset
  ) {
    fail('INVALID_ARCHIVE')
  }
  if (entries > MAX_XLSX_ARCHIVE_ENTRIES) fail('TOO_MANY_ENTRIES')

  const centralDirectoryEnd = centralDirectoryOffset + centralDirectoryBytes
  let cursor = centralDirectoryOffset
  let expandedBytes = 0
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > centralDirectoryEnd) fail('INVALID_ARCHIVE')
    if (view.getUint32(cursor, true) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE) {
      fail('INVALID_ARCHIVE')
    }
    const compressedBytes = view.getUint32(cursor + 20, true)
    const uncompressedBytes = view.getUint32(cursor + 24, true)
    const fileNameBytes = view.getUint16(cursor + 28, true)
    const extraBytes = view.getUint16(cursor + 30, true)
    const entryCommentBytes = view.getUint16(cursor + 32, true)
    if (compressedBytes === 0xffffffff || uncompressedBytes === 0xffffffff) {
      fail('INVALID_ARCHIVE')
    }
    expandedBytes += uncompressedBytes
    if (expandedBytes > MAX_XLSX_EXPANDED_BYTES) fail('EXPANDED_TOO_LARGE')
    cursor += 46 + fileNameBytes + extraBytes + entryCommentBytes
    if (cursor > centralDirectoryEnd) fail('INVALID_ARCHIVE')
  }
  if (cursor !== centralDirectoryEnd) fail('INVALID_ARCHIVE')
  return { entries, expandedBytes }
}
