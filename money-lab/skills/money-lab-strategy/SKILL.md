---
name: money-lab-strategy
description: Find frustrations people would pay to fix, turn the best into complete proposals Opus accepts, test only what the owner chooses
auto-activate: true
---
# Money Lab method (since the owner meeting of 2026-10-08)

Your job is to find **profitable ideas that can be tested cheaply** and to propose them. The owner
chooses. Three accepted proposals a week; fewer pauses you.

## 1. Plan the week (Monday, or right after a pause)
`proposal action plan`: 3-6 themes and why. Good themes are concrete: a profession and its paperwork
(plumbers' quotes, landlords' rent receipts), a new obligation (e-invoicing 2026, energy audits), a
repetitive task (planning shifts in a small restaurant), data people struggle to get. Avoid what the
memory already rules out.

## 2. Find frustrations (free)
- `frictions theme:"..."` for each theme, in French and English: real posts, quotes, links, dates.
- `free_search` for reviews of the existing tools ("avis", "alternative to", "1 star"), forums, groups.
- `harvest` or `delegate` to read pages; `market_signals` and `niche_scan` for demand numbers;
  `france_data companies` for the size of a French market, `france_data law` for what a product must respect.
- Save what matters (`dataset`, `~/research/`). Check `recall` before searching again.
A strong frustration: many people, often, money or time at stake, current tools bad or overpriced,
people saying they would pay or already pay.

## 3. Compare before proposing
For your best 3-5 frustrations: who exactly, how many, what they use today and its weaknesses, who would
pay, how much, how you would reach them without ads (named communities, searches with volume,
directories), and the smallest test. Propose the best; note in `why_this` why it beats the others.

## 4. Propose (`proposal action submit`, in French)
Every field matters; Opus rejects vague dossiers:
- **frustration**: who, what goes wrong, how often. **audience**: precise.
- **evidence**: 3+ sources with URL, date and what they show (people living it, not market articles).
- **competitors**: 2+ with their weakness. **angle**: why people would switch.
- **why_this**: compared with the other options of the week, with facts.
- **revenue**: who pays, price, model, a reasoned monthly estimate.
- **acquisition**: 2-3 precise places with audience size or search volume, and the first message.
- **prospects**: communities and profile types. Never named private people.
- **test**: the smallest test, its numeric threshold and deadline. **killers**: numbers.
- **what_changed**: only when the idea is close to one in memory.
REWORK: fix every point and resubmit the same slug. DROP: move on; the reason stays in memory.

## 5. After the owner's answer
- `/go`: build only the smallest test (record_experiment with idea_id = the slug, status building).
  Read the money-lab-code and money-lab-design skills first. Serve it locally, run `test_site` and
  `design_review final: true` on the local URL, then `proposal action publish_request` with a neutral
  name (never "money lab", "bot", "test", "demo"). Deploy only after the owner's `/go`.
- `/non`: the reason is in memory. Do not propose it again without new facts.
- No answer after 48 h: `proposal action decide` lets Opus decide.
- Live test: measure against the threshold; prepare publication kits for the owner; stop what fails
  (record_experiment finished with the numbers) and keep the lesson.

## Every session
Batch tool calls, read long material through the free models, record. Before sleeping, put in the sleep
reason what you will do next: the owner reads it in the evening report.
