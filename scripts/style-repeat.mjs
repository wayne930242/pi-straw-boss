// Check two complete captures of the same build (§10.1). For comparisons across builds use
// style-diff.mjs on individual cells: an intentional theme difference isn't a Standard failure.
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [a, b] = process.argv.slice(2);
if (!a || !b) throw Error('Usage: node scripts/style-repeat.mjs FIRST_DIR SECOND_DIR');
const diff = fileURLToPath(new URL('./style-diff.mjs', import.meta.url));
let identical = 0, zero = 0;
for (const view of ['standard', 'geek', 'raven', 'storybook-day', 'storybook-night', 'zen']) {
	for (const size of ['1440x900', '390x844']) for (const route of ['map', 'head', 'workspace', 'session', 'settings']) {
		const cell = `${view}-${size}-${route}`, name = cell + '.json';
		process.stdout.write(`${cell}: `);
		const styles = spawnSync(process.execPath, [diff, join(a, name), join(b, name)], { stdio: 'inherit' });
		if (styles.error) throw styles.error;
		if (styles.status === 0) identical++;
		const image = cell + '.png';
		for (const root of [a, b]) if (!statSync(join(root, image)).size) throw Error(`Empty screenshot: ${join(root, image)}`);
		if (view !== 'standard') continue;
		const pixels = spawnSync('magick', ['compare', '-metric', 'AE', join(a, image), join(b, image), 'null:'], { encoding: 'utf8' });
		if (pixels.error) throw pixels.error;
		const metric = pixels.stderr.trim();
		console.log(`${cell}: AE ${metric}`);
		if (pixels.status === 0 && /^0(?:\s*\(0\))?$/.test(metric)) zero++;
	}
}
console.log(`Identical styles ${identical}/60; Standard AE zero ${zero}/10`);
if (identical !== 60 || zero !== 10) process.exitCode = 1;
