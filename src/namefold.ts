/** How Straw Boss compares session names: case-insensitive, whitespace runs as one space, trimmed. The link-wait router resolves owners by it and the standing-twin warning finds twins by it, so the two agree (TWR-F001). */
export const foldName = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
