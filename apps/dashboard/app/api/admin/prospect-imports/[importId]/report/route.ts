import { auth } from '@clerk/nextjs/server'
import { db, withTenantIsolationBypass } from '@pathfinder/db'
import { NextResponse } from 'next/server'
import { prospectImportReportCsvCell } from '../../../../../../lib/prospect-import-report-csv'

export async function GET(_request: Request, context: { params: Promise<{ importId: string }> }) {
  const { userId, sessionClaims } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 })
  const isPlatformAdmin =
    (sessionClaims?.publicMetadata as { platform_role?: string } | undefined)?.platform_role ===
    'PLATFORM_ADMIN'
  if (!isPlatformAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { importId } = await context.params
  if (!importId || importId.length > 191) {
    return NextResponse.json({ error: 'Invalid import identity' }, { status: 400 })
  }
  const prospectImport = await withTenantIsolationBypass(() =>
    db.prospectImport.findUnique({
      where: { id: importId },
      select: { fileName: true, reportHash: true },
    }),
  )
  if (!prospectImport?.reportHash) {
    return NextResponse.json({ error: 'Dry-run report is not ready' }, { status: 404 })
  }

  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(
          encoder.encode('sheet,row,status,row_fingerprint,warnings,errors,duplicate_matches\r\n'),
        )
        let cursor: string | undefined
        for (;;) {
          const rows = await withTenantIsolationBypass(() =>
            db.prospectImportReportEntry.findMany({
              where: { importId },
              orderBy: { id: 'asc' },
              take: 500,
              ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            }),
          )
          if (!rows.length) break
          const chunk = rows
            .map((row) =>
              [
                row.sheetName,
                row.originalRowNumber,
                row.status,
                row.rowFingerprint,
                row.warnings,
                row.errors,
                row.duplicateMatches,
              ]
                .map(prospectImportReportCsvCell)
                .join(','),
            )
            .join('\r\n')
          controller.enqueue(encoder.encode(`${chunk}\r\n`))
          cursor = rows.at(-1)!.id
        }
        controller.close()
      } catch (error) {
        controller.error(error)
      }
    },
  })
  const safeName = prospectImport.fileName.replaceAll(/[^A-Za-z0-9._-]/gu, '_').slice(0, 100)
  return new Response(body, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${safeName}.dry-run.csv"`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
      'x-torchiko-report-sha256': prospectImport.reportHash,
    },
  })
}
