'use client'

import { Component, type ReactNode } from 'react'

type State = { failed: boolean }

/**
 * Client Tochi is optional enhancement. A presentation/runtime failure must
 * never take down the portal actions it sits alongside.
 */
export class ClientTochiBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  render() {
    return this.state.failed ? null : this.props.children
  }
}
