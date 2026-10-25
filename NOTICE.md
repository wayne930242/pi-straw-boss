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
