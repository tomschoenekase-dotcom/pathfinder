'use client'

import { useEffect, useRef, useState } from 'react'

/** Current Torchiko source-brand lockup, kept local to the dashboard app. */
export function TorchikoWordmark({
  inverse = false,
  className = '',
  height = 32,
}: {
  inverse?: boolean
  className?: string
  height?: number
}) {
  const imageRef = useRef<HTMLImageElement>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (imageRef.current?.complete && !imageRef.current.naturalWidth) setFailed(true)
  }, [])

  return (
    <span className={`inline-flex max-w-full items-center ${className}`}>
      {failed ? (
        <span
          className={
            inverse
              ? 'font-semibold tracking-tight text-white'
              : 'font-semibold tracking-tight text-tk-ink'
          }
        >
          Torchiko
        </span>
      ) : (
        <img
          ref={imageRef}
          src={`/brand/torchiko-wordmark-${inverse ? 'inverse' : 'light'}-480w.png`}
          alt="Torchiko"
          width={480}
          height={134}
          style={{ height, width: 'auto' }}
          onError={() => setFailed(true)}
        />
      )}
    </span>
  )
}
