# Zen as a mode, and the Storybook theme: design

Spec: [spec.md](spec.md) (proposed). Precedent: [raven-view design](../2026-11-07-raven-view/design.md).

## Approach

### Part A: two axes instead of one list

Today one value, the device's view, carries both the skin and Zen. Part A splits it into two independent axes: the **theme** (the device's `Choice` resolved to a `View`, unchanged machinery) and the **mode** (Zen on or off). One pure function joins them into the **face**:

```text
face = mode === "zen" && route !== "settings" ? "zen" : resolve(themeChoice, contrast, serverDefault)
```

- `data-view` stays the face attribute, so every `[data-view="zen"]` rule in `style.css`, `zen.css`, and `layer.ts` (`enterConfirms`) is untouched. So is every `[data-view="raven"]` rule.
- `src/views.ts`:
  - `VIEWS = ["standard", "geek", "raven", "storybook"]`, `MODES = ["zen"]`, `type Face = View | "zen"`.
  - The build's lazy units are `[...VIEWS minus standard, ...MODES]`. `scripts/vite-themes.ts` writes `mode: true` on the mode's entry of `themes.json` and `sb-themes`.
  - The folder stays `gui/themes/zen/`. Renaming it would be churn: the per-folder cap and the dist layout already work.
- `gui/mode.ts` (new, entry, about 25 lines): `mountMode(prefs)` with `on()`, `enter()`, `leave()`, and `onChange`. It reads `sb.zen` and, while that is `null`, the legacy `sb.view === "zen"`. It writes only `sb.zen`, and it has no `storage` listener (spec O1).
- `gui/view.ts` loses `held`, `release`, `mountZenBack`, and `enterZen`. It keeps `choice`, `server`, `set`, `reread`, `onChange`, and `onServer`, and now speaks only of themes. `apply()` sets `data-view` to the face, which it takes from a `face()` getter that `pagecore` provides, and the theme-colour from `THEME[face]` (with the phase for storybook).
- `gui/viewface.ts` keeps one table, `faceAfter(move, …)`, whose moves are `enter` (the header button; it leaves the settings route), `leave` (Esc Esc, the corner, the palette, an exit), `pick` and `follow` (theme only; the mode is never touched), and `route` (settings suspends, leaving resumes). `tests/viewface.test.ts` walks every move from every start state: mode × route × theme.
- `gui/faces.ts`: `RULES: Record<Face, Rules>`, and `rulesOf(face)`.
- `gui/pagecore.ts`: `zenOn = () => mode.on() && current.view !== "settings"`, where it was `view === "zen" && !away`.
- The header: `#zen-enter` replaces `#zen-back` and is always present while the shell is shown. `mountZenEnter(button, enter)` replaces `mountZenBack`.

### Part B: a theme with a clock

Storybook is one more folder under `gui/themes/`, following Raven's shape. The one new mechanism is the **phase**:

- `gui/phase.ts` (entry, about 10 lines): `phaseAt(date) → "day" | "night"`, the single source. `boot.js` carries a copy, `phase(hours)`, checked against it by a parity test.
- `gui/themes/storybook/phase.ts` (chunk): `mountPhase({ now, setTimeout, clearTimeout, root, doc })` sets `data-phase` and arms a timer to the next boundary. It rechecks on visibility, `pageshow`, and a snapshot (throttled to 60 s) and calls the `onShift` listeners on a change. All of it is driven by a fake clock in tests.
- `ThemeParts` gains `onShift?(fn)` and `badge?: Badge | (() => Badge)`. `main.ts` registers `onShift` when the theme takes effect (`onTheme`). On a shift it calls `view.refresh()` (theme-colour) and redraws the tab icon with `badge()`.
- The ambience (`gui/themes/storybook/ambience.ts`) copies `raven/weather.ts`: clips loaded through `audio`, `out("background")`, and a gate made of the face, visibility, the Background switch, and the backdrop being on the page. At a shift it cross-fades two buffer sources.

## Interfaces and data flow

