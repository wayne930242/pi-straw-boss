import type { Net, Unit } from "../src/net.ts";
import type { CarFact } from "../src/train/carfacts.ts";
import type { ProjectYard, YardCar, YardStep, YardTrainRow } from "../src/train/yardview.ts";
import { getLocale } from "./paraglide/runtime.js";

// The demo's trains (`?trains=<state>`, docs/specs/2026-11-07-train-workers.md §11.2): the yards of the net snapshot with invented projects, the integrator and the train units in a tab of the Harbor base, and the load. Every state of the page
// has one: `all` (the default for `?trains`), `forming`, `running`, `waiting`, `mutual` (two trains wait for the same lane and target), `round2` (a car removed from a re-assembly), `notices` (every kind of car notice), `stale`, `ended`, `unreadable`,
// `empty` (a yard with no train yet), and `loose` (a yard no unit of the net places: the header's chip). `&yard` opens the yard a moment after the page starts, for pictures.

export const TRAIN_STATES = ["all", "forming", "running", "waiting", "mutual", "round2", "notices", "stale", "ended", "unreadable", "empty", "loose"] as const;
export type TrainState = (typeof TRAIN_STATES)[number];
export const isTrainState = (value: string | null): value is TrainState => (TRAIN_STATES as readonly (string | null)[]).includes(value);

