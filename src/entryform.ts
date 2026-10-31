import { APP } from "./remote.ts";

// What the installed app's entry (appentry.ts) draws: its words in English and Traditional Chinese, the page with the pairing code as eight boxes of one character each, and the script
// that makes the boxes behave as one field (`SCRIPT`, served at `entry.js`: the page's CSP allows scripts from its own origin only, so there is none inline). The page works without the script:
// the boxes are named fields `c1` to `c8` that the server joins (paircode.ts `typedText`). The Wi-Fi access (LAN) entry draws the same form, with its own words and its own QR, waiting, and notice pages
// (docs/specs/2026-10-30-sb-gui-lan.md, "Approval on this computer").

const TEXT = {
	en: { title: "Straw Net", lead: "This device is not paired. On the computer that runs Straw Boss, run /boss gui remote (or open Phone in the page) and type the 8 characters it shows beside the QR.", label: "Pairing code", hint: "Type the 8 characters, one in each box. No hyphen needed.", box: (n: number) => `character ${n} of 8`, go: "Pair", paired: "Already paired on this device? Open the straw net", wrong: "That code did not work. Check it, or ask for a new one on the computer.", locked: "Too many wrong codes. Ask for a new code on the computer (/boss gui remote).", done: "Paired. Opening the straw net…" },
	zh: { title: "Straw Net", lead: "這個裝置還沒配對。在執行 Straw Boss 的電腦上執行 /boss gui remote（或在頁面開啟「手機」視窗），輸入 QR code 旁邊顯示的 8 個字元。", label: "配對碼", hint: "輸入 8 個字元，每格一個，不需要輸入連字號。", box: (n: number) => `第 ${n} 碼，共 8 碼`, go: "配對", paired: "這個裝置已經配對過？開啟 straw net", wrong: "這個配對碼無效。請確認輸入無誤，或在電腦上取得新的配對碼。", locked: "錯誤次數過多。請在電腦上取得新的配對碼（/boss gui remote）。", done: "已配對。正在開啟 straw net…" },
};
const LAN = {
	en: { lead: "This device is not paired. On the computer that runs Straw Boss, run /boss gui lan (or open Phone, Same Wi-Fi, in the page) and type the 8 characters it shows beside the QR.", locked: "Too many wrong codes from this device. Ask for a new code on the computer (/boss gui lan).", ask: "Pair this device with Straw Boss on", pair: "Pair", wait: "Waiting for the computer to allow this device.", number: "Number", type: "On the computer, type this number.", denied: "The computer did not allow this device.", timeout: "Not allowed in time. Ask the computer for a new code.", busy: "The computer is busy with other pair requests; try again in a minute.", limited: "Too many requests from this device; try again in ten minutes.", again: "Back to the pairing page" },
	zh: { lead: "這個裝置還沒配對。在執行 Straw Boss 的電腦上執行 /boss gui lan（或在頁面開啟「手機」>「同一個 Wi-Fi」），輸入 QR code 旁邊顯示的 8 個字元。", locked: "這個裝置輸入錯誤的配對碼太多次。請在電腦上取得新的配對碼（/boss gui lan）。", ask: "要把這個裝置與以下電腦上的 Straw Boss 配對嗎？", pair: "配對", wait: "等待電腦允許這個裝置。", number: "數字", type: "請在電腦上輸入這組數字。", denied: "電腦沒有允許這個裝置。", timeout: "沒有及時允許。請在電腦上取得新的配對碼。", busy: "電腦正在處理其他配對要求，請一分鐘後再試。", limited: "這個裝置的要求太多，請十分鐘後再試。", again: "回到配對頁" },
};
export const wordsOf = (zh: boolean) => TEXT[zh ? "zh" : "en"];
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const STYLE = "body{font:16px system-ui,sans-serif;background:#16161e;color:#c0caf5;margin:0;padding:2rem 1.25rem;max-width:30rem}input,button{font:inherit;padding:.6rem .8rem;border-radius:.4rem;border:1px solid #565f89;background:#1a1b26;color:inherit}"
	+ "fieldset{border:0;margin:0;padding:0;min-width:0}legend{padding:0;font-weight:600}.hint{margin:.3rem 0 .8rem;color:#9aa5ce}.boxes{display:flex;gap:.3rem}.boxes input{flex:1 1 0;min-width:0;max-width:3rem;height:3rem;padding:0;text-align:center;font:600 1.4rem ui-monospace,monospace;text-transform:uppercase}.boxes input:nth-child(5){margin-left:.8rem}input:focus{outline:2px solid #7aa2f7;outline-offset:1px}"
	+ "button{background:#7aa2f7;color:#16161e;border-color:#7aa2f7;margin-top:1rem}button:disabled{opacity:.45}.note{color:#f7768e}.number{font-size:2.5rem;letter-spacing:.2em;margin:.5rem 0}a{color:#7aa2f7}";

const doc = (zh: boolean, title: string, body: string, head = "", script = false) => `<!doctype html><html lang="${zh ? "zh-Hant" : "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><link rel="icon" href="data:,">${head}<title>${title}</title><style>${STYLE}</style></head><body><h1>${title}</h1>${body}${script ? `<script src="${APP}entry.js"></script>` : ""}</body></html>`;

