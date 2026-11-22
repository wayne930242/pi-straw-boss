/** The tab label for a name, cut at 16 characters as pi-auto-tab-name cuts it, so that extension takes the label as its own and keeps it. No imports: the opener and the server load it. */
export const tabLabel = (name: string): string => Array.from(name).length > 16 ? `${Array.from(name).slice(0, 16).join("").trimEnd()}…` : name;
