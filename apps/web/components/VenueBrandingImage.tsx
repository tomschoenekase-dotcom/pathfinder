'use client'

import { useEffect, useRef, useState } from 'react'

/** Branding is decorative; a delivery failure must never leave a broken image or block entry. */
export function VenueBrandingImage({ src, className }: { src: string; className: string }) {
  const [failedSource, setFailedSource] = useState<string | null>(null)
  const image = useRef<HTMLImageElement>(null)
  useEffect(() => {
    // The browser can fail an SSR image before React attaches its error handler.
    if (image.current?.complete && image.current.naturalWidth === 0) setFailedSource(src)
  }, [src])
  if (failedSource === src) return null
  return (
    // Controlled derivatives are already resized; keep their revocable delivery path intact.
    // eslint-disable-next-line @next/next/no-img-element
    <img ref={image} src={src} alt="" className={className} onError={() => setFailedSource(src)} />
  )
}
