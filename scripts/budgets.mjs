import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

// A script named by index.html and its static imports load at start; dynamic imports do not.
export function pageAssets(dir) {
	const html = readFileSync(join(dir, 'index.html'), 'utf8');
	const assets = readdirSync(join(dir, 'assets'));
	const entry = /assets\/(index-[\w-]+\.js)/.exec(html)?.[1];
	assert.ok(entry, 'index.html loads one entry script');
	const eager = new Set();
	function reach(name) {
		if (eager.has(name)) return;
		eager.add(name);
		const js = readFileSync(join(dir, 'assets', name), 'utf8');
		for (const [, dependency] of js.matchAll(/(?:from|import)\s*["']\.\/([\w.-]+\.js)["']/g)) reach(dependency);
	}
	reach(entry);
	for (const [, name] of html.matchAll(/<script\b[^>]*\bsrc="\.\/assets\/([\w.-]+\.js)"/g)) reach(name);
	const chunks = assets.filter(name => name.endsWith('.js') && !eager.has(name));
	const css = assets.filter(name => name.endsWith('.css'));
	return { eager, chunks, css };
}

function sizes(files) {
	let raw = 0, gz = 0;
	for (const name of files) {
		const bytes = readFileSync(name);
		raw += bytes.length;
		if (/\.(css|js)$/.test(name)) gz += gzipSync(bytes).length;
	}
	return { raw, gz };
}

export function measureBudgets(dir) {
	const themes = join(dir, 'themes');
	const rows = Object.fromEntries(readdirSync(themes).map(view => {
		const folder = join(themes, view);
		const files = readdirSync(folder, { recursive: true, withFileTypes: true }).filter(e => e.isFile());
		return [view, sizes(files.map(e => join(e.parentPath, e.name)))];
	}));
	const { eager, chunks, css } = pageAssets(dir);
	const assets = join(dir, 'assets');
	assert.ok(chunks.length && css.length, 'expected lazy JavaScript chunks and stylesheets');
	for (const [name, files] of [['eager', eager], ['chat', chunks], ['stylesheet', css]]) {
		assert.ok(!(name in rows), `theme name collides with page budget: ${name}`);
		rows[name] = sizes(Array.from(files, file => join(assets, file)));
	}
	return rows;
}

if (import.meta.main) {
	const root = join(import.meta.dirname, '..');
	const figures = measureBudgets(join(root, 'dist/gui'));
	console.table(figures);
	if (process.argv.includes('--write') || process.env.npm_config_write === 'true') {
		const path = join(root, 'tests/budgets.json');
		const recorded = JSON.parse(readFileSync(path, 'utf8'));
		assert.deepEqual(Object.keys(figures).sort(), Object.keys(recorded).sort(), 'set a design ceiling for each budget');
		const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
		for (const [name, { raw, gz }] of Object.entries(figures)) {
			const { ceiling } = recorded[name];
			assert.ok(Number.isSafeInteger(ceiling) && raw <= ceiling, `${name}: ${raw} raw bytes exceed ceiling ${ceiling}`);
			recorded[name] = { ceiling, raw, gz, sha };
		}
		writeFileSync(path, JSON.stringify(recorded, null, 2) + '\n');
	}
}
