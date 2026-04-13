import type { ReactNode } from 'react'
import { ClerkProvider } from '@clerk/nextjs'

import './globals.css'

type RootLayoutProps = {
  children: ReactNode
}

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body>{children}</body>
      </html>
    </ClerkProvider>
  )
}
