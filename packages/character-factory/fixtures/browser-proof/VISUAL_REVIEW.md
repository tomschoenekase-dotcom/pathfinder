# P07 semantic playback visual review

## Captured evidence

The current evidence uses the real Next.js dashboard fixture route and imported
`FamilyRigRenderer`. The earlier self-contained HTML captures are retained as superseded interim
evidence and are not the basis of the current claim.

Chromium rendered the self-contained fixture directly from the repository:

- `react-speaking-desktop.png`: 1440 × 1000, segmented full motion, speaking state.
- `react-success-mobile.png`: iPhone 13 emulation, segmented full motion, success state.
- `react-reduced-tablet.png`: 1024 × 768, explicit reduced motion, thinking state.
- `react-double-fallback-tablet.png`: 1024 × 768, failed layers and failed static assets resolving
  to the accessible neutral fallback.

The desktop comparison has no clipping or horizontal overflow. The mobile layout changes to a
compact image-and-description row and retains readable source/rig labels. The fallback remains
visible without implying that a character asset loaded. Reduced motion removes transforms and
animation while keeping the semantic state in accessible text.

## Visual quality critique

The editorial specimen-sheet layout fits an architecture proof and avoids a generic dashboard or
card grid. The warm paper palette and restrained dividers keep attention on the three forms. Type,
spacing, and hierarchy hold at the inspected widths.

The imported OpenMoji fixtures are visually coherent enough to compare motion families but are not
production character candidates. Deterministic source-derived layers now provide an owl wing pivot,
astronaut helmet/head nod, and morph body/face separation. The source does not provide astronaut arm
parts, and speaking remains weak without mouth/beak segmentation. Repeating the small motion set for
a long voice session would still look mechanical. A richer segmented raster or trusted deforming
mesh remains necessary before a commercial-quality runtime decision.

## Limits

- Screenshots prove browser rendering at sampled animation instants; they do not prove animation
  smoothness or a frame-rate budget.
- System-level `prefers-reduced-motion` was not emulated in the captured browser; the equivalent
  explicit reduced path was captured and the media query is covered by source tests.
- No physical device, Safari, Firefox, page-suspension, or slow-network proof was run.
- This is neutral fixture evidence only. It neither selects nor represents final Tochi art.
