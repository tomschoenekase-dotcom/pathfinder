import { z } from 'zod'

const railwayEnvironmentSchema = z.preprocess(
  (value) => value ?? (process.env.NODE_ENV === 'production' ? undefined : 'staging'),
  z.enum(['production', 'staging', 'preview']),
)

const rawEnvSchema = z
  .object({
    // Deployment boundary: production serves live traffic, staging is synthetic
    // data only, and preview is for ephemeral review deployments. This is
    // required when NODE_ENV=production and defaults to staging for development.
    RAILWAY_ENVIRONMENT: railwayEnvironmentSchema,

    // Non-secret, operator-confirmed resource identities. Staging requires
    // these so an environment label alone cannot admit a deployment.
    DATABASE_RESOURCE_ID: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u)
      .optional(),
    REDIS_RESOURCE_ID: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u)
      .optional(),
    STORAGE_RESOURCE_ID: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u)
      .optional(),

    // Recurring jobs should only be registered by production workers unless an
    // environment explicitly opts in or out. Production must declare this
    // explicitly; omission is never authority for background side effects.
    WORKER_SCHEDULERS_ENABLED: z.enum(['true', 'false']).optional(),

    // Starts consumers that can reach AI, email, or media providers. Staging
    // defaults off so its worker remains connectivity-only without provider
    // credentials, queues, consumers, schedulers, or accidental outbound calls.
    OUTBOUND_PROVIDER_WORKERS_ENABLED: z.enum(['true', 'false']).optional(),

    // Mutation dispatch is correctness infrastructure, separate from business
    // cron. Every worker environment requires explicit rollout authority.
    EMBEDDING_DISPATCH_ENABLED: z.enum(['true', 'false']).optional(),

    // Durable generation request publication is correctness infrastructure.
    // No environment gets implicit rollout authority.
    GENERATION_DISPATCH_ENABLED: z.enum(['true', 'false']).optional(),

    // Expired generation recovery is correctness infrastructure, separate from
    // business cron. Staging/preview require an explicit canary opt-in.
    GENERATION_RECOVERY_ENABLED: z.enum(['true', 'false']).optional(),

    // Evaluation consumption is a separate, server-only rollout gate. It is
    // deliberately default-off in every environment; tenant admission still
    // requires the evaluation-runner-v1 TenantFeatureFlag as well.
    EVALUATION_RUNNER_ENABLED: z.enum(['true', 'false']).optional(),

    // Agent task consumption is separately gated from every existing provider
    // workload. It stays off until an operator configures an execution adapter.
    AGENT_RUNNER_ENABLED: z.enum(['true', 'false']).optional(),

    // Public machine-to-machine bridge transport is separately dark. Database
    // activation alone must never expose the HTTP surface.
    AGENT_BRIDGE_HTTP_ENABLED: z.enum(['true', 'false']).optional(),

    // Controlled prerequisite for the hosted widget. It remains default-off
    // until the origin/key boundary and third-party staging proof exist.
    EMBED_PREVIEW_ENABLED: z.enum(['true', 'false']).optional(),
    VOICE_MODE_ENABLED: z.enum(['true', 'false']).optional(),
    OPENAI_REALTIME_PREMIUM_MODEL: z.string().min(1).max(100).optional(),
    OPENAI_REALTIME_ECONOMY_MODEL: z.string().min(1).max(100).optional(),
    OPENAI_REALTIME_TRANSCRIPTION_MODEL: z.string().min(1).max(100).optional(),
    // Server-only, bounded static policy for the staging framing kernel. Runtime
    // parsing applies the exact per-venue origin shape and fails closed.
    WIDGET_PREVIEW_ORIGINS_JSON: z.string().max(16_384).optional(),

    // Error monitoring is default-off. DSNs are only used when the matching
    // explicit runtime flag is true; source-map credentials are build-only.
    SENTRY_ENABLED: z.enum(['true', 'false']).optional(),
    SENTRY_DSN: z.string().url().optional(),
    SENTRY_RELEASE: z.string().min(1).max(100).optional(),

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

    // Optional authoritative malware scanner for quarantined intake bytes.
    // Without it, uploads remain PRECHECK_PASSED and cannot become reviewable.
    INTAKE_CLAMAV_HOST: z.string().trim().min(1).max(253).optional(),
    INTAKE_CLAMAV_PORT: z.coerce.number().int().min(1).max(65_535).optional(),

    // Required when email is wired (post-MVP scaffolding)
    RESEND_API_KEY: z.string().optional(),
    RESEND_FROM_EMAIL: z.string().optional(),
    RESEND_WEBHOOK_SECRET: z.string().optional(),
    PROSPECT_OUTREACH_DELIVERY_ENABLED: z.enum(['true', 'false']).default('false'),
    PROSPECT_OUTREACH_REPLY_DOMAIN: z.string().trim().min(1).max(253).optional(),
    PROSPECT_OUTREACH_REPLY_SECRET: z.string().min(32).optional(),
    DASHBOARD_URL: z.string().optional(),
    OPERATIONAL_ALERT_DELIVERY_ENABLED: z.enum(['true', 'false']).optional(),
    OPERATIONAL_ALERT_EMAIL_TO: z.string().email().optional(),
    OPERATIONAL_ALERT_MIN_SEVERITY: z.enum(['INFO', 'WARNING', 'ERROR', 'CRITICAL']).optional(),
    OPERATIONAL_ALERT_DEV_SINK_ENABLED: z.enum(['true', 'false']).optional(),
  })
  .superRefine((values, ctx) => {
    if (values.RAILWAY_ENVIRONMENT === 'production' && !values.REDIS_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['REDIS_URL'],
        message: 'REDIS_URL is required in production',
      })
    }
    if (values.RAILWAY_ENVIRONMENT === 'staging' && process.env.NODE_ENV === 'production') {
      for (const field of ['DATABASE_RESOURCE_ID', 'REDIS_RESOURCE_ID'] as const) {
        if (!values[field]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `${field} is required in staging`,
          })
        }
      }
    }
  })

