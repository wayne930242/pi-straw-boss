Status: approved by the boss 2026-11-26 (spec, animals O11, day 06:00–17:59)
Base: `main` 8e3c816c (0.93.0)
Related: [2026-11-07-raven-view/spec.md](../2026-11-07-raven-view/spec.md) (the theme mechanism and the precedent this follows), [2026-11-01-zen-view.md](../2026-11-01-zen-view.md) (Zen, Z-D16, Z-D20), [2026-11-09-sound-split.md](../2026-11-09-sound-split.md) (the two sound classes). Design notes: [design.md](design.md).

# Zen as a mode, and the Storybook (繪本) theme: spec

Two changes to the GUI, built in this order:

- **Part A: Zen becomes a mode.** Zen leaves the list of views; a header button enters it from any theme.
- **Part B: a new theme, Storybook (繪本).** It is a cute, soothing picture-book skin of Standard: a watercolour day by daylight and a storybook night after dark, with animal role icons and gentle motion. It also brings its own sounds, and Standard's question clip is replaced by one from the same library.

## 0. Boss decisions (2026-11-26)

| Id | Question | Answer (verbatim) | What it fixes |
|---|---|---|---|
| SB-D1 | Is Zen a theme? | 「Zen 使用自己的主題，改成模式的意思是說他應該放在 navbar 直接能夠進入，而不是 settings 的一個選項」 | Zen keeps its own ink look and synthesized effects. It leaves the settings view control and the list a device or the server picks from. A header (navbar) control enters it directly from any theme, and leaving it shows the device's theme (Part A). |
| SB-D2 | The new theme's character | 「以可愛、舒心為主，搭配一些可愛元素」 | Storybook, view id `storybook`, en "Storybook", zh-TW 「繪本」 (§B1). |
| SB-D3 | Light or dark? | 「看現在時間？」 | The phase follows the device's local time: a light watercolour day and a dark storybook night (§B2). |
| SB-D4 | Which cute elements? | 「插畫＋動物圖示，詞彙不改」 | Illustrations and animal role icons. There is no noun pack and no sentence pack: every word is Standard's (§B3, §B4, §B7). |
| SB-D5 | Sounds | Casper's library (https://www.casper.tw/sound-effects/zh-tw/, licence `/license/`: no AI training, no repackaging as a pack, no Content ID) for three slots: Storybook's question clip, Storybook's background ambience (day and night), and Standard's question clip `gui/sounds/waiting.mp3`, now Kenney CC0 | §C. Boss picked all four on 2026-11-26 by ear (scratch/sound-candidates/listen.html): kalimba-thumb-pluck, place-forest-birds-singing, night-cricket-meadow, ui-message-marimba (§Sounds table). |

## Reality anchor (read from 8e3c816c)

- One list holds the view names: `VIEWS = ["standard", "geek", "zen", "raven"]`, with `CHOICES = auto + VIEWS` (`src/views.ts:5-8`). These read it:
  - the server's default: `src/server/guiprefs.ts:14-22` (any other value reads as `auto`), `src/server/guihost.ts:466` (the error text), and `GuiRecord.view` (`src/handover.ts:19`);
  - the completions: `src/bossviews.ts:4-10`;
  - the build's theme folders: `THEME_VIEWS`, `scripts/vite-themes.ts:14`;
  - `boot.js` names: every key of `<meta name="sb-themes">`, `gui/boot.js:15-16`;
  - Zen's menu (`gui/zenmenu.ts:32-37`), the palette (`gui/paletteentries.ts:29-32`), and the demo's server cycle (`gui/fixture.ts:97`).
