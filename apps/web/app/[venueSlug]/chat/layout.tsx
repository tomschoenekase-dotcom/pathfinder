import type { ReactNode } from 'react'
import type { Viewport } from 'next'

type VenueChatLayoutProps = {
  children: ReactNode
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#0f172a',
}

export default function VenueChatLayout({ children }: VenueChatLayoutProps) {
  return children
}
