import { watch as fsWatch } from "node:fs";
import type { Reply } from "../control.ts";
import type { Pane, Workspace, World } from "../herdr.ts";
import { ANSWER_ID, answerFile, ensureDir, listRequests, readResult, sweep, UUID, writeAtomic } from "./files.ts";
import { CHOICES, type TrustAnswer, type TrustAsk, type TrustChoice, type TrustGroup, type TrustRequest } from "./types.ts";

// The server's side of the trust question (docs/specs/2026-10-26-project-trust.md): lists the requests the asking pis left in <state>/trust/, one entry per folder and digest, and
// writes their answers. A request is listed only while its Herdr is this server's, its process lives, and Herdr lists its pane; one whose process is gone is removed (sweep).

const SETTLE_MS = 5000, STEP_MS = 100, KEEP_MS = 120_000;
const no = (status: number, error: string, reason: string, extra: Record<string, unknown> = {}): Reply => ({ status, body: { error, reason, ...extra } });
/** Text for the page: control characters are removed and Unicode format characters (bidi overrides, zero-width marks) drawn as U+FFFD. */
export const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").replace(/\p{Cf}/gu, "\ufffd");
const group = (g: TrustGroup): TrustGroup => ({ ...g, kind: clean(g.kind), path: clean(g.path), items: g.items.map(clean) });

export interface ServeDeps {
	/** <state>/trust */
	dir: string;
	/** The Herdr socket this server's net is read from. */
	herdr: string;
	world(): Promise<Pick<World, "panes" | "workspaces">>;
	/** The id of the page's opening that waits on a pane, when one does. */
	opening?(pane: string): string | undefined;
	now?(): number;
	sleep?(ms: number): Promise<void>;
}

export function createTrustServe(d: ServeDeps) {
	const now = d.now ?? Date.now, sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	// One answer per request, in memory (one server runs per machine): the answer id taken for it, and what became of it, kept for a resend of the same answer.
	const taken = new Map<string, { answerId: string; at: number; outcome: Promise<Reply> }>();

	/** The requests that count: this Herdr's, of a process that runs, whose pane Herdr lists in a workspace it lists. */
	function listed(panes: Pane[], workspaces: Workspace[]): TrustRequest[] {
		if (!ensureDir(d.dir)) return [];
		sweep(d.dir, now());
		for (const [id, t] of taken) if (now() - t.at > KEEP_MS) taken.delete(id);
		return listRequests(d.dir).filter((r) => {
			const pane = panes.find((p) => p.pane_id === r.pane);
			return r.herdr === d.herdr && Boolean(pane?.workspace_id && workspaces.some((w) => w.workspace_id === pane.workspace_id));
		});
	}
	const groupsOf = (all: TrustRequest[]) => Object.values(Object.groupBy(all, (r) => `${r.cwd}\u0000${r.digest}`)).map((g = []) => g);

	/** The snapshot's entries: one per folder and digest, the oldest request's id naming it. */
	function asks(panes: Pane[], workspaces: Workspace[]): TrustAsk[] {
		return groupsOf(listed(panes, workspaces)).map((g): TrustAsk => {
			const first = g[0]!, opening = g.map((r) => d.opening?.(r.pane)).find(Boolean);
			return {
				id: first.id, digest: first.digest, folder: clean(first.cwd), found: first.found.map(group),
				agents: g.map((r) => ({ pane: r.pane, base: clean(workspaces.find((w) => w.workspace_id === panes.find((p) => p.pane_id === r.pane)?.workspace_id)?.label ?? ""), role: r.role, at: r.at })),
				...(opening && { opening }),
			};
		}).sort((a, b) => a.agents[0]!.at - b.agents[0]!.at);
	}

	/** Waits for the requests' results: accepted when one says `remote` with this answer, stale when every request ended otherwise (`by`: how the first did), unknown when none came in time. */
	async function settle(ids: string[], answerId: string): Promise<Reply> {
		let by: string | undefined;
		for (let waited = 0; waited <= SETTLE_MS; waited += STEP_MS) {
			const results = ids.map((id) => readResult(d.dir, id)), live = listRequests(d.dir);
			if (results.some((r) => r?.by === "remote" && r.answerId === answerId)) return { status: 200, body: { outcome: "accepted" } };
			const ended = ids.filter((id, i) => results[i] || !live.some((r) => r.id === id)); // a request that is gone without a result: its pi ended
			by = ended.length ? (results.find((r) => r)?.by ?? "gone") : by;
			if (ended.length === ids.length) break;
			await sleep(STEP_MS);
		}
		return by ? { status: 200, body: { outcome: "stale", by } } : { status: 200, body: { outcome: "unknown" } };
	}

	/** POST trust/answer {id, digest, choice, answerId}: the page's answer, written for every request of the folder and digest. */
	async function answer(json: Record<string, unknown>): Promise<Reply> {
		const { id, digest, choice, answerId } = json;
		if (typeof id !== "string" || !UUID.test(id) || typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest) || !CHOICES.includes(choice as TrustChoice) || typeof answerId !== "string" || !ANSWER_ID.test(answerId)) return no(400, "bad_request", "The answer does not name its question.");
		const prior = taken.get(id);
		if (prior) return prior.answerId === answerId ? prior.outcome : no(409, "busy", "Another answer for this question is on its way.", { outcome: "busy" });
		const world = await d.world(), all = listed(world.panes, world.workspaces), target = all.find((r) => r.id === id);
		if (!target || target.digest !== digest) return no(409, "stale", "The question changed or is no longer open; read it again.", { outcome: "stale" });
		const members = all.filter((r) => r.cwd === target.cwd && r.digest === target.digest), ids = members.map((r) => r.id);
		const other = ids.map((i) => taken.get(i)).find(Boolean);
		if (other) return other.answerId === answerId ? other.outcome : no(409, "busy", "Another answer for this question is on its way.", { outcome: "busy" });
		const outcome = (async () => {
			for (const r of members) writeAtomic(d.dir, answerFile(r.id), { version: 1, id: r.id, digest: r.digest, choice: choice as TrustChoice, answerId } satisfies TrustAnswer);
			return settle(ids, answerId);
		})();
		for (const i of ids) taken.set(i, { answerId, at: now(), outcome });
		return outcome;
	}

	/** Calls `poke` when the directory changes, so a request shows at once and not at the next reading. */
	function watch(poke: () => void): () => void {
		try {
			if (!ensureDir(d.dir)) return () => {};
			const w = fsWatch(d.dir, () => poke());
			w.on("error", () => {});
			return () => w.close();
		} catch {
			return () => {}; // the net's own reading (every 2 s with a page) still sees it
		}
	}
	return { asks, answer, watch };
}
