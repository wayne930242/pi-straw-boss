import { rmSync } from "node:fs";
import { join, parse } from "node:path";
import { writeJson } from "./server/record.ts";
import { isSnapshotV1 } from "./todoledger.ts";

const empty = "no tasks remain", invalid = "the todo snapshot does not match todo/v1";
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Normalize the raw branch snapshot, never the board's abbreviated view. Task fields unknown to sb pass through. */
export function handoverSnapshot(snapshot: unknown) {
	if (snapshot === undefined) return { reason: empty };
	if (!object(snapshot) || !Array.isArray(snapshot.tasks) || typeof snapshot.nextId !== "number") return { reason: invalid };
	let nextId = snapshot.nextId;
	const kept: Record<string, unknown>[] = [], seen = new Set<unknown>();
	for (const t of snapshot.tasks as unknown[]) {
		if (!object(t) || seen.has(t.id)) return { reason: invalid };
		seen.add(t.id);
		if (typeof t.id === "number") nextId = Math.max(nextId, t.id + 1);
		if (t.status !== "deleted") kept.push(t);
	}
	if (!kept.length) return { reason: empty };
	const ids = new Set(kept.map((t) => t.id));
	const tasks = kept.map(({ blockedBy, ...task }) => {
		if (!Array.isArray(blockedBy)) return blockedBy === undefined ? task : { ...task, blockedBy };
		const deps = blockedBy.filter((id) => ids.has(id));
		return deps.length ? { ...task, blockedBy: deps } : task;
	});
	const data = { v: 1, tasks, nextId };
	return isSnapshotV1(data) ? { data } : { reason: invalid };
}

/** The successor receives a path only for a file this call wrote. Replace it atomically, before the tab opens. */
export function writeHandoverTodos(handoff: string, snapshot: unknown) {
	const { dir, name } = parse(handoff), path = join(dir, `${name}.todos.json`);
	const { data, reason } = handoverSnapshot(snapshot);
	if (!data) {
		rmSync(path, { force: true }); // no stale list beside a reused handoff
		return { written: false as const, count: 0, path: null, reason };
	}
	try { writeJson(path, data); } catch (error) {
		rmSync(path, { force: true }); // a failed replacement must not leave the old snapshot for this handoff
		throw error;
	}
	return { written: true as const, count: data.tasks.length, path };
}
