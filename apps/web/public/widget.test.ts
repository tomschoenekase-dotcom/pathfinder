import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type FakeFrame = {
  loading?: string
  referrerPolicy?: string
  setAttribute: ReturnType<typeof vi.fn>
  src?: string
  style: Record<string, string>
  title?: string
}

function executeWidget(params: { slug: string | null; source?: string; mounted?: boolean }) {
  const inserted: FakeFrame[] = []
  const frame: FakeFrame = { setAttribute: vi.fn(), style: {} }
  const script = {
    dataset: { ...(params.mounted ? { pathfinderMounted: 'true' } : {}) } as Record<string, string>,
    getAttribute: (name: string) => (name === 'data-pathfinder-venue' ? params.slug : null),
    insertAdjacentElement: vi.fn((_position: string, element: FakeFrame) => inserted.push(element)),
    src: params.source ?? 'https://guide.example/widget.js',
    tagName: 'SCRIPT',
  }
  const source = readFileSync(resolve(process.cwd(), 'public/widget.js'), 'utf8')
  runInNewContext(source, {
    URL,
    document: {
      baseURI: 'https://host.example/page',
      createElement: vi.fn(() => frame),
      currentScript: script,
    },
    encodeURIComponent,
  })
  return { frame, inserted, script }
}

describe('classic third-party widget loader', () => {
  beforeEach(() => vi.clearAllMocks())

  it('derives the exact embed origin from its own script and inserts an accessible iframe', () => {
    const { frame, inserted, script } = executeWidget({ slug: 'city-museum' })

    expect(inserted).toEqual([frame])
    expect(frame.src).toBe('https://guide.example/embed/city-museum')
    expect(frame.title).toBe('PathFinder venue guide')
    expect(frame.loading).toBe('lazy')
    expect(frame.referrerPolicy).toBe('strict-origin-when-cross-origin')
    expect(frame.setAttribute).toHaveBeenCalledWith('data-pathfinder-widget', '')
    expect(frame.style).toEqual({
      border: '0',
      display: 'block',
      minHeight: '640px',
      width: '100%',
    })
    expect(script.dataset.pathfinderMounted).toBe('true')
  })

  it.each([null, '', 'Museum', '../museum', 'museum/extra', 'museum?admin=1', 'a'.repeat(201)])(
    'rejects invalid venue authority without inserting a frame: %s',
    (slug) => {
      expect(executeWidget({ slug }).inserted).toEqual([])
    },
  )

  it.each([
    'http://guide.example/widget.js',
    'ftp://guide.example/widget.js',
    'https://user:password@guide.example/widget.js',
  ])('rejects unsafe loader source %s', (source) => {
    expect(executeWidget({ slug: 'museum', source }).inserted).toEqual([])
  })

  it('permits explicit loopback HTTP development and ignores script query authority', () => {
    const { frame } = executeWidget({
      slug: 'museum',
      source: 'http://127.0.0.1:3000/widget.js?target=https://attacker.example',
    })
    expect(frame.src).toBe('http://127.0.0.1:3000/embed/museum')
  })

  it('mounts at most once for one script element', () => {
    expect(executeWidget({ slug: 'museum', mounted: true }).inserted).toEqual([])
  })
})
