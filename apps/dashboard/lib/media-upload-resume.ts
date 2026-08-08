export type CompletedMediaUploadPart = {
  partNumber: number
  etag: string
  size: number
}

export function planMediaUploadResume(partCount: number, completed: CompletedMediaUploadPart[]) {
  if (!Number.isSafeInteger(partCount) || partCount <= 0) {
    throw new Error('Media upload part count must be a positive safe integer.')
  }
  const completedPartNumbers = new Set<number>()
  for (const part of completed) {
    if (
      !Number.isSafeInteger(part.partNumber) ||
      part.partNumber < 1 ||
      part.partNumber > partCount ||
      completedPartNumbers.has(part.partNumber) ||
      typeof part.etag !== 'string' ||
      part.etag.length === 0 ||
      !Number.isSafeInteger(part.size) ||
      part.size <= 0
    ) {
      throw new Error('Media upload resume state is invalid.')
    }
    completedPartNumbers.add(part.partNumber)
  }
  return {
    parts: completed.map(({ partNumber, etag }) => ({ partNumber, etag })),
    remainingPartNumbers: Array.from({ length: partCount }, (_, index) => index + 1).filter(
      (partNumber) => !completedPartNumbers.has(partNumber),
    ),
    uploadedBytes: completed.reduce((total, part) => total + part.size, 0),
  }
}
