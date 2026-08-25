# CraftMagic brand pack

The written half of the brand. The drawn half is `<Mark>` / `<Logo>` in
`apps/web/src/brand/Logo.tsx` and the SVGs beside this file; the colours are CSS custom
properties in `apps/web/src/styles.css`. Nothing here is a second source of truth — if a value
in this document disagrees with the code, the code is what ships and this document is stale.

## Logo & wordmark

The mark is an isometric block: one voxel drawn in three faces, with a spark of magic on the
top corner. Pair it with the Space Grotesk wordmark for the primary lockup, or use either
alone.

| Asset | Use |
|---|---|
| `<Logo>` | Primary lockup — mark plus wordmark. The default everywhere there is room. |
| `<Mark>` | Mark alone. Favicons, avatars, anywhere under the lockup minimum. |
| `mark.svg` | The mark as a file, for contexts outside the app (READMEs, uploads). |
| `mark-light.svg` | Same, darkened for light or printed backgrounds. |
| `mark-mono.svg` | Same, white, for single-ink contexts. |
| `favicon.svg` | The mark on its dark tile. Linked from `index.html`. |

**Clear space** — keep a margin of half the mark's height on all sides.

**Minimum size** — 24px for the mark, 120px for the full lockup. Below that, drop the wordmark
and use the mark alone. Below roughly 24px also drop the spark (`<Mark spark={false} />`): it
is four thin points and turns to mush.

**Colourways** are fixed, and `MarkVariant` names all of them:

| Variant | Top | Left | Right | Spark | Use |
|---|---|---|---|---|---|
| `brand` | `#6EE7B7` | `#2F8F6F` | `#227A5C` | `#BFF7E2` | The default, on the dark UI |
| `light` | `#3FBF90` | `#227A5C` | `#186247` | `#0F1216` | Light and printed backgrounds |
| `mono` | `#FFFFFF` | `#B8BDC4` | `#8B929B` | `#FFFFFF` | Single ink |
| `mint` | `#9DF3D0` | `#4BBF95` | `#2F8F6F` | `#D6FAEC` | Tinted single ink |
| `knockout` | `#0F1216` | `#0A3226` | `#072019` | `#0F1216` | Sitting inside a mint fill |

## Colour

A near-black canvas keeps the 3D forward; one mint carries every action. The deep teals come
straight from the mark's own faces. The signal trio is reserved for status — a build that
failed, a pending job — and never used for decoration.

| Token | Value | Name | Role |
|---|---|---|---|
| `--brand-void` | `#0B0E12` | Void | The landing canvas, darker than the app shell |
| `--bg` | `#0F1216` | Shell | The app background |
| `--panel` | `#171B21` | Panel | Raised surfaces |
| `--border` | `#262C35` | Border | Hairlines |
| `--muted` | `#8B949E` | Muted | Secondary text |
| `--text` | `#E6E9EE` | Ink | Body text |
| `--brand-mint` / `--accent` | `#6EE7B7` | Mint | **Primary.** CTAs, accents, active state |
| `--brand-grass` / `--ok` | `#4ADE80` | Grass | Success |
| `--brand-amber` / `--pending` | `#FBBF24` | Amber | Pending |
| `--brand-coral` / `--fail` | `#F87171` | Coral | Failure |
| `--brand-teal` | `#2F8F6F` | Teal | The mark's left face |
| `--brand-pine` | `#227A5C` | Pine | The mark's right face |
| `--brand-spark` | `#BFF7E2` | Spark | The mark's highlight |

`--accent`, `--ok`, `--pending` and `--fail` are aliases of the brand colours rather than
separate values: the role name is what UI code should ask for, and the alias is what stops the
two drifting apart.

## Type

Grotesk for voice, mono for the machine.

| Token | Family | Use |
|---|---|---|
| `--font-display` | Space Grotesk, 500/600/700 | Display and headings |
| — | `system-ui` | Body and UI. Fast, native, nothing to load |
| `--font-mono` | JetBrains Mono | Prompts, coordinates, counts, code |

Both webfonts are loaded from Google Fonts in `index.html` and both stacks fall back to a
system face, so a blocked or slow font never leaves text invisible.

## Voice

The tagline is **"Type it. Watch it build."** — an instruction and its result, in that order.
Product copy follows it: say what the thing does, then what you get. The one-line description
is "AI Minecraft builds — type it, watch it build."