/** The entry's page: the lead, a note after a refusal, the eight boxes (not after a lockout), and the way on for a device that is already paired. `lan` draws the Wi-Fi access entry's words. */
export const page = (zh: boolean, note?: "wrong" | "locked", lan = false) => {
	const t = wordsOf(zh), l = LAN[zh ? "zh" : "en"], boxes = Array.from({ length: 8 }, (_, i) => `<input name="c${i + 1}" maxlength="1" size="1" type="text" inputmode="text" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" aria-label="${t.box(i + 1)}" required${i ? "" : " autofocus"}>`).join("");
	const form = `<form method="post" action="${APP}pair"><fieldset><legend>${t.label}</legend><p class="hint">${t.hint}</p><div class="boxes">${boxes}</div></fieldset><button type="submit">${t.go}</button></form>`;
	return doc(zh, t.title, `<p>${lan ? l.lead : t.lead}</p>${note ? `<p class="note" role="alert">${note === "locked" && lan ? l.locked : t[note]}</p>` : ""}${note === "locked" ? "" : form}<p><a href="${APP}">${t.paired}</a></p>`, "", true);
};
/** The Wi-Fi QR's page: a link preview or prefetcher that fetches the URL gets this and uses nothing up; the code is posted by the button. */
export const askPage = (zh: boolean, host: string, code: string) => {
	const l = LAN[zh ? "zh" : "en"];
	return doc(zh, wordsOf(zh).title, `<p>${l.ask} ${esc(host)}${zh ? "" : "?"}</p><form method="post" action="${APP}pair"><input type="hidden" name="code" value="${esc(code)}"><button type="submit">${l.pair}</button></form>`);
};
/** Where a pending Wi-Fi device waits (no script: it reloads itself); the number is the one to type on the computer. */
export const waitPage = (zh: boolean, w: { state: "pending"; number: string } | { state: "denied" | "timeout" | "none" }) => {
	const l = LAN[zh ? "zh" : "en"], title = wordsOf(zh).title;
	if (w.state === "pending") return doc(zh, title, `<p>${l.wait}</p><p>${l.number}</p><p class="number">${esc(w.number)}</p><p>${l.type}</p>`, `<meta http-equiv="refresh" content="2;url=${APP}pair/wait">`);
	return doc(zh, title, `<p class="note" role="alert">${w.state === "denied" ? l.denied : w.state === "timeout" ? l.timeout : l.lead}</p><p><a href="${APP}">${l.again}</a></p>`);
};
/** A Wi-Fi refusal a person can wait out: too many requests from the device, or the computer busy with other pair requests. */
export const noticePage = (zh: boolean, kind: "limited" | "busy") => {
	const l = LAN[zh ? "zh" : "en"];
	return doc(zh, wordsOf(zh).title, `<p class="note" role="alert">${l[kind]}</p>${kind === "busy" ? `<p><a href="${APP}">${l.again}</a></p>` : ""}`);
};

/** The boxes as one field: a character moves on to the next box, Backspace on an empty box back to the one before, the arrow keys walk, and a pasted code (hyphen, spaces, or none) fills all eight. */
export const SCRIPT = `(function () {
	var form = document.querySelector("form"), go = form && form.querySelector("button");
	if (!go) return;
	var boxes = Array.prototype.slice.call(form.querySelectorAll(".boxes input"));
	var clean = function (text) { return text.normalize("NFKC").toUpperCase().replace(/[^0-9A-Z]/g, ""); };
	var sync = function () { go.disabled = !boxes.every(function (box) { return box.value; }); };
	var focus = function (i) { boxes[Math.max(0, Math.min(7, i))].focus(); };
	var fill = function (from, chars) {
		for (var k = 0; k < chars.length && from + k < 8; k++) boxes[from + k].value = chars.charAt(k);
		focus(from + chars.length);
		sync();
	};
	boxes.forEach(function (box, i) {
		var typed = function () {
			var chars = clean(box.value);
			box.value = chars.charAt(0);
			if (chars.length > 1) fill(i, chars);
			else { if (chars) focus(i + 1); sync(); }
		};
		box.addEventListener("input", function (e) { if (!e.isComposing) typed(); });
		box.addEventListener("compositionend", typed);
		box.addEventListener("beforeinput", function (e) { if (e.inputType === "insertText" && box.value) box.select(); });
		box.addEventListener("focus", function () { box.select(); });
		box.addEventListener("click", function () { box.select(); });
		box.addEventListener("paste", function (e) {
			e.preventDefault();
			var chars = clean((e.clipboardData || window.clipboardData).getData("text"));
			if (chars) fill(chars.length >= 8 ? 0 : i, chars.slice(0, 8));
		});
		box.addEventListener("keydown", function (e) {
			if (e.key === "Backspace" && !box.value && i > 0) { e.preventDefault(); boxes[i - 1].value = ""; focus(i - 1); sync(); }
			else if (e.key === "ArrowLeft") { e.preventDefault(); focus(i - 1); }
			else if (e.key === "ArrowRight") { e.preventDefault(); focus(i + 1); }
			else if (e.key === "Home") { e.preventDefault(); focus(0); }
			else if (e.key === "End") { e.preventDefault(); focus(7); }
		});
	});
	form.addEventListener("submit", function (e) {
		var empty = boxes.filter(function (box) { return !box.value; })[0];
		if (empty) { e.preventDefault(); empty.focus(); }
	});
	sync();
})();
`;
