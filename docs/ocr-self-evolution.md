# OCR self-evolution — architecture (owner vision, 2026-06-24)

The SO OCR (`scan-so`) gets better the more it is used. Two engines, owner-specified:

1. **Per-salesperson personalization** — every salesperson writes differently, so the
   scanner adapts to each one's handwriting habits.
2. **Cross-salesperson sharing** — one salesperson's learnings benefit everyone, so the
   overall OCR standard keeps rising and a brand-new rep starts on the shoulders of the team.

## The three layers (injected AFTER the cached SYSTEM_PROMPT+catalog prefix)

| Layer | Content | Priority |
|---|---|---|
| **Personal (per salesperson)** | (a) rules AUTO-DISTILLED from this rep's confirmed corrections; (b) techniques the rep **manually UPLOADS** about their own quirks ("my K = King", "my 7 has a slash", "I write the SO ref top-right with an HC prefix") | **Highest** — a rep's own style wins ties when scanning their slip |
| **Global shared rules** | (a) common, non-rep-specific patterns DISTILLED across ALL reps' corrections; (b) techniques promoted from an individual to everyone | Baseline — injected for every rep, incl. brand-new ones |
| **Global alias dictionary** (already exists) | cross-rep shorthand / model-name aliases | Baseline |

Injection order in the prompt = **personal first, then global** ("以各自的个性、手法优先").

## Pipeline (each link must actually run — verify end to end)

`/extract` → insert `so_scan_samples` (raw) → operator reviews/corrects → `/samples/:id/confirm`
saves the corrected JSON (edit-gated: only when actually edited) → fire-and-forget distill
regenerates: (a) this rep's personal rules, (b) the global shared rules, (c) the global alias
dict → next `/extract` injects personal(manual + distilled) + global rules + global aliases.
Weekly Sunday cron `distillAllSalespersonRules` rebuilds them in bulk.

## Build status

- **OCR-polish wave (in flight)** builds: the GLOBAL shared-rules layer (cross-rep distill +
  store + inject for every rep), enriches the per-rep distiller (also learn customerSoRef /
  address-parts / quirks), and keeps personal-before-global ordering.
- **NEXT wave — active upload (the new ask):** let a salesperson MANUALLY upload their own
  OCR techniques (not only learn passively from corrections):
  - Storage: a manual-rules field per salesperson (extend `so_scan_rules`, or a small
    `so_scan_manual_rules` table) — combined with the auto-distilled rules into the personal layer.
  - UI: a per-rep "Teach the scanner your writing quirks" free-text editor (the rep's scan-rules
    page / profile; in-app save, no window.confirm). Owner can edit any rep's + **promote a tip
    to the global layer**.
  - Injection: manual rules + distilled rules = the personal layer, injected first; bounded token
    budget; fail-soft.

## Guardrails
Temperature 0; the cached SYSTEM_PROMPT+catalog prefix stays byte-stable (all rep/global rules
go AFTER the cache boundary); never-invent SKU/state; keep the deliberate rules (Houzs Century
from Branding, 3-method, One-Shot, forced-dropdown).
