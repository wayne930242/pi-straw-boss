import { isAbsolute, join, resolve } from "node:path";
import { Type } from "typebox";
import { createReturnWatch, type ReturnWatch } from "./carwait.ts";
import { bodyOf, fieldsOf } from "./headerfields.ts";
import { makeCtx, trusted } from "./server/client.ts";
import { slotOf } from "./server/record.ts";
import { callControl, type Reply } from "./server/socket.ts";
import { startOf } from "./startof.ts";
import type { Kit } from "./state.ts";
import { snapshotOfBranch } from "./todo.ts";
import { parseSlip, slipLines } from "./train/accept.ts";
import { CAR_STATES, type CarState, type CarView, coordinatorWord, forwardsOf, noticeText, validateStateFields } from "./train/cars.ts";
import { isName, isObject, type Json } from "./train/spec.ts";
import { type Manifest, rowsOfSnapshot, slipBlocks, type TrainGuard } from "./trainguard.ts";
import type { TrainId } from "./trainrole.ts";
import { integrationOff } from "./trainswitch.ts";

// `train_car` (docs/specs/2026-11-07-train-workers.md §5.5, §24; todo #125 task 5a): a train and the integrator set what became of a car, and the sb server tells its coordinator and confirms the delivery. The tool checks what only the session
// knows (its manifest, its branch, its todo list) and sends the state to the server, which checks what it can know itself and records it. The session proves itself to the server with a secret the server hands this process once and this process holds in memory only.

/** Where the secrets of the sessions this process has run are kept: on `globalThis`, so a `/reload` (a new module in the same process) finds the one it was given; never in env, argv, a file, or any text the model reads. */
const HELD = Symbol.for("pi-straw-boss.cars.secrets");
const heldSecrets = (): Map<string, string> => ((globalThis as { [HELD]?: Map<string, string> })[HELD] ??= new Map());

export type ServerCall = (request: Record<string, unknown>, timeoutMs?: number) => Promise<Reply | undefined>;

/** One request to the live sb server of this account over its control socket; undefined when none runs, it is not trusted, or it does not answer. A server is never started for it. */
export function callServer(env: NodeJS.ProcessEnv, stateDir: string): ServerCall {
	return async (request, timeoutMs = 10_000) => {
		try {
			const ctx = makeCtx({ env, slot: slotOf(stateDir, env), version: "0.0.0", cli: "cli.mjs", by: "train_car", spawn: () => { throw new Error("train_car never starts a server"); } });
			const record = await trusted(ctx);
			if (!record || !ctx.alive(record.pid)) return undefined;
			return (await callControl(record.socket, record.secret, { ...request, cmd: String(request.cmd) }, timeoutMs)).reply;
		} catch {
			return undefined;
		}
	};
}

export interface CarClientDeps {
	call: ServerCall;
	session(): string | undefined;
	pane(): string | undefined;
	pid?: number;
	started?(pid: number): string | undefined;
	/** Where the secret is kept (a test gives its own). */
	held?: Map<string, string>;
}
export interface CarSet { state: CarState; car: Json; fields: Json }
export interface SetAnswer { state: CarState; at: string; file: string; coordinator: string; notice?: string; unchecked?: string }