```text
load ─ boot.js: sb.zen|legacy → data-view=zen + Zen sheet
              │ else theme resolve → data-view=<theme>; storybook → data-phase, phase theme-color, sheet
main.ts ─ mountMode + mountView ─ face() ─ pagecore.sync ─ Zen layer | theme page
header #zen-enter ─ mode.enter() ─ face → zen ─ withZen(show) ─ idle: loadTheme(device theme) (O10)
Esc Esc / corner / exit ─ mode.leave() ─ face → theme ─ showTheme(theme)
storybook chunk ─ mountPhase ─ boundary/visibility ─ data-phase ─ onShift → theme-color, tab badge, ambience cross-fade
server ─ /boss gui view <theme> ─ gui-prefs.json ─ sb-view / hello / view event ─ theme only
```

## Palette (starting values, computed 2026-11-26; the test decides)

| Token | Day | Night |
|---|---|---|
| ground | `#fbf5e9` cream paper | `#111a35` night sky |
| panel | `#fffdf8` | `#18234a` |
| sunken | `#f3ead8` | `#0c1329` |
| text | `#3a3150` (≥ 10.1 : 1) | `#f4ecd8` (≥ 12.9 : 1) |
| dim | `#655c78` (≥ 5.2) | `#b8b3cf` (≥ 7.5) |
| waiting | `#8a5300` honey (≥ 5.3) | `#ffd37e` lamp (≥ 10.8) |
| error | `#a8323a` berry (≥ 5.5) | `#ff9a95` (≥ 7.5) |
| working | `#2f6e47` leaf (≥ 5.1) | `#93d9ab` (≥ 9.2) |
| idle | `#5f6573` (≥ 4.9) | `#a7adbd` (≥ 6.8) |
| accent | `#3d63a6` storybook blue (≥ 4.97) | `#9cc0ff` (≥ 8.3) |

The ratios are the minimum over ground, panel, and sunken. Fills that carry text (a waiting pill, a button) use the ground colour as their text, checked the same way. Wash tints (sky `#d8ecf7`, mint `#dff1e4`, peach `#fbe3d3`) are backgrounds only, and every text colour is checked on them too.

## Precedent

- The theme mechanism, `boot.js`, the per-folder caps, `iconRef`, and `soundOf` come from the raven-view spec §1.2 and §6.
- The legacy-key read comes from the sound-split spec (*Storage and migration*).
- Compositor-only status motion, the map layer model, and the trace method come from raven spec §1.5 and `tests/raven-motion.test.ts`.
- The weather loop, which the ambience copies: `gui/themes/raven/weather.ts`.
- Contrast sampled from the shipped pictures: `tests/raven-contrast.test.ts`.

## Trade-offs and rejected alternatives

| Choice | Rejected | Why |
|---|---|---|
| A separate mode axis, with `data-view` as the face | Keep `zen` in `VIEWS` and hide its button | The server could still default into Zen, `held` would stay, and leaving would still show Standard instead of the device's theme. |
| `sb.zen` plus a legacy read of `sb.view` | Rewrite `sb.view` from `zen` to `auto` once | A rollback to an older build would lose Zen, and the sound-split precedent never writes a legacy key. |
| No live cross-tab sync of the mode | A `storage` listener | A second tab would be pulled into or out of Zen under the boss (Z-D20). |
| The phase by local hours | Sunrise and sunset, or `prefers-color-scheme` | Sunrise needs a location. The OS scheme is not what the boss asked (「看現在時間」). |
| `data-phase` on `<html>`, set by `boot.js` | Set only by the theme chunk | That would paint a day frame at night until the chunk arrives. |
| One favicon | One per phase | Halves the work and the bytes; the badge already carries the phase. |
| Single-colour animal icons | Full-colour watercolour icons | State colours, forced colours, and 16 px legibility. |
| Keep `gui/themes/zen/` | Move it to `gui/modes/zen/` | Churn in the build plugin, the dist layout, caps, and tests, with no behaviour gained. |

## Risks

- **The first light theme.** Literal dark-assuming colours in Standard's CSS will show up on cream paper. Phase B-1 starts with the audit, and the screenshots of every page in the day phase are the check.
- **Phase parity.** `boot.js`'s copy of `phaseAt` can drift; the 24-hour parity test guards it.
- **Mode migration.** Pages of an older build open on the same browser keep reading `sb.view = zen` as Zen, which is the intent. A device that never leaves Zen on the new build keeps the legacy value for ever, which is harmless.
- **Budgets.** The two backdrops and the ambience are incompressible. If the 450 KB cap is tight, the nooks (O7) go first.