- Zen is a value of the device's view. `sb.view = zen` puts every page of the device into Zen. Esc Esc, the corner control, or the settings route set `data-zen-away`, and the page then shows **Standard**, not the device's theme (`gui/view.ts:55`, `face = … ? "standard" : view`). The header's `#zen-back` (`gui/index.html:74`, `mountZenBack` at `gui/view.ts:123`) is shown only while away. `held` (`gui/view.ts:50, 73`) keeps a page in Zen when the server's default moves away from `zen` (Z-D20 R3). `faceAfter` (`gui/viewface.ts:27-41`) and `rulesOf` (`gui/faces.ts`) decide the face and its rules.
- Zen's code and stylesheet sit in the theme folder `gui/themes/zen/` and load through `loadTheme("zen")` (`gui/main.ts:96`). The settings page's control has a Zen button (`gui/index.html:121`).
- A theme hands in `sprite`, `nouns`, `sentences`, `sounds` (only `waiting`), and `badge` (`gui/themes/theme.ts`). The question clip goes through `soundOf("waiting", waitingUrl)` (`gui/notify.ts:6, 67`), with `waiting.mp3` (3,177 bytes) as the base. Raven's three clips are already Casper's (NOTICE.md, *Raven Keep sounds*).
- Every view is dark today. `color-scheme: dark` is in every theme's `--pbs-*` block. Raven's non-goals and Zen's both say "a light variant".
- Each theme folder has a byte cap: geek 8,474, zen 143,819, raven 446,985 (raven's ceiling is 450 KB). `tests/imports.test.ts:1780` asserts "a folder per theme and no other".

---

# Part A: Zen as a mode

## A1. Observable behaviour

- **Themes and the mode.** A device chooses a **theme**: `Choice = auto | standard | geek | raven | storybook`, `View = standard | geek | raven | storybook`. **Zen** is a **mode** of the page, on or off, and it is not in that list. The page's **face** (`data-view` on `<html>`) is `zen` while the mode is on and the route is not the settings page; otherwise it is the device's resolved theme. Zen's own look (ink, `zen.css`), its layer, its synthesized effects, its music, its keymap, and every Z-D rule about cards are unchanged.
- **Settings.** The view control loses its Zen button. It shows Auto, Standard, Geek, Raven Keep, and Storybook, and its label stays 「畫面」/"View". The hint `view_title` stops naming Zen.
- **The header button.** `#zen-back` becomes `#zen-enter`, the **Zen button**. It appears in the header of every theme (Standard, Geek, Raven Keep, Storybook), beside the gear, whenever the shell is on the screen, the settings route included. A press turns the mode on and Zen shows at once. On the settings route it first leaves the page, as today's Zen pick there does (Back). The text is 「禪」/"Zen" and the title 「進入禪（一次只看一件待辦）」/"Enter Zen (one waiting item at a time)". On a phone (≤ 640 px) it is an ensō glyph (`#i-zen`, a symbol of Standard's inline sprite) on a 44 px target, with that title as its `aria-label`. Each theme styles it in its own colours: Geek writes `[Zen]`, Raven and Storybook use their palettes.
- **Leaving.** Esc Esc, the corner control, the palette's way out, an item's exit, and a session's exit turn the mode **off**. The page then shows the device's theme: Raven Keep, Storybook, Geek, or Standard, not always Standard as today. The exits that go somewhere still do (an item's dialog in the theme's dock, a companion's session route). The corner control and the palette entry now read 「離開禪（Esc Esc）」/"Leave Zen (Esc Esc)" (`zen_leave_title`, `pal_standard` renamed `pal_leave`).
- **Persistence (O1).** The mode is stored on the device as `sb.zen` (`"1"` or `"0"`). A reload, a new page of the device, and the build-change reload open in Zen while it is on, as a Zen device does today. Another open tab of the device is never switched by this key, into Zen or out of it. The key is read at load only, and no `storage` listener exists for it, so no page is pulled out of what it shows (in the spirit of Z-D20).
- **The settings route** suspends Zen and does not end it. With the mode on, the settings page shows the theme's page, and leaving it shows Zen again (today's away-on-settings rule, ZNR-F004, kept). Zen's corner menu still opens Settings.
- **The server cannot put a page into Zen (O3).** `/boss gui view zen` is refused with `Zen is a mode now: enter it with the Zen button in the page's header. The default view is auto, standard, geek, raven, or storybook`. Completions drop `gui view zen`. A `gui-prefs.json` that says `zen` reads as `auto`, as any unknown value does. `/boss gui view` (tell) adds one line when the file says `zen`: `gui-prefs.json still says zen, which is now a mode; the default reads as auto`. The server never rewrites the file by itself (the existing rule). `gui.json` never carries `view: "zen"` again.
- **Z-D20 (「永遠不要打斷」) under the mode.** It holds by construction:
  - A change of the server's default, or of the screen's contrast, changes only the theme. A page in Zen keeps its face, and the new theme shows when the boss leaves.
  - A pick in another tab changes that tab's theme and, through `sb.view`, this one's theme. It never touches this page's mode.
  - `held`, `release()`, and the `follow`-while-in-Zen branch of `faceAfter` go: nothing is left that could switch a page out of Zen. Leaving and entering happen only on the boss's own action.
  - The build-change reload still waits for the breath (`core.upgrade`, unchanged).
- **Zen's corner menu and palette (O4).** The view row and the `view:*` palette entries go from Zen. A theme picked there would show only after leaving, which reads as a broken pick. The theme belongs to the settings page. Language, Sound effects, Background sound, the music, Settings, and Leave Zen stay.
- **Keymap (O5).** Zen's rows (`zenrows.ts`) and Esc's table (`zenkeys.ts`) are unchanged. No new key enters Zen in this change.
- **Rules per face.** `gui/faces.ts` keys `RULES` by face (`Face = View | "zen"`). `raven` and `storybook` take Standard's row, `geek` Standard's without calm, and `zen` its own. `rulesOf(face)` no longer takes `away`.
- **Tab icon and colour.** In Zen the tab icon is the ensō with no count, and the theme-colour is `#14110e`, as now. On leaving, both are the theme's.
- **Assets while in Zen (O10).** The amendment to raven spec §1.2's "never loaded together": a page whose mode is on loads Zen's chunk first. The device's theme (its stylesheet and module) loads after Zen has drawn, when the page is idle, so leaving shows it with no flash of Standard. A theme's own sounds and motion run only while its face is shown: Raven's weather checks its backdrop today, and Storybook's ambience follows the same rule (§C2). A page on a theme with the mode off loads no Zen file (unchanged).

