export const dynamic = 'force-dynamic'

import type { ReactNode } from 'react'
import { Plus_Jakarta_Sans } from 'next/font/google'
import { ClerkProvider } from '@clerk/nextjs'

import './globals.css'

const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  variable: '--font-jakarta',
  display: 'swap',
})

type RootLayoutProps = {
  children: ReactNode
}

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <ClerkProvider>
      <html lang="en" className={jakarta.variable}>
        <body className="font-jakarta antialiased">{children}</body>
      </html>
    </ClerkProvider>
  )
}
