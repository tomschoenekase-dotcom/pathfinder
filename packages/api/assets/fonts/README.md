# Venue QR print fonts

These fonts are bundled for server-side rasterization of printable QR sheet titles and URLs. Keep this folder in the production server image and register it with Fontconfig before invoking `renderVenueQrPdf`. The print renderer rasterizes text into the PDF, so no font file is loaded by the visitor dashboard.

All three fonts are licensed under SIL Open Font License 1.1. Each font's full license and upstream copyright notice is in its subfolder.

| File                                          | Family coverage                              | Upstream pin                                               | SHA-256                                                            |             Size |
| --------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------ | ---------------: |
| `noto-sans-latin/NotoSans-Regular.otf`        | Latin, Greek, Cyrillic                       | Noto Sans v2.015, `notofonts/latin-greek-cyrillic` release | `BFB44DE2C2031C391FF856943FE8F105EBB5D725CB9A04D493D211D5BBD5C21B` |    331,784 bytes |
| `noto-sans-arabic/NotoSansArabic-Regular.ttf` | Arabic                                       | Noto Sans Arabic v2.012, `notofonts/arabic` release        | `472ABE37EC7A7CE61AA2CA6F01D9C4299F6ADD431DA828F054CD1B41AC0ED5A4` |    292,600 bytes |
| `noto-sans-cjk-sc/NotoSansCJKsc-Regular.otf`  | CJK, Simplified Chinese regional glyph forms | Noto Sans CJK v2.004, Simplified Chinese OTF release       | `2C76254F6FC379FDDFCE0A7E84FB5385BB135D3E399294F6EEB6680D0365B74B` | 16,437,364 bytes |

Upstream sources:

- Latin: <https://github.com/notofonts/latin-greek-cyrillic/releases/tag/NotoSans-v2.015>
- Arabic: <https://github.com/notofonts/arabic/releases/tag/NotoSansArabic-v2.012>
- CJK: <https://github.com/notofonts/noto-cjk/releases/tag/Sans2.004>

The total font payload is 17,061,748 bytes (16.3 MiB). CJK coverage is pinned to the Simplified Chinese regional font. Japanese, Korean and Traditional Chinese region-specific glyph forms are not bundled; Noto Sans SC covers shared CJK ideographs but may choose Simplified Chinese forms for ambiguous glyphs.
