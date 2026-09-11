'use client'

import ClientPortalError from '../../(app)/error'

export function NeutralBrandErrorFixture() {
  return <ClientPortalError reset={() => undefined} />
}
