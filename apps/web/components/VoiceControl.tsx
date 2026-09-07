'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Mic, MicOff, Volume2 } from 'lucide-react'
import type { SupportedChatLanguage } from '@pathfinder/api/schemas'
import type { CharacterState } from '@pathfinder/contracts/character-system'

import { useTRPCClient } from '../lib/trpc'
import { runBoundedClientRequest } from '../lib/bounded-client-request'
import { getChatLanguagePresentation } from './LanguagePicker'

type VoiceState =
  | 'idle'
  | 'requesting'
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'error'
export type VoiceTranscriptLine = {
  speaker: 'VISITOR' | 'ASSISTANT'
  text: string
  delivery?: 'PLAYED' | 'INTERRUPTED'
}
type LiveAssistantCaption = {
  responseId: string
  text: string
  interrupted: boolean
}

export const MICROPHONE_REQUEST_TIMEOUT_MS = 15_000
export const REALTIME_SDP_REQUEST_TIMEOUT_MS = 30_000
export const REALTIME_SDP_RESPONSE_MAX_BYTES = 1024 * 1024
export const VOICE_AVAILABILITY_TIMEOUT_MS = 15_000
const RECENT_CAPTION_DELTA_EVENT_LIMIT = 2_048
const VOICE_TRANSCRIPT_TEXT_LIMIT = 8_000

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Cancellation is best-effort after the response has already failed closed.
  }
}

export async function requestRealtimeSdpAnswer({
  offerSdp,
  clientSecret,
  controller,
  timeoutMs = REALTIME_SDP_REQUEST_TIMEOUT_MS,
  fetchImpl = fetch,
}: {
  offerSdp: string
  clientSecret: string
  controller: AbortController
  timeoutMs?: number
  fetchImpl?: typeof fetch
}): Promise<string> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let completed = false
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetchImpl('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      body: offerSdp,
      headers: {
        Authorization: `Bearer ${clientSecret}`,
        'Content-Type': 'application/sdp',
      },
      signal: controller.signal,
    })
    if (!response.ok) {
      await cancelResponseBody(response)
      throw new Error(`REALTIME_CONNECT_${response.status}`)
    }

    const declaredLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > REALTIME_SDP_RESPONSE_MAX_BYTES) {
      await cancelResponseBody(response)
      throw new Error('REALTIME_SDP_RESPONSE_TOO_LARGE')
    }
    if (!response.body) throw new Error('REALTIME_SDP_RESPONSE_UNAVAILABLE')

    reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let receivedBytes = 0
    const cancelReader = () => void reader?.cancel().catch(() => undefined)
    controller.signal.addEventListener('abort', cancelReader, { once: true })
    try {
      for (;;) {
        const result = await reader.read()
        if (controller.signal.aborted) throw new Error('REALTIME_SDP_REQUEST_TIMEOUT')
        if (result.done) break
        receivedBytes += result.value.byteLength
        if (receivedBytes > REALTIME_SDP_RESPONSE_MAX_BYTES) {
          await reader.cancel()
          throw new Error('REALTIME_SDP_RESPONSE_TOO_LARGE')
        }
        chunks.push(result.value)
      }
    } finally {
      controller.signal.removeEventListener('abort', cancelReader)
    }

    const encodedAnswer = new Uint8Array(receivedBytes)
    let offset = 0
    for (const chunk of chunks) {
      encodedAnswer.set(chunk, offset)
      offset += chunk.byteLength
    }
    const answer = new TextDecoder().decode(encodedAnswer)
    if (!answer.trim()) throw new Error('REALTIME_SDP_RESPONSE_INVALID')
    completed = true
    return answer
  } catch (cause) {
    if (controller.signal.aborted) throw new Error('REALTIME_SDP_REQUEST_TIMEOUT')
    throw cause
  } finally {
    window.clearTimeout(timeoutId)
    if (!completed && reader) await reader.cancel().catch(() => undefined)
  }
}

function characterStateForVoice(state: VoiceState): CharacterState {
  if (state === 'requesting' || state === 'connecting') return 'attention'
  if (state === 'listening' || state === 'thinking' || state === 'speaking' || state === 'error')
    return state
  return 'idle'
}

function readableError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return 'Microphone access was denied. You can continue in text or change browser permission and try again.'
  }
  if (error instanceof Error && error.message === 'VOICE_UNSUPPORTED') {
    return 'Voice is not supported in this browser. You can continue in text.'
  }
  if (error instanceof Error && error.message === 'MICROPHONE_REQUEST_TIMEOUT') {
    return 'The microphone request took too long. Continue in text, check your browser permission, or try voice again.'
  }
  return 'Voice could not connect. You can continue in text or try again.'
}

