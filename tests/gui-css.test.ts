import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { declarations, rulesOf } from "./css-rules.ts";

// What the page's style sheet must keep (no browser runs here): the hidden slash menu stays hidden, the selected pair tab is shown by more than colour,
// and text boxes and menus are themed.
const css = readFileSync(new URL("../gui/style.css", import.meta.url), "utf8");
const rule = (selector: string) => css.split("\n").flatMap((line) => (line.includes(selector) ? [line] : [])).join("\n");
// Geek's rules live in its theme file (gui/themes/geek/geek.css), loaded after this sheet; the entry sheet holds none of them.
const geekCss = readFileSync(new URL("../gui/themes/geek/geek.css", import.meta.url), "utf8");
const geekRule = (selector: string) => geekCss.split("\n").flatMap((line) => (line.includes(selector) ? [line] : [])).join("\n");

test("`.slash[hidden]` is display none", () => {
	assert.match(css, /\.slash\[hidden\]\s*\{\s*display:\s*none/);
});

test("the wait panel's answer box in Standard and Geek is the composer's box: themed, 44 px, 16 px on a touch screen (no zoom), with its form and its hidden buttons obeying `hidden`", () => {
	const box = rulesOf(css).find((r) => r.parts.includes('html:not([data-view="zen"]) .wait-box'));
	assert.ok(box, "Standard's box rules leave Zen out: Zen draws the box as its own input, with no frame and no glow");
	assert.equal(rulesOf(css).filter((r) => r.parts.some((p) => /\.wait-box\b/.test(p) && !p.includes('html:not([data-view="zen"])')) && !r.parts.includes(".composer textarea")).length, 0, "no rule on the box reaches Zen but Zen's own (and the touch screen's 16 px, which Zen's 1 rem already is)");
	const decl = declarations(box!.body);
	assert.ok(decl.some(([p, v]) => p === "min-height" && v === "44px") && decl.some(([p, v]) => p === "background" && v === "var(--sunken)"));
	assert.match(css, /@media \(pointer: coarse\) \{[^}]*\.wait-box[^}]*\{ font-size: 16px; \}/);
	assert.match(css, /\.wait-form\[hidden\] \{ display: none; \}/);
	assert.match(css, /\.wait-panel \.pair-btn\[hidden\] \{ display: none; \}/);
});

test("the selected pair tab has a fill and a heavier weight, for `.on` and `aria-selected`", () => {
	const line = rule('.pair-tabs .later[aria-selected="true"]');
	assert.match(line, /\.pair-tabs \.later\.on/);
	assert.match(line, /font-weight:\s*700/);
	assert.match(line, /background:\s*color-mix/);
});

test("the server's facts are a two-column grid and text boxes and menus are themed", () => {
	assert.match(rule(".server-facts {"), /display:\s*grid;\s*grid-template-columns:\s*max-content/);
	assert.match(css, /:where\(input:not\([^)]*\), select\)\s*\{[^}]*background:\s*var\(--surface-0\)/);
});

test("the boss-conversation bar has padding and its phrases wrap as units", () => {
	assert.match(rule(".tower-conv { display: grid"), /padding:\s*8px 10px/);
	assert.match(rule(".tower-conv .conv-line > span"), /display:\s*inline-block/);
});

test("the settings' View control wraps, and a server default gives the long Auto button (Follow server (geek)) a row of its own", () => {
	assert.match(css, /\.view-pick > div \{ flex-wrap: wrap; \}/);
	assert.match(css, /\.view-pick\[data-following\] button\[data-choice="auto"\] \{ flex-basis: 100%; \}/);
});

test("the drawer marks its current unit by a tint and a chevron, never by coloured side stripes", () => {
	const lines = css.split("\n").filter((line) => line.includes(".drawer .unit.current"));
	assert.ok(lines.length > 0);
	for (const line of lines) assert.doesNotMatch(line, /inset\s+-?\d+px\s+0\s+var\(--c\)/, "an inset stripe on one side");
	assert.match(rule(".drawer .unit.current > .card {"), /background:\s*var\(--c1\)/);
	assert.match(rule(".drawer .unit.current > .card > .hit::after"), /content:\s*"›"/);
});

test("a finished card's Dismiss takes its own row on a phone, and a question's card says when more lies below", () => {
	assert.match(rule(".base .card > .quit-btn:not([hidden]) {"), /flex:\s*1 1 100%/);
	assert.match(rule(".base .card:has(> .quit-btn:not([hidden]))"), /flex-wrap:\s*wrap/);
	assert.match(rule(".comms-in .ask[data-more] .ask-acts::before"), /content:\s*attr\(data-cue\)/);
	assert.match(rule(".comms-in .ask-opts"), /max-height:\s*none/);
});

