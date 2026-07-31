-- Emacs emulation layer for ttt.
--
-- Single-file by necessity: the plugin sandbox strips package.loaders down to
-- the preload loader (internal/plugin/sandbox.go), so a plugin cannot require
-- sibling .lua files. Sections below are delimited.
--
-- The organizing idea, and the one place this differs structurally from
-- ttt-vim: Emacs has no modes. Its primary axis is a PREFIX KEY TRIE (C-x,
-- C-x r, C-h) plus a universal argument (C-u). There is no mode state machine
-- here and there must never be one -- see the "Keymap trie" section.
--
--   Section 1  State
--   Section 2  Editor shim (keeps the mark and the mark ring valid across edits)
--   Section 3  Echo area and status
--   Section 4  Key normalization
--   Section 5  Buffer primitives
--   Section 6  Word syntax and word motions
--   Section 7  Screen position and scrolling
--   Section 8  Mark, mark ring and region
--   Section 9  Kill ring
--   Section 10 Commands
--   Section 11 Keyboard macros
--   Section 12 Incremental search
--   Section 13 Keymap trie and dispatcher
--   Section 14 Registration and deferred startup

local ttt = require("ttt")
local events = require("ttt.events")
local raw_editor = require("ttt.editor")

-- ---------------------------------------------------------------------------
-- Section 1: State
-- ---------------------------------------------------------------------------

local state = {
	enabled = true,

	-- Mark and region. `mark` is a live position kept valid by the editor shim.
	mark = nil, -- { line, col } or nil
	mark_active = false, -- transient-mark-mode: is the region highlighted?
	mark_ring = {}, -- previous marks, newest first

	-- Kill ring. Index 1 is the most recent kill; `kill_index` is where C-y
	-- reads from and M-y rotates.
	kill_ring = {},
	kill_index = 1,
	yank_start = nil, -- extent of the last yank, for M-y
	yank_end = nil,

	-- Dispatcher.
	map = nil, -- the keymap we are inside, nil at top level
	path = {}, -- tokens typed to get there, e.g. { "ctrl-x", "r" }
	arg = { active = false, mult = 4, digits = "", sign = 1 }, -- C-u
	quoted = false, -- C-q typed, next key inserts literally
	last_command = nil, -- name of the previous command (kill/yank chaining)
	last_kill = false, -- was the previous command a kill? (kills accumulate)
	goal = nil, -- sticky column for C-n / C-p

	-- Keyboard macros (C-x ( / C-x ) / C-x e).
	macro = { recording = nil, keys = {}, last = nil, playing = 0, budget = 0 },

	recenter = 0, -- C-l cycle position
	echo_msg = nil, -- current echo-area message
	clipboard = false, -- emacs.clipboard: mirror kills to the system clipboard

	-- Incremental search (Section 12). `isearch` is nil unless a search is
	-- running; `isearch_last` is the one bit of history Emacs needs, so that
	-- C-s C-s repeats the previous search string.
	isearch = nil,
	isearch_last = nil,
}

local KILL_MAX = 60
local MACRO_MAX_DEPTH = 10
local MACRO_MAX_KEYS = 20000

-- ---------------------------------------------------------------------------
-- Section 2: Editor shim
--
-- The mark, the mark ring and the yank extent are buffer positions that have to
-- survive edits, and there is no buffer-change event carrying positions
-- (`editor.change` fires with a path only, internal/app/app.go), so the two
-- mutating entry points are wrapped. `editor` is a fresh table that forwards
-- everything else to the real module via __index -- the module itself is left
-- untouched, so no other plugin sees the override.
--
-- Emacs needs this more than Vim does: a Vim mark is a line number with a
-- best-effort column, but an Emacs mark is one end of the region, so a wrong
-- column silently kills the wrong text. Columns are therefore adjusted too,
-- which ttt-vim does not do.
-- ---------------------------------------------------------------------------