## A2. Storage and migration

| Stored | New build reads | Notes |
|---|---|---|
| `sb.view = zen`, no `sb.zen` | theme **Auto**, mode **on** | This is the legacy fallback, the sound-split precedent: `sb.zen` is read first, and only while it is `null` does `sb.view === "zen"` mean on. The legacy key is never written, so an older build on the same browser still finds Zen. |
| `sb.view = zen`, `sb.zen = 0` | Auto, off | The device left Zen on the new build. |
| `sb.view = raven`, `sb.zen = 1` | Raven Keep, on | Leaving shows Raven Keep. |
| `sb.view = storybook` on an older build | Auto | `choiceOf` as today. |
| `gui-prefs.json` `{"v":1,"view":"zen"}` | `auto`, plus the tell note above | The file is untouched until `/boss gui view <name>` (`storedIs` already rewrites a value this build cannot read). |
| `gui-prefs.json` `storybook` on an older server | `auto` | As raven was. |

`gui/prefs.ts` gains `zen: "sb.zen"` with the reader above. A refused storage reads the legacy value or off, and a write it refuses is dropped, so the mode holds until the page closes.

## A3. First frame

`boot.js` reads `sb.zen` (and the legacy `sb.view`) before the body exists. With the mode on it sets `data-view="zen"` and the theme-colour `#14110e`, and it links Zen's stylesheet when the server did not. The style.css first-frame block (the ink ground and the ring) stays as is. Otherwise it resolves the theme as today. The theme names exclude the mode: the build writes `mode: true` on Zen's entry in `themes.json` and `sb-themes`, and `boot.js` skips such entries. A parity test runs `boot.js` against `view.ts`/`mode.ts` over every stored `sb.view` × `sb.zen` × contrast × server default.

## A4. Edge cases

- **The mode is on and the theme is Geek through Auto plus `prefers-contrast: more`.** Leaving shows Geek.
- **The settings route with the mode on.** Pressing the Zen button there leaves the settings page and shows Zen. Picking a theme there changes the theme and stays on the settings page; the mode stays on, and Zen shows on leaving it.
- **A stream hello carrying `view: "zen"` from an older server.** It reads as Auto, and the build mismatch reloads the page anyway.
- **The demo.** `?zen=<state>` writes `sb.zen=1` into its in-memory store (`main.ts:40`), not `sb.view`. The fixture's server cycle walks `CHOICES` without Zen.
- **A paired device.** It still cannot run `/boss gui view` (`BOSS_LOCAL`, unchanged). Entering Zen is page-local and needs no server route.
- **Desk shell.** `gui.json` never says `zen`. The shell paints the theme's colour (a desk follow-up for `storybook`, §B10).

---

# Part B: the Storybook theme

## B1. The view

- Its id is `storybook`, and the messages are `view_storybook` (en "Storybook", zh-TW 「繪本」). It is added to `src/views.ts`, and through that list to `/boss gui view storybook` (completion text: `Default view: Storybook (a picture-book skin of Standard: watercolour by day, a starry night after dark) for devices that follow the server`), the settings control, the `sb-view` meta, `hello`, the `view` event, and `gui.json`.
- It is a skin of Standard: the same layout, interaction, and words (SB-D4). It lives in `gui/themes/storybook/` with the raven mechanism (entry `index.ts`, stylesheet, sprite, favicon, pictures, sounds, phase code), and loads only on a page that shows it.
- Auto with `prefers-contrast: more` is still Geek. An explicit Storybook stays Storybook.

## B2. Day and night (SB-D3)

- **Phase.** `day` from 06:00 to 17:59 and `night` from 18:00 to 05:59, by the device's local clock (`Date#getHours()`; O2). Nothing uses server time, and there is no manual override (O9). The demo forces it with `&phase=day|night`.
- **First frame.** When the resolved view is `storybook`, `boot.js` computes the phase, sets `data-phase` on `<html>` and the phase's theme-colour, and links the stylesheet as for any theme. The CSS hangs everything on `html[data-view="storybook"][data-phase="day"|"night"]`, so the first paint is in the right phase. `boot.js`'s `phase(hours)` is checked against `gui/phase.ts` `phaseAt(date)` for all 24 hours (parity test).
- **Live switch.**
  - The theme module arms one timer to the next boundary, read from a clock seam (`now()`, `setTimeout`) so tests drive it with `tests/fake-clock.ts`.
  - It checks again on `visibilitychange` to visible, on `pageshow`, and at each snapshot no more than once a minute, because a phone that slept skips timers and a time-zone or DST change moves the boundary.
  - At a boundary the tokens switch at once. The two backdrops cross-fade by opacity over 2.4 s, or instantly under reduced motion.
  - The switch causes no reload and no route change, and it does not touch focus, drafts, the scroll position, or open dialogs.
  - The ambience cross-fades with the pictures (§C2).
