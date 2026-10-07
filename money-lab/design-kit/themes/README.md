# Themes

Load `base.css`, then ONE of these, then your own `site.css`. Each theme sets the fonts and the
colours; everything else comes from base.css. Change at least two things so the result is yours:
the accent colour, the heading font, the radius, a background pattern, a signature element.

| Theme | Feel | Fonts (Google Fonts, free) | Good for |
| --- | --- | --- | --- |
| sober | calm, precise, trustworthy | Inter + Inter | tools, calculators, B2B |
| warm | friendly, human | Fraunces + Source Sans 3 | local services, crafts, food |
| editorial | magazine, serious | Playfair Display + Lora | guides, comparisons, content |
| playful | bright, rounded | Nunito + Nunito | kids, hobbies, games |
| technical | dense, monospaced accents | IBM Plex Sans + IBM Plex Mono | developer tools, data |
| retro | bold, 70s print | Archivo Black + Archivo | brands that want to stand out |

Fonts load from Google Fonts with `<link rel="preconnect">` + the `@import` in each theme. To
self-host (faster, no third party), download the woff2 files (e.g. from fontsource.org) into
`/fonts/` and replace the `@import` with `@font-face` rules.
