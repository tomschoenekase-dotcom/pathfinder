'use client'

import { useState } from 'react'
import { SourceConnectionsSettings } from '../../../components/SourceConnectionsSettings'
import { FixtureTRPCClientProvider, type DashboardTRPCClient } from '../../../lib/trpc'
import type { SourceConnectionConfig } from '@pathfinder/contracts/source-connections'

type Row = {
  id: string
  name: string
  venueId: string
  updatedAt: string
  state: string
  approved: boolean
  config: SourceConnectionConfig
  preview: unknown
  previewAt: string | null
  previewErrorCategory: string | null
  lastAttemptAt: string | null
  lastSuccessAt: string | null
  lastErrorAt: string | null
  lastErrorCategory: string | null
  consecutiveFailures: number
}
function fixtureClient() {
  let rows: Row[] = []
  let counter = 0
  const timestamp = () => new Date(Date.now() + ++counter).toISOString()
  const get = (input: { connectorId: string }) => {
    const row = rows.find((item) => item.id === input.connectorId)
    if (!row) throw new Error('Source not found')
    return row
  }
  return {
    sourceConnections: {
      list: { query: async () => structuredClone(rows) },
      createDraft: {
        mutate: async (input: { name: string; config: SourceConnectionConfig }) => {
          rows = [
            ...rows,
            {
              id: `fixture_source_${rows.length}`,
              venueId: 'fixture_venue',
              name: input.name,
              config: input.config,
              updatedAt: timestamp(),
              state: 'DISABLED',
              approved: false,
              preview: null,
              previewAt: null,
              previewErrorCategory: null,
              lastAttemptAt: null,
              lastSuccessAt: null,
              lastErrorAt: null,
              lastErrorCategory: null,
              consecutiveFailures: 0,
            },
          ]
          return {}
        },
      },
      updateDraft: {
        mutate: async (input: { connectorId: string; config: SourceConnectionConfig }) => {
          Object.assign(get(input), {
            config: input.config,
            preview: null,
            approved: false,
            updatedAt: timestamp(),
          })
          return {}
        },
      },
      requestPreview: {
        mutate: async (input: { connectorId: string }) => {
          const row = get(input)
          row.previewAt = timestamp()
          row.preview = {
            previewId: `preview_${counter}`,
            previewHash: 'a'.repeat(64),
            configHash: 'b'.repeat(64),
            status: 'VALID',
            observedAt: row.previewAt,
            issues: [],
            cost: { fetches: 1, bytes: 1240 },
            records: [
              {
                id: 'public_program',
                kind: 'event',
                title: 'Saturday public program',
                text: 'A synthetic program extracted from the approved fixture page.',
                startDate: '2026-10-10',
                endDate: '2026-10-10',
                showtimes: [{ startAt: '2026-10-10T15:00:00Z', endAt: '2026-10-10T16:00:00Z' }],
                links: ['https://example.org/program'],
              },
            ],
          }
          return { queued: true }
        },
      },
      approvePreview: {
        mutate: async (input: { connectorId: string; previewHash: string }) => {
          const row = get(input)
          Object.assign(row, { approved: true, state: 'ACTIVE', updatedAt: timestamp() })
          row.config.approval = {
            approvedConfigHash: 'b'.repeat(64),
            approvedPreviewHash: input.previewHash,
            approvedAt: timestamp(),
            approvedBy: 'fixture_manager',
          }
          return {}
        },
      },
      pause: {
        mutate: async (input: { connectorId: string }) => {
          Object.assign(get(input), { state: 'DISABLED', updatedAt: timestamp() })
          return {}
        },
      },
      resume: {
        mutate: async (input: { connectorId: string }) => {
          Object.assign(get(input), { state: 'ACTIVE', updatedAt: timestamp() })
          return {}
        },
      },
      requestRefresh: {
        mutate: async (input: { connectorId: string }) => {
          Object.assign(get(input), {
            lastAttemptAt: timestamp(),
            lastErrorAt: timestamp(),
            lastErrorCategory: 'network_error',
            consecutiveFailures: 1,
          })
          return { queued: true }
        },
      },
    },
  } as unknown as DashboardTRPCClient
}

export function SourceConnectionsFixture() {
  const [client] = useState(fixtureClient)
  return (
    <FixtureTRPCClientProvider client={client}>
      <main className="min-h-screen bg-pf-cream px-4 py-8 sm:px-8">
        <div className="mx-auto max-w-5xl">
          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-pf-deep/75">
            Synthetic operator fixture · no network submissions
          </p>
          <h1 className="mb-6 text-3xl font-semibold text-pf-deep">Venue source settings</h1>
          <h2 className="mb-3 text-xl font-semibold text-pf-deep">Approved information</h2>
          <SourceConnectionsSettings venueId="fixture_venue" />
        </div>
      </main>
    </FixtureTRPCClientProvider>
  )
}
