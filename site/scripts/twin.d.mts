export declare const GENERATED: string[];
export declare function headingLines(lines: string[]): { i: number; level: number; text: string }[];
export declare function brokenBold(text: string): number[];
export declare function twinDrift(enLines: string[], zhLines: string[]): { message: string; bad?: undefined } | { message?: undefined; bad: number[] };
export declare const sourceOf: (zhText: string) => string | undefined;
export declare function twinProblems(repo: string): string[];
