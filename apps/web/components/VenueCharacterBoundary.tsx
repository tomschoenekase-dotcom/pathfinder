'use client'

import { Component, type ReactNode } from 'react'

import { VenueCharacterFallback } from './VenueCharacterFallback'

type VenueCharacterBoundaryProps = {
  children: ReactNode
  resetKey: string
  compact?: boolean
}

type VenueCharacterBoundaryState = { failed: boolean }

export class VenueCharacterBoundary extends Component<
  VenueCharacterBoundaryProps,
  VenueCharacterBoundaryState
> {
  state: VenueCharacterBoundaryState = { failed: false }

  static getDerivedStateFromError(): VenueCharacterBoundaryState {
    return { failed: true }
  }

  componentDidCatch() {
    // The visual layer is optional. Product telemetry can be added without
    // allowing a renderer failure to interrupt the durable text chat.
  }

  componentDidUpdate(previous: VenueCharacterBoundaryProps) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false })
    }
  }

  render() {
    if (this.state.failed)
      return (
        <VenueCharacterFallback
          {...(this.props.compact === undefined ? {} : { compact: this.props.compact })}
        />
      )
    return this.props.children
  }
}
