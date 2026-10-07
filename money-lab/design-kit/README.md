# Money Lab design kit

A starting point for sites that look professional while staying simple, fast and original.
Installed by the runtime into `~/library/design/` (this copy is refreshed on updates: put your own
work in `~/library/`, not here).

```
base.css              foundation: fluid type, spacing scale, components, dark mode, print
themes/<name>.css     six very different looks (fonts + colours); pick one, then make it yours
templates/tool.html   a one-tool page: hero, the tool, how it works, FAQ, footer
templates/landing.html a product landing page with sections you can delete
components.html       every component rendered once, to copy from
icons.md              how to use free SVG icon sets inline
```

## How to start a page
1. Copy `templates/tool.html` (or `landing.html`) next to your site files.
2. Link `base.css` and ONE theme, then your `site.css` for what is specific to this site.
3. Change at least two things: the accent colour (`--accent`), a font, the radius, a background
   pattern or a signature element (a shape, a motif, a way of framing the main action).
4. Replace every placeholder text. Write for one reader; say what the tool does in the first line.
5. Run `check_design`, fix, then `design_review` before publishing.

Everything here is MIT-licensed by this project; the fonts are from Google Fonts (open licences).
