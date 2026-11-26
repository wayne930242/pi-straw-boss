// node scripts/style-diff.mjs before.json after.json. Exit 0 only for identical snapshots;
// added nodes list their display so a new Standard slot can be checked without shifting siblings.
import { readFileSync } from 'node:fs';

function load(file) {
	const { format, defaults, rows, nodes } = JSON.parse(readFileSync(file, 'utf8'));
	if (format !== 1 || !Object.hasOwn(nodes, 'html') || !Object.keys(defaults).length) throw Error(`Invalid snapshot: ${file}`);
	const styles = rows.map(row => {
		const style = { ...defaults, ...row };
		for (const prop in row) if (row[prop] === null) delete style[prop];
		return style;
	});
	for (const id of Object.values(nodes)) if (!Number.isInteger(id) || !styles[id]) throw Error(`Invalid style row ${id} in ${file}`);
	return { nodes, styles };
}

const [before, after] = process.argv.slice(2).map(load);
if (!before || !after) throw Error('Usage: node scripts/style-diff.mjs before.json after.json');
let changed = 0;
const report = line => { changed++; console.log(line); };
for (const path in before.nodes) if (!(path in after.nodes)) report(`removed ${path}`);
for (const path in after.nodes) if (!(path in before.nodes)) report(`added ${path} (display: ${after.styles[after.nodes[path]].display})`);
const pairs = new Map();
for (const path in before.nodes) {
	if (!(path in after.nodes)) continue;
	const a = before.nodes[path], b = after.nodes[path], key = `${a}:${b}`;
	if (!pairs.has(key)) {
		const left = before.styles[a], right = after.styles[b];
		pairs.set(key, [...new Set([...Object.keys(left), ...Object.keys(right)])].filter(p => left[p] !== right[p])
			.map(p => `${p}: ${JSON.stringify(left[p])} -> ${JSON.stringify(right[p])}`));
	}
	for (const difference of pairs.get(key)) report(`changed ${path} ${difference}`);
}
if (changed) process.exitCode = 1;
else console.log(`identical (${Object.keys(before.nodes).length} paths)`);
