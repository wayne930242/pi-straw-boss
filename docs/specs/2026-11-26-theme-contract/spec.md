Status: approved (2026-11-26). Nothing here is built yet. The boss approved the direction and decided Q1, Q4, and Q7 (§12, *Decided*); the other questions take their recommendation.

Related: [2026-11-07-raven-view/spec.md](../2026-11-07-raven-view/spec.md) (the theme mechanism), [2026-11-26-storybook-theme/spec.md](../2026-11-26-storybook-theme/spec.md) (the first light theme, whose §B10 makes "a versioned markup contract" the condition for ever splitting themes out), [2026-11-01-zen-view.md](../2026-11-01-zen-view.md).

# Theme contract for the sb GUI: spec

## 0. Summary

1. A theme restyles the page through a declared surface: **tokens** (custom properties), **slots** (empty decoration elements Standard renders), and **hooks** (data attributes Standard guarantees, and a data-only manifest per theme). It no longer overrides Standard's literal colours or borrows its pseudo-elements.
2. **Precedence** comes from cascade layers: `@layer standard, theme;`. A theme rule beats Standard's rule whatever their specificity. Standard's `!important` stop rules (calm, reduced motion, `[hidden]`, stale pause) still beat every theme.
3. **Tokens**: Standard's 57 stay, plus `--tint` (the overlay colour that replaces raw `--hi` mixes), `--glow` (a 0 to 1 factor on every glow), `--scrim`, `--err-text`, and `--ansi-0` to `--ansi-15`. Of the 39 hex literals outside `:root`, 33 become tokens and 6 stay, each with a reason.
4. **Slots**: `backdrop` (8 fixed layers behind the page), `stage`, `head`, `map`, `hud`, `chat-edge`, `chat-corner`, `composer-edge`, and a short list of pseudo-elements Standard promises never to use.
5. **Hooks**: a `theme.json` manifest per theme (theme-color, phases, badge, senders, ambience loudness) that `boot.js`, `view.ts`, the tab icon, and the sound code all read, so these facts have one source. `data-vary` (0 to 7, from the item's key) gives a stable per-item variation.
6. **Versioning**: `gui/themes/contract.json` lists every name, at contract version 1. Removing or renaming a listed name is breaking. `tests/theme-contract.test.ts` pins the v1 names and checks each theme against them.
7. **Budgets**: each theme folder gets a round ceiling chosen by a person, plus a recorded figure (written by a script) with a tolerance of 1 % or 2 KB. Hash noise falls inside the tolerance, and the history moves out of test comments. Gzip is checked only for CSS and JS.
8. **Migration**: seven phases. After each, Standard is identical, checked by a computed-style snapshot of every element and pseudo-element on five routes at two widths, plus a pixel diff.
9. Raven sits at 99 % of its 450 KB folder cap. Picture themes get a 512,000-byte ceiling (the boss's pick, Q4).
10. Twelve open questions are in §12, each with a recommendation.

## 1. Reality anchor (read from 4c018131, 0.100.1)

- **Theme loading.** One entry module per theme, `gui/themes/<view>/index.ts`, reached only through `import()` (`gui/themes/registry.ts:14`). A loaded theme stays loaded (`registry.ts:17-24`). `showTheme` hands the parts on to nouns, sentences, sounds, and icons (`registry.ts:31-41`).
- **ThemeParts today** (`gui/themes/theme.ts:8-24`): `sprite`, `senders`, `nouns`, `sentences`, `sounds`, `badge` (a value or a function of the phase), `onShift`, `recheck`. All are optional.
- **First frame.** `boot.js` resolves the face, sets `data-view` on `<html>` (`gui/boot.js:51`), and sets `data-phase` for Storybook only (`boot.js:53`). It paints theme-colours from its own table (`boot.js:38`) and writes the theme's `<link>` after the entry's stylesheet (`boot.js:70`; order in `dist/gui/index.html:19-21`). `gui/view.ts:19` holds a second copy of the same theme-colour table. The server can write the link itself at `<!--sb-theme-->` (`src/guithemes.ts:25`).
- **Stylesheets.** `gui/style.css` (1,542 lines; tokens in `:root`, lines 3-47) is imported by `main.ts:1`. `gui/pbs.css` arrives later with the block chunk (`gui/blockschunk.ts:2`). Each theme imports its own sheet (`geek/index.ts:2`, `raven/index.ts:4`, `storybook/index.ts:4`, `zen/index.ts:2`). No file uses `@layer`. A theme beats Standard only by specificity or by coming later in the document.
- **CSP**: `style-src 'self' 'unsafe-inline'`, `script-src 'self'`, `img-src 'self' data:` (`src/gui.ts:58`).
- **Build target**: Vite 8.3.4 defaults to `chrome111, edge111, firefox114, safari16.4, ios16.4` (`node_modules/vite/dist/node/chunks/node.js:720-726`), and its CSS minifier is Lightning CSS (`node_modules/vite/dist/node/index.d.ts:2863`). The page already depends on `popover` (`gui/index.html:64`), `color-mix()`, and `:has()`.
- **Existing precedent for a slot**: the two `<i class="perch" aria-hidden="true">` in `#stage` and `.head-node` (`index.html:102`, `:107`). Standard hides them (`style.css:1302`), and Raven draws its perched raven in them.
- **Tests that read CSS** go through `tests/css-rules.ts`. Its `rulesOf` walks `@media`, `@supports`, and `@layer` blocks (`css-rules.ts:36-38`).
- **Size budgets**: `tests/imports.test.ts` (1,887 lines; "measured" appears 778 times; its longest line, 390, is 2,327 characters). Theme folders are capped at `imports.test.ts:1803-1870`, with the caps at `:1860` (Raven `[449_283, 337_652]` against the asserted 450,000 at `:1866`). The eager page is capped at `:1370`, the chat chunks at `:1624`, the stylesheet at `:1793`. `tests/raven-rooms.test.ts:39` caps Raven's source folder a second time (490,107).

## 2. The frictions, checked against the code

| # | Friction | Evidence at 4c018131 | What the contract changes |
|---|---|---|---|
| F1 | Hard-coded colours | `#i-brand` paints 5 × `#7dcfff` and 1 × `#bb9af7` (`index.html:21`), so Storybook ships its own `storybook-brand`. `style.css` has 39 hex literals outside `:root` (§4.3). Two of them (`#f7768e`, `:1108`, `:1125`) are Standard's error red, which Geek and Raven never recolour. | §4: every colour Standard paints is a token, except six listed exemptions. A test forbids new literals. |
| F2 | Dark-ground assumptions | 17 `var(--hi)` mixes on 12 lines (`style.css:80, 81, 93, 110, 330, 337, 343, 709, 736, 754, 757, 913`); glows on 20 lines (§4.2); `.sheet::backdrop` at 60 % shadow (`:164`). Storybook undoes them one by one (`storybook.css:170, 175, 185-192`) and sets `--hi` to plum (`storybook.css:22`). | `--tint`, `--glow`, `--scrim`, and `--err-text` (§4.2). A light theme sets four tokens instead of writing overrides. |
| F3 | Specificity fights | Theme rules carry `html[data-view="…"]` plus Standard's own selector to outrank it. Standard's motion selectors run up to 0,3,0 (`style.css:325-326`). The `:is(body, #stage)` list the brief describes is no longer in the tree (`git log -S` finds neither it nor its fix on main). The mechanism holds, though: `:is()` takes its most specific argument's weight, so `#stage` gave the body rule id weight. | §3: layers. Order between Standard and a theme no longer depends on specificity or on load order. |
| F4 | No decoration slots | Storybook stacks its ambient layers on `html`, `body`, `#stage`, and `#work` pseudo-elements (`storybook.css:321-370`): fireflies two to a layer (`:368`), butterfly wings as a second layer (`:352`). Raven does the same on `body`, `.work`, and `.map`. Washi tape uses `.base::after`, `.dialog::after`, `.head-node::after` (`:156`), the chat's tape and holes `.chat-root::before/::after` (`:210-211`), the bee `.composer::before/::after` (`:240-241`). The tape fix that moved it off the chat's first row is ca9f491d on main (the brief's 53009b3b is on `feat/storybook-chat`). | §5: named slots, with rules on layout, stacking, and pointer events. |
| F5 | Data themes cannot reach | Sender: `chat.ts:110` sets `data-sender` in every view, and `icons.ts:20-21` draws it only for a theme that declares `senders`. That hook already exists. Per-item tilt: only `data-key` exists (`render.ts:114`), which CSS cannot hash, so Storybook alternates tape by `nth-child(3n + 2)` (`storybook.css:157`), and the tape moves when a base is added. | §6.3: `data-vary`. The attribute list is frozen in the contract. |
| F6 | Layout side effects | `.tx { content-visibility: auto }` (`style.css:687`) clips paint outside an entry, so Storybook gave the stamp room with `min-height` (`storybook.css:225`). `.comms-in` is `position: fixed` on a phone (`style.css:949`), and `.target-veil` (`:1528`) is a fixed descendant, so a `container-type` there would capture it. Storybook put its container on `.chat-root` (`storybook.css:205`). `.hud` has `backdrop-filter` (`style.css:72`) and is already a containing block. | §6.4: Standard lists its containment facts and the elements a theme must not make into containing blocks. |
| F7 | Shared facts guessed per theme | Theme-colours live in `boot.js:38` and `view.ts:19`. Standard's colour is kept in `data-standard` (`boot.js:58`, RV-F002). Badges are in `tabicon.ts:7`, `raven/index.ts`, `storybook/index.ts:14`. Loudness: Raven's rain is `gain 0.045` (−26.9 dB) on a −15 dBFS clip, so it lands near −42 dBFS (`raven/weather.ts:13-14`). Storybook's first build compared gains rather than loudness. It now targets the same −42 dBFS (`storybook/ambience.ts:9-10`; fixed in 44fc7778, the brief's 744af5f0 on `feat/storybook-chat`). | §6.1: one manifest per theme. Loudness is declared as the clip's measured mean, and the page derives the gain from one target. |
| F8 | Size budgets | §1, last bullet. Every merge rewrites exact figures, and gzip moves by 1 to 10 bytes when hashed chunk names change (`imports.test.ts:1328`, `:1589`). | §8. |
| F9 | Repaint cost | `--sb-frame` and `--sb-grain` are SVG data URIs, the grain an `feTurbulence` filter (`storybook.css:48-50`). They are used as `border-image` and background on cards and the header (`:147-148`). Each repaint of such an element re-runs the SVG's paint: with the demo ticking, Storybook made 312 paints and 1,174 pre-paints in 10 s, against Standard's 286 and 117 (`scratch/storybook-b4/notes.md:23-28`). | §9: a paint rule for surfaces, and a trace anchor per theme. |

## 3. Precedence: cascade layers

### 3.1 The rule

- Every stylesheet of the page starts with the same statement, `@layer standard, theme;`. Standard's sheets (`style.css`, `pbs.css`) wrap their rules in `@layer standard { … }`. Every theme sheet (`geek.css`, `raven.css`, `storybook.css`, and `zen.css`, since the mode is built as a theme) wraps its rules in `@layer theme { … }`.
- The first statement the browser parses fixes the order. Because every file carries the same statement, the order holds whichever file comes first. Today, `boot.js` links the theme after the entry's sheet, a registry `import()` appends a theme's sheet later still, and `pbs.css` arrives last of all, with the block chunk, so today it wins ties against the theme. Inside layers, `pbs.css` stays under every theme.
- **Normal declarations**: theme beats Standard, whatever the specificity. Within one layer, specificity and order work as before. A theme still has to win against its own rules.
- **Important declarations** reverse the layer order: Standard's `!important` beats a theme's `!important`. Standard has ten, all of them stop rules: stale pause (`style.css:299`), calm (`:525-532`), `[hidden]` (`:533`), the paused page (`:834`), reduced motion (`:1035`), the folded head (`:1412`). The contract states this as intended: a theme cannot restart what calm, reduced motion, or staleness stopped, or show what `[hidden]` hides. A theme's own `!important` rules (Geek's stops and borders, `geek.css:5-75`; Raven's square corners, `raven.css:388-404`; Storybook's forced-colours and reduced-motion stops, `storybook.css:267`, `:401`) still beat every normal Standard declaration, as they do now.
- Inline `style` attributes and the custom properties scripts set (`--col`, `--pw`, `--hud`, …) stay above both layers. This does not change.
- **Scoping stays.** A loaded theme stays loaded (`registry.ts:17-24`), so every theme rule keeps its `[data-view="<view>"]` prefix. New theme rules write the prefix as `:where(html[data-view="<view>"])`, which adds no specificity, so a theme's rules rank among themselves by their own selectors (Q8).

### 3.2 Support and constraints

- `@layer` is in Chrome and Edge 99, Firefox 97, and Safari 15.4. All are below the build's target (§1) and below what `popover` already requires. No fallback is needed.
- CSP: layers are CSS syntax only, and `style-src` does not change.
- Lightning CSS keeps `@layer` for these targets. Phase 1 checks this on the built files, not by assumption (§10).
- Each sheet wraps its statement and its layer block in `@media all { … }`. Without it Lightning CSS folds the statement into `@layer standard;@layer theme{…}` (the same order, but no literal statement for contract test item 7). The minifier drops the `@media all` itself. Keep the wrapper when editing a sheet.
- `tests/css-rules.ts` has to learn the statement form. `@layer standard, theme;` has no block, so today the reader would read `@layer standard, theme;\n:root` as one prelude, walk the `:root` block as a layer, find no rules inside it, and drop `:root` (`css-rules.ts:36-38`). Every test that reads the token block would then fail. Phase 1 splits top-level statements at `;` before it looks for a block.

## 4. Tokens

### 4.1 The v1 list

Every theme sets every **required** token, in each of its phases. Themes already do: Geek and Raven set 56 of the 57, Storybook 55, and `zen.css` 53. Optional tokens fall back to Standard's values. A theme may add private tokens only under its own prefix (`--rk-`, `--sb-`, `--zen-`, `--gk-`).

| Role | Tokens | Status |
|---|---|---|
| Ground and surfaces | `--bg`, `--bg-2`, `--surface-0`, `--surface-1`, `--raised`, `--sunken`, `--well`, `--panel`, `--plate`, `--plate-hi` | required |
| Ambient ground | `--aura-1`, `--aura-2`, `--grid` | optional |
| Lines | `--line-c` (opaque), `--line` (translucent) | required |
| Text | `--text`, `--dim`, `--ink` (text on a filled control) | required |
| Overlay tint | **`--tint`** (new): the colour Standard mixes at 2 to 8 % into a surface to raise it; Standard `#ffffff`. `--hi` stays one contract version as an alias (`--tint: var(--hi)` in `:root`, so a theme that sets `--hi` still works) | required (as `--tint` or `--hi`) |
| Accent | `--accent`, `--accent-hi` | required |
| States | `--working`, `--amber` (waiting), `--violet` (commanding), `--idle`, `--ok` (done), `--err` (error), `--err-soft`, `--unknown`, `--gold` (attention) | required |
| State text | **`--err-text`** (new): error text on a switch; Standard `color-mix(in srgb, var(--err-soft) 45%, var(--tint))`, today's literal mix at `style.css:93` | optional |
| Elevation | `--shadow` (the colour of drop shadows) | required |
| Glow | **`--glow`** (new): a unitless factor, 0 to 1, on the blur and spread of every glow (§4.2); Standard 1, a light theme 0 | optional |
| Scrim | **`--scrim`** (new): the backdrop behind a modal sheet or drawer; Standard `color-mix(in srgb, var(--shadow) 60%, transparent)` (`style.css:164`, `:905`) | optional |
| Paper (documents) | `--paper-hi`, `--paper`, `--paper-ink`, `--paper-edge` | required |
| Terminal | `--term-bg`, `--term-fg`; **`--ansi-0` … `--ansi-15`** (new, §4.3) | `--term-*` required, `--ansi-*` optional |
| Fonts | `--sans`, `--mono` | optional |
| pi-better-show | the 18 `--pbs-*` tokens of `style.css:44-46` | as the raven spec §7 says |

State colours are read through `--c`, `--c1`, and `--c4` on `[data-mark]` elements (`style.css:61-68`). Those three are hooks the contract lists, not tokens a theme sets.

Not tokens: theme-colour, the tab badge, and sound levels. `boot.js` needs them before any stylesheet exists, and the audio code needs them as numbers, so they live in the manifest (§6.1).

### 4.2 Replacing the dark-ground mixes and glows

- **`--tint`.** The 17 `color-mix(in srgb, var(--hi) N%, transparent)` uses at the lines in F2 become `var(--tint)`, with their percentages unchanged. Standard renders identically. Storybook already sets `--hi` to its plum ink (`storybook.css:22`) and keeps that value as `--tint`. Its override `:is(.stats, .stats div, .tally div, .alerts) { background: none }` (`storybook.css:175`) becomes a choice it may keep, not a fix it needs.
- **`--glow`.** A glow is a shadow with offset `0 0`, a blur above 0, and a colour other than `--shadow`. At 4c018131 they sit on 20 lines: `style.css:75, 91, 93, 250, 319, 463, 501, 505, 514, 515, 531, 532, 603, 844, 846, 847, 848` (the last three are keyframe stops), `851, 1417, 1496`. Each blur and spread becomes `calc(<length> * var(--glow))`. With `--glow: 1` the computed value is the same length. With `0`, a `0 0 0 0` shadow paints nothing. Rings (`0 0 0 Npx`, a focus or selection outline) and elevation shadows in `--shadow` are not glows and do not change. Storybook's four glow overrides (`storybook.css:170, 187-189`) are then replaced by `--glow: 0`.
- **`--scrim`**: `.sheet::backdrop` and `.drawer-veil` read it. Storybook's `:191` override becomes a token.
- **`--err-text`**: `.tog[data-state="error"]` reads it. Storybook's `:186` override becomes a token.

### 4.3 Every literal colour in `gui/style.css` outside `:root`

The count: `grep -noE '#[0-9a-fA-F]{3,8}\b' gui/style.css` gives 71 hits. 31 are in `:root`. Of the 40 after it, one is `#125`, a todo number in a comment (`:376`). That leaves 39 hex literals (36 six-digit, `#fff`, and `#000` twice) and one `rgba()`.

| # | Line | Literal | Where | Decision |
|---|---|---|---|---|
| 1 | 98 | `#14110e` | Zen's first frame, background | **Keep.** It paints before `zen.css` loads and equals `--zen-ground` (`zen.css:4`). The contract test checks that equality. Today `tests/zen-contrast.test.ts:59` checks only the hue. |
| 2 | 98 | `#ebe3d3` | Zen's first frame, text | **Keep**, equal to `--zen-paper` (`zen.css:5`). |
| 3 | 99 | `#857a6b` | Zen's first-frame ring | **Keep**, equal to `--zen-line` (`zen.css:5`). |
| 4 | 99 | `rgba(150, 136, 116, 0.14)` | the ring's wash | **Keep**, the same wash as `zen.css:38`. |
| 5-6 | 662 | `#000` ×2 | `mask: linear-gradient(#000 0 0)` of the composer's ring | **Keep.** A mask reads only alpha, so the colour has no visual role. |
| 7 | 869 | `#fff` | `.doc-frame` background, the canvas behind an HTML document in a sandboxed iframe | **Keep.** A document with no background expects the browser's white canvas, in any theme. |
| 8-15 | 894 | `.c0` `#414868`, `.c1` `#f7768e`, `.c2` `#9ece6a`, `.c3` `#e0af68`, `.c4` `#7aa2f7`, `.c5` `#bb9af7`, `.c6` `#7dcfff`, `.c7` `#a9b1d6` | terminal foreground, ANSI 0 to 7 | → `var(--ansi-0)` … `var(--ansi-7)`, with these values in `:root` |
| 16-23 | 895 | `.c8` `#545c7e`, `.c9` `#ff899d`, `.c10` `#9fe044`, `.c11` `#faba4a`, `.c12` `#8db0ff`, `.c13` `#c7a9ff`, `.c14` `#a4daff`, `.c15` `#c0caf5` | ANSI 8 to 15 | → `--ansi-8` … `--ansi-15` |
| 24-30 | 896 | `.k1` to `.k6` (the values of `.c1` to `.c6`), `.k7, .kz` `#a9b1d6` | terminal background, ANSI 1 to 7 | → the same tokens |
| 31-38 | 897 | `.k8` to `.k15` (the values of `.c8` to `.c15`) | ANSI 8 to 15 | → the same tokens |
| 39 | 1108 | `#f7768e` | `.link-alert[data-level="error"]` wash | → `var(--err)`. Standard is identical, and Geek and Raven get their own red. Storybook's override `storybook.css:190` goes. |
| 40 | 1125 | `#f7768e` | `.link-team[data-status="stopped"]` wash | → `var(--err)`, as row 39 |

The terminal stays a dark well in every theme (`storybook.css:263`). The `--ansi-*` tokens are for the mode and themes that retint single colours: Zen overrides `.c3`, `.c11`, `.k3`, and `.k11` by class today (`zen.css:234-235`) and would set `--ansi-3` and `--ansi-11` instead.

**Colour literals outside `style.css`** that the contract covers:

| Where | Literal | Decision |
|---|---|---|
| `index.html:21` `#i-brand` | `#7dcfff` ×5, `#bb9af7` | → `currentColor` (`.logo` is `color: var(--accent)`, `style.css:74`) and `style="fill: var(--violet)"` on the middle dot. Custom properties inherit into a `<use>` shadow tree, and inline styles are allowed by `style-src 'unsafe-inline'`. A theme may still ship `<view>-brand`. |
| `index.html:11` theme-color | `#1a1b26` | **Keep**: it is Standard's colour as the server writes it, and `boot.js` keeps it in `data-standard`. Standard's manifest names the same value, and a test checks the two agree. |
| `boot.js:38`, `view.ts:19` | theme-colours | → read from the manifests (§6.1) |
| `tabicon.ts:7`, `raven/index.ts` badge, `storybook/index.ts:14` | badge colours | → manifests |
| `qr.ts:13-14` | `#fff`, `#06101e` | **Keep**: a QR code needs dark modules on a light quiet zone to scan, in every theme. |
| `demo-*.ts`, `fixture.ts` | demo data | out of scope |

A contract test forbids any colour literal in `style.css` outside `:root` except rows 1 to 7, so F1 cannot creep back in.

## 5. Slots

### 5.1 The slots

A slot is an empty element Standard renders, with `class="deco" data-slot="<name>" aria-hidden="true"`. It holds no text and no focusable content.

| Slot | Place | Count | Replaces |
|---|---|---|---|
| `backdrop` | first child of `<body>`, before `.shell` (`index.html:49`), so it is outside the inert shell and behind the page | 1 element with 8 `<i>` children (each child's `::before` and `::after` are the theme's as well: 24 layers) | Storybook's layers on `html`, `body`, `#stage`, and `#work` pseudo-elements (`storybook.css:321-370`), and Raven's on `body`, `.work`, and `.map` |
| `stage` | first children of `#stage`, where the perches are (`index.html:102`) | 2 | the `.perch` pair; `.perch` stays as a second class for one contract version |
| `head` | inside `.head-node` (`index.html:107`) | 2 | the head-node perch pair |
| `map` | first child of `#map`, before `.links` (`index.html:104-105`), so it scrolls with the map | 1 | Raven's `.map::before` layers |
| `hud` | first child of `.hud` (`index.html:50`) | 1 | none yet: header ornaments without borrowing `.hud`'s pseudo-elements |
| `chat-edge` | in `.chat-root`, before the scroller (`chat.ts:131-132`) | 1 | `.chat-root::before` (binding holes) and `::after` (tape), `storybook.css:210-211` |
| `chat-corner` | in `.chat-root`, after the scroller, outside the log's `content-visibility` | 1 | the nook painted as `.chat-scroll`'s background (`storybook.css:212`) |
| `composer-edge` | first child of `.composer` (`composer.ts:163`) | 1 | the bee and its glow, `.composer::before/::after` (`storybook.css:240-241`) |

Standard's sheet hides every slot and makes it inert to the pointer:
`[data-slot] { display: none; pointer-events: none !important; }`. Because the `!important` sits in the `standard` layer, no theme can make a slot catch a click.

### 5.2 Rules a theme follows

- **No layout impact.** A theme that shows a slot positions it `absolute` or `fixed`. A slot never takes part in flow, grid, or flex sizing. The contract test checks that every theme rule which gives a slot a `display` value also gives it `position: absolute` or `fixed`.
- **Never above a control.** `backdrop` uses `z-index: -1` in the root stacking context. Every other slot stays at `z-index` 1 or lower inside its parent, and its paint avoids the parent's controls: the `chat-edge` tape sits above the page's top edge, not over the first row, as ca9f491d fixed by hand. The phase screenshots check this (§10.1).
- **Compositor-friendly.** A slot that animates changes only `transform` and `opacity` (the raven §1.5 and storybook §B6 rules), and it may set `contain: strict`. Until Raven's head scene is redesigned, its existing window lights and lightning may animate `--rk-a`, `--rk-b`, and `--rk-bolt`, and its fog, bats, and wing strip may animate `background-position`.
- **Forced colours and calm.** Under `forced-colors: active` a slot draws nothing. Calm and reduced motion still the slot through Standard's `!important` stops. Raven keeps the lightning and perched bird moving under calm on a fine pointer only; reduced motion still stops both.

### 5.3 Reserved pseudo-elements

Some decorations belong to one item, and a slot per item would add DOM nodes to every card. For those, Standard promises never to use these pseudo-elements, which it does not use today (checked with a comment-free grep of `style.css`): `.base::after`, `.dialog::after`, `.head-node::after`, `.chat-list::after` (the nook after the last message on a narrow chat, which has to stay before the end sentinel `chat.ts` reads), and `.comms-head::after`. The contract test checks that `style.css` sets no `content` on them. Every other pseudo-element of a Standard element stays outside the contract: a theme may still style it, but a Standard change to it is not breaking.

## 6. Hooks

### 6.1 The manifest: `gui/themes/<view>/theme.json` (data only)

```json
{
  "contract": 1,
  "color": { "day": "#fbf5e9", "night": "#111a35" },
  "phases": "day-night",
  "badge": { "day": { "dot": "#e0902b", "ring": "#fbf5e9", "text": "#3a3150" }, "night": { "dot": "#ffd37e", "ring": "#111a35", "text": "#111a35" } },
  "senders": true,
  "ambience": { "day": { "file": "sounds/place-forest-birds-singing.mp3", "meanDbfs": -20.9 }, "night": { "file": "sounds/night-cricket-meadow.mp3", "meanDbfs": -17.9 } },
  "sounds": { "waiting": "sounds/kalimba-thumb-pluck.mp3" }
}
```

- `color`: the theme-colour, a string or one per phase. `scripts/vite-themes.ts` already writes the theme map into `<meta name="sb-themes">` (`vite-themes.ts:118`). It merges each manifest into that map, so `boot.js` reads `themes[view].color` instead of its own table (`boot.js:38`), and `view.ts` reads the same map instead of `THEME` (`view.ts:19`). Standard's manifest names `#1a1b26` and its badge (`tabicon.ts:7`).
- `phases: "day-night"`: `boot.js` sets `data-phase` for any theme that declares it, not only for Storybook (`boot.js:53`). The registry mounts Standard's phase clock (`gui/phase.ts`) for that theme and tells the page at a boundary to repaint the theme-colour and badge and to cross-fade the ambience. `ThemeParts.onShift` and `recheck` go: today `storybook/phase.ts` mounts the same clock by hand.
- `badge`: replaces `ThemeParts.badge`, as a value or one per phase.
- `senders`: replaces `ThemeParts.senders` (`icons.ts:20-21`, `registry.ts:38`).
- `ambience`: a looped background clip per phase (or `"loop"` for one) with its **measured mean in dBFS**, measured by `ffmpeg -af volumedetect`. Standard's loop player (today `storybook/ambience.ts`, moved to `gui/ambience.ts`) sets the gain to `10 ** ((AMBIENCE_DBFS - meanDbfs) / 20)`, with the one constant `AMBIENCE_DBFS = -42`. The reference is Raven's rain: `10 ** ((-42 + 15) / 20) = 0.0447`, its `RAIN.gain` 0.045 (`weather.ts:14`). Storybook's 0.089 and 0.063 (`ambience.ts:10`) come out of the same formula (0.0881, 0.0624). A test checks every declared loop against the formula within 0.5 dB. This is the fact F7 got wrong: gains do not carry from one clip to another, loudness does.
- `sounds`: the effects clips by kind (today `ThemeParts.sounds`). No loudness rule yet (Q6).
- File paths are relative to the theme's folder, and the build rewrites them to hashed names as it already does for stylesheets (`vite-themes.ts:105-110`).

### 6.2 `ThemeParts` v1 (code, built-in themes only)

```ts
/** Contract 1 (gui/themes/contract.json). What a built-in theme's entry may export besides its stylesheet; every data fact is in theme.json. */
export interface ThemeParts {
	/** The icon sprite's symbols, ids `<view>-<role>` (`<view>-brand` for the logo). */
	sprite?: string;
	/** Role nouns and sentences by locale. */
	nouns?: NounPack;
	sentences?: SentencePack;
	/** Built-in only: code that runs while the face is shown (Raven's weather). Started on show, stopped on leave. */
	mount?(env: { audio: Audio; phase(): Phase | undefined }): { stop(): void };
}
```

- Removed and moved to the manifest: `senders`, `badge`, `sounds`, `onShift`, `recheck`.
- `mount` replaces today's module side effects (`raven/index.ts` calls `mountWeather` at import, `storybook/index.ts` mounts the clock and ambience at import), so a theme's code starts and stops with its face instead of with its module.
- An external theme (not in v1, §11) would be the manifest, the stylesheet, pictures, sounds, a sprite file, and noun or sentence JSON, with no `mount`. Raven's thunder timing is the one part today that needs code.

### 6.3 Data attributes Standard guarantees

The v1 list holds every attribute the shipped theme sheets select (counted from `geek.css`, `raven.css`, and `storybook.css` with comments and `url()` stripped), each with its writer and values:

| Attribute | On | Writer | Values |
|---|---|---|---|
| `data-view` | `<html>`; `#stage` (the route) | `boot.js:51`, `view.ts:66`; `main.ts:181` | a face; `map`, `head`, `workspace`, `session`, `settings` |
| `data-phase` | `<html>` | `boot.js:53`, the phase clock | `day`, `night` (themes with `phases`) |
| `data-calm` | `<html>` | `calm.ts:19-24` | present or absent |
| `data-stale` | `<body>`, `#stage` | `main.ts:239` | `true`, `false` |
| `data-mark` | units, towers, plates, tallies, legend | `render.ts` and 6 more | `working`, `commanding`, `waiting`, `idle`, `done`, `error`, `unknown` (`style.css:61-67`) |
| `data-activity`, `data-kind` | `.composer` | `composer.ts:238` | a mark; a kind |
| `data-sender` | a notice's `<use>` | `chat.ts:110` | a kind or role icon id |
| `data-role` | `#session-view` | `session.ts` | a role |
| `data-state` | `.tog`, `.link`, `.connect`, board rows | 18 files | as each writer documents |
| `data-key` | keyed items | `render.ts:114`, `drawer.ts:78` | the item's id |
| **`data-vary`** (new) | every keyed item of `render.ts`'s list and every `.tx` | `render.ts` (one place, at `make`) | `0` to `7`, FNV-1a of `data-key` mod 8: stable for an item's life, independent of its position |
| `data-train-wait`, `data-status`, `data-level`, `data-under`, `data-supply`, `data-on`, `data-news`, `data-head`, `data-focus`, `data-docs`, `data-current`, `data-box` | as written today | their writers | as written today |
| `aria-selected`, `aria-pressed`, `aria-checked`, `aria-current`, `open`, `hidden` | controls | — | the ARIA and HTML values |

Storybook's tape then alternates by `data-vary` instead of `nth-child` (`storybook.css:157`), so adding a base no longer moves the tape on the others.

### 6.4 Containment facts

Standard documents the layout facts a theme has to know, and the contract lists them (they are facts, not promises; changing one is breaking):

- `.tx` has `content-visibility: auto` (`style.css:687`): paint outside an entry's box is clipped. Decorations on a chat entry stay inside it.
- `.dossier:not(.full)` has `content-visibility: hidden` (`style.css:948`).
- `.head-node` is an inline-size container (`style.css:1293`), and `.hud` is a containing block for fixed descendants (its `backdrop-filter`, `style.css:72`).
- Fixed elements a theme must not trap. A theme sets no `transform`, `filter`, `backdrop-filter`, `contain`, `container-type`, `will-change: transform`, or `perspective` on any ancestor of these: `.comms-in` and `.dossier.full` on a phone (`style.css:949`), `.target-veil` (`:1528`, inside the composer), `.drawer` and `.drawer-veil` (`:903`, `:905`), `.dock` (`:778`), `.minimap` (`:481`), `.connect` (`:283`). Popovers and dialogs in the top layer are not affected. The contract test checks theme rules on the listed ancestors (`body`, `.shell`, `.stage`, `#work`, `#session-view`, `.comms-in`, `.composer-root`) for those properties.

## 7. Versioning and the contract test

- **`gui/themes/contract.json`**: `{ "version": 1, "tokens": { "required": […], "optional": […], "deprecated": { "--hi": "--tint" } }, "slots": […], "reservedPseudo": […], "attributes": { name: [values] }, "classes": […], "ids": ["stage", "work", "session-view"], "manifest": […], "parts": […], "containment": […] }`.
- **`classes`** holds the Standard class names a theme may select. In v1 that is the 194 names the three shipped theme sheets select today (§1 count; all but `.perch-turn`, `.target-chev`, and `.tstate` also appear in `style.css`, and those three are set in markup). A theme that wants to reach another class adds it here in the same change, which makes every new reach visible in review.
- **Breaking** (the version goes to 2): removing or renaming any listed name; changing a token's role (what it paints); moving a slot to another parent or stacking context; dropping or renaming a listed attribute value; dropping a manifest or `ThemeParts` key; changing a containment fact. **Not breaking**: adding a name. Contract 1 grows by addition only, with no minor number (Q9).
- **`tests/theme-contract.test.ts`** (new):
  1. The v1 names, frozen in the test file, are a subset of `contract.json`. Removing one fails until the same change bumps `version` and replaces the frozen list.
  2. `style.css`'s `:root` defines every token, and every theme block (each phase included) sets every required token.
  3. Every slot exists where §5.1 says, with `aria-hidden="true"` and no children other than the `<i>` of `backdrop`. Standard's sheet hides it. Every theme rule that shows a slot positions it `absolute` or `fixed`.
  4. Standard sets no `content` on a reserved pseudo-element.
  5. Every attribute is written by the file the table names (a `dataset.<name>` or `"data-<name>"` match).
  6. Every class, id, and attribute a theme sheet selects is in the contract.
  7. Every stylesheet (source and built) starts with `@layer standard, theme;` and keeps its rules inside its own layer.
  8. Every `theme.json` names `contract: 1`, has the required keys, and its ambience levels match the formula. Standard's manifest colour equals `index.html:11`.
  9. No colour literal in `style.css` outside `:root` except rows 1 to 7 of §4.3. Zen's first-frame literals equal their `zen.css` tokens.
  10. No theme rule sets a §6.4 property on a listed ancestor.

## 8. Budgets

### 8.1 Theme folders

- **One ceiling per theme**, raw bytes of `dist/gui/themes/<view>/`: a round design number a person sets, never a measurement. A ceiling moves only with a spec line or a boss nod, named in the commit.
- **Gzip** is checked only for the folder's `.css` and `.js`. Pictures and MP3s do not compress (Raven is 449,283 raw and 337,652 gzipped, `imports.test.ts:1860`), so a gzip cap over the whole folder measures nothing but hash noise.
- **A recorded figure per theme** in `tests/budgets.json`: `{ "raven": { "ceiling": 512000, "raw": 449283, "gz": 52000, "sha": "…" } }`. `npm run budgets` (a new script, `scripts/budgets.mjs`, no dependencies) measures `dist/` after `npm run gui:build` and prints the figures. With `--write` it updates the JSON, so the change shows in the diff.
- **The test fails** when a figure is above its ceiling, or above the recorded figure plus the tolerance: 1 % or 2,048 bytes, whichever is larger. Hash noise (1 to 10 gzip bytes, `imports.test.ts:1328`, `:1589`) sits far inside the tolerance, and a real jump (one more picture) does not. The why of a change goes in the commit message, not in a test comment. The prose history in the test (§1) is dropped. Git keeps it.
- Per-file caps that are design limits stay where they are (Raven's rooms ≤ 44 KB, `raven-rooms.test.ts:30`; Storybook's §B5 table). `raven-rooms.test.ts:39`, a second cap on Raven's *source* folder, goes: the built folder has the one budget.

### 8.2 The page budgets themes move

The same scheme (ceiling, recorded figure, tolerance) replaces the exact caps of the eager page (`imports.test.ts:1370`), the chat chunks (`:1624`), and the stylesheet (`:1793`), because this contract's phases change `style.css` and `boot.js` bytes. The TypeScript line budgets (`imports.test.ts:64`) are out of scope.

### 8.3 Raven at 99 %

Raven's folder is 449,283 bytes against the raven spec's 450,000 (raven spec §5, `docs/specs/2026-11-07-raven-view/spec.md:83`), 717 bytes of room. Any CSS line Raven gains (the token and slot moves of Phases 2 and 4 among them) fails the cap. The 450 KB figure was set as a design guess. Nothing measured ties it to a cost: the server reads the bundle into memory at start (raven spec `:26`), and a page fetches only the pictures and clips of what it shows. The boss picked a 512,000-byte ceiling for picture themes (Raven, Storybook) (Q4).

## 9. Paint rules

- A decoration on an element that repaints with live data (cards, the header, plates, chat entries) is a raster image (WebP or PNG) or a CSS gradient. It is not an SVG image, and never an SVG with a filter primitive (`feTurbulence`). An SVG data URI stays allowed in a slot layer, which is fixed and does not repaint with data, and on surfaces that repaint rarely.
- **Anchor per theme**: the Storybook §B6 trace (demo map, 10 s, the demo silenced, other animations paused) at rest gives at most 150 paints and 100 document pre-paints. A second trace with the demo ticking records Standard's figure (286 paints and 117 pre-paints, `scratch/storybook-b4/notes.md:28`) as the reference. A theme records its own figures and stays within 3 × Standard's pre-paints. Storybook's 1,174 fails this today. Its fix (a raster frame and grain) is part of this migration, as Phase 4b (the boss's pick, Q7). It changes how Storybook looks, so the boss compares candidates before it lands.

