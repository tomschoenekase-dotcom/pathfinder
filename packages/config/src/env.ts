import { z } from 'zod'

const railwayEnvironmentSchema = z.preprocess(
  (value) => value ?? (process.env.NODE_ENV === 'production' ? undefined : 'staging'),
  z.enum(['production', 'staging', 'preview']),
)

const rawEnvSchema = z.object({
  // Deployment boundary: production serves live traffic, staging is synthetic
  // data only, and preview is for ephemeral review deployments. This is
  // required when NODE_ENV=production and defaults to staging for development.
  RAILWAY_ENVIRONMENT: railwayEnvironmentSchema,

  // Recurring jobs should only be registered by production workers unless an
  // environment explicitly opts in or out. Queue consumers run independently.
  WORKER_SCHEDULERS_ENABLED: z.enum(['true', 'false']).optional(),

  // Required from PACKET-03 onward
  DATABASE_URL: z.string().min(1),
  DIRECT_DATABASE_URL: z.string().min(1),

  // Required from PACKET-11 (BullMQ / Redis) onward
  REDIS_URL: z.string().optional(),

  // Required from PACKET-08 (auth) onward
  CLERK_SECRET_KEY: z.string().min(1),
  CLERK_PUBLISHABLE_KEY: z.string().min(1),

  // Required from PACKET-10 (Clerk webhook) onward
  CLERK_WEBHOOK_SECRET: z.string().optional(),

  // Required from PACKET-13 (chat router) onward
  ANTHROPIC_API_KEY: z.string().min(1).optional(),

  // Required for RAG / semantic place search
  OPENAI_API_KEY: z.string().min(1).optional(),
  MEDIA_ANALYSIS_MODEL: z.string().min(1).optional(),
  MEDIA_SYNTHESIS_MODEL: z.string().min(1).optional(),
  MEDIA_TRANSCRIPTION_MODEL: z.string().min(1).optional(),

  // Required from PACKET-12 (integrations) onward
  INTEGRATION_ENCRYPTION_KEY: z.string().optional(),

  // Required when storage is wired (post-MVP scaffolding)
  STORAGE_BUCKET: z.string().optional(),
  STORAGE_REGION: z.string().optional(),
  STORAGE_ENDPOINT: z.string().url().optional(),
  STORAGE_ACCESS_KEY_ID: z.string().optional(),
  STORAGE_SECRET_ACCESS_KEY: z.string().optional(),

  // Required from PACKET-14 (analytics) onward
  POSTHOG_API_KEY: z.string().optional(),

  // Required when email is wired (post-MVP scaffolding)
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM_EMAIL: z.string().optional(),
  DASHBOARD_URL: z.string().optional(),
})

export const envSchema = rawEnvSchema.transform((values) => ({
  ...values,
  WORKER_SCHEDULERS_ENABLED:
    values.WORKER_SCHEDULERS_ENABLED === undefined
      ? values.RAILWAY_ENVIRONMENT === 'production'
      : values.WORKER_SCHEDULERS_ENABLED === 'true',
}))

// During Next.js build (NEXT_PHASE=phase-production-build) env vars may not
// be available. Skip strict validation then; the app will crash at runtime if
// a required var is missing, which is the correct behaviour.
export const env =
  process.env.NEXT_PHASE === 'phase-production-build'
    ? (process.env as unknown as z.infer<typeof envSchema>)
    : envSchema.parse(process.env)
