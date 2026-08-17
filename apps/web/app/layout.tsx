import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { ClerkProvider } from '@clerk/nextjs'
import {
  DM_Sans,
  Inter,
  Playfair_Display,
  Plus_Jakarta_Sans,
  Poppins,
  Space_Grotesk,
} from 'next/font/google'

import { ServiceWorkerRegistration } from '../components/ServiceWorkerRegistration'

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

const publicWebUrl = new URL(process.env.NEXT_PUBLIC_WEB_URL ?? 'https://torchiko.com')

export const metadata: Metadata = {
  metadataBase: publicWebUrl,
  title: 'Torchiko — The AI guide built for your venue',
  description:
    'Guests ask questions. Torchiko answers with real directions, hours, and recommendations specific to your venue. Set up in an afternoon. No app download required.',
  openGraph: {
    title: 'Torchiko — The AI guide built for your venue',
    description:
      'Guests ask questions. Torchiko answers with real directions, hours, and recommendations specific to your venue. Set up in an afternoon. No app download required.',
    url: publicWebUrl,
    siteName: 'Torchiko',
    type: 'website',
    images: [
      {
        url: '/og-image.png',
        width: 1200,
        height: 630,
        alt: 'Torchiko — The AI guide built for your venue',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Torchiko — The AI guide built for your venue',
    description:
      'Guests ask questions. Torchiko answers with real directions, hours, and recommendations specific to your venue. Set up in an afternoon. No app download required.',
    images: ['/og-image.png'],
  },
}

export default function RootLayout({ children }: RootLayoutProps) {
  const document = (
    <html lang="en" className={chatFontVariables}>
      <head>
        <meta name="theme-color" content="#1F4E8C" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
      </head>
      <body className="font-jakarta antialiased">
        {children}
        <ServiceWorkerRegistration enabled={process.env.NEXT_PUBLIC_PWA_ENABLED !== 'false'} />
      </body>
    </html>
  )

  const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
  return publishableKey ? (
    <ClerkProvider publishableKey={publishableKey} afterSignOutUrl="/">
      {document}
    </ClerkProvider>
  ) : (
    document
  )
}