/** The session's way to the server's book of cars: it registers once, holds the secret in memory, and asks for states and for the cars of a project. */
export function createCarClient(d: CarClientDeps) {
	const pid = d.pid ?? process.pid, held = d.held ?? heldSecrets();
	const keyOf = () => `${d.session() ?? ""}|${pid}`;
	let registering: Promise<string> | undefined;
	const failure = (reply: Reply | undefined, what: string) => new Error(reply ? String(reply.error ?? `${what} was refused`) : "sb: the sb server did not answer (is it running?)");
	async function ensure(): Promise<string> {
		const key = keyOf(), kept = held.get(key);
		if (kept) return kept;
		return (registering ??= (async () => {
			const session = d.session(), pane = d.pane();
			if (!session || !pane) throw new Error("sb: this session has not joined the net yet; try again in a moment");
			const started = d.started?.(pid) ?? startOf(pid);
			const reply = await d.call({ cmd: "cars-register", session, pid, ...(started ? { started } : {}), pane });
			if (!reply?.ok || typeof reply.secret !== "string") throw failure(reply, "registering");
			held.set(key, reply.secret);
			return reply.secret;
		})().finally(() => { registering = undefined; }));
	}
	return {
		ensure,
		/** Registers if it has not (the extension tries early, before a shell can: see carbook.ts). Resolves quietly when it cannot. */
		async register(): Promise<boolean> { try { await ensure(); return true; } catch { return false; } },
		registered: () => held.has(keyOf()),
		async set(request: CarSet): Promise<SetAnswer> {
			for (let attempt = 0; ; attempt++) {
				const secret = await ensure();
				const reply = await d.call({ cmd: "cars-set", secret, state: request.state, car: request.car, fields: request.fields }, 120_000);
				if (reply?.ok) return reply as unknown as SetAnswer;
				// A server that started again knows no secret: register again, once.
				if (attempt === 0 && reply && /not from a registered session/.test(String(reply.error))) { held.delete(keyOf()); continue; }
				throw failure(reply, "the state");
			}
		},
		/** Asks the server whether it still holds this process's secret, and registers again when it does not (a server that restarted knows none). True when the session is registered afterwards. */
		async verify(): Promise<boolean> {
			const secret = held.get(keyOf());
			if (!secret) return this.register();
			const reply = await d.call({ cmd: "cars-check", secret });
			if (reply?.ok) return true;
			if (!reply) return false; // no answer: the server may be starting; the secret stays
			held.delete(keyOf());
			return this.register();
		},
		/** The cars of a project the server shows this session (the guard's source): a train's own, the integrator's own. */
		async read(project: string): Promise<CarView[]> {
			for (let attempt = 0; ; attempt++) {
				const secret = await ensure();
				const reply = await d.call({ cmd: "cars-read", project, secret });
				if (reply?.ok && Array.isArray(reply.cars)) return reply.cars as CarView[];
				if (attempt === 0 && reply && /not from a registered session/.test(String(reply.error))) { held.delete(keyOf()); continue; }
				throw failure(reply, "reading the cars");
			}
		},
	};
}
export type CarClient = ReturnType<typeof createCarClient>;

// ---- the tool

export interface CarCtx { cwd?: string; sessionManager: { getBranch(): readonly unknown[] } }
export interface CarToolDeps {
	role(): "train" | "main" | undefined;
	train(): TrainId | undefined;
	manifest(ctx: CarCtx): Manifest | undefined;
	client: Pick<CarClient, "set">;
	home: string;
	/** The integrator's wait for the notice of a car it returned (carwait.ts, #13): nothing else waits for that notice, so the session does. */
	returns?: Pick<ReturnWatch, "add">;
}
export interface CarParams { car: string; state: CarState; project?: string; train?: string; departs?: string; reason?: string; round?: number; evidence?: string; version?: string; commit?: string }
const FIELD_KEYS = ["train", "departs", "reason", "round", "evidence", "version", "commit"] as const;

/** The slip blocks of a forwarded message body: a `car: <app> | tickets: …` that follows the tower's own words starts a block of its own line. */
function slipsOf(body: string) {
	return slipBlocks(slipLines(body)).blocks.map(parseSlip);
}

const assembles = (rows: ReturnType<typeof rowsOfSnapshot>["rows"]) => rows.flatMap((r) => {
	const sb = isObject(r.metadata?.sb) ? (r.metadata!.sb as Json) : undefined;
	if (!sb || sb.kind !== "assemble" || !Number.isInteger(sb.round)) return [];
	const removed = isObject(sb.spec) && Array.isArray(sb.spec.removed) ? (sb.spec.removed as Json[]).flatMap((x) => (isObject(x) && typeof x.ticket === "string" ? [x.ticket] : [])) : [];
	return [{ round: sb.round as number, removed }];
});

