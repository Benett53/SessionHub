// Small shared helpers.

/** Split a command line into words, honouring single and double quotes. */
export function splitWords(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inWord = false;
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (quote === '"' && c === "\\" && (s[i + 1] === '"' || s[i + 1] === "\\")) cur += s[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) {
        out.push(cur);
        cur = "";
        inWord = false;
      }
    } else {
      cur += c;
      inWord = true;
    }
  }
  if (inWord) out.push(cur);
  return out;
}
