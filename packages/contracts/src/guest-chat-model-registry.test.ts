import { describe, expect, it } from 'vitest'
import {
  GUEST_CHAT_ROUTE_DEFINITIONS,
  GUEST_CHAT_MODEL_KEYS,
  GUEST_CHAT_MODEL_SPECS,
  GUEST_CHAT_PUBLIC_ROUTE_KEYS,
  GUEST_CHAT_ENVIRONMENT_DEFAULT_KEYS,
  GUEST_CHAT_RUNTIME_DEFAULT_KEYS,
  GUEST_CHAT_DEFAULT_FALLBACKS,
  OPERATOR_GUEST_MODEL_KEYS,
  OPERATOR_GUEST_MODEL_INPUT_KEYS,
  OPERATOR_GUEST_MODEL_SELECTIONS,
} from './guest-chat-model-registry'

describe('pure guest route registry projections', () => {
  it('projects every definition into execution, routing and default policy without another allowlist', () => {
    const definitions = Object.values(GUEST_CHAT_ROUTE_DEFINITIONS)
    expect(Object.values(GUEST_CHAT_MODEL_KEYS)).toEqual(
      definitions.map((definition) => definition.key),
    )
    expect(Object.keys(GUEST_CHAT_MODEL_SPECS)).toEqual(
      definitions.map((definition) => definition.key),
    )
    expect(new Set(GUEST_CHAT_PUBLIC_ROUTE_KEYS)).toEqual(
      new Set(definitions.map((definition) => definition.key)),
    )
    expect(new Set(GUEST_CHAT_ENVIRONMENT_DEFAULT_KEYS)).toEqual(
      new Set(
        definitions
          .filter((definition) => definition.environmentDefaultAllowed)
          .map((definition) => definition.key),
      ),
    )
    expect(new Set(GUEST_CHAT_RUNTIME_DEFAULT_KEYS)).toEqual(
      new Set(
        definitions
          .filter((definition) => definition.runtimeDefaultAllowed)
          .map((definition) => definition.key),
      ),
    )
    for (const definition of definitions) {
      expect(GUEST_CHAT_MODEL_SPECS[definition.key]).toEqual(definition.spec)
      expect(GUEST_CHAT_DEFAULT_FALLBACKS[definition.key]).toEqual({
        enabled: false,
        modelKeys: [],
      })
      expect(GUEST_CHAT_MODEL_SPECS[definition.key]).not.toHaveProperty('selection')
      expect(GUEST_CHAT_MODEL_SPECS[definition.key]).not.toHaveProperty('defaultFallback')
    }
  })

  it('retains hidden legacy routes and the existing environment/runtime distinction', () => {
    expect(GUEST_CHAT_PUBLIC_ROUTE_KEYS).toEqual([
      'guest-chat',
      'guest-chat-openai',
      'guest-chat-luna',
      'guest-chat-luna-reasoning',
      'guest-chat-sol',
      'guest-chat-sol-fast',
      'guest-chat-terra-fast',
      'guest-chat-deepseek-flash',
      'guest-chat-deepseek-pro',
    ])
    expect(OPERATOR_GUEST_MODEL_KEYS).toEqual([
      'guest-chat-sol-fast',
      'guest-chat-terra-fast',
      'guest-chat-sol',
      'guest-chat-luna',
      'guest-chat-luna-reasoning',
      'guest-chat',
    ])
    expect(GUEST_CHAT_ENVIRONMENT_DEFAULT_KEYS).toContain('guest-chat')
    expect(GUEST_CHAT_RUNTIME_DEFAULT_KEYS).not.toContain('guest-chat')
    for (const hidden of [
      'guest-chat-openai',
      'guest-chat-deepseek-flash',
      'guest-chat-deepseek-pro',
    ]) {
      expect(OPERATOR_GUEST_MODEL_KEYS).not.toContain(hidden)
      expect(GUEST_CHAT_ENVIRONMENT_DEFAULT_KEYS).not.toContain(hidden)
      expect(GUEST_CHAT_RUNTIME_DEFAULT_KEYS).not.toContain(hidden)
    }
  })

  it('derives accepted aliases and labels from each selected definition', () => {
    for (const choice of Object.values(OPERATOR_GUEST_MODEL_SELECTIONS)) {
      for (const alias of choice.inputAliases)
        expect(OPERATOR_GUEST_MODEL_INPUT_KEYS).toContain(alias)
      expect(choice.title).not.toBe('')
      expect(choice.description.length).toBeGreaterThan(20)
    }
    expect(OPERATOR_GUEST_MODEL_SELECTIONS['guest-chat-sol-fast'].inputAliases).toEqual([
      'sol',
      'Sol',
    ])
  })
})