export async function trainCar(deps: CarToolDeps, params: CarParams, ctx: CarCtx): Promise<{ text: string; details: unknown }> {
	const role = deps.role();
	if (!role) throw new Error("sb: train_car is for a train and for the integrator; this session is neither");
	const state = params.state;
	if (!(CAR_STATES as readonly string[]).includes(state)) throw new Error(`sb: state "${String(state)}" is not one of ${CAR_STATES.join(", ")}`);
	if (typeof params.car !== "string" || !params.car.trim()) throw new Error("sb: car is the car's first ticket (the first of the slip's tickets:, not its car:, which names the app)");
	const ticket = params.car.trim();
	if (role === "train" && state === "received") throw new Error("sb: a train does not set received: the integrator does, at receipt");
	if (role === "main" && (state === "dropped" || state === "landed")) throw new Error(`sb: only a train sets ${state}; the integrator sets received and returned`);
	const fields: Json = {};
	for (const key of FIELD_KEYS) if (params[key] !== undefined) fields[key] = params[key];
	if (typeof fields.evidence === "string" && !isAbsolute(fields.evidence)) fields.evidence = fields.evidence === "~" || fields.evidence.startsWith("~/") ? join(deps.home, fields.evidence.slice(2)) : resolve(ctx.cwd ?? process.cwd(), fields.evidence);
	const bad = validateStateFields(state, fields);
	if (bad.length) throw new Error(bad.join("; "));
	const entries = ctx.sessionManager.getBranch(), { rows } = rowsOfSnapshot(snapshotOfBranch(entries));

	let car: Json, coordinator: string;
	if (role === "main") {
		// The slip is one a tower forwarded to this session, and the session that sent it to the tower is the coordinator (§5.5).
		const found = forwardsOf(entries, fieldsOf).flatMap((forward) => slipsOf(bodyOf(forward.text)).filter((s) => s.tickets.includes(ticket)).map((slip) => ({ forward, slip })));
		const hit = found.at(-1);
		if (!hit) throw new Error(`sb: car ${ticket} is on no forwarded slip of this session: a car slip reaches the integrator as the tower's forward, whose header names its sender (fwd-from)`);
		const f = hit.slip.fields, head = f.head, claimed = f.coordinator;
		if (!head || !/^[0-9a-f]{40}$/.test(head) || !f.car || !f.branch || !claimed) throw new Error(`sb: the slip of car ${ticket} needs car:, branch:, head: (40 hex) and coordinator:`);
		if (state === "received" && claimed !== hit.forward.from) throw new Error(coordinatorWord(ticket, claimed, hit.forward.from));
		const project = params.project ?? rows.map((r) => (isObject(r.metadata?.sb) && (r.metadata!.sb as Json).kind === "train" ? (r.metadata!.sb as Json).project : undefined)).find((p) => typeof p === "string");
		if (!isName(project)) throw new Error("sb: give project (the integrator's project, a path-safe name), or create the train todo first");
		coordinator = claimed;
		car = { project, app: f.car, head, tickets: hit.slip.tickets, branch: f.branch, coordinator: claimed };
	} else {
		const manifest = deps.manifest(ctx), mine = manifest?.cars.find((c) => c.ticket === ticket || c.row?.tickets.includes(ticket));
		if (!mine?.head) throw new Error(`sb: car ${ticket} is not in this train's manifest`);
		const slip = parseSlip(mine.slip), app = slip.fields.car ?? manifest?.app;
		if (!app) throw new Error(`sb: the slip of car ${ticket} names no app (car:)`);
		const plan = assembles(rows), listed = (round: number) => plan.some((a) => a.round === round && a.removed.includes(ticket));
		if (state === "returned" && !listed(1)) throw new Error(`sb: car ${ticket} is returned from the manifest only when round 1's assemble lists it in spec.removed: create that assemble first`);
		if (state === "dropped") {
			const round = Number(fields.round);
			if (plan.some((a) => a.round <= round && a.removed.includes(ticket))) throw new Error(`sb: car ${ticket} was out of the train before round ${round}`);
			if (!listed(round + 1)) throw new Error(`sb: car ${ticket} is dropped from round ${round} when round ${round + 1}'s assemble lists it in spec.removed: create that assemble first`);
		}
		if (state === "landed" && plan.some((a) => a.removed.includes(ticket))) throw new Error(`sb: car ${ticket} was removed from the train, so it cannot land`);
		coordinator = slip.fields.coordinator ?? "";
		car = { app, head: mine.head, tickets: mine.row?.tickets ?? slip.tickets, branch: slip.fields.branch ?? "" };
	}
	const answer = await deps.client.set({ state, car, fields });
	const told = answer.coordinator || coordinator;
	// A car returned at receipt is on no train, so no step of a train waits for its notice: this session does, and calls the tower when the server lost it.
	const waiting = role === "main" && state === "returned" && deps.returns !== undefined;
	if (waiting) deps.returns!.add({ project: String(car.project), app: String(car.app), head: String(car.head), ticket, coordinator: told, at: answer.at, line: answer.notice ?? noticeText("returned", { ticket, head: String(car.head), reason: String(fields.reason) }) });
	const waits = waiting ? "this session waits for that and calls the tower itself if the sb server loses the notice" : `${state === "received" ? "the train todo" : state === "landed" ? "the land step" : "the assemble that removes it"} waits for that${state === "received" ? " before the manifest goes to the tower" : ""}`;
	const text = `Car ${ticket} is ${state}. sb tells its coordinator (${told}) by session id and confirms the delivery; ${waits}. You send no notice yourself.${answer.unchecked ? ` Received unchecked: ${answer.unchecked}.` : ""}`;
	return { text, details: { car: ticket, ...answer } };
}

const FIRST_LOOK_MS = 3_000;

