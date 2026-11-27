/**
 * Spike 0a evidence probe, loaded with `-e` next to the installed pi-straw-boss. It reads only:
 * which extension registered `subagent` in this load, the load stamp the host wrote, and the
 * `pi-herdr-agents:runs:v1` answer of the loaded run owner. It appends one JSON line to
 * $SPIKE_PROBE_FILE at session start and each time the answer changes.
 */
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CHANNEL = "pi-herdr-agents:runs:v1";
const STAMP = Symbol.for("pi-herdr-agents/load-stamp");

export default function probe(pi: ExtensionAPI): void {
  const file = process.env.SPIKE_PROBE_FILE;
  if (!file || process.env.PI_SUBAGENT_ID) return;
  const write = (kind: string, data: Record<string, unknown>) => appendFileSync(file, `${JSON.stringify({ kind, at: new Date().toISOString(), pid: process.pid, ...data })}\n`);
  const ask = () => {
    const probe: { snapshot?: unknown } = {};
    pi.events.emit(CHANNEL, probe);
    return probe.snapshot;
  };
  let last = "";
  pi.on("session_start", () => {
    const tools = pi.getAllTools().filter((t) => /^subagent|^subagents_|^worktree_/.test(t.name)).map((t) => ({ name: t.name, source: t.sourceInfo.source, path: t.sourceInfo.path }));
    write("start", { tools, stamp: (globalThis as Record<symbol, unknown>)[STAMP] ?? null, runs: ask() ?? null });
    const timer = setInterval(() => {
      const runs = ask();
      const text = JSON.stringify(runs ?? null);
      if (text === last) return;
      last = text;
      write("runs", { runs: runs ?? null });
    }, 500);
    timer.unref();
  });
}
