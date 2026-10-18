import { type Alert, rankOf } from "./alerts.ts";
import { m } from "./paraglide/messages.js";

// One overlay layer for every panel the page opens. Two kinds:
// - Dialogs stack in the dock. A dialog the user is looking at is never covered by one they did not open: only an explicit open (a click
//   on a unit that waits, on the HUD alert, or on a dialog peeking out beneath) comes to the top; any other open slides in beneath the
//   top dialog, peeking out, and takes no focus, until the user closes the top one or clicks it. A unit that starts to need
//   attention never opens anything: it joins the alert queue (questions and errors first, then plain state changes; oldest first in
//   each), shown in the HUD. Closing the top dialog reveals the one beneath; with none beneath, the next queued question or error
//   (plain state changes wait for the user). "Later" puts the alert back in the queue and reveals nothing queued; "Open comms" closes
//   the alert and reveals nothing either, since the user is going to that unit. Escape closes the top dialog only. Focus moves into a dialog when it opens and goes back to where it was when it closes. Dialogs are not modal: the
//   page stays usable, nothing traps focus, and dialogs beneath the top are inert. A queued alert whose unit no longer needs attention
//   leaves the queue by itself; an open dialog stays open and shows the unit's current state.
// - Tiles sit beside the current view and share its width (documents). Opening one never covers or closes a dialog, and one that
//   arrives on its own does not take focus. When the width runs out the tiles turn into tabs.
// This is the dialog stack's model; the tiles' model and the layer's DOM are in layer.ts. Both load as one chunk on the first alert,
// dialog, or tile (alerts.ts, which spots alerts in each snapshot, stays in the map's chunk). The models are pure (DOM work goes
// through `io`), so the rules are tested without a browser.

export type { Alert };
const order = (a: Alert, b: Alert) => rankOf(a.mark) - rankOf(b.mark) || a.at - b.at;
/** The queue in words, the same in the header and in every dialog: what needs the user, and what only finished (closing never reveals those). */
export const tally = (queue: Alert[]) => {
	const asking = queue.filter((a) => rankOf(a.mark) === 0).length, rest = queue.length - asking;
	return [asking && m.tally_need({ count: asking }), rest && m.tally_finished({ count: rest })].filter(Boolean).join(" · ");
};

export interface StackIO<F> { render(open: Alert[], queue: Alert[]): void; enter(alert: Alert): void; focused(): F | undefined; restore(target: F | undefined): boolean }

export function createStack<F>(io: StackIO<F>) {
	// `raised` is the state that raised an open dialog's alert; the dialog itself shows the unit's current state.
	let open: { alert: Alert; back: F | undefined; raised: Alert["mark"] }[] = [], queue: Alert[] = [];
	const draw = () => io.render(open.map((o) => o.alert), queue);
	const show = (alert: Alert, back: F | undefined, user = true) => {
		const i = open.findIndex((o) => o.alert.key === alert.key);
		if (i >= 0 && !user) return; // already open: it stays where it is
		const entry = i >= 0 ? open.splice(i, 1)[0]! : { alert, back, raised: alert.mark };
		// Not the user's own open: beneath the top dialog, without focus. With none open there is nothing to cover.
		if (!user && open.length) open.splice(open.length - 1, 0, entry);
		else open.push(entry);
		queue = queue.filter((q) => q.key !== alert.key);
		draw();
		if (user) io.enter(entry.alert);
	};
	return {
		get open() { return open.map((o) => o.alert); },
		get queue() { return queue; },
		/** A unit started to need attention: it waits in the queue, or refreshes its open dialog. Never opens or focuses anything. */
		arrive(alert: Alert) {
			const o = open.find((x) => x.alert.key === alert.key);
			if (o) [o.alert, o.raised] = [{ ...alert, at: o.alert.at }, alert.mark];
			else {
				const old = queue.find((q) => q.key === alert.key);
				queue = [...queue.filter((q) => q.key !== alert.key), old && old.mark === alert.mark ? old : alert].sort(order);
			}
			draw();
		},
		/** Drops queued alerts whose unit no longer shows the state that raised them; open dialogs take the unit's current state, or show `gone` when the unit left the net. */
		prune(now: (key: string) => Alert | undefined) {
			queue = queue.filter((q) => now(q.key)?.mark === q.mark);
			for (const o of open) {
				const unit = now(o.alert.key);
				o.alert = unit ? { ...o.alert, ...unit, gone: undefined, at: o.alert.at } : { ...o.alert, mark: "unknown", note: undefined, pending: undefined, gone: true };
			}
			draw();
		},
		/** Draws again with the same models, for what the page knows that the models do not (the stream state). */
		redraw: draw,
		/** The user opens a dialog (raised to the top if it is open already). `user` false opens it beneath the top one, without focus. */
		show: (alert: Alert, user = true) => show(alert, io.focused(), user),
		/** The user clicked a dialog beneath the top one: it comes to the top. */
		raise(key: string) {
			const o = open.find((x) => x.alert.key === key);
			if (o && o !== open.at(-1)) show(o.alert, io.focused());
		},
		next() {
			if (queue[0]) show(queue[0], io.focused());
		},
		/**
		 * Closes the top dialog and returns false when none is open. The dialog beneath comes back; with none beneath, the next queued
		 * question or error does (it was waiting behind this one). "later" puts the closed alert back in the queue and reveals nothing
		 * queued, so the user can always step out of the queue (an alert whose unit moved on meanwhile is stale and is dropped instead); "go"
		 * (Open comms) reveals nothing either: the user is going to that unit.
		 */
		close(how: "close" | "later" | "go" = "close"): boolean {
			const top = open.pop();
			if (!top) return false;
			const below = open.at(-1), next = how === "close" ? queue.find((q) => rankOf(q.mark) === 0) : undefined;
			if (how === "later" && top.alert.mark === top.raised) queue = [...queue, top.alert].sort(order);
			if (!below && next) {
				show(next, top.back);
				return true;
			}
			draw();
			if (!io.restore(top.back) && below) io.enter(below.alert);
			return true;
		},
	};
}
