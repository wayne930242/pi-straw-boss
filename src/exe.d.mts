import type { ChildProcess, ExecFileOptions, ExecFileSyncOptions } from "node:child_process";

export class ExeNotFound extends Error {
	code: "ENOENT";
	constructor(name: string, why: string);
}
export interface ResolveDeps { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; isFile?: (path: string) => boolean }
export function searchPath(name: string, deps?: ResolveDeps): string;
export function resolveExe(name: string, deps?: ResolveDeps): string;
export function forgetExe(name?: string): void;
export function execFileExe(name: string, args: string[], options: ExecFileOptions, done: (error: (Error & { code?: string | number }) | null, stdout: string, stderr: string) => void): ChildProcess | undefined;
export function execFileSyncExe(name: string, args: string[], options?: ExecFileSyncOptions): string | Buffer;
