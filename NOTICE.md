# Notices

## QR Code generator library (`src/qr.ts`)

Parts of `src/qr.ts` (the module count, the GF(256) multiply, the block interleave) are adapted from Project Nayuki's [QR Code generator library](https://www.nayuki.io/page/qr-code-generator-library).

Copyright (c) Project Nayuki. (MIT License)

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

- The above copyright notice and this permission notice shall be included in
  all copies or substantial portions of the Software.
- The Software is provided "as is", without warranty of any kind, express or
  implied, including but not limited to the warranties of merchantability,
  fitness for a particular purpose and noninfringement. In no event shall the
  authors or copyright holders be liable for any claim, damages or other
  liability, whether in an action of contract, tort or otherwise, arising from,
  out of or in connection with the Software or the use or other dealings in the
  Software.

## Icons

The browser view's icons are credited in [`gui/ICONS.md`](gui/ICONS.md).

## Symbols Nerd Font Mono (`gui/fonts/SymbolsNerdFontMono.woff2`)

The icon font a pane's screen falls back to is Symbols Nerd Font Mono from [Nerd Fonts](https://github.com/ryanoasis/nerd-fonts) 3.5.1, converted to WOFF2 unchanged. The icons inside it come from their own projects under their own licenses, listed in the Nerd Fonts repository.

The MIT License (MIT)

Copyright (c) 2014 Ryan L McIntyre

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Sounds (`gui/sounds/`)

The GUI's sounds come from [Kenney](https://kenney.nl) (www.kenney.nl), released under Creative Commons Zero (CC0 1.0), converted to mono MP3: `waiting.mp3` is `question_002` from Interface Sounds 1.0, `done.mp3` is `confirmation_001` from Interface Sounds 1.0, and `error.mp3` is `lowDown` from Digital Audio.

## BIP-39 English word list (`src/link/bip39-english.ts`)

Straw Link's safety words are drawn from the BIP-39 English word list (2048 words), copied unchanged from [`bip-0039/english.txt`](https://github.com/bitcoin/bips/blob/master/bip-0039/english.txt) in the bitcoin/bips repository (sha256 `2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda`). BIP-39, "Mnemonic code for generating deterministic keys", is by Marek Palatinus, Pavol Rusnak, Aaron Voisine, and Sean Bowe, and its header names the MIT license. The word list is part of Straw Link's protocol, so another implementation has to use the same list.

## Zen view lines

The short lines under the Zen view's idle circle (`gui/zenlines.ts`) are one sentence or less each, shown with their source. Their sources, with the book, page, or chapter of each, are named in the comment above every entry: Thich Nhat Hanh, *Peace Is Every Step* (Bantam, 1991; 橡實文化 for the Chinese); Tara Brach and Mindful.org (mindful.org); Sharon Salzberg (sharonsalzberg.com); 華人正念減壓中心 (mindfulness.com.tw); 陳德中 and 台灣正念工坊 (Firstory); Zen Mind, Beginner's Mind by Shunryu Suzuki (Weatherhill, 1970); and the Japanese works whose originals are shown in small type under a line: Matsuo Bashō (おくのほそ道, haiku), Yosa Buson and Kobayashi Issa (haiku), Kamo no Chōmei (方丈記), Yoshida Kenkō (徒然草), Sei Shōnagon (枕草子), the waka of Fujiwara no Teika (新古今和歌集), Ki no Tomonori (古今和歌集), Yamabe no Akahito (万葉集), and Dōgen (傘松道詠), 利休百首 (Urasenke's text), Ii Naosuke (茶湯一会集), Tanizaki Jun'ichirō (陰翳礼讃), Masaoka Shiki and Natsume Sōseki (haiku), and Taneda Santōka (草木塔); the texts of Aozora Bunko, Wikisource, the Nara Manyo Culture Museum database, and Urasenke are named in the comments. A Chinese line marked `zh: our translation`, and an English line marked `en: our translation`, are ours.

## Raven Keep view (`gui/themes/raven/`)

The Raven Keep (鴉閣) view's art is original to this project. Its ten role icons and its crest favicon were drawn as an ink-engraving sheet with an image generator (Codex image generation) and traced to single-colour SVG with [potrace](https://potrace.sourceforge.net/) (`sprite.svg`, `favicon.svg`); the backdrop illustration (`backdrop.webp`) was made with the same generator and resized; so was the perched raven (`perch.webp`, one strip of two frames, profile and head turned: the head of the second frame is blended onto the body of the first). The chat page's four rooms (`room-study.webp`, `room-hall.webp`, `room-crypt.webp`, `room-library.webp`) are the same generator's pictures, resized to 1280 by 800; the blood goblet (`raven-main`) and the keep's front (`raven-crown`) in the sprite were redrawn by hand as bold single paths after their traced designs, so they read at 16 px. The Zen ensō and Geek `>_` tab icons (`gui/themes/zen/favicon.svg`, `gui/themes/geek/favicon.svg`) are drawn for this project. Nothing in them is copied from a published setting.

Its three sounds are released under Creative Commons Zero (CC0 1.0), trimmed and converted to mono MP3 (`sounds/`):

- `caw.mp3`, a crow's caw: "crow caw" by zeroisnotnull, https://opengameart.org/content/crow-caw
- `bell.mp3`, one church-bell strike, trimmed to 1.5 s with a fade: "Church bell" by kgeshev, https://freesound.org/people/kgeshev/sounds/378799/
- `door.mp3`, an old wooden door creaking: "An old wooden door creaking" by soundofsong, https://freesound.org/people/soundofsong/sounds/647646/

## pi-better-show (`dist/gui/assets/blockschunk-*.js`)

The GUI's block chunk bundles [pi-better-show](https://github.com/wayne930242/pi-better-show) 0.5.0 (its parser, its answer encoding, and its fourteen elements), and with it the [yaml](https://github.com/eemeli/yaml) library 2.9.1.

pi-better-show: MIT License, Copyright (c) 2026 wayne930242

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

yaml: ISC License, Copyright Eemeli Aro <eemeli@gmail.com>

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.

## Role definitions (`roles/`)

The role pack in `roles/` (docs/specs/2026-11-09-agent-kinds.md §9) is derived from two sources.

- `roles/worker.md`, `roles/scout.md`, `roles/reviewer.md`, `roles/visual-tester.md`, and `roles/adversarial-reviewer.md` start from the role overrides of [weihung-basic-agent](https://github.com/wayne930242/weihung-basic-agent) (`agents/`), MIT License, Copyright (c) 2026 wayne930242. Those overrides in turn derive from the pi-herdr-roles definitions below.
- `roles/planner.md` derives from [pi-herdr-roles](https://www.npmjs.com/package/pi-herdr-roles) 0.1.0 `roles/planner.md` alone.
- `roles/watchdog.md` is Straw Boss's own, derived from neither source.

pi-herdr-roles' role definitions were moved from [giuseppecrj/pi-herdr-agents](https://github.com/giuseppecrj/pi-herdr-agents) at commit `c2177dff835da44937e614e8a03d0405d442e848`, whose MIT notice is retained from its upstream lineage, [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents) and [0xRichardH/pi-herdr-subagents](https://github.com/0xRichardH/pi-herdr-subagents). pi-herdr-roles 0.1.0 carries this notice:

```text
MIT License

Copyright (c) 2026 HazAT

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
