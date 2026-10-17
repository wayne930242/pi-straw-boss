// A QR code encoder (ISO/IEC 18004) for one job: the remote pairing URL as a square to scan, in the terminal and in the page. Byte mode,
// error correction level M, the smallest version that holds the text, and the mask with the lowest penalty; the tables are the standard's.
// Adapted in part (module count, GF(256) multiply, block interleave) from Project Nayuki's QR Code generator library
// (https://www.nayuki.io/page/qr-code-generator-library), Copyright (c) Project Nayuki, MIT License: see NOTICE.md. tests/qr.test.ts decodes what it draws.

// Level M, by version: error correction codewords per block, and the number of blocks.
const ECC = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
const MASKS: ((x: number, y: number) => boolean)[] = [
	(x, y) => (x + y) % 2 === 0, (_, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
	(x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
	(x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

const bit = (value: number, i: number) => ((value >>> i) & 1) === 1;
/** Modules left for data and error correction once the function patterns are drawn. */
function rawModules(v: number) {
	const align = Math.floor(v / 7) + 2;
	return (16 * v + 128) * v + 64 - (v >= 2 ? (25 * align - 10) * align - 55 : 0) - (v >= 7 ? 36 : 0);
}
const dataBytes = (v: number) => Math.floor(rawModules(v) / 8) - ECC[v]! * BLOCKS[v]!;
// Reed-Solomon over GF(256) with the polynomial 0x11D.
function mul(x: number, y: number) {
	let z = 0;
	for (let i = 7; i >= 0; i--) z = ((z << 1) ^ ((z >>> 7) * 0x11d)) ^ (((y >>> i) & 1) * x);
	return z;
}
function divisor(degree: number) {
	const out = Array<number>(degree).fill(0);
	out[degree - 1] = 1;
	for (let i = 0, root = 1; i < degree; i++, root = mul(root, 2)) for (let j = 0; j < degree; j++) out[j] = mul(out[j]!, root) ^ (out[j + 1] ?? 0);
	return out;
}
function remainder(data: number[], div: number[]) {
	const out = div.map(() => 0);
	for (const b of data) {
		const factor = b ^ out.shift()!;
		out.push(0);
		div.forEach((c, i) => (out[i]! ^= mul(c, factor)));
	}
	return out;
}

/** The text's data codewords and error correction, interleaved block by block as the symbol carries them. */
function codewords(bytes: Uint8Array, v: number) {
	const bits: number[] = [], put = (value: number, n: number) => { for (let i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
	const cap = dataBytes(v) * 8;
	put(4, 4);
	put(bytes.length, v < 10 ? 8 : 16);
	bytes.forEach((b) => put(b, 8));
	put(0, Math.min(4, cap - bits.length));
	put(0, (8 - (bits.length % 8)) % 8);
	for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
	const data = Array.from({ length: cap / 8 }, (_, i) => bits.slice(i * 8, i * 8 + 8).reduce((n, b) => n * 2 + b, 0));
	const n = BLOCKS[v]!, ecc = ECC[v]!, raw = Math.floor(rawModules(v) / 8), short = n - (raw % n), len = Math.floor(raw / n), div = divisor(ecc);
	const blocks: number[][] = [];
	for (let i = 0, at = 0; i < n; i++) {
		const block = data.slice(at, (at += len - ecc + (i < short ? 0 : 1)));
		blocks.push([...block, ...(i < short ? [-1] : []), ...remainder(block, div)]);
	}
	return blocks[0]!.flatMap((_, i) => blocks.map((b) => b[i]!)).filter((b) => b >= 0);
}

/** The code's modules, row by row (true is dark), without the quiet zone. Throws when the text does not fit a QR code. */
export function qr(text: string): boolean[][] {
	const bytes = new TextEncoder().encode(text);
	let v = 1;
	while (4 + (v < 10 ? 8 : 16) + bytes.length * 8 > dataBytes(v) * 8) if (++v > 40) throw new Error("The text is too long for a QR code");
	const size = v * 4 + 17, grid = () => Array.from({ length: size }, () => Array<boolean>(size).fill(false));
	const m = grid(), fixed = grid(), set = (x: number, y: number, dark: boolean) => ((m[y]![x] = dark), (fixed[y]![x] = true));
	for (let i = 0; i < size; i++) (set(6, i, i % 2 === 0), set(i, 6, i % 2 === 0));
	for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const)
		for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
			const d = Math.max(Math.abs(dx), Math.abs(dy));
			if (cx + dx >= 0 && cx + dx < size && cy + dy >= 0 && cy + dy < size) set(cx + dx, cy + dy, d !== 2 && d !== 4);
		}
	const count = Math.floor(v / 7) + 2, step = Math.floor((v * 8 + count * 3 + 5) / (count * 4 - 4)) * 2, align = v === 1 ? [] : [6];
	for (let pos = size - 7; v > 1 && align.length < count; pos -= step) align.splice(1, 0, pos);
	align.forEach((ay, i) => align.forEach((ax, j) => {
		if ((i === 0 && (j === 0 || j === count - 1)) || (i === count - 1 && j === 0)) return;
		for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
	}));
	if (v >= 7) {
		let rem = v;
		for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
		for (let i = 0; i < 18; i++) (set(size - 11 + (i % 3), Math.floor(i / 3), bit((v << 12) | rem, i)), set(Math.floor(i / 3), size - 11 + (i % 3), bit((v << 12) | rem, i)));
	}
	/** The format bits (level M is 00) for a mask, both copies, and the dark module. */
	const format = (g: boolean[][], mask: number) => {
		let rem = mask;
		for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
		const bits = ((mask << 10) | rem) ^ 0x5412, put = (x: number, y: number, i: number) => ((g[y]![x] = bit(bits, i)), (fixed[y]![x] = true));
		for (let i = 0; i < 6; i++) put(8, i, i);
		(put(8, 7, 6), put(8, 8, 7), put(7, 8, 8));
		for (let i = 9; i < 15; i++) put(14 - i, 8, i);
		for (let i = 0; i < 8; i++) put(size - 1 - i, 8, i);
		for (let i = 8; i < 15; i++) put(8, size - 15 + i, i);
		((g[size - 8]![8] = true), (fixed[size - 8]![8] = true));
	};
	format(m, 0);
	const words = codewords(bytes, v);
	for (let right = size - 1, i = 0; right >= 1; right -= 2) {
		if (right === 6) right = 5;
		for (let row = 0; row < size; row++)
			for (let j = 0; j < 2; j++) {
				const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - row : row;
				if (!fixed[y]![x] && i < words.length * 8) (m[y]![x] = bit(words[i >>> 3]!, 7 - (i & 7))), i++;
			}
	}
	const masked = (k: number) => {
		const g = m.map((row, y) => row.map((dark, x) => dark !== (!fixed[y]![x] && MASKS[k]!(x, y))));
		format(g, k);
		return g;
	};
	return [0, 1, 2, 3, 4, 5, 6, 7].map(masked).reduce((best, g) => (penalty(g) < penalty(best) ? g : best));
}

/** The standard's penalty: long runs, 2×2 blocks, finder-like patterns (light beyond the edge counts), and an unbalanced share of dark. */
function penalty(g: boolean[][]) {
	const n = g.length, lines = [...g, ...g.map((_, x) => g.map((row) => row[x]!))].map((line) => line.map(Number).join(""));
	let score = 0, dark = 0;
	for (const line of lines) {
		for (const run of line.match(/0{5,}|1{5,}/g) ?? []) score += run.length - 2;
		score += 40 * (`0000${line}0000`.match(/(?=10111010000|00001011101)/g)?.length ?? 0);
	}
	for (let y = 0; y < n; y++)
		for (let x = 0; x < n; x++) {
			if (g[y]![x]) dark++;
			if (x < n - 1 && y < n - 1 && g[y]![x] === g[y]![x + 1] && g[y]![x] === g[y + 1]![x] && g[y]![x] === g[y + 1]![x + 1]) score += 3;
		}
	return score + 10 * (Math.ceil(Math.abs(dark * 20 - n * n * 10) / (n * n)) - 1);
}

/** The code for a terminal: two module rows per line, light modules drawn as blocks (▀ ▄ █) on a dark background, a 4-module quiet zone. */
export function qrLines(m: boolean[][]): string[] {
	const n = m.length + 8, light = (x: number, y: number) => y < n && !(m[y - 4]?.[x - 4] ?? false);
	const lines: string[] = [];
	for (let y = 0; y < n; y += 2) lines.push(Array.from({ length: n }, (_, x) => [" ", "▄", "▀", "█"][Number(light(x, y)) * 2 + Number(light(x, y + 1))]).join(""));
	return lines;
}
