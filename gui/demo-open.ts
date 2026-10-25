// The demo's stand-in for the opening API (spawn.ts on the server): a folder tree under /demo, and an open that takes about 20 s and reports its
// steps as the server does (POST open/progress). A first message or a name with "fail" in it makes the join step fail, to see the failure.

const tree: Record<string, string[]> = { "/demo": ["Desktop", "Documents", "harbor-api", "sbd-playground", "中文專案"], "/demo/harbor-api": ["web", "worker"], "/demo/sbd-playground": ["base-check", "claude-check", "a-folder-with-a-very-long-name-that-has-to-be-cut"], "/demo/Desktop": ["notes"] };
const STEPS = [["create", 1500], ["start", 6000], ["join", 9000], ["deliver", 2500]] as const;
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function demoOpen(): void {
	const real = globalThis.fetch.bind(globalThis), opens = new Map<string, { at: number; plan: string[]; fail: boolean }>();
	globalThis.fetch = async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url, at = /api\/(dirs(?:\/\w+)?|open\/\w+)$/.exec(url)?.[1];
		if (!at || init?.method !== "POST") return real(input, init);
		const json = JSON.parse(String(init.body ?? "{}")) as Record<string, string>;
		if (at === "dirs/places") return reply(200, { home: "/demo", sep: "/", places: [{ name: "Desktop", path: "/demo/Desktop" }, { name: "Documents", path: "/demo/Documents" }], recent: ["/demo/harbor-api", "/demo/sbd-playground/base-check"] });
		if (at === "dirs/new") {
			const path = `${json.path}/${json.name}`;
			if (/[/\\:*?"<>|]/.test(json.name ?? "") || !json.name?.trim()) return reply(400, { error: "bad_name", reason: "A folder name has no / \\ : * ? \" < > | in it." });
			const created = !(path in tree);
			if (created) {
				(tree[json.path!] ??= []).push(json.name);
				tree[path] = [];
			}
			return reply(200, { path, created });
		}
		if (at === "dirs") {
			const path = json.path ?? "/demo";
			return reply(200, { path, home: "/demo", sep: "/", parent: path === "/demo" ? null : path.slice(0, path.lastIndexOf("/")) || "/demo", dirs: tree[path] ?? [], truncated: false });
		}
		if (at === "open/progress") {
			const open = opens.get(json.id!), now = Date.now();
			if (!open) return reply(404, { error: "not_found", reason: "No such opening." });
			let from = open.at;
			const steps = open.plan.map((id) => {
				const [, ms] = STEPS.find(([s]) => s === id)!, start = from, end = (from += ms);
				return { id, state: now >= end ? "done" : now >= start ? "active" : "pending", ms: Math.max(0, Math.min(now, end) - start) };
			});
			const joining = steps.find((s) => s.id === "join")!, failed = open.fail && joining.state === "active" && joining.ms > 5000 ? { step: "join", reason: "The pi in pane w1:p9 did not join the net within 60 s" } : undefined;
			return reply(200, { steps: steps.map((s) => (failed && s.id === "join" ? { ...s, state: "failed" } : s)), finished: false, ...(failed && { failed }) });
		}
		const plan = ["create", "start", "join", ...(json.prompt?.trim() ? ["deliver"] : [])], fail = /fail/i.test(`${json.label ?? ""}${json.prompt ?? ""}`);
		opens.set(json.deploy!, { at: Date.now(), plan, fail });
		const total = plan.reduce((sum, id) => sum + STEPS.find(([s]) => s === id)![1], 0);
		await new Promise((done) => setTimeout(done, fail ? 5000 + STEPS[0][1] + STEPS[1][1] : total));
		return fail ? reply(502, { error: "open_failed", reason: "The pi in pane w1:p9 did not join the net within 60 s", step: "join" }) : reply(200, { workspace: "w1", session: "t1", pane: "w1:p9" });
	};
}
