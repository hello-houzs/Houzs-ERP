# Houzs ERP Design System — usage for the design agent

This DS is the production component library of the Houzs ERP (manufacturing /
SCM web app). Theme C ("Ink & Petrol") — cool neutral canvas, petrol/teal CTAs,
brass brand accents. Pure Tailwind 3 utility classes. **No provider wrapper is
required** to use these components; render them directly inside any host page.

## Styling idiom

Compose **with Tailwind utility classes**, never inline `style={{}}` or
hand-written CSS. The full Tailwind 3 vocabulary is available, plus this DS's
**semantic palette** (defined in `_ds_bundle.css` — read it to confirm names):

### Surfaces & ink

| Use it for | Class |
|---|---|
| Page canvas | `bg-bg` |
| Card / panel | `bg-surface` |
| Nested / inset (table headers, search fields) | `bg-surface-2` |
| Dim surface (hover, secondary card) | `bg-surface-dim` |
| Default border | `border-border` (subtle: `border-border-subtle`, strong: `border-border-strong`) |
| Primary text | `text-ink` |
| Secondary text | `text-ink-secondary` |
| Muted / metadata text | `text-ink-muted` |

### Primary (functional accent — petrol/teal)

CTAs, selected rows, links, active tabs, focus rings. **This is the only
"emphasis" color the agent should reach for** when something needs to read
as the active / chosen state.

`bg-primary` `text-primary` `border-primary` `text-white` (on primary)
`bg-primary-soft` (selected-row tint) `text-primary-ink` (text on soft)

### Brass accent (brand-only — never a CTA)

Logo, doc numbers, eyebrow labels, soft brand-tinted backgrounds.
`text-accent` `bg-accent-soft` `text-accent-bright` (gold on dark)

### Semantic

`bg-synced` / `bg-synced-bg` (success), `bg-err` / `bg-err-bg` (error),
`bg-warning-bg` + `text-warning-text` (warning).

### Type

System sans is the default — `font-display` and `font-mono` both alias the
OS UI font. **Money cells get `font-money`** — IBM Plex Mono, tabular nums,
amounts line up by decimal across rows. Reach for it on any column or detail
field showing currency or quantities.

Eyebrow / numeric chips use `font-mono uppercase tracking-wider` (Plus Jakarta
fallback). Brand wordmarks use `tracking-brand`.

### Shape & elevation

`rounded-md` for most controls, `rounded-lg` for cards, `rounded-full` for
badges and pills. Two shadow tiers in use — `shadow-stone` (resting card),
`shadow-slab` (elevated / hover).

### Motion

`animate-rise` (page-load reveal), `animate-fade-in`.

## Composition pattern

Most pages follow this skeleton — `Layout` wraps the chrome, `PageHeader` sets
the title strip, `Panel` slabs hold content, `StatStrip` rows are the metric
slot above the fold:

```tsx
import { Layout, PageHeader, Panel, StatStrip, StatCard, Button, DataTable } from '<pkg>'

<Layout>
  <PageHeader title="Sales Orders" actions={<Button variant="primary">New SO</Button>} />
  <StatStrip>
    <StatCard label="Open" value="42" tone="default" />
    <StatCard label="Overdue" value="3" tone="warning" />
  </StatStrip>
  <Panel title="Recent">
    <DataTable rows={...} columns={...} />
  </Panel>
</Layout>
```

For amounts use `font-money` on the cell or wrap with `<span className="font-money">$1,234.56</span>`.
For status, prefer `<Badge tone="success|warning|err">…</Badge>` over a raw chip.

## Where the truth lives

- **Per-component API**: each `components/<group>/<Name>/<Name>.d.ts` is the
  contract — read the `<Name>Props` interface before guessing props.
- **Per-component usage**: each `<Name>.prompt.md` carries the JSDoc + intent.
- **Compiled styles**: `_ds_bundle.css` (component CSS) and `styles.css`
  (the @import closure) — grep these to verify any class name before using it.
