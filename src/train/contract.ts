import { readFileSync } from "node:fs";

// The merge-train contract (docs/specs/2026-11-07-train-workers.md §14.1, TB-F008). The train's and the integrator's prompts follow two skills by name, `integrating` and `deploying`, and assume what version 1 of the contract
// holds (the seven seams read from one `## Seam bindings` block, the Project skill headings with `## Acceptance`, the car slip); a model cannot tell a stale procedure from a current one by reading the skill. So a skill declares
// the contract versions it implements in its frontmatter, under the Agent Skills `metadata` map (the one field the specification leaves to clients):
//
//     metadata:
//       merge-train-contract: "1"
//
// and the guard asks this module. It names no package: the skills are the two pi loaded for this session (`pi.getCommands()`, each with the SKILL.md the model reads), whoever ships them. A skill pi did not load, a file that
// cannot be read, no declaration, or a declaration without this version refuses the train's and the integrator's mutating calls with the reason. The version is a whole number that rises only when a host written for the one
// before would go wrong; a skill that still serves the older hosts lists both ("1 2").

export const CONTRACT = 1;
export const CONTRACT_SKILLS = ["integrating", "deploying"] as const;
export type Contract = { ok: true; contract: number } | { ok: false; refusal: string };
/** A row of `pi.getCommands()`, as far as this reads it. */
export interface SkillCommand { name: string; source?: string; sourceInfo?: { path?: string } }

/** The value of `merge-train-contract` under the frontmatter's `metadata:`, unquoted; undefined when the text declares none. Any other spelling of the two lines reads as none, which refuses. */
export function declaredContract(text: string): string | undefined {
	const lines = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1]?.split(/\r?\n/) ?? [];
	const at = lines.findIndex((line) => /^metadata:\s*(#.*)?$/.test(line));
	let indent: string | undefined;
	for (const line of at < 0 ? [] : lines.slice(at + 1)) {
		if (/^\S/.test(line)) break;
		if (/^\s*(#.*)?$/.test(line)) continue;
		indent ??= /^\s+/.exec(line)![0]; // the map's own keys: a key nested deeper is another map's
		const found = /^(\s+)merge-train-contract:\s*(.*?)\s*(?:\s#.*)?$/.exec(line);
		if (found?.[1] === indent) return found[2]!.replace(/^(["'])(.*)\1$/, "$2");
	}
	return undefined;
}

export function checkContract(commands: readonly SkillCommand[] | undefined, need = CONTRACT): Contract {
	const refuse = (why: string): Contract => ({ ok: false, refusal: `sb: the merge train needs the skills ${CONTRACT_SKILLS.map((name) => `\`${name}\``).join(" and ")} to declare merge-train contract ${need}, and ${why}, then try again` });
	if (!commands) return refuse("this pi does not list its skills (pi.getCommands); update pi");
	for (const name of CONTRACT_SKILLS) {
		const file = commands.find((c) => c.source === "skill" && c.name === `skill:${name}` && c.sourceInfo?.path)?.sourceInfo?.path;
		if (!file) return refuse(`pi loaded no skill named \`${name}\`; install a package that provides it and /reload`);
		let text: string;
		try { text = readFileSync(file, "utf8"); } catch (error) { return refuse(`${file} cannot be read (${(error as Error).message}); fix it and /reload`); }
		const said = declaredContract(text);
		if (said === undefined) return refuse(`${file} declares none (its frontmatter needs \`metadata:\` with \`merge-train-contract: "${need}"\` under it); update the package that ships it and /reload`);
		const versions = said.split(/[\s,]+/).filter(Boolean);
		if (!versions.length || versions.some((v) => !/^\d+$/.test(v))) return refuse(`${file} declares ${JSON.stringify(said)}; its value lists the contract versions the skill implements, such as "${need}"`);
		if (!versions.includes(String(need))) return refuse(`${file} declares ${JSON.stringify(said)}; update ${versions.every((v) => Number(v) > need) ? "pi-straw-boss" : "the package that ships it"} and /reload`);
	}
	return { ok: true, contract: need };
}
