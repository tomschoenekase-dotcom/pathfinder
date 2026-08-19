import React from 'react'

import styles from './TorchikoClientPrimitives.module.css'

export type TorchikoCoreState = 'welcome' | 'share' | 'processing' | 'questions' | 'ready' | 'live'

export function TorchikoCore({
  state = 'welcome',
  size = 'hero',
  className,
}: {
  state?: TorchikoCoreState
  size?: 'hero' | 'compact'
  className?: string
}) {
  return (
    <div
      className={[styles.core, size === 'compact' ? styles.coreCompact : '', className]
        .filter(Boolean)
        .join(' ')}
      data-state={state}
    >
      <svg
        className={styles.coreSvg}
        viewBox="0 0 640 520"
        fill="none"
        aria-hidden="true"
        focusable="false"
      >
        <ellipse className={styles.coreField} cx="316" cy="260" rx="259" ry="185" />
        <ellipse className={styles.coreField} cx="347" cy="260" rx="190" ry="134" />
        <path
          className={`${styles.coreStrand} ${styles.strandAqua}`}
          d="M55 123C186 41 379 76 505 250"
          pathLength="1"
          strokeWidth="9"
        />
        <path
          className={`${styles.coreStrand} ${styles.strandAquaDeep} ${styles.strandTwo}`}
          d="M72 194C224 130 389 159 510 253"
          pathLength="1"
          strokeWidth="7"
        />
        <path
          className={`${styles.coreStrand} ${styles.strandBlue} ${styles.strandThree}`}
          d="M47 273C192 242 382 247 510 263"
          pathLength="1"
          strokeWidth="8"
        />
        <path
          className={`${styles.coreStrand} ${styles.strandBlueDeep} ${styles.strandFour}`}
          d="M94 358C231 359 395 319 510 270"
          pathLength="1"
          strokeWidth="7"
        />
        <path
          className={`${styles.coreStrand} ${styles.strandInk} ${styles.strandFive}`}
          d="M103 433C260 478 410 377 510 275"
          pathLength="1"
          strokeWidth="9"
        />
        <path className={styles.coreSeam} d="M187 162C307 135 417 182 492 247" />
        <path className={styles.coreSeam} d="M203 365C324 354 424 313 493 274" />
        <ellipse className={styles.coreHalo} cx="512" cy="262" rx="48" ry="48" />
        <path
          className={styles.coreEmber}
          d="M492 224C515 230 535 242 547 257C551 246 551 234 547 222C561 231 569 244 570 258C580 253 587 244 590 235C597 247 600 260 598 273C594 294 575 307 554 307C532 308 510 298 496 281C513 284 530 278 540 266C530 247 515 233 492 224Z"
        />
        <path
          fill="#fff1aa"
          d="M535 286C547 278 552 266 552 252C563 260 568 270 565 279C574 276 581 270 585 264C585 276 579 286 570 291C558 298 545 293 535 286Z"
        />
      </svg>
    </div>
  )
}
