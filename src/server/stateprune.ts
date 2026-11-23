import { lstatSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { boardPath, boardState, readBoard, readEnd, trainboardDir } from "../train/board.ts";
import type { TrainId } from "../trainrole.ts";
import { STALE_MS } from "../dead.ts";
import type { Pane, Session, Workspace } from "../herdr.ts";
import { integrationOff } from "../trainswitch.ts";
import { idOfName, reviveDir, sessionHeader } from "../revive.ts";
import { readRecords, rolesDir } from "../roles.ts";
import { trainFromToken } from "../trainrole.ts";
import { line } from "../safetext.ts";
import type { Slot } from "./record.ts";
import { towersDir, writeDurable } from "./towerstore.ts";
import { type SweepDeps, sweepTrainboards } from "./trainsweep.ts";
import { writerAlive } from "./traingate.ts";

// Retention table: roles need 14d of inactivity, no holder, and no live/revivable successor; towers need 14d since a successful missing look;
// trainboards and trains share the authoritative train end + 30d rule (train/board.ts), with live/open trains and indexed ledgers protected;
// revive ledgers need 7d of inactivity, no role, and no lock. Head, link, stash and procs use their own lifecycle or carry durable user state.
const DAY = 86_400_000, ROLE_AGE = 14 * DAY, MISSING_AGE = 14 * DAY, REVIVE_AGE = 7 * DAY;
const MISSING = ".missing-since.json", ROLE_GAP = 3_600_000;
/** First sightings of role records whose pane was missing, keyed by record file name: a record goes only on a second sighting an hour or more later. */
const ROLE_SEEN = MISSING;
export const PRUNE_EVERY_MS = DAY;

export interface PruneDeps {
	slot: Slot;
	env: NodeJS.ProcessEnv;
	now(): number;
	panes(): Promise<Pane[]>;
	workspaces(): Promise<Workspace[]>;
	sessions(): Promise<Session[]>;
	alive?: NonNullable<SweepDeps["alive"]>;
	/** Rechecked after asynchronous reads: a server that lost the slot can't remove anything. */
	skip?(): boolean;
	/** Herdr is restoring panes after a start (towers' `recoverUntil`): a pane it does not list yet may come back, so no role record goes. */
	recovering?(): boolean;
}

type Kind = "roles" | "trainboard" | "trains" | "tower" | "revive";
interface Counts { scanned: number; remove: number }
export interface PruneReport {
	dryRun: boolean;
	roles: Counts & { sighted: number };
	trainboard: Counts & { files: number; cars: number };
	trains: { remove: number };
	tower: Counts & { newlyMissing: number; reset: number };
	revive: Counts;
	skipped: Partial<Record<Kind, string>>;
	problems: string[];
}

const stat = (path: string) => lstatSync(path, { throwIfNoEntry: false });
function entries(dir: string) {
	const kind = stat(dir);
	if (!kind) return [];
	if (!kind.isDirectory()) throw new Error("expected a directory, not a symlink or file");
	return readdirSync(dir, { withFileTypes: true });
}

function trainRestoreNeeded(root: string, train: TrainId, now: number): boolean {
	const file = boardPath(root, train.project, train.code), folder = dirname(file);
	for (const dir of [trainboardDir(root), dirname(folder), folder]) {
		const st = stat(dir);
		if (!st) return false;
		if (!st.isDirectory()) return true;
	}
	const read = readBoard(file), { end, problem } = readEnd(file);
	return !read.ok || problem !== undefined || boardState(read.board, { now, alive: false, ...(end ? { end } : {}) }) !== "ended";
}

export async function pruneState(d: PruneDeps, dryRun = false): Promise<PruneReport> {
	const out: PruneReport = { dryRun, roles: { scanned: 0, remove: 0, sighted: 0 }, trainboard: { scanned: 0, remove: 0, files: 0, cars: 0 }, trains: { remove: 0 }, tower: { scanned: 0, remove: 0, newlyMissing: 0, reset: 0 }, revive: { scanned: 0, remove: 0 }, skipped: {}, problems: [] };
	const kinds: Kind[] = d.slot.primary ? ["roles", "trainboard", "trains", "tower", "revive"] : ["tower"];
	const fail = (reason: string) => {
		for (const kind of kinds) out.skipped[kind] = reason;
		return out;
	};
	const [p, w, s] = await Promise.allSettled([Promise.resolve().then(d.panes), Promise.resolve().then(d.workspaces), Promise.resolve().then(d.sessions)]);
	if (p.status !== "fulfilled" || w.status !== "fulfilled") return fail("Herdr could not be read");
	if (s.status !== "fulfilled") return fail("broker could not be read");
	const { value: ps } = p, { value: ws } = w, { value: sessions } = s;
	if (!Array.isArray(ps) || ps.some((x) => typeof x?.pane_id !== "string" || !x.pane_id) || !Array.isArray(ws) || ws.some((x) => typeof x?.workspace_id !== "string" || !x.workspace_id)) return fail("Herdr returned an invalid snapshot");
	if (!Array.isArray(sessions) || sessions.some((x) => typeof x?.id !== "string" || !x.id)) return fail("broker returned an invalid snapshot");
	if (d.skip?.()) return fail("server is leaving");
	const now = d.now(), { slot } = d, root = slot.stateDir;
	const attempt = (kind: Kind, fn: () => void) => {
		try { fn(); } catch (error) { out.problems.push(`${kind}: ${line((error as Error).message).slice(0, 230)}`); }
	};
	const remove = (path: string, recursive = false) => { if (!dryRun) rmSync(path, { recursive }); };
	const active = new Set(sessions.map((s) => s.id)), paneIds = new Set(ps.map((p) => p.pane_id));
	const paneFiles = new Set(ps.map((p) => p.agent_session?.value));
	const workspaces = new Set(ws.map((w) => w.workspace_id));
	// Individual reads can straddle a Herdr change. A pane or registered session is positive evidence even if the workspace list missed it.
	for (const p of ps) if (p.workspace_id) workspaces.add(p.workspace_id);
	for (const s of sessions) if (s.herdrLocation?.workspace?.id) workspaces.add(s.herdrLocation.workspace.id);

	try {
		for (const dir of [root, ...(slot.primary ? [] : [join(root, "servers"), slot.dir])]) {
			const st = stat(dir);
			if (!st) return out;
			if (!st.isDirectory()) return fail("state path is not a directory");
		}
	} catch { return fail("state path could not be read"); }

	attempt("tower", () => {
		const base = towersDir(slot);
		for (const item of entries(base)) {
			if (!item.isDirectory() || !/^[A-Za-z0-9_-]+$/.test(item.name)) continue;
			const dir = join(base, item.name), mark = join(dir, MISSING);
			out.tower.scanned++;
			attempt("tower", () => {
				const marker = stat(mark);
				if (marker && !marker.isFile()) throw new Error("missing-workspace marker is not a regular file");
				if (workspaces.has(item.name)) {
					if (marker) { remove(mark); out.tower.reset++; }
					return;
				}
				let since: unknown;
				if (marker) {
					try { since = JSON.parse(readFileSync(mark, "utf8")); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
				}
				if (typeof since !== "number" || !Number.isSafeInteger(since) || since <= 0 || since > now) {
					if (!dryRun) writeDurable(mark, now);
					out.tower.newlyMissing++;
				} else if (now - since >= MISSING_AGE) {
					if (!stat(dir)?.isDirectory()) return;
					remove(dir, true);
					out.tower.remove++;
				}
			});
		}
	});
	if (!slot.primary) return out;

	attempt("roles", () => {
		const folder = rolesDir(root);
		const names = new Set(entries(folder).filter((e) => e.isFile() && /^[a-f0-9]{32}\.json$/.test(e.name)).map((e) => join(folder, e.name)));
		out.roles.scanned = names.size;
		// Role records predate slots and have no slot field. The primary cannot prove absence in a secondary Herdr, even after its server stops.
		if (entries(join(root, "servers")).some((e) => /^[a-f0-9]{16}$/.test(e.name))) { out.skipped.roles = "role records are shared with a secondary Herdr"; return; }
		const records = readRecords(root).filter((r) => names.has(r.path));
		const recent = records.map(({ path, record }) => {
			const file = stat(record.file), stored = stat(path), id = idOfName(record.file) ?? sessionHeader(record.file)?.id;
			const kept = !stored?.isFile() || !Number.isFinite(record.at) || now - Math.max(record.at, stored.mtimeMs, record.ended?.at ?? 0, record.handedOver?.at ?? 0) <= ROLE_AGE ||
				paneIds.has(record.pane) || paneFiles.has(record.file) || (id !== undefined && active.has(id)) ||
				(file !== undefined && now - file.mtimeMs <= STALE_MS) ||
				(record.train !== undefined && record.role === "train" && trainRestoreNeeded(root, record.train, now));
			return { path, record, id, kept, stored };
		});
		const aliveIds = new Set([...active, ...recent.flatMap((r) => r.kept && r.id ? [r.id] : [])]);
		const seenPath = join(folder, ROLE_SEEN), seenStat = stat(seenPath);
		if (seenStat && !seenStat.isFile()) throw new Error("missing-pane sightings are not a regular file");
		let seen: Record<string, number> = {};
		if (seenStat) {
			try { const v: unknown = JSON.parse(readFileSync(seenPath, "utf8")); if (v && typeof v === "object" && !Array.isArray(v)) seen = v as Record<string, number>; } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
		}
		const next: Record<string, number> = {}, recovering = Boolean(d.recovering?.());
		for (const { path, record, kept, stored } of recent) {
			const h = record.handedOver, name = basename(path);
			if (kept || (h && (aliveIds.has(h.to) || (h.pane !== undefined && paneIds.has(h.pane))))) continue;
			if (recovering) { if (name in seen) next[name] = seen[name]!; continue; }
			const since = seen[name];
			if (typeof since !== "number" || !Number.isSafeInteger(since) || since <= 0 || since > now) { next[name] = now; out.roles.sighted++; continue; }
			if (now - since < ROLE_GAP) { next[name] = since; continue; }
			attempt("roles", () => {
				if (stat(join(reviveDir(root), `${name}.lock`))) { next[name] = since; return; }
				const latest = stat(path);
				if (!latest?.isFile() || latest.ino !== stored?.ino || latest.mtimeMs !== stored.mtimeMs) { next[name] = since; return; }
				remove(path);
				out.roles.remove++;
			});
		}
		// Records whose pane came back (kept) or that are gone drop out of the sightings.
		if (!dryRun && JSON.stringify(next) !== JSON.stringify(seen)) {
			if (Object.keys(next).length) writeDurable(seenPath, next);
			else if (seenStat) rmSync(seenPath);
		}
	});

	if (integrationOff(d.env, root)) out.skipped.trainboard = out.skipped.trains = "merge train is off";
	else attempt("trainboard", () => {
		const liveTrains = new Set(ps.flatMap((p) => { const id = trainFromToken(p.tokens?.sb_train); return id ? [`${id.project}/${id.code}`] : []; }));
		const swept = sweepTrainboards({ stateDir: root, now: () => now, dryRun, alive: (writer, board) => active.has(writer.session) || (writer.pane !== undefined && paneIds.has(writer.pane)) || liveTrains.has(`${board.project}/${board.code}`) || (d.alive ? d.alive(writer, board) : writerAlive(writer)) });
		out.trainboard = { scanned: swept.boards, remove: swept.removed.length, files: swept.files, cars: swept.removed.reduce((sum, r) => sum + r.cars, 0) };
		out.trains.remove = swept.ledgerFiles;
		out.problems.push(...swept.problems);
	});

	attempt("revive", () => {
		const dir = reviveDir(root);
		for (const item of entries(dir)) {
			if (!item.isFile() || !/^[0-9a-f]{32}\.json$/.test(item.name)) continue;
			out.revive.scanned++;
			const path = join(dir, item.name), st = stat(path);
			if (!st?.isFile() || now - st.mtimeMs <= REVIVE_AGE || stat(join(rolesDir(root), item.name)) || stat(`${path}.lock`)) continue;
			remove(path);
			out.revive.remove++;
		}
	});
	return out;
}

export interface PruneStart extends PruneDeps {
	log(event: string, facts: Record<string, string | number>): void;
	every?: (fn: () => Promise<void>, ms: number) => () => void;
}
export function startPrune(o: PruneStart) {
	let stopped = false, pending: Promise<PruneReport> | undefined;
	const run = () => pending ??= pruneState({ ...o, skip: () => stopped || Boolean(o.skip?.()) }).then((r) => {
		o.log("state-prune", { roles: r.roles.remove, rolesSighted: r.roles.sighted, boards: r.trainboard.remove, boardFiles: r.trainboard.files, ledgerFiles: r.trains.remove, tower: r.tower.remove, newlyMissing: r.tower.newlyMissing, revive: r.revive.remove, skipped: JSON.stringify(r.skipped), ...(r.problems.length ? { problems: line(r.problems.slice(0, 3).join("; ")).slice(0, 300) } : {}) });
		return r;
	}).finally(() => { pending = undefined; });
	const stop = (o.every ?? ((fn, ms) => { const timer = setInterval(() => void fn(), ms); timer.unref(); return () => clearInterval(timer); }))(async () => { await run(); }, PRUNE_EVERY_MS);
	return { first: run(), run, stop: () => { stopped = true; stop(); } };
}
