import { fileURLToPath } from "node:url";
import { themeData } from "../scripts/theme-data.ts";

/** Source manifests in the same shape as the bundled meta, with readable paths for fake pages. */
export const manifests = themeData(fileURLToPath(new URL("../gui", import.meta.url)), file => file);
export const THEME = Object.fromEntries(Object.entries(manifests).map(([view, data]) => [view, data.color]));