- **Theme-colour per phase** (`gui/view.ts` `THEME` gains `storybook: { day, night }`, read with `data-phase`): day `#fbf5e9`, night `#111a35`.
- **Tab icon.** One favicon serves both phases (O6): a bunny peeking over an open picture book, line art in deep plum `#3a3150` on a cream disc `#fbf5e9`, readable on a light or dark tab strip. The waiting badge takes the phase's colours: day `{ dot: "#e0902b", ring: "#fbf5e9", text: "#3a3150" }`, night `{ dot: "#ffd37e", ring: "#111a35", text: "#111a35" }`. `ThemeParts.badge` may be a function of the phase, and the theme tells the page at a boundary (`onShift`, design.md) so it redraws the tab icon and the theme-colour.
- **`color-scheme`.** `light` by day and `dark` at night, in the `--pbs-*` block and on `<html>`, so native controls, scrollbars, and pi-better-show elements follow (`tests/pbs-tokens.test.ts`).

## B3. Look

- **Day: a watercolour picture book.** Cream paper ground, soft pastel washes (sky blue, mint, peach), deep plum ink for text, rounded corners (14 px panels, 999 px pills), soft paper shadows instead of glows, and a faint paper grain (a static tiled SVG noise in the stylesheet, under 2 KB).
- **Night: a storybook night.** A deep blue sky ground, warm moon-cream text, lamplight gold for what waits, and stars. Panels are dusk-blue glass where `backdrop-filter` is supported and opaque `#18234a` otherwise.
- **Palette** (the starting values; the contrast test decides, and design.md has the table). Every text colour is at least 4.5 : 1 on every surface in both phases, the state colours used as text included. Large text and UI borders are at least 3 : 1. Waiting is honey or lamp gold, error berry red, working leaf green, idle grey-blue, and the accent storybook blue. A state never differs from another by hue alone, since the shapes and Standard's words stay.
- **This is the first light theme.** Standard's entry CSS has places that assume a dark ground (literal `rgba(255,255,255,…)` overlays, glows, `--ink` as text on fills, the QR code's frame). Phase B-1 begins with an audit: every literal colour in `gui/style.css` and the chunk stylesheets that a light ground would break gets a token or a storybook override. The audit's list goes in the change's report, and `tests/storybook-contrast.test.ts` computes over the storybook block's tokens. The terminal keeps its own colours (a dark well in both phases, as in Raven).
- **Fonts.** Standard's faces, with one exception: the headings may use a rounded system stack (`ui-rounded, "SF Pro Rounded", system-ui`). No web font is fetched.
- **Status motion** (as raven §1.5 replaced the radar). Storybook overrides the same six inherited rules: the tower's conic `.sweep` and `.pulse`, the plate's spinning `.ring` and its `::after` ping, the small badge's spinner, and the connection overlay's ring. It uses its own figures, drawn in `storybook.css` only, with no markup hook:
  - **Working:** little footsteps. Three paw prints appear one after another around the lower arc of the disc and fade (`opacity` and a 2 px `translateY`, 3.6 s), over a soft wash that swells by `scale`. The small badge shows a hopping dot (`translateY`, 1.2 s).
  - **Waiting:** a lantern. A warm glow inside the disc swells and settles (`scale` and `opacity`, 3.2 s) under a dashed ring that breathes. The badge's "?" floats in a little speech bubble (2.4 s).
  - **Connection overlay:** a lantern glow in a dashed ring, and a plain berry ring when the stream gave up.
  - **The raven precedent's rules:**
    - Compositor only: each status animation changes only `transform` and `opacity` of a layer whose picture is fixed.
    - No cycle is under 0.8 s, and nothing flashes more than 3 times a second.
    - Nothing reads as a radar (no conic wedge, no full-turn spin).
    - Reduced motion, `data-calm`, and forced colours stop it all, and each state keeps a still figure (three paw prints, or the lantern at four fifths with its dashed ring). The figures differ in shape, not in hue alone.

## B4. Role icons (SB-D4)

