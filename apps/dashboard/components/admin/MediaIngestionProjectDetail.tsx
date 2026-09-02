'use client'

import { useEffect, useState } from 'react'
import type { inferRouterOutputs } from '@trpc/server'

import type { AppRouter } from '@pathfinder/api'

import { runBoundedClientRequest } from '../../lib/bounded-client-request'
import { useTRPCClient } from '../../lib/trpc'
import { MediaIngestionReview } from './MediaIngestionReview'

type MediaProject = inferRouterOutputs<AppRouter>['mediaIngestion']['get']

const ACTIVE_STATUSES = new Set([
  'UPLOADING',
  'QUEUED',
  'INVENTORYING',
  'ANALYZING',
  'SYNTHESIZING',
])
const BASE_POLL_MS = 3_000
const MAX_POLL_MS = 30_000
const REQUEST_TIMEOUT_MS = 15_000

export function MediaIngestionProjectDetail({ initialProject }: { initialProject: MediaProject }) {
  const client = useTRPCClient()
  const [project, setProject] = useState(initialProject)
  const [pollError, setPollError] = useState<string | null>(null)

  useEffect(() => {
    if (!ACTIVE_STATUSES.has(project.status)) return
    let disposed = false
    let failures = 0
    let timer: number | undefined
    const controller = new AbortController()

    const schedule = (delay: number) => {
      if (!disposed) timer = window.setTimeout(() => void poll(), delay)
    }
    const poll = async () => {
      if (document.hidden) {
        schedule(BASE_POLL_MS)
        return
      }
      try {
        const status = await runBoundedClientRequest({
          parentSignal: controller.signal,
          timeoutMs: REQUEST_TIMEOUT_MS,
          request: (signal) =>
            client.mediaIngestion.status.query(
              {
                tenantId: project.tenantId,
                venueId: project.venueId,
                projectId: project.id,
              },
              { signal },
            ),
        })
        if (disposed) return
        failures = 0
        setPollError(null)
        if (status.hasDraft) {
          const detail = await runBoundedClientRequest({
            parentSignal: controller.signal,
            timeoutMs: REQUEST_TIMEOUT_MS,
            request: (signal) =>
              client.mediaIngestion.get.query(
                {
                  tenantId: project.tenantId,
                  venueId: project.venueId,
                  projectId: project.id,
                },
                { signal },
              ),
          })
          if (!disposed) setProject(detail)
          return
        }
        setProject((current) => ({
          ...current,
          status: status.status,
          stage: status.stage,
          progress: status.progress,
          coverage: status.coverage,
          error: status.error,
          updatedAt: status.updatedAt,
          completedAt: status.completedAt,
          reviewGeneration: status.reviewGeneration,
        }))
        if (ACTIVE_STATUSES.has(status.status)) schedule(BASE_POLL_MS)
      } catch (error) {
        if (disposed) return
        failures += 1
        setPollError(
          error instanceof Error ? error.message : 'Live status is temporarily unavailable.',
        )
        schedule(Math.min(MAX_POLL_MS, BASE_POLL_MS * 2 ** Math.min(failures, 4)))
      }
    }

    schedule(BASE_POLL_MS)
    return () => {
      disposed = true
      controller.abort()
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [client, project.id, project.status, project.tenantId, project.venueId])

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-4xl font-semibold tracking-tight text-pf-deep">{project.name}</h1>
          <span className="rounded-full bg-pf-primary/10 px-3 py-1 text-xs font-semibold text-pf-primary">
            {project.status.replace(/_/g, ' ').toLowerCase()}
          </span>
        </div>
        <p className="text-sm text-pf-deep/60">
          {project.sourceFileName ?? 'No archive'} · stage {project.stage} · {project.progress}%
        </p>
        {ACTIVE_STATUSES.has(project.status) ? (
          <div
            className="h-2 overflow-hidden rounded-full bg-pf-light"
            aria-label="Analysis progress"
          >
            <div
              className="h-full bg-pf-accent transition-[width]"
              style={{ width: `${Math.max(0, Math.min(100, project.progress))}%` }}
            />
          </div>
        ) : null}
        {pollError ? (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Live status is temporarily unavailable. The last confirmed state is shown; retrying
            automatically.
          </p>
        ) : null}
        {project.error ? (
          <p className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {project.error}
          </p>
        ) : null}
      </header>

      {project.draftJson ? (
        <MediaIngestionReview initialProject={project} />
      ) : (
        <div className="rounded-2xl border border-pf-light bg-pf-white p-8 text-sm text-pf-deep/60 shadow-sm">
          {ACTIVE_STATUSES.has(project.status)
            ? 'Analysis is running. This page will update automatically.'
            : 'No review draft is available for this intake.'}
        </div>
      )}
    </div>
  )
}
