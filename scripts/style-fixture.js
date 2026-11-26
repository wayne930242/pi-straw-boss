// Pre-navigation inputs for style-matrix.mjs. The demo builds ages, timeline widths and its
// Zen line from the clock and randomness. Give every document the same fixture, not different CSS.
(() => {
	const face = new URL(location.href).searchParams.get('snapshotView');
	if (!face) return;
	localStorage.clear(); sessionStorage.clear();
	localStorage.setItem('sb.view', face === 'zen' ? 'standard' : face);
	localStorage.setItem('sb.zen', face === 'zen' ? '1' : '0');
	localStorage.setItem('sb-locale', 'en');
	const Date0 = Date, instant = Date.UTC(2026, 10, 26, 4, 0, 0);
	window.Date = new Proxy(Date0, {
		get: (t, k) => k === 'now' ? () => instant : Reflect.get(t, k),
		construct: (t, args) => Reflect.construct(t, args.length ? args : [instant]),
		apply: () => new Date0(instant).toString(),
	});
	let seed = 7;
	Math.random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
	// Capture the first populated frame before the next fixture tick, even on a slow machine.
	// Short startup timers (hello, net, chat history, entrance cleanup) still run normally.
	for (const name of ['setTimeout', 'setInterval']) {
		const schedule = window[name].bind(window);
		window[name] = (fn, delay, ...args) => schedule(fn, delay >= 1000 ? 2147483647 : delay, ...args);
	}
})();
