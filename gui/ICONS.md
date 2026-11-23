# Icons

The browser view's icons come from [game-icons.net](https://game-icons.net), licensed [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). The credit also shows in the page itself.

| Used for | Icon | Author | Source |
|---|---|---|---|
| Tower | Control Tower | Delapouite | https://game-icons.net/1x1/delapouite/control-tower.html |
| Head tower | Crown | Lorc | https://game-icons.net/1x1/lorc/crown.html |
| Main agent | Robot Helmet | Delapouite | https://game-icons.net/1x1/delapouite/robot-helmet.html |
| Member | Pawn | Lorc | https://game-icons.net/1x1/lorc/pawn.html |
| Subagent | Delivery Drone | Delapouite | https://game-icons.net/1x1/delapouite/delivery-drone.html |
| Sub workspace (outpost) | Camping Tent | Delapouite | https://game-icons.net/1x1/delapouite/camping-tent.html |
| Pi pane outside the net (unaligned unit) | Hood | Lorc | https://game-icons.net/1x1/lorc/hood.html |
| You, in the comms log | Person | Delapouite | https://game-icons.net/1x1/delapouite/person.html |
| Comms channel, incoming messages | Walkie Talkie | Delapouite | https://game-icons.net/1x1/delapouite/walkie-talkie.html |
| Document tile | Scroll Unfurled | Lorc | https://game-icons.net/1x1/lorc/scroll-unfurled.html |
| Train (a train worker's unit card) | Steam Locomotive | Delapouite | https://game-icons.net/1x1/delapouite/steam-locomotive.html |
| Coordinator main (kind) | Ship Wheel | Delapouite | https://game-icons.net/1x1/delapouite/ship-wheel.html |
| Integrator main (kind) | Join | Delapouite | https://game-icons.net/1x1/delapouite/join.html |
| Standing main (kind) | Lighthouse | Delapouite | https://game-icons.net/1x1/delapouite/lighthouse.html |
| Worker subagent (kind) | Spanner | Lorc | https://game-icons.net/1x1/lorc/spanner.html |
| Scout subagent (kind) | Binoculars | Delapouite | https://game-icons.net/1x1/delapouite/binoculars.html |
| Planner subagent (kind) | Pencil Ruler | Delapouite | https://game-icons.net/1x1/delapouite/pencil-ruler.html |
| Reviewer subagent (kind) | Magnifying Glass | Lorc | https://game-icons.net/1x1/lorc/magnifying-glass.html |
| Watchdog subagent (kind) | Hound | Lorc | https://game-icons.net/1x1/lorc/hound.html |

A unit takes its kind's icon (the eight rows above, `#i-<duty>`) where it has one, and its position's icon (main, member, subagent) where it does not (docs/specs/2026-11-09-agent-kinds.md D16).

Changes: the black background square of each SVG was removed and the fill set to `currentColor`, so state colors apply; the paths are inlined as an SVG sprite in `index.html`. The icon set's license text: https://github.com/game-icons/icons/blob/master/license.txt

## Raven Keep view

The Raven Keep view draws its own icons (`gui/themes/raven/sprite.svg`), original to this project: one ink-engraving sheet made with an image generator (Codex image generation), each icon traced to single-colour SVG with potrace (fill `currentColor`, path text only reformatted). The game-icons credit above stays for Standard's icons, which every view keeps as its fallback. The blood goblet (`raven-main`) and the keep's front (`raven-crown`) were redrawn by hand as bold single paths after their traced designs, so they read at 16 px.

| Used for | Raven Keep icon |
|---|---|
| You, in the comms log | the Count |
| Head tower | the keep (castle) |
| Tower | a steward's key ring |
| Main agent | a hooded spawn |
| Member | a wolf |
| Subagent | a bat |
| Sub workspace (outpost) | a coffin |
| Pi pane outside the net | a ghost |
| Comms channel | a raven |
| Document tile | a tome |

The train and the seven kinds (coordinator, integrator, standing, worker, scout, planner, reviewer) have no Raven Keep twin: the keep shows Standard's icon for them, as it does for any role its sprite does not draw.

The head page's backdrop (`gui/themes/raven/backdrop.webp`) and the raven perched on its gate (`gui/themes/raven/perch.webp`) are raster art made with the same image generator (Codex image generation) for this project, resized and cut; nothing in them is copied.

The tab icons (`gui/themes/<view>/favicon.svg`) are drawn for this project: Zen an ensō, Geek `>_`, Raven Keep the crest (a raven before a shield holding a castle, bone and crimson on near-black). The view's sounds are CC0 clips credited in `NOTICE.md`.
