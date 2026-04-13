import type { Metadata } from 'next'
import type { ReactNode } from 'react'

import './globals.css'

type RootLayoutProps = {
  children: ReactNode
}

export const metadata: Metadata = {
  title: 'PathFinder',
  description: 'Public venue wayfinding and visitor chat.',
  manifest: '/manifest.json',
}

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
