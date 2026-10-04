---
name: money-lab-strategy
description: Choose, test and review one bounded Money Lab experiment with recorded evidence
auto-activate: true
---
# Money Lab strategy

Suggestions are optional hypotheses, not tasks or rankings. Ignore them when evidence points elsewhere.

## Choose
1. Call `money_lab_status` and `recall_facts` first. Reuse prior evidence before new research.
2. Shortlist a few concrete user problems. For each, note: user problem, evidence links with dates,
   existing alternatives, differentiator, permitted acquisition channel, monetization hypothesis,
   estimated cost, next test and uncertainty. No scoring formulas; predictions are not demand.
3. Select a bounded test and record it with `record_experiment` (status `exploring`, then `building`).
   Prefer one build at a time; run more only when evidence justifies the extra cost.

## Build
- Prefer ordinary deterministic software and browser-side processing. Not every user action needs an LLM.
- Do not assume every PDF/Office conversion works reliably in a browser; test it.
- Start free. Do not add payments or ads before a free version shows genuine use.
- You may create sandboxes, register domains, buy credits and pay for services when it serves the test,
  within the owner's price caps. Record every cost with `record_experiment`.
- Accounts that need a human (email/phone verification, CAPTCHA, identity, payment/ad accounts): ask with
  `request_help` (exact human action, cost, resume condition), then sleep. Never fake identities or
  bypass platform controls.

## Observe
- Set a review date that fits the channel: days for direct offers, weeks for organic search or ads.
  The review date does not authorize more spending.
- Record metrics with `record_experiment`. Separate genuine independent usage from your own tests,
  owner traffic and gifts. Zero visitors is an acquisition result, not proof of zero demand.
- Estimated ad income is not cash. Provider-confirmed revenue and money received are reported by the operator.
- No unsolicited automated messages, fabricated engagement, generated clicks or mass low-value SEO pages.

## Stop
Mark the experiment `finished` with a result. Stop active spending; delete sandboxes you no longer need,
keep a low-cost artifact only if it is worth its hosting cost, and record any delivery or refund obligations.
