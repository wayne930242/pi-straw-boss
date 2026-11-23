import type { Mark } from "../src/netdata.ts";
import type { Net, Unit } from "../src/net.ts";

// `?kinds` in the demo (docs/specs/2026-11-09-agent-kinds.md D16): one base with a unit of every kind, so the icons can be compared side by side: the three coordinator kinds, a train, and the four worker kinds under a main.
const unit = (key: string, name: string, role: Unit["role"], mark: Mark, over: Partial<Unit> = {}): Unit => ({ id: key, key, control: true, name, role, mark, subs: [], ...over });
const WORKERS = ["worker", "scout", "planner", "reviewer"] as const;

export function kindsFromUrl(net: Net, search = location.search) {
	if (!new URLSearchParams(search).has("kinds")) return;
	const workers = WORKERS.map((duty, i) => unit(`k/${duty}`, `${duty}-1`, "subagent", (["working", "working", "idle", "waiting"] as const)[i]!, { duty }));
	net.bases.push({ id: "wk", label: "Kind Yard", mark: "working", tower: null, outposts: [], outside: [], tabs: [{ id: "wk:t1", label: "kinds", units: [
		unit("k/coordinator", "coordinator-main", "main", "commanding", { duty: "coordinator", subs: workers }), unit("k/integrator", "integrator-main", "main", "working", { duty: "integrator" }),
		unit("k/standing", "standing-main", "main", "idle", { duty: "standing" }), unit("k/train", "train 1111a", "train", "working"), unit("k/member", "plain-member", "member", "idle"),
	] }] });
}
