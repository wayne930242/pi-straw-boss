import { h } from "./dom.ts";
import { m } from "./paraglide/messages.js";

// One image at a time over the whole page: the chat's thumbnails open it here. A tap on the image toggles its own size (scrolling when
// larger than the screen); the arrows and ← → step through the images of the same message; Escape, ×, or a tap beside the image closes it.

export function lightbox(srcs: string[], start: number) {
	let at = start;
	const img = h("img", { alt: "" }), count = h("span", { class: "lb-count" });
	const button = (cls: string, label: string, text: string, act: () => void) => {
		const b = h("button", { type: "button", class: cls, "aria-label": label }, text);
		b.addEventListener("click", (event) => (event.stopPropagation(), act()));
		return b;
	};
	const step = (by: number) => ((at = (at + by + srcs.length) % srcs.length), show());
	const prev = button("lb-prev", m.image_previous(), "‹", () => step(-1)), next = button("lb-next", m.image_next(), "›", () => step(1));
	const d = h("dialog", { class: "lightbox", "aria-label": m.image_viewer() }, img, prev, next, button("lb-close", m.close(), "×", () => d.close()), count);
	function show() {
		d.classList.remove("zoom");
		img.src = srcs[at]!;
		img.alt = m.image_n({ n: at + 1 });
		count.textContent = srcs.length > 1 ? `${at + 1} / ${srcs.length}` : "";
		prev.hidden = next.hidden = srcs.length < 2;
	}
	img.addEventListener("click", (event) => (event.stopPropagation(), d.classList.toggle("zoom")));
	d.addEventListener("click", () => d.close());
	d.addEventListener("keydown", (event) => {
		if (srcs.length > 1 && (event.key === "ArrowLeft" || event.key === "ArrowRight")) (event.preventDefault(), step(event.key === "ArrowLeft" ? -1 : 1));
	});
	d.addEventListener("close", () => d.remove());
	document.body.append(d);
	show();
	d.showModal();
}
