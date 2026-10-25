import { m } from "./paraglide/messages.js";

// An overview of the map in a corner, after zoetrope's: shown only while the map runs past the window (on a screen with a mouse), each base a block
// in its state's colour, with a frame for what the window shows. A click scrolls there. It is drawn again when the map's layout changes, and on a
// scroll only its frame moves, once a frame at most. It steps aside once the map's foot is in view, over the timeline.

const WIDTH = 140;

export function mountMinimap(map: HTMLElement, bases: HTMLElement) {
	const box = document.createElement("nav"), inner = document.createElement("div"), view = document.createElement("i");
	[box.className, inner.className, view.className, box.hidden] = ["minimap", "mm-in", "mm-view", true];
	box.setAttribute("aria-label", m.minimap());
	box.append(inner, view);
	document.body.append(box);
	let scale = 1, frame = 0;
	const place = () => {
		frame = 0;
		const r = map.getBoundingClientRect();
		view.style.transform = `translateY(${Math.round(Math.max(0, -r.top) * scale)}px)`;
		view.style.height = `${Math.round(Math.min(innerHeight - Math.max(0, r.top), r.bottom) * scale)}px`;
		box.classList.toggle("away", r.bottom < innerHeight);
	};
	const draw = () => {
		const r = map.getBoundingClientRect();
		box.hidden = map.hidden || r.height < innerHeight * 1.05 || !matchMedia("(min-width: 900px) and (hover: hover)").matches;
		if (box.hidden) return;
		scale = Math.min(WIDTH / r.width, (innerHeight * 0.4) / r.height);
		Object.assign(box.style, { width: `${Math.round(r.width * scale)}px`, height: `${Math.round(r.height * scale)}px` });
		inner.replaceChildren(...[...bases.querySelectorAll<HTMLElement>(":scope > .base:not(.leaving)")].map((b) => {
			const q = b.getBoundingClientRect(), d = document.createElement("i");
			d.dataset.mark = b.dataset.mark ?? "idle";
			d.style.cssText = `left:${(q.left - r.left) * scale}px;top:${(q.top - r.top) * scale}px;width:${q.width * scale}px;height:${q.height * scale}px`;
			return d;
		}));
		place();
	};
	addEventListener("scroll", () => (frame ||= requestAnimationFrame(place)), { passive: true });
	addEventListener("resize", draw);
	box.addEventListener("click", (e) => {
		const r = map.getBoundingClientRect(), y = (e.clientY - box.getBoundingClientRect().top) / scale;
		scrollTo({ top: r.top + scrollY + y - innerHeight / 2, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
	});
	return draw;
}
