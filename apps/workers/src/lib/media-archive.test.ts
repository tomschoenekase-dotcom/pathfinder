import { createReadStream, type ReadStream } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { describe, expect, it } from 'vitest'

import {
  MediaArchiveByteBudget,
  MediaArchiveByteLimitError,
  MediaTextRetentionBudget,
  forwardReadableErrors,
  jsonArrayExceedsCharacterLimit,
  readUtf8TextPrefix,
} from './media-archive'

async function collectThrough(counter: NodeJS.ReadWriteStream, chunks: Buffer[]): Promise<Buffer> {
  const forwarded: Buffer[] = []
  counter.on('data', (chunk: Buffer) => forwarded.push(chunk))
  await pipeline(Readable.from(chunks), counter)
  return Buffer.concat(forwarded)
}

describe('media archive actual-byte budget', () => {
  it('rejects dishonest metadata based on actual chunks before forwarding the crossing chunk', async () => {
    const budget = new MediaArchiveByteBudget(5)
    const counter = budget.createEntryCounter()
    const forwarded: Buffer[] = []
    counter.on('data', (chunk: Buffer) => forwarded.push(chunk))

    await expect(
      pipeline(Readable.from([Buffer.from('abc'), Buffer.from('def')]), counter),
    ).rejects.toBeInstanceOf(MediaArchiveByteLimitError)

    expect(Buffer.concat(forwarded).toString()).toBe('abc')
    expect(counter.bytes).toBe(3)
    expect(budget.totalBytes).toBe(3)
  })

  it('accepts an entry exactly equal to the limit', async () => {
    const budget = new MediaArchiveByteBudget(5)
    const counter = budget.createEntryCounter()

    await expect(collectThrough(counter, [Buffer.from('ab'), Buffer.from('cde')])).resolves.toEqual(
      Buffer.from('abcde'),
    )
    expect(counter.bytes).toBe(5)
    expect(budget.totalBytes).toBe(5)
  })

  it('shares one budget across ignored-style and supported-style streams', async () => {
    const budget = new MediaArchiveByteBudget(7)
    const ignored = budget.createEntryCounter()
    const supported = budget.createEntryCounter()

    await collectThrough(ignored, [Buffer.from('skip')])
    await expect(collectThrough(supported, [Buffer.from('data')])).rejects.toBeInstanceOf(
      MediaArchiveByteLimitError,
    )

    expect(ignored.bytes).toBe(4)
    expect(supported.bytes).toBe(0)
    expect(budget.totalBytes).toBe(4)
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid byte limit: %s',
    (limit) => {
      expect(() => new MediaArchiveByteBudget(limit)).toThrow(/positive safe integer/)
    },
  )
})

describe('media evidence memory budgets', () => {
  it('shares one Unicode-aware text-retention budget across files', () => {
    const budget = new MediaTextRetentionBudget(5)
    expect(budget.allowance(4)).toBe(4)
    budget.retain('A🌍')
    expect(budget.retainedCharacters).toBe(2)
    expect(budget.allowance(4)).toBe(3)
    budget.retain('abc')
    expect(budget.allowance(4)).toBe(0)
    expect(() => budget.retain('x')).toThrow(/retention budget/)
  })

  it('checks aggregate JSON size incrementally against a hard ceiling', () => {
    expect(jsonArrayExceedsCharacterLimit([], 1)).toBe(true)
    expect(jsonArrayExceedsCharacterLimit([{ value: 'a' }], 20)).toBe(false)
    expect(jsonArrayExceedsCharacterLimit([{ value: 'a' }, { value: '0123456789' }], 20)).toBe(true)
  })

  it.each([0, -1, 1.5, Number.NaN])('rejects an invalid text budget: %s', (limit) => {
    expect(() => new MediaTextRetentionBudget(limit)).toThrow(/positive safe integer/)
    expect(() => jsonArrayExceedsCharacterLimit([], limit)).toThrow(/positive safe integer/)
  })
})

describe('archive transport error forwarding', () => {
  it('destroys the parser with the source error and can detach the listener', async () => {
    const source = new PassThrough()
    const destination = new PassThrough()
    const parserError = new Promise<Error>((resolve) => destination.once('error', resolve))
    const detach = forwardReadableErrors(source, destination)
    const transportError = new Error('transport failed')

    source.emit('error', transportError)
    await expect(parserError).resolves.toBe(transportError)
    expect(destination.destroyed).toBe(true)

    detach()
    expect(source.listenerCount('error')).toBe(0)
  })
})

describe('bounded UTF-8 text prefix', () => {
  it('preserves multi-byte characters split across chunks and counts Unicode characters', async () => {
    const text = `A${String.fromCodePoint(0x00e9)}${String.fromCodePoint(0x1f30d)}Z`
    const expected = `A${String.fromCodePoint(0x00e9)}${String.fromCodePoint(0x1f30d)}`
    const bytes = Buffer.from(text, 'utf8')
    const chunks = [bytes.subarray(0, 2), bytes.subarray(2, 5), bytes.subarray(5)]
    const stream = Readable.from(chunks) as unknown as import('node:fs').ReadStream

    await expect(
      readUtf8TextPrefix('unused', 3, { highWaterMark: 2, openStream: () => stream }),
    ).resolves.toBe(expected)
  })

  it('stops at the prefix without consuming the whole stream', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pathfinder-media-prefix-'))
    const filePath = join(directory, 'large.txt')
    const content = `prefix-${'tail'.repeat(100_000)}`
    let openedStream: ReadStream | undefined

    try {
      await writeFile(filePath, content)
      await expect(
        readUtf8TextPrefix(filePath, 3, {
          highWaterMark: 8,
          openStream: (path, highWaterMark) => {
            openedStream = createReadStream(path, { highWaterMark })
            return openedStream
          },
        }),
      ).resolves.toBe('pre')

      expect(openedStream?.destroyed).toBe(true)
      expect(openedStream?.bytesRead).toBeLessThan(Buffer.byteLength(content))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each([0, -1, 1.5, Number.NaN])('rejects an invalid character limit: %s', async (limit) => {
    await expect(readUtf8TextPrefix('unused', limit)).rejects.toThrow(/positive safe integer/)
  })

  it('destroys the text stream when cancellation is already requested', async () => {
    const controller = new AbortController()
    controller.abort()
    const stream = Readable.from([Buffer.from('unused')]) as unknown as import('node:fs').ReadStream

    await expect(
      readUtf8TextPrefix('unused', 10, {
        openStream: () => stream,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'MediaJobCancelledError' })
    expect(stream.destroyed).toBe(true)
  })

  it('interrupts a text stream that stalls after reading starts', async () => {
    const controller = new AbortController()
    const stream = new Readable({ read() {} }) as unknown as import('node:fs').ReadStream
    const result = readUtf8TextPrefix('unused', 10, {
      openStream: () => stream,
      signal: controller.signal,
    })

    await new Promise((resolve) => setImmediate(resolve))
    controller.abort()

    await expect(result).rejects.toMatchObject({ name: 'MediaJobCancelledError' })
    expect(stream.destroyed).toBe(true)
  })
})
