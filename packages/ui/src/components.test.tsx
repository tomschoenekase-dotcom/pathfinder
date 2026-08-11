import { describe, expect, it } from 'vitest'

import { Button } from './Button'
import { EmptyState } from './EmptyState'
import { Input } from './Field'
import { StatusBadge } from './StatusBadge'
import { Panel, Surface } from './Surface'

describe('shared UI primitives', () => {
  it('keeps buttons safe by default and includes visible keyboard focus and reduced-motion styles', () => {
    const button = Button({ children: 'Save' })

    expect(button.props.type).toBe('button')
    expect(button.props.className).toContain('focus-visible:ring-2')
    expect(button.props.className).toContain('motion-reduce:transition-none')
  })

  it('marks invalid inputs without discarding caller classes', () => {
    const input = Input({ 'aria-invalid': true, className: 'tracking-wide' })

    expect(input.props['aria-invalid']).toBe(true)
    expect(input.props.className).toContain('aria-[invalid=true]:border-red-600')
    expect(input.props.className).toContain('tracking-wide')
  })

  it('uses text as the status signal and keeps the decorative dot hidden', () => {
    const badge = StatusBadge({ children: 'Needs attention', tone: 'warning' })
    const children = badge.props.children as Array<{ props?: Record<string, unknown> } | string>
    const dot = children[0] as { props?: Record<string, unknown> }

    expect(badge.props.className).toContain('text-amber-900')
    expect(dot.props?.['aria-hidden']).toBe('true')
    expect(children[1]).toBe('Needs attention')
  })

  it('provides deliberately distinct primary and secondary surfaces', () => {
    const surface = Surface({ children: 'Primary' })
    const panel = Panel({ children: 'Secondary' })

    expect(surface.type).toBe('section')
    expect(surface.props.className).toContain('bg-white')
    expect(panel.type).toBe('div')
    expect(panel.props.className).toContain('bg-slate-50/70')
  })

  it('renders an empty state with a semantic heading and optional action slot', () => {
    const state = EmptyState({ title: 'No requests', action: 'Create request' })
    const children = state.props.children as Array<unknown>

    expect(state.props.className).toContain('text-center')
    expect(children).toHaveLength(4)
  })
})
