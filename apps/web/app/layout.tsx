import type { Metadata } from 'next'
import type { ReactNode } from 'react'

import './globals.css'

type RootLayoutProps = {
  children: ReactNode
}

export const metadata: Metadata = {
  title: 'PathFinder',
  description: 'Public venue wayfinding and visitor chat.',
}

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="en">
      <head>
        <meta name="theme-color" content="#0f172a" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <link rel="manifest" href="/manifest.webmanifest" />
      </head>
      <body>
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
