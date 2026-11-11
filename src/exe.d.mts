import type { ChildProcess, ExecFileOptions, ExecFileSyncOptions } from "node:child_process";

export class ExeNotFound extends Error {
	code: "ENOENT";
	constructor(name: string, why: string);
}
export interface ResolveDeps { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; isFile?: (path: string) => boolean }
export function searchPath(name: string, deps?: ResolveDeps): string;
export function resolveExe(name: string, deps?: ResolveDeps): string;
export function forgetExe(name?: string): void;
/** `deadline` (ms): the call ends by then whatever the program does, and a program cut off is ended behind it (its group where there are groups, the program alone with `group: false`), by SIGTERM and then SIGKILL after `grace` (ms, 2000). */
export function execFileExe(name: string, args: string[], options: ExecFileOptions & { deadline?: number; grace?: number; group?: boolean }, done: (error: (Error & { code?: string | number | null }) | null, stdout: string, stderr: string) => void): ChildProcess | undefined;
export function execFileSyncExe(name: string, args: string[], options?: ExecFileSyncOptions): string | Buffer;
