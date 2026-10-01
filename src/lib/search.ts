/**
 * One way of searching, for every search box in the app.
 *
 * Each page used to do its own `name.toLowerCase().includes(query)`, which is
 * fine at a desk and hopeless on a warehouse floor: "anorak 2" missed
 * "Anorak #2", "jeans ladies" missed "Ladies Jeans", and "blk" missed "Black
 * T-shirt". Thumbs typing fast on a phone produce exactly those queries.
 *
 * So a query matches when every word of it can be found in the text, in any
 * order, as the start of a word, inside it, or - for three letters or more - as
 * an abbreviation whose first letter starts a word ("blk" in "Black"). Results
 * are ranked so that the obvious answer comes first and the clever matches only
 * fill in after it.
 *
 * No imports, so any page can use it without pulling anything else in.
 */

/** Lowercase, "#" and punctuation gone, spacing collapsed. */
export function normalizeSearch(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/#/g, "")
    .replace(/[^a-z0-9/\s.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function words(text: string): string[] {
  return text.split(/[\s/.]+/).filter((w) => w !== "");
}

/** "blk" in "black": same first letter, the rest in order. */
function isAbbreviation(token: string, word: string): boolean {
  if (token.length < 3 || word[0] !== token[0]) return false;
  let at = 1;
  for (let i = 1; i < word.length && at < token.length; i += 1) {
    if (word[i] === token[at]) at += 1;
  }
  return at === token.length;
}

/** The rank of a match that relied on an abbreviation - the loosest kind. */
export const ABBREVIATION_RANK = 5;

/**
 * How well `text` answers `query`: 0 is a perfect answer, higher is weaker,
 * null is no match. An empty query matches everything at rank 0.
 *
 *   0  the same text
 *   1  the text starts with the query
 *   2  every word of the query starts a word of the text
 *   3  the text contains the query
 *   4  every word is found somewhere, in any order
 *   5  every word is found, some only as abbreviations
 */
export function matchRank(query: string, text: string): number | null {
  const q = normalizeSearch(query);
  if (q === "") return 0;
  const t = normalizeSearch(text);
  if (t === "") return null;
  if (t === q) return 0;
  // Spacing differences ("3/4jeans" vs "3/4 jeans") still count as exact.
  if (t.replace(/\s/g, "") === q.replace(/\s/g, "")) return 0;
  if (t.startsWith(q)) return 1;

  const tokens = words(q);
  const textWords = words(t);
  if (tokens.every((tok) => textWords.some((w) => w.startsWith(tok)))) return 2;
  if (t.includes(q)) return 3;

  let abbreviated = false;
  for (const tok of tokens) {
    if (t.includes(tok)) continue;
    if (textWords.some((w) => isAbbreviation(tok, w))) {
      abbreviated = true;
      continue;
    }
    return null;
  }
  return abbreviated ? 5 : 4;
}

/** True when any of the fields answers the query. */
export function matches(query: string, ...fields: Array<string | null | undefined>): boolean {
  if (normalizeSearch(query) === "") return true;
  return fields.some((f) => f != null && matchRank(query, f) !== null);
}

/** The best rank across several fields, or null. */
export function bestRank(
  query: string,
  ...fields: Array<string | null | undefined>
): number | null {
  let best: number | null = null;
  for (const field of fields) {
    if (field == null) continue;
    const rank = matchRank(query, field);
    if (rank !== null && (best === null || rank < best)) best = rank;
  }
  return best;
}

/**
 * Filter and rank a list by the query. The order of equally good matches is
 * left as it was, so a list sorted by age stays sorted by age within a rank.
 */
export function searchList<T>(
  items: T[],
  query: string,
  fieldsOf: (item: T) => Array<string | null | undefined>,
): T[] {
  if (normalizeSearch(query) === "") return items;
  return items
    .map((item, index) => ({ item, index, rank: bestRank(query, ...fieldsOf(item)) }))
    .filter((entry) => entry.rank !== null)
    .sort((a, b) => (a.rank as number) - (b.rank as number) || a.index - b.index)
    .map((entry) => entry.item);
}
