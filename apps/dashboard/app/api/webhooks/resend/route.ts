/**
 * Prospect Resend ingestion was retired by ADR-CRM-CANONICALIZATION-2026-08-20.
 * Transactional/opted-in Resend integrations must use a separate product-owned endpoint.
 */
export async function POST(): Promise<Response> {
  return Response.json(
    {
      error: 'gone',
      detail: 'Resend is not a prospect correspondence provider',
    },
    { status: 410 },
  )
}
