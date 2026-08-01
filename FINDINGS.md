# Undo Divergence Analysis — ttt-emacs vs Emacs Oracle

## Summary

**The 33 undo-related fuzz divergences are oracle artifacts, not ttt-emacs bugs.** The oracle runs all tokens as a single `execute-kbd-macro` call, which Emacs wraps in undo boundaries — grouping ALL edits inside the macro into one undo step. Interactive Emacs (and ttt-emacs) gives each command its own undo step. The divergences test keyboard-macro semantics, not interactive editing semantics.

**No ttt core undo changes are needed.** ttt-emacs correctly matches interactive Emacs behavior: each command wrapped in `edit()` is its own undo step, and self-insert characters that fall through to ttt are grouped by adjacency (matching Emacs's `self-insert-command` amalgamation).

## Mechanism

### How the oracle runs tokens

`emacs-oracle.js` joins all tokens with spaces and executes them as ONE keyboard macro:

```elisp
(execute-kbd-macro (kbd "C-d C-d C-s mixedcase RET C-f C-a C-e C-/"))
```

Emacs's `execute-kbd-macro` function wraps the entire macro in `undo-boundary` calls. All buffer changes made by the macro — whether from one command or many — become a single undo group. When the sequence contains `C-/`, it undoes the ENTIRE macro's changes in one step.

### How ttt-emacs runs tokens

Each `--exec` key event is processed individually by the plugin's key interceptor:

1. **Self-insert characters** (`a`, `b`, `c`) fall through to ttt's editor, which pushes `InsertRuneCommand` through `Push()`. Adjacency-based grouping coalesces consecutive inserts into one `BatchCommand` — matching Emacs's `self-insert-command` amalgamation.

2. **Commands** (`C-d`, `C-k`, `M-d`, `C-y`) are intercepted by the plugin, wrapped in `edit()` → `begin_undo_group()`/`end_undo_group()`, which creates exactly one `BatchCommand` per command. Each command is its own undo step.

3. **Undo** (`C-/`, `C-x u`) calls `ttt.exec_command("editor.undo")`, which pops one entry from the undo stack.

This matches interactive Emacs behavior: consecutive `self-insert-command` calls amalgamate, everything else is its own undo step.

### The gap

| Scenario | Interactive Emacs | ttt-emacs | Oracle (single macro) |
|---|---|---|---|
| `a b c C-/` | Undoes "abc" in one step | ✓ Same | ✓ Same (both amalgamate within macro) |
| `C-d C-d C-/` | Undoes 2nd C-d only | ✓ Same | ✗ Undoes BOTH C-d's |
| `C-k C-/` | Undoes the kill | ✓ Same | ✗ Also undoes any prior edits in the macro |
| `C-d C-d C-s str RET C-/` | Undoes 2nd C-d only | ✓ Same | ✗ Undoes BOTH C-d's |

### Concrete example: seed 56

Tokens: `C-d C-d C-s mixedcase RET C-f C-a C-e C-/`

Fixture: `The quick brown fox...`

| Step | Interactive Emacs | Oracle (single macro) |
|---|---|---|
| C-d | Deletes `T` → `he quick...` | Deletes `T` (inside macro) |
| C-d | Deletes `h` → `e quick...` | Deletes `h` (inside macro) |
| C-s...RET | Isearch, no buffer change | Isearch (inside macro) |
| C-f C-a C-e | Movement, no buffer change | Movement (inside macro) |
| C-/ | **Undoes only 2nd C-d** → `he quick...` | **Undoes entire macro** → `The quick...` |

ttt-emacs produces `he quick...` — matching interactive Emacs. The oracle produces `The quick...` — matching keyboard-macro Emacs. This is reported as a text divergence, but ttt-emacs is correct.

## Two real (minor) divergences in ttt's undo grouping

While the 33 divergences are oracle artifacts, ttt's undo grouping has two known differences from Emacs's amalgamation. These are real but minor:

### 1. Space heuristic (`canGroup` in `undo.go:114-116`)

```go
// Space/tab after non-space starts a new group (space belongs with the next word)
if (ic.Rune == ' ' || ic.Rune == '\t') && lc.Rune != ' ' && lc.Rune != '\t' {
    return false
}
```

In Emacs, `self-insert-command`s amalgamate regardless of what's typed. `"hi there"` is one undo step. In ttt, the space breaks the group, making it two steps: `"hi"` then `" there"`.

**Impact**: Typing "hi there" then C-/ undoes only " there" in ttt vs the whole thing in Emacs. Minor — users rarely notice because the space-heuristic matches how people think about undo (undoing " there" is more useful than undoing everything back to "hi").

**Fix**: An `editor.undoGrouping` setting could disable the space heuristic when set to `"emacs"`.

### 2. Consecutive deletes are grouped in ttt core (but NOT in the plugin)

In ttt core (`canGroup` lines 120-123), consecutive `DeleteRuneCommand`s at adjacent columns are grouped. In Emacs, consecutive `delete-char` commands do NOT amalgamate.

However, the emacs plugin intercepts `C-d` and `DEL`, wrapping each in `edit()` which calls `BeginTransaction()`/`EndTransaction()`. Inside a transaction, `Push()` doesn't apply the adjacency grouping. So in the plugin, each C-d/DEL is correctly its own undo step.

**Impact**: Only affects ttt's native typing path, not the plugin. A user who types backspaces in raw ttt (without the plugin) would see consecutive backspaces grouped.

## Recommended fix: Oracle, not core

The correct fix is in the oracle, not in ttt's undo system:

### Fix `emacs-oracle.js`: Insert undo boundaries between command groups

Instead of running all tokens as one `execute-kbd-macro`, split into groups:
- **Consecutive self-insert tokens** run as one sub-macro (to preserve amalgamation)
- **Every other token** runs as its own sub-macro (to match per-command undo boundaries)

```javascript
// In buildScript():
// Group consecutive self-insert tokens, keep everything else separate
const groups = [];
let i = 0;
while (i < tokens.length) {
  if (isSelfInsert(tokens[i])) {
    const run = [tokens[i]];
    while (i + 1 < tokens.length && isSelfInsert(tokens[i + 1])) {
      run.push(tokens[++i]);
    }
    groups.push(run.join(' '));
  } else {
    groups.push(tokens[i]);
  }
  i++;
}

// Generate: one execute-kbd-macro per group, with undo-boundary between
const forms = groups.map(g => `(execute-kbd-macro (kbd ${elisp(g)}))`);
const body = forms.join('\n      (undo-boundary)\n      ');
```

**Expected result**: With this fix, the 33 undo divergences should drop to near zero. The remaining divergences would be the two real ttt grouping differences (space heuristic, delete grouping in raw ttt) — neither of which affects the plugin in practice.

### Alternative: Accept the gap

If fixing the oracle is too complex (the error-resume logic depends on single-macro execution), we can:
1. Document that the undo divergences test keyboard-macro semantics, not interactive semantics
2. Move affected seeds to `known-divergences.json`
3. The 20/200 divergence rate (10%) is already down from the original 36/200 (18%) thanks to Phase 0 fixes

## Testing methodology note

The differential fuzzer is a powerful tool that has found real bugs (empty-region, empty-kill, M-> push-mark). The undo divergences are NOT real bugs — they're a known limitation of the oracle design, documented in `DESIGN.md` gotcha 5. The single-macro approach was chosen to preserve command-loop continuity (self-insert amalgamation, consecutive-undo chaining), at the cost of accurate per-command undo boundaries. Splitting into groups as described above preserves both properties.
