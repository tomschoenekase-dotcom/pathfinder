import React from 'react'

import { normalizeTorchikoBrandText } from '@pathfinder/ui'

type WeeklyReportContentProps = { content: string }

export function WeeklyReportContent({ content }: WeeklyReportContentProps) {
  const paragraphs = normalizeTorchikoBrandText(content)
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)

  return (
    <div className="space-y-4 text-sm leading-7 text-pf-deep/80">
      {paragraphs.map((paragraph, index) => (
        <p key={`${index}:${paragraph.slice(0, 32)}`} className="whitespace-pre-wrap">
          {paragraph}
        </p>
      ))}
    </div>
  )
}
