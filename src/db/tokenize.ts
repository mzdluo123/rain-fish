const segmenter = new Intl.Segmenter("zh", { granularity: "word" });

/**
 * Splits text into lowercase word tokens. ICU's dictionary segmenter handles
 * Chinese and Japanese (and Latin/digits) without extra dependencies.
 * NFKC folds full-width forms; punctuation and whitespace are dropped.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const s of segmenter.segment(text.normalize("NFKC"))) {
    if (s.isWordLike) out.push(s.segment.toLowerCase());
  }
  return out;
}

/** Builds an FTS5 MATCH expression: every token quoted (so operators/syntax in user text are inert), AND-ed. */
export function toMatchQuery(text: string): string | null {
  const tokens = tokenize(text);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replaceAll('"', '""')}"`).join(" ");
}
