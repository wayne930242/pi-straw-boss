// Path words the page needs about a folder the server named: its last segment (what a base is called by default) and a child's path. The server's
// separator comes with each listing (`sep`), so a Windows path with backslashes is cut and joined as it is.

/** The last segment of `path`: the folder's own name, empty for home (a base takes no name from it). */
export const leaf = (path: string, home?: string) => (path === home ? "" : path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1));
/** `name` inside `path`, with the separator the path uses. */
export const child = (path: string, name: string, sep: string) => (path.endsWith(sep) ? path : path + sep) + name;
