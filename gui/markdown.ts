// A small markdown renderer of its own (D8): text in, a tree of plain nodes out, then DOM nodes built from the tree. Nothing is ever
// parsed as HTML, so raw HTML in the text stays text; links keep only the http, https, and mailto schemes. No syntax highlighting.

export type N = string | { tag: string; kids: N[]; attrs?: Record<string, string> };
const el = (tag: string, kids: N[], attrs?: Record<string, string>): N => ({ tag, kids, attrs });
const SAFE = /^(?:https?:\/\/|mailto:)[^\s\u0000-\u001f]+$/i;
const link = (href: string, kids: N[]): N => el("a", kids, { href, rel: "noopener noreferrer", target: "_blank" });
// Every span is bounded, so text with many unmatched markers stays linear.
const INLINE = /(`+)([^`]|[^`][^]{0,1000}?[^`])\1(?!`)|\*\*([^*][^]{0,1000}?)\*\*|~~([^~][^]{0,1000}?)~~|\*([^\s*][^*]{0,500}?)\*|(?<![\w])_([^\s_][^_]{0,500}?)_(?![\w])|\[([^\]]{1,500})\]\(([^)\s]{1,2000})(?:\s+"[^"]*")?\)|(https?:\/\/[^\s<>)\]]+)/g;

export function inline(src: string): N[] {
	const out: N[] = [];
	let at = 0;
	for (const m of src.matchAll(INLINE)) {
		if (m.index > at) out.push(src.slice(at, m.index));
		at = m.index + m[0].length;
		if (m[2] !== undefined) out.push(el("code", [m[2]]));
		else if (m[3] !== undefined) out.push(el("strong", inline(m[3])));
		else if (m[4] !== undefined) out.push(el("del", inline(m[4])));
		else if (m[5] !== undefined || m[6] !== undefined) out.push(el("em", inline((m[5] ?? m[6])!)));
		else if (m[7] !== undefined) out.push(SAFE.test(m[8]!) ? link(m[8]!, inline(m[7])) : m[0]);
		else out.push(link(m[9]!, [m[9]!]));
	}
	if (at < src.length) out.push(src.slice(at));
	return out;
}

const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const DIVIDER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const starts = (line: string, next?: string) => /^\s*(`{3,}|~{3,}|#{1,6}\s|>)/.test(line) || RULE.test(line) || LIST.test(line) || (line.includes("|") && next !== undefined && DIVIDER.test(next) && next.includes("-"));

export function parse(md: string): N[] {
	const lines = md.replace(/\r\n?/g, "\n").split("\n"), out: N[] = [];
	for (let i = 0; i < lines.length; ) {
		const line = lines[i]!, next = lines[i + 1];
		const fence = line.match(/^\s*(`{3,}|~{3,})\s*([\w+-]*)/), heading = line.match(/^\s*(#{1,6})\s+(.*?)\s*#*\s*$/), item = line.match(LIST);
		if (!line.trim()) i++;
		else if (fence) {
			const body: string[] = [];
			for (i++; i < lines.length && !lines[i]!.trim().startsWith(fence[1]!); i++) body.push(lines[i]!);
			i++;
			out.push(el("pre", [el("code", [body.join("\n")], fence[2] ? { "data-lang": fence[2] } : undefined)]));
		} else if (heading) (out.push(el(`h${heading[1]!.length}`, inline(heading[2]!))), i++);
		else if (RULE.test(line)) (out.push(el("hr", [])), i++);
		else if (/^\s*>/.test(line)) {
			const body: string[] = [];
			for (; i < lines.length && /^\s*>/.test(lines[i]!); i++) body.push(lines[i]!.replace(/^\s*> ?/, ""));
			out.push(el("blockquote", parse(body.join("\n"))));
		} else if (line.includes("|") && next !== undefined && DIVIDER.test(next) && next.includes("-")) {
			const rows: string[][] = [];
			for (i += 2; i < lines.length && lines[i]!.trim() && lines[i]!.includes("|"); i++) rows.push(cells(lines[i]!));
			out.push(el("table", [el("thead", [el("tr", cells(line).map((c) => el("th", inline(c))))]), el("tbody", rows.map((r) => el("tr", r.map((c) => el("td", inline(c))))))]));
		} else if (item) {
			const indent = item[1]!.length, items: N[] = [];
			while (i < lines.length) {
				const m = lines[i]!.match(LIST);
				if (!m || m[1]!.length !== indent || /\d/.test(m[2]!) !== /\d/.test(item[2]!)) break;
				const body = [m[3]!], task = m[3]!.match(/^\[([ xX])\]\s+(.*)$/);
				if (task) body[0] = task[2]!;
				for (i++; i < lines.length && lines[i]!.trim() && lines[i]!.search(/\S/) > indent; i++) body.push(lines[i]!.replace(new RegExp(`^ {0,${indent + 2}}`), ""));
				// A task item carries a check mark of its own (drawn by CSS) in front of its text, and no bullet.
				const kids = parse(body.join("\n")), first = kids[0], done = task?.[1] !== " ";
				if (task) (typeof first === "object" && first.tag === "p" ? first.kids : kids).unshift(el("i", done ? ["✓"] : [], { class: "check", "data-done": String(done), "aria-label": done ? "done" : "not done" }));
				items.push(el("li", kids, task ? { class: "task" } : undefined));
				if (!lines[i]?.trim() && lines[i + 1]?.match(LIST)?.[1]?.length === indent) i++;
			}
			out.push(el(/\d/.test(item[2]!) ? "ol" : "ul", items));
		} else {
			const body = [line];
			for (i++; i < lines.length && lines[i]!.trim() && !starts(lines[i]!, lines[i + 1]); i++) body.push(lines[i]!);
			out.push(el("p", inline(body.join("\n"))));
		}
	}
	return out;
}

/** The tree as DOM nodes. */
export function mount(nodes: N[]): DocumentFragment {
	const put = (n: N): Node => {
		if (typeof n === "string") return document.createTextNode(n);
		const node = document.createElement(n.tag);
		for (const [k, v] of Object.entries(n.attrs ?? {})) node.setAttribute(k, v);
		node.append(...n.kids.map(put));
		return node;
	};
	const fragment = document.createDocumentFragment();
	fragment.append(...nodes.map(put));
	return fragment;
}
