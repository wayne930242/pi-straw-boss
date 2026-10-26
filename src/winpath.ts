import { win32 } from "node:path";

// Windows system programs by absolute path. A bare name such as `powershell.exe` is looked for in the current folder before PATH (nodejs/node#46264, libuv 1.48 and older), and a
// pi session's folder is a project, so a `powershell.exe` planted in a repository would run. Every call to a program of the system names it from `%SystemRoot%\System32`, and runs
// it from that folder, so nothing of the project's is in its way either.

/**
 * `%SystemRoot%`, from the environment (a plain object is searched without regard to case, as Windows does), taken only when it is a drive-letter absolute path: a relative value would put the
 * program path and its working directory in the project folder. `C:\Windows` when none is set or none is such a path.
 */
export function systemRoot(env: NodeJS.ProcessEnv = process.env): string {
	for (const name of ["SystemRoot", "windir"]) {
		const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
		const value = key && env[key]?.trim();
		if (value && /^[A-Za-z]:\\/.test(value)) return value;
	}
	return "C:\\Windows";
}
/** `%SystemRoot%\System32`, the folder these programs live in and run from. */
export const system32 = (env: NodeJS.ProcessEnv = process.env) => win32.join(systemRoot(env), "System32");
/** A program of the system by absolute path: `system32Path("whoami.exe")`. */
export const system32Path = (name: string, env: NodeJS.ProcessEnv = process.env) => win32.join(system32(env), name);
/** Windows PowerShell 5.1, which every supported Windows has. */
export const powershellPath = (env: NodeJS.ProcessEnv = process.env) => win32.join(system32(env), "WindowsPowerShell", "v1.0", "powershell.exe");
