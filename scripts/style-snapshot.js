// agent-browser eval --stdin < scripts/style-snapshot.js. Lossless JSON: each DOM path names a
// style row. Rows store differences from the root's style (null = property absent), once per row.
(() => {
	// A skipped content-visibility:auto grid has no used tracks until a descendant
	// needs layout. Read inside each such subtree first, without scrolling, changing
	// its CSS, or yielding a frame in which Chrome could skip it again.
	for (const el of document.querySelectorAll('*')) {
		if (el.firstElementChild && getComputedStyle(el).contentVisibility === 'auto') el.firstElementChild.getBoundingClientRect();
	}
	const nodes = {}, rows = [], intern = new Map();
	const defaults = {};
	const root = getComputedStyle(document.documentElement);
	for (const prop of root) defaults[prop] = root.getPropertyValue(prop);
	function record(el, path, pseudo) {
		const style = getComputedStyle(el, pseudo || null), row = {};
		for (const prop of style) {
			const value = style.getPropertyValue(prop);
			if (value !== defaults[prop]) row[prop] = value;
		}
		// Custom properties can be missing or present with an empty value. Preserve both cases.
		const present = new Set(style);
		for (const prop in defaults) if (!present.has(prop)) row[prop] = null;
		const key = JSON.stringify(row);
		if (!intern.has(key)) { intern.set(key, rows.length); rows.push(row); }
		nodes[path + pseudo] = intern.get(key);
	}
	function visit(el, path) {
		for (const pseudo of ['', '::before', '::after']) record(el, path, pseudo);
		const counts = new Map();
		for (const child of el.children) {
			// Slots have their own sibling sequence: inserting an <i data-slot> before a plain <i>
			// does not turn a later phase's additions into changes to every following sibling.
			const key = child.localName + (child.id ? '#' + CSS.escape(child.id) : child.hasAttribute('data-slot') ? '[data-slot=' + CSS.escape(child.dataset.slot) + ']' : '');
			const n = 1 + (counts.get(key) ?? 0);
			counts.set(key, n);
			visit(child, `${path}/${key}[${n}]`);
		}
	}
	visit(document.documentElement, 'html');
	return { format: 1, defaults, rows, nodes };
})()
