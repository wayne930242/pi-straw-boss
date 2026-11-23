import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeName, type Tie } from "./childtie.ts";
import type { Reply } from "./socket.ts";

// Review threads (docs/specs/2026-11-23-lite-b2-d-e-f.md §2; boss decisions d_where=sb, d_attach=main_pairs, d_rounds=per_thread): a main pairs a worker and a reviewer with `boss_pair` before it dispatches them, and the two children talk on
// thread T<n> with `thread_post` and `thread_wait` (src/threadtools.ts) until the reviewer approves (`done`), either member gives up (`blocked`), or the server closes it. The server numbers the posts, keeps the round cap, and closes
// the thread; it never sends the main anything. Both children's `thread_wait` return `closed`, they write their final reports and end, and pi-herdr-agents delivers the two results: that is the main's only wake.
//
// Rules: only the reviewer posts `fix` (one repair round each) and `done`; only the worker posts `review`; a `fix` past `rounds` is refused and closes the thread `blocked` ("N repair rounds used"). `done` or `blocked` closes it, and every
// later post is refused. No post for 2 hours, a member whose run ended (its activity file says done or is gone), or 24 hours since the pair close it `blocked` with the reason. `main` may be named only with `done` or `blocked`. Mentions
// route: a member's wait returns only the posts that name it.
//
// Storage: `<server folder>/threads/<owner8>/T<n>.jsonl` (the posts, append-only, mode 600) and `T<n>.json` (owner, members, rounds, the members' activity files). The posts are the truth: the round count, the last post and the close
// are read back from them, so a server restart keeps every thread as it was. A closed thread's files go 7 days after its close.

export const ROUNDS = 3, IDLE_MS = 2 * 3_600_000, TTL_MS = 24 * 3_600_000, HOLD_MS = 45_000, SWEEP_MS = 60_000, KEEP_MS = 7 * 24 * 3_600_000, MAX_TEXT = 4000, MAX_POSTS = 200, PER_OWNER = 8, READ_BYTES = 16 * 1024;
export const MEMBERS = ["worker", "reviewer"] as const;
export const TAGS = ["review", "fix", "done", "blocked", "note"] as const;
export type Member = (typeof MEMBERS)[number];
export type Tag = (typeof TAGS)[number];
export type To = Member | "main";
export interface Post { n: number; at: number; from: Member | "sb"; to: To[]; tag: Tag; text: string; refs?: number[] }
export interface Closed { by: Member | "sb"; tag: "done" | "blocked"; at: number; time: number; reason?: string }
interface Meta { id: string; owner: string; worker: string; reviewer: string; rounds: number; created: number; seen: Partial<Record<Member, string>> }
interface Thread extends Meta { folder: string; posts: Post[]; waits: Set<Waiter> }
interface Waiter { as: Member; since: number; done(reply: Reply): void }
export interface PostQuery { thread: string; to: unknown; tag: unknown; text: unknown; refs?: unknown }

export interface ThreadsDeps {
	/** The threads folder (`<server folder>/threads`). */
	dir: string;
	now(): number;
	/** Runs `fn` after `ms` and returns its cancel; a test gives one on a clock it moves. */
	timer(ms: number, fn: () => void): () => void;
	/** Whether a member's run ended (childtie.ts `childEnded`). */
	ended(activityFile: string): boolean;
	holdMs?: number;
	log?(event: string, facts: Record<string, string | number | boolean>): void;
}

const no = (error: string): Reply => ({ ok: false, error });
const ID = /^T[1-9][0-9]{0,5}$/;
/** Plain: no control or format character but a line break or a tab. */
const CONTROL = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const folderOf = (owner: string) => owner.slice(0, 8).replace(/[^A-Za-z0-9_-]/g, "_") || "_";
const span = (ms: number) => `${Math.round(ms / 3_600_000)} hours`;

