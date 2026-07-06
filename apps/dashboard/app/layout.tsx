export const dynamic = 'force-dynamic'

import type { ReactNode } from 'react'
import {
  DM_Sans,
  Inter,
  Playfair_Display,
  Plus_Jakarta_Sans,
  Poppins,
  Space_Grotesk,
} from 'next/font/google'
import { ClerkProvider } from '@clerk/nextjs'

import './globals.css'

const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  variable: '--font-jakarta',
  display: 'swap',
})

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
})

const poppins = Poppins({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-poppins',
  display: 'swap',
})

const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  variable: '--font-space-grotesk',
  display: 'swap',
})

const dmSans = DM_Sans({
  subsets: ['latin'],
  variable: '--font-dm-sans',
  display: 'swap',
})

const playfair = Playfair_Display({
  subsets: ['latin'],
  variable: '--font-playfair',
  display: 'swap',
})

const chatFontVariables = [
  jakarta.variable,
  inter.variable,
  poppins.variable,
  spaceGrotesk.variable,
  dmSans.variable,
  playfair.variable,
].join(' ')

type RootLayoutProps = {
  children: ReactNode
}

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <ClerkProvider afterSignOutUrl={process.env.NEXT_PUBLIC_AFTER_SIGN_OUT_URL ?? '/sign-in'}>
      <html lang="en" className={chatFontVariables}>
        <body className="font-jakarta antialiased">{children}</body>
      </html>
    </ClerkProvider>
  )
}
