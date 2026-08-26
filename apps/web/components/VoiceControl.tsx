'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Mic, MicOff, Volume2 } from 'lucide-react'
import type { SupportedChatLanguage } from '@pathfinder/api/schemas'
import type { CharacterState } from '@pathfinder/contracts/character-system'

import { useTRPCClient } from '../lib/trpc'
import { getChatLanguagePresentation } from './LanguagePicker'

type VoiceState =
  | 'idle'
  | 'requesting'
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'error'
export type VoiceTranscriptLine = { speaker: 'VISITOR' | 'ASSISTANT'; text: string }

export const MICROPHONE_REQUEST_TIMEOUT_MS = 15_000

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
  const [premiumAvailable, setPremiumAvailable] = useState(false)
  const [state, setState] = useState<VoiceState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [transcript, setTranscript] = useState<VoiceTranscriptLine[]>([])
  const peerRef = useRef<RTCPeerConnection | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const channelRef = useRef<RTCDataChannel | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const sequenceRef = useRef(0)
  const stopTimerRef = useRef<number | null>(null)
  const endingRef = useRef(false)

  const setVoiceState = useCallback(
    (next: VoiceState) => {
      setState(next)
      onCharacterState?.(characterStateForVoice(next))
    },
    [onCharacterState],
  )

  const releaseBrowserMedia = useCallback(() => {
    if (stopTimerRef.current !== null) window.clearTimeout(stopTimerRef.current)
    stopTimerRef.current = null
    channelRef.current?.close()
    peerRef.current?.close()
    streamRef.current?.getTracks().forEach((track) => track.stop())
    channelRef.current = null
    peerRef.current = null
    streamRef.current = null
  }, [])

  const endSession = useCallback(
    async (options: { fallbackToText?: boolean; errorCode?: string } = {}) => {
      if (endingRef.current) return
      endingRef.current = true
      const voiceSessionId = sessionIdRef.current
      releaseBrowserMedia()
      sessionIdRef.current = null
      if (voiceSessionId && anonymousToken) {
        try {
          await client.voice.end.mutate({
            venueId,
            anonymousToken,
            voiceSessionId,
            fallbackToText: options.fallbackToText ?? false,
            ...(options.errorCode ? { errorCode: options.errorCode } : {}),
          })
        } catch {
          // The browser media is already closed; server expiry remains the safe fallback.
        }
      }
      endingRef.current = false
      setVoiceState(options.errorCode ? 'error' : 'idle')
    },
    [anonymousToken, client.voice.end, releaseBrowserMedia, setVoiceState, venueId],
  )

  useEffect(() => {
    if (!anonymousToken) {
      setAvailable(false)
      return
    }
    let current = true
    void client.voice.availability
      .query({ venueId, anonymousToken })
      .then((result) => {
        if (!current) return
        setAvailable(result.enabled)
        setPremiumAvailable(result.enabled && result.premiumAvailable)
      })
      .catch(() => {
        if (current) setAvailable(false)
      })
    return () => {
      current = false
    }
  }, [anonymousToken, client.voice.availability, venueId])

  useEffect(
    () => () => {
      releaseBrowserMedia()
      const voiceSessionId = sessionIdRef.current
      if (voiceSessionId && anonymousToken) {
        void client.voice.end.mutate({
          venueId,
          anonymousToken,
          voiceSessionId,
          fallbackToText: true,
          errorCode: 'CLIENT_UNMOUNTED',
        })
      }
    },
    [anonymousToken, client.voice.end, releaseBrowserMedia, venueId],
  )

  const saveTranscript = useCallback(
    (speaker: 'VISITOR' | 'ASSISTANT', text: string, providerEventId: string) => {
      const clean = text.trim()
      const voiceSessionId = sessionIdRef.current
      if (!clean || !voiceSessionId || !anonymousToken) return
      const sequence = sequenceRef.current++
      setTranscript((lines) => [...lines, { speaker, text: clean }].slice(-12))
      void client.voice.transcript
        .mutate({
          venueId,
          anonymousToken,
          voiceSessionId,
          providerEventId,
          sequence,
          speaker,
          text: clean,
          language: getChatLanguagePresentation(language).code,
        })
        .catch(() => undefined)
    },
    [anonymousToken, client.voice.transcript, language, venueId],
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
        if (type === 'input_audio_buffer.speech_started') setVoiceState('listening')
        else if (type === 'input_audio_buffer.speech_stopped' || type === 'response.created') {
          setVoiceState('thinking')
        } else if (type.includes('output_audio') && type.endsWith('.delta')) {
          setVoiceState('speaking')
        } else if (type === 'response.done') {
          saveUsage(event, eventId)
          setVoiceState('listening')
        } else if (type === 'conversation.item.input_audio_transcription.completed') {
          saveTranscript('VISITOR', String(event.transcript ?? ''), eventId)
        } else if (
          type === 'response.output_audio_transcript.done' ||
          type === 'response.audio_transcript.done'
        ) {
          saveTranscript('ASSISTANT', String(event.transcript ?? ''), eventId)
        } else if (type === 'error') {
          setError('The voice connection reported an error. Continue in text or try again.')
          void endSession({ fallbackToText: true, errorCode: 'PROVIDER_EVENT_ERROR' })
        }
      } catch {
        // Ignore provider events this client version does not understand.
      }
    },
    [endSession, saveTranscript, saveUsage, setVoiceState],
  )

  async function startSession() {
    if (!anonymousToken || disabled || (state !== 'idle' && state !== 'error')) return
    setError(null)
    setTranscript([])
    sequenceRef.current = 0
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined') {
        throw new Error('VOICE_UNSUPPORTED')
      }
      setVoiceState('requesting')
      const stream = await requestMicrophoneStream()
      streamRef.current = stream
      setVoiceState('connecting')
      const locale = getChatLanguagePresentation(language).code
      const authorization = await client.voice.start.mutate({
        venueId,
        anonymousToken,
        locale,
        tier: premiumAvailable ? 'PREMIUM' : 'ECONOMY',
      })
      sessionIdRef.current = authorization.voiceSessionId

      const peer = new RTCPeerConnection()
      peerRef.current = peer
      const audio = document.createElement('audio')
      audio.autoplay = true
      peer.ontrack = (event) => {
        audio.srcObject = event.streams[0] ?? new MediaStream([event.track])
      }
      for (const track of stream.getTracks()) peer.addTrack(track, stream)
      const channel = peer.createDataChannel('oai-events')
      channelRef.current = channel
      channel.addEventListener('message', handleProviderEvent)
      channel.addEventListener('open', () => setVoiceState('listening'))
      channel.addEventListener('close', () => {
        if (sessionIdRef.current) void endSession({ fallbackToText: true })
      })

      const offer = await peer.createOffer()
      await peer.setLocalDescription(offer)
      if (!offer.sdp) throw new Error('VOICE_SDP_UNAVAILABLE')
      const response = await fetch('https://api.openai.com/v1/realtime/calls', {
        method: 'POST',
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${authorization.clientSecret}`,
          'Content-Type': 'application/sdp',
        },
      })
      if (!response.ok) throw new Error(`REALTIME_CONNECT_${response.status}`)
      await peer.setRemoteDescription({ type: 'answer', sdp: await response.text() })
      await client.voice.connected.mutate({
        venueId,
        anonymousToken,
        voiceSessionId: authorization.voiceSessionId,
      })
      stopTimerRef.current = window.setTimeout(() => {
        void endSession({ fallbackToText: true })
      }, authorization.maxDurationSeconds * 1_000)
    } catch (cause) {
      setError(readableError(cause))
      await endSession({ fallbackToText: true, errorCode: 'CLIENT_CONNECTION_FAILED' })
    }
  }

  if (!available) return null

  return (
    <VoiceControlPanel
      state={state}
      disabled={disabled}
      error={error}
      transcript={transcript}
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
  onStart,
  onEnd,
}: {
  state: VoiceState
  disabled: boolean
  error: string | null
  transcript: VoiceTranscriptLine[]
  onStart: () => void
  onEnd: () => void
}) {
  const active = state !== 'idle' && state !== 'error'
  const canRetry = state === 'error'

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
      {transcript.length ? (
        <div
          className="mt-2 max-h-28 space-y-1 overflow-y-auto border-t border-[var(--chat-border)] pt-2 text-sm"
          aria-label="Voice transcript"
        >
          {transcript.map((line, index) => (
            <p key={`${line.speaker}-${index}`} dir="auto" className="text-[var(--chat-text)]">
              <span className="font-semibold">{line.speaker === 'VISITOR' ? 'You' : 'Guide'}:</span>{' '}
              {line.text}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  )
}