## 10. Migration

Each phase is its own branch, lands alone, and leaves **Standard identical**. `npm run check` and the named tests run after each phase. A run that reads `dist/` comes after `npm run gui:build`. `npm test` runs once, on the merged tree at the end (AGENTS.md; a run whose inputs have not changed is not repeated). Never run `npm run gui:demo` and `npm test` at once in one checkout: both regenerate `gui/paraglide`. Every new test is seen red first. UI work goes to the opus model with reference screenshots and a self-review against them.

### 10.1 How "identical" is checked

- **Build and serve**: `npm run gui:demo`, then `node_modules/.bin/vite preview gui --outDir ../dist/demo --port <p>` under a monitor (`python3 -m http.server` stalls headless Chrome on this demo). Use a fresh `agent-browser` session name per run, since Chrome's disk cache keeps stale chunks across rebuilds of same-named files.
- **Matrix**: routes map, head, workspace (the first base), session (the first unit's chat), and settings, at 1440 × 900 and 390 × 844. Standard is the gate. Geek, Raven, Storybook (day and night, `?phase=`), and Zen are recorded for review. The view is set through `localStorage` `sb.view` before load.
- **Freeze**: silence the demo (its `go silent` control), then `document.getAnimations().forEach((a) => { a.pause(); a.currentTime = 0; })`. `data-calm` is not used, since it changes Standard's look.
- **Computed-style snapshot** (the gate): `scripts/style-snapshot.js`, a browser-side function with no dependencies, run through `agent-browser eval`. It writes every element's and every `::before`/`::after`'s full `getComputedStyle`, keyed by DOM path, as JSON. `scripts/style-diff.mjs` compares two snapshots. The gate is exact equality on every pre-existing node for Standard. New nodes (slots) are listed as added, and their computed `display` must be `none`.
- **Pixel diff** (a sanity check): `agent-browser screenshot` of the same matrix, `magick compare -metric AE before.png after.png diff.png` = 0 for Standard. Theme diffs go into the phase report with their crops.
- **Run the matrix**: for the default demo build, pass `--base /pi-straw-boss/ --host 127.0.0.1 --strictPort` to Vite preview. Run `node scripts/style-matrix.mjs <empty-directory> <port> [session-prefix]` against it (default 4810). Any port works: `style-diff` replaces the preview origin inside CSS `url()`s with `<origin>`, so parallel phases capture on their own ports. Each cell has a JSON snapshot and a PNG. Compare one pair with `node scripts/style-diff.mjs before.json after.json`; it lists additions, removals and property changes separately.
- **Phase 0** establishes this: run `node scripts/style-repeat.mjs <first-directory> <second-directory>` on two captures of one build. It checks all 60 style snapshots and requires zero changed pixels in the 10 Standard screenshots.

### 10.2 Phases

| Phase | Content | Anchor |
|---|---|---|
| **0. Tooling** (`chore/style-snapshot`) | `scripts/style-snapshot.js`, `scripts/style-diff.mjs`; the baseline snapshots and screenshots of 4c018131 in `scratch/theme-contract/baseline/` | two runs of one build are identical (§10.1) |
| **1. Layers** (`feat/theme-layers`) | the `@layer` statement and wrappers in `style.css`, `pbs.css`, `geek.css`, `raven.css`, `storybook.css`, `zen.css`; `tests/css-rules.ts` reads the statement form; contract test items 7 (layers only) | `npm run check`; `npm run gui:build`; built CSS checked for the statement (contract test 7 on `dist/`); `npm run test:one -- tests/theme-contract.test.ts tests/gui-css.test.ts tests/raven-motion.test.ts tests/storybook-motion.test.ts tests/raven-contrast.test.ts tests/storybook-contrast.test.ts tests/geek-contrast.test.ts tests/zen-contrast.test.ts tests/pbs-tokens.test.ts tests/gui-themes.test.ts tests/themes-dist.test.ts tests/imports.test.ts`; Standard snapshot identical. **Themes may change** (a theme rule that lost on specificity now wins), and each diff is listed with its rule and either accepted as a fix or the rule removed (Q1). |
| **2. Tokens** (`feat/theme-tokens`) | `--tint` (with the `--hi` alias), `--glow`, `--scrim`, `--err-text`, `--ansi-*`; rows 8 to 40 of §4.3; `#i-brand`; then each theme sets the tokens and drops the overrides they replace (`storybook.css:170, 175, 186-191`; `zen.css:234-235`) | `npm run check`; `npm run gui:build`; `npm run test:one -- tests/theme-contract.test.ts tests/gui-css.test.ts tests/storybook-contrast.test.ts tests/raven-contrast.test.ts tests/geek-contrast.test.ts tests/zen-contrast.test.ts tests/zen-terminal.test.ts tests/storybook-theme.test.ts tests/imports.test.ts`; Standard snapshot identical; Storybook's snapshot identical where the token reproduces the override, and every other difference listed; Geek and Raven differ only at the two link washes (the intended F1 fix) |
| **3. Manifests** (`feat/theme-manifest`) | `theme.json` for Standard and each theme; `scripts/vite-themes.ts` merges them into `sb-themes` and `themes.json`; `boot.js`, `view.ts`, and `tabicon.ts` read them; the registry mounts the phase clock for `phases`; `gui/ambience.ts` with `AMBIENCE_DBFS`; `ThemeParts` v1 with `mount` | `npm run check`; `npm run gui:build`; `npm run test:one -- tests/view.test.ts tests/zen-mode.test.ts tests/viewface.test.ts tests/gui-view.test.ts tests/tabicon.test.ts tests/storybook-phase.test.ts tests/storybook-ambience.test.ts tests/storybook-theme.test.ts tests/raven-theme.test.ts tests/raven-weather.test.ts tests/raven-weather-wiring.test.ts tests/sound-split.test.ts tests/gui-themes.test.ts tests/themes-dist.test.ts tests/theme-contract.test.ts tests/imports.test.ts` (`view.test.ts` and `zen-mode.test.ts` run `boot.js` itself); every theme's snapshot identical, since no look changes |
| **4. Slots** (`feat/theme-slots`) | slot markup in `index.html`, `chat.ts`, `composer.ts`; Standard's hide rule; Raven and Storybook move their layers from pseudo-elements into slots | `npm run check`; `npm run gui:build`; `npm run test:one -- tests/theme-contract.test.ts tests/storybook-motion.test.ts tests/raven-motion.test.ts tests/storybook-chat.test.ts tests/raven-rooms.test.ts tests/calm.test.ts tests/imports.test.ts`; Standard snapshot identical with the slots listed as added and hidden; Raven and Storybook pixel diffs at t = 0 empty, or each difference explained; the §B6 trace of Storybook at rest within its limits again |
| **4b. Storybook paint** (`feat/storybook-raster`) | The boss picked **A, traced pencil**: day and night PNGs of the original frame, grain and divider. The 2× frame uses 28 source pixels for each 14px corner. | `npm run check`; `npm run gui:build`; Storybook, theme-contract and imports tests; Standard snapshot identical. **§9 paint gate still open:** in three 10 s ticking-map traces on the build based on `7c3f138d`, total PrePaint (Standard → Storybook) was 58 → 738, 184 → 770 and 60 → 350; none met the 3× limit. The earlier candidate comparison (60 → 171) did not reproduce. The boss merged A with the gate pending. After the trace harness fix, five SVG status masks still accounted for 118 PrePaint events inside image paints (67 pencil, 12 envelope, 7 flag, 14 moon, 18 stars). The boss approved 96px PNGs of those masks, including the slight change to antialiasing on their edges. The three valid 10 s pairs with the PNGs were **15 → 10 (limit 45), 13 → 10 (39), and 12 → 159 (36)**. Each recorded 701 map mutations per theme and zero image-nested PrePaint events in Storybook. The third pair failed on document work: one second contained 60 PrePaint events, 60 commits and no Paint. Two other captures (15 → 602 and 11 → 12) ended with shared effects running and the harness rejected them; neither counts toward the three. Evidence: `scratch/theme-contract/sbpaint/trace-{1,4,5}/` (valid), `trace-{2,3}/` (rejected). |
| **5. Hooks and the frozen list** (`feat/theme-contract`) | `data-vary` in `render.ts`; `contract.json` complete; the full contract test (items 1 to 10); Storybook's tape on `data-vary` | `npm run check`; `npm run gui:build`; `npm run test:one -- tests/theme-contract.test.ts tests/storybook-theme.test.ts tests/imports.test.ts`; Standard snapshot identical (`data-vary` is an attribute no Standard rule reads) |
| **6. Budgets** (`feat/theme-budgets`) | `tests/budgets.json`, `scripts/budgets.mjs`, `npm run budgets`; the four budgets of §8 rewritten; the Raven source cap dropped; the ceilings the boss picks (Q4) | `npm run gui:build`; `npm run budgets`; `npm run test:one -- tests/imports.test.ts tests/raven-rooms.test.ts tests/storybook-theme.test.ts` |
| **7. Docs** | `docs/how-it-works.md`, a *Themes* entry (the contract in brief: tokens, slots, manifest, layers), with the same lines of the zh-TW twin and its commit line moved; the storybook spec's §B10 pointer to this spec | `npm --prefix site run check`; `cd site && npm ci && npm run build`; `npm run test:one -- tests/twin.test.ts`; then `npm test` once on the merged tree |

Phase 1 comes first because it decides which rules win, and every later deletion of an override relies on that. Phases 2, 3, and 5 do not depend on each other and may land in any order after Phase 1. Phase 4 needs Phase 1, Phase 4b needs Phase 4 (its layers move into slots first), and Phase 6 runs last, so its recorded figures are taken once.

A fresh-context reviewer is required for Phases 1 and 3 (Phase 1 changes the cascade of every view, and Phase 3 changes a shared contract, the theme map in `<meta name="sb-themes">` and `themes.json` that `boot.js` and the server read). Only P0 and P1 findings block.

## 11. Not doing

- Loading a theme from outside the repository. The manifest and the data-only parts are the precondition the storybook spec §B10 names, and the split stays the boss's call (「先內建，條件到了再拆」). An external theme would also need its sprite sanitized before `icons.ts:35` parses it into the page. The CSP (`script-src 'self'`) already blocks inline handlers.
- Renaming the state tokens (`--amber` → `--waiting`, …) (Q2).
- New themes, and any look change beyond the two link washes (F1) and what Phase 1's review accepts.
- The TypeScript line budgets.

## 12. Open questions

**Decided** by the boss on 2026-11-26: the direction as written; Q1 as recommended (each Phase 1 diff reviewed with its screenshot); Q4 512,000 bytes for picture themes; Q7 *inside* this migration, as Phase 4b (against the recommendation). The other questions take their recommendation.

| # | Question | Recommendation |
|---|---|---|
| Q1 | Phase 1 may change how a theme looks where a theme rule lost to a more specific Standard rule. Keep each such change, or restore the old look? | Review each diff with its rule. Keep it when it is what the theme's author wrote (the rule was dead by accident). Delete the rule when the old look was the intent. The boss sees the screenshots. |
| Q2 | Rename state tokens to their meaning (`--waiting`, `--commanding`, `--done`, `--error`)? | Not in v1. It touches every sheet and test for no visual gain. Add aliases if an external theme format comes. |
| Q3 | Hold the built-in themes to the contract's class list now, while every theme lives in this repository? | Yes. The cost of a new reach is one line in `contract.json`, and the list is what a future split needs anyway. |
| Q4 | Raven's folder ceiling | 512,000 bytes for picture themes (Raven, Storybook), 16,000 for Geek, 160,000 for Zen. The alternative keeps 450,000 and wins room back (Raven's favicon is 8,142 bytes against Storybook's 1,502, and its sprite is the largest non-picture file), which caps every later Raven change at a few hundred bytes. |
| Q5 | May built-in themes keep code? | Yes, only through `ThemeParts.mount` (Raven's weather). External themes would be data only. |
| Q6 | A loudness rule for effects clips (the question clip)? | Not now. Record each clip's peak in the manifest as information, and set a rule if a clip is reported too loud. |
| Q7 | Fix Storybook's repaint cost (raster frame and grain) inside this migration? | No, as a Storybook follow-up after Phase 4, with the §9 trace as its anchor, because it changes Storybook's look. |
| Q8 | Move every theme selector to the `:where()` prefix? | Only for new rules. A mass rewrite risks the specificity balance inside each theme for no gain once layers are in. |
| Q9 | Version format | One integer. Additions keep it, and removals or renames raise it. |
| Q10 | Where the contract lives | `gui/themes/contract.json` (read by the test and the build) and a *Themes* entry in `docs/how-it-works.md`. No separate author guide until someone outside writes a theme. |
| Q11 | `data-vary`'s range | 0 to 7: enough for tape angles and tilts without repeats among neighbours most of the time, and a one-digit attribute. |
| Q12 | Is the computed-style snapshot worth committing as `scripts/`? | Yes. Every later theme change and Standard refactor can reuse it, and it adds no dependency (it runs in the browser through `agent-browser`). |
