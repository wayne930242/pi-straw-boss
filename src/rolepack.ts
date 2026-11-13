import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// sb's role pack (docs/specs/2026-11-09-agent-kinds.md §9, D11): pi-herdr-agents resolves the roles a kind runs as from `roles/`, registered on its
// discovery event (its docs/roles.md, "Publish a role pack"). Every pi registers it, Herdr or not and child or not: a child that spawns resolves roles too.

export const ROLE_DISCOVERY_EVENT = "pi-herdr-subagents:roles:discover:v1";
export const ROLES_DIR = fileURLToPath(new URL("../roles", import.meta.url));

export default function rolePack(pi: ExtensionAPI): void {
	const unsubscribe = pi.events.on(ROLE_DISCOVERY_EVENT, (request) => {
		const discovery = request as { apiVersion?: unknown; register?(path: string): void };
		if (discovery.apiVersion === 1) discovery.register?.(ROLES_DIR);
	});
	pi.on("session_shutdown", unsubscribe);
}
