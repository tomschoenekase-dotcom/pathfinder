import { createGmailOAuthRuntime } from '@pathfinder/api/correspondence'

export function gmailOAuthRuntime() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
  const redirectUri = process.env.GMAIL_OAUTH_REDIRECT_URI
  const integrationEncryptionKey = process.env.INTEGRATION_ENCRYPTION_KEY
  if (!clientId || !clientSecret || !redirectUri || !integrationEncryptionKey) return null
  return createGmailOAuthRuntime({
    configuration: { clientId, clientSecret, redirectUri, integrationEncryptionKey },
  })
}
