// The reader's words for every config: whether auto mode is on, the head tower, where the watch's notice is, and what the head was told of each finding. The small chart (cfg/small.cfg: one period, one finding, nothing
// failing, the decided design) is the one drawn; the other configs are over the chart's 500 states, and their reports give each path in these words.
export const title = "one night of the auto watch, nothing failing";

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const has = (set, x) => Array.isArray(set) && set.some((y) => same(y, x));
const name = (f) => `finding ${f}`;

/** Where the watch's last notice is, as the head's queue holds it. */
function notice(v) {
	const k = v.w.pend.k;
	if (k === "none") return "no notice out";
	const e = v.queue.find((x) => same(x.k, k));
	if (!e) return has(v.ledger, k) ? "a head run finished the notice" : "the notice left the queue untaken";
	if (e.st === "parked") return "the notice parked after two crashes";
	if (e.st === "taken" && same(v.run, k)) return "a head run holds the notice";
	return e.cr ? "the notice waits again after a crash" : "the notice waits in the head's queue";
}

function findings(v) {
	const all = [...new Set([...v.present, ...v.seen])].sort();
	if (!all.length) return "nothing to look at";
	return all.map((f) => `${name(f)} ${has(v.present, f) ? "shows" : "resolved"}, ${has(v.w.shown, f) ? "told" : "not told"}`).join(", ");
}

function stale(v) {
	const old = v.queue.filter((e) => e.p !== v.period || v.auto === "off");
	if (!old.length) return "";
	return old.every((e) => e.st === "taken" && same(v.run, e.k)) ? "; a head run still holds the last notice" : `; ${old.length} notice${old.length > 1 ? "s" : ""} of an ended period left in the head's queue`;
}

export function state(v) {
	if (v.auto === "off") return `${v.period === 0 ? "Auto mode off" : "Auto mode off, the morning list written"}${stale(v)}`;
	const parts = [notice(v)];
	if (v.w.inRow >= 2) parts.push("the watch stopped after two parks in a row");
	else if (v.w.pc) parts.push(`${v.w.pc} parked before`);
	if (v.head === "closed") parts.push("the head tower closed");
	parts.push(findings(v));
	return `${parts.join("; ")}${stale(v)}`;
}

export function group(v) {
	if (v.auto === "off") return "off";
	if (v.w.pend.k !== "none") return "notice";
	return "watching";
}
export const colors = { off: "tan", watching: "blue", notice: "orange" };

const STEPS = {
	AutoOn: "the boss switches auto mode on",
	AutoOff: "the boss switches auto mode off",
	Appears: "a finding appears",
	Resolves: "a finding resolves",
	RunTakes: "a head run takes the notice",
	RunEndsOk: "the head run ends well",
	RunCrashes: "the head run crashes",
	RunQuit: "the server quits the head run",
	Restart: "the sb server restarts",
	Purge: "a day-old notice is purged from the queue",
	HeadCloses: "the boss closes the head tower",
	HeadOpens: "the head tower is opened again",
	ParkedFieldBad: "a hand edit breaks the parked notice in the period file",
	StateLost: "the period file is lost",
};

export function step(action, from, to) {
	if (action === "Reading") {
		if (to.out.k !== "none") return to.out.over ? "a reading sends a notice over one that waits" : "a reading finds something new: one notice to the head";
		if (from.w.pend.k !== "none" && to.w.pend.k === "none") return "a reading reads the notice back";
		return "a reading with nothing to send";
	}
	return STEPS[action] ?? null;
}
