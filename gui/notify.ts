import { m } from "./paraglide/messages.js";
import { hang } from "./render.ts";
import type { Alert } from "./alerts.ts";
import doneUrl from "./sounds/done.mp3";
import errorUrl from "./sounds/error.mp3";
import waitingUrl from "./sounds/waiting.mp3";

// Reminders and sounds for the alerts a snapshot raises: a unit waiting on an answer, one that finished, one that failed.
// Each has a switch in the header, kept per browser: reminders on, sounds off, so a page that opens makes no noise. The sound button
// opens a small panel with the switch, a volume (0 to 100, default 60), and a try; the sounds play through Web Audio, whose gain an
// iPhone honours (it ignores an audio element's volume).
// A reminder is a system notification while the page is hidden or unfocused (the alert queue shows it on a focused page);
// clicking it brings the page forward on that unit. Only a question is urgent: a failure or a finish shows a silent system notification, and with Sound on plays its
// own softer clip (the error clip) beside the question's. A batch plays one sound, the most urgent of its marks.

type Kind = "waiting" | "error" | "done";
const SOUNDS: Record<Kind, string> = { waiting: waitingUrl, error: errorUrl, done: doneUrl };
const kindOf = (a: Alert): Kind | undefined => (a.mark === "waiting" || a.pending ? "waiting" : a.mark === "error" ? "error" : a.mark === "done" ? "done" : undefined);
const read = (key: string, fallback: string) => {
	try {
		return localStorage.getItem(key) ?? fallback;
	} catch {
		return fallback; // storage refused: the default holds for this page
	}
};
const write = (key: string, value: string) => {
	try {
		localStorage.setItem(key, value);
	} catch {}
};

export interface Notifier { signal(fresh: Alert[]): void; /** The finished-unit clip, when Sound is on: a new unit that is ready (deploy.ts). */ chime(): void }

/** Mounts the header's reminder switch (`#remind`) and sound panel (`#sound`, `#sound-pop`) and returns what plays a snapshot's new alerts. */
export function mountNotify(open: (a: Alert) => void): Notifier {
	const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
	const remindBtn = $<HTMLButtonElement>("remind"), soundBtn = $<HTMLButtonElement>("sound"), pop = $<HTMLDivElement>("sound-pop");
	const onBox = $<HTMLInputElement>("sound-on"), vol = $<HTMLInputElement>("sound-vol"), volOut = $<HTMLOutputElement>("sound-vol-out");
	const can = typeof Notification !== "undefined";
	let remind = read("sb.remind", "1") === "1", sound = read("sb.sound", "0") === "1", volume = Math.min(100, Math.max(0, Number(read("sb.volume", "60")) || 0));
	let ac: AudioContext | undefined, gain: GainNode | undefined;
	const clips = new Map<Kind, Promise<AudioBuffer>>();
	const draw = () => {
		const perm = can ? Notification.permission : "denied";
		remindBtn.setAttribute("aria-pressed", String(remind));
		// On but not yet allowed: the next press asks the browser; refused: the browser's settings decide.
		remindBtn.dataset.state = !remind ? "off" : perm === "granted" ? "on" : perm === "denied" ? "blocked" : "ask";
		remindBtn.title = !can ? m.remind_unsupported() : !remind ? m.remind_off() : perm === "granted" ? m.remind_on() : perm === "denied" ? m.remind_blocked() : m.remind_ask();
		soundBtn.dataset.state = sound ? "on" : "off";
		// The state in a word too (the Geek view shows it, style.css `.tog::before`), where the Standard view shows it by a dot's colour.
		remindBtn.dataset.word = { off: m.state_off, on: m.state_on, blocked: m.state_blocked, ask: m.state_ask }[remindBtn.dataset.state as "off"]();
		soundBtn.dataset.word = sound ? m.state_on() : m.state_off();
		soundBtn.setAttribute("aria-label", sound ? m.sound_on() : m.sound_off());
		onBox.checked = sound;
		vol.value = volOut.value = String(volume);
		if (gain) gain.gain.value = (volume / 100) ** 2; // loudness follows the square of the gain more closely than the gain
	};
	remindBtn.textContent = m.remind();
	soundBtn.textContent = m.sound();
	soundBtn.title = m.sound_title();
	$("sound-on-label").textContent = m.sound();
	$("sound-vol-label").textContent = m.sound_volume();
	$("sound-try").textContent = m.sound_try();
	remindBtn.onclick = async () => {
		if (remind && can && Notification.permission === "default") await Notification.requestPermission().catch(() => {});
		else write("sb.remind", (remind = !remind) ? "1" : "0");
		draw();
	};
	// The panel hangs under its button, kept inside the window; the popover closes on Escape or a press outside it.
	pop.addEventListener("toggle", (event) => (event as ToggleEvent).newState === "open" && hang(pop, soundBtn));
	// Each press in the panel lets the page play, and says what a finished unit sounds like.
	onBox.onchange = () => {
		write("sb.sound", (sound = onBox.checked) ? "1" : "0");
		draw();
		if (sound) play("done");
	};
	vol.oninput = () => (write("sb.volume", String((volume = Number(vol.value)))), draw());
	vol.onchange = () => play("done");
	$("sound-try").onclick = () => play("done");
	function play(kind: Kind) {
		ac ??= new AudioContext();
		if (!gain) (gain = ac.createGain()).connect(ac.destination), draw();
		const c = ac, out = gain;
		if (!clips.has(kind)) clips.set(kind, fetch(SOUNDS[kind]).then((r) => r.arrayBuffer()).then((bytes) => c.decodeAudioData(bytes)));
		// A browser that blocks sound before any press keeps the context suspended, and the sound stays silent.
		void Promise.all([c.resume(), clips.get(kind)!]).then(([, clip]) => {
			const source = c.createBufferSource();
			source.buffer = clip;
			source.connect(out);
			source.start();
		}).catch(() => clips.delete(kind));
	}
	draw();
	return {
		chime: () => sound && play("done"),
		signal(fresh) {
			const due = fresh.flatMap((a) => ((k) => (k ? [{ a, k }] : []))(kindOf(a)));
			if (!due.length) return;
			if (sound) play((["waiting", "error", "done"] as const).find((k) => due.some((d) => d.k === k))!);
			if (!remind || !can || Notification.permission !== "granted" || (!document.hidden && document.hasFocus())) return;
			for (const { a, k } of due) {
				const n = new Notification(a.name, { body: a.trust ? m.trust_reminder() : { waiting: m.notify_waiting, error: m.notify_error, done: m.notify_done }[k]({ note: a.note ?? "" }).trim(), tag: a.key, icon: document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href, silent: k !== "waiting" }); // only a question may make the system beep: a failure or a finish is a quiet notice
				n.onclick = () => (window.focus(), n.close(), open(a));
			}
		},
	};
}
