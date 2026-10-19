// The packets that travel the map's wires. Each is a dot moved by a CSS animation of `transform` alone, which the compositor runs
// without the main thread (SVG's animateMotion, and offset-path, are redrawn on the main thread every frame). The wire is a cubic curve
// whose control points share the middle x, so the keyframes are points spaced evenly along it and a linear timing keeps the dot's pace.

export interface Wire { x1: number; y1: number; x2: number; y2: number; mid: number }

/** `n` + 1 points spaced evenly along the wire's curve. */
export function along({ x1, y1, x2, y2, mid }: Wire, n = 64): (readonly [number, number])[] {
	const dense = Array.from({ length: 201 }, (_, i) => {
		const t = i / 200, u = 1 - t;
		return [u ** 3 * x1 + 3 * u * u * t * mid + 3 * u * t * t * mid + t ** 3 * x2, u ** 3 * y1 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t ** 3 * y2] as const;
	});
	const reach = dense.reduce<number[]>((sum, p, i) => (sum.push(i ? sum[i - 1]! + Math.hypot(p[0] - dense[i - 1]![0], p[1] - dense[i - 1]![1]) : 0), sum), []);
	return Array.from({ length: n + 1 }, (_, k) => dense[Math.max(0, reach.findIndex((r) => r >= (k / n) * reach.at(-1)!))]!);
}

/** The keyframes (in a `<style>`) and a dot for each wire; none when `still`. */
export function packets(wires: Wire[], still: boolean): HTMLElement[] {
	if (still || !wires.length) return [];
	const css = document.createElement("style");
	css.textContent = wires.map((w, i) => `@keyframes pk${i}{${along(w).map(([x, y], k, all) => `${((k / (all.length - 1)) * 100).toFixed(2)}%{transform:translate(${x.toFixed(1)}px,${y.toFixed(1)}px)}`).join("")}}`).join("");
	return [css, ...wires.map((_, i) => ((dot) => ((dot.className = "packet"), (dot.style.animationName = `pk${i}`), dot))(document.createElement("i")))];
}
