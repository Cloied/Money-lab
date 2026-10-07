# Icons, illustrations, images

Use SVG icons inline (no icon font, no extra request). Copy the `<svg>` from the set's site and add
`aria-hidden="true"` next to text, or `role="img"` + `<title>` when the icon stands alone.
Keep ONE icon set per site; mixing sets looks amateur.

| Need | Source (free, check the licence page once) | Notes |
| --- | --- | --- |
| Interface icons | lucide.dev (ISC), tabler.io/icons (MIT), heroicons.com (MIT), phosphoricons.com (MIT) | 24px grid, stroke 2; download SVG |
| Brand logos | simpleicons.org (CC0) | GitHub, Stripe, Bluesky... |
| Flags, emoji as images | openmoji.org (CC BY-SA), twemoji (CC BY) | credit required |
| Illustrations | undraw.co (own licence, free, colour-matchable), opendoodles.com (CC0), humaaans.com (CC BY) | adapt the colour to `--accent` |
| Photos | unsplash.com, pexels.com (free licences) | resize to the display width, convert to WebP |
| Patterns and backgrounds | heropatterns.com (CC BY 4.0), haikei.app (blobs, waves, free export) | subtle, low contrast |
| Favicon and link preview | render_image presets `favicon` (512x512) and `og` (1200x630) | your own design, always |

Example inline icon (Lucide "check"):
```html
<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>
```