test("the 'More below' cue sits in the Send row, never absolutely over option text; the 360 placeholder is small and its hint short", () => {
	const cue = /ask-acts::before \{[^}]*\}/.exec(rule(".comms-in .ask[data-more] .ask-acts::before"))![0];
	assert.doesNotMatch(cue, /position:\s*absolute/);
	assert.match(cue, /flex:\s*1 1 100%/);
	assert.match(css, /@media \(max-width: 380px\) \{\s*\n\s*\.composer textarea::placeholder \{ font-size: 12px/);
	const en = JSON.parse(readFileSync(new URL("../gui/messages/en.json", import.meta.url), "utf8"));
	assert.ok(en.blocked_answer_above.length <= 22, "fits one 12px monospace line in the 360 px one-row box");
});

test("forced colors: disabled controls and placeholders take GrayText, and the map's connectors are left out", () => {
	const block = css.slice(css.indexOf("@media (forced-colors: active)"));
	assert.match(block, /:is\(\.composer, \.ask\) button:disabled\s*\{[^}]*GrayText/);
	assert.match(block, /::placeholder\s*\{\s*color:\s*GrayText/);
	assert.match(block, /\.links, \.packets \{ display: none/);
});

test("Geek: a disabled Send is dim words in a dashed outline, a focused timeline tick has a ring, and the settings page drops the bar's chips", () => {
	assert.match(geekRule('[data-view="geek"] :is(.composer, .ask) button:disabled'), /opacity:\s*1[^}]*dashed/);
	assert.match(geekRule('[data-view="geek"] .tl-mark:focus-visible'), /outline:\s*2px solid var\(--text\)/);
	assert.match(rule('body[data-route="settings"]'), /display:\s*none/);
});

test("a question card's Cancel is a 44 px target on a phone, quieter than Send, and shares Send's press feedback", () => {
	assert.match(rule(".ask-cancel {"), /border:\s*1px solid var\(--line\)[^}]*background:\s*none/);
	assert.match(css, /@media \(max-width: 640px\) \{[\s\S]*?\.ask-send, \.ask-cancel, \.ask-opt[^{]*\{ min-height: 44px; \}/);
	assert.match(css, /@media \(max-width: 640px\) \{[\s\S]*?\.ask-send, \.ask-cancel, \.sheet-yes, \.cmp-yes\) \{ min-width: 44px; \}/);
	assert.match(css, /:is\(\.ask, \.term-bar, \.doc-acts, \.composer\) :is\(button, \.cmp-link\) \{ min-height: 44px; \}/, "and the narrow rule covers every button in the card");
});

test("the settings column keeps one width: auto side margins never shrink it to its content in the stacked (column) layout, and its Go buttons drop the UA border", () => {
	const column = rule(".settings.view {");
	assert.match(column, /margin-inline:\s*auto/);
	assert.match(column, /(^|[\s;{])width:\s*100%/, "auto margins turn off a column flex item's stretch; the explicit width keeps it full");
	assert.match(column, /max-width:\s*760px/);
	assert.match(rule(".teams-tile .go {"), /border:\s*0/);
});

const zen = readFileSync(new URL("../gui/zen.css", import.meta.url), "utf8");

test("Zen's first frame in style.css is scoped to the Zen view, so Standard and Geek keep their rules: the breathing ring, its calm still, and its keyframes are the only additions", () => {
	for (const line of css.split("\n").filter((l) => /zen-breath|#zen:empty/.test(l))) assert.match(line, /data-view="zen"|@keyframes zen-breath/, line.slice(0, 80));
	assert.match(css, /#zen:empty:not\(\[hidden\]\)::after \{[^}]*animation: zen-breath 10s infinite/);
	assert.match(css, /\[data-view="zen"\]\[data-calm\] #zen:empty:not\(\[hidden\]\)::after \{ animation: none; \}/);
	assert.match(css, /40% \{ transform: scale\(1\)/, "4 s in of the 10 s breath");
	assert.ok(!/zen/.test(geekCss), "nothing of Zen's in the Geek theme");
});

test("zen.css: the visual language (Z-D15): no boxes, selection is light with a dot, the seal marks only the keys and never as a ring around a box, overlays let the page recede", () => {
	const at = zen.indexOf("The visual language (Z-D15");
	assert.ok(at > 0, "the block");
	const v = zen.slice(at, zen.indexOf("@media (prefers-reduced-motion: reduce) { [data-view=\"zen\"] .zen-ripples", at));
	assert.match(v, /\.zen-card button\.ask-opt \{ display: grid;[^}]*row-gap: 0;[^}]*border: 1px solid transparent;[^}]*background: transparent;/, "a choice is a line, not a pill");
	assert.match(v, /\.zen-card button\.ask-opt::before \{ content: "";[^}]*border-radius: 50%;/, "with a dot before it");
	assert.match(v, /\.ask-opt\[aria-checked="true"\]::before \{ border-color: var\(--zen-paper\); background: var\(--zen-paper\); \}/, "the dot fills when chosen");
	assert.match(v, /button\.ask-opt:is\(:hover:not\(:disabled\), :focus-visible\) \{ border-color: transparent; background: transparent; color: color-mix\(in srgb, var\(--zen-paper\) 80%, white\);/, "a lit choice is a brighter word, not a filled box (Z-D15)");
	assert.match(v, /button\.ask-opt:focus-visible::before \{ border-color: var\(--zen-seal\);/, "the keys ring the dot, inside the line");
	assert.match(v, /#zen :is\([^)]*\.ask-send[^)]*\):focus-visible \{ outline: none; text-decoration: underline 1px var\(--zen-seal\)/, "a button the keys are on is underlined in seal, not ringed");
	assert.match(v, /:is\(\.zen-card \.ask-own, \.composer textarea, \.tcard-input\) \{ border: 1px solid transparent; border-bottom-color: var\(--zen-line\); border-radius: 0; background: transparent;/, "a text field is one line under the words");
	assert.match(v, /#zen :is\([^)]*\.palette-box\):focus-visible \{ outline: none; border-radius: 0;/, "and its focus beats the page-wide ring");
	assert.match(v, /:is\(\.ask-send, \.cmp-send, \.cmp-yes, \.pad-yes, \.tcard-go, \.zen-term-back\) \{ border-color: transparent; background: transparent;/, "Send is a word");
	assert.match(v, /\.zen-log \.bubble \{ padding-inline: 0; background: transparent; color: var\(--zen-ash\); \}/, "what you said: at the right, in ash, no ground (the boss's pick)");
	assert.match(v, /\.palette-back \{ background: var\(--zen-veil\);[^}]*(?<!-)backdrop-filter: blur\(10px\);/, "the palette's page recedes (the unprefixed property, not only -webkit-)");
	assert.match(v, /\.palette-panel \{[^}]*border-color: transparent; background: transparent;/, "and the palette has no panel");
	assert.match(v, /:is\(\.zen-menuhost:has\(> \.zen-menu:not\(\[hidden\]\)\), \.zen-musichost:has\(> \.zen-musicpanel:not\(\[hidden\]\)\)\)::before \{ content: ""; position: fixed; inset: 0;[^}]*pointer-events: auto;/, "the menu and the music list lay the same veil, which takes the press that closes them (ZVL-F002)");
	assert.match(v, /\.zen-term-host :is\(\.pad-yes, \.tcard-go\) \{ border-color: transparent; background: transparent; color: var\(--zen-paper\);/, "the terminal layer's yes is a word, over its pill rule (ZVL-F001)");
	assert.match(v, /\.zen-term-host :is\(\.pad-no, \.tcard-mask\) \{ border-color: transparent; background: transparent; color: var\(--zen-ash\); \}/, "and its no is the quieter word");
	assert.match(v, /\.zen-term-host :is\(\.pad-yes, \.tcard-go\):hover:not\(:disabled\) \{ background: var\(--zen-glow\); \}/, "its hover is the glow, not the warm pill");
	assert.doesNotMatch(zen, /\.zen-term-host[^{]*\{[^}]*background: var\(--zen-warm\)/, "no older term-host rule fills a pair button with the warm ground (a mask[aria-pressed] in its :is outranked the block)");
	assert.match(v, /:is\(\.zen-menu, \.zen-musicpanel\) \{ border-color: transparent; background: transparent;/);
	assert.match(zen.slice(zen.indexOf("@media (forced-colors: active) {\n")), /^\t\[data-view="zen"\] \.zen-card \.ask-opt\[aria-checked="true"\]::before \{ forced-color-adjust: none; border-color: Highlight; background: Highlight; \}/m, "forced colours keeps the chosen dot (ZVL-F003)");
	assert.doesNotMatch(zen, /\.zen-company \.composer textarea \{ border: 0/, "the companion's box is a transparent border with a line under it, not border 0 (ZVL-F004)");
	assert.doesNotMatch(v, /border: 0[;\s]|border: none/, "borders turn transparent, never go: forced colours draws them");
	assert.doesNotMatch(v, /rgba?\(|#[0-9a-f]{3,8}\b/i, "the block's colours are the ink tokens");
});

test("zen.css: every rule is under the Zen view, the answer card has no Standard chrome, targets are 44 px, and motion keeps breathing at rest (Z-D13) and stills under reduced motion and forced colours", () => {
	const body = zen.replace(/\/\*[\s\S]*?\*\//g, "");
	for (const sel of body.matchAll(/^(\[data-view="zen"\][^{]*|@[^{]*)\{/gm)) assert.ok(sel[1]!.includes('data-view="zen"') || sel[1]!.startsWith("@"), sel[1]);
	assert.ok(!/(^|\n)(?!\s|\[data-view|@|\}|--)\S/.test(body.replace(/@keyframes[^{]*\{[\s\S]*?\}\s*\}|@keyframes[^{]*\{[^}]*\}/g, "")), "no rule outside the Zen view");
	assert.match(zen, /\.zen-(fs|menubtn)[^{]*\{ width: 44px; height: 44px;/, "the corner controls are 44 px");
	assert.match(zen, /\.zen-row \{[^}]*min-height: 44px/, "and the menu's rows");
	assert.match(zen, /\.zen-opt[^{]*\{ min-width: 44px; min-height: 44px;/);
	assert.ok(!/\[data-calm\]/.test(zen.replace(/\/\*[\s\S]*?\*\//g, "")), "calm stills nothing in Zen: the circle and the ground keep breathing (Z-D13)");
	assert.match(zen, /\.zen-stage:has\(\.zen-company\) > \.zen-circle \{[^}]*animation-name: zen-breath-low;/, "the circle breathes behind the companion's log");
	assert.match(zen, /\.zen-stage:has\(\.zen-company \.zen-rest\) > \.zen-circle \{[^}]*animation: none;[^}]*filter: blur\(\d+px\);[^}]*border-color: transparent;/, "the head's history veils the circle: blurred, its ring gone, so no line crosses the words");
	assert.match(zen, /\.zen-company:has\(\.zen-rest\) \.zen-log :is\(\.notice, \.act\) \{ border: 0; background: transparent; \}/, "the head's history has no boxes: a tower's answer is quiet type");
	assert.match(zen, /\.zen-company:has\(\.zen-rest\) \.zen-log \.act code \{[^}]*text-transform: none;/, "and a tool row is no capitals");
	assert.match(zen, /@keyframes zen-breath-low \{ 0% \{ transform: scale\(0\.72\)[^}]*\} 40% \{ transform: scale\(1\)/);
	assert.match(zen, /\.zen-drift i:last-child \{[^}]*animation: zen-tide 30s[^;]*, zen-wander 47s/, "the ground's tide is half a minute, and it wanders");
	assert.match(zen, /@keyframes zen-wander \{ from \{ transform: translate3d\(/, "the wander moves by transform alone");
	assert.match(zen, /animation: zen-wash 24s/, "the washes drift within half a minute");
	assert.match(zen, /\.zen-log :is\(\.tx-body, \.bubble, details\.act, \.thought, \.more, pre, th, td, \.pic\) \{ border-color: transparent;/, "the companion's log has no boxes");
	assert.match(zen, /\.zen-log :is\(\.thought, \.more\)::before \{ border-color: transparent; \}/, "nor the outline a touch screen draws on ::before");
	assert.match(zen, /\.zen-company \.composer textarea \{ border: 1px solid transparent; border-bottom-color: var\(--zen-line\)/, "its composer is one line");
	assert.match(zen, /@media \(prefers-reduced-motion: reduce\)/);
	assert.match(zen, /@media \(forced-colors: active\)[\s\S]*\.zen-drift[\s\S]*CanvasText/);
	assert.match(zen, /:focus-visible \{ outline: 2px solid var\(--zen-seal\)/, "a visible focus ring");
	assert.match(zen, /\.zen-card-in > \* \{ animation: zen-in 1\.8s/, "the card's parts arrive slowly, one after another");
	assert.ok(!/transition:[^;}]*\b(height|width|max-height|all)\b/.test(zen) && !/animation[^;}]*\b(height|width)\b/.test(zen), "no height or width animation anywhere on a Zen card: it takes its size at once");
	assert.match(zen, /@keyframes zen-in \{ from \{ opacity: 0; \} \}/, "a card's parts arrive by opacity alone");
	assert.match(zen, /\.zen-card \[data-fade\] \{ animation: zen-fade 0\.3s/, "a swap of what the card holds fades in over a short moment");
	assert.match(zen, /prefers-reduced-motion: reduce\) \{[^\n]*\.zen-card-in > \*, \[data-view="zen"\] \.zen-card \[data-fade\] \{ animation: none; \}/, "and under reduced motion nothing fades");
	assert.match(zen, /animation-delay: calc\(var\(--n, 0\) \* 0\.22s\)/);
	assert.match(zen, /\.zen-log \.chat-scroll \{ overscroll-behavior: contain; touch-action: pan-y; \}/, "the log scrolls itself only: nothing chains to the page, a finger moves it up and down");
	assert.match(zen, /\.zen-card \{ overscroll-behavior: contain; \}/);
	assert.match(zen, /\.chat-pill \{ border: 1px solid var\(--zen-line\); background: var\(--zen-warm\); color: var\(--zen-paper\);/, "the log's pill is paper on warm (7 : 1, tests/zen-contrast.test.ts), not paper on paper");
	assert.match(zen, /#zen \{ overscroll-behavior: none; \}/, "no pull-to-refresh or history swipe from the layer");
	assert.match(readFileSync(new URL("../gui/style.css", import.meta.url), "utf8"), /html\[data-view="zen"\], html\[data-view="zen"\] body \{[^}]*overscroll-behavior: none;/, "nor from the page under it, from the first frame");
	assert.ok(!/\.zen-(header|bar|nav)\b/.test(zen) && !/zen-nothing/.test(zen));
});

test("the key pad's confirm buttons are one pair in Standard and Geek: one box rule for both (the same height, a border, 12 px words), the yes filled with --amber and its --ink words, the no outlined, and both 44 px on a phone", () => {
	const both = rulesOf(css).find((r) => r.parts.some((p) => p === ".pad-yes, .pad-no" || (p === ".pad-yes" && r.parts.includes(".pad-no"))));
	assert.ok(both, "one rule holds both");
	const d = Object.fromEntries(declarations(both.body));
	assert.equal(d["min-height"], "34px");
	assert.match(d.border ?? "", /^1px solid/);
	assert.match(d.font ?? "", /^600 12px/);
	const yes = rulesOf(css).find((r) => r.parts.length === 1 && r.parts[0] === ".pad-yes");
	assert.ok(yes && /background: var\(--amber\)/.test(yes.body) && /color: var\(--ink\)/.test(yes.body), "filled, with the ink on the fill");
	assert.match(css, /\(pointer: coarse\) \{ \.pad-key, \.pad-yes, \.pad-no[^{]*\{ min-height: 44px; \}/);
	assert.ok(!/\.pad-yes[^{]*\{[^}]*text-decoration/.test(css), "no link underline on either");
});

test("the terminal card is the dock's other box: a dialog's box rules, the confirm pair's box for its mask and Send, 44 px targets and a bottom sheet on a phone, flat in Geek, ink in Zen with no header", () => {
	const box = rulesOf(css).find((r) => r.parts.includes(".dialog") && r.parts.includes(".tcard") && r.body.includes("border-radius: 18px"));
	assert.ok(box, "the card is drawn as a dialog is");
	const pair = rulesOf(css).find((r) => r.parts.includes(".pad-yes") && r.parts.includes(".pad-no"));
	assert.ok(pair?.parts.includes(".tcard-mask") && pair.parts.includes(".tcard-go"), "its buttons are the confirm pair's box: one height, one border, 12 px words");
	assert.match(css, /\.tcard-go \{[^}]*background: var\(--amber\); color: var\(--ink\)/, "the one that sends is filled");
	assert.match(css, /\.tcard-mask \{ background: transparent/, "the mask toggle is outlined");
	assert.match(css, /\(pointer: coarse\) \{ \.pad-key, \.pad-yes, \.pad-no, \.tcard-mask, \.tcard-go, \.tcard-input, \.tcard \.x, \.tcard-full \{ min-height: 44px; \}/, "44 px targets, in the pad's phone rule");
	assert.match(css, /@media \(max-width: 640px\) \{ \.tcard \{[^}]*env\(safe-area-inset-bottom\)/, "a sheet clear of the home bar");
	assert.match(css, /\.dock > \.dialog \{ z-index: 1; \}/, "a dialog opened over the card covers it");
	assert.match(geekCss, /\[data-view="geek"\] :is\([^)]*\.tcard[^)]*\) \{ background: var\(--surface-0\); \}/, "flat in Geek");
	assert.match(css, /forced-colors: active\) \{[\s\S]*\.tcard \{ border: 1px solid CanvasText; \}/);
	assert.match(zen, /\.tcard > header \{ position: absolute;[^}]*clip-path/, "Zen's layer names the unit: the card's header is for readers only");
	assert.match(zen, /\.zen-term-host :is\(\.pad-yes, \.pad-no, \.tcard-mask, \.tcard-go\) \{ min-height: 44px/);
	assert.match(zen, /prefers-reduced-motion: reduce\) \{ \[data-view="zen"\] \.tcard \{ animation: none; \} \}/);
});

test("the terminal card's input label is only for screen readers, in every view: no rule shows it", () => {
	const zen = readFileSync(new URL("../gui/zen.css", import.meta.url), "utf8");
	const own = (text: string) => text.split("\n").flatMap((line) => line.match(/[^{}]*\.tcard-label[^{]*\{[^}]*\}/g) ?? []);
	const rules = [...own(css), ...own(zen)];
	assert.equal(rules.length, 1, "one rule names it");
	assert.match(rules[0]!, /position:\s*absolute[^}]*width:\s*1px[^}]*height:\s*1px[^}]*clip-path:\s*inset\(50%\)/);
	assert.doesNotMatch(css + zen, /tcard-row:focus-within/, "nothing reveals it on focus");
});

// Zen Z7 layout fixes: each of these was a defect seen in the demo's pictures at 390 x 844, 844 x 390, or 1280 x 800.
const zenRule = (needle: string) => rulesOf(zen).filter((r) => r.parts.some((p) => p.includes(needle)));

test("Zen: the log is the positioned box of its jump-to-latest pill, so the pill sits above the composer", () => {
	const log = zenRule(".zen-log").find((r) => r.parts.includes('[data-view="zen"] .zen-log'))!;
	assert.match(log.body, /position:\s*relative/);
	assert.match(css, /\.chat-root \{ position: relative/, "Standard's own place for the pill is unchanged");
});

test("Zen: a choice is never squeezed below its label and description, and the list scrolls instead", () => {
	assert.match(zenRule(".zen-card .ask-opts").map((r) => r.body).join(";"), /grid-auto-rows:\s*max-content/);
});

test("Zen: the open history leaves the item whole and takes the room that is left", () => {
	const open = ':has(.zen-history:not([hidden]))';
	const rules = rulesOf(zen).filter((r) => r.selector.includes(open));
	const body = (needle: string) => rules.filter((r) => r.selector.includes(needle)).map((r) => r.body).join(";");
	assert.match(body(".zen-answer"), /flex:\s*none/);
	assert.match(body(".ask > :not"), /overflow:\s*visible/);
	assert.match(body(".ask > :not"), /mask-image:\s*none/, "no soft edge over the question's subtitle");
	assert.match(body(".zen-history"), /flex:\s*1 1 12rem[^}]*min-height:\s*12rem/);
});

test("Zen: the pause's circle and the item's card take the focus without a ring, and the circle stays round", () => {
	const ring = rulesOf(zen).filter((r) => r.selector.includes(".zen-circle, .zen-card):focus-visible"));
	assert.equal(ring.length, 1);
	assert.match(ring[0]!.body, /outline:\s*none/);
	assert.match(zenRule(".zen-circle:focus-visible").map((r) => r.body).join(";"), /border-radius:\s*50%/);
});

test("Zen: a trust list is centred without bullets, and the companion's name has the line below the strip", () => {
	assert.match(zenRule(".trust-group ul").map((r) => r.body).join(";"), /list-style:\s*none/);
	assert.match(zenRule(".zen-company > header").map((r) => r.body).join(";"), /padding:\s*24px 100px 0 0/);
});

test("Zen: on a phone the status strip stands at the left, clear of the corner buttons", () => {
	const narrow = /@media \(max-width: 640px\) \{[^@]*\.zen-strip \{[^}]*left:\s*max\(12px[^}]*translate:\s*none[^}]*max-width:\s*calc\(100vw - 190px\)/;
	assert.match(zen, narrow);
});

test("Zen: a page under 900 px high and one under 600 px wide spend less on air before a question's choices scroll", () => {
	const media = (q: string) => zen.slice(zen.indexOf(`@media (${q}) {`)).split(/\n\}/)[0]!;
	assert.match(media("max-height: 900px"), /\.zen-card-in \{ gap: 10px/);
	assert.match(media("max-height: 900px"), /button\.ask-opt \{ padding-block: 7px/);
	assert.match(media("max-width: 600px"), /\.zen-card-in \{ gap: 6px/);
	assert.match(media("max-width: 600px"), /button\.ask-opt \{ padding: 6px 16px; font-size: 1rem/);
	assert.match(media("max-width: 600px"), /\.ask-opt small \{ font-size: 0\.78rem/);
});

test("Zen's wait card buttons are 44 px text buttons with the vermilion underline on keyboard focus, not Standard's pills", () => {
	const css = readFileSync(new URL("../gui/zen.css", import.meta.url), "utf8");
	assert.match(css, /\.zen-skip, \.zen-card \.cmp-link, \.wait-panel \.pair-btn\) \{ text-transform: none; min-height: 44px/);
	assert.match(css, /\.wait-panel \.pair-btn,[^{]*\):focus-visible \{ outline: none; text-decoration: underline 1px var\(--zen-seal\)/);
});

test("Zen's wait buttons rest as the card's quiet text buttons (no underline) and only keyboard focus draws the vermilion line", () => {
	const css = readFileSync(new URL("../gui/zen.css", import.meta.url), "utf8");
	assert.match(css, /\.zen-skip, \.zen-card \.cmp-link, \.wait-panel \.pair-btn, [^{]*\) \{ border-color: transparent; background: transparent; color: var\(--zen-ash\); text-decoration-color: transparent/);
});

test("the head's lines still reach their rest level under reduced motion: style.css stills every animation except theirs, and theirs is a step whose delay the script sets, so no !important shorthand may reset it", () => {
	assert.match(css, /prefers-reduced-motion: reduce\) \{ \*:not\(\.zen-hl\), \*::before, \*::after \{ animation: none !important;/, "the global rule leaves the head's lines out");
	const reduced = zen.slice(zen.indexOf("@media (prefers-reduced-motion: reduce) { /* no fade"), zen.indexOf("@media (forced-colors: active) { /* the lines"));
	assert.match(reduced, /\[data-view="zen"\] \.zen-hl \{ animation: zen-head-step 0\.01s steps\(1\) both; transition: none; \}/, "a step, and the lift (the hover's) lands at once");
	assert.match(zen, /@keyframes zen-head-step \{ to \{ --fade: 0\.16; \} \}/);
	assert.ok(!/!important/.test(reduced), "an important animation shorthand would set the delay back to 0 over the inline one");
	assert.doesNotMatch(reduced, /animation: none/, "hover, focus, a tap and a hold lift the line (--lift: 1 still applies, with no motion); they never stop the animation");
});

test("the Whole conversation link's key (\"· H\") is the input hint's quiet ash, no box and no vermilion, and a touch screen (no keyboard) does not show it", () => {
	const key = rulesOf(zen).find((r) => r.parts.includes('[data-view="zen"] .zen-head-key'));
	assert.deepEqual(declarations(key!.body), [["color", "var(--zen-ash)"], ["opacity", "0.35"], ["transition", "opacity 0.4s var(--zen-ease)"]], "the same ash at the same 0.35 as the folded input's hint");
	assert.match(zen, /@media \(pointer: coarse\), \(hover: none\) \{ \[data-view="zen"\] \.zen-head-key \{ display: none; \} \}/, "no key on a touch screen");
	assert.match(zen, /\.zen-head-history:is\(:hover, :focus-visible\) \.zen-head-key \{ opacity: 1; \}/, "it comes up with the link, as the hint does");
	for (const file of ["en", "zh-TW"]) assert.equal(JSON.parse(readFileSync(new URL(`../gui/messages/${file}.json`, import.meta.url), "utf8")).zen_head_key, "· H", `${file} has the key's words`);
});

test("a wait card's answer box is the head strip's input in the card: the same hairline box (vermilion underline on focus) at the card's full width, and its unfolded buttons obey `hidden`", () => {
	const box = rulesOf(zen).find((r) => r.parts.includes('[data-view="zen"] .zen-head-box'));
	assert.ok(declarations(box!.body).some(([p, v]) => p === "border-bottom-color" && v === "var(--zen-line)"), "the box has the hairline, no frame");
	assert.match(zen, /\.zen-head-box:focus-visible \{ outline: none; border-radius: 0; border-bottom-color: var\(--zen-seal\); \}/, "and the vermilion underline on focus");
	assert.match(zen, /\.zen-answer \.wait-panel \.zen-head-form \{ flex: 1 1 100%; width: 100%; text-align: left; \}/, "full width under the question");
	assert.match(zen, /\.wait-panel \.pair-btn\[hidden\] \{ display: none; \}/);
});

test("the folded hint keeps its square corners when focused: the page-wide focus rule (specificity 1,2,0) gives a focused control 8px, which curls the hairline up at both ends", () => {
	const wide = rulesOf(zen).find((r) => r.parts.includes('[data-view="zen"] #zen :focus-visible'));
	assert.match(wide!.body, /border-radius: 8px/, "the rule the hint has to beat");
	const hint = rulesOf(zen).filter((r) => r.parts.includes('[data-view="zen"] #zen .zen-head-hint:focus-visible'));
	assert.equal(hint.length, 1, "a focus rule of the hint's own, with the id in it so it outranks the page-wide one");
	assert.deepEqual(declarations(hint[0]!.body), [["border-radius", "0"]]);
});

test("the strip's two swaps move: hover, focus, and a tap ease the lines to clear and back over Zen's 0.6 s curve, and the mindfulness line fades out and in; neither restarts the fade's clock", () => {
	assert.match(zen, /@property --fade \{ syntax: "<number>"; inherits: false; initial-value: 1; \}/);
	assert.match(zen, /@property --lift \{ syntax: "<number>"; inherits: false; initial-value: 0; \}/, "a registered property is the only thing a transition can ease here: the animation owns --fade");
	const line = rulesOf(zen).find((r) => r.parts.includes('[data-view="zen"] .zen-hl'));
	assert.equal(declarations(line!.body).find(([p]) => p === "transition")?.[1], "--lift 0.6s var(--zen-ease)", "the lines ease in and out on Zen's own curve");
	const lifts = rulesOf(zen).filter((r) => r.body.includes("--lift: 1"));
	assert.equal(lifts.length, 2, "the hover rule and the held rule");
	assert.ok(lifts.every((r) => !/animation/.test(r.body)), "no hover rule resets or removes the animation");
	const mind = rulesOf(zen).find((r) => r.parts.includes('[data-view="zen"] .zen-line[data-away]'));
	assert.deepEqual(declarations(mind!.body), [["opacity", "0"], ["visibility", "hidden"], ["transition", "opacity 0.6s var(--zen-ease), visibility 0s linear 0.6s"]], "away: faded out, then out of the reading order once it is gone; a layout that does not move");
	assert.match(zen, /\.zen-line \{[^}]*transition: opacity 1\.6s var\(--zen-ease\), visibility 0s;/, "and back at the line's own slow pace");
	assert.doesNotMatch(zen, /\.zen-line\[hidden\]/, "the line is never taken out of the layout");
	const link = rulesOf(zen).find((r) => r.parts.includes('[data-view="zen"] .zen-head-history[data-away]'));
	assert.deepEqual(declarations(link!.body), [["opacity", "0"], ["visibility", "hidden"], ["transition", "opacity 0.6s var(--zen-ease), visibility 0s linear 0.6s"]], "the Whole conversation link fades the same way, so the strip does not jump when the lines come clear");
});

test("the cue that says a card waits for Enter (Z-D19) has a row of its own under the link in every state, keeps its room when there is none, is a 44 px control, and moves not at all under reduced motion", () => {
	const away = rulesOf(zen).find((r) => r.parts.includes('[data-view="zen"] .zen-head-cue[data-away]'));
	assert.deepEqual(declarations(away!.body), [["opacity", "0"], ["visibility", "hidden"], ["transition", "opacity 0.6s var(--zen-ease), visibility 0s linear 0.6s"]], "with no card it fades away and keeps its room: the circle and the lines never move when a card comes or goes");
	const meta = rulesOf(zen).find((r) => r.parts.includes('[data-view="zen"] .zen-head-meta'));
	assert.deepEqual(declarations(meta!.body).filter(([k]) => k === "grid-template-rows"), [["grid-template-rows", "minmax(44px, auto) minmax(44px, auto)"]], "two rows of at least 44 px in every state, so the link's row and the cue's are both kept whether the lines are up or at rest");
	const cells = rulesOf(zen).find((r) => r.parts.includes('[data-view="zen"] .zen-head-meta > *'));
	assert.deepEqual(declarations(cells!.body), [["grid-column", "1"]]);
	assert.ok(rulesOf(zen).some((r) => r.parts.includes('[data-view="zen"] .zen-head-history') && /grid-row: 1/.test(r.body)), "the link is in the first row");
	assert.ok(rulesOf(zen).some((r) => r.parts.includes('[data-view="zen"] .zen-head-cue') && /grid-row: 2/.test(r.body)), "the cue is in the second, lines up or at rest");
	assert.ok(!rulesOf(zen).some((r) => r.parts.some((x) => /zen-head-cue/.test(x)) && /display:\s*none/.test(r.body)), "the cue is never taken out of the layout: a card that comes would add its row (ZD19-F001)");
	assert.ok(rulesOf(zen).some((r) => r.parts.some((x) => /zen-head-cue-btn/.test(x)) && /min-height: 44px/.test(r.body)), "a tap target of 44 px: a phone has no Enter");
	assert.ok(!/vermilion|--zen-seal/.test(rulesOf(zen).filter((r) => r.parts.includes('[data-view="zen"] .zen-head-cue') || r.parts.includes('[data-view="zen"] .zen-head-cue-btn')).map((r) => r.body).join("")), "vermilion is for the focus alone");
	const reduced = zen.slice(zen.indexOf("@media (prefers-reduced-motion: reduce) { /* no fade"), zen.indexOf("@media (forced-colors: active) { /* the lines"));
	assert.match(reduced, /\.zen-head-cue\)/, "under reduced motion the cue comes and goes at once");
});

test("the circle gives way when the circle, its line, and the strip are taller than the page, and the group starts under the working-and-idle line, so the two never overlap (Z-D19 fix)", () => {
	const stage = rulesOf(zen).find((r) => r.parts.includes('[data-view="zen"] .zen-stage:has(.zen-head)'));
	const d = Object.fromEntries(declarations(stage!.body));
	assert.equal(d["grid-template-rows"], "minmax(80px, var(--orb)) max-content max-content", "the circle's row takes what is left, from 80 px up to its size");
	assert.equal(d["--orb"], "min(48vmin, 320px)", "its size is what it was");
	assert.equal(d["padding-top"], "40px", "the working-and-idle line is at 18 to 40 px: the circle starts below it");
	const circle = rulesOf(zen).find((r) => r.parts.includes('[data-view="zen"] .zen-stage:has(.zen-head) > .zen-circle'));
	assert.deepEqual(declarations(circle!.body), [["width", "auto"], ["height", "100%"]], "the circle follows its row's height, and its width follows it");
	const short = zen.slice(zen.indexOf("@media (max-height: 560px) {"), zen.indexOf("@media (prefers-reduced-motion: reduce) { /* no fade"));
	assert.match(short, /\.zen-stage:has\(\.zen-head\) \{ gap: 10px; --orb: min\(30vmin, 200px\); \}/, "a short window has the smaller circle by the same row");
});

test("a rested strip sends its lines and working line away the way the mindfulness line goes: faded out, then out of the reading order, and still taking their room; hover and forced colours do not bring them back", () => {
	const rest = rulesOf(zen).find((r) => r.parts.includes('[data-view="zen"] .zen-head[data-hushed] :is(.zen-head-lines, .zen-head-working)'));
	assert.ok(rest, "the rule is there");
	assert.deepEqual(declarations(rest!.body), [["opacity", "0"], ["visibility", "hidden"], ["transition", "opacity 0.6s var(--zen-ease), visibility 0s linear 0.6s"]]);
	assert.ok(!declarations(rest!.body).some(([p]) => p === "display"), "never taken out of the layout: calling the head back moves nothing");
	const list = rulesOf(zen).find((r) => r.parts.includes('[data-view="zen"] .zen-head-lines'));
	assert.equal(declarations(list!.body).find(([p]) => p === "transition")?.[1], "opacity 0.6s var(--zen-ease), visibility 0s", "and they come back over the same 0.6 s");
	assert.ok(!/visibility: visible/.test(rest!.body), "nothing in the rule undoes the hiding");
	const forced = zen.slice(zen.indexOf("@media (forced-colors: active) { /* the lines"), zen.indexOf("/* The head's history (zenhead.ts quietForwards)"));
	assert.ok(!/data-hushed|visibility/.test(forced), "forced colours show the lines they show, and a rested strip hides them: no rule there lifts the hiding");
	const reduced = zen.slice(zen.indexOf("@media (prefers-reduced-motion: reduce) { /* no fade"), zen.indexOf("@media (forced-colors: active) { /* the lines"));
	assert.match(reduced, /\.zen-head\[data-hushed\] :is\(\.zen-head-lines, \.zen-head-working\) \{ transition: none; \}/, "under reduced motion the rest is at once");
});

test("the head page's crown plate is gold like the head's node and avatar: its colour and wash come from --gold, not the accent's blue", () => {
	const plate = css.split("\n").filter((line) => line.startsWith(".comms-head[data-head] .logo {") || line.startsWith(".comms-head[data-head]:not([data-mark=\"commanding\"]) .logo {")).join("\n");
	assert.match(plate, /\.comms-head\[data-head\] \.logo \{[^}]*color: var\(--gold\)/);
	assert.match(plate, /\.comms-head\[data-head\] \.logo \{[^}]*background: radial-gradient\([^;]*var\(--gold\)/);
	assert.match(plate, /\.logo \{[^}]*border-color: color-mix\(in srgb, var\(--gold\)/, "and its border, until the unit is commanding, whose glow is the mark's own");
	assert.match(css, /\.comms-head\[data-head\] \.logo svg \{[^}]*filter: drop-shadow\([^;]*var\(--gold\)/, "the glow around the crown");
});

test("Zen's link cards (zendecide.ts) are drawn in ink: a centred wait panel, the arguments as dim code without a box, the number as the strip's hairline field at 44 px, and only inside the Zen scope", () => {
	const zen = readFileSync(new URL("../gui/zen.css", import.meta.url), "utf8"), block = zen.slice(zen.indexOf("/* Link cards (gui/zendecide.ts)"));
	assert.match(block, /\.zen-decide-acts \{ display: flex; justify-content: center; flex-wrap: wrap;/);
	assert.match(block, /\.zen-decide \.zen-args \{[^}]*border: 0;[^}]*background: none;[^}]*color: var\(--zen-ash\);[^}]*monospace/, "type only: dimmer monospace, no box");
	assert.match(block, /\.zen-decide \.zen-pair-number \{[^}]*text-align: center/);
	for (const line of block.split("\n").filter((l) => /^\[data-view|^\s*\[data-view/.test(l))) assert.match(line, /^\s*\[data-view="zen"\]/, "every rule of the block is Zen's");
	assert.doesNotMatch(block, /\bheight: \d+px|transition: [^;]*(height|width)/, "no size animation (Z-D9)");
});

test("T2: the map's overview steps aside while a question panel is open on an ally base's card, so the panel's Send answer and Cancel row at the foot of the window is not under it", () => {
	const hide = rulesOf(css).find((r) => r.parts.includes("body:has(.ally-asks:not([hidden]) .ally-asks-list:not([hidden])) .minimap"));
	assert.ok(hide, "a rule hides the minimap for an open ally panel");
	assert.deepEqual(declarations(hide!.body), [["opacity", "0"], ["pointer-events", "none"]], "as it does under a terminal tile: faded out and out of the pointer's way");
	assert.match(css, /body:has\(\.ally-asks:not\(\[hidden\]\) \.ally-asks-list:not\(\[hidden\]\)\) \.minimap \{ opacity: 0; pointer-events: none; \}/, "an open list in a box that shows: a list left open in a box that has no question is not an open panel");
	assert.ok(rulesOf(css).some((r) => r.parts.some((p) => p.endsWith(".minimap") && p.includes("body:has(.tile)"))), "the tile's rule, which this one stands beside, is still there");
});

test("a link drawn as a pair button (`a.pair-btn`, the wait panel's comms link) sits in the same box as the buttons: centred, no underline, unprefixed", () => {
	const r = rulesOf(css).find((x) => x.parts.includes("a.pair-btn"));
	assert.ok(r, "a rule for the link form of .pair-btn");
	const decl = declarations(r!.body);
	assert.ok(decl.some(([p, v]) => p === "display" && v === "inline-flex") && decl.some(([p, v]) => p === "align-items" && v === "center") && decl.some(([p, v]) => p === "text-decoration" && v === "none"));
	assert.doesNotMatch(r!.body, /-webkit-/);
});

test("the divider above a session's composer sits under the log, above the docked strips (queue, todos, monitors), and a strip never ends on it", () => {
	const rules = rulesOf(css), on = (part: string) => rules.filter((r) => r.parts.includes(part)).flatMap((r) => declarations(r.body));
	assert.ok(on(".comms-in > .chat-root").some(([p, v]) => p === "border-bottom" && v === "1px solid var(--line)"), "the log's foot carries the hairline: what scrolls ends here, what is docked starts under it");
	assert.ok(on(".comms-in .composer").some(([p, v]) => p === "border-top" && v === "0"), "the composer has no hairline of its own, or it would meet the last strip's border");
	assert.ok(on(".comms-in > .chat-root").some(([p, v]) => p === "margin-bottom" && v === "var(--dock-gap, 0px)") && on(".comms-in .composer").some(([p, v]) => p === "margin-top" && v === "var(--dock-gap, 0px)"), "a clear gap under the divider and above the composer");
	const gap = rules.find((r) => r.parts.some((p) => /^\.comms-in:has\(> :is\(.*\.todos, \.monitors\)/.test(p)));
	assert.ok(gap && declarations(gap.body).some(([p, v]) => p === "--dock-gap" && /^\d+px$/.test(v)), "the gap exists only while a strip shows, so a composer alone keeps the divider on its top edge");
	assert.match(gap!.parts.join(), /\.queue-bar.*\.queue-list.*\.queue-act.*\.todos.*\.monitors/, "every docked strip counts");
});

test("the tower's notes (a bordered card) get their own 6 px under the divider, and none while a strip's dock gap already gives it", () => {
	const rules = rulesOf(css), strips = ".queue-bar, .queue-list, .queue-act, .todos, .monitors";
	const own = rules.filter((r) => r.parts.includes(".comms-in > .tower-notes")).flatMap((r) => declarations(r.body));
	assert.ok(own.some(([p, v]) => p === "margin-top" && v === "6px"), "no strip: the notes sit 6 px under the divider (the card's border is never the divider's)");
	const withStrip = rules.find((r) => r.parts.includes(`.comms-in:has(> :is(${strips}):not([hidden])) > .tower-notes`));
	assert.ok(withStrip && declarations(withStrip.body).some(([p, v]) => p === "margin-top" && v === "0"), "a strip shows: the log's dock gap is the one gap");
	const gap = rules.find((r) => r.parts.includes(`.comms-in:has(> :is(${strips}):not([hidden]))`));
	assert.ok(gap, "the strip list that turns the dock gap on is the one the notes' reset follows");
	assert.match(css, /\.tower-notes:has\(> \.tower-notices:empty\)[^{]*\{ display: none; \}/, "an empty notes box hides by display, which is why the divider cannot look for it with :not([hidden])");
});

test("a queued row's label (排隊中・插話, Queued · steer) never breaks inside, while the message beside it breaks where it must", () => {
	const rules = rulesOf(css), on = (part: string) => rules.filter((r) => r.parts.includes(part)).flatMap((r) => declarations(r.body));
	assert.ok(on(".queue-list b").some(([p, v]) => p === "white-space" && v === "nowrap"), "the label is one piece");
	assert.ok(on(".queue-list p").some(([p, v]) => p === "overflow-wrap" && v === "anywhere"), "a long path or URL breaks anywhere instead of pulling the label apart");
});

test("an ally card's unit is flat in Geek: a stale one is not dimmed (its pill and its words say it), and the card's unit rules sit once in the entry sheet", () => {
	assert.match(geekCss, /\[data-view="geek"\] :is\([^)]*\.ally-unit\.stale[^)]*\) \{ opacity: 1; \}/);
	assert.match(geekCss, /\[data-view="geek"\] \.ally-unit \{ background: none; \}/, "and not tinted");
	assert.match(css, /^\.ally-unit \{[^}]*grid-template-columns: minmax\(0, 1fr\)/m, "a long monospace line (a monitor, a report's first line) cannot widen the unit past its card");
	assert.equal([...css.matchAll(/^\.ally-unit \{/gm)].length, 1);
	assert.ok(css.split("\n").every((l) => !/\[data-view="geek"\][^)]*\{/.test(l.replace(/:not\(\[data-view="geek"\]\)/g, ""))), "the entry sheet has no Geek rule");
});

test("the drawer's current row keeps its chevron's strip clear of a Quit button: the card's right padding is the chevron's inset plus a glyph (Geek's wider one) and a gap", () => {
	const rules = rulesOf(css), body = (part: string) => rules.filter((r) => r.parts.includes(part)).flatMap((r) => declarations(r.body));
	const px = (v?: string) => Number(/^(\d+(?:\.\d+)?)px$/.exec(v ?? "")?.[1] ?? NaN);
	const chevron = body(".drawer .unit.current > .card > .hit::after"), inset = px(chevron.find(([p]) => p === "right")?.[1]);
	assert.ok(chevron.some(([p, v]) => p === "position" && v === "absolute") && inset > 0, "the chevron is drawn over the whole card at `right: <px>`, so its strip is the card's to reserve");
	const pad = px(body(".drawer .unit.current > .card:has(> .quit-btn:not([hidden]))").find(([p]) => p === "padding-right")?.[1]);
	assert.ok(pad >= inset + 12 + 6, `padding-right ${pad}px must clear the chevron (inset ${inset}px, a glyph up to 12px wide, a 6px gap)`);
	assert.doesNotMatch(css.split("\n").filter((l) => l.includes(".quit-btn:not([hidden]))")).join("\n"), /-webkit-/);
});

test("ZNI-F010: under the corner buttons the cue runs the companion's whole width and balances its lines, so the second clause is not left as one word; the quiet notes and the way back keep a 44 px target", () => {
	assert.match(zenRule(".zen-company .zen-head-cue").map((r) => r.body).join(";"), /margin-right:\s*-100px/);
	assert.match(zen, /\[data-view="zen"\] \.zen-head-cue-btn \{ text-wrap: balance; \}/);
	const quiet = rulesOf(zen).find((r) => r.parts.some((p) => p.includes(".zen-company-rest")) && /min-height: 44px/.test(r.body));
	assert.ok(quiet, "Back to the breath on a session that is over is a 44 px target, like the head history's");
	assert.ok(zenRule(".zen-company-note:empty").some((r) => /display:\s*none/.test(r.body)), "no note, no room");
	assert.ok(zenRule(".zen-term-note:empty").some((r) => /display:\s*none/.test(r.body)));
	assert.ok(!/-webkit-text-wrap/.test(zen));
});

test("ZNR (secret_drop card): the lone line of a card's answer row (「請在終端機中回答。」, a read-only dialog's Open the terminal) is centred in Zen, not pushed right by Standard's `margin-left: auto`", () => {
	const std = rulesOf(css).find((r) => r.parts.includes(".ask-acts > :last-child"));
	assert.ok(std && /margin-left:\s*auto/.test(std.body), "Standard keeps pushing its last control right");
	const own = zenRule('.ask-acts > :last-child').filter((r) => r.parts.some((p) => p.startsWith('[data-view="zen"] .zen-card ')));
	assert.ok(own.some((r) => /(?<!-)margin-left:\s*0\b/.test(r.body)), "Zen's card says margin-left: 0 for it, scoped under the view and the card so it outranks Standard's rule");
	assert.ok(!/-webkit-margin/.test(zen));
});

test("ZNR upgrade: the line that says a new build waits for the breath is fixed at the foot of Zen's page, quiet, takes no pointer, is gone when empty, and holds still with reduced motion", () => {
	const line = zenRule(".zen-update").filter((r) => r.parts.includes('[data-view="zen"] .zen-update'));
	const decl = line.flatMap((r) => declarations(r.body));
	for (const [p, v] of [["position", "fixed"], ["pointer-events", "none"], ["color", "var(--zen-ash)"]]) assert.ok(decl.some(([a, b]) => a === p && b === v), `${p}: ${v}`);
	assert.ok(zenRule(".zen-update:empty").some((r) => /display:\s*none/.test(r.body)), "no words, no room");
	const foot = rulesOf(zen).filter((r) => r.parts.some((p) => p.startsWith('[data-view="zen"] #zen[data-update]')));
	assert.ok(foot.some((r) => r.parts.includes('[data-view="zen"] #zen[data-update]') && /--zen-foot:\s*3rem/.test(r.body) && /padding-bottom:\s*calc\([^;]*var\(--zen-foot\)/.test(r.body)), "while a new build waits the page keeps its foot, so the line lies over nothing");
	assert.ok(foot.some((r) => r.parts.some((p) => p.endsWith(".zen-term")) && /padding-bottom:[^;]*var\(--zen-foot\)/.test(r.body)), "and so does the terminal layer");
	assert.match(zenRule(".zen-card:has(.zen-ask) .zen-card-in").map((r) => r.body).join(";"), /max-height:\s*calc\([^;]*var\(--zen-foot, 0px\)\)/, "a dialog card gives the foot up too");
	const z = (n: string) => Number(/z-index:\s*(\d+)/.exec(zenRule(n).map((r) => r.body).join(";"))?.[1]);
	assert.ok(z(".zen-update") > z(".zen-term"), "above the terminal layer, whose own foot is kept clear");
	assert.match(zen, /@media \(prefers-reduced-motion: reduce\) \{[^\n]*\.zen-update \{ animation: none; \}/, "reduced motion: no fade");
	assert.ok(!/-webkit-translate|-webkit-animation/.test(zen.split("\n").filter((l) => l.includes("zen-update")).join("\n")));
});

// Zen's awake strip fills the page (docs/specs/2026-11-04-head-tower.md, Zen: the strip fills the page; `data-fill`, set by zenhead.ts). No browser runs here: the numbers the layout stands on are asserted in the rules, and the page was measured in a browser (docs/releases/0.60.3.md).
const fillSel = '[data-view="zen"] .zen-stage:has(.zen-head[data-fill]:not([hidden]))';
const decls = (...selectors: string[]) => Object.fromEntries(rulesOf(zen).filter((r) => selectors.some((s) => r.parts.includes(s))).flatMap((r) => declarations(r.body)));

test("Z-D21 (fill): while the strip is awake the stage is a column that centres what it holds; the circle gives way first and alone, from its size to a floor of 18 vh clamped to 80 to 160 px, never below 80; the mindfulness line keeps no room", () => {
	const stage = Object.fromEntries(declarations(rulesOf(zen).find((r) => r.parts.includes(fillSel))!.body)); // the first rule: a short window's own gap is below
	assert.deepEqual([stage.display, stage["flex-direction"], stage["align-items"], stage["justify-content"], stage.gap], ["flex", "column", "center", "center", "14px"], "the group stays in the middle of the page while it is shorter than the page");
	const circle = decls(`${fillSel} > .zen-circle`);
	assert.equal(circle.flex, "0 100000 var(--orb)", "its size is the strip's `--orb` (as before); its shrink factor is so large against the strip's that it alone gives way until it is at its floor");
	assert.equal(circle["min-height"], "min(var(--orb), clamp(80px, 18vh, 160px))", "the floor: 18 vh, never under 80 px (the old floor), never over 160 px, never over its own size");
	assert.deepEqual([circle.width, circle.height], ["auto", "auto"], "the old grid row's `height: 100%` is a flex-basis now, and the width follows the height (aspect-ratio)");
	assert.ok(/(^|[^\d])80px/.test(circle["min-height"]!), "the 80 px floor is still in the rule");
	const line = decls(`${fillSel} > .zen-line`);
	assert.deepEqual([line.flex, line.height], ["none", "0"], "the mindfulness line, away, takes no room: it fades out where it stood");
	assert.ok(decls('[data-view="zen"] .zen-line[data-away]').visibility === "hidden", "and it is still out of the reading order");
});

test("Z-D21 (fill): the strip takes the rest of the height; its lines are a column that shows whole lines only, newest from the foot, and the oldest are the ones missing; the cue row, the input, and the hint keep their size", () => {
	const strip = decls('[data-view="zen"] .zen-head[data-fill]');
	assert.deepEqual([strip.display, strip["flex-direction"], strip.flex, strip["min-height"]], ["flex", "column", "0 1 auto", "0"], "it gives way (after the circle) down to its fixed parts");
	assert.equal(decls('[data-view="zen"] .zen-head[data-fill][hidden]').display, "none", "a strip that is hidden (no snapshot yet, or no head) stays hidden whatever else it carries");
	assert.equal(decls('[data-view="zen"] .zen-head[data-fill] > *').flex, "none", "each fixed part (the working line, the link and cue row, the hint, the input) keeps its size");
	const lines = decls('[data-view="zen"] .zen-head[data-fill] > .zen-head-lines');
	assert.equal(lines.flex, "1 1 auto");
	assert.equal(lines["min-height"], "3.2rem", "one clamped line (2 × 1.6 rem of 16 px, the line-height the lines have) at the least, the newest");
	assert.deepEqual([lines.display, lines["flex-flow"], lines["align-content"], lines.overflow], ["flex", "column-reverse wrap", "flex-start", "hidden"], "a line that does not fit wraps into a second column the box clips away: whole lines, no half one");
	const line = decls('[data-view="zen"] .zen-head[data-fill] .zen-hl');
	assert.deepEqual([line.order, line.flex, line["box-sizing"], line.width, line["max-width"]], ["var(--rank, 0)", "none", "border-box", "100%", "none"], "sorted by rank, newest first from the foot, each as wide as the strip so a wrapped column starts beyond its edge");
	assert.equal(decls('[data-view="zen"] .zen-head[data-fill] .zen-hl[data-who="boss"]')["padding-left"], "15%", "the quiet strip's 85 % for the boss's lines, kept as padding");
	assert.equal(decls('[data-view="zen"] .zen-head[data-fill] .zen-hl[data-who="head"]')["padding-right"], "10%", "and its 90 % for the head's");
	const meta = rulesOf(zen).find((r) => r.parts.includes('[data-view="zen"] .zen-head-meta'));
	assert.match(meta!.body, /grid-template-rows: minmax\(44px, auto\) minmax\(44px, auto\)/, "the cue row is reserved in the awake strip too (it is a child of the strip, which never takes it out)");
	assert.ok(!rulesOf(zen).some((r) => r.parts.some((p) => p.includes("[data-fill]") && /zen-head-(cue|meta|form|hint|box)/.test(p))), "no fill rule touches the cue row, the input, or the hint: they are the strip's own, as at rest");
	const stage = rulesOf(zen).find((r) => r.parts.includes('[data-view="zen"] .zen-stage:has(.zen-head)'));
	assert.equal(declarations(stage!.body).find(([p]) => p === "padding-top")?.[1], "40px", "12 px under the header at the least: the 40 px the stage keeps under its top still stand in the awake layout");
});

test("Z-D21 (fill): the quiet strip is as it was: three lines, two on a phone or a window 560 px tall or less (headlines.ts SHOWN), the older ones kept by the page but not drawn; the older lines of the awake strip hold the lowest clear level", async () => {
	const { CLEAR, SHOWN, SHOWN_SMALL } = await import("../gui/headlines.ts");
	const hide = rulesOf(zen).filter((r) => r.parts.some((p) => p.startsWith('[data-view="zen"] .zen-head:not([data-fill]) .zen-hl')));
	assert.equal(hide.length, 2, "one rule for the lines beyond the third, one in the small media for the third");
	const [beyond, third] = hide;
	assert.ok(/display: none/.test(beyond!.body) && /display: none/.test(third!.body));
	const ranks = [...beyond!.parts[0]!.matchAll(/data-rank="(\d+)"/g)].map((x) => Number(x[1]));
	assert.deepEqual(ranks, [...Array(SHOWN).keys()], `the rule spares ranks 0 to ${SHOWN - 1}: SHOWN lines`);
	assert.ok(third!.parts[0]!.includes(`[data-rank="${SHOWN_SMALL}"]`), `and on a small page rank ${SHOWN_SMALL} goes too: SHOWN_SMALL lines`);
	const phone = zen.slice(zen.indexOf("@media (max-width: 600px), (max-height: 560px) {"));
	assert.ok(phone.slice(0, phone.indexOf("\n}\n")).includes('.zen-head:not([data-fill]) .zen-hl[data-rank="2"] { display: none; }'), "that rule is inside the phone / short window media block");
	const deep = rulesOf(zen).find((r) => r.parts.some((p) => p.includes('.zen-hl[data-rank]:not([data-rank="0"], [data-rank="1"], [data-rank="2"])')) && /--clear/.test(r.body));
	assert.equal(declarations(deep!.body).find(([p]) => p === "--clear")?.[1], String(CLEAR.at(-1)), "ranks 3 and up are as clear as rank 2, the lowest level that holds 7 : 1 (zen-contrast.test.ts)");
	const short = zen.slice(zen.indexOf("@media (max-height: 560px) {", zen.indexOf("@media (max-width: 600px), (max-height: 560px) {")), zen.indexOf("@media (prefers-reduced-motion: reduce) { /* no fade"));
	assert.match(short, /\.zen-stage:has\(\.zen-head\[data-fill\]:not\(\[hidden\]\)\) \{ gap: 10px; \}/, "a short window keeps its 10 px gap in the awake layout too");
});

test("the comms log keeps a fling to itself in every view: at its end or top the momentum stops there and does not chain to the page (todo #123)", () => {
	const base = rulesOf(css).find((r) => r.parts.length === 1 && r.parts[0] === ".chat-scroll" && /overflow-y: auto/.test(r.body));
	assert.ok(base, "the log's base rule");
	assert.match(base.body, /(^|[;\s])overscroll-behavior: contain\b/, "the base rule, not only the phone's: the Standard and Geek page is taller than the window (the footer follows the log's panel)");
	assert.ok(!rulesOf(css).some((r) => r.parts.some((p) => /\.chat-scroll\b/.test(p)) && /(^|[;\s])overscroll-behavior: auto\b/.test(r.body)), "no view takes it back");
});

test("a main's row on an ally card is one line at every width: Stop keeps the right end, the name and then \"by\" ellipsize (by first), the kind and state words stay whole (rev-F001, todo #150)", () => {
	const get = (selector: string, prop: string) => rulesOf(css).filter((r) => r.parts.length === 1 && r.parts[0] === selector).flatMap((r) => declarations(r.body)).find(([p]) => p === prop)?.[1]; // the phone's rule for the row's height is another rule of the same selector
	assert.equal(get(".au-main", "display"), "flex");
	assert.equal(get(".au-main", "flex-wrap"), "nowrap", "a wrapping row sends Stop to a line of its own once the words outgrow the card");
	assert.equal(get(".au-main", "min-width"), "0");
	for (const part of [".au-mname", ".au-mby"]) assert.deepEqual(["0", "hidden", "ellipsis", "nowrap"], [get(part, "min-width"), get(part, "overflow"), get(part, "text-overflow"), get(part, "white-space")], `${part} shrinks below its text and ends in an ellipsis`);
	const shrink = (value: string | undefined) => Number(value!.split(/\s+/)[1]);
	assert.ok(shrink(get(".au-mby", "flex")) > 1, "by gives way before the name: it shrinks faster than the name's default 1");
	assert.equal(get(".au-mname", "flex"), undefined, "the name keeps the default shrink of 1");
	assert.match(get(".au-mstate", "flex")!, /^none$/, "the state word stays whole");
	assert.equal(get(".au-mstate", "white-space"), "nowrap");
	assert.equal(get(".role", "flex"), "none", "and so does the kind word (`.au-mkind` is a `.role`)");
	assert.match(css, /:where\(\.au-stop\) \{ margin-left: auto; flex: none;/, "Stop is not shrunk and sits at the right end");
});

test("ZF (docs/specs/2026-11-24-zen-f.md §8.7): Zen's target button and list have no frame, 44 px targets, the seal only under :focus-visible, an opacity fade on the list alone and none under reduced motion; the quiet live text never moves; forced colours keep the hairline and the dot", () => {
	const block = zen.slice(zen.indexOf("/* ── Headless runs in Zen"), zen.indexOf("/* Link cards (gui/zendecide.ts)"));
	const rule = (sel: string) => rulesOf(block).filter((r) => r.parts.some((p) => p.endsWith(sel)) && !/@media/.test(r.parts.join(" "))).map((r) => r.body).join(";");
	assert.match(rule(".target-btn"), /border: 1px solid transparent;/, "no frame: the border is transparent, only the hairline under it");
	assert.match(rule(".target-btn"), /background: transparent;/, "no fill");
	for (const sel of [".target-btn", ".target-row", ".target-find"]) assert.match(rule(sel), /min-height: 44px/, `${sel}: 44 px`);
	assert.match(rule(".target-row"), /border: 1px solid transparent;/);
	for (const line of block.split("\n").filter((l) => /--zen-seal\b/.test(l))) assert.match(line, /:focus-visible/, `the seal only marks the keys: ${line.slice(0, 80)}`);
	assert.match(rule(".target-veil"), /animation: zen-fade 0\.3s/, "the list fades in (opacity, zen-fade)");
	assert.doesNotMatch(block, /transform|slide|translate/, "nothing slides");
	assert.match(block, /@media \(prefers-reduced-motion: reduce\) \{[^\n]*\.target-veil \{ animation: none; \}/);
	assert.match(rule(".tx.live-quiet"), /animation: none; transition: none;/);
	assert.match(rule(".tx.live-quiet .live-text"), /animation: none; transition: none;/);
	assert.match(block, /@media \(forced-colors: active\) \{[\s\S]*\.target-btn, \[data-view="zen"\] \.target-find \{ border-bottom-color: CanvasText;[\s\S]*\.tx\.live-quiet \.live-text \{ color: CanvasText; \}/);
	for (const line of block.split("\n").filter((l) => /^\[data-view|^\s*\[data-view/.test(l))) assert.match(line, /^\s*\[data-view="zen"\]/, "every rule is Zen's");
	// Standard: the head page's button and list, 44 px, Geek's chevron a `v`.
	assert.match(css, /\.target-btn \{[^}]*min-height: 44px/);
	assert.match(css, /\.target-row \{[^}]*min-height: 44px/);
	assert.match(geekCss, /\.target-chev::after \{ content: "v";/);
});
