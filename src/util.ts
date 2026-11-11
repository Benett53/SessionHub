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

/**
 * A name from a remote listing as a single local file name.
 *
 * The server chooses the names it reports. One such as "..\..\x" or "a/b"
 * would leave the folder picked for a download, so everything that separates
 * path components becomes "_". On Windows the same goes for the characters
 * and device names the file system reserves ("x:y" would write an alternate
 * data stream, "NUL" would discard the file).
 */
export function localFileName(name: string, windows: boolean): string {
  let out = name.replace(/[/\u0000]/g, "_");
  if (windows) {
    out = out.replace(/[\\:*?"<>|]/g, "_").replace(/[. ]+$/, "");
    if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(out)) out = `_${out}`;
  }
  return out === "" || out === "." || out === ".." ? "_" : out;
}

/** Every way a line can end in pasted text; a lone CR is the Enter key. */
const LINE_END = /\r\n|\r|\n/;

/** Number of lines a paste would send to the terminal. */
export function pasteLineCount(text: string): number {
  return text.replace(/(?:\r\n|\r|\n)$/, "").split(LINE_END).length;
}

/** The first `count` lines of a text that is about to be pasted. */
export function pasteLines(text: string, count: number): string[] {
  return text.split(LINE_END).slice(0, count);
}

/**
 * Pasted text without control characters, except tab and line ends.
 *
 * The clipboard is filled by other programs and web pages. ESC could end
 * bracketed paste early ("ESC [ 201 ~"), so that the rest runs as typed
 * input, and characters such as Ctrl+O run the line in a shell even without
 * a line end.
 */
export function pasteSafe(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}