const MIN = 60_000, SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
/** What the people and the readers wrote is data in one language, so the demo writes it in the page's: a Chinese view shows no English the server never wrote, and an English one no Chinese. */
const said = (zh: string, en: string) => (getLocale() === "en" ? en : zh);
export function trainsDemo(net: Net, state: TrainState, now: number): void {
	const ago = (min: number) => new Date(now - min * MIN).toISOString(), day = new Date(now).toISOString().slice(0, 10), code = (letter: string) => `${day}-${letter}`;
	const car = (tickets: string[], over: Partial<YardCar> = {}): YardCar => ({ tickets, branch: `fix/${tickets[0]!.toLowerCase()}`, head: SHA, departs: "next", arrived: ago(40), accepted: [{ kind: "e2e", nod: said("測過了，可以上車", "tested, good to ride") }, { kind: "uat", nod: said("驗收 OK", "accepted, OK") }], ...over });
	const step = (id: number, kind: YardStep["kind"], status: YardStep["status"], over: Partial<YardStep> = {}): YardStep => ({ id, kind, name: kind, status, round: 1, waits: [], ...over });
	const passed = (id: number, kind: YardStep["kind"], name: string = kind, over: Partial<YardStep> = {}) => step(id, kind, "completed", { name, outcome: "passed", ...over });
	const row = (letter: string, over: Partial<YardTrainRow> = {}): YardTrainRow => ({ code: code(letter), app: "web", state: "live", key: `train-${letter}`, writerLive: true, round: 1, updated: ago(1), cars: [car(["T-15"]), car(["T-16"], { departs: "with T-15" })], steps: [], ...over });
	const gates = (waits: YardStep["waits"]) => [
		passed(1, "assemble", "assemble", { holds: { lane: "web" } }), passed(2, "review"), passed(3, "full-check", "type-check"),
		step(4, "full-check", "in_progress", { name: "unit", load: { max: 30, weight: 4 }, waits }), step(5, "full-check", "in_progress", { name: "lint", load: { perCore: 1, weight: 2 }, waits: [] }),
		step(6, "full-check", "pending", { name: "build" }), step(7, "merge", "pending", { holds: { lane: "web" } }), step(8, "ci", "pending"), step(9, "deploy", "pending", { holds: { target: "target-a" } }), step(10, "deploy-verify", "pending"), step(11, "land", "pending"),
	];
	const running = row("m", { steps: gates([]), holds: { lanes: ["web"], targets: [] }, cars: [car(["T-15"], { notice: { state: "received", status: "delivered", attempts: 1, at: ago(30) } }), car(["T-16"], { departs: "with T-15", accepted: [], notice: { state: "received", status: "delivered", attempts: 1, at: ago(30) } })] });
	const waiting = row("n", { app: "api", steps: gates([{ load: { max: 30, now: 42 } }]).slice(0, 5), cars: [car(["T-31"], { notice: { state: "received", status: "delivered", attempts: 1, at: ago(12) } })] });
	const mutualA = row("p", { steps: [passed(1, "assemble", "assemble", { holds: { lane: "web" } }), step(2, "merge", "in_progress", { holds: { lane: "web" }, waits: [{ lane: { app: "web", holder: code("m") } }] })], cars: [car(["T-40"])] });
	const mutualB = row("q", { app: "infra", steps: [passed(1, "assemble"), step(2, "deploy", "in_progress", { holds: { target: "target-a" }, waits: [{ target: { target: "target-a", holder: code("m") } }, { lock: { name: "heavy", holder: { train: code("n"), step: 4 } } }] })], cars: [car(["T-41"], { accepted: [] })] });
	const round2 = row("r", { round: 2, removed: [{ ticket: "T-12", why: said("unit 測試失敗", "unit tests failed"), notice: { state: "dropped", status: "pending", attempts: 2, last: "queued" } }], cars: [car(["T-15"])], steps: [
		passed(1, "assemble", "assemble", { outcome: "void", why: "superseded" }), step(2, "full-check", "completed", { name: "unit", outcome: "void", why: "superseded" }),
		passed(3, "assemble", "assemble", { round: 2 }), passed(4, "review", "review", { round: 2 }), step(5, "full-check", "in_progress", { name: "unit", round: 2, load: { max: 30, weight: 4 }, waits: [] }), step(6, "merge", "pending", { round: 2 }),
	] });
	const notices = row("t", { cars: [
		car(["T-51"], { notice: { state: "landed", status: "delivered", attempts: 1, at: ago(2) } }), car(["T-52"], { notice: { state: "returned", status: "pending", attempts: 2, last: said("排隊中", "queued") } }),
		car(["T-53"], { notice: { state: "dropped", status: "escalated", attempts: 4, at: ago(1) } }), car(["T-54"], { notice: { status: "unreadable", reason: "notice record: states.received must be an object", kind: "shape" } }), car(["T-55"], { notice: { state: "received", status: "pending", attempts: 0 } }),
	], steps: [passed(1, "assemble"), step(2, "land", "in_progress")] });
	const stale = row("k", { state: "stale", writerLive: false, updated: ago(44), holds: { lanes: ["web"], targets: [] }, steps: [passed(1, "assemble", "assemble", { holds: { lane: "web" } }), step(2, "full-check", "completed", { name: "unit", outcome: "failed" }), step(3, "merge", "completed", { outcome: "void", why: "skipped" }), step(4, "merge", "in_progress", { holds: { lane: "web" } })] });
	const ended = row("e", { state: "ended", writerLive: false, key: undefined, updated: ago(300), steps: [passed(1, "assemble"), passed(2, "review"), passed(3, "full-check", "unit"), passed(4, "merge"), passed(5, "ci"), passed(6, "land")] });
	const bad = row("b", { state: "unreadable", key: undefined, reason: "file is 70 KB, more than 64 KB", reasonKind: "toobig", cars: [], steps: [] });
	const forming = [
		{ code: code("s"), app: "web", status: "forming" as const, cars: [car(["T-20"], { departs: "alone", accepted: [{ kind: "e2e", nod: said("測過了", "tested") }] }), car(["T-21"], { departs: "after 23:30", accepted: [] })], departs: { maxCars: 4, maxWaitMin: 60, oldest: ago(37) } },
		{ code: code("u"), app: "api", status: "departing" as const, cars: [car(["T-22"], { departs: "by 18:00" })] }, { code: code("v"), app: "web", status: "refused" as const, cars: [car(["T-23"])] },
	];
	const parts: Record<TrainState, Partial<ProjectYard> & { trains: YardTrainRow[] }> = {
		all: { trains: [running, waiting, mutualB, round2, notices, stale, ended, bad], waiting: [code("q")], forming },
		forming: { trains: [], waiting: [], forming }, running: { trains: [running], waiting: [] }, waiting: { trains: [running, waiting], waiting: [] }, mutual: { trains: [running, waiting, mutualA, mutualB], waiting: [code("p"), code("q")] },
		round2: { trains: [round2], waiting: [] }, notices: { trains: [notices], waiting: [] }, stale: { trains: [stale], waiting: [] }, ended: { trains: [ended], waiting: [] }, unreadable: { trains: [bad], waiting: [] }, empty: { trains: [], waiting: [] }, loose: { trains: [], waiting: [] },
	};
	// The cars of billing-main (a1) and ops-main (a3) on their unit cards (docs/specs/2026-11-28-car-rows.md): riding, waiting on another train's load, forming, landed and dropped. The ladder is train e's, which landed.
	const fact = (ticket: string, coordinator: string, over: Partial<CarFact>): CarFact => ({ id: `acme/web-${ticket}#1`, project: "acme", app: "web", head: SHA, tickets: [ticket], coordinator, integrator: "integ-acme", phase: "riding", since: now - 12 * MIN, ...over });
	const cars: CarFact[] = [
		fact("T-15", "a1", { train: code("m"), stage: { kind: "full-check", at: 3, of: 6, attempt: 2 } }), fact("T-31", "a1", { app: "api", train: code("n"), since: now - 4 * MIN, stage: { kind: "full-check", at: 3, of: 6, attempt: 1 }, waits: [{ load: { max: 30, now: 42 } }] }),
		fact("T-51", "a1", { phase: "landed", train: code("t"), since: now - 2 * MIN, version: "2.4.0" }),
		fact("T-20", "a3", { phase: "waiting", train: code("s"), since: now - 37 * MIN, departs: { maxCars: 4, maxWaitMin: 60, oldest: ago(37) } }), fact("T-12", "a3", { phase: "dropped", train: code("r"), since: now - 8 * MIN, reason: said("unit 測試失敗", "unit tests failed") }),
	];
	const part = parts[state], acme: ProjectYard = { project: "acme", integrator: { key: "integ-acme", live: true }, forming: [], waiting: [], ...(state === "all" || state === "running" ? { cars } : {}), ...part };
	net.yards = { projects: state === "loose" ? [{ project: "orphan", forming: [], trains: [{ ...running, key: undefined }], waiting: [] }] : [acme] };
	net.load = { now: 42, cores: 14 };
	if (state === "loose") return;
	const unit = (key: string, name: string, role: Unit["role"], extra: Partial<Unit> = {}): Unit => ({ id: key, key, control: true, name, role, mark: "working", note: "thinking", subs: [], ...extra });
	const units = [unit("integ-acme", "integ acme", "main", { mark: "idle", note: undefined }), ...part.trains.filter((t) => t.key).map((t) => unit(t.key!, `train ${t.code.slice(5, 7)}${t.code.slice(8, 10)}${t.code.slice(-1)}`, "train", { train: { project: "acme", code: t.code }, mark: t.steps.some((s) => s.waits.length) ? "idle" : "working", note: undefined }))];
	net.bases[0]!.tabs.push({ id: "w1:trains", label: "trains", units });
}

/** `?trains=<state>` (a missing or unknown state is `all`) puts the trains on the demo net; `&yard` opens the yard a moment after the page starts. */
export function trainsFromUrl(net: Net, now: number): void {
	const params = new URLSearchParams(location.search), state = params.get("trains");
	if (state === null) return;
	trainsDemo(net, isTrainState(state) ? state : "all", now);
	if (params.has("yard")) setTimeout(() => document.querySelector<HTMLElement>("[data-yard]:not([hidden])")?.click(), 2500);
}
