// The shared input corpus for the batch fuzzer, the shrinker and the repro
// helper.
//
// Tall and varied ASCII: enough lines that short sequences from point-min
// rarely hit point-max, with brackets/quotes and underscores (word- and
// symbol-syntax boundaries for M-f / M-b / M-d), repeated words, indentation,
// blank lines (C-k on an empty line, C-a/C-e degenerate cases) and mixed case
// (M-u / M-l / M-c).
//
// NO TRAILING NEWLINE. ttt's loader drops a file's final newline and parity.js
// pins `showTrailingNewline` off, so a fixture ending in "\n" would leave the
// two buffer models one line apart. Both runners throw on such a fixture.
export const CORPUS = [
  "The quick brown fox jumps over the lazy dog",
  "function add(a, b) { return a + b }",
  'const greeting = "hello, world"',
  "foo.bar.baz = qux(1, 2, 3)",
  "if (x == y) then do_something() end",
  "  indented line with trailing spaces   ",
  "list = [alpha, beta, gamma, delta]",
  "a1 b2 c3 d4 e5 f6 g7 h8 i9 j0",
  "MixedCase Words And UPPER lower",
  "path/to/some/file.txt:42:column",
  "email@example.com and #hashtag and $var",
  "one two three four five six seven eight",
  "",
  "def method(self, arg): return arg * 2",
  "x = { key: 'value', num: 123, ok: true }",
  "the the the quick quick brown fox fox",
  "SELECT * FROM table WHERE id = 100",
  "  nested { block ( with [ many ] pairs ) here }",
  "trailing punctuation!? yes... maybe;",
  "last content line before the end",
].join("\n");

// A short fixture for hand-written cases and shrinking, where a 20-line diff is
// noise. Same character classes, five lines.
export const SMALL = [
  "alpha beta gamma delta",
  "foo(bar, baz) qux",
  'say "hello world" now',
  "one two three four",
  "  indented line",
].join("\n");
