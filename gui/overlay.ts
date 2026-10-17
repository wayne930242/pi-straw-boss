import { type Alert, rankOf } from "./alerts.ts";

// One overlay layer for every panel the page opens. Two kinds:
// - Dialogs stack in the dock. Only the user opens one (a click on a unit that waits, or on the HUD alert). A unit that starts to need
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

export interface StackIO<F> { render(open: Alert[], queue: Alert[]): void; enter(alert: Alert): void; focused(): F | undefined; restore(target: F | undefined): boolean }

export function createStack<F>(io: StackIO<F>) {
	let open: { alert: Alert; back: F | undefined }[] = [], queue: Alert[] = [];
	const draw = () => io.render(open.map((o) => o.alert), queue);
	const show = (alert: Alert, back: F | undefined) => {
		const i = open.findIndex((o) => o.alert.key === alert.key);
		const entry = i >= 0 ? open.splice(i, 1)[0]! : { alert, back };
		open.push(entry);
		queue = queue.filter((q) => q.key !== alert.key);
		draw();
		io.enter(entry.alert);
	};
	return {
		get open() { return open.map((o) => o.alert); },
		get queue() { return queue; },
		/** A unit started to need attention: it waits in the queue, or refreshes its open dialog. Never opens or focuses anything. */
		arrive(alert: Alert) {
			const o = open.find((x) => x.alert.key === alert.key);
			if (o) o.alert = { ...alert, at: o.alert.at };
			else {
				const old = queue.find((q) => q.key === alert.key);
				queue = [...queue.filter((q) => q.key !== alert.key), old && old.mark === alert.mark ? old : alert].sort(order);
			}
			draw();
		},
		/** Drops queued alerts whose unit no longer shows the state that raised them; open dialogs take the unit's current state. */
		prune(now: (key: string) => Alert | undefined) {
			queue = queue.filter((q) => now(q.key)?.mark === q.mark);
			for (const o of open) o.alert = { ...o.alert, ...now(o.alert.key), at: o.alert.at };
			draw();
		},
		/** The user opens a dialog (raised to the top if it is open already). */
		show: (alert: Alert) => show(alert, io.focused()),
		next() {
			if (queue[0]) show(queue[0], io.focused());
		},
		/**
		 * Closes the top dialog and returns false when none is open. The dialog beneath comes back; with none beneath, the next queued
		 * question or error does (it was waiting behind this one). "later" puts the closed alert back in the queue and reveals nothing
		 * queued, so the user can always step out of the queue; "go" (Open comms) reveals nothing either: the user is going to that unit.
		 */
		close(how: "close" | "later" | "go" = "close"): boolean {
			const top = open.pop();
			if (!top) return false;
			const below = open.at(-1), next = how === "close" ? queue.find((q) => rankOf(q.mark) === 0) : undefined;
			if (how === "later") queue = [...queue, top.alert].sort(order);
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
