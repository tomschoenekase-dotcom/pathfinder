import type { CSSProperties } from 'react'
import type { ChatAppearanceTokens, ChatPalette } from '@pathfinder/ui/theme'

/**
 * One mapping from resolved appearance tokens to CSS custom properties, shared by the chat and
 * the venue start screen so both screens stay visually consistent.
 */
export function chatAppearanceStyle(
  palette: ChatPalette,
  tokens: ChatAppearanceTokens,
  highContrast = false,
): CSSProperties {
  return {
    '--chat-accent': palette.accent,
    '--chat-accent-text': highContrast ? tokens.actionText : palette.accentText,
    '--chat-accent-contrast': palette.accentContrast,
    '--chat-surface': tokens.footerBg,
    '--chat-bg': tokens.pageBg,
    '--chat-card': highContrast ? tokens.pageBg : palette.card,
    '--chat-border': highContrast ? tokens.pageText : palette.border,
    '--chat-text': tokens.pageText,
    '--chat-text-muted': tokens.pageMuted,
    '--chat-header-bg': tokens.headerBg,
    '--chat-header-text': tokens.headerText,
    '--chat-header-muted': tokens.headerMuted,
    '--chat-header-accent': tokens.headerAccent,
    '--chat-header-border': tokens.headerBorder,
    '--chat-footer-bg': tokens.footerBg,
    '--chat-footer-text': tokens.footerText,
    '--chat-footer-muted': tokens.footerMuted,
    '--chat-footer-border': tokens.footerBorder,
    '--chat-field-bg': tokens.fieldBg,
    '--chat-field-text': tokens.fieldText,
    '--chat-field-muted': tokens.fieldMuted,
    '--chat-field-border': tokens.fieldBorder,
    '--chat-user-bg': tokens.userBg,
    '--chat-user-text': tokens.userText,
    '--chat-user-border': tokens.userBorder,
    '--chat-assistant-bg': tokens.assistantBg,
    '--chat-assistant-text': tokens.assistantText,
    '--chat-assistant-border': tokens.assistantBorder,
    '--chat-speaker-label': tokens.speakerLabelColor,
    '--chat-action-bg': tokens.actionBg,
    '--chat-action-text': tokens.actionText,
    '--chat-action-border': tokens.actionBorder,
    '--chat-backdrop-position': tokens.backgroundPosition,
    '--chat-backdrop-overlay': tokens.backgroundOverlay,
  } as CSSProperties
}
