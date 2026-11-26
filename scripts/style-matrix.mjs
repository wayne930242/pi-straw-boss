// node scripts/style-matrix.mjs OUTDIR [PORT=4810] [SESSION_PREFIX=tc]. Serve the default gui:demo build with
// vite preview gui --outDir ../dist/demo --base /pi-straw-boss/ --host 127.0.0.1 --port PORT --strictPort.
// Any port works: style-diff ignores the origin inside CSS url()s, so parallel workers use their own ports.
// Requires agent-browser and a fresh, empty output directory. No CSS overrides or diff exclusions.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [dir, port = '4810', prefix = 'tc'] = process.argv.slice(2);
if (!dir || !/^\d{4,5}$/.test(port) || !/^[a-z0-9-]+$/.test(prefix)) throw Error('Usage: node scripts/style-matrix.mjs OUTDIR [PORT] [SESSION_PREFIX]');
const out = resolve(dir), session = `${prefix}-${randomUUID()}`;
mkdirSync(out, { recursive: true });
if (readdirSync(out).length) throw Error(`Not empty: ${out}`);
const source = readFileSync(new URL('./style-snapshot.js', import.meta.url), 'utf8');
const fixture = fileURLToPath(new URL('./style-fixture.js', import.meta.url));
const browser = (args, input) => execFileSync('agent-browser', ['--session', session, ...args], { input, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
const evaluate = code => JSON.parse(browser(['--json', 'eval', '--stdin'], code)).data.result;
const routes = { map: '', head: 'head', workspace: 'w/w1', session: 'w/w1/s/a1', settings: 'settings' };
const ready = { map: '#bases [data-key="w1"]', head: '#session-view .chat-list .tx', workspace: '#ws-view .say:not([hidden]) p', session: '#session-view .chat-list .tx', settings: '#settings-view:not([hidden])' };
const frame = 'new Promise(requestAnimationFrame)';
const freeze = `async () => {
	await document.fonts.ready;
	[...document.querySelectorAll('button')].find(b => b.textContent === 'go silent').click();
	// Let entrance classes expire before measuring the resting layout. Recompute the map's
	// wires using the final card positions, not a point halfway through its entrance.
	await new Promise(r => setTimeout(r, 900));
	document.activeElement?.blur(); // the session auto-focuses its composer; don't capture a blinking caret
	const zero = () => document.getAnimations().forEach(a => { a.pause(); a.currentTime = 0; });
	zero(); dispatchEvent(new Event('resize'));
	await ${frame}; await ${frame}; zero(); await ${frame};
	if (document.documentElement.hasAttribute('data-calm')) throw Error('Unexpected calm state');
}`;
console.log(`session ${session}`);
try {
	// Skia's GPU gradient dithering can differ by 1–2 channel levels between fresh Chrome
	// processes on the same host. Raster on the CPU; keep the original pixels and exact AE.
	browser(['--args', '--disable-gpu,--disable-skia-runtime-opts,--force-color-profile=srgb', '--init-script', fixture, 'open']);
	for (const [width, height] of [[1440, 900], [390, 844]]) {
		browser(['set', 'viewport', String(width), String(height), '1']);
		for (const label of ['standard', 'geek', 'raven', 'storybook-day', 'storybook-night', 'zen']) {
			const [view, phase] = label.split('-');
			for (const [route, path] of Object.entries(routes)) {
				const url = new URL(`http://127.0.0.1:${port}/pi-straw-boss/${path}`);
				url.searchParams.set('snapshotView', view);
				if (phase) url.searchParams.set('phase', phase);
				if (route === 'head') url.searchParams.set('head', 'talk');
				const file = join(out, `${label}-${width}x${height}-${route}`);
				console.log(file);
				browser(['open', url.href]);
				const face = view === 'zen' && route === 'settings' ? 'standard' : view;
				const target = face === 'zen' ? '#zen:not([hidden]) .zen-corner' : ready[route];
				browser(['wait', '--fn', `innerWidth===${width} && innerHeight===${height} && document.documentElement.dataset.view==='${face}' && ${phase ? `document.documentElement.dataset.phase==='${phase}' && ` : ''}document.querySelector('#stage').dataset.view==='${route}' && document.querySelector('#link').dataset.state==='live' && !!document.querySelector('${target}')`]);
				evaluate(`(${freeze})().then(() => true)`);
				const snapshot = evaluate(source);
				if (!Object.hasOwn(snapshot.nodes, 'html::after')) throw Error('Incomplete capture');
				writeFileSync(file + '.json', JSON.stringify(snapshot));
				browser(['screenshot', file + '.png']);
			}
		}
	}
} finally { browser(['close']); }
