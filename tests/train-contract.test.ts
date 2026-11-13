import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkContract, CONTRACT, declaredContract, type SkillCommand } from "../src/train/contract.ts";

// The merge-train contract (src/train/contract.ts, docs/specs/2026-11-07-train-workers.md §14.1): Straw Boss asks pi which `integrating` and `deploying` skills it loaded and reads the contract each declares.
// It names no package: a skill from any package passes when its frontmatter declares the contract.

const root = fileURLToPath(new URL("..", import.meta.url));
const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const scratch = () => (roots.push(realpathSync(mkdtempSync(join(tmpdir(), "sb-contract-")))), roots.at(-1)!);
const DECLARES = 'metadata:\n  merge-train-contract: "1"\n';
/** A skill as a package ships it (`<pkg>/skills/<name>/SKILL.md`), and the command pi lists for it. */
function skill(pkg: string, name: string, front = DECLARES): SkillCommand {
	const file = join(pkg, "skills", name, "SKILL.md");
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `---\nname: ${name}\ndescription: Use when testing ${name}.\n${front}---\n\n# ${name}\n\nmetadata:\n  merge-train-contract: "1"\n`);
	return { name: `skill:${name}`, source: "skill", sourceInfo: { path: file } };
}
const both = (pkg: string, front = DECLARES) => [skill(pkg, "integrating", front), skill(pkg, "deploying", front)];
const refusal = (commands: readonly SkillCommand[] | undefined) => { const got = checkContract(commands); assert.equal(got.ok, false, "the contract check refuses"); return (got as { refusal: string }).refusal; };

test("the two skills pi loaded pass when each declares the contract Straw Boss follows", () => {
	const pkg = scratch();
	assert.equal(CONTRACT, 1);
	assert.deepEqual(checkContract(both(pkg)), { ok: true, contract: 1 });
	assert.deepEqual(checkContract([{ name: "review", source: "prompt" }, ...both(pkg, "metadata:\n  author: someone\n  merge-train-contract: 1 # the seams and the Acceptance row\nlicense: MIT\n")]), { ok: true, contract: 1 }, "unquoted, among other metadata, with a comment");
	assert.deepEqual(checkContract(both(pkg, "metadata:\n  merge-train-contract: '1 2'\n")), { ok: true, contract: 1 }, "a skill that implements several versions names each");
});

test("a skill pi did not load is refused by name, before anything is read", () => {
	const pkg = scratch();
	assert.match(refusal([]), /^sb: the merge train needs the skills `integrating` and `deploying` to declare merge-train contract 1, and pi loaded no skill named `integrating`; install a package that provides it and \/reload, then try again$/);
	assert.match(refusal([skill(pkg, "integrating")]), /pi loaded no skill named `deploying`/);
	assert.match(refusal([skill(pkg, "integrating"), { ...skill(pkg, "deploying"), source: "prompt" }]), /no skill named `deploying`/, "a prompt or an extension command of that name is no skill");
	assert.match(refusal([skill(pkg, "integrating"), { name: "skill:deploying", source: "skill" }]), /no skill named `deploying`/, "a skill with no file is none");
	assert.match(refusal(undefined), /this pi does not list its skills/, "a pi without getCommands");
});

test("a skill that declares no contract, or declares it anywhere but under `metadata:` in its frontmatter, is refused with the lines it needs", () => {
	const pkg = scratch();
	const said = refusal(both(pkg, ""));
	assert.match(said, /skills\/integrating\/SKILL\.md declares none \(its frontmatter needs `metadata:` with `merge-train-contract: "1"` under it\); update the package that ships it and \/reload, then try again$/, "the body's own words are not the frontmatter");
	assert.match(refusal([skill(pkg, "integrating"), skill(pkg, "deploying", "")]), /skills\/deploying\/SKILL\.md declares none/, "each skill declares for itself");
	assert.match(refusal(both(pkg, 'merge-train-contract: "1"\n')), /declares none/, "a top-level key");
	assert.match(refusal(both(pkg, 'metadata:\n  note: x\nother:\n  merge-train-contract: "1"\n')), /declares none/, "under another key");
	assert.match(refusal(both(pkg, 'metadata:\n  # versions\n  host:\n    merge-train-contract: "1"\n')), /declares none/, "under a key of metadata, not metadata itself");
	rmSync(join(pkg, "skills", "deploying", "SKILL.md"));
	assert.match(refusal([skill(pkg, "integrating"), { name: "skill:deploying", source: "skill", sourceInfo: { path: join(pkg, "skills", "deploying", "SKILL.md") } }]), /skills\/deploying\/SKILL\.md cannot be read \(ENOENT/);
});

test("an older contract is refused and so is one only newer than Straw Boss's, each naming which side to update", () => {
	const pkg = scratch();
	assert.match(refusal(both(pkg, 'metadata:\n  merge-train-contract: "0"\n')), /skills\/integrating\/SKILL\.md declares "0"; update the package that ships it and \/reload, then try again$/);
	assert.match(refusal(both(pkg, 'metadata:\n  merge-train-contract: "2 3"\n')), /declares "2 3"; update pi-straw-boss and \/reload, then try again$/);
	assert.match(refusal(both(pkg, "metadata:\n  merge-train-contract: yes\n")), /declares "yes"; its value lists the contract versions the skill implements, such as "1"/);
	assert.match(refusal(both(pkg, "metadata:\n  merge-train-contract:\n")), /declares ""; its value lists/);
});

test("declaredContract reads only the frontmatter's `metadata:` block", () => {
	assert.equal(declaredContract('---\nname: x\nmetadata:\n  merge-train-contract: "1"\n---\n'), "1");
	assert.equal(declaredContract('\uFEFF---\r\nname: x\r\nmetadata:\r\n    merge-train-contract: 1, 2\r\n---\r\nbody'), "1, 2");
	assert.equal(declaredContract('name: x\nmetadata:\n  merge-train-contract: "1"\n'), undefined, "no frontmatter");
	assert.equal(declaredContract('---\nname: x\n---\nmetadata:\n  merge-train-contract: "1"\n'), undefined, "after the frontmatter");
	assert.equal(declaredContract('---\ndescription: |\n  metadata:\n    merge-train-contract: "1"\n---\n'), undefined, "inside another key's text");
});

// ---- no transition: a skill with no declaration is refused, whichever package ships it

test("an undeclared skill is refused, also inside a pi-anchorloop 2.15.x package (the old pass is gone)", () => {
	const pkg = scratch();
	writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: ["pi", "anchorloop"].join("-"), version: "2.15.2" }));
	assert.match(refusal(both(pkg, "")), /skills\/integrating\/SKILL\.md declares none/);
});

test("src and prompts name no skills package", () => {
	const files = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
	const naming = [...files("src"), ...files("prompts")].filter((file) => /pi-anchorloop/i.test(readFileSync(join(root, file), "utf8")));
	assert.deepEqual(naming, []);
	for (const file of files("prompts")) assert.doesNotMatch(readFileSync(join(root, file), "utf8"), /anchorloop/i, `${file} names the contract, not who implements it`);
});
