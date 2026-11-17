---
id: PRD-006
title: UI checked in a real browser, inside the loop
status: in-progress
created: 2026-11-16
updated: 2026-11-17
---

# PRD-006 — UI checked in a real browser, inside the loop

## 1. Problem and evidence

The harness asks for tests and for test-first work, but nothing in the loop ever draws a screen. In Tama OS
(2026-11-16, demo data) every unit test passed while:

- the project room's conversation ("Hilo de la sala") was squeezed to 64–142 px, 14–32 % of its panel, at every
  screen size from 1280×720 to 1920×1080;
- a session view on a phone set its title one word per line under a select, with a 24 px conversation;
- 12 of 121 buttons answered nothing visible, and 10 shoved the screen with an abrupt insert.

The operator's own complaint is the last two: "I press buttons and do not always see that anything happened; red text
just appears abruptly."

## 2. What was measured before deciding

| Option | Result on Tama OS | Decision |
|---|---|---|
| Bombadil 0.7.10, default properties | 0 findings in 6 min: it watches crashes, console errors and HTTP failures, not layout | Kept for later: nightly exploration (ticket 05) |
| Bombadil with a layout property | Found the squeezed thread in ~8 s once a custom action took it into a room | Same mechanism as below, slower to reach a screen |
| Playwright, same property | 12/12 size × room combinations in 16 s | **The runner** |
| Jev (TypeSafe) as a visual judge, 4 generic questions × 17 screenshots × 2 passes | Saw only blatant breakage (0.98); the squeezed thread scored 0.20–0.32, the same as healthy screens; ~2,400 input tokens a screenshot | **Rejected** for screenshots |
| Six geometry rules, no project knowledge | 571 alarms → 9 after calibration; caught the thread and two phone breakages | **Kept** |
| ~130 guidelines from ui-ux-pro-max, ux-heuristics, no-ai-design-slop | Mechanical ones tested: text-over-text, tap-target and axe-core kept; "text < 11 px" rejected (691 hits: small mono labels are a design choice) | Mechanical → rules; judgment → the visual critic (ticket 04) |
| Press every button, observe 1 s | 121 buttons: 12 silent, 3 unannounced, 10 abrupt | **Kept** as the interaction rules |

## 3. Decisions

- **D1 — Rules run as a command, not as an agent.** A rule answers the same every run and costs no tokens; a model
  is kept for what no rule covers (ticket 04) and for writing project rules (ticket 03).
- **D2 — One rule set for every web project**, in `ui-check.js`, with project rules added on top. Capped at about
  20 mechanical rules; a new one enters only if it beats the weakest on calibration.
- **D3 — Every rule starts at `warn`.** Calibrated on one project; a project promotes a rule to `block` once it is
  quiet there. `warn` reaches the code reviewer as evidence; `block` sends the change back before review.
- **D4 — In the loop, after every implementation**, not after it: a rule is cheapest to satisfy while the
  implementer still holds the change, and a BLOCK round spends no reviewer tokens.
- **D5 — A run that could not open the app is NOT VERIFIED**, never a pass (same rule as a preflight `SKIP`).
- **D6 — The probe never presses a destructive label**, and interactions are opt-in, for demo data.

## 4. Tickets

`docs/tickets/prd-006-ui-check/`: 01 ui-check script and rules · 02 the loop seat · 03 rule-author seat · 04 visual
critic seat · 05 nightly exploration.

## 5. Out of scope

The Pi loop (`develop-phase-pi.js`) until ticket 02 has run on a real project. Pixel-diff visual regression.
Non-web interfaces (Flutter, native).
