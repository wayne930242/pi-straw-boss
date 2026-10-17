import type { Mark } from "../src/dashboard.ts";
import type { Net, Unit } from "../src/net.ts";
import type { Source } from "./stream.ts";

// The demo net for `npm run gui:dev`: invented names, state changes on a timer, and a stream that can be dropped to see the
// disconnected page. It stands in for the server's EventSource, so the real reconnect logic runs against it.

const unit = (id: string, name: string, role: Unit["role"], mark: Mark, note?: string, subs: Unit[] = []): Unit => ({ id, name, role, mark, note, subs });
const demo = (): Net => ({
	bases: [
		{ id: "w1", label: "Harbor API", mark: "working", head: true, tower: { name: "tower · Harbor API", mark: "working" }, outposts: [{ id: "w1-fix", label: "harbor-api-hotfix", mark: "working" }], tabs: [
			{ id: "w1:t1", label: "billing", units: [unit("a1", "billing-main", "main", "working", "tool:edit", [unit("a1/lint", "lint-sweep", "subagent", "working", "tool:bash"), unit("a1/docs", "docs-writer", "subagent", "done", "finished")]), unit("a2", "billing-tests", "member", "idle")] },
			{ id: "w1:t2", label: "ops", units: [unit("a3", "ops-main", "main", "waiting", "waiting on a question")] },
		] },
		{ id: "w2", label: "Lighthouse Web", mark: "working", head: false, tower: { name: "tower · Lighthouse Web", mark: "idle" }, outposts: [], tabs: [
			{ id: "w2:t1", label: "checkout", units: [unit("b1", "checkout-main", "main", "working", "thinking", [unit("b1/e2e", "e2e-runner", "subagent", "working", "thinking")]), unit("b2", "checkout-style", "member", "working", "tool:read")] },
		] },
		{ id: "w3", label: "Orchard Data", mark: "idle", head: false, tower: { name: "tower · Orchard Data", mark: "done" }, outposts: [], tabs: [
			{ id: "w3:t1", label: "etl", units: [unit("c1", "etl-main", "main", "idle")] },
		] },
		{ id: "w4", label: "Quarry Tools", mark: "idle", head: false, tower: null, outposts: [], tabs: [] },
	],
});

// Where each state can go next: work mostly continues, sometimes asks a question or finishes; an error is rare.
const NEXT: Record<Mark, Mark[]> = { working: ["working", "waiting", "idle", "done"], waiting: ["working"], idle: ["working"], done: ["working"], error: ["working"], unknown: ["working"] };
const units = (net: Net) => net.bases.flatMap((b) => b.tabs.flatMap((t) => t.units.flatMap((u) => [u, ...u.subs])));

export interface Control { drop(): void; silence(): void; restore(): void }

export function createFixture({ resume, tick = 2500 }: { resume(): void; tick?: number }): { open(): Source; control: Control } {
	let net = demo(), step = 0, dropped = false, silent = false, current: FixtureSource | undefined;
	class FixtureSource implements Source {
		fail: () => void = () => {};
		private listeners = new Map<string, ((data: string) => void)[]>();
		private timers: ReturnType<typeof setInterval>[] = [];
		constructor() {
			current = this;
			// A dropped server answers a connection with an error, as a stopped one would.
			if (dropped) this.timers.push(setTimeout(() => this.fail(), 300));
			else this.timers.push(setTimeout(() => this.send("message", net), 150), setInterval(() => this.send("ping", ""), 15_000));
		}
		onError(handler: () => void) {
			this.fail = handler;
		}
		listen(type: string, handler: (data: string) => void) {
			this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
		}
		send(type: string, payload: unknown) {
			if (silent) return;
			for (const l of this.listeners.get(type) ?? []) l(JSON.stringify(payload));
		}
		close() {
			this.timers.forEach((t) => (clearTimeout(t), clearInterval(t)));
			if (current === this) current = undefined;
		}
	}
	// Every tick one agent changes state, so the page always has something moving.
	setInterval(() => {
		const all = units(net);
		const pick = all[step % all.length]!;
		const options = NEXT[pick.mark];
		pick.mark = step % 17 === 16 ? "error" : options[step % options.length]!;
		pick.note = pick.mark === "working" ? "tool:edit" : pick.mark === "waiting" ? "waiting on a question" : undefined;
		net = structuredClone(net);
		step++;
		current?.send("message", net);
	}, tick);
	const control: Control = {
		drop: () => ((dropped = true), current?.fail()),
		silence: () => (silent = true),
		restore: () => ((dropped = false), (silent = false), resume()),
	};
	mountToolbar(control);
	return { open: () => new FixtureSource(), control };
}

function mountToolbar(control: Control) {
	const bar = document.createElement("div");
	bar.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:9;display:flex;gap:8px;align-items:center;padding:8px 10px;border-radius:12px;background:#0e1628;border:1px solid #2a3a60;font:12px system-ui;color:#8b99ba";
	bar.append("demo fixture:");
	for (const [label, run] of [["drop stream", control.drop], ["go silent", control.silence], ["restore", control.restore]] as const) {
		const button = document.createElement("button");
		button.textContent = label;
		button.style.cssText = "all:unset;cursor:pointer;padding:3px 9px;border-radius:8px;background:#1a2748;color:#dbe6ff";
		button.onclick = run;
		bar.append(button);
	}
	document.body.append(bar);
}