async function requestMicrophoneStream(): Promise<MediaStream> {
  const request = navigator.mediaDevices.getUserMedia({ audio: true })
  let timedOut = false
  let timeoutId: number | null = null
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = window.setTimeout(() => {
      timedOut = true
      reject(new Error('MICROPHONE_REQUEST_TIMEOUT'))
    }, MICROPHONE_REQUEST_TIMEOUT_MS)
  })

  try {
    return await Promise.race([request, timeout])
  } finally {
    if (timeoutId !== null) window.clearTimeout(timeoutId)
    if (timedOut) {
      void request
        .then((lateStream) => lateStream.getTracks().forEach((track) => track.stop()))
        .catch(() => undefined)
    }
  }
}

function voiceStateLabel(state: VoiceState): string {
  if (state === 'idle') return 'Voice conversation'
  if (state === 'error') return 'Voice unavailable'
  return `${state.charAt(0).toUpperCase()}${state.slice(1)}…`
}

export function VoiceControl({
  venueId,
  anonymousToken,
  language,
  disabled,
  onCharacterState,
}: {
  venueId: string
  anonymousToken: string | null
  language: SupportedChatLanguage
  disabled: boolean
  onCharacterState?: (state: CharacterState) => void
}) {
  const client = useTRPCClient()
  const [available, setAvailable] = useState(false)
  const [availabilityScopeKey, setAvailabilityScopeKey] = useState<string | null>(null)
  const [premiumAvailable, setPremiumAvailable] = useState(false)
  const [state, setState] = useState<VoiceState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [transcript, setTranscript] = useState<VoiceTranscriptLine[]>([])
  const [liveAssistantCaption, setLiveAssistantCaption] = useState<LiveAssistantCaption | null>(
    null,
  )
  const peerRef = useRef<RTCPeerConnection | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const channelRef = useRef<RTCDataChannel | null>(null)
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const lifecycleGenerationRef = useRef(0)
  const startingAttemptRef = useRef<number | null>(null)
  const endingGenerationRef = useRef<number | null>(null)
  const endedSessionIdsRef = useRef(new Set<string>())
  const sequenceRef = useRef(0)
  const stopTimerRef = useRef<number | null>(null)
  const realtimeRequestRef = useRef<AbortController | null>(null)
  const activeResponseIdRef = useRef<string | null>(null)
  const pendingAssistantTranscriptRef = useRef<
    Map<string, { text: string; providerEventId: string }>
  >(new Map())
  const interruptedResponseIdsRef = useRef(new Set<string>())
  const playedResponseIdsRef = useRef(new Set<string>())
  const generatingResponseIdsRef = useRef(new Set<string>())
  const finalizedResponseIdsRef = useRef(new Set<string>())
  const handledCaptionDeltaEventIdsRef = useRef(new Set<string>())
  const pendingGroundingCallsRef = useRef(new Set<string>())
  const completedGroundingCallsRef = useRef(new Set<string>())
  const groundingTurnRef = useRef(0)
  const groundingContinuedResponsesRef = useRef(new Set<string>())
  const handledGroundingResponsesRef = useRef(new Set<string>())
  const onCharacterStateRef = useRef(onCharacterState)
  onCharacterStateRef.current = onCharacterState
  const scopeKey = JSON.stringify([venueId, anonymousToken])
  const scopeKeyRef = useRef(scopeKey)
  if (scopeKeyRef.current !== scopeKey) {
    scopeKeyRef.current = scopeKey
    lifecycleGenerationRef.current += 1
    startingAttemptRef.current = null
    endingGenerationRef.current = null
  }

  const setVoiceState = useCallback((next: VoiceState) => {
    setState(next)
    onCharacterStateRef.current?.(characterStateForVoice(next))
  }, [])

  const releaseBrowserMedia = useCallback(() => {
    if (stopTimerRef.current !== null) window.clearTimeout(stopTimerRef.current)
    stopTimerRef.current = null
    realtimeRequestRef.current?.abort()
    realtimeRequestRef.current = null
    channelRef.current?.close()
    peerRef.current?.close()
    remoteAudioRef.current?.pause()
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    channelRef.current = null
    peerRef.current = null
    streamRef.current = null
    remoteAudioRef.current = null
    activeResponseIdRef.current = null
    pendingAssistantTranscriptRef.current.clear()
    interruptedResponseIdsRef.current.clear()
    playedResponseIdsRef.current.clear()
    generatingResponseIdsRef.current.clear()
    finalizedResponseIdsRef.current.clear()
    handledCaptionDeltaEventIdsRef.current.clear()
    pendingGroundingCallsRef.current.clear()
    completedGroundingCallsRef.current.clear()
    groundingTurnRef.current += 1
    groundingContinuedResponsesRef.current.clear()
    handledGroundingResponsesRef.current.clear()
  }, [])

  const closeRemoteSession = useCallback(
    async (input: {
      venueId: string
      anonymousToken: string
      voiceSessionId: string
      fallbackToText: boolean
      errorCode?: string
    }) => {
      if (endedSessionIdsRef.current.has(input.voiceSessionId)) return
      endedSessionIdsRef.current.add(input.voiceSessionId)
      try {
        await client.voice.end.mutate(input)
      } catch {
        // Browser media is closed independently; server expiry remains the safe fallback.
      }
    },
    [client.voice.end],
  )

  const endSession = useCallback(
    (options: { fallbackToText?: boolean; errorCode?: string } = {}) => {
      if (endingGenerationRef.current !== null) return
      const endingGeneration = ++lifecycleGenerationRef.current
      endingGenerationRef.current = endingGeneration
      startingAttemptRef.current = null
      const endingScopeKey = scopeKeyRef.current
      const voiceSessionId = sessionIdRef.current
      sessionIdRef.current = null
      setLiveAssistantCaption(null)
      releaseBrowserMedia()
      if (endingGenerationRef.current === endingGeneration) {
        endingGenerationRef.current = null
      }
      if (
        lifecycleGenerationRef.current === endingGeneration &&
        scopeKeyRef.current === endingScopeKey
      ) {
        setVoiceState(options.errorCode ? 'error' : 'idle')
      }
      if (voiceSessionId && anonymousToken) {
        void closeRemoteSession({
          venueId,
          anonymousToken,
          voiceSessionId,
          fallbackToText: options.fallbackToText ?? false,
          ...(options.errorCode ? { errorCode: options.errorCode } : {}),
        })
      }
    },
    [anonymousToken, closeRemoteSession, releaseBrowserMedia, setVoiceState, venueId],
  )

  useEffect(() => {
    if (!anonymousToken) {
      setAvailable(false)
      setAvailabilityScopeKey(scopeKey)
      return
    }
    const controller = new AbortController()
    void runBoundedClientRequest({
      parentSignal: controller.signal,
      timeoutMs: VOICE_AVAILABILITY_TIMEOUT_MS,
      request: (signal) => client.voice.availability.query({ venueId, anonymousToken }, { signal }),
    })
      .then((result) => {
        if (controller.signal.aborted) return
        setVoiceState('idle')
        setError(null)
        setTranscript([])
        setLiveAssistantCaption(null)
        sequenceRef.current = 0
        setAvailable(result.enabled)
        setPremiumAvailable(result.enabled && result.premiumAvailable)
        setAvailabilityScopeKey(scopeKey)
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setVoiceState('idle')
          setError(null)
          setTranscript([])
          setLiveAssistantCaption(null)
          sequenceRef.current = 0
          setAvailable(false)
          setPremiumAvailable(false)
          setAvailabilityScopeKey(scopeKey)
        }
      })
    return () => {
      controller.abort()
    }
  }, [anonymousToken, client.voice.availability, scopeKey, setVoiceState, venueId])

  useEffect(
    () => () => {
      lifecycleGenerationRef.current += 1
      startingAttemptRef.current = null
      endingGenerationRef.current = null
      const voiceSessionId = sessionIdRef.current
      sessionIdRef.current = null
      releaseBrowserMedia()
      if (voiceSessionId && anonymousToken) {
        void closeRemoteSession({
          venueId,
          anonymousToken,
          voiceSessionId,
          fallbackToText: true,
          errorCode: 'CLIENT_UNMOUNTED',
        })
      }
    },
    [anonymousToken, closeRemoteSession, releaseBrowserMedia, venueId],
  )

  const saveTranscript = useCallback(
    (
      speaker: 'VISITOR' | 'ASSISTANT',
      text: string,
      providerEventId: string,
      delivery?: 'PLAYED' | 'INTERRUPTED',
    ) => {
      const clean = text.trim()
      const voiceSessionId = sessionIdRef.current
      if (!clean || !voiceSessionId || !anonymousToken) return
      const sequence = sequenceRef.current++
      setTranscript((lines) =>
        [...lines, { speaker, text: clean, ...(delivery ? { delivery } : {}) }].slice(-12),
      )
      void client.voice.transcript
        .mutate({
          venueId,
          anonymousToken,
          voiceSessionId,
          providerEventId,
          sequence,
          speaker,
          text:
            delivery === 'INTERRUPTED'
              ? `[Interrupted] ${clean.slice(0, VOICE_TRANSCRIPT_TEXT_LIMIT - 14)}`
              : clean.slice(0, VOICE_TRANSCRIPT_TEXT_LIMIT),
          language: getChatLanguagePresentation(language).code,
        })
        .catch(() => undefined)
    },
    [anonymousToken, client.voice.transcript, language, venueId],
  )

  const finishAssistantTranscript = useCallback(
    (responseId: string, delivery: 'PLAYED' | 'INTERRUPTED') => {
      const pending = pendingAssistantTranscriptRef.current.get(responseId)
      if (!pending) return
      pendingAssistantTranscriptRef.current.delete(responseId)
      interruptedResponseIdsRef.current.delete(responseId)
      playedResponseIdsRef.current.delete(responseId)
      finalizedResponseIdsRef.current.add(responseId)
      setLiveAssistantCaption((caption) => (caption?.responseId === responseId ? null : caption))
      saveTranscript('ASSISTANT', pending.text, pending.providerEventId, delivery)
      if (activeResponseIdRef.current === responseId) activeResponseIdRef.current = null
    },
    [saveTranscript],
  )

  const saveUsage = useCallback(
    (event: Record<string, unknown>, providerEventId: string) => {
      const voiceSessionId = sessionIdRef.current
      if (!voiceSessionId || !anonymousToken) return
      const response =
        event.response && typeof event.response === 'object'
          ? (event.response as Record<string, unknown>)
          : null
      const usage =
        response?.usage && typeof response.usage === 'object'
          ? (response.usage as Record<string, unknown>)
          : null
      if (!usage) return
      const inputDetails =
        usage.input_token_details && typeof usage.input_token_details === 'object'
          ? (usage.input_token_details as Record<string, unknown>)
          : {}
      const outputDetails =
        usage.output_token_details && typeof usage.output_token_details === 'object'
          ? (usage.output_token_details as Record<string, unknown>)
          : {}
      const cachedDetails =
        inputDetails.cached_tokens_details && typeof inputDetails.cached_tokens_details === 'object'
          ? (inputDetails.cached_tokens_details as Record<string, unknown>)
          : {}
      const integer = (value: unknown) =>
        typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
      void client.voice.usage
        .mutate({
          venueId,
          anonymousToken,
          voiceSessionId,
          providerEventId,
          inputTokens: integer(usage.input_tokens),
          outputTokens: integer(usage.output_tokens),
          cachedInputTokens: integer(inputDetails.cached_tokens),
          cachedAudioInputTokens: integer(cachedDetails.audio_tokens),
          audioInputTokens: integer(inputDetails.audio_tokens),
          audioOutputTokens: integer(outputDetails.audio_tokens),
        })
        .catch(() => undefined)
    },
    [anonymousToken, client.voice.usage, venueId],
  )

  const handleProviderEvent = useCallback(
    (raw: MessageEvent<string>) => {
      try {
        const event = JSON.parse(raw.data) as Record<string, unknown>
        const type = typeof event.type === 'string' ? event.type : ''
        const eventId = typeof event.event_id === 'string' ? event.event_id : crypto.randomUUID()
        if (type === 'input_audio_buffer.speech_started') {
          groundingTurnRef.current += 1
          pendingGroundingCallsRef.current.clear()
          const responseId = activeResponseIdRef.current
          if (responseId && channelRef.current) {
            interruptedResponseIdsRef.current.add(responseId)
            if (generatingResponseIdsRef.current.has(responseId)) {
              channelRef.current.send(
                JSON.stringify({ type: 'response.cancel', response_id: responseId }),
              )
            }
            channelRef.current.send(JSON.stringify({ type: 'output_audio_buffer.clear' }))
          }
          setVoiceState('listening')
        } else if (type === 'response.created') {
          const response = event.response as { id?: unknown } | undefined
          if (typeof response?.id === 'string') {
            activeResponseIdRef.current = response.id
            generatingResponseIdsRef.current.add(response.id)
          }
          setVoiceState('thinking')
        } else if (type === 'input_audio_buffer.speech_stopped') {
          setVoiceState('thinking')
        } else if (
          type === 'response.output_audio_transcript.delta' ||
          type === 'response.audio_transcript.delta'
        ) {
          const responseId =
            typeof event.response_id === 'string' ? event.response_id : activeResponseIdRef.current
          const delta = typeof event.delta === 'string' ? event.delta : ''
          if (
            responseId &&
            responseId === activeResponseIdRef.current &&
            delta &&
            !finalizedResponseIdsRef.current.has(responseId) &&
            !handledCaptionDeltaEventIdsRef.current.has(eventId)
          ) {
            if (handledCaptionDeltaEventIdsRef.current.size >= RECENT_CAPTION_DELTA_EVENT_LIMIT) {
              const oldestEventId = handledCaptionDeltaEventIdsRef.current.values().next().value
              if (typeof oldestEventId === 'string') {
                handledCaptionDeltaEventIdsRef.current.delete(oldestEventId)
              }
            }
            handledCaptionDeltaEventIdsRef.current.add(eventId)
            setLiveAssistantCaption((caption) => ({
              responseId,
              text: `${caption?.responseId === responseId ? caption.text : ''}${delta}`.slice(
                -VOICE_TRANSCRIPT_TEXT_LIMIT,
              ),
              interrupted: interruptedResponseIdsRef.current.has(responseId),
            }))
          }
        } else if (
          type === 'output_audio_buffer.started' ||
          (type.includes('output_audio') && type.endsWith('.delta'))
        ) {
          setVoiceState('speaking')
        } else if (type === 'response.done') {
          const response = event.response as
            | { id?: unknown; status?: unknown; output?: unknown }
            | undefined
          if (typeof response?.id === 'string') {
            generatingResponseIdsRef.current.delete(response.id)
            if (response.status !== 'completed') {
              interruptedResponseIdsRef.current.add(response.id)
              saveUsage(event, eventId)
              return
            }
            if (handledGroundingResponsesRef.current.has(response.id)) {
              saveUsage(event, eventId)
              return
            }
            handledGroundingResponsesRef.current.add(response.id)
            const callCandidates = (Array.isArray(response.output) ? response.output : [])
              .filter(
                (item): item is Record<string, unknown> =>
                  Boolean(item) && typeof item === 'object',
              )
              .filter(
                (item) => item.type === 'function_call' && item.name === 'lookup_venue_knowledge',
              )
              .filter(
                (item) => typeof item.call_id === 'string' && typeof item.arguments === 'string',
              )
            const calls = [
              ...new Map(callCandidates.map((item) => [item.call_id as string, item])).values(),
            ]
            if (calls.length && !interruptedResponseIdsRef.current.has(response.id)) {
              const generation = lifecycleGenerationRef.current
              const groundingTurn = groundingTurnRef.current
              const voiceSessionId = sessionIdRef.current
              if (!voiceSessionId || !anonymousToken) return
              const freshCalls = calls.slice(0, 3).filter((item) => {
                const callId = item.call_id as string
                if (
                  pendingGroundingCallsRef.current.has(callId) ||
                  completedGroundingCallsRef.current.has(callId)
                )
                  return false
                pendingGroundingCallsRef.current.add(callId)
                return true
              })
              const overflowOutputs = calls.slice(3).map((item) => ({
                callId: item.call_id as string,
                output: { grounded: false, context: '', error: 'GROUNDING_CALL_LIMIT_EXCEEDED' },
              }))
              void Promise.all(
                freshCalls.map(async (item) => {
                  const callId = item.call_id as string
                  let query = ''
                  try {
                    const args = JSON.parse(item.arguments as string) as { query?: unknown }
                    query = typeof args.query === 'string' ? args.query : ''
                  } catch {
                    query = ''
                  }
                  try {
                    const result = await client.voice.groundingContext.mutate({
                      venueId,
                      anonymousToken,
                      voiceSessionId,
                      toolCallId: callId,
                      query,
                    })
                    return {
                      callId,
                      output: {
                        grounded: result.context.length > 0,
                        context: result.context,
                        sourceIds: result.sourceIds,
                      },
                    }
                  } catch {
                    return {
                      callId,
                      output: { grounded: false, context: '', error: 'GROUNDING_UNAVAILABLE' },
                    }
                  } finally {
                    pendingGroundingCallsRef.current.delete(callId)
                  }
                }),
              )
                .then((groundedOutputs) => {
                  const outputs = [...groundedOutputs, ...overflowOutputs]
                  if (
                    !outputs.length ||
                    lifecycleGenerationRef.current !== generation ||
                    groundingTurnRef.current !== groundingTurn ||
                    sessionIdRef.current !== voiceSessionId ||
                    channelRef.current?.readyState !== 'open' ||
                    interruptedResponseIdsRef.current.has(response.id as string)
                  )
                    return
                  for (const output of outputs) {
                    channelRef.current.send(
                      JSON.stringify({
                        type: 'conversation.item.create',
                        item: {
                          type: 'function_call_output',
                          call_id: output.callId,
                          output: JSON.stringify(output.output),
                        },
                      }),
                    )
                    completedGroundingCallsRef.current.add(output.callId)
                  }
                  if (!groundingContinuedResponsesRef.current.has(response.id as string)) {
                    groundingContinuedResponsesRef.current.add(response.id as string)
                    channelRef.current.send(JSON.stringify({ type: 'response.create' }))
                  }
                })
                .catch(() => undefined)
            }
          }
          saveUsage(event, eventId)
        } else if (type === 'conversation.item.input_audio_transcription.completed') {
          saveTranscript('VISITOR', String(event.transcript ?? ''), eventId)
        } else if (
          type === 'response.output_audio_transcript.done' ||
          type === 'response.audio_transcript.done'
        ) {
          const responseId =
            typeof event.response_id === 'string' ? event.response_id : activeResponseIdRef.current
          if (responseId) {
            if (finalizedResponseIdsRef.current.has(responseId)) return
            const completedText = String(event.transcript ?? '')
              .trim()
              .slice(-VOICE_TRANSCRIPT_TEXT_LIMIT)
            if (completedText) {
              setLiveAssistantCaption((caption) =>
                responseId === activeResponseIdRef.current || caption?.responseId === responseId
                  ? {
                      responseId,
                      text: completedText,
                      interrupted: interruptedResponseIdsRef.current.has(responseId),
                    }
                  : caption,
              )
            }
            pendingAssistantTranscriptRef.current.set(responseId, {
              text: completedText,
              providerEventId: eventId,
            })
            if (interruptedResponseIdsRef.current.has(responseId)) {
              finishAssistantTranscript(responseId, 'INTERRUPTED')
            } else if (playedResponseIdsRef.current.has(responseId)) {
              playedResponseIdsRef.current.delete(responseId)
              finishAssistantTranscript(responseId, 'PLAYED')
            }
          }
        } else if (
          type === 'output_audio_buffer.stopped' &&
          typeof event.response_id === 'string'
        ) {
          if (finalizedResponseIdsRef.current.has(event.response_id)) return
          if (pendingAssistantTranscriptRef.current.has(event.response_id)) {
            finishAssistantTranscript(event.response_id, 'PLAYED')
          } else {
            playedResponseIdsRef.current.add(event.response_id)
          }
          setVoiceState('listening')
        } else if (
          type === 'output_audio_buffer.cleared' &&
          typeof event.response_id === 'string'
        ) {
          if (finalizedResponseIdsRef.current.has(event.response_id)) return
          const responseId = event.response_id
          interruptedResponseIdsRef.current.add(responseId)
          setLiveAssistantCaption((caption) =>
            caption?.responseId === responseId ? { ...caption, interrupted: true } : caption,
          )
          finishAssistantTranscript(responseId, 'INTERRUPTED')
        } else if (type === 'error') {
          setError('The voice connection reported an error. Continue in text or try again.')
          void endSession({ fallbackToText: true, errorCode: 'PROVIDER_EVENT_ERROR' })
        }
      } catch {
        // Ignore provider events this client version does not understand.
      }
    },
    [
      anonymousToken,
      client.voice.groundingContext,
      endSession,
      finishAssistantTranscript,
      saveTranscript,
      saveUsage,
      setVoiceState,
      venueId,
    ],
  )

  async function startSession() {
    if (
      !anonymousToken ||
      disabled ||
      (state !== 'idle' && state !== 'error') ||
      startingAttemptRef.current !== null
    )
      return
    const attemptGeneration = ++lifecycleGenerationRef.current
    const attemptScopeKey = scopeKeyRef.current
    startingAttemptRef.current = attemptGeneration
    let stream: MediaStream | null = null
    let peer: RTCPeerConnection | null = null
    let voiceSessionId: string | null = null
    const isCurrentAttempt = () =>
      lifecycleGenerationRef.current === attemptGeneration &&
      scopeKeyRef.current === attemptScopeKey
    const closeStaleAttempt = async () => {
      if (voiceSessionId && sessionIdRef.current === voiceSessionId) {
        sessionIdRef.current = null
      }
      if (peer && peerRef.current === peer) {
        releaseBrowserMedia()
      } else {
        peer?.close()
        stream?.getTracks().forEach((track) => track.stop())
      }
      if (voiceSessionId) {
        await closeRemoteSession({
          venueId,
          anonymousToken,
          voiceSessionId,
          fallbackToText: true,
          errorCode: 'CLIENT_UNMOUNTED',
        })
      }
    }
    setError(null)
    setTranscript([])
    setLiveAssistantCaption(null)
    sequenceRef.current = 0
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined') {
        throw new Error('VOICE_UNSUPPORTED')
      }
      setVoiceState('requesting')
      stream = await requestMicrophoneStream()
      if (!isCurrentAttempt()) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      streamRef.current = stream
      setVoiceState('connecting')
      const locale = getChatLanguagePresentation(language).code
      const authorization = await client.voice.start.mutate({
        venueId,
        anonymousToken,
        locale,
        tier: premiumAvailable ? 'PREMIUM' : 'ECONOMY',
      })
      voiceSessionId = authorization.voiceSessionId
      if (!isCurrentAttempt()) {
        await closeStaleAttempt()
        return
      }
      sessionIdRef.current = voiceSessionId

      peer = new RTCPeerConnection()
      peerRef.current = peer
      const activePeer = peer
      const failActiveConnection = (errorCode: string, message: string) => {
        if (!isCurrentAttempt() || peerRef.current !== peer || !sessionIdRef.current) return
        setError(message)
        void endSession({ fallbackToText: true, errorCode })
      }
      peer.onconnectionstatechange = () => {
        if (activePeer.connectionState === 'failed') {
          failActiveConnection(
            'CLIENT_NETWORK_FAILED',
            'The voice network connection was lost. Continue in text or try voice again.',
          )
        }
      }
      peer.oniceconnectionstatechange = () => {
        if (activePeer.iceConnectionState === 'failed') {
          failActiveConnection(
            'CLIENT_NETWORK_FAILED',
            'The voice network connection was lost. Continue in text or try voice again.',
          )
        }
      }
      const audio = document.createElement('audio')
      audio.autoplay = true
      remoteAudioRef.current = audio
      peer.ontrack = (event) => {
        if (
          !isCurrentAttempt() ||
          peerRef.current !== activePeer ||
          remoteAudioRef.current !== audio
        )
          return
        audio.srcObject = event.streams[0] ?? new MediaStream([event.track])
      }
      for (const track of stream.getTracks()) {
        peer.addTrack(track, stream)
        track.addEventListener?.(
          'ended',
          () =>
            failActiveConnection(
              'MICROPHONE_ENDED',
              'The microphone stopped. Continue in text or reconnect voice after checking the device.',
            ),
          { once: true },
        )
      }
      const channel = peer.createDataChannel('oai-events')
      channelRef.current = channel
      channel.addEventListener('message', (event) => {
        if (isCurrentAttempt() && channelRef.current === channel) handleProviderEvent(event)
      })
      channel.addEventListener('open', () => {
        if (isCurrentAttempt() && channelRef.current === channel) {
          channel.send?.(
            JSON.stringify({
              type: 'session.update',
              session: {
                type: 'realtime',
                tool_choice: 'auto',
                tools: [
                  {
                    type: 'function',
                    name: 'lookup_venue_knowledge',
                    description:
                      'Look up current public venue facts for the visitor question. Required before answering venue-specific factual questions.',
                    parameters: {
                      type: 'object',
                      additionalProperties: false,
                      properties: { query: { type: 'string', minLength: 2, maxLength: 500 } },
                      required: ['query'],
                    },
                  },
                ],
              },
            }),
          )
          setVoiceState('listening')
        }
      })
      channel.addEventListener('close', () => {
        if (isCurrentAttempt() && channelRef.current === channel && sessionIdRef.current) {
          void endSession({ fallbackToText: true })
        }
      })

      const offer = await peer.createOffer()
      if (!isCurrentAttempt()) {
        await closeStaleAttempt()
        return
      }
      await peer.setLocalDescription(offer)
      if (!isCurrentAttempt()) {
        await closeStaleAttempt()
        return
      }
      if (!offer.sdp) throw new Error('VOICE_SDP_UNAVAILABLE')
      const realtimeController = new AbortController()
      realtimeRequestRef.current = realtimeController
      const answerSdp = await requestRealtimeSdpAnswer({
        offerSdp: offer.sdp,
        clientSecret: authorization.clientSecret,
        controller: realtimeController,
      })
      if (realtimeRequestRef.current === realtimeController) realtimeRequestRef.current = null
      if (!isCurrentAttempt()) {
        await closeStaleAttempt()
        return
      }
      await peer.setRemoteDescription({ type: 'answer', sdp: answerSdp })
      if (!isCurrentAttempt()) {
        await closeStaleAttempt()
        return
      }
      await client.voice.connected.mutate({
        venueId,
        anonymousToken,
        voiceSessionId: authorization.voiceSessionId,
      })
      if (!isCurrentAttempt()) {
        await closeStaleAttempt()
        return
      }
      stopTimerRef.current = window.setTimeout(() => {
        if (isCurrentAttempt() && sessionIdRef.current === authorization.voiceSessionId) {
          void endSession({ fallbackToText: true })
        }
      }, authorization.maxDurationSeconds * 1_000)
    } catch (cause) {
      if (!isCurrentAttempt()) {
        await closeStaleAttempt()
        return
      }
      setError(readableError(cause))
      await endSession({ fallbackToText: true, errorCode: 'CLIENT_CONNECTION_FAILED' })
    } finally {
      if (startingAttemptRef.current === attemptGeneration) startingAttemptRef.current = null
    }
  }

  if (!available || availabilityScopeKey !== scopeKey) return null

  return (
    <VoiceControlPanel
      state={state}
      disabled={disabled}
      error={error}
      transcript={transcript}
      liveAssistantCaption={liveAssistantCaption}
      onStart={() => void startSession()}
      onEnd={() => void endSession()}
    />
  )
}

