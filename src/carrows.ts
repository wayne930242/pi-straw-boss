import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CAR_ROWS_EVENT, carRows, carsText, type SentSlip, type TodoRef, UNRECEIVED_MS } from "./carline.ts";
import { localeOf, type Locale } from "./locale.ts";
import type { Kit } from "./state.ts";
import { todosOfBranch } from "./todo.ts";
import type { CarFact } from "./train/carfacts.ts";
import { slipsInText } from "./train/cars.ts";
import { callServer, type ServerCall } from "./traincar.ts";

// A session's car rows (docs/specs/2026-11-28-car-rows.md): it asks the sb server every 15 s for the facts of the cars it coordinates or received (`cars-rows`), remembers the slips it sent that no integrator has received
// yet, answers `straw-boss:car-rows:v1` from both at once (the probe is synchronous), prints them for `/boss cars`, and tells its model once of a slip nobody received in 15 minutes (boss 2026-11-28). No other notice is added.

export const REMIND_MS = UNRECEIVED_MS, ASK_MS = 15_000, KEEP_SENT_MS = 24 * 3600_000;
export const UNRECEIVED = "straw-boss-car-unreceived";
/** What the model is told of a slip no integrator received in 15 minutes. */
export const unreceivedText = (s: SentSlip) => `Car slip ${s.tickets.join(", ")} (${s.app}, head ${s.head.slice(0, 12)}) was sent to the tower 15 minutes ago and no integrator has received it yet: an sb or tower restart may have lost it. Ask the project's integrator (intercom) whether it has the slip, or send the same slip again with call_tower why=shared so the tower forwards it again. sb says this once.`;

/** The slips each session of this process sent: on `globalThis`, so a `/reload` keeps them; never in a file. */
const HELD = Symbol.for("pi-straw-boss.cars.sent");
const heldSlips = (): Map<string, SentSlip[]> => ((globalThis as { [HELD]?: Map<string, SentSlip[]> })[HELD] ??= new Map());

export interface CarRowsDeps {
	pi: Pick<ExtensionAPI, "on" | "events" | "sendMessage">;
	me(): string;
	/** The merge train is on and this session has an sb server to ask. */
	enabled(): boolean;
	call: ServerCall;
	/** The session's branch, for its todo list. */
	branch(): readonly unknown[];
	lang(): Locale;
	now(): number;
	/** Between two asks of the server; 0 asks only on `refresh` (tests). */
	every?: number;
	held?: Map<string, SentSlip[]>;
}

export function registerCarRows(d: CarRowsDeps) {
	const held = d.held ?? heldSlips(), every = d.every ?? ASK_MS;
	let facts: CarFact[] = [], answered: number | undefined, timer: ReturnType<typeof setInterval> | undefined, running: Promise<void> | undefined;
	const sent = () => held.get(d.me()) ?? [];
	const todos = (): TodoRef[] => { try { return (todosOfBranch(d.branch()) ?? []).map((t) => ({ id: t.id, subject: t.subject, status: t.status, ...(t.uid ? { uid: t.uid } : {}) })); } catch { return []; } };
	const rows = () => carRows({ facts, sent: sent(), todos: todos(), me: d.me(), lang: d.lang(), now: d.now() });

	// A slip the tower took: each car of the message whose coordinator is this session (a slip that names none is the sender's own).
	d.pi.on("tool_result", (event) => {
		const input = event.input as { message?: unknown; why?: unknown } | undefined;
		if (event.toolName !== "call_tower" || event.isError || input?.why !== "shared" || typeof input.message !== "string" || !d.me()) return;
		const mine = slipsInText(input.message).filter((s) => !s.over && !s.problems?.length && (s.coordinator ?? d.me()) === d.me());
		if (!mine.length) return;
		const list = sent().filter((s) => !mine.some((m) => m.app === s.app && m.head === s.head));
		held.set(d.me(), [...list, ...mine.map((m) => ({ app: m.app, head: m.head, tickets: [...m.tickets], at: d.now() }))]);
	});

	/** Asks the server once: a slip whose car it holds is forgotten, and a slip 15 minutes old that it still does not hold is told to the model, once. A server that does not answer changes nothing. */
	async function look(): Promise<void> {
		if (!d.enabled() || !d.me()) return;
		const reply = await d.call({ cmd: "cars-rows", session: d.me() }).catch(() => undefined);
		if (!reply?.ok || !Array.isArray(reply.cars)) return;
		facts = reply.cars as CarFact[];
		const now = d.now();
		answered = now;
		const heads = new Set(facts.map((f) => `${f.app}\n${f.head}`)), keep = sent().filter((s) => !heads.has(`${s.app}\n${s.head}`) && now - s.at < KEEP_SENT_MS);
		held.set(d.me(), keep);
		for (const s of keep) {
			if (s.reminded !== undefined || now - s.at < REMIND_MS) continue;
			s.reminded = now;
			d.pi.sendMessage({ customType: UNRECEIVED, content: unreceivedText(s), display: true, details: { app: s.app, head: s.head, tickets: s.tickets } }, { triggerTurn: true, deliverAs: "followUp" });
		}
	}
	const refresh = () => (running ??= look().finally(() => { running = undefined; }));

	d.pi.events.on(CAR_ROWS_EVENT, (raw) => {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
		Object.assign(raw, { rows: { version: 1, rows: rows() } });
	});
	if (every > 0) {
		d.pi.on("session_start", () => {
			if (timer) clearInterval(timer);
			void refresh();
			timer = setInterval(() => void refresh(), every);
			timer.unref?.();
		});
		d.pi.on("session_shutdown", () => { if (timer) clearInterval(timer); timer = undefined; });
	}
	return {
		refresh,
		rows,
		/** `/boss cars`: asks the server first, so the text is the newest. */
		async text(): Promise<string> { await refresh(); return carsText(rows(), todos(), d.me(), d.lang(), d.now()); },
		answered: () => answered,
	};
}
export type CarRows = ReturnType<typeof registerCarRows>;

/** The car rows of a session in a pane, wired to its kit: the server it already talks to, its branch, sb's language (read at most every 30 s: the probe is asked at every draw). */
export function carRowsOf(kit: Kit, enabled: () => boolean): CarRows {
	const { pi, cfg } = kit;
	let lang: { at: number; value: Locale } | undefined;
	return registerCarRows({
		pi, me: kit.me, enabled: () => !kit.s.isTower && enabled(), call: cfg.server ? callServer(cfg.env, kit.guiDir) : async () => undefined, branch: () => kit.s.branch(), now: cfg.now,
		lang: () => (lang && cfg.now() - lang.at < 30_000 ? lang.value : (lang = { at: cfg.now(), value: localeOf(cfg.env, kit.guiDir) }).value),
	});
}
