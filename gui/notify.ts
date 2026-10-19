import { m } from "./paraglide/messages.js";
import type { Alert } from "./alerts.ts";
import doneUrl from "./sounds/done.mp3";
import errorUrl from "./sounds/error.mp3";
import waitingUrl from "./sounds/waiting.mp3";

// Reminders and sounds for the alerts a snapshot raises: a unit waiting on an answer, one that finished, one that failed.
// Each has a switch in the header, kept per browser: reminders on, sounds off, so a page that opens makes no noise.
// A reminder is a system notification while the page is hidden or unfocused (the alert queue shows it on a focused page);
// clicking it brings the page forward on that unit. A batch plays one sound, the most urgent of its marks.

type Kind = "waiting" | "error" | "done";
const SOUNDS: Record<Kind, string> = { waiting: waitingUrl, error: errorUrl, done: doneUrl };
const kindOf = (a: Alert): Kind | undefined => (a.mark === "waiting" || a.pending ? "waiting" : a.mark === "error" ? "error" : a.mark === "done" ? "done" : undefined);
const read = (key: string, fallback: boolean) => {
	try {
		const v = localStorage.getItem(key);
		return v === null ? fallback : v === "1";
	} catch {
		return fallback; // storage refused: the default holds for this page
	}
};
const write = (key: string, on: boolean) => {
	try {
		localStorage.setItem(key, on ? "1" : "0");
	} catch {}
};

export interface Notifier { signal(fresh: Alert[]): void }

/** Mounts the two header switches (`#remind`, `#sound`) and returns what plays a snapshot's new alerts. */
export function mountNotify(open: (a: Alert) => void): Notifier {
	const remindBtn = document.getElementById("remind") as HTMLButtonElement, soundBtn = document.getElementById("sound") as HTMLButtonElement;
	const can = typeof Notification !== "undefined";
	let remind = read("sb.remind", true), sound = read("sb.sound", false);
	const audio = new Map<Kind, HTMLAudioElement>();
	const draw = () => {
		const perm = can ? Notification.permission : "denied";
		remindBtn.setAttribute("aria-pressed", String(remind));
		// On but not yet allowed: the next press asks the browser; refused: the browser's settings decide.
		remindBtn.dataset.state = !remind ? "off" : perm === "granted" ? "on" : perm === "denied" ? "blocked" : "ask";
		remindBtn.title = !can ? m.remind_unsupported() : !remind ? m.remind_off() : perm === "granted" ? m.remind_on() : perm === "denied" ? m.remind_blocked() : m.remind_ask();
		soundBtn.setAttribute("aria-pressed", String(sound));
		soundBtn.dataset.state = sound ? "on" : "off";
		soundBtn.title = sound ? m.sound_on() : m.sound_off();
	};
	remindBtn.textContent = m.remind();
	soundBtn.textContent = m.sound();
	remindBtn.onclick = async () => {
		if (remind && can && Notification.permission === "default") await Notification.requestPermission().catch(() => {});
		else write("sb.remind", (remind = !remind));
		draw();
	};
	soundBtn.onclick = () => {
		write("sb.sound", (sound = !sound));
		if (sound) play("done"); // the press itself lets the page play, and says what a finished unit sounds like
		draw();
	};
	function play(kind: Kind) {
		const a = audio.get(kind) ?? new Audio(SOUNDS[kind]);
		audio.set(kind, a);
		a.currentTime = 0;
		void a.play().catch(() => {}); // a browser that blocks the sound before any press stays silent
	}
	draw();
	return {
		signal(fresh) {
			const due = fresh.flatMap((a) => ((k) => (k ? [{ a, k }] : []))(kindOf(a)));
			if (!due.length) return;
			if (sound) play((["waiting", "error", "done"] as const).find((k) => due.some((d) => d.k === k))!);
			if (!remind || !can || Notification.permission !== "granted" || (!document.hidden && document.hasFocus())) return;
			for (const { a, k } of due) {
				const n = new Notification(a.name, { body: { waiting: m.notify_waiting, error: m.notify_error, done: m.notify_done }[k]({ note: a.note ?? "" }).trim(), tag: a.key, icon: document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href });
				n.onclick = () => (window.focus(), n.close(), open(a));
			}
		},
	};
}
