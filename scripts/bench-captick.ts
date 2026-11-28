// The capacity tick's cost with N mains (docs/specs/2026-11-28-stale-snooze.md, Performance): each main has a 50,000-record ledger (projected once into its capacity file, as capfill.ts does)
// and a 128 MiB session file (sparse, with real entries at its end). A tick is what the sb server does each minute for them: stat and read each session file's own move (worked.ts), read the
// capacity files, and join them. Run: node scripts/bench-captick.ts [mains] [ticks]. It prints ms per tick, first (cold) and then with nothing changed, and the session side's projection.
import { appendFileSync, mkdtempSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capDir, capOfTodos, capTasksOf, joinCaps, type MainFacts, openTodos, readCaps, writeCap } from "../src/capacity.ts";
import { createWorked } from "../src/server/worked.ts";

const N = Number(process.argv[2] ?? 20), TICKS = Number(process.argv[3] ?? 20), RECORDS = 50_000, FILE = 128 * 1024 * 1024, SERVER = "sb-server-1", NOW = Date.now();
const root = mkdtempSync(join(tmpdir(), "psb-bench-")), dir = capDir(join(root, "board"));
try {
	const snapshot = { tasks: Array.from({ length: RECORDS }, (_, i) => ({ id: i + 1, subject: `task ${i + 1} of the ledger`, status: i % 10 === 0 ? "pending" : "completed" })), nextId: RECORDS + 1 };
	let t = performance.now();
	const list = capTasksOf(snapshot), facts = { ...capOfTodos(list, snapshot), todos: openTodos(list, snapshot) };
	const project = performance.now() - t;
	const files: string[] = [];
	for (let i = 0; i < N; i++) {
		const session = `0190${String(i).padStart(4, "0")}-0000-7000-8000-000000000000`, file = join(root, `${session}.jsonl`);
		writeCap(dir, { v: 1, session, updated: NOW, ...facts });
		writeFileSync(file, "");
		truncateSync(file, FILE - 64 * 1024);
		appendFileSync(file, `\n${Array.from({ length: 200 }, (_, k) => JSON.stringify({ type: "message", timestamp: new Date(NOW - 3600_000 + k).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "x".repeat(200) }] } })).join("\n")}\n`);
		files.push(file);
	}
	const worked = createWorked(SERVER), sessions = files.map((f) => f.slice(root.length + 1, -".jsonl".length));
	const tick = () => {
		const mains = files.map((file, i): MainFacts => {
			const st = statSync(file), own = worked(file, st.mtimeMs);
			return { session: sessions[i]!, name: `m${i}`, workspace: "w", role: "main", state: "idle", workers: [], fileMtime: st.mtimeMs, ...(typeof own === "number" ? { worked: own } : {}) };
		});
		return joinCaps({ mains, caps: readCaps(dir), load1: 0, cores: 8, unattended: true, now: NOW });
	};
	t = performance.now(); tick(); const cold = performance.now() - t;
	const runs: number[] = [];
	for (let k = 0; k < TICKS; k++) { t = performance.now(); tick(); runs.push(performance.now() - t); }
	runs.sort((a, b) => a - b);
	console.log(JSON.stringify({ mains: N, records: RECORDS, sessionFileMiB: FILE / 1048576, projectMs: +project.toFixed(2), coldTickMs: +cold.toFixed(2), unchangedTickMedianMs: +runs[runs.length >> 1]!.toFixed(2), unchangedTickMaxMs: +runs.at(-1)!.toFixed(2) }));
} finally {
	rmSync(root, { recursive: true, force: true });
}
