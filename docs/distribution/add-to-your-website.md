# Add Torchiko to your website

Torchiko gives your venue's visitors the same guide they see through its QR link. Choose a floating launcher, an inline guide, or both. The code below contains no secret or API key.

## Before you paste anything

Ask Torchiko for **(1)** your venue slug, **(2)** the exact Torchiko web origin, and **(3)** confirmation that website access is enabled for your venue and that your website's exact HTTPS origin is allowed. An origin is the scheme, host, and optional port, such as `https://www.example.org`; it has no path. Include every host that will embed the guide, such as both `www` and the bare domain. Torchiko must enable this access first. A preview on a different domain will need its own allowed origin.

In the examples, replace `https://YOUR-TORCHIKO-ORIGIN` and `YOUR-VENUE-SLUG` with the values Torchiko sends you. Keep `https://` and the `/widget.js` path. Test on your actual HTTPS site.

## Floating launcher: paste before `</body>`

```html
<script
  src="https://YOUR-TORCHIKO-ORIGIN/widget.js"
  data-torchiko-venue="YOUR-VENUE-SLUG"
  async
></script>
```

The button opens the guide when a visitor taps it. To open it from your own button, **replace** the snippet above with this complete block before `</body>`. This version waits for the loader script before wiring the button:

```html
<script src="https://YOUR-TORCHIKO-ORIGIN/widget.js" data-torchiko-venue="YOUR-VENUE-SLUG"></script>
<button type="button" id="ask-torchiko">Ask about this place</button>
<script>
  document.getElementById('ask-torchiko').addEventListener('click', function () {
    window.Torchiko.open()
  })
</script>
```

You can pass a starting question: `window.Torchiko?.open({ ask: 'Where is the entrance?' })`. It fills the question box; the visitor must tap Send. Keep `ask` to 200 characters or less. If Torchiko gives you a public place ID for this venue, `window.Torchiko?.open({ place: 'PUBLIC-PLACE-ID' })` can start in that place's context. An unknown or private ID is ignored. `window.Torchiko?.close()` closes the launcher. The optional `window.Torchiko?.on('ready', callback)`, `.on('open', callback)`, and `.on('close', callback)` hooks report guide state; they contain no visitor conversation data.

## Inline guide: paste where it should appear

```html
<div data-torchiko-inline="YOUR-VENUE-SLUG" style="height: 720px"></div>
<script src="https://YOUR-TORCHIKO-ORIGIN/widget.js" async></script>
```

The guide fills the reserved area. Adjust the container height for your layout and check it on a phone. You may use an inline guide and a launcher on the same page; use one script tag with the launcher attribute if you do:

```html
<div data-torchiko-inline="YOUR-VENUE-SLUG" style="height: 720px"></div>
<script
  src="https://YOUR-TORCHIKO-ORIGIN/widget.js"
  data-torchiko-venue="YOUR-VENUE-SLUG"
  async
></script>
```

If your site sets a Content Security Policy, allow the exact Torchiko web origin in `script-src`, `style-src`, `connect-src`, and `frame-src`. Torchiko separately allows your exact origin to frame the guide. A restrictive site policy or an unapproved origin can prevent it from appearing. Do not add a wildcard to work around a blocked frame.

## Test before publishing

- On the real HTTPS page, open the launcher, close it, and reopen it. Check that the guide returns without losing the conversation during that page visit.
- If using inline mode, check the guide at phone and desktop widths. The page should not scroll sideways, and the question box should remain reachable above the keyboard.
- Try the existing button and an optional `ask` value. The question should appear without sending a message.
- Check your site's browser console for blocked script, style, request, or frame policies. Ask Torchiko to verify your exact origin if the guide is absent.
- Verify keyboard focus, screen-reader label, and your site's privacy or consent wording.

For deeper installation details, see [website installation](website-installation.md). Torchiko's access remains off until its operator enables the venue and origin; installing the snippet alone does not turn it on.