-- Split a UTF-8 string into an array of rune strings. Lua 5.1 has no utf8
-- library, so the lead byte decides the sequence length.
local function runes_of(s)
	local out = {}
	local i, n = 1, #s
	while i <= n do
		local b = s:byte(i)
		local len = 1
		if b >= 0xf0 then
			len = 4
		elseif b >= 0xe0 then
			len = 3
		elseif b >= 0xc0 then
			len = 2
		end
		out[#out + 1] = s:sub(i, i + len - 1)
		i = i + len
	end
	return out
end

local function rune_len(s)
	return #runes_of(s or "")
end

local function count_newlines(s)
	local n = 0
	for _ in string.gmatch(s or "", "\n") do
		n = n + 1
	end
	return n
end

-- Everything the shim has to keep valid.
local function each_position(fn)
	if state.mark then
		fn(state.mark)
	end
	for _, m in ipairs(state.mark_ring) do
		fn(m)
	end
	if state.yank_start then
		fn(state.yank_start)
	end
	if state.yank_end then
		fn(state.yank_end)
	end
end

local editor
editor = setmetatable({
	insert = function(l, c, text)
		local nl = count_newlines(text)
		local tail = rune_len(text:match("[^\n]*$"))
		local width = rune_len(text)
		each_position(function(m)
			-- Strictly after: an Emacs marker has insertion-type nil, so text
			-- inserted exactly AT the mark leaves the mark before it. That is what
			-- puts the mark at the start of what C-y just inserted.
			if m.line == l and m.col > c then
				if nl == 0 then
					m.col = m.col + width
				else
					m.line = m.line + nl
					m.col = (m.col - c) + tail + 1
				end
			elseif m.line > l then
				m.line = m.line + nl
			end
		end)
		return raw_editor.insert(l, c, text)
	end,

	-- [sl,sc] .. [el,ec) is replaced by `text`. A position inside the replaced
	-- span collapses onto its start, which is what Emacs does to a mark inside
	-- deleted text.
	replace = function(sl, sc, el, ec, text)
		local nl = count_newlines(text)
		local new_el = sl + nl
		local new_ec
		if nl == 0 then
			new_ec = sc + rune_len(text)
		else
			new_ec = rune_len(text:match("[^\n]*$")) + 1
		end
		each_position(function(m)
			if m.line < sl or (m.line == sl and m.col <= sc) then
				return -- before the edit
			end
			if m.line < el or (m.line == el and m.col < ec) then
				m.line = sl -- inside it
				m.col = sc
				return
			end
			if m.line == el then
				m.line = new_el
				m.col = new_ec + (m.col - ec)
			else
				m.line = m.line + (new_el - el)
			end
		end)
		return raw_editor.replace(sl, sc, el, ec, text)
	end,

	set_line = function(l, text)
		local len = rune_len(raw_editor.get_line(l) or "")
		return editor.replace(l, 1, l, len + 1, text)
	end,
}, { __index = raw_editor })

-- ---------------------------------------------------------------------------
-- Section 3: Echo area and status
--
-- THE ECHO AREA IS THE STATUS BAR, DELIBERATELY -- NOT ttt.command_line.
--
-- ttt.command_line is a modal overlay, and overlays are handled ABOVE the
-- plugin key interceptor (internal/ui/root.go: handleOverlay runs before
-- KeyInterceptor). While one is open the plugin receives ZERO keystrokes, which
-- would break every Emacs prompt that has to keep reading keys AS Emacs
-- commands: C-g to abort, C-s C-s to repeat an isearch, DEL to backtrack.
-- set_status_item is not focusable, so the plugin keeps the keyboard. The
-- deferred isearch and query-replace work is meant to sit on echo() below.
--
-- The completing prompts are the exception and deliberately go the other way:
-- M-x, C-x C-f and C-x b hand over to ttt's own overlays (Section 10), because
-- those are prompts that own the keyboard in Emacs too, Escape dismisses them,
-- and it buys real completion that no plugin API could provide.
-- ---------------------------------------------------------------------------

local function status_ready()
	return type(ttt.set_status_item) == "function"
end

local function key_label(tok) -- forward-declared use; defined in Section 4
	return tok
end

local function path_label()
	local parts = {}
	for _, t in ipairs(state.path) do
		parts[#parts + 1] = key_label(t)
	end
	return table.concat(parts, " ")
end

local function arg_value()
	local a = state.arg
	if not a.active then
		return 1, false
	end
	if a.digits ~= "" then
		return a.sign * tonumber(a.digits), true
	end
	if a.sign < 0 then
		return -1, true
	end
	return a.mult, true
end

local function render_status()
	if not status_ready() then
		return
	end
	if not state.enabled then
		ttt.remove_status_item("mode")
		ttt.remove_status_item("echo")
		return
	end

	local parts = {}
	if state.arg.active then
		parts[#parts + 1] = "C-u " .. tostring((arg_value()))
	end
	if #state.path > 0 then
		parts[#parts + 1] = path_label() .. "-"
	end
	if state.quoted then
		parts[#parts + 1] = "C-q-"
	end
	if state.macro.recording then
		parts[#parts + 1] = "Def"
	end
	-- No idle label. Vim needs one because it is modal and the label says what
	-- the next keystroke will do; Emacs is not modal and has no such indicator,
	-- so the slot only ever carries the TRANSIENT states above -- a pending
	-- prefix, a universal argument, C-q, macro recording -- and is empty during
	-- ordinary editing. The echo area is a separate item ("echo") and is not
	-- affected by this.
	if #parts > 0 then
		ttt.set_status_item("left", "mode", table.concat(parts, " "), { priority = 10 })
	else
		ttt.remove_status_item("mode")
	end

	if state.echo_msg then
		ttt.set_status_item("left", "echo", state.echo_msg, { priority = 11 })
	else
		ttt.remove_status_item("echo")
	end
end

local function echo(msg)
	state.echo_msg = msg
	render_status()
end

-- What Emacs does by signalling a Lisp error: say so, and change nothing else.
-- The distinction from echo() matters because a command that signals does NOT
-- deactivate the region and does NOT count as a kill for kill-chaining --
-- `deactivate-mark` and `this-command` are only set by a command that got as
-- far as doing its work. Found by the differential fuzzer: `C-k` at end of
-- buffer followed by `C-w` must still kill the region.
local function signal(msg)
	state.failed = true
	echo(msg)
end

local function clear_echo()
	state.echo_msg = nil
	render_status()
end

-- ---------------------------------------------------------------------------
-- Section 4: Key normalization
--
-- key.press delivers { type, key, rune, mod }. `rune` is present only for
-- printable input; `mod` is nil when unmodified. Verified event shapes (see
-- REFERENCE.md for how they were captured):
--
--   ctrl+d   -> { key="Ctrl-D",   rune=nil, mod="ctrl" }   -- BOTH, not one
--   ctrl+d   -> { key="d",        rune="d", mod="ctrl" }   -- kitty protocol
--   alt+f    -> { key="f",        rune="f", mod="alt"  }
--   ctrl+spc -> { key=" ",        rune=" ", mod="ctrl" }   -- real terminal
--   ctrl+spc -> { key="unknown",  rune=nil, mod="ctrl" }   -- KeyNUL, see below
--   esc      -> { key="Esc",      rune=nil, mod=nil    }
--
-- tcell folds Ctrl into the key constant and *also* sets ModCtrl, so the key
-- name must win: normalizing off `mod` alone yields "ctrl+Ctrl-D". Under the
-- kitty keyboard protocol the same chord arrives as a rune plus ModCtrl
-- instead, so the rune path has to re-apply the ctrl- prefix.
--
-- Canonical tokens: runes keep their case ("a" vs "A"); named keys lowercase
-- ("esc", "backspace"); control keys collapse to "ctrl-d"; Meta prefixes as
-- "alt-"; shifted named keys prefix "shift-" so ttt's own shift+arrow
-- selection is not swallowed.
-- ---------------------------------------------------------------------------

local function has_mod(mod, name)
	return mod ~= nil and mod:find(name, 1, true) ~= nil
end

-- Ctrl+punctuation has no KeyCtrl* constant. tcell's legacy decoder reports the
-- control byte as a rune (0x1F -> "_"), and ttt's own foldCtrlEvent folds
-- ctrl+backtick onto ctrl+space, so both are canonicalized here the same way.
local CTRL_RUNE = {
	[" "] = "space",
	["`"] = "space",
	["_"] = "/",
	["/"] = "/",
}

local function token_of(ev)
	local ctrl = has_mod(ev.mod, "ctrl")
	local alt = has_mod(ev.mod, "alt")
	local shift = has_mod(ev.mod, "shift")
	local key = ev.key or ""
	local tok

	local ctrl_letter = key:match("^Ctrl%-(.+)$")
	if ctrl_letter then
		local base = ctrl_letter:lower()
		-- CTRL_RUNE also normalizes the key-name spelling ("Ctrl-_" -> ctrl-/), so
		-- the plugin is already right if core ever names KeyNUL/KeyUS instead of
		-- reporting them as "unknown" (see the branch below).
		tok = "ctrl-" .. (CTRL_RUNE[base] or base)
	elseif ev.rune and ev.rune ~= "" then
		if ctrl then
			tok = "ctrl-" .. (CTRL_RUNE[ev.rune] or ev.rune:lower())
		else
			tok = ev.rune
			if shift then
				shift = false -- the rune already carries the shift
			end
		end
	elseif key == "unknown" and ctrl then
		-- tcell.KeyNUL (0x00, ctrl+space) and tcell.KeyUS (0x1F, ctrl+/) have no
		-- entry in tcell.KeyNames, so internal/plugin/event_convert.go reports
		-- both as "unknown". They are indistinguishable here; C-SPC wins because
		-- undo also has C-x u. Terminals speaking the kitty protocol (Ghostty,
		-- Kitty, WezTerm) send runes instead and hit the branch above, where the
		-- two *are* distinct. See REFERENCE.md.
		tok = "ctrl-space"
	else
		tok = key:lower()
		if ctrl then
			tok = "ctrl-" .. tok
		end
		if shift then
			tok = "shift-" .. tok
			shift = false
		end
	end

	if alt then
		tok = "alt-" .. tok
	end
	return tok
end

-- A token that stands for a character the user meant to type. Modifier-prefixed
-- and named keys are not. gopher-lua is Lua 5.1, which has no %g class, so this
-- is a byte-range check.
local function is_char_token(tok)
	if tok:sub(1, 5) == "ctrl-" or tok:sub(1, 4) == "alt-" or tok:sub(1, 6) == "shift-" then
		return false
	end
	local b = tok:byte(1)
	if b == nil then
		return false
	end
	if #tok == 1 then
		return b >= 0x20 and b <= 0x7e
	end
	return b >= 0x80 -- a multi-byte rune
end

-- Emacs notation for a token, used by the echo area and describe-bindings.
key_label = function(tok)
	local out = tok
	local meta = false
	if out:sub(1, 4) == "alt-" then
		meta = true
		out = out:sub(5)
	end
	local ctrl = out:match("^ctrl%-(.+)$")
	if ctrl then
		if ctrl == "space" then
			out = "C-SPC"
		elseif #ctrl == 1 then
			out = "C-" .. ctrl
		else
			out = "C-<" .. ctrl .. ">"
		end
	elseif #out > 1 then
		out = "<" .. out .. ">"
	elseif out == " " then
		out = "SPC"
	end
	if meta then
		out = "M-" .. out
	end
	return out
end

-- ---------------------------------------------------------------------------
-- Section 5: Buffer primitives
--
-- The editor Lua API is 1-based for both line and col, and `col` is a visual
-- (rune) column, not a byte index. Everything below works on rune arrays so
-- multi-byte lines behave. get_line is used rather than buffer_lines: the
-- latter copies the whole buffer, which is unacceptable on a key-press path.
--
-- Point sits BETWEEN characters, as in Emacs, so the last valid column on a
-- line is #line + 1 (unlike Vim mode, which clamps to #line).
-- ---------------------------------------------------------------------------

local function line_runes(n)
	return runes_of(editor.get_line(n) or "")
end

local function line_len(n)
	return #line_runes(n)
end

local function line_count()
	return editor.line_count()
end

local function clamp(v, lo, hi)
	if v < lo then
		return lo
	end
	if v > hi then
		return hi
	end
	return v
end

-- table.concat errors when j runs past the array, so clamp both ends here
-- rather than at every call site.
local function sub_runes(r, i, j)
	i = math.max(1, i)
	j = math.min(j, #r)
	if i > j then
		return ""
	end
	return table.concat(r, "", i, j)
end

local function point()
	local c = editor.cursor()
	return c.line, c.col
end

local function goto_point(l, c)
	l = clamp(l, 1, line_count())
	editor.set_cursor(l, clamp(c, 1, line_len(l) + 1))
	state.goal = nil
end

-- The character after point, "\n" at end of line, nil at end of buffer.
local function char_after(l, c)
	local r = line_runes(l)
	if c <= #r then
		return r[c]
	end
	if l < line_count() then
		return "\n"
	end
	return nil
end

local function char_before(l, c)
	if c > 1 then
		return line_runes(l)[c - 1]
	end
	if l > 1 then
		return "\n"
	end
	return nil
end

local function fwd_pos(l, c)
	if c <= line_len(l) then
		return l, c + 1
	end
	if l < line_count() then
		return l + 1, 1
	end
	return l, c
end

local function back_pos(l, c)
	if c > 1 then
		return l, c - 1
	end
	if l > 1 then
		return l - 1, line_len(l - 1) + 1
	end
	return l, c
end

-- Charwise text for [sl,sc] .. [el,ec) -- ec is an exclusive end column, the
-- same convention editor.replace uses.
local function region_string(sl, sc, el, ec)
	if sl == el then
		return sub_runes(line_runes(sl), sc, ec - 1)
	end
	local parts = { sub_runes(line_runes(sl), sc, math.huge) }
	for l = sl + 1, el - 1 do
		parts[#parts + 1] = editor.get_line(l) or ""
	end
	parts[#parts + 1] = sub_runes(line_runes(el), 1, ec - 1)
	return table.concat(parts, "\n")
end

-- Insert `text` at (l, c) and return the position just past it.
local function insert_text(l, c, text)
	editor.insert(l, c, text)
	local nl = count_newlines(text)
	if nl == 0 then
		return l, c + rune_len(text)
	end
	return l + nl, rune_len(text:match("[^\n]*$")) + 1
end

-- UNDO CONTRACT: every Emacs command is exactly one undo step. Undo
-- transactions do NOT nest -- a second begin_undo_group mid-operation resets the
-- transaction start index (internal/core/undo/undo.go) and silently drops
-- everything before it -- so exactly one bracket per command, and never around
-- a call that runs a core command (core opens its own).
local function edit(fn)
	editor.begin_undo_group()
	local ok, err = pcall(fn)
	editor.end_undo_group()
	if not ok then
		error(err, 0)
	end
end

-- ---------------------------------------------------------------------------
-- Section 6: Word syntax and word motions
--
-- Emacs word syntax is much simpler than Vim's word/WORD split: a character is
-- either word-constituent or it is not. The classes here are `standard-syntax-
-- table`, which is what fundamental-mode uses (src/syntax.c, init_syntax_once):
--
--   word (Sword)     A-Z a-z 0-9 $ %
--   symbol (Ssymbol) _ - + * / & | < > =
--   punct (Spunct)   . , ; : ? ! # @ ~ ^ ' `
--
-- Only the first class is word-constituent, so M-f on "foo_bar" stops after
-- "foo" and M-f on "50%" runs through the "%". Both are easy to get wrong: Vim
-- counts "_" as a word character and "%" as punctuation, so ttt-vim's classes
-- would be wrong in both directions and are deliberately not reused.
-- ---------------------------------------------------------------------------

local function is_word(ch)
	if ch == nil or ch == "\n" then
		return false
	end
	local b = ch:byte(1)
	if b >= 0x80 then
		-- Emacs derives this from the char's script; treating every multi-byte
		-- rune as a word character matches for letters and diverges only for
		-- non-ASCII punctuation.
		return true
	end
	if b == 0x24 or b == 0x25 then
		return true -- "$" and "%" have word syntax in the standard table
	end
	return (b >= 0x30 and b <= 0x39) or (b >= 0x41 and b <= 0x5a) or (b >= 0x61 and b <= 0x7a)
end

-- Where forward-word would land: skip non-word characters, then word ones.
local function forward_word_pos(l, c, count)
	for _ = 1, count do
		while true do
			local ch = char_after(l, c)
			if ch == nil or is_word(ch) then
				break
			end
			l, c = fwd_pos(l, c)
		end
		while true do
			local ch = char_after(l, c)
			if ch == nil or not is_word(ch) then
				break
			end
			l, c = fwd_pos(l, c)
		end
	end
	return l, c
end

local function backward_word_pos(l, c, count)
	for _ = 1, count do
		while true do
			local ch = char_before(l, c)
			if ch == nil or is_word(ch) then
				break
			end
			l, c = back_pos(l, c)
		end
		while true do
			local ch = char_before(l, c)
			if ch == nil or not is_word(ch) then
				break
			end
			l, c = back_pos(l, c)
		end
	end
	return l, c
end

-- ---------------------------------------------------------------------------
-- Section 7: Screen position and scrolling
--
-- SetCursor calls EnsureCursorVisible on the Go side (internal/app/plugin_api.go),
-- so every routine here moves point FIRST and scrolls LAST; the reverse order is
-- silently undone.
-- ---------------------------------------------------------------------------

local function viewport()
	local v = editor.viewport()
	return v.top_line, v.bottom_line, v.height
end

local function scroll_page(dir, count)
	local top, _, h = viewport()
	local n = line_count()
	local amount = math.max(1, h - 2) * count

	local l, c = point()
	goto_point(l + dir * amount, c)

	if n > h then
		editor.scroll_to(clamp(top + dir * amount, 1, math.max(1, n - h + 1)))
	end
end

-- C-l: centre, then top, then bottom, as recenter-top-bottom does.
local function recenter_view(stage)
	local _, _, h = viewport()
	local l = editor.cursor().line
	local top
	if stage == 1 then
		top = l
	elseif stage == 2 then
		top = l - h + 1
	else
		top = l - math.floor(h / 2)
	end
	editor.scroll_to(math.max(1, top))
end

-- ---------------------------------------------------------------------------
-- Section 8: Mark, mark ring and region
--
-- The mark is one live position; the mark ring remembers where it was. The
-- region is [mark, point) in whichever order they fall. Highlighting borrows
-- ttt's own selection: SetSelection anchors at the start and parks the cursor at
-- the end (internal/app/plugin_api.go), so point must be set first and the
-- selection synced afterwards with the same end position.
-- ---------------------------------------------------------------------------

local function sync_region()
	if not (state.mark and state.mark_active) then
		return
	end
	local l, c = point()
	editor.set_selection(state.mark.line, state.mark.col, l, c)
end

local function deactivate_mark()
	if state.mark_active then
		state.mark_active = false
		editor.clear_selection()
	end
end

local function push_mark(l, c, activate)
	if state.mark then
		table.insert(state.mark_ring, 1, { line = state.mark.line, col = state.mark.col })
		while #state.mark_ring > 16 do
			table.remove(state.mark_ring)
		end
	end
	state.mark = { line = l, col = c }
	if activate then
		state.mark_active = true
	end
	-- Moving the mark under a LIVE region has to move the selection anchor with
	-- it, or the highlight keeps painting from where the mark used to be. This is
	-- reachable through the push-mark inside C-y (`C-SPC C-f C-y`).
	if state.mark_active then
		sync_region()
	end
end

-- C-u C-SPC: point goes to the mark, and the ring rotates into its place.
local function pop_mark()
	if not state.mark then
		signal("No mark set in this buffer")
		return
	end
	local ml, mc = state.mark.line, state.mark.col
	local prev = table.remove(state.mark_ring, 1)
	state.mark = prev or { line = ml, col = mc }
	deactivate_mark()
	goto_point(ml, mc)
end

-- Normalized region bounds, or nil when there is no region.
--
-- The mark must be ACTIVE, which is `mark-even-if-inactive` nil rather than
-- Emacs's own default of t. ttt has no way to show a set-but-inactive mark --
-- no selection means no region -- so an inactive mark is treated as no region
-- and C-w / M-w refuse, which is the behaviour the two editors can share.
local function region_bounds()
	if not (state.mark and state.mark_active) then
		return nil
	end
	local l, c = point()
	local ml = clamp(state.mark.line, 1, line_count())
	local mc = clamp(state.mark.col, 1, line_len(ml) + 1)
	if ml < l or (ml == l and mc <= c) then
		return ml, mc, l, c
	end
	return l, c, ml, mc
end

-- ---------------------------------------------------------------------------
-- Section 9: Kill ring
--
-- A flat list, newest first, capped at KILL_MAX. `kill_index` is where C-y
-- reads and M-y rotates. Consecutive kill commands accumulate into the head
-- entry rather than pushing a new one, which is what makes repeated C-k collect
-- a whole paragraph into a single yank.
--
-- Deliberately much simpler than Vim's registers: there are no named slots, no
-- delete ring, no per-entry linewise/charwise kind. Emacs has none of those.
-- ---------------------------------------------------------------------------

-- There is no clipboard binding in the plugin Lua API, so mirroring a kill to
-- the system clipboard borrows editor.copy: select the range, copy, restore.
-- The range must still exist, so this runs *before* the text is deleted.
local function clipboard_copy(sl, sc, el, ec)
	local l, c = point()
	editor.set_selection(sl, sc, el, ec)
	ttt.exec_command("editor.copy")
	editor.clear_selection()
	editor.set_cursor(l, c)
end

-- An EMPTY kill is a real kill-ring entry: `(kill-new "")` pushes "", and a
-- following C-y yanks nothing instead of re-yanking the previous entry. Dropping
-- empty kills here would make `M-d` at point-max (or `M-w` on an empty region)
-- paste a whole line out of nowhere. Verified against Emacs 27.1.
local function kill_push(text)
	table.insert(state.kill_ring, 1, text)
	while #state.kill_ring > KILL_MAX do
		table.remove(state.kill_ring)
	end
	state.kill_index = 1
end

-- `prepend` is set by the backward kills (M-DEL), so C-k C-k reads forwards and
-- M-DEL M-DEL reads backwards, both in buffer order.
-- `quiet` is kill-ring-save (M-w), which appends to a chain in progress but does
-- NOT start one: copy-region-as-kill never sets this-command to 'kill-region, so
-- `M-w C-k` leaves two separate entries while `C-k M-w` makes one. Verified
-- against Emacs 27.1.
local function kill_save(text, prepend, range, quiet)
	if state.last_kill then
		if not state.kill_ring[1] then
			-- Emacs quirk, reproduced on purpose: kill-append onto an EMPTY ring
			-- signals after filter-buffer-substring has already deleted the text,
			-- so the text is gone and the ring stays empty. Reachable through a
			-- refused C-w (see cmds.kill_region) followed by any kill.
			return
		end
		if prepend then
			state.kill_ring[1] = text .. state.kill_ring[1]
		else
			state.kill_ring[1] = state.kill_ring[1] .. text
		end
		state.kill_index = 1
	else
		kill_push(text)
	end
	if not quiet then
		state.this_kill = true -- ⇔ (setq this-command 'kill-region)
	end
	-- An empty kill has nothing to mirror, and asking ttt to copy an empty
	-- selection is not the same no-op (editor.copy with no selection takes the
	-- whole line), so the clipboard is left alone.
	if state.clipboard and range and text ~= "" then
		clipboard_copy(range[1], range[2], range[3], range[4])
	end
end

local function current_kill()
	return state.kill_ring[state.kill_index]
end

-- ---------------------------------------------------------------------------
-- Section 10: Commands
--
-- Every entry takes (count, explicit): `count` is the resolved universal
-- argument (1 when none was given) and `explicit` says whether the user
-- actually typed one, which a few commands care about (C-u C-SPC, C-u C-k).
-- ---------------------------------------------------------------------------

local cmds = {}

-- Movement ------------------------------------------------------------------

cmds.forward_char = function(n)
	local l, c = point()
	local sl, sc = l, c
	for _ = 1, math.abs(n) do
		if n > 0 then
			l, c = fwd_pos(l, c)
		else
			l, c = back_pos(l, c)
		end
	end
	if l == sl and c == sc and n ~= 0 then
		signal(n > 0 and "End of buffer" or "Beginning of buffer")
		return
	end
	goto_point(l, c)
end

cmds.backward_char = function(n)
	cmds.forward_char(-n)
end

-- C-n / C-p keep a sticky goal column, so a run down through short lines comes
-- back out at the original column. This is `line-move-visual` nil (logical
-- lines, not screen lines) and `track-eol` nil (the goal is a column, it does
-- not stick to the end of the line).
--
-- `next-line-add-newlines` is nil by default, so C-n on the last line must NOT
-- grow the buffer: it signals and leaves point alone. A count that overshoots
-- still moves as far as it can, which is what line-move-1 does.
cmds.next_line = function(n)
	local l, c = point()
	-- `temporary-goal-column` only survives between consecutive line-move
	-- commands: (memq last-command '(next-line previous-line)). Anything else --
	-- including a self-inserting key, which never reaches finish_command's
	-- goto_point -- restarts the goal from the current column.
	local chained = state.last_command == "next-line" or state.last_command == "previous-line"
	local goal = (chained and state.goal) or c
	local last = line_count()
	local target = l + n
	if target > last then
		-- line-move-1 moves as far as it can and THEN signals, so C-n on the last
		-- line lands on point-max rather than staying put. Verified against Emacs
		-- 27.1: `M-u C-p` leaves point at 1, not where M-u left it.
		signal("End of buffer")
		editor.set_cursor(last, line_len(last) + 1)
		state.goal = goal
		return
	end
	if target < 1 then
		signal("Beginning of buffer")
		editor.set_cursor(1, 1)
		state.goal = goal
		return
	end
	editor.set_cursor(target, math.min(goal, line_len(target) + 1))
	state.goal = goal
end

cmds.previous_line = function(n)
	cmds.next_line(-n)
end

cmds.beginning_of_line = function()
	local l = editor.cursor().line
	goto_point(l, 1)
end

cmds.end_of_line = function()
	local l = editor.cursor().line
	goto_point(l, line_len(l) + 1)
end

cmds.forward_word = function(n)
	local l, c = point()
	if n < 0 then
		l, c = backward_word_pos(l, c, -n)
	else
		l, c = forward_word_pos(l, c, n)
	end
	goto_point(l, c)
end

cmds.backward_word = function(n)
	cmds.forward_word(-n)
end

cmds.scroll_up = function(n)
	scroll_page(1, n)
end

cmds.scroll_down = function(n)
	scroll_page(-1, n)
end

-- M-< and M-> push the mark before the big jump, so C-u C-SPC comes back --
-- but ONLY when the region is inactive:
--
--   (or (consp arg) (region-active-p) (push-mark))
--
-- Pushing unconditionally moves the mark out from under a live region, so a
-- C-SPC ... M-> C-w kills from the wrong place. Found by the differential
-- fuzzer (seed 8), and invisible in any sequence that does not mark first.
local function jump_pushing_mark(l, c)
	if not state.mark_active then
		push_mark(l, c, false)
	end
end

cmds.beginning_of_buffer = function()
	local l, c = point()
	jump_pushing_mark(l, c)
	goto_point(1, 1)
end

cmds.end_of_buffer = function()
	local l, c = point()
	jump_pushing_mark(l, c)
	local n = line_count()
	goto_point(n, line_len(n) + 1)
end

cmds.recenter = function()
	if state.last_command ~= "recenter-top-bottom" then
		state.recenter = -1
	end
	state.recenter = (state.recenter + 1) % 3
	recenter_view(state.recenter)
end

-- Mark and region -----------------------------------------------------------

cmds.set_mark = function(_, explicit)
	if explicit then
		pop_mark() -- C-u C-SPC
		return
	end
	local l, c = point()
	push_mark(l, c, true)
	echo("Mark set")
end

-- gopher-lua evaluates `a, b = b, a` as `b, b` -- a register-allocation bug, not
-- Lua semantics. Every swap in this file therefore reads both sides into
-- separate names first, which is exactly what this command is.
cmds.exchange_point_and_mark = function()
	if not state.mark then
		signal("No mark set in this buffer")
		return
	end
	local ml, mc = state.mark.line, state.mark.col
	local pl, pc = point()
	state.mark = { line = pl, col = pc }
	-- C-x C-x ACTIVATES the region, whatever it was before -- verified against
	-- Emacs 27.1 rather than read off exchange-point-and-mark's `xor` clause,
	-- which reads as though an inactive mark should stay inactive. It does not:
	-- `M-> C-x C-x` leaves a live region, and a following C-w kills it.
	state.mark_active = true
	goto_point(ml, mc)
	sync_region()
end

cmds.mark_whole_buffer = function()
	local n = line_count()
	push_mark(n, line_len(n) + 1, false)
	goto_point(1, 1)
	state.mark_active = true
	sync_region()
end

-- Editing -------------------------------------------------------------------

cmds.delete_char = function(n)
	if n < 0 then
		cmds.delete_backward_char(-n)
		return
	end
	local l, c = point()
	local el, ec = l, c
	for _ = 1, n do
		el, ec = fwd_pos(el, ec)
	end
	if el == l and ec == c then
		signal("End of buffer")
		return
	end
	edit(function()
		editor.replace(l, c, el, ec, "")
		goto_point(l, c)
	end)
end

-- `delete-active-region` defaults to t, so DEL with a live region deletes the
-- whole region instead of one character -- and DELETES it, without a kill-ring
-- entry (delete-active-region is only passed a killflag with a prefix arg). C-d
-- is `delete-char`, which has no such case; only DEL and <delete>
-- (delete-forward-char) do. Missing this makes any C-SPC ... DEL sequence
-- diverge wildly, since Emacs eats the whole region.
--
-- An EMPTY active region is not a region: `use-empty-active-region` is nil, so
-- `region-active-p` is false for delete-backward-char's purposes and DEL deletes
-- the character before point as if nothing were marked (the mark stays where it
-- is; the edit deactivates it, as any buffer modification does). Verified
-- against Emacs 27.1 with `C-f C-SPC DEL`.
local function delete_active_region()
	local sl, sc, el, ec = region_bounds()
	if not sl then
		return false
	end
	if sl == el and sc == ec then
		return false
	end
	edit(function()
		editor.replace(sl, sc, el, ec, "")
		goto_point(sl, sc)
	end)
	deactivate_mark()
	return true
end

cmds.delete_backward_char = function(n)
	if n < 0 then
		cmds.delete_char(-n)
		return
	end
	if n == 1 and delete_active_region() then
		return
	end
	local l, c = point()
	local sl, sc = l, c
	for _ = 1, n do
		sl, sc = back_pos(sl, sc)
	end
	if sl == l and sc == c then
		signal("Beginning of buffer")
		return
	end
	edit(function()
		editor.replace(sl, sc, l, c, "")
		goto_point(sl, sc)
	end)
end

cmds.delete_forward_char = function(n)
	if n == 1 and delete_active_region() then
		return
	end
	cmds.delete_char(n)
end

-- C-k with `kill-whole-line` nil, which is the Emacs default and the easiest
-- thing in this file to get backwards:
--
--   point before the end of a non-empty line -> kill to end of line, and NOT
--     the newline, even when point is at column 1
--   point at the end of the line (which includes every empty line) -> kill the
--     newline, joining the next line on
--
-- C-u N C-k kills N whole lines; C-u 0 C-k kills back to the line start.
cmds.kill_line = function(n, explicit)
	local l, c = point()
	local el, ec

	if explicit then
		if n <= 0 then
			if c == 1 then
				signal("Beginning of line")
				return
			end
			local text = region_string(l, 1, l, c)
			edit(function()
				kill_save(text, true, { l, 1, l, c })
				editor.replace(l, 1, l, c, "")
				goto_point(l, 1)
			end)
			return
		end
		local last = clamp(l + n - 1, 1, line_count())
		if last < line_count() then
			el, ec = last + 1, 1
		else
			el, ec = last, line_len(last) + 1
		end
	elseif c > line_len(l) then
		if l >= line_count() then
			signal("End of buffer")
			return
		end
		el, ec = l + 1, 1
	else
		el, ec = l, line_len(l) + 1
	end

	if el == l and ec == c then
		signal("End of buffer")
		return
	end
	local text = region_string(l, c, el, ec)
	edit(function()
		kill_save(text, false, { l, c, el, ec })
		editor.replace(l, c, el, ec, "")
		goto_point(l, c)
	end)
end

-- With no mark ever set there is no region, and Emacs raises an error rather
-- than guessing. Here that is a message and a no-op: the buffer, point and mark
-- are all left exactly as they were.
local function no_region_message()
	if state.mark then
		return "The mark is not active now"
	end
	return "The mark is not set now, so there is no region"
end

cmds.kill_region = function()
	local sl, sc, el, ec = region_bounds()
	if not sl then
		-- `kill-region` is itself the symbol kill-append tests for, and the
		-- command loop sets this-command before the interactive spec signals, so
		-- even a REFUSED C-w arms the kill chain. That is what makes the
		-- empty-ring quirk above reachable.
		state.this_kill = true
		signal(no_region_message())
		return
	end
	local text = region_string(sl, sc, el, ec)
	edit(function()
		kill_save(text, false, { sl, sc, el, ec })
		editor.replace(sl, sc, el, ec, "")
		goto_point(sl, sc)
	end)
	deactivate_mark()
end

cmds.kill_ring_save = function()
	local sl, sc, el, ec = region_bounds()
	if not sl then
		signal(no_region_message())
		return
	end
	kill_save(region_string(sl, sc, el, ec), false, { sl, sc, el, ec }, true)
	deactivate_mark()
	echo("Saved")
end

-- Emacs leaves point at the END of the yanked text and the mark at its
-- beginning, which is what makes C-y C-x C-x select what was just pasted.
cmds.yank = function(n)
	-- `yank` runs (push-mark) BEFORE (current-kill), so an empty kill ring still
	-- leaves the mark behind at point: `C-y C-x C-x` is a working command pair on
	-- a fresh buffer even though the C-y signalled. Found by the fuzzer.
	local l, c = point()
	push_mark(l, c, false)

	local text = current_kill()
	if not text then
		signal("Kill ring is empty")
		return
	end
	edit(function()
		local el, ec = l, c
		for _ = 1, math.max(1, n) do
			el, ec = insert_text(el, ec, text)
		end
		state.yank_start = { line = l, col = c }
		state.yank_end = { line = el, col = ec }
		goto_point(el, ec)
	end)
end

-- M-y replaces what the previous yank inserted with the next ring entry, so it
-- is only meaningful directly after a yank.
cmds.yank_pop = function()
	if state.last_command ~= "yank" and state.last_command ~= "yank-pop" then
		signal("Previous command was not a yank")
		return
	end
	if #state.kill_ring < 2 then
		signal("Kill ring has a single entry")
		return
	end
	state.kill_index = (state.kill_index % #state.kill_ring) + 1
	local text = current_kill()
	local s, e = state.yank_start, state.yank_end
	edit(function()
		editor.replace(s.line, s.col, e.line, e.col, text)
		local el, ec = s.line, s.col
		if count_newlines(text) == 0 then
			ec = s.col + rune_len(text)
		else
			el = s.line + count_newlines(text)
			ec = rune_len(text:match("[^\n]*$")) + 1
		end
		state.yank_end = { line = el, col = ec }
		goto_point(el, ec)
	end)
end

-- C-t. Emacs's transpose-chars is not simply "swap the characters either side of
-- point": it first steps back one character when point is at end of line
--
--   (when (and (null arg) (eolp)) (forward-char -1))
--
-- and only then swaps the pair around point, leaving point after it. Written
-- against the point model that gives all four cases for free:
--
--   "a|bc"   -> "ba|c"     the ordinary case
--   "abc|"   -> "acb|"     end of line: the two *preceding* characters
--   "ab\n|cd"-> "abc\n|d"  start of line: the newline is one of the two
--   "ab\n|\ncd"           empty line: steps back onto the previous line first
--
-- The newline cases work because the replaced span crosses a line boundary and
-- editor.replace takes text containing "\n".
cmds.transpose_chars = function()
	local l, c = point()
	if c > line_len(l) then
		l, c = back_pos(l, c)
	end
	local before = char_before(l, c)
	local after = char_after(l, c)
	if before == nil or after == nil then
		signal("Beginning of buffer")
		return
	end
	local bl, bc = back_pos(l, c)
	local el, ec = fwd_pos(l, c)
	edit(function()
		local text = after .. before
		editor.replace(bl, bc, el, ec, text)
		-- Point lands just past the pair, computed the same way insert_text does.
		local nl = count_newlines(text)
		if nl == 0 then
			goto_point(bl, bc + rune_len(text))
		else
			goto_point(bl + nl, rune_len(text:match("[^\n]*$")) + 1)
		end
	end)
end

-- C-o: open a line after point without moving it.
cmds.open_line = function(n)
	local l, c = point()
	edit(function()
		editor.insert(l, c, string.rep("\n", math.max(1, n)))
		goto_point(l, c)
	end)
end

-- Unlike C-k (which signals `end-of-buffer` itself, before it ever reaches
-- kill-region), the word kills do NOT signal when there is no word left:
-- `kill-word` is (kill-region (point) (progn (forward-word arg) (point))) and
-- forward-word simply returns nil at the buffer edge. So M-d at point-max and
-- M-DEL at point-min kill the EMPTY region -- a real kill-ring entry, so the
-- next C-y yanks nothing -- and deactivate the mark like any other kill.
-- Verified against Emacs 27.1.
cmds.kill_word = function(n)
	local l, c = point()
	local el, ec = forward_word_pos(l, c, math.max(1, n))
	local text = region_string(l, c, el, ec)
	edit(function()
		kill_save(text, false, { l, c, el, ec })
		editor.replace(l, c, el, ec, "")
		goto_point(l, c)
	end)
end

cmds.backward_kill_word = function(n)
	local l, c = point()
	local sl, sc = backward_word_pos(l, c, math.max(1, n))
	local text = region_string(sl, sc, l, c)
	edit(function()
		kill_save(text, true, { sl, sc, l, c })
		editor.replace(sl, sc, l, c, "")
		goto_point(sl, sc)
	end)
end

-- M-u / M-l / M-c all run from point to the end of the word and leave point
-- there, which is what makes them chainable.
local function case_word(n, mode)
	local l, c = point()
	local el, ec = forward_word_pos(l, c, math.max(1, n))
	if el == l and ec == c then
		return
	end
	local text = region_string(l, c, el, ec)
	local out
	if mode == "up" then
		out = text:upper()
	elseif mode == "down" then
		out = text:lower()
	else
		-- capitalize-region: the first character of *every* word in the range,
		-- so M-3 M-c capitalizes three words rather than only the first. A range
		-- that starts mid-word capitalizes that partial word, as Emacs does
		-- ("he|llo" -> "heLlo"). The class matches is_word above.
		out = text:lower():gsub("[%w%$%%]+", function(w)
			return w:sub(1, 1):upper() .. w:sub(2)
		end)
	end
	edit(function()
		editor.replace(l, c, el, ec, out)
		goto_point(el, ec)
	end)
end

cmds.upcase_word = function(n)
	case_word(n, "up")
end

cmds.downcase_word = function(n)
	case_word(n, "down")
end

cmds.capitalize_word = function(n)
	case_word(n, "cap")
end

-- Files, undo, control ------------------------------------------------------

cmds.undo = function(n)
	for _ = 1, math.max(1, n) do
		ttt.exec_command("editor.undo")
	end
	deactivate_mark()
	echo("Undo!")
end

cmds.save_buffer = function()
	if ttt.exec_command("file.save") then
		echo("Wrote " .. (editor.file_name() or "buffer"))
	else
		signal("file.save is not available")
	end
end

-- Emacs C-x C-c offers to save modified buffers before exiting, so this routes
-- through editor.quit -- the core command that prompts on unsaved changes --
-- rather than the unconditional ttt.quit(), which would silently discard work.
cmds.quit_editor = function()
	if not ttt.exec_command("editor.quit") then
		ttt.quit()
	end
end

-- Bridges to ttt's own overlays. `exec_command` returns false when the command
-- is not registered, which is the only failure mode worth reporting.
local function run_core(id, name)
	if not ttt.exec_command(id) then
		signal(name .. ": " .. id .. " is not available")
	end
end

cmds.execute_extended_command = function()
	run_core("command.palette", "M-x")
end

cmds.find_file = function()
	run_core("file.quickOpen", "C-x C-f")
end

cmds.switch_to_buffer = function()
	run_core("file.quickOpen", "C-x b")
end

cmds.kill_buffer = function()
	run_core("tab.close", "C-x k")
end

cmds.keyboard_quit = function()
	deactivate_mark()
	if state.macro.recording then
		state.macro.recording = nil
		state.macro.keys = {}
	end
	echo("Quit")
end

cmds.quoted_insert = function()
	state.quoted = true
end

-- ---------------------------------------------------------------------------
-- Section 11: Keyboard macros
--
-- C-x ( / C-x ) / C-x e is very nearly Vim's q / @, so the same shape is used:
-- recording captures canonical *tokens*, not raw events, and a replay is
-- literally "feed the tokens back through dispatch()". `playing` is a depth
-- counter that stops a replay from being recorded and caps recursion; a key
-- budget catches the other runaway shape, a macro that loops without recursing.
-- ---------------------------------------------------------------------------

local dispatch -- forward declaration; play_macro re-enters it

local function start_macro()
	state.macro.recording = true
	state.macro.keys = {}
	echo("Defining kbd macro...")
end

local function stop_macro()
	if not state.macro.recording then
		signal("Not defining kbd macro")
		return
	end
	local keys = state.macro.keys
	-- The C-x of the closing "C-x )" was recorded before the prefix resolved.
	if keys[#keys] == "ctrl-x" then
		table.remove(keys)
	end
	state.macro.recording = nil
	state.macro.last = keys
	state.macro.keys = {}
	echo("Keyboard macro defined")
end

local function play_macro(count)
	local keys = state.macro.last
	if not keys or #keys == 0 then
		signal("No kbd macro has been defined")
		return
	end
	if state.macro.playing >= MACRO_MAX_DEPTH then
		return
	end
	if state.macro.playing == 0 then
		state.macro.budget = MACRO_MAX_KEYS
	end
	state.macro.playing = state.macro.playing + 1
	-- A Lua error mid-replay would otherwise be swallowed by the key.press
	-- listener and leave the depth counter stuck.
	pcall(function()
		for _ = 1, math.max(1, count) do
			for _, tok in ipairs(keys) do
				state.macro.budget = state.macro.budget - 1
				if state.macro.budget <= 0 then
					error("emacs: macro key budget exhausted")
				end
				-- A self-inserting key is normally passed through for the editor
				-- to type. There is no editor in a replay, so type it here.
				if not dispatch(tok) and is_char_token(tok) then
					local l, c = point()
					edit(function()
						local el, ec = insert_text(l, c, tok)
						goto_point(el, ec)
					end)
				end
			end
		end
	end)
	state.macro.playing = state.macro.playing - 1
end

cmds.start_kbd_macro = function()
	start_macro()
end

cmds.end_kbd_macro = function()
	stop_macro()
end

cmds.call_last_kbd_macro = function(n)
	play_macro(n)
end

-- ---------------------------------------------------------------------------
-- Section 12: Incremental search (C-s / C-r)
--
-- The one Emacs prompt that could NOT have been built on ttt.command_line.
-- isearch keeps reading keys as Emacs commands after the prompt is up -- C-s
-- repeats, DEL backtracks, C-g aborts -- and an overlay would take the keyboard
-- away from the plugin entirely (Section 3). It renders through echo(), so the
-- plugin keeps every keystroke.
--
-- The search is LITERAL, never a regexp: string comparison over rune arrays, so
-- multi-byte lines behave and no regexp engine is needed. The search string can
-- never contain a newline (RET exits), so a match never spans lines.
--
-- STATE MACHINE. `state.isearch` is nil when no search is running, and
-- otherwise holds all of it:
--
--   str      the search string
--   dir      1 forward, -1 backward
--   origin   point when the search started: where C-g returns to, and where the
--            mark is pushed on exit
--   barrier  Emacs's isearch-barrier -- how far a backward match may extend
--   match    { line, col, len } of the current match, nil when there is none
--   failing  no match for `str`
--   wrapped  the search has restarted from the far end of the buffer
--   stack    one snapshot per command, for DEL
--
-- THE BACKTRACK STACK. DEL is isearch-delete-char, which undoes the last
-- COMMAND, not the last character. A snapshot is pushed after every isearch
-- command (including the one that starts the search, so the stack always has a
-- floor), and DEL pops one and restores it whole: string, point, match,
-- direction, failing and wrapped together. So `C-s f o o C-s DEL` goes back to
-- the FIRST match of "foo" -- it does not become a search for "fo".
--
-- EXIT AND REDISPATCH. Any key isearch does not handle itself ends the search
-- and is then executed normally (isearch-other-meta-char). This is the one
-- place this section reaches back into the dispatcher, and the key must not be
-- lost: the search is torn down FIRST, so the recursive dispatch() cannot land
-- back in here, and its return value is passed through so that a key ttt owns
-- still falls through to the editor.
--
-- Every rule below was checked against GNU Emacs 27.1 (isearch.el) rather than
-- guessed; the non-obvious ones are commented where they are implemented.
-- ---------------------------------------------------------------------------

local isr = {}

-- Smart case: a search string that is all lower case folds case, and one
-- upper-case character makes the search case-sensitive. This is
-- `isearch-no-upper-case-p` with `search-upper-case` at its default. The test
-- is per RUNE rather than a %u byte match, which would call the 0xC3 lead byte
-- of a two-byte rune upper case.
isr.fold_case = function(str)
	for _, r in ipairs(runes_of(str)) do
		if r ~= string.lower(r) then
			return false
		end
	end
	return true
end

-- A line as a rune array, lower-cased when the search folds case. Folding rune
-- by rune rather than with s:lower() keeps rune indices aligned with the
-- buffer: Go's ToLower can change a string's byte length.
isr.fold_runes = function(r, fold)
	if not fold then
		return r
	end
	local out = {}
	for i = 1, #r do
		out[i] = string.lower(r[i])
	end
	return out
end

isr.match_at = function(hay, needle, i)
	local m = #needle
	if i < 1 or i + m - 1 > #hay then
		return false
	end
	for j = 1, m do
		if hay[i + j - 1] ~= needle[j] then
			return false
		end
	end
	return true
end

-- First match whose START is at or after (l, c) -- what search-forward finds.
isr.find_forward = function(needle, fold, l, c)
	local m = #needle
	for line = math.max(1, l), line_count() do
		local hay = isr.fold_runes(line_runes(line), fold)
		local from = (line == l) and math.max(1, c) or 1
		for i = from, #hay - m + 1 do
			if isr.match_at(hay, needle, i) then
				return line, i
			end
		end
	end
	return nil
end

-- Last match whose START is at or before (l, c). Callers that want
-- search-backward's "the match must END at or before here" pass c - #needle.
isr.find_backward = function(needle, fold, l, c)
	local m = #needle
	for line = math.min(l, line_count()), 1, -1 do
		local hay = isr.fold_runes(line_runes(line), fold)
		local upto = (line == l) and c or (#hay - m + 1)
		if upto > #hay - m + 1 then
			upto = #hay - m + 1
		end
		for i = upto, 1, -1 do
			if isr.match_at(hay, needle, i) then
				return line, i
			end
		end
	end
	return nil
end

isr.pos_before = function(l1, c1, l2, c2)
	return l1 < l2 or (l1 == l2 and c1 < c2)
end

-- The earlier of two positions, as a fresh table.
isr.min_pos = function(a, b)
	if isr.pos_before(b.line, b.col, a.line, a.col) then
		return { line = b.line, col = b.col }
	end
	return { line = a.line, col = a.col }
end

-- Search for the current string from (bl, bc): forward finds the first match
-- starting at or after it, backward the last match ENDING at or before it.
isr.locate = function(s, bl, bc)
	local fold = isr.fold_case(s.str)
	local needle = isr.fold_runes(runes_of(s.str), fold)
	if s.dir > 0 then
		return isr.find_forward(needle, fold, bl, bc)
	end
	return isr.find_backward(needle, fold, bl, bc - #needle)
end

-- Adopt a search result. Forward search leaves point at the END of the match,
-- backward search at its BEGINNING. A search that fails does NOT move point:
-- Emacs restores it from the last pushed state, which is where it already is.
isr.apply = function(s, ml, mc)
	if not ml then
		s.failing = true
		return
	end
	local m = rune_len(s.str)
	s.failing = false
	s.match = { line = ml, col = mc, len = m }
	if s.dir > 0 then
		goto_point(ml, mc + m)
	else
		goto_point(ml, mc)
	end
	sync_region()
end

-- Match highlighting borrows ttt's own find highlight. SetSearch is always
-- case-SENSITIVE for a plain pattern (internal/app/plugin_api.go), so a
-- case-folding search is handed a quoted regexp with an inline (?i) flag
-- instead -- the plugin's own matching above stays literal either way.
isr.regex_quote = function(str)
	local out = str:gsub("[%^%$%.%|%?%*%+%(%)%[%]%{%}\\]", function(ch)
		return "\\" .. ch
	end)
	return out
end

isr.highlight = function(s)
	if s.str == "" then
		editor.clear_search()
		return
	end
	if isr.fold_case(s.str) then
		editor.set_search("(?i)" .. isr.regex_quote(s.str), true)
	else
		editor.set_search(s.str)
	end
end

-- The echo-area prompt, assembled exactly as isearch-message-prefix does:
-- "failing ", then "over"/"wrapped ", then "case-sensitive " (which Emacs shows
-- only while failing), then the prompt itself, and the first letter upper-cased
-- at the end. So: "I-search: foo", "I-search backward: foo",
-- "Failing I-search: foo", "Wrapped I-search: foo".
isr.message = function(s)
	local m = ""
	if s.failing then
		m = m .. "failing "
	end
	if s.wrapped then
		local l, c = point()
		local over
		if s.dir > 0 then
			over = isr.pos_before(s.origin.line, s.origin.col, l, c)
		else
			over = isr.pos_before(l, c, s.origin.line, s.origin.col)
		end
		m = m .. (over and "over" or "") .. "wrapped "
	end
	if s.failing and not isr.fold_case(s.str) then
		m = m .. "case-sensitive "
	end
	m = m .. "I-search" .. (s.dir < 0 and " backward" or "") .. ": " .. s.str
	return m:sub(1, 1):upper() .. m:sub(2)
end

-- Redisplay after an isearch command: prompt, highlight, and the snapshot DEL
-- will come back to.
isr.update = function(s)
	local l, c = point()
	s.stack[#s.stack + 1] = {
		str = s.str,
		dir = s.dir,
		failing = s.failing,
		wrapped = s.wrapped,
		barrier = { line = s.barrier.line, col = s.barrier.col },
		match = s.match and { line = s.match.line, col = s.match.col, len = s.match.len } or nil,
		pl = l,
		pc = c,
	}
	isr.highlight(s)
	echo(isr.message(s))
end

isr.restore = function(s, st)
	s.str = st.str
	s.dir = st.dir
	s.failing = st.failing
	s.wrapped = st.wrapped
	s.barrier = { line = st.barrier.line, col = st.barrier.col }
	s.match = st.match and { line = st.match.line, col = st.match.col, len = st.match.len } or nil
	goto_point(st.pl, st.pc)
	sync_region()
	isr.highlight(s)
	echo(isr.message(s))
end

isr.begin = function(dir)
	local l, c = point()
	local s = {
		str = "",
		dir = dir,
		origin = { line = l, col = c },
		barrier = { line = l, col = c },
		match = nil,
		failing = false,
		wrapped = false,
		stack = {},
	}
	state.isearch = s
	isr.update(s)
end

-- A typed character. `isearch-search-and-update` only searches while the search
-- is SUCCEEDING -- once it fails, further characters pile onto the string
-- without moving point, which is what makes C-g's first stage ("drop the failed
-- characters") meaningful.
isr.add_char = function(s, ch)
	s.str = s.str .. ch
	if s.failing then
		isr.update(s)
		return
	end
	if s.dir > 0 then
		-- Forward: the longer match may still start where this one does, so the
		-- search resumes from the START of the current match.
		local bl, bc = point()
		if s.match then
			bl, bc = s.match.line, s.match.col
		end
		isr.apply(s, isr.locate(s, bl, bc))
		isr.update(s)
		return
	end

	-- Backward: adding a character extends the match to the RIGHT, so a match
	-- that still starts where this one does is kept in place and point does not
	-- move -- provided it does not reach past the search origin or the barrier.
	local fold = isr.fold_case(s.str)
	local needle = isr.fold_runes(runes_of(s.str), fold)
	if s.match then
		local hay = isr.fold_runes(line_runes(s.match.line), fold)
		local limit = isr.min_pos(s.origin, s.barrier)
		local endc = s.match.col + #needle
		if
			isr.match_at(hay, needle, s.match.col)
			and not isr.pos_before(limit.line, limit.col, s.match.line, endc)
		then
			s.match.len = #needle
			s.failing = false
			isr.update(s)
			return
		end
		local base = isr.min_pos(limit, { line = s.match.line, col = s.match.col + s.match.len + 1 })
		isr.apply(s, isr.locate(s, base.line, base.col))
	else
		local bl, bc = point()
		isr.apply(s, isr.locate(s, bl, bc))
	end
	isr.update(s)
end

-- C-s / C-r with a search already running: repeat, wrap, or turn around.
isr.repeat_search = function(s, dir)
	local bl, bc = point()
	if s.dir ~= dir then
		-- Changing direction does not search anywhere new: it flips the
		-- direction and searches again from point, which lands on the SAME match
		-- from its other end (isearch-repeat sets isearch-success t and leaves
		-- the wrapped flag alone).
		s.dir = dir
		s.failing = false
	elseif s.str == "" then
		-- An empty search string reuses the last one, and then searches for it
		-- from point. With no previous string Emacs reports an error and stays
		-- put; there is nothing else it could do.
		if not state.isearch_last or state.isearch_last == "" then
			isr.update(s)
			return
		end
		s.str = state.isearch_last
	elseif s.failing then
		-- Repeating a failing search wraps to the far end of the buffer and
		-- searches from there. If THAT fails too, point stays where it was.
		s.wrapped = true
		if dir > 0 then
			bl, bc = 1, 1
		else
			bl = line_count()
			bc = line_len(bl) + 1
		end
	end

	s.barrier = { line = bl, col = bc }
	if s.str == "" then
		s.failing = false
	else
		isr.apply(s, isr.locate(s, bl, bc))
	end
	isr.update(s)
end

-- DEL: undo the last isearch command. The floor state (pushed when the search
-- started) is never popped -- Emacs just dings there.
isr.del = function(s)
	if #s.stack <= 1 then
		return
	end
	table.remove(s.stack)
	isr.restore(s, s.stack[#s.stack])
end

-- Leaving the search. `abort` is C-g's second stage: point goes back to where
-- the search started and the string is not remembered.
--
-- Otherwise, and this is `isearch-done`: a search that MOVED point pushes the
-- mark where it started, so C-x C-x jumps back -- but not when a region is
-- already live, because pushing would move the mark out from under it.
isr.finish = function(abort)
	local s = state.isearch
	state.isearch = nil
	editor.clear_search()
	if not abort and s.str ~= "" then
		state.isearch_last = s.str
	end
	if abort then
		goto_point(s.origin.line, s.origin.col)
		sync_region()
		echo("Quit")
		return
	end
	local l, c = point()
	if (l ~= s.origin.line or c ~= s.origin.col) and not state.mark_active then
		push_mark(s.origin.line, s.origin.col, false)
		echo("Mark saved where search started")
	else
		clear_echo()
	end
end

-- C-g, in two stages (isearch-abort). A FAILING search rubs out the characters
-- that made it fail and stays in the search; a succeeding one aborts outright.
isr.quit = function(s)
	if not s.failing then
		isr.finish(true)
		return
	end
	while #s.stack > 1 and s.stack[#s.stack].failing do
		table.remove(s.stack)
	end
	isr.restore(s, s.stack[#s.stack])
end

-- The isearch keymap. Everything else exits and is executed normally.
isr.key = function(tok)
	local s = state.isearch
	if tok == "ctrl-s" then
		isr.repeat_search(s, 1)
	elseif tok == "ctrl-r" then
		isr.repeat_search(s, -1)
	elseif tok == "backspace" then
		isr.del(s)
	elseif tok == "enter" or tok == "esc" then
		isr.finish(false)
	elseif tok == "ctrl-g" then
		isr.quit(s)
	elseif is_char_token(tok) then
		isr.add_char(s, tok)
	else
		-- Not ours: end the search, then let the key run as if it had been typed
		-- outside one. The teardown happens FIRST so this cannot recurse, and the
		-- result is passed through so a key ttt owns still reaches the editor.
		isr.finish(false)
		return dispatch(tok)
	end
	state.last_command = "isearch"
	state.last_kill = false
	render_status()
	return true
end

cmds.isearch_forward = function()
	isr.begin(1)
end

cmds.isearch_backward = function()
	isr.begin(-1)
end

-- ---------------------------------------------------------------------------
-- Section 13: Keymap trie and dispatcher
--
-- THE DISPATCHER IS A TRIE, NOT A MODE MACHINE. Each node is either a command
-- ({ name, run }) or a keymap ({ prefix, map }). A keystroke either descends
-- into a keymap, runs a command, self-inserts, or falls through to the editor.
-- Prefix state is exactly two fields: `state.map` (where we are) and
-- `state.path` (how we got there). Adding C-c or M-g later is one table.
-- ---------------------------------------------------------------------------

local function C(name, fn)
	return { name = name, run = fn }
end

local function P(label, map)
	return { prefix = label, map = map }
end

-- A clearly-marked not-yet-implemented binding. It consumes the key (so the
-- prefix does not leak through to the editor) and says so in the echo area.
local function TODO(name, hint)
	return C(name, function()
		signal(name .. ": not implemented yet" .. (hint and (" -- " .. hint) or ""))
	end)
end

-- Commands after which the region stays highlighted. Everything else
-- deactivates the mark, which also keeps ttt from replacing a live selection
-- when a self-inserting key falls through to the editor.
local REGION_KEEP = {
	["forward-char"] = true,
	["backward-char"] = true,
	["next-line"] = true,
	["previous-line"] = true,
	["move-beginning-of-line"] = true,
	["move-end-of-line"] = true,
	["forward-word"] = true,
	["backward-word"] = true,
	["scroll-up-command"] = true,
	["scroll-down-command"] = true,
	["beginning-of-buffer"] = true,
	["end-of-buffer"] = true,
	["recenter-top-bottom"] = true,
	["set-mark-command"] = true,
	["exchange-point-and-mark"] = true,
	["mark-whole-buffer"] = true,
	-- Starting a search must not disturb a live region: verified against 27.1,
	-- `C-SPC M-f C-s g a RET` leaves the region active with the mark still where
	-- C-SPC put it, and the highlight follows point to the match.
	["isearch-forward"] = true,
	["isearch-backward"] = true,
}

-- Consecutive kills accumulate into one kill-ring entry. There is no table for
-- that: the chain is armed by kill_save() setting state.this_kill, which mirrors
-- kill-region setting `this-command`, and only a kill that really stored
-- something arms it. See Section 9.

-- C-x r ...: rectangles and registers. Present as a keymap so C-x r k does not
-- leak a stray "k" into the buffer while it is unimplemented.
local RECTANGLE_MAP = {
	["k"] = TODO("kill-rectangle"),
	["y"] = TODO("yank-rectangle"),
	["t"] = TODO("string-rectangle"),
	["o"] = TODO("open-rectangle"),
	["d"] = TODO("delete-rectangle"),
	["c"] = TODO("clear-rectangle"),
	["ctrl-space"] = TODO("point-to-register"),
	["j"] = TODO("jump-to-register"),
	["s"] = TODO("copy-to-register"),
	["i"] = TODO("insert-register"),
}

local CTRL_X_MAP = {
	["ctrl-s"] = C("save-buffer", cmds.save_buffer),
	["ctrl-c"] = C("save-buffers-kill-terminal", cmds.quit_editor),
	["ctrl-x"] = C("exchange-point-and-mark", cmds.exchange_point_and_mark),
	["u"] = C("undo", cmds.undo),
	["h"] = C("mark-whole-buffer", cmds.mark_whole_buffer),
	["("] = C("start-kbd-macro", cmds.start_kbd_macro),
	[")"] = C("end-kbd-macro", cmds.end_kbd_macro),
	["e"] = C("call-last-kbd-macro", cmds.call_last_kbd_macro),
	["r"] = P("C-x r", RECTANGLE_MAP),

	-- File and buffer commands hand over to ttt's own overlays. Letting the
	-- overlay take focus is CORRECT here, unlike for isearch: find-file and
	-- switch-to-buffer are completing prompts that own the keyboard in Emacs too,
	-- and Escape dismisses them. It also buys real completion for free, which the
	-- plugin has no API to build. ttt has no buffer list distinct from its file
	-- list, so C-x b lands on the same quick-open overlay as C-x C-f.
	["ctrl-f"] = C("find-file", cmds.find_file),
	["b"] = C("switch-to-buffer", cmds.switch_to_buffer),
	["k"] = C("kill-buffer", cmds.kill_buffer),
	["ctrl-w"] = TODO("write-file", "use File > Save As for now"),
}

local HELP_MAP = {} -- filled in below, once describe_bindings exists

local KEYMAP = {
	-- Movement.
	["ctrl-f"] = C("forward-char", cmds.forward_char),
	["right"] = C("forward-char", cmds.forward_char),
	-- C-b IS CURRENTLY UNREACHABLE. Core binds ctrl+b to sidebar.toggle, which
	-- is in config.ForceKeyCommands, and force keys are checked ABOVE the plugin
	-- key interceptor (internal/ui/root.go, HandleEvent). Verified empirically:
	-- no key.press event arrives at all. The binding is kept so that a core fix,
	-- or rebinding sidebar.toggle to a chord, makes it work with no change here.
	-- <left> is the working equivalent. Same story for C-p, C-t and C-q below.
	["ctrl-b"] = C("backward-char", cmds.backward_char),
	["left"] = C("backward-char", cmds.backward_char),
	["ctrl-n"] = C("next-line", cmds.next_line),
	["down"] = C("next-line", cmds.next_line),
	["ctrl-p"] = C("previous-line", cmds.previous_line), -- BLOCKED: command.palette
	["up"] = C("previous-line", cmds.previous_line),
	["ctrl-a"] = C("move-beginning-of-line", cmds.beginning_of_line),
	["home"] = C("move-beginning-of-line", cmds.beginning_of_line),
	["ctrl-e"] = C("move-end-of-line", cmds.end_of_line),
	["end"] = C("move-end-of-line", cmds.end_of_line),
	["alt-f"] = C("forward-word", cmds.forward_word),
	["alt-b"] = C("backward-word", cmds.backward_word),
	["ctrl-v"] = C("scroll-up-command", cmds.scroll_up),
	["pgdn"] = C("scroll-up-command", cmds.scroll_up),
	["alt-v"] = C("scroll-down-command", cmds.scroll_down),
	["pgup"] = C("scroll-down-command", cmds.scroll_down),
	["alt-<"] = C("beginning-of-buffer", cmds.beginning_of_buffer),
	["alt->"] = C("end-of-buffer", cmds.end_of_buffer),
	["ctrl-l"] = C("recenter-top-bottom", cmds.recenter),

	-- Mark and region.
	["ctrl-space"] = C("set-mark-command", cmds.set_mark),

	-- Editing.
	["ctrl-d"] = C("delete-char", cmds.delete_char),
	-- <delete> is delete-forward-char, which unlike C-d's delete-char honours
	-- delete-active-region.
	["delete"] = C("delete-forward-char", cmds.delete_forward_char),
	-- tcell normalizes KeyBackspace2 (DEL) onto KeyBackspace in newEventKey, so
	-- there is only ever one backspace token to bind.
	["backspace"] = C("delete-backward-char", cmds.delete_backward_char),
	["ctrl-k"] = C("kill-line", cmds.kill_line),
	["ctrl-y"] = C("yank", cmds.yank),
	["alt-y"] = C("yank-pop", cmds.yank_pop),
	["ctrl-w"] = C("kill-region", cmds.kill_region),
	["alt-w"] = C("kill-ring-save", cmds.kill_ring_save),
	["ctrl-t"] = C("transpose-chars", cmds.transpose_chars), -- BLOCKED: terminal.toggle
	["ctrl-o"] = C("open-line", cmds.open_line),
	["alt-d"] = C("kill-word", cmds.kill_word),
	["alt-backspace"] = C("backward-kill-word", cmds.backward_kill_word),
	["alt-u"] = C("upcase-word", cmds.upcase_word),
	["alt-l"] = C("downcase-word", cmds.downcase_word),
	["alt-c"] = C("capitalize-word", cmds.capitalize_word),

	-- Undo. C-/ and C-_ are the same control byte; on terminals that report it
	-- ambiguously it is read as C-SPC instead, so C-x u is the reliable spelling.
	["ctrl-/"] = C("undo", cmds.undo),

	-- Control.
	["ctrl-g"] = C("keyboard-quit", cmds.keyboard_quit),
	["ctrl-q"] = C("quoted-insert", cmds.quoted_insert), -- BLOCKED: editor.quit

	-- Prefixes.
	["ctrl-x"] = P("C-x", CTRL_X_MAP),
	["ctrl-h"] = P("C-h", HELP_MAP),

	-- Search. The live prompt lives in the echo area (Section 12) so that the
	-- plugin keeps receiving keys: C-s C-s repeats, C-g aborts, DEL backtracks.
	-- Once a search is running the dispatcher routes every key to isr.key
	-- BEFORE it reaches this table, so these two entries only ever start one.
	["ctrl-s"] = C("isearch-forward", cmds.isearch_forward),
	["ctrl-r"] = C("isearch-backward", cmds.isearch_backward),
	["alt-%"] = TODO("query-replace", "use Ctrl+R (replace) for now"),
	-- M-x IS the command palette: an overlay with completion over every command,
	-- dismissed with Escape. Same reasoning as C-x C-f above.
	["alt-x"] = C("execute-extended-command", cmds.execute_extended_command),
}

-- describe-bindings walks the trie, so it is defined after it.
local function key_entries()
	local rows = {}
	local function walk(map, prefix)
		for tok, node in pairs(map) do
			local label = (prefix ~= "" and (prefix .. " ") or "") .. key_label(tok)
			if node.map then
				walk(node.map, label)
			else
				rows[#rows + 1] = { key = label, value = node.name }
			end
		end
	end
	walk(KEYMAP, "")
	table.sort(rows, function(a, b)
		if a.value == b.value then
			return a.key < b.key
		end
		return a.value < b.value
	end)
	return rows
end

cmds.describe_bindings = function()
	ttt.show_info("Emacs bindings", key_entries())
end

HELP_MAP["b"] = C("describe-bindings", cmds.describe_bindings)
HELP_MAP["ctrl-h"] = C("describe-bindings", cmds.describe_bindings)

-- Dispatcher ----------------------------------------------------------------

local function reset_pending()
	state.map = nil
	state.path = {}
end

local function arg_reset()
	local a = state.arg
	a.active = false
	a.mult = 4
	a.digits = ""
	a.sign = 1
end

-- Post-command housekeeping, which is Emacs's command loop in three lines.
--
--   * a command that signalled changes nothing else: the region keeps whatever
--     activation it had, and the kill chain is not extended
--   * movement and the mark commands keep the region and re-paint it
--   * everything else deactivates it, which is `deactivate-mark` being set by
--     buffer modification -- and is also what keeps ttt from replacing a live
--     selection when a self-inserting key falls through to the editor
local function finish_command(name)
	if REGION_KEEP[name] then
		-- Movement re-paints the region even when it signalled: C-n at the last
		-- line still drags point to point-max, and the highlight has to follow.
		sync_region()
	elseif not state.failed then
		deactivate_mark()
	end
	state.last_command = name
	-- `this-command` is set by kill-new/kill-append, so only a kill that really
	-- stored something extends the chain.
	state.last_kill = state.this_kill or false
	render_status()
end

local function run_node(node, tok)
	if node.map then
		state.map = node.map
		state.path[#state.path + 1] = tok
		state.echo_msg = nil
		render_status()
		return true
	end

	local n, explicit = arg_value()
	reset_pending()
	arg_reset()
	state.echo_msg = nil
	state.failed = false
	state.this_kill = false

	local ok, err = pcall(node.run, n, explicit)
	if not ok then
		-- Errors thrown inside a key.press listener are swallowed by the host and
		-- the key falls through, which looks exactly like "the plugin ignored my
		-- key". Surface them instead.
		ttt.notify("emacs: " .. tostring(err), "error")
	end
	finish_command(node.name)
	return true
end

-- The single entry point for a canonical token, whether it came from a real
-- keystroke or from a macro replay.
dispatch = function(tok)
	-- An incremental search owns every key while it is running (Section 12),
	-- including the ones this table would otherwise claim. Keys it does not
	-- handle end the search and come straight back here.
	if state.isearch then
		return isr.key(tok)
	end

	-- C-q: the next key goes in literally.
	if state.quoted then
		state.quoted = false
		local text
		if is_char_token(tok) then
			text = tok
		elseif tok == "enter" then
			text = "\n"
		elseif tok == "tab" then
			text = "\t"
		end
		if text then
			local l, c = point()
			edit(function()
				local el, ec = insert_text(l, c, text)
				goto_point(el, ec)
			end)
		end
		finish_command("quoted-insert")
		return true
	end

	-- Inside a prefix, every key belongs to the prefix -- including digits, which
	-- is why the universal argument is only read at the top level.
	if state.map then
		local node = state.map[tok]
		if node == nil then
			local label = path_label() .. " " .. key_label(tok)
			reset_pending()
			arg_reset()
			signal(label .. " is undefined")
			return true
		end
		return run_node(node, tok)
	end

	-- Universal argument: C-u, C-u C-u, C-u 12, C-u -, M-5.
	local a = state.arg
	if tok == "ctrl-u" then
		if a.active and a.digits == "" then
			a.mult = a.mult * 4
		else
			a.active = true
			a.mult = 4
			a.digits = ""
			a.sign = 1
		end
		render_status()
		return true
	end
	local mdigit = tok:match("^alt%-(%d)$")
	if mdigit or tok == "alt--" then
		a.active = true
		if mdigit then
			a.digits = a.digits .. mdigit
		else
			a.sign = -1
		end
		render_status()
		return true
	end
	if a.active and tok:match("^%d$") then
		a.digits = a.digits .. tok
		render_status()
		return true
	end
	if a.active and tok == "-" and a.digits == "" then
		a.sign = -1
		render_status()
		return true
	end

	-- C-x e, then a bare `e` for each repeat, as Emacs does.
	if tok == "e" and state.last_command == "call-last-kbd-macro" then
		local n = (arg_value())
		arg_reset()
		state.echo_msg = nil
		play_macro(n)
		finish_command("call-last-kbd-macro")
		return true
	end

	local node = KEYMAP[tok]
	if node then
		return run_node(node, tok)
	end

	-- Self-insert. With no prefix argument the key is passed through so ttt's own
	-- typing path (auto-indent, bracket matching, undo coalescing) runs; only a
	-- repeat count has to be done here.
	if is_char_token(tok) then
		local n, explicit = arg_value()
		arg_reset()
		-- Same as run_node: the next command clears the echo area. Without this a
		-- message ("Mark saved where search started") survives arbitrary typing,
		-- because self-insert does not go through run_node.
		state.echo_msg = nil
		if explicit and n > 1 then
			local l, c = point()
			edit(function()
				local el, ec = insert_text(l, c, string.rep(tok, n))
				goto_point(el, ec)
			end)
			finish_command("self-insert-command")
			return true
		end
		deactivate_mark()
		state.last_command = "self-insert-command"
		state.last_kill = false
		render_status()
		return false
	end

	-- Not ours: arrows with modifiers, ctrl+s, chords, Esc. Pass-through
	-- discipline matters -- the interceptor sits above Escape handling and every
	-- core binding, so swallowing a key here silently breaks it globally.
	arg_reset()
	deactivate_mark()
	state.last_command = nil
	state.last_kill = false
	state.echo_msg = nil
	render_status()
	return false
end

local function on_key(ev)
	if not state.enabled then
		return false
	end

	local tok = token_of(ev)
	local was_recording = state.macro.recording

	local ok, handled = pcall(dispatch, tok)
	if not ok then
		ttt.notify("emacs: " .. tostring(handled), "error")
		reset_pending()
		arg_reset()
		render_status()
		return true
	end

	if was_recording and state.macro.recording and state.macro.playing == 0 then
		local keys = state.macro.keys
		keys[#keys + 1] = tok
	end

	return handled and true or false
end

-- ---------------------------------------------------------------------------
-- Section 14: Registration and deferred startup
-- ---------------------------------------------------------------------------

local function enable()
	state.enabled = true
	reset_pending()
	arg_reset()
	clear_echo()
	render_status()
end

local function disable()
	state.enabled = false
	-- Turning the plugin off mid-search would otherwise leave the prompt and the
	-- match highlight on screen with nothing left to dismiss them.
	if state.isearch then
		isr.finish(true)
	end
	deactivate_mark()
	render_status()
end

local function toggle()
	if state.enabled then
		disable()
	else
		enable()
	end
end

ttt.register({
	commands = {
		{ id = "emacs.toggle", title = "Emacs: Toggle Emacs Mode", handler = toggle },
		{ id = "emacs.enable", title = "Emacs: Enable Emacs Mode", handler = enable },
		{ id = "emacs.disable", title = "Emacs: Disable Emacs Mode", handler = disable },
		{ id = "emacs.describeBindings", title = "Emacs: Describe Bindings", handler = cmds.describe_bindings },
	},
})

events.on("key.press", on_key)

-- Deferred startup: LoadAll calls Init before the host wires the settings and
-- status-bar APIs, so ttt.settings and ttt.set_status_item are both nil while
-- this file is executing. Everything that touches them is delayed by a tick.
-- get_setting lives inside the closure so it consumes no top-level local (Lua
-- 5.1 caps a function at 200). Reads are defensive: a denied key raises a Lua
-- error, so each call is pcall'd and falls back to the default.
ttt.set_timeout(0, function()
	local function get_setting(key, default)
		local ok, mod = pcall(require, "ttt.settings")
		if not ok or type(mod) ~= "table" or type(mod.get) ~= "function" then
			return default
		end
		local ok2, val = pcall(mod.get, key)
		if not ok2 or val == nil then
			return default
		end
		return val
	end

	if not get_setting("emacs.enabled", true) then
		state.enabled = false
	end
	state.clipboard = get_setting("emacs.clipboard", false) and true or false

	-- Emacs places the cursor at the start of restored text after undo.
	local ok, mod = pcall(require, "ttt.settings")
	if ok and type(mod) == "table" and type(mod.set) == "function" then
		pcall(mod.set, "editor.undoDeleteCursorStart", true)
	end

	render_status()
end)
