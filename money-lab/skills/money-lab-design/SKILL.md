---
name: money-lab-design
description: Design web pages that look professional while staying simple, fast and original; the method, the kit in ~/library/design, free resources, and the checks before publishing
auto-activate: false
---
# Money Lab design

A page people trust gets used, shared and ranked. You have no designer: this method replaces one.
Never publish a page that skipped the checks at the end.

## 1. Brief before code (10 minutes, in ~/research/<site>/design-brief.md)
- **Reader**: one person, their situation, the device they will use (most will be on a phone).
- **Job**: the single thing the page must make easy. One main action per page.
- **Feeling**: two adjectives (e.g. "precise, calm"; "warm, handmade"). Pick the kit theme that
  matches (`~/library/design/themes/README.md`), then plan two changes that make it yours.
- **Competitors**: `view_page` three of them (desktop + mobile), note what they all do the same,
  and choose ONE distinctive element for your page: a signature shape or motif, an unusual but
  readable font pairing, a way of framing the tool, a colour nobody in the niche uses, a small
  delightful detail (an animation on the result, a hand-drawn arrow). Not a gimmick: one thing.
- **Message test**: write the H1 and the lede. A stranger must know in five seconds what it does and
  for whom. Verify later with `first_impression`.

## 2. Build with the kit
- Start from `~/library/design/templates/tool.html` or `landing.html`; link `base.css`, ONE theme,
  then your `site.css`. Every colour and size goes through the custom properties (`--accent`,
  `--space-*`, `--step-*`); no ad-hoc hex values or pixel margins in the HTML.
- Rules that make simple pages beautiful: generous whitespace (sections padded with `--space-7`+);
  at most 2 fonts; a type scale (headings far bigger than body); one accent colour plus neutrals;
  consistent radius and shadow; align everything to the container; 45-75 characters per line;
  mobile first (test at 390px before desktop); real content, no lorem ipsum, no stock clichés.
- Trust signals, honestly: who made it, how it works, what happens to data, a contact, an "about"
  page, a last-updated date, no fake testimonials or counters.
- Icons inline (one set, see `~/library/design/icons.md`); images resized to display width, WebP,
  with alt text; a favicon and an og image made with `render_image` (presets `favicon`, `og`).
- Interactions: the main action visible without scrolling on mobile; results appear in place with a
  clear state (loading, success, error with what to do); keyboard works; focus is visible.
- Performance is design: no framework for a static page, no web font over 2 weights, no script you
  do not need. Aim `audit_page` 90+ everywhere.

## 3. Free resources (check the licence page once, cite nothing you did not read)
- Fonts: fonts.google.com (pairings: fontpair.co, typewolf.com for inspiration); self-host from fontsource.org.
- Colours: realtimecolors.com (test a palette on a real layout), coolors.co, open-props.style and
  radix-ui.com/colors (accessible scales), accessible-colors.com for contrast fixes.
- Components to study or copy (MIT unless noted): uiverse.io (buttons, cards, loaders), hyperui.dev,
  picocss.com (semantic classless CSS), open-props.style, shadcn/ui and daisyui.com (patterns, even without their framework),
  animista.net (CSS animations), css-tricks.com and web.dev/patterns (layout and component patterns).
- Inspiration (look, do not copy): land-book.com, godly.website, siteinspire.com, lapa.ninja,
  minimal.gallery, httpster.net, dribbble.com (search "landing page" + your niche), awwwards.com.
- Illustrations and backgrounds: undraw.co (recolour to `--accent`), opendoodles.com, haikei.app
  (waves, blobs, gradients), heropatterns.com, css-pattern.com (pure CSS patterns).
- Icons: lucide.dev, tabler.io/icons, heroicons.com, phosphoricons.com, simpleicons.org.
- Images: unsplash.com, pexels.com; squoosh.app and svgomg.net to compress (or `cwebp`/`npx svgo`
  on your server).
- Accessibility and quality: webaim.org/resources/contrastchecker, dequeuniversity.com/rules/axe
  (explains every `check_design` finding), web.dev/learn/design, html.spec.whatwg.org for correct markup.
- Copywriting: read 3 good pages in your niche; write the headline as the outcome, the lede as who
  and how; buttons say what happens ("Télécharger le PDF", not "Envoyer").
When `harvest` or `web_fetch` reads one of these sites, save what you keep (palette, pairing, pattern)
in `~/library/design/notes.md` with the source and licence, so you never research it twice.

## 4. Before publishing (every page, every significant change)
1. `check_design` (free): fix every ERROR, then the warnings that affect readers (overflow, contrast,
   tap targets, alt text, heavy images). Look at both screenshots: hierarchy, spacing, alignment.
2. `first_impression` (free): if the five-second reader cannot say what the page does and for whom,
   rewrite the H1 and lede before touching anything else.
3. `audit_page` (free): 90+ on performance, accessibility, best practices, SEO.
4. `design_review` (free by default: a vision model reads both screenshots): as often as you iterate.
   `design_review final: true` (Opus, a few cents): once per page before it goes live and after a
   redesign. Apply the top fixes or record why not. Verdict FIX FIRST means it is not ready.
5. `view_page` desktop, mobile and print (if people print or save as PDF). Then publish.
Record the before/after screenshots and the review in `record_experiment` evidence. Save reusable
pieces (a nice result card, a form pattern) in `~/library/` for the next product.