export function VoiceControlPanel({
  state,
  disabled,
  error,
  transcript,
  liveAssistantCaption,
  onStart,
  onEnd,
}: {
  state: VoiceState
  disabled: boolean
  error: string | null
  transcript: VoiceTranscriptLine[]
  liveAssistantCaption?: LiveAssistantCaption | null
  onStart: () => void
  onEnd: () => void
}) {
  const active = state !== 'idle' && state !== 'error'
  const canRetry = state === 'error'
  const transcriptViewportRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const viewport = transcriptViewportRef.current
    if (viewport) viewport.scrollTop = viewport.scrollHeight
  }, [liveAssistantCaption?.interrupted, liveAssistantCaption?.text, transcript.length])

  return (
    <div className="mb-3 rounded-2xl border border-[var(--chat-border)] bg-[var(--chat-card)] px-3 py-2">
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={disabled || state === 'requesting' || state === 'connecting'}
          onClick={active ? onEnd : onStart}
          className="inline-flex min-h-11 items-center gap-2 rounded-full bg-[var(--chat-accent)] px-4 text-sm font-semibold text-[var(--chat-accent-contrast)] transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={
            active
              ? 'End voice conversation'
              : canRetry
                ? 'Try voice conversation again'
                : 'Start voice conversation'
          }
          aria-pressed={active}
        >
          {active ? (
            <MicOff className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Mic className="h-4 w-4" aria-hidden="true" />
          )}
          {active ? 'End voice' : canRetry ? 'Try voice again' : 'Talk'}
        </button>
        <div className="min-w-0 flex-1" role="status" aria-live="polite">
          <p className="flex items-center gap-1.5 text-sm font-medium text-[var(--chat-text)]">
            {state === 'speaking' ? <Volume2 className="h-4 w-4" aria-hidden="true" /> : null}
            {voiceStateLabel(state)}
          </p>
          <p className="text-xs text-[var(--chat-text-muted)]">
            {state === 'idle'
              ? 'Your browser asks before microphone access. You can stop or continue in text.'
              : state === 'error'
                ? 'Voice stopped safely. Text chat is still available.'
                : 'You can interrupt naturally or switch back to text.'}
          </p>
        </div>
      </div>
      {error ? (
        <p className="mt-2 text-sm text-rose-700" role="alert">
          {error}
        </p>
      ) : null}
      {transcript.length || liveAssistantCaption ? (
        <div
          ref={transcriptViewportRef}
          className="mt-2 max-h-28 space-y-1 overflow-y-auto rounded-sm border-t border-[var(--chat-border)] pt-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--chat-accent)]"
          aria-label="Voice transcript"
          tabIndex={0}
        >
          {transcript.map((line, index) => (
            <p key={`${line.speaker}-${index}`} dir="auto" className="text-[var(--chat-text)]">
              <span className="font-semibold">{line.speaker === 'VISITOR' ? 'You' : 'Guide'}:</span>{' '}
              {line.text}
              {line.delivery === 'INTERRUPTED' ? (
                <span className="ml-1 text-xs font-medium text-[var(--chat-text-muted)]">
                  (interrupted)
                </span>
              ) : null}
            </p>
          ))}
          {liveAssistantCaption ? (
            <p dir="auto" className="text-[var(--chat-text)]">
              <span className="font-semibold">Guide:</span> {liveAssistantCaption.text}
              <span className="ml-1 text-xs font-medium text-[var(--chat-text-muted)]">
                {liveAssistantCaption.interrupted
                  ? '(interrupted; finalizing)'
                  : '(caption in progress)'}
              </span>
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
