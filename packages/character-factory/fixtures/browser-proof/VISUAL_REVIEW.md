# P07 semantic playback visual review

## Captured evidence

Chromium rendered the self-contained fixture directly from the repository:

- `speaking-desktop.png`: 1440 × 1000, full motion, speaking state.
- `success-mobile.png`: iPhone 13 emulation (390 × 844 CSS viewport), full motion, success state.
- `reduced-tablet.png`: 1024 × 768, explicit reduced motion, thinking state.
- `asset-fallback-tablet.png`: 1024 × 768, missing source assets and neutral fallback.

The desktop comparison has no clipping or horizontal overflow. The mobile layout changes to a
compact image-and-description row and retains readable source/rig labels. The fallback remains
visible without implying that a character asset loaded. Reduced motion removes transforms and
animation while keeping the semantic state in accessible text.

## Visual quality critique

The editorial specimen-sheet layout fits an architecture proof and avoids a generic dashboard or
card grid. The warm paper palette and restrained dividers keep attention on the three forms. Type,
spacing, and hierarchy hold at the inspected widths.

The imported OpenMoji fixtures are visually coherent enough to compare motion families but are not
production character candidates. Whole-image transforms read as an owl pivot/hop, upright astronaut
lean/lift, and elastic morph squash/stretch. Speaking remains weak because mouths and beaks are not
separate. The astronaut cannot gesture with an arm, and the owl cannot flap independently. Repeating
these moves for a long voice session would look mechanical. A segmented raster or trusted deforming
mesh is still required before a commercial-quality runtime decision.

## Limits

- Screenshots prove browser rendering at sampled animation instants; they do not prove animation
  smoothness or a frame-rate budget.
- System-level `prefers-reduced-motion` was not emulated in the captured browser; the equivalent
  explicit reduced path was captured and the media query is covered by source tests.
- No physical device, Safari, Firefox, page-suspension, or slow-network proof was run.
- This is neutral fixture evidence only. It neither selects nor represents final Tochi art.
