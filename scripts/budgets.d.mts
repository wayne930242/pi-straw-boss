export function pageAssets(dir: string): { eager: Set<string>; chunks: string[]; css: string[] };
export function measureBudgets(dir: string): Record<string, { raw: number; gz: number }>;
