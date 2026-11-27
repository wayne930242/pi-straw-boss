import type { Locale } from "../locale.ts";
import type { Rival } from "./rivals.ts";

const arg = (s: string) => /^[a-zA-Z0-9@%_+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;

export function retiredWarning(rivals: readonly Rival[], locale: Locale): string {
	const paths = rivals.map(r => r.path).join(", ");
	const commands = [...new Set(rivals.map(r => `pi remove ${arg(r.configured?.source ?? r.path)}${r.configured?.local ? " --local" : ""}`))].join("; ");
	return locale === "zh-TW"
		? `Straw Boss 現在負責執行子代理，但 pi 已從 ${paths} 載入 pi-herdr-agents，因此這個工作階段仍由舊套件接手。請執行 ${commands}，再執行 /reload`
		: `Straw Boss now hosts subagents, but pi loaded pi-herdr-agents from ${paths}, so the old host is still in use. Run ${commands}, then /reload`;
}