/** The tool of a train and of the integrator. Registered when the session has joined the net, unless the merge train is off. `callTower` is this session's `blocked` call to its tower, for a returned car whose notice the server lost (carwait.ts). */
export function trainCarTool(kit: Kit, guard: () => TrainGuard | undefined, link: ReturnType<typeof carLink>, callTower: (text: string) => Promise<unknown>) {
	const { pi, s, cfg } = kit, { client } = link;
	let registered = false;
	return () => {
		if (s.isTower || registered || !link.enabled()) return;
		registered = true;
		link.keepRegistering();
		// The wait for the notices of the cars this session returned: a look soon after each return, then every 15 s while one is still awaited (also after a /reload, which finds the waits of the module before it).
		const watch = createReturnWatch({ session: () => kit.me() || undefined, read: (project) => client.read(project), callTower, now: cfg.now });
		let timer: ReturnType<typeof setTimeout> | undefined, stopped = false;
		const look = (ms: number) => {
			if (stopped || timer || !watch.size()) return;
			timer = setTimeout(() => { timer = undefined; void watch.tick().catch(() => undefined).then(() => look(CHECK_MS)); }, ms);
			timer.unref?.();
		};
		look(FIRST_LOOK_MS);
		// A reload keeps the waits (the module loaded next goes on with them); any other end of the session hands them to the tower, since nobody waits after it.
		pi.on("session_shutdown", async (event) => {
			stopped = true;
			if (timer) clearTimeout(timer);
			if (event.reason !== "reload" && watch.size()) await watch.end().catch(() => undefined);
		});
		const deps: CarToolDeps = {
			role: () => (s.isTrain ? "train" : kit.role() === "main" ? "main" : undefined), train: () => (s.isTrain ? s.train : undefined),
			manifest: (ctx) => guard()?.manifestOf(ctx as never), client, home: process.env.HOME ?? "",
			returns: { add: (wait) => { watch.add(wait); look(FIRST_LOOK_MS); } },
		};
		pi.registerTool({
			name: "train_car", label: "train_car",
			description: "Set what became of a car: the sb server tells the car's coordinator by session id and confirms the delivery, and the step that depends on it waits for that. For the integrator (state received with train and departs, or returned with reason, at receipt) and a train (returned with reason, dropped with round, reason and evidence, landed with version and commit). Never send a coordinator a notice yourself.",
			parameters: Type.Object({
				car: Type.String({ description: "The car's first ticket: the first of the slip's tickets:, not the slip's car: (which names the car's app)." }),
				state: Type.Union(CAR_STATES.map((x) => Type.Literal(x))),
				project: Type.Optional(Type.String({ description: "Integrator only, when no train todo names the project yet." })),
				train: Type.Optional(Type.String({ description: "received: the train's code, YYYY-MM-DD-<letters>." })),
				departs: Type.Optional(Type.String({ description: "received: the departure conditions in words." })),
				reason: Type.Optional(Type.String({ description: "returned, dropped: why, the refusal's word verbatim when sb gave one (at most 600 characters)." })),
				round: Type.Optional(Type.Number({ description: "dropped: the round the car is dropped from." })),
				evidence: Type.Optional(Type.String({ description: "dropped: the path of the failing log or review finding." })),
				version: Type.Optional(Type.String({ description: "landed: the version it landed in." })),
				commit: Type.Optional(Type.String({ description: "landed: the 40-hex commit on the base's remote branch." })),
			}),
			execute: async (_id, params, _signal, _update, ctx) => {
				const out = await trainCar(deps, params as CarParams, ctx as unknown as CarCtx);
				return { content: [{ type: "text", text: out.text }], details: out.details };
			},
		});
	};
}

const CHECK_MS = 15_000;

/** The client of this session and the early registration: the secret is asked for as soon as the session has an id and a pane, before a shell of the model can ask, and again after a server restart (a check every 15 s finds that the server forgot it). Inert without a server link. */
export function carLink(kit: Kit, delays: readonly number[] = [500, 1000, 2000, 5000, 10_000, 30_000]) {
	const { cfg, pi } = kit;
	const call: ServerCall = cfg.server ? callServer(cfg.env, kit.guiDir) : async () => undefined;
	const client = createCarClient({ call, session: () => kit.me() || undefined, pane: () => kit.s.at?.paneId });
	let timer: ReturnType<typeof setTimeout> | undefined, stopped = false;
	return {
		client,
		enabled: () => !integrationOff(cfg.env, kit.guiDir) && cfg.server !== null && cfg.server !== undefined,
		/** Asks to register at once and again until it works, quickly at first (the secret is asked for before a shell of the model can ask), then once a minute; once it works it asks the server every 15 s whether it still knows the secret. */
		keepRegistering() {
			stopped = false;
			const attempt = (n: number, ok = false) => {
				timer = setTimeout(() => void client.verify().then((now) => { if (!stopped) attempt(now ? 0 : n + 1, now); }), ok ? CHECK_MS : (delays[Math.min(n, delays.length - 1)] ?? 60_000));
				timer.unref?.();
			};
			attempt(0);
			pi.on("session_shutdown", () => { stopped = true; if (timer) clearTimeout(timer); });
		},
	};
}
