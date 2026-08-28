'use client'

import { type RefObject, useEffect, useRef } from 'react'

export function useRouteChangeFocus(pathname: string, contentRef: RefObject<HTMLElement | null>) {
  const previousPathname = useRef(pathname)

  useEffect(() => {
    if (previousPathname.current === pathname) return
    previousPathname.current = pathname

    const content = contentRef.current
    if (!content) return
    const activeElement = document.activeElement
    if (activeElement instanceof HTMLElement && content.contains(activeElement)) return

    const heading = content.querySelector<HTMLElement>('h1')
    const target = heading ?? content
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1')
    target.focus()
  }, [contentRef, pathname])
}
