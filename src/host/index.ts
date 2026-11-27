/**
 * The Maestro host entry (spike 0a). It imports no Maestro module until the host is selected:
 * `PI_STRAW_BOSS_HOST`, then `<agentDir>/straw-boss/host.json`, then `~/.pi/agent/straw-boss/host.json`
 * (a child Maestro points at a local agent dir still finds the home file), else on. The boss chose
 * on by default for a plain npm install; slice 1 adds the double-host check that must stand down or
 * refuse when pi-herdr-agents also loads.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type HostChoice = "sb" | "off";

const parse = (value: unknown): HostChoice | undefined => (value === "sb" || value === "off" ? value : undefined);

function readChoice(file: string): HostChoice | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const host = parse((JSON.parse(text) as { host?: unknown }).host);
  if (!host) throw new Error(`pi-straw-boss: ${file} names no host ("sb" or "off")`);
  return host;
}

/** Which host this load runs, and where the answer came from. */
export function hostChoice(env: NodeJS.ProcessEnv = process.env, agentDir = getAgentDir(), home = homedir()): { host: HostChoice; from: string } {
  const fromEnv = env.PI_STRAW_BOSS_HOST;
  if (fromEnv !== undefined) {
    const host = parse(fromEnv);
    if (!host) throw new Error(`pi-straw-boss: PI_STRAW_BOSS_HOST=${fromEnv} names no host ("sb" or "off")`);
    return { host, from: "PI_STRAW_BOSS_HOST" };
  }
  for (const file of [...new Set([join(agentDir, "straw-boss", "host.json"), join(home, ".pi", "agent", "straw-boss", "host.json")])]) {
    const host = readChoice(file);
    if (host) return { host, from: file };
  }
  return { host: "sb", from: "default" };
}

export default async function strawBossHost(pi: ExtensionAPI): Promise<void> {
  if (hostChoice().host !== "sb") return;
  const { default: host } = await import("./engine.ts");
  await host(pi);
}
