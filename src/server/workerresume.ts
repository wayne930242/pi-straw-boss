import { existsSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { capDir, readDevice } from "../capacity.ts";
import { createReservations } from "../capres.ts";
import { type Opened, type OpenRequest, OpenLimitError, type PeerSender } from "../opener.ts";
import { fileRefusal, idOfName, sessionHeader } from "../revive.ts";
import { admitPoints } from "../workercap.ts";
import type { ResumeSpec } from "../workerslip.ts";
import { gate, turnOfDoor, type WorkerDoor, WorkerRepeat } from "./workerally.ts";
import { type BookEntry, bookOf, bookOfAsk, putBook, readBook } from "./workerbook.ts";
import { dropWorktree, modelRefusal, type Prepared, prepareWorktree, runGit, worktreeOf } from "./workeropen.ts";

// The box's door for a resume (docs/specs/2026-11-26-ally-workers.md, Resume): a `worker: … | resume: <session>` slip of the run's own device brings a worker that ended back as the same pi session, in its worktree, with
// a follow-up. On the same queue as the opens (`turnOfDoor`), so two resumes of one session cannot race. The book (workerbook.ts) only names the session: the worktree path is derived again, and the session file is checked
// (revive.ts `fileRefusal`) inside pi's sessions folder. Every refusal answers the slip's ask by code with its cause; another device's session reads as an unknown one.

const ago = (now: number, at: number) => ((m) => (m < 90 ? `${m} min ago` : `${Math.round(m / 60)} h ago`))(Math.max(0, Math.round((now - at) / 60_000)));
const canon = (p: string) => { try { return realpathSync(p); } catch { try { return join(realpathSync(dirname(p)), basename(p)); } catch { return resolve(p); } } };

/** pi's own file of a session when the book has none: `*_<id>.jsonl` one folder down in pi's sessions folder. */
function scanFile(root: string, session: string): string | undefined {
	try {
		for (const d of readdirSync(root, { withFileTypes: true })) if (d.isDirectory()) for (const f of readdirSync(join(root, d.name))) if (f.endsWith(`_${session}.jsonl`) && idOfName(f) === session) return join(root, d.name, f);
	} catch { /* no folder: no file */ }
	return undefined;
}
const unknown = (d: WorkerDoor, device: string, session: string) => {
	const mine = readBook(d.stateDir, d.now()).filter((x) => x.device === device && x.ended && x.main !== session).slice(-5).reverse();
	return `no worker of session ${session.slice(0, 8)} is on record here for your device (it lapsed after 7 days, or it never opened here)${mine.length ? `; your resumable ones: ${mine.map((x) => `${x.main.slice(0, 8)} (branch ${x.branch ?? "?"}, ${x.ended!.how} ${ago(d.now(), x.ended!.at)})`).join(", ")}` : ""}`;
};

export function resumeWorker(d: WorkerDoor, peer: PeerSender, request: OpenRequest & { slip: { spec: ResumeSpec; ask?: string } }): Promise<Opened> {
	const { spec, ask } = request.slip, session = spec.resume, device = peer.id.replace(/^link:/, ""), git = d.git ?? runGit;
	return turnOfDoor(d.stateDir, async () => {
		const prior = ask ? bookOfAsk(d.stateDir, d.now(), ask) : undefined;
		if (prior) throw new WorkerRepeat(`This slip already opened or resumed session ${prior.main.slice(0, 8)}; its report answers the device's ask, so nothing was opened or sent again`);
		let reservation: string | undefined, made: Prepared | undefined, checkout = "", opened: Opened | undefined, entry: BookEntry | undefined;
		const store = createReservations(capDir(join(d.stateDir, "board")), d.now);
		try {
			const { config, budget } = gate(d, peer);
			entry = bookOf(d.stateDir, d.now(), session, device);
			if (!entry || !entry.branch || !entry.baseSha) throw new OpenLimitError(unknown(d, device, session));
			const branch = entry.branch, label = entry.label ?? branch;
			if (spec.branch !== undefined && spec.branch !== branch) throw new OpenLimitError(`session ${session.slice(0, 8)} worked on branch ${branch}, not ${spec.branch}`);
			const live = d.live?.() ?? { routes: [] };
			const row = live.routes.find((r) => r.to === session);
			if (row?.final !== undefined || (!row && live.listed?.has(session))) throw new OpenLimitError("it is closing after its report; send the follow-up again in a minute");
			if (row) throw new OpenLimitError("it still runs; its report answers your earlier ask");
			checkout = await d.checkout();
			if (d.within !== undefined && !d.inside(checkout, d.within)) throw new OpenLimitError("this workspace's checkout is outside the project the team binds on this computer");
			const { dir, common } = await worktreeOf({ checkout, branch, home: d.home, git });
			if (live.routes.some((r) => r.path !== undefined && canon(r.path) === canon(dir))) throw new OpenLimitError(`another live worker holds the worktree ${dir}`);
			const root = d.sessionsRoot ?? "", file = (entry.file && existsSync(entry.file) ? entry.file : undefined) ?? scanFile(root, session);
			if (!file) throw new OpenLimitError(`its session file is gone (session ${session.slice(0, 8)})`);
			const header = sessionHeader(file);
			if (!header) throw new OpenLimitError("its session file has no pi session header");
			if (header.id !== session) throw new OpenLimitError(`its session file's header id (${header.id.slice(0, 13)}) is not ${session.slice(0, 13)}`);
			if (!header.cwd || canon(header.cwd) !== canon(dir)) throw new OpenLimitError(`the session's folder ${header.cwd ?? "(none)"} is not the worker's worktree ${dir}`);
			const model = spec.model !== undefined ? modelRefusal(config.models, spec.model) : entry.model !== undefined && !config.models.includes(entry.model) ? `the model it ran on, ${entry.model}, is no longer in this box's workers.models (${config.models.join(", ") || "none listed"}): give model` : undefined;
			if (model) throw new OpenLimitError(model);
			const points = spec.points ?? entry.points ?? 1;
			const got = admitPoints({ room: () => readDevice(capDir(join(d.stateDir, "board")), d.now()), store }, budget, points, { session: "", worker: "", self: true });
			if ("refusal" in got) throw new OpenLimitError(`${got.refusal}: this worker needs ${points}`);
			reservation = got.id;
			let came: string;
			if (existsSync(dir)) {
				const own = resolve(dir, await git(["rev-parse", "--git-common-dir"], dir).catch(() => "")), on = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], dir).catch(() => "");
				if (canon(own) !== canon(common)) throw new OpenLimitError(`${dir} is no worktree of this workspace's repository`);
				if (on !== branch) throw new OpenLimitError(`the worktree ${dir} is on ${on ? `branch ${on}` : "a detached HEAD"}, not ${branch}`);
				const head = await git(["rev-parse", "HEAD"], dir).catch(() => "");
				came = `the worktree was kept on the box, at ${head.slice(0, 12) || "an unread HEAD"}${entry.head && head && entry.head !== head ? ` (your last report's head was ${entry.head.slice(0, 12)})` : ""}, with whatever it held`;
			} else {
				made = await prepareWorktree({ checkout, spec: { label, branch, base: entry.baseSha, points }, home: d.home, ...(d.reserved ? { reserved: d.reserved(checkout) } : {}), git });
				came = made.rework ? `the worktree was made again from origin/${branch} at ${made.baseSha.slice(0, 12)}${entry.head && entry.head !== made.baseSha ? ` (your last known head was ${entry.head.slice(0, 12)})` : ""}` : `the branch was never pushed, so the worktree was made again from its base ${made.baseSha.slice(0, 12)}`;
			}
			const why = fileRefusal(file, { root, checkout: dir });
			if (why) throw new OpenLimitError(why);
			const useModel = spec.model ?? entry.model;
			opened = await d.open({ ...request, role: "worker", worker: { dir, branch, base: entry.base ?? entry.baseSha, points, label, ...(useModel ? { model: useModel } : {}), resume: { file, session, came, ...(spec.model ? { model: spec.model } : {}) } } });
			const { ended: _, ...kept } = entry;
			putBook(d.stateDir, d.now(), { ...kept, ask: ask ?? entry.ask, at: d.now(), file, points, ...(useModel ? { model: useModel } : {}) });
			d.route(opened, { points, branch, path: dir, base: entry.base ?? entry.baseSha, baseSha: made?.baseSha ?? entry.baseSha, label }, ask);
			try { store.claim(reservation, opened.main); } catch { /* it expires; the row counts the worker */ }
			d.log("worker-resumed", { main: session, branch, points, made: made !== undefined });
			return opened;
		} catch (error) {
			if (opened) return (d.log("worker-route-failed", { main: opened.main, why: (error as Error).message.slice(0, 200) }), opened);
			if (reservation) try { store.drop(reservation); } catch { /* it expires */ }
			if (made) await dropWorktree({ checkout, prepared: made, git });
			if (error instanceof WorkerRepeat) throw error;
			const why = (error as Error).message;
			d.log("worker-resume-refused", { session: session.slice(0, 8), why: why.slice(0, 200) });
			if (ask) await d.reply(ask, `The box did not resume worker ${entry?.label ?? spec.label} (session ${session.slice(0, 8)}, branch ${entry?.branch ?? spec.branch ?? "?"}): ${why}`).catch((e: Error) => d.log("worker-refused-reply-failed", { error: e.message.slice(0, 160) }));
			throw error;
		}
	});
}
