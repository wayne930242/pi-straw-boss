export type Kid = Node | string | false | null | undefined;

/** The kids that are nodes or text: false, null, and undefined drop out. */
export const nodes = (...kids: Kid[]) => kids.filter((kid): kid is Node | string => kid !== false && kid != null);

/** Plays `cls`'s one-shot animation again without reading layout: `.flip` swaps it to the same keyframes under their `-b` name (style.css), which restarts it. */
export const replay = (el: Element, cls: string) => (el.classList.add(cls), el.classList.toggle("flip"));

/** An element built from a tag, attributes, and children. Data only ever becomes text nodes or attribute values, never markup. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string> | null, ...kids: Kid[]): HTMLElementTagNameMap[K] {
	const el = document.createElement(tag);
	for (const [name, value] of Object.entries(props ?? {})) el.setAttribute(name, value);
	el.append(...nodes(...kids));
	return el;
}
