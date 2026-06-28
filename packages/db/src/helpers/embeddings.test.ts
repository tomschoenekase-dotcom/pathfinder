import { beforeEach, describe, expect, it, vi } from 'vitest'

const { embeddingsCreate, storeKnowledgeEntryEmbedding } = vi.hoisted(() => ({
  embeddingsCreate: vi.fn(),
  storeKnowledgeEntryEmbedding: vi.fn(),
}))

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    embeddings: {
      create: embeddingsCreate,
    },
  })),
}))

vi.mock('@pathfinder/config', () => ({
  env: { OPENAI_API_KEY: 'test-key' },
}))

vi.mock('./semantic-search', () => ({
  storeKnowledgeEntryEmbedding,
  storePlaceEmbedding: vi.fn(),
}))

import { generateAndStoreKnowledgeEntryEmbedding, setOpenAIClientForTesting } from './embeddings'

describe('generateAndStoreKnowledgeEntryEmbedding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setOpenAIClientForTesting(null)
    embeddingsCreate.mockResolvedValue({
      data: [{ embedding: [0.1, 0.2, 0.3] }],
    })
  })

  it('embeds title, category, and content and stores the vector', async () => {
    await generateAndStoreKnowledgeEntryEmbedding({
      id: 'entry_1',
      title: 'Refund policy',
      category: 'Policy',
      content: 'Refunds are available within 30 days.',
    })

    expect(embeddingsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        input: 'Refund policy. Policy. Refunds are available within 30 days.',
      }),
    )
    expect(storeKnowledgeEntryEmbedding).toHaveBeenCalledWith('entry_1', [0.1, 0.2, 0.3])
  })
})
