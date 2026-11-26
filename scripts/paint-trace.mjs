// §9 live-map comparison. Serve the same gui:demo build for both faces, e.g.
// vite preview gui --outDir ../dist/demo --base /pi-straw-boss/ --port 4920
// node scripts/paint-trace.mjs [demo URL] [new output directory] [theme]
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import assert from 'node:assert/strict';

const [base = 'http://127.0.0.1:4920/pi-straw-boss/', output = `scratch/paint-${Date.now()}`, theme = 'storybook'] = process.argv.slice(2);
assert(['storybook', 'raven', 'geek'].includes(theme), 'expected a device theme');
const url = new URL(base);
url.searchParams.set('phase', 'day');
const dir = resolve(output), session = `tc-paint-${process.pid}-${Date.now()}`;
// A moving layer on a page with links can wake Chrome's navigation predictor at
// 60 Hz without painting. Exclude its link sampling for both faces (§9).
const flags = '--disable-gpu,--disable-skia-runtime-opts,--force-color-profile=srgb,--disable-features=NavigationPredictor';
const ab = (args, input) => execFileSync('agent-browser', ['--session', session, ...args], { encoding: 'utf8', input });
const evaluate = code => JSON.parse(ab(['--json', 'eval', '--stdin'], code)).data.result;
const json = (name, value) => writeFileSync(join(dir, `${name}.json`), JSON.stringify(value, null, 2));

// Runs in the page. Use the loaded theme's own keyframes, not an animation-name
// prefix. A transition has no keyframes rule; it belongs to the paused set.
function install(view) {
  const names = new Set();
  function collect(rules) {
    for (const rule of rules) {
      if (rule instanceof CSSKeyframesRule) names.add(rule.name);
      else if (rule.cssRules) collect(rule.cssRules);
    }
  }
  const sheet = [...document.styleSheets].find(s => s.href && new URL(s.href).pathname.includes(`/themes/${view}/`));
  if (view !== 'standard' && !sheet) throw Error(`theme stylesheet missing: ${view}`);
  if (sheet) collect(sheet.cssRules);
  const kept = a => names.has(a.animationName);
  const row = a => ({ name: a.animationName || a.transitionProperty || a.constructor.name, theme: kept(a),
    target: a.effect?.target?.localName, classes: a.effect?.target?.getAttribute('class'),
    pseudo: a.effect?.pseudoElement, state: a.playState });
  const inventory = () => document.getAnimations().map(row);
  const before = inventory(), stopped = [];
  const sweep = event => {
    for (const a of document.getAnimations()) {
      if (!kept(a) && a.playState === 'running') {
        const prior = row(a);
        a.pause();
        stopped.push({ event, ...prior, after: a.playState });
      }
    }
  };
  // Event targets are the originating elements. Their getAnimations() omits
  // ::before / ::after. Scan the document on starts, not on every frame.
  for (const type of ['animationstart', 'transitionrun']) document.addEventListener(type, () => sweep(type), true);
  sweep('initial');
  const initial = inventory();
  let updates = 0;
  new MutationObserver(rs => { updates += rs.length; }).observe(document.querySelector('#bases'),
    { childList: true, attributes: true, subtree: true, characterData: true });
  const state = () => ({ live: document.querySelector('#link').dataset.state, calm: document.documentElement.hasAttribute('data-calm'), view: document.documentElement.dataset.view });
  window.paintWindow = async () => {
    const start = state(), at = updates;
    performance.mark('paint-trace:start');
    await new Promise(r => setTimeout(r, 10_000));
    performance.mark('paint-trace:end');
    return { before, initial, stopped, final: inventory(), start, end: state(), updates: updates - at,
      themeKeyframes: [...names], viewport: [innerWidth, innerHeight, devicePixelRatio], agent: navigator.userAgent };
  };
  return true;
}

function counts(raw) {
  const obj = JSON.parse(raw), events = obj.traceEvents ?? obj;
  const mark = tag => events.find(e => e.name === `paint-trace:${tag}`);
  const start = mark('start'), end = mark('end');
  assert(start && end && start.pid === end.pid && start.tid === end.tid, 'missing renderer marks');
  const window = events.filter(e => e.pid === start.pid && e.tid === start.tid && e.ts >= start.ts && e.ts < end.ts);
  const count = name => window.filter(e => e.name === name).length;
  return { ms: (end.ts - start.ts) / 1000, prePaint: count('PrePaint'), paint: count('Paint') };
}

function measure(view) {
  evaluate(`localStorage.clear();sessionStorage.clear();localStorage.setItem('sb.view',${JSON.stringify(view)});localStorage.setItem('sb-locale','en');true`);
  ab(['open', url.href]);
  ab(['wait', '--fn', `performance.now()>10000 && document.documentElement.dataset.view===${JSON.stringify(view)} && document.querySelector('#stage')?.dataset.view==='map' && document.querySelector('#link')?.dataset.state==='live' && !!document.querySelector('#bases [data-key="w1"]')`]);
  evaluate(`(${install})(${JSON.stringify(view)})`);
  ab(['profiler', 'start', '--categories', 'devtools.timeline,blink.user_timing,disabled-by-default-devtools.timeline']);
  const audit = evaluate('paintWindow()');
  const trace = join(dir, `${view}.trace.json`);
  ab(['profiler', 'stop', trace]);
  json(`${view}.inventory`, audit);
  const raw = readFileSync(trace), result = counts(raw);
  writeFileSync(`${trace}.gz`, gzipSync(raw));
  unlinkSync(trace);
  assert.deepEqual(audit.viewport, [1440, 900, 1]);
  assert.deepEqual(audit.start, { live: 'live', calm: false, view });
  assert.deepEqual(audit.start, audit.end);
  assert(audit.updates > 0 && result.ms >= 9999 && result.prePaint > 0, 'invalid live trace');
  for (const rows of [audit.initial, audit.final]) {
    assert(!rows.some(a => !a.theme && a.state === 'running'), 'unpaused shared animation');
    if (view === 'storybook') assert(rows.some(a => a.theme && a.state === 'running'), 'storybook is not animating');
  }
  assert(audit.stopped.every(a => a.after === 'paused'));
  return { ...result, updates: audit.updates };
}

mkdirSync(resolve(dir, '..'), { recursive: true });
mkdirSync(dir); // Don't overwrite an earlier pair.
try {
  console.log(`Chrome flags (both faces): ${flags}`);
  ab(['--args', flags, 'open', url.href]);
  ab(['set', 'viewport', '1440', '900', '1']);
  const standard = measure('standard'), candidate = measure(theme);
  const pass = candidate.prePaint <= 3 * standard.prePaint;
  const summary = { url: url.href, flags, standard, [theme]: candidate, limit: 3 * standard.prePaint, pass };
  json('summary', summary);
  console.log(JSON.stringify(summary, null, 2));
  if (!pass) process.exitCode = 1;
} finally {
  ab(['close']);
}
