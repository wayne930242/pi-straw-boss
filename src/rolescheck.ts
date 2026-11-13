import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { ROLES_DIR } from "./rolepack.ts";
import { PARENT_ONLY } from "./tools.ts";

// `/boss roles-check [folder]` (docs/specs/2026-11-09-agent-kinds.md §9, "Acceptance for the tool sets"): each role's `tools:` names against the tools
// of the session it runs in, plus the names only a child has. It reads files and compares names: no process starts.

/** Tools a child has that its parent does not, and where they come from. */
export const CHILD_ONLY: Record<string, string> = {
	caller_ping: "pi-herdr-agents' child extension (launch.ts:762)",
	subagent_done: "pi-herdr-agents' child extension, for a role that does not auto-exit (launch-command.ts:67)",
	watch_read: "sb, in a child only (§10)",
	watch_report: "sb, in a child only (§10)",
};
/** pi-herdr-agents' worktree tools: registered with `parentSession` only (pi-extension/subagents/index.ts:383, :512). */
export const HOST_PARENT_ONLY: Record<string, string> = {
	worktree_list: "pi-herdr-agents, outside a child (pi-extension/subagents/index.ts:512)",
	worktree_remove: "pi-herdr-agents, outside a child (pi-extension/subagents/index.ts:512)",
};

export interface RoleTools { name: string; tools?: string[] }
export interface Failure { role: string; tool: string; reason: string }

/** The pure comparison: every name resolves, and none is parent-only. */
export function rolesCheck(roles: RoleTools[], toolNames: string[], childOnly: Record<string, string>, parentOnly: Record<string, string>): { ok: boolean; lines: string[]; failures: Failure[] } {
	const have = new Set(toolNames), lines: string[] = [], failures: Failure[] = [];
	for (const role of roles) {
		if (!role.tools) {
			lines.push(`${role.name}: every tool (no tools: line)`);
			continue;
		}
		const where = role.tools.map((tool) => {
			const reason = parentOnly[tool] ? `parent-only: ${parentOnly[tool]}` : childOnly[tool] || have.has(tool) ? undefined : "no such tool in this session";
			if (reason) failures.push({ role: role.name, tool, reason });
			return `${tool} (${reason ? `FAIL, ${reason}` : childOnly[tool] ?? "this session"})`;
		});
		lines.push(`${role.name}: ${where.join(", ")}`);
	}
	return { ok: failures.length === 0, lines, failures };
}

/** The role files of a folder: each one's name (the file stem) and its `tools:` list, when it has one. */
export function readRoles(dir = ROLES_DIR): RoleTools[] {
	return readdirSync(dir).filter((file) => file.endsWith(".md")).sort().map((file) => {
		const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(join(dir, file), "utf8"))?.[1] ?? "";
		const tools = /^tools:\s*(.*)$/m.exec(front)?.[1];
		return { name: basename(file, ".md"), ...(tools === undefined ? {} : { tools: tools.split(",").map((t) => t.trim()).filter(Boolean) }) };
	});
}

const NARROWED = /^--(?:exclude-)?tools(?:=|$)/;
export const NARROWED_TEXT = "roles-check needs a session started without --tools or --exclude-tools";

/** The command: refuses in a session whose tools were narrowed at start (pi's getAllTools honours the flags), else checks the folder given or sb's own roles/. */
export function runRolesCheck(args: string, { argv = process.argv, tools, parentOnly = PARENT_ONLY }: { argv?: readonly string[]; tools(): string[]; parentOnly?: readonly string[] }): { ok: boolean; text: string } {
	if (argv.some((arg) => NARROWED.test(arg))) return { ok: false, text: NARROWED_TEXT };
	const given = args.trim(), dir = given ? resolve(given.replace(/^~(?=$|\/)/, homedir())) : ROLES_DIR;
	let roles: RoleTools[];
	try {
		roles = readRoles(dir);
	} catch (error) {
		return { ok: false, text: `roles-check cannot read ${dir}: ${(error as Error).message}` };
	}
	const result = rolesCheck(roles, tools(), CHILD_ONLY, { ...Object.fromEntries(parentOnly.map((name) => [name, "sb, outside a child"])), ...HOST_PARENT_ONLY });
	const head = result.ok ? `roles-check passed: ${roles.length} roles in ${dir}` : `roles-check failed: ${result.failures.length} name(s) in ${dir}`;
	return { ok: result.ok, text: [head, ...result.lines, ...result.failures.map((f) => `${f.role}: ${f.tool} — ${f.reason}`)].join("\n") };
}
