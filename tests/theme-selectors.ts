// Use Vite's CSS parser, including @container and functional selectors. A class mentioned
// by :has() is part of a theme's reach, but is not the element the declaration styles.
import { transform, type Selector, type SelectorComponent } from "lightningcss";

export function selectors(css: string, visit: (sel: Selector, props: Map<string, string>, line: number) => void) {
	transform({ filename: "theme.css", code: Buffer.from(css), visitor: { Rule: { style({ value: rule }) {
		const props = new Map<string, string>();
		for (const d of [...rule.declarations?.declarations ?? [], ...rule.declarations?.importantDeclarations ?? []]) {
			if (d.property === "custom") props.set(d.value.name, JSON.stringify(d.value.value));
			else if (d.property === "unparsed") props.set(d.value.propertyId.property, JSON.stringify(d.value.value));
			else props.set(d.property, JSON.stringify(d.value));
		}
		for (const sel of rule.selectors) visit(sel, props, rule.loc.line + 1);
	} } } });
}

function name(c: SelectorComponent) {
	return c.type === "class" ? `.${c.name}` : c.type === "id" ? `#${c.name}` : c.type === "attribute" ? `[${c.name}]` : c.type === "type" ? c.name : c.type === "pseudo-element" ? `::${c.kind}` : "";
}
export function* reach(sel: Selector): Generator<string> {
	for (const c of sel) {
		yield name(c);
		for (const nested of ("selectors" in c ? c.selectors : "of" in c ? c.of : []) ?? []) yield* reach(Array.isArray(nested) ? nested : [nested]);
	}
}

/** Positive names on the subject, not on an ancestor, a negation, or a relative selector. */
export function subject(sel: Selector): string[] {
	return sel.slice(sel.findLastIndex(c => c.type === "combinator") + 1).flatMap(c =>
		c.type === "pseudo-class" && (c.kind === "is" || c.kind === "where") ? c.selectors.flatMap(subject) : [name(c)]);
}