export function createThreads(d: ThreadsDeps) {
	const all = new Map<string, Thread>(), holdMs = d.holdMs ?? HOLD_MS;
	const key = (folder: string, id: string) => `${folder}/${id}`;
	const closedOf = (t: Thread): Closed | undefined => {
		const last = t.posts.at(-1);
		return last && (last.tag === "done" || last.tag === "blocked") ? { by: last.from, tag: last.tag, at: last.n, time: last.at, ...(last.from === "sb" ? { reason: last.text } : {}) } : undefined;
	};
	const fixes = (t: Thread) => t.posts.filter((p) => p.tag === "fix").length;
	const lastAt = (t: Thread) => t.posts.at(-1)?.at ?? t.created;
	const summary = (t: Thread) => ({ thread: t.id, ref: key(t.folder, t.id), worker: t.worker, reviewer: t.reviewer, rounds: t.rounds, fixes: fixes(t), posts: t.posts.length, created: t.created, ...(closedOf(t) ? { closed: closedOf(t) } : { open: true }) });
	const files = (t: Pick<Thread, "folder" | "id">) => ({ meta: join(d.dir, t.folder, `${t.id}.json`), posts: join(d.dir, t.folder, `${t.id}.jsonl`) });
	const saveMeta = (t: Thread) => {
		const { meta } = files(t), body: Meta = { id: t.id, owner: t.owner, worker: t.worker, reviewer: t.reviewer, rounds: t.rounds, created: t.created, seen: t.seen };
		mkdirSync(join(d.dir, t.folder), { recursive: true, mode: 0o700 });
		writeFileSync(`${meta}.tmp`, JSON.stringify({ version: 1, ...body }), { mode: 0o600 });
		renameSync(`${meta}.tmp`, meta);
	};
	const find = (owner: string, id: string) => (ID.test(id) ? all.get(key(folderOf(owner), id)) : undefined);
	const ownOf = (t: Thread | undefined, owner: string) => (t && t.owner === owner ? t : undefined);
	const memberOf = (t: Thread, name: string): Member | undefined => (t.worker === name ? "worker" : t.reviewer === name ? "reviewer" : undefined);
	const forMe = (t: Thread, as: Member, since: number) => t.posts.filter((p) => p.n > since && p.from !== as && p.to.includes(as));
	const answer = (t: Thread, as: Member, since: number): Reply | undefined => {
		const posts = forMe(t, as, since), closed = closedOf(t), seq = t.posts.length;
		if (closed) return { ok: true, state: "closed", thread: t.id, posts, since: seq, closed };
		return posts.length ? { ok: true, state: "posts", thread: t.id, posts, since: seq } : undefined;
	};
	const wake = (t: Thread) => {
		for (const w of [...t.waits]) {
			const reply = answer(t, w.as, w.since);
			if (reply) w.done(reply);
		}
	};
	const append = (t: Thread, post: Omit<Post, "n" | "at">): Post => {
		const full: Post = { n: t.posts.length + 1, at: d.now(), ...post };
		mkdirSync(join(d.dir, t.folder), { recursive: true, mode: 0o700 });
		appendFileSync(files(t).posts, `${JSON.stringify(full)}\n`, { mode: 0o600 });
		t.posts.push(full);
		return full;
	};
	/** The server's own close: one `blocked` post from sb with the reason, to both members (and the main's record). */
	const close = (t: Thread, reason: string) => {
		if (closedOf(t)) return;
		append(t, { from: "sb", to: ["worker", "reviewer", "main"], tag: "blocked", text: reason });
		d.log?.("thread-closed", { thread: t.id, owner: t.owner.slice(0, 8), by: "sb", reason });
		wake(t);
	};
	/** Remembers the activity file a member speaks with, so its end is seen. */
	const see = (t: Thread, as: Member, tie: Tie) => {
		if (t.seen[as] === tie.activityFile) return;
		t.seen[as] = tie.activityFile;
		try { saveMeta(t); } catch (error) { d.log?.("thread-save-failed", { thread: t.id, error: (error as Error).message }); }
	};
	const tied = (tie: Tie, thread: unknown): { t: Thread; as: Member } | Reply => {
		if (typeof thread !== "string" || !ID.test(thread)) return no("thread is T<n>, as your task gives it");
		const t = ownOf(find(tie.parent, thread), tie.parent);
		if (!t) return no(`no thread ${thread} of the session that dispatched you`);
		const as = memberOf(t, tie.name);
		if (!as) return no(`you (${tie.name}) are not a member of ${thread}: its worker is ${t.worker}, its reviewer ${t.reviewer}`);
		see(t, as, tie);
		return { t, as };
	};

	function load(): void {
		let folders: string[] = [];
		try { folders = readdirSync(d.dir); } catch { return; }
		for (const folder of folders) {
			let names: string[] = [];
			try { names = readdirSync(join(d.dir, folder)).filter((f) => /^T[0-9]+\.json$/.test(f)); } catch { continue; }
			for (const name of names) {
				try {
					const meta = JSON.parse(readFileSync(join(d.dir, folder, name), "utf8")) as Meta;
					if (!ID.test(meta.id) || typeof meta.owner !== "string" || folderOf(meta.owner) !== folder) continue;
					let lines: string[] = [];
					try { lines = readFileSync(files({ folder, id: meta.id }).posts, "utf8").split("\n"); } catch { /* no post yet */ }
					const posts: Post[] = [];
					for (const line of lines) {
						try { const p = JSON.parse(line) as Post; if (p.n === posts.length + 1) posts.push(p); } catch { /* the empty tail, or a line cut by a crash */ }
					}
					all.set(key(folder, meta.id), { ...meta, seen: meta.seen ?? {}, folder, posts, waits: new Set() });
				} catch (error) {
					d.log?.("thread-load-failed", { file: `${folder}/${name}`, error: (error as Error).message });
				}
			}
		}
	}

	const api = {
		/** A main's `boss_pair`: thread T<n> of `owner` with the two names as pi-herdr-agents will write them. */
		pair(q: { owner: string; worker: string; reviewer: string; rounds?: number }): Reply {
			const worker = safeName(q.worker), reviewer = safeName(q.reviewer), rounds = q.rounds ?? ROUNDS;
			if (!worker || !reviewer) return no("worker and reviewer are the names you give subagent: letters, digits, spaces, or hyphens");
			if (worker === reviewer) return no(`worker and reviewer need two names (both read ${worker})`);
			if (!Number.isInteger(rounds) || rounds < 1 || rounds > ROUNDS) return no(`rounds is 1 to ${ROUNDS}`);
			const folder = folderOf(q.owner), mine = [...all.values()].filter((t) => t.owner === q.owner && !closedOf(t));
			if (mine.length >= PER_OWNER) return no(`at most ${PER_OWNER} open threads per main: wait for one to close`);
			const taken = mine.find((t) => memberOf(t, worker) || memberOf(t, reviewer));
			if (taken) return no(`${memberOf(taken, worker) ? worker : reviewer} is a member of open thread ${taken.id}: give each pair new names`);
			const n = 1 + Math.max(0, ...[...all.values()].filter((t) => t.folder === folder).map((t) => Number(t.id.slice(1))));
			const t: Thread = { id: `T${n}`, owner: q.owner, worker, reviewer, rounds, created: d.now(), seen: {}, folder, posts: [], waits: new Set() };
			try { saveMeta(t); } catch (error) { return no(`the thread could not be written: ${(error as Error).message}`); }
			all.set(key(folder, t.id), t);
			d.log?.("thread-paired", { thread: t.id, owner: q.owner.slice(0, 8), rounds });
			return { ok: true, thread: t.id, worker, reviewer, rounds };
		},
		/** A child's first run: the open thread of its dispatcher that names it, if any. */
		member(tie: Tie): Reply {
			const t = [...all.values()].find((x) => x.owner === tie.parent && !closedOf(x) && memberOf(x, tie.name));
			if (!t) return { ok: true, member: null };
			const as = memberOf(t, tie.name)!;
			see(t, as, tie);
			return { ok: true, member: { thread: t.id, as, rounds: t.rounds } };
		},
		post(tie: Tie, q: PostQuery): Reply {
			const got = tied(tie, q.thread);
			if ("ok" in got) return got;
			const { t, as } = got, closed = closedOf(t);
			if (closed) return no(`${t.id} is closed (${closed.tag} by ${closed.by} at #${closed.at}${closed.reason ? `: ${closed.reason}` : ""}): write your final report and end`);
			const tag = q.tag as Tag;
			if (!TAGS.includes(tag)) return no(`tag is one of ${TAGS.join(", ")}`);
			const to = q.to;
			if (!Array.isArray(to) || !to.length || to.some((x) => x !== "worker" && x !== "reviewer" && x !== "main") || new Set(to).size !== to.length) return no("to is a list of worker, reviewer, main");
			if (to.includes("main") && tag !== "done" && tag !== "blocked") return no("main may be named only with done or blocked: the main is woken by your final result when the thread closes");
			if (typeof q.text !== "string" || !q.text.trim() || q.text.length > MAX_TEXT || CONTROL.test(q.text.replace(/[\n\t]/g, " "))) return no(`text is 1 to ${MAX_TEXT} plain characters`);
			const refs = q.refs;
			if (refs !== undefined && (!Array.isArray(refs) || refs.length > 20 || refs.some((r) => !Number.isInteger(r) || r < 1 || r > t.posts.length))) return no(`refs are post numbers #1 to #${t.posts.length}`);
			if ((tag === "fix" || tag === "done") && as !== "reviewer") return no(`only the reviewer posts ${tag}; post review when your work is ready for it`);
			if (tag === "review" && as !== "worker") return no("only the worker posts review; the reviewer answers with fix or done");
			if (t.posts.length >= MAX_POSTS - 1 && tag !== "done" && tag !== "blocked") return no(`${t.id} holds ${t.posts.length} posts: post done or blocked`);
			if (tag === "fix" && fixes(t) >= t.rounds) {
				close(t, `${t.rounds} repair round${t.rounds > 1 ? "s" : ""} used`);
				return no(`${t.id} allows ${t.rounds} repair round${t.rounds > 1 ? "s" : ""} and all are used: the fix is refused, and the thread is closed blocked. Write your final report with the open findings and end`);
			}
			const post = append(t, { from: as, to: to as To[], tag, text: q.text, ...(refs?.length ? { refs: refs as number[] } : {}) });
			if (tag === "done" || tag === "blocked") d.log?.("thread-closed", { thread: t.id, owner: t.owner.slice(0, 8), by: as, tag });
			wake(t);
			const after = closedOf(t);
			return { ok: true, thread: t.id, n: post.n, ...(after ? { closed: after } : {}), ...(tag === "fix" ? { round: fixes(t), rounds: t.rounds } : {}) };
		},
		/** A child's long poll: the posts that name it after `since`, or `closed`, at once; else held until one comes or the hold ends (`unchanged`). */
		wait(tie: Tie, q: { thread: unknown; since?: unknown }): Promise<Reply> {
			const got = tied(tie, q.thread);
			if ("ok" in got) return Promise.resolve(got);
			const { t, as } = got, since = typeof q.since === "number" && Number.isInteger(q.since) && q.since >= 0 ? q.since : 0;
			const now = answer(t, as, since);
			if (now) return Promise.resolve(now);
			return new Promise<Reply>((resolve) => {
				let cancel = () => {};
				const w: Waiter = { as, since, done: (reply) => { t.waits.delete(w); cancel(); resolve(reply); } };
				t.waits.add(w);
				cancel = d.timer(holdMs, () => w.done({ ok: true, state: "unchanged", thread: t.id, posts: [], since: Math.max(since, t.posts.length) }));
			});
		},
		/** A main's read: its own `T<n>`, or `<owner8>/T<n>` of another main on this computer (a successor reads its predecessor's). The newest posts within 16 KB. */
		read(owner: string, ref: string): Reply {
			const m = /^(?:([A-Za-z0-9_-]{1,8})\/)?(T[0-9]+)$/.exec(ref);
			const t = m ? (m[1] ? all.get(key(m[1], m[2]!)) : ownOf(find(owner, m[2]!), owner)) : undefined;
			if (!t) return no(`no thread ${ref}${m?.[1] ? "" : " of this session"}: board_read lists your threads`);
			const posts = [...t.posts];
			let cut = 0;
			while (posts.length > 1 && JSON.stringify(posts).length > READ_BYTES) (posts.shift(), cut++);
			return { ok: true, ...summary(t), list: posts, ...(cut ? { cut } : {}) };
		},
		/** A main's threads, open first. */
		list(owner: string): Reply {
			const mine = [...all.values()].filter((t) => t.owner === owner).sort((a, b) => Number(Boolean(closedOf(a))) - Number(Boolean(closedOf(b))) || b.created - a.created || Number(b.id.slice(1)) - Number(a.id.slice(1)));
			return { ok: true, threads: mine.map(summary) };
		},
		/** Closes what went quiet, outlived its day, or lost a member; drops closed threads after 7 days. */
		sweep(): void {
			const now = d.now();
			for (const t of all.values()) {
				const closed = closedOf(t);
				if (closed) {
					if (now - closed.time >= KEEP_MS && !t.waits.size) {
						all.delete(key(t.folder, t.id));
						for (const f of Object.values(files(t))) rmSync(f, { force: true });
					}
					continue;
				}
				if (now - t.created >= TTL_MS) close(t, `open for ${span(TTL_MS)}, the thread's limit`);
				else if (now - lastAt(t) >= IDLE_MS) close(t, `no post for ${span(IDLE_MS)}`);
				else for (const as of MEMBERS) {
					const file = t.seen[as];
					if (file && d.ended(file)) { close(t, `the ${as} ${t[as]} ended without a close`); break; }
				}
			}
		},
		start(): () => void {
			load();
			api.sweep();
			let stopped = false, cancel = () => {};
			const tick = () => { if (stopped) return; api.sweep(); cancel = d.timer(SWEEP_MS, tick); };
			cancel = d.timer(SWEEP_MS, tick);
			return () => {
				stopped = true;
				cancel();
				for (const t of all.values()) for (const w of [...t.waits]) w.done({ ok: false, error: "the sb server is stopping; ask again" });
			};
		},
	};
	return api;
}
export type Threads = ReturnType<typeof createThreads>;
