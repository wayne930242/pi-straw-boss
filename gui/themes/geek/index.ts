// The Geek theme: a stylesheet (geek.css, black, monospace, nothing moves) and the work board's plain words (sentences.ts). It loads the first time a page shows Geek (gui/themes/registry.ts), or boot.js links the stylesheet before the first frame.
import "./geek.css";
import type { ThemeParts } from "../theme.ts";
import { SENTENCES } from "./sentences.ts";

export const theme: ThemeParts = { sentences: SENTENCES };
