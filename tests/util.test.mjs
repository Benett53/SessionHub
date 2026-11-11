// Run with: npm test
import assert from "node:assert/strict";
import { test } from "node:test";

import { localFileName, pasteLineCount, pasteSafe } from "../src/util.ts";

test("pasted lines are counted for every kind of line end", () => {
  assert.equal(pasteLineCount("one"), 1);
  assert.equal(pasteLineCount("one\n"), 1);
  assert.equal(pasteLineCount("one\ntwo\r\nthree"), 3);
  // A lone CR is the Enter key for the shell.
  assert.equal(pasteLineCount("a\rb\rc\rd\re\rf\r"), 6);
});

test("pasted text cannot end bracketed paste or press control keys", () => {
  assert.equal(pasteSafe("echo ok\x1b[201~\rrm -rf x\r"), "echo ok[201~\rrm -rf x\r");
  // Ctrl+O runs the line in bash, Ctrl+C / Ctrl+D act on the program.
  assert.equal(pasteSafe("ls\x0f\x03\x04\x7f\u009b"), "ls");
  assert.equal(pasteSafe("tab\there\nnext\r\nlast é ✓"), "tab\there\nnext\r\nlast é ✓");
});

test("remote names stay inside the download folder", () => {
  assert.equal(localFileName("../../x", false), ".._.._x");
  assert.equal(localFileName("..", false), "_");
  assert.equal(localFileName("..\\..\\x", true), ".._.._x");
  assert.equal(localFileName("a:b", true), "a_b");
  assert.equal(localFileName("NUL.txt", true), "_NUL.txt");
  assert.equal(localFileName("report.pdf", true), "report.pdf");
});