export const envSchema = rawEnvSchema.transform((values) => ({
  ...values,
  WORKER_SCHEDULERS_ENABLED: values.WORKER_SCHEDULERS_ENABLED === 'true',
  OUTBOUND_PROVIDER_WORKERS_ENABLED: values.OUTBOUND_PROVIDER_WORKERS_ENABLED === 'true',
  EMBEDDING_DISPATCH_ENABLED: values.EMBEDDING_DISPATCH_ENABLED === 'true',
  GENERATION_DISPATCH_ENABLED: values.GENERATION_DISPATCH_ENABLED === 'true',
  GENERATION_RECOVERY_ENABLED: values.GENERATION_RECOVERY_ENABLED === 'true',
  EVALUATION_RUNNER_ENABLED: values.EVALUATION_RUNNER_ENABLED === 'true',
  AGENT_RUNNER_ENABLED: values.AGENT_RUNNER_ENABLED === 'true',
  AGENT_BRIDGE_HTTP_ENABLED: values.AGENT_BRIDGE_HTTP_ENABLED === 'true',
  EMBED_PREVIEW_ENABLED: values.EMBED_PREVIEW_ENABLED === 'true',
  VOICE_MODE_ENABLED: values.VOICE_MODE_ENABLED === 'true',
  OPERATIONAL_ALERT_DELIVERY_ENABLED: values.OPERATIONAL_ALERT_DELIVERY_ENABLED === 'true',
  OPERATIONAL_ALERT_DEV_SINK_ENABLED: values.OPERATIONAL_ALERT_DEV_SINK_ENABLED === 'true',
}))

// During Next.js build (NEXT_PHASE=phase-production-build) env vars may not
// be available. Skip strict validation then; the app will crash at runtime if
// a required var is missing, which is the correct behaviour.
export const env =
  process.env.NEXT_PHASE === 'phase-production-build'
    ? (process.env as unknown as z.infer<typeof envSchema>)
    : envSchema.parse(process.env)
