# Neutral character architecture fixtures

These are imported test sources, not Torchiko-generated character art and not Tochi candidates.

- Owl: OpenMoji `1F989.svg`
- Astronaut: OpenMoji `1F9D1-200D-1F680.svg`
- Morph/ghost: OpenMoji `1F47B.svg`

All three files are pinned to OpenMoji tag `16.0.0`, commit
`66e17da0f2d4347f64ee9d78c367fc5234283863`. OpenMoji graphics are licensed
under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) and are
copyright OpenMoji contributors. Source: https://github.com/hfg-gmuend/openmoji.

The SVG files remain quarantined architecture fixtures. The factory inspects them but does not
publish or inline them as trusted runtime code. A production pipeline must decode and normalize
approved source into bounded raster slots.
