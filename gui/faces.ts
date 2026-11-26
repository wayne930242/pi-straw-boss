import type { Face } from "../src/views.ts";

// What each face does beyond its skin, as one table (tests/faces.test.ts): the page reads a row where it used to ask whether Zen is on. The face is a theme, or the mode Zen while it shows (viewface.ts).
/**
 * `count`: the tab icon carries the number of units waiting. `signal`: an arrival is told to the clips and the system notifications (`notify.signal`). `announce`: every arrival is told (`arrivals`), or the layer tells the one item it shows itself (`current`; a click on a system notification then changes nothing).
 * `keys`: Space and F open and enlarge the dialogs (`dialogs`), or Zen's keymap (`zen`: H toggles the item's context, Enter and Space end the pause; hotkeys.ts). `drawer`: the phone's quick-switch drawer. `calm`: the page rests its infinite motion after 30 s. `chime`: a new link notice that needs the boss rings.
 * `escape`: Esc in a field that has text stays in the composer (`stay`), or lets go of the field first and leaves on the next press (`blur`).
 */
export interface Rules { count: boolean; signal: boolean; announce: "arrivals" | "current"; keys: "dialogs" | "zen"; drawer: boolean; calm: boolean; chime: boolean; escape: "stay" | "blur" }
const standard: Rules = { count: true, signal: true, announce: "arrivals", keys: "dialogs", drawer: true, calm: true, chime: true, escape: "stay" };
export const RULES: Record<Face, Rules> = { standard, raven: standard, geek: { ...standard, calm: false }, zen: { count: false, signal: false, announce: "current", keys: "zen", drawer: false, calm: true, chime: false, escape: "blur" } };
/** The rules of the face the page shows. */
export const rulesOf = (face: Face): Rules => RULES[face];
