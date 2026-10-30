/** Read-only, non-secret CRM inventory. Explicit staging identity is mandatory. */
import { PrismaClient } from '@prisma/client'

async function main() {
  if (
    process.env.RAILWAY_ENVIRONMENT_ID !== 'a7a394fc-aa4e-4a45-bd3c-904419a67818' ||
    process.env.DATABASE_RESOURCE_ID !== '7bd81064-588f-48a5-b138-1fc86691a09b' ||
    process.env.RAILWAY_PROJECT_ID !== '8621111a-4ac8-4d88-9566-4627c8a02059'
  ) {
    throw Object.assign(new Error('STAGING_IDENTITY_REQUIRED'), {
      code: 'STAGING_IDENTITY_REQUIRED',
    })
  }
  const db = new PrismaClient({ log: [] })
  try {
    const [organizations, messages, activities, mailboxes] = await Promise.all([
      db.prospectOrganization.count(),
      db.prospectEmailMessage.count(),
      db.prospectActivity.count(),
      db.correspondenceProviderAccount.findMany({
        select: { id: true, provider: true, connectionStatus: true },
      }),
    ])
    console.log(
      JSON.stringify({ environment: 'staging', organizations, messages, activities, mailboxes }),
    )
  } finally {
    await db.$disconnect()
  }
}
main().catch((error: unknown) => {
  const code =
    error && typeof error === 'object' && 'code' in error ? String(error.code) : 'NO_CODE'
  const kind = error instanceof Error ? error.name : 'unknown'
  const message = error instanceof Error ? error.message : ''
  const reason =
    [
      'did not initialize',
      "Can't reach database",
      'Unknown field',
      'Environment variable not found',
      'credentials',
      'authentication',
    ].find((part) => message.includes(part)) ?? 'other'
  console.error(JSON.stringify({ error: 'STAGING_INVENTORY_FAILED', code, kind, reason }))
  process.exitCode = 1
})
