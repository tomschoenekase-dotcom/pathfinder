import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { Plus_Jakarta_Sans } from 'next/font/google'

import './globals.css'

const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  variable: '--font-jakarta',
  display: 'swap',
})

type RootLayoutProps = {
  children: ReactNode
}

export const metadata: Metadata = {
  metadataBase: new URL('https://sweet-luck-production-0037.up.railway.app'),
  title: 'PathFinder — The AI guide built for your venue',
  description:
    'Guests ask questions. PathFinder answers with real directions, hours, and recommendations specific to your venue. Set up in an afternoon. No app download required.',
  openGraph: {
    title: 'PathFinder — The AI guide built for your venue',
    description:
      'Guests ask questions. PathFinder answers with real directions, hours, and recommendations specific to your venue. Set up in an afternoon. No app download required.',
    url: 'https://sweet-luck-production-0037.up.railway.app',
    siteName: 'PathFinder',
    type: 'website',
    images: [
      {
        url: '/og-image.png',
        width: 1200,
        height: 630,
        alt: 'PathFinder — The AI guide built for your venue',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'PathFinder — The AI guide built for your venue',
    description:
      'Guests ask questions. PathFinder answers with real directions, hours, and recommendations specific to your venue. Set up in an afternoon. No app download required.',
    images: ['/og-image.png'],
  },
}

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="en" className={jakarta.variable}>
      <head>
        <meta name="theme-color" content="#1F4E8C" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <link rel="manifest" href="/manifest.webmanifest" />
      </head>
      <body className="font-jakarta antialiased">
        {children}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "if ('serviceWorker' in navigator) { window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () {}); }); }",
          }}
        />
      </body>
    </html>
  )
}