- There are ten icons in one sprite `sprite.svg`, ids `storybook-<role>`, all through `iconRef` (Standard's stay the fallback). The roles are Raven's ten. Each animal below is a proposal for the boss's approval (O11):

  | Role | Animal | Why |
  |---|---|---|
  | you (the boss) | bunny | the reader of the book |
  | head tower | owl | watches over everything, awake at night |
  | tower | mother duck | leads a line of ducklings (its mains) |
  | main | beaver | the builder who does the work |
  | member | squirrel | a busy teammate |
  | subagent | bee | a small helper sent on an errand |
  | outpost | snail | carries its house to a far place |
  | outside unit | cat | comes and goes on its own |
  | comms | bluebird with a letter | carries the messages |
  | document | mouse with a book | reads and keeps the pages |

- **Style (O12).** Single-colour silhouettes with rounded, chunky shapes (`fill="currentColor"`), so state colours, Geek-style forced colours, and both phases work. Each must read at 16 to 20 px; unlike Raven, legibility at small size is not traded away. They are drawn as one sheet with Codex image generation in a children's-book stamp style and traced with potrace. An icon too detailed after tracing is redrawn as a bold path of at most 1.5 KB. The sprite is at most 30 KB.
- There are no role nouns: the legend, plates, crumbs, and dossier keep Standard's words (`tests/storybook-theme.test.ts`: `theme.nouns` and `theme.sentences` are undefined).

## B5. Illustrations

All pictures are drawn with Codex image generation in one watercolour picture-book style, original to this project (no existing book or character copied), WebP, under the theme folder. A phase's pictures are named in CSS under that phase's selector, so a page fetches only the shown phase's pictures; the other phase's pictures are fetched at the boundary.

| File | Where | Size | Cap |
|---|---|---|---|
| `backdrop-day.webp` | head page and map, by day: a meadow with a winding path to a treehouse, clouds, distant hills | 1280 × 721 | 100 KB |
| `backdrop-night.webp` | the same scene at night: deep blue sky, crescent moon, stars, warm lamplight in the treehouse windows | 1280 × 721 | 100 KB |
| `nook-day.webp`, `nook-night.webp` (O7) | the chat page: a small corner vignette under the comms (a picnic blanket by day, a reading lamp and a sleeping cat at night) | ≤ 480 × 300 | 20 KB each |

- **Placement as in Raven.**
  - The head page and the map show the backdrop. The workspace and settings pages stay plain paper or sky. The chat page shows its nook, faint, in a corner.
  - The map draws the picture as fixed layers, and its panels and legend take a paper or dusk veil.
  - Under 600 px the backdrop covers the screen's height and is pinned so the treehouse shows.
  - Under forced colours no picture is drawn.
- **Contrast over the pictures.** Text keeps 4.5 : 1 over the brightest pixel of the day picture and the darkest of the night picture, under the veil each surface takes. The test samples the shipped files, as `tests/raven-contrast.test.ts` does.

## B6. Ambient motion

- **Day:** two cloud strips that slide slowly, one each way (`translateX`, 150 s and 210 s); two butterflies that cross now and then, their wings two layers swapped by opacity (never `background-position`), on a `transform` path, at most one crossing per 40 s; and a leaf that drifts down now and then.
- **Night:** stars that twinkle (opacity, in three groups out of phase, 4 to 7 s); five to seven fireflies that wander and glow (`transform` and `opacity`, 9 to 14 s each, out of phase); the moon's halo breathing (opacity, 8 s); and the treehouse windows' lamplight breathing (opacity, 5.3 s, at most 16 % alpha).
- **Rules** (raven §1.5's map lessons):
  - The map is open for hours, so every layer there only fades or moves (`opacity`, `transform`). Nothing animates a registered property, a gradient, `background-position`, a filter, or a shadow.
  - No IntersectionObserver stays connected while these run (a measured Chrome cost: a frame every vsync).
  - Under 600 px the butterflies and fireflies are fewer (one butterfly, three fireflies).
  - Reduced motion, `data-calm`, and forced colours draw the still picture: clouds in place, stars lit, no fireflies or butterflies.
- **Performance anchor.** A Chrome trace of the demo map, other animations frozen, 10 s at rest, in each phase: at most 150 paints and 100 pre-paints (Raven's map measured 134 and 88). It is recorded in the change's report.

## B7. Words

There is no noun pack and no sentence pack (SB-D4): English and zh-TW keep every base message. The new messages are `view_storybook` and the Part A messages (`zen_enter`, `zen_enter_title`, the reworded `zen_leave_title` and `pal_leave`), in both locales.

## B8. Budget

`dist/gui/themes/storybook/` is at most **450 KB** raw (raven's ceiling). It is planned as: two backdrops ≤ 200 KB, two nooks ≤ 40 KB, sprite ≤ 30 KB, favicon ≤ 4 KB, stylesheet and entry ≤ 60 KB, sounds ≤ 110 KB (§C). `tests/imports.test.ts` gains the `storybook` cap (the measured figure, ≤ 450,000 asserted beside it). The entry's budget grows only by what the measured report names: `gui/phase.ts`, the Zen button, and the view name.

## B9. Edge cases

- **The page stays open across 18:00.** The night tokens arrive, the pictures cross-fade, the ambience cross-fades, and the tab icon's badge redraws. A dialog, a draft, or the terminal in use is untouched.
- **A phone wakes at 07:10 after a night asleep.** `visibilitychange` re-reads the phase before the first frame shows, and the stale night does not linger until a timer fires.
- **The device clock or time zone changes.** The next check (visibility, snapshot, or timer) takes the new phase.
- **A page in Zen mode on a Storybook device.** Zen shows, Storybook's ambience is silent and its motion is not drawn (its face is not shown), and leaving shows the current phase.
- **`boot.js` fails.** The page draws the server's linked stylesheet or Standard. `main.ts` corrects `data-view`, and the theme module sets `data-phase` when it loads (a possible flash then, as for any theme).
- **Print, and the desk shell's window colour.** Out of scope (§B10).

## B10. Non-goals

- A noun or sentence pack, and flavour text.
- A manual phase setting.
- A phase from sunrise or sunset or from the OS's light or dark preference.
- A Zen in storybook colours (Zen keeps its ink).
- A light variant of Standard, Geek, or Raven.
- Installed-app icons and the manifest.
- The desk shell's colour for `storybook` (a straw-boss-desk follow-up: its window should take `#fbf5e9` or `#111a35`).
- Per-role chat rooms like Raven's (one nook per phase instead).
- A new hotkey for Zen.
- Theme packages outside this repository. The boss asked (2026-11-26) whether themes should ship separately, downloaded or installed by whoever wants them, and chose 「先內建，條件到了再拆」: Storybook ships built in like Raven. Revisit when someone else wants to make a theme, when the theme folders make the package noticeably heavy, or when the non-MIT assets (Casper's clips) should leave the public repository. The first external format then is data only (CSS, pictures, sounds, a manifest, no JavaScript), since a theme's code runs in a page that answers agents' dialogs, and the themes' CSS overrides Standard's markup (`.sweep`, `.ring`), so an external theme needs a versioned markup contract first.

---

# Part C: sounds (SB-D5)

All clips come from Casper's library and are used under its licence (https://www.casper.tw/sound-effects/zh-tw/license/): no AI training, no repackaging as a sound pack, no Content ID registration. Each is converted to mono MP3 with nothing else changed, is not under the MIT licence, and is listed in NOTICE.md. A clip whose page carries the "Powered by Stability AI" notice keeps that notice beside it, as Raven's entry does. A file is named for what it is, not for the event, following Raven.

## C1. Slots

| Slot | Class | File | Picked clip | Limits |
|---|---|---|---|---|
| Storybook's question clip (`ThemeParts.sounds.waiting`) | effects | `gui/themes/storybook/sounds/<name>.mp3` | 拇指琴單音 `kalimba-thumb-pluck` (https://sound-effects.casper.tw/audio/ id from search-zh-tw.json), trimmed to 1.7 s with a fade-out | ≤ 1.8 s with a fade-out, ≤ 20 KB, mono, 22.05 or 24 kHz, 48 kbps or less. Gentle and bright (a small chime, a music-box note, a soft bird call), and never a fanfare. |
| Storybook day ambience | background | `gui/themes/storybook/sounds/<name>.mp3` | 森林鳥鳴 `place-forest-birds-singing` (3.65 s), made a seamless loop by a 0.5 s equal-power crossfade of head and tail | 3 to 12 s (Casper clips are ≤ 4 s; Raven's rain is a 4 s loop), a seamless loop (no gap or click at the seam, checked by ear and by the first and last 20 ms of samples), ≤ 45 KB, mono, 32 kbps or less. Quiet (birds far off, a brook, a light breeze), with no melody that grows tiresome on loop. |
| Storybook night ambience | background | `gui/themes/storybook/sounds/<name>.mp3` | 草地蟋蟀 `night-cricket-meadow` (3.61 s), looped as the day clip | as the day ambience (crickets, a soft night breeze, a far owl at most once per loop) |
| Standard's question clip | effects | `gui/sounds/<name>.mp3`, replacing `waiting.mp3` (Kenney CC0) | 馬林巴短音 `ui-message-marimba`, trimmed to 0.6 s with a fade-out | ≤ 1.2 s, ≤ 12 KB, mono. Neutral enough for Standard and for Geek, which plays the base clip because it has no sounds of its own. |

The storybook folder's sounds total at most 110 KB.

## C2. Behaviour

- **The question clip.** It follows the existing chokepoint: `soundOf("waiting", base)`, behind the Sound effects switch and volume, played only for what waits on the boss (2026-11-24). A finish and a failure play nothing. The settings page's Try plays the shown view's clip. It is fetched on first play, and a failed fetch falls back to the base clip (`audio.play(url, fallback)`).
- **The ambience** (Background class; `tests/sound-split.test.ts` gains rows for the two clips).
  - It plays while the face is `storybook`, the page is visible, Background is on, and the backdrop is on the page (map or head page; O8), as Raven's rain does.
  - It is one Web Audio buffer source with `loop = true` through `audio.out("background")`, at a quiet level under the class gain (−12 dB, as the rain), fetched on first use.
  - At a phase boundary the two loops cross-fade over 3 s. Only the shown phase's clip is fetched until a boundary comes.
  - It stops at once when the face leaves storybook (Zen entered, another theme), when the page is hidden, or when Background is turned off. Turning Background on is the gesture that starts it, and a stored-on switch waits for the first tap (as the rain and Zen's music do).
- **Standard's clip.** `gui/notify.ts` imports the new file in place of `waiting.mp3`; the old file is removed. NOTICE.md's *Sounds (`gui/sounds/`)* entry is rewritten to the Casper licence (not MIT, not CC0) with the clip's name and URL. `docs/how-it-works.md` *Reminders and sounds* stops naming Kenney (and the zh-TW twin's same line changes with it).

---

# Docs to change

- `docs/how-it-works.md`, each in the same change as the behaviour it describes, with the same lines of `docs/how-it-works.zh-TW.md` and its commit line moved (`tests/twin.test.ts`):
  - *View: Auto, Standard, Geek, Zen, Raven Keep* becomes *View: Auto, Standard, Geek, Raven Keep, Storybook*;
  - the Zen entry's opening (a mode entered from the header; leaving shows the device's theme; persistence; no server default);
  - a new *Storybook (繪本)* entry after Raven Keep;
  - *Reminders and sounds* and *Sound effects and background sound* (Storybook's ambience, the new base clip).
  
  Keep the existing anchors, and add new ones only.
- `site/src/content/docs/reference/commands.md` and `zh-tw/reference/commands.md`: `/boss gui view auto|standard|geek|raven|storybook`, with a note that Zen is a mode.
- `site/src/content/docs/guide/browser-view.md` and its zh-TW twin: the view list, how to enter and leave Zen, and a Storybook section with day and night pictures.
- README.md and README.zh-TW.md (boss rule, 2026-11-01): screenshots from `npm run gui:demo` of the header's Zen button, and of Storybook's map, head page, chat page, and phone in both phases. Never from the live GUI or real data.
- NOTICE.md: §C, and a *Storybook view* art entry (Codex image generation, potrace, original art).
- `docs/specs/2026-11-01-zen-view.md`: a dated "Superseded in part" note at the top pointing here (Zen is a mode; `/boss gui view zen` gone; R3's `held` gone).

# Open questions (each with the recommendation this spec already follows)

| # | Question | Recommendation |
|---|---|---|
| O1 | Where does the mode live? | On the device (`sb.zen`), read at load, never applied live to another open tab; leaving writes off. A reload keeps Zen as today. The alternative, per tab (`sessionStorage`), would open every new tab in the theme. |
| O2 | Day hours | 06:00 to 17:59 day, 18:00 to 05:59 night, local clock. Sunrise and sunset would need a location, and 07 to 19 reads late in a Taiwan winter. |
| O3 | Can the server still default pages into Zen? | No. `/boss gui view zen` is refused with guidance, and a stored `zen` reads as `auto` with a note on tell. Zen is the boss's own act on a device. |
| O4 | Zen's corner menu and palette view list | Remove the view row and the `view:*` entries; a theme picked inside Zen would show nothing until leaving. Keep Settings and Leave Zen. |
| O5 | A hotkey to enter Zen | None in this change; the header button is one press away. Add one later if the boss asks. |
| O6 | One favicon or one per phase? | One for both phases (a bunny over an open book), with the badge colours per phase. |
| O7 | Chat-page pictures | One small nook per phase (≤ 20 KB each), not per-role rooms, to keep the 450 KB cap and the calm. They can be dropped if the budget is tight. |
| O8 | Where the ambience plays | Only where the backdrop is (map and head page), as Raven's rain. A chat page stays quiet. |
| O9 | A manual day or night override | None. The demo's `&phase=` is for screenshots only. |
| O10 | Loading the theme while in Zen | Load the device's theme after Zen has drawn, when idle, so leaving does not flash Standard. This amends raven §1.2's "never loaded together" for a Zen page only, and its sounds and motion stay off while Zen is shown. |
| O11 | The animal per role | The table in §B4 (bunny, owl, mother duck, beaver, squirrel, bee, snail, cat, bluebird, mouse). |
| O12 | Icon style | Single-colour rounded silhouettes (`currentColor`), not full-colour watercolour icons: state colours, forced colours, and 16 px legibility need one colour. The watercolour lives in the pictures. |

# Build plan and Reality anchor per phase

Each phase is its own branch or commit set, and each lands alone. `npm run check` and the named tests run after each, and `npm test` once per merged tree (AGENTS.md; it is not repeated when its inputs have not changed). A run that reads `dist/` needs `npm run gui:build` first. Never run `npm run gui:demo` and `npm test` at once in one checkout (both regenerate `gui/paraglide`). Every new test is seen red first. Byte and line budgets are raised only with measured figures, named in the report. UI work goes to the opus model with reference screenshots and a self-review against them (project memory, 2026-10-17).

| Phase | Content | Anchor |
|---|---|---|
| **A. Zen mode** (`feat/zen-mode`; two commits: the lists and the server, then the page and the docs) | Part A whole: `src/views.ts` (`VIEWS` without zen, `MODES = ["zen"]`), `bossviews.ts`, `guiprefs.ts` and the tell note, the `guihost.ts` text, `scripts/vite-themes.ts` (`mode: true`), `boot.js`, `gui/prefs.ts` (`sb.zen` plus legacy), `gui/view.ts` (no `held`), a new `gui/mode.ts`, `gui/viewface.ts` (moves: enter, leave, pick, follow, route), `gui/faces.ts`, `gui/pagecore.ts`, `gui/main.ts`, `gui/index.html`, `gui/style.css` (`.zen-enter`), `zenmenu.ts`, `paletteentries.ts`, `fixture.ts`, messages, docs and twin, the zen-view supersede note | `npm run check`; `npm run gui:build`; `npm run test:one -- tests/view.test.ts tests/viewface.test.ts tests/gui-view.test.ts tests/faces.test.ts tests/pagecore.test.ts tests/prefs.test.ts tests/zen-extras.test.ts tests/palette.test.ts tests/gui-themes.test.ts tests/themes-dist.test.ts tests/gui.test.ts tests/phone-targets.test.ts tests/imports.test.ts tests/twin.test.ts`, plus the new `tests/zen-mode.test.ts` (the A2 migration table, enter, leave, and settings suspend, no live cross-tab switch, the server refusing `zen` and the tell note, the `boot.js` parity over `sb.view` × `sb.zen` × contrast × server). Then `npm test` once. A fresh-context reviewer is required (it changes a shared contract: the server's view values and `gui.json`), and only P0 and P1 block. Then demo screenshots of the header button in each theme and on a phone. |
| **B-1. Palette and day/night** (`feat/storybook`) | `storybook` in `src/views.ts`, `view_storybook`, `gui/themes/storybook/{index.ts,storybook.css,favicon.svg,phase.ts}`, `gui/phase.ts`, the `boot.js` phase and its theme-colours, `view.ts` `THEME.storybook`, the badge per phase and `onShift`, the `--pbs-*` blocks with `color-scheme`, the light-ground audit of the entry CSS, the folder cap | `npm run check`; `npm run gui:build`; `npm run test:one -- tests/storybook-phase.test.ts tests/storybook-contrast.test.ts tests/storybook-theme.test.ts tests/view.test.ts tests/tabicon.test.ts tests/pbs-tokens.test.ts tests/gui-themes.test.ts tests/themes-dist.test.ts tests/imports.test.ts tests/geek-contrast.test.ts tests/raven-contrast.test.ts` (new: the phase table and the boundary timer on a fake clock with the visibility recheck, the `boot.js` phase parity, every text token ≥ 4.5 : 1 on every surface in both phases, no nouns or sentences); screenshots of both phases (map, settings, chat, phone) |
| **B-2. Icons** | `sprite.svg` (10 animals), favicon final | `npm run test:one -- tests/storybook-theme.test.ts tests/imports.test.ts` (ten `storybook-<role>` ids, `currentColor`, sprite ≤ 30 KB, every `iconRef` role present); a demo screenshot of the legend and plates at 16, 20, and 32 px for the boss |
| **B-3. Illustrations** | the two backdrops, the two nooks, the veils, the phone framing | `npm run gui:build`; `npm run test:one -- tests/storybook-contrast.test.ts tests/imports.test.ts tests/themes-dist.test.ts` (text over the sampled brightest and darkest pixels under each veil, per-file caps, the folder ≤ 450 KB, only the shown phase's picture named for a page in that phase); screenshots in both phases |
| **B-4. Motion** | status figures, the day and night ambient layers, calm, reduced, and forced | `npm run test:one -- tests/storybook-motion.test.ts tests/calm.test.ts tests/imports.test.ts` (new, modelled on `raven-motion.test.ts`: Standard's six rules keep their text, Storybook overrides each, keyframes only `transform` and `opacity`, no cycle under 0.8 s, all in the no-preference block outside `data-calm`, distinct still figures); the Chrome trace of §B6 in both phases, in the report |
| **B-5. Sounds** (after the boss picks the clips) | Storybook's question clip and the day and night ambience (`storybook/ambience.ts`), Standard's clip replaced, NOTICE.md, the how-it-works sound lines and twin | `npm run test:one -- tests/sound-split.test.ts tests/notify.test.ts tests/storybook-ambience.test.ts tests/imports.test.ts tests/twin.test.ts` (new: background class only, plays only while the face is storybook, the page is visible, and the backdrop is shown, cross-fade at a boundary on the fake clock, stops on entering Zen, only the shown phase's clip fetched); size and format checks per §C1 (`ffprobe`: mono, duration, bytes); the boss's listening check |
| **B-6. Docs and pictures** | how-it-works Storybook entry and twin, the site guide and commands in both languages, the README screenshots | `npm --prefix site run check`; `cd site && npm ci && npm run build` (every internal link and anchor); `npm run test:one -- tests/twin.test.ts`; then `npm test` once on the merged tree |

The Standard clip swap (in B-5) touches no Storybook file. It may land as its own commit as soon as the boss picks its clip.
