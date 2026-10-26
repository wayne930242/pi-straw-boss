/** Whether version `a` is newer than `b`; a server that recorded none predates the handover. Compares the first three numeric parts. */
export function newer(a: string, b?: string) {
	const [x, y] = [a, b ?? "0"].map((v) => [...v.split(/[.-]/).slice(0, 3).map(Number), 0, 0].slice(0, 3)) as [number[], number[]];
	const i = x.findIndex((n, j) => n !== y[j]);
	return i >= 0 && x[i]! > y[i]!;
}
