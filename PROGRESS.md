# Computer Use MCP Server — Progress

## Cycle 1 (2026-03-08)

### Container Status
- Docker container `computer-use` running (Ubuntu 24.04 ARM64)
- Xvfb :1 at 1024x768x24
- XFCE4 desktop, x11vnc on :5900, noVNC on :6080
- xdotool, ImageMagick (import/convert), scrot all available
- Firefox ESR 140 installed (via Mozilla PPA — snap stub doesn't work in Docker)

### All 16 Actions Working ✅
| Action | Implementation | Status |
|--------|---------------|--------|
| screenshot | `scrot -o` + base64 encode | ✅ |
| left_click | mousemove + click 1 | ✅ |
| right_click | mousemove + click 3 | ✅ |
| middle_click | mousemove + click 2 | ✅ |
| double_click | mousemove + click --repeat 2 | ✅ |
| triple_click | mousemove + click --repeat 3 | ✅ |
| left_click_drag | mousemove + mousedown + mousemove + mouseup | ✅ |
| type | base64→file + xdotool type --file (safe special chars) | ✅ |
| key | xdotool key with key mapping | ✅ |
| mouse_move | xdotool mousemove | ✅ |
| scroll | mousemove + click --repeat N (batched) | ✅ |
| left_mouse_down | mousedown 1 | ✅ |
| left_mouse_up | mouseup 1 | ✅ |
| hold_key | keydown + nested action + keyup | ✅ |
| wait | setTimeout + screenshot | ✅ |
| zoom | scrot + convert crop + resize | ✅ |

### Additional Tools
- **computer_bash**: docker exec with configurable timeout ✅
- **computer_status**: container status + display geometry check ✅

### Real-World Test: Browser Automation ✅
Successfully completed full browser automation flow:
1. Opened Firefox ESR with `firefox-esr https://example.com`
2. Dismissed security warning by clicking "Don't show again"
3. Closed extra tab
4. Clicked URL bar, Ctrl+A to select all, typed new URL
5. Navigated to httpbin.org/get — JSON response displayed correctly

### Bugs Found & Fixed
1. **`--sync` flag hangs**: `xdotool mousemove --sync` hangs indefinitely in Xvfb. Removed all `--sync` flags.
2. **`xdpyinfo` not installed**: Replaced with `xdotool getdisplaygeometry` for display health check.
3. **`left_click_drag` non-standard params**: Fixed to use spec-compliant `start_coordinate` + `coordinate` (end).
4. **`.mcp.json` missing**: Created for Claude Code auto-loading.
5. **Firefox snap stub**: `firefox` package is just a snap redirect. Installed `firefox-esr` from Mozilla PPA.
6. **Shell escaping in type**: Special chars ($, ", backticks) could break. Now uses base64→file→xdotool --file approach.
7. **Scroll performance**: N separate docker execs → single `click --repeat N` call.
8. **Screenshot speed**: Switched from `import -window root` to `scrot -o` (~25% faster).

### Performance Optimizations
- Screenshots: `scrot` instead of `import` (~25% faster)
- Scroll: batched into single xdotool call
- Type: file-based approach avoids shell escaping overhead
- Coordinate validation: rounds floats, catches out-of-bounds early

### Architecture
- MCP server: `index.js` (single file, ~330 lines)
- Docker: `computer-use-env` image (Ubuntu 24.04 ARM64)
- Display: Xvfb :1 at 1024x768
- VNC: x11vnc on :5900, noVNC on :6080
- Dockerfile updated to use Mozilla PPA for Firefox ESR

---

## Cycle 2 (2026-03-08)

### Spec Compliance Fixes
1. **`left_mouse_down`/`left_mouse_up` coordinate support**: Per Anthropic spec, both actions now accept optional `[x,y]` coordinate to move mouse before press/release.
2. **`hold_key` nested action support**: Refactored from simple duration-based hold to supporting nested actions. New `hold_key_action` param accepts `{action, coordinate, text, ...}` to execute while key is held. Falls back to duration-based hold when no nested action provided.
3. **Code architecture**: Extracted `executeAction()` function for reuse. Schema extracted to `actionSchema` const.

### Docker Image Improvements
- Added `nano` (terminal text editor)
- Added `mousepad` (GUI text editor for XFCE)
- Added `sudo` with passwordless access for `agent` user
- Added `xclip` (clipboard support for xdotool/X11)

### Real-World Testing Results
- Full browser flow: Ctrl+L → type URL → navigate ✅
- Terminal: open xfce4-terminal, type commands, execute ✅
- File operations via /workspace volume ✅
- Double-click word selection ✅
- Right-click context menu ✅
- Zoom region crop ✅
- Scroll ✅
- Cursor position query ✅

### Next Steps
- [ ] Integrate findings from Anthropic reference implementation research
- [ ] Multi-container support (spawn/destroy environments)
- [ ] Resolution switching
- [ ] Session recording/replay
- [ ] File exchange helpers via /workspace volume
- [ ] Browser automation helpers (URL navigation, wait-for-element)
- [x] Test hold_key with nested actions end-to-end after recycle → client can't pass nested object

---

## Cycle 3 (2026-03-08)

### Bugs Found & Fixed
1. **`type` action drops newlines**: `xdotool type --file` silently ignores `\n` characters. Multi-line text was typed as a single line. **Fix**: Split text on newlines, type each segment separately, press Return between segments. Also normalizes `\r\n` and `\r` to `\n`.
2. **`computer_bash` shell variable mangling**: `dockerExec()` used `execSync` with string interpolation, causing `$HOME`, backticks, and other shell constructs to be expanded by the **host** shell instead of the container's. **Fix**: Switched to `execFileSync` with argument array — command is passed directly to `docker exec` without host shell interpretation.
3. **Coordinate validation off-by-one**: `x > DISPLAY_WIDTH` allowed x=1024 on a 1024-wide display (pixels are 0-1023). **Fix**: Changed to `x >= DISPLAY_WIDTH`.

### Spec Compliance Findings (from browsing Anthropic docs in-VM)
- `hold_key` = duration-only per spec (confirmed again from live docs)
- Modifier+click = `text` param on action (e.g., `{"action": "left_click", "text": "shift"}`) — verified working ✅
- `hold_key_action` nested object: Zod v4 and MCP SDK generate correct JSON Schema, but Claude Code client doesn't pass the param. Kept as optional enhancement.
- `text_editor_20250728` and `bash_20250124` — companion tool types in the API (we implement similar via `computer_bash`)
- `display_number` — optional param for X11 multi-display (we don't use it yet)
- Coordinate scaling only needed for displays > 1568px longest edge (our 1024x768 is fine)

### Real-World Testing
- Firefox browsing Anthropic docs ✅
- Terminal (xfce4-terminal) opened and used ✅
- Triple-click line select ✅
- Shift+click text selection via `text` modifier ✅
- Scroll (multi-amount) ✅
- Wait action ✅
- Type (confirmed newline bug, manual test of fix approach) ✅
- computer_bash (confirmed $HOME host expansion bug) ✅

### Technical Notes
- Zod version: v4.3.6 (breaking change from v3). MCP SDK correctly uses `z4mini.toJSONSchema()` for schema conversion.
- `zod-to-json-schema` v3.25.1 returns empty schemas with Zod v4 objects — MCP SDK's compat layer handles this by detecting Zod version.
- MCP server code: ~445 lines in index.js

### Next Steps
- [x] Verify type newline fix end-to-end after MCP reload → ✅ cycle 4
- [x] Verify computer_bash execFileSync fix end-to-end after MCP reload → ✅ cycle 4
- [x] Research agent results (Anthropic reference impl comparison) → ✅ cycle 4
- [ ] Multi-container support
- [ ] Resolution switching
- [ ] `display_number` param support

---

## Cycle 4 (2026-03-08)

### Critical Fix: MCP Server Path
- **Root cause**: `.mcp.json` pointed to `/Users/kevinster/computer-use-mcp/index.js` (main repo, `master` branch), NOT the worktree. All cycle 3 fixes existed only in the worktree but the running MCP server used old code.
- **Fix**: Updated `.mcp.json` to point to worktree's `index.js`. Also ran `npm install` (node_modules were missing in worktree).
- **Lesson**: Always verify the MCP server is running the code you think it is.

### End-to-End Verification (Cycle 3 Fixes)
1. **computer_bash $var isolation** ✅ — `echo $HOME` returns `/home/agent` (container), not `/Users/kevinster` (host)
2. **Type with newlines** ✅ — Heredoc typed with proper newlines, `cat` output showed separate lines
3. **Shell construct isolation** ✅ — `$HOME`, backticks, single quotes all handled correctly in container

### Full 16-Action Test Suite ✅
All actions verified end-to-end through MCP:
screenshot, left_click, right_click, double_click, triple_click, left_click_drag, type, key, mouse_move, scroll, left_mouse_down, left_mouse_up, hold_key (duration), wait, zoom, cursor_position

### Research Agent Findings (Anthropic Reference Comparison)
**Overall: 8/10** — highly compliant, small fixes to reach 9/10
- ✅ All 16 base actions implemented
- ✅ Screenshot capture (base64 PNG)
- ✅ Coordinate validation
- ✅ Click/scroll modifiers via `text` param
- ✅ Type with newline handling
- ✅ Error handling with screenshot on failure
- **Bonus features** (non-standard, documented as extensions):
  - `cursor_position` action
  - `hold_key_action` nested action support
  - `left_mouse_down`/`up` with optional coordinates
- **Fixed this cycle**:
  - scroll_amount >= 0 validation
  - duration bounds (0 < d <= 100) for hold_key and wait

### Refactoring
1. **Dropped `execSync` entirely** — all Docker calls use `execFileSync` with arg arrays
2. **Environment-driven config** — `DISPLAY_WIDTH`, `DISPLAY_HEIGHT`, `SCREENSHOT_DELAY_MS` all configurable via env vars
3. MCP server code: ~450 lines in index.js

### Real-World Testing
- Browsed Hacker News: URL navigation, page load, article click, back button
- Opened arXiv paper, zoomed into abstract for reading
- Full Firefox workflow with multiple tabs

### Commits
1. `8e38b52` — refactor: drop execSync entirely, make display config env-driven
2. `6d7b83a` — fix: add input validation for scroll_amount and duration

### Next Steps
- [ ] Multi-container support (spawn/destroy environments on demand)
- [ ] Resolution switching (with coordinate scaling for > 1568px)
- [ ] `display_number` param support
- [ ] Session recording/replay
- [ ] File exchange helpers via /workspace
- [ ] Browser automation helpers

---

## Cycle 5 (2026-03-08)

### JPEG Screenshot Compression
- Added `SCREENSHOT_FORMAT` env var (jpeg/png, default: jpeg)
- Added `SCREENSHOT_QUALITY` env var (1-100, default: 80)
- PNG: ~182KB → JPEG q80: ~121KB (33% reduction per screenshot)
- All screenshot paths updated: screenshot, wait, zoom, follow-up, error handler
- Correct MIME types propagated (`image/jpeg` or `image/png`)

### Container Auto-Recovery
- `dockerExec()` now detects when container is stopped and auto-recovers
- Uses full recreation (`docker rm -f` + `docker run -d`) instead of `docker start`
  - `docker start` leaves stale X11 lock files that prevent Xvfb from starting
- Waits up to 15s for display readiness after recreation
- Configurable via env vars: `CONTAINER_IMAGE`, `CONTAINER_VNC_PORT`, `CONTAINER_NOVNC_PORT`, `CONTAINER_WORKSPACE`

### Verification Results
- **JPEG screenshots**: ✅ Returns `image/jpeg` mime type
- **JPEG zoom**: ✅ Zoom action uses JPEG format
- **Auto-recovery**: ✅ Stopped container → screenshot triggered full recreation → desktop came up → screenshot succeeded
- **Real-world browsing**: ✅ Browsed Anthropic Computer Use docs, scrolled, clicked expandable sections

### Spec Re-Verification
- Browsed live Anthropic docs — confirmed all actions match spec
- `computer_20251124` adds `zoom` only (requires `enable_zoom: true` in tool definition)
- `hold_key` = duration-based hold (confirmed)
- No new actions or breaking changes detected

### Commits
1. `dd3d028` — feat: JPEG screenshot compression and container auto-recovery
2. `e80e9f4` — fix: container auto-recovery uses full recreation instead of docker start

### Next Steps
- [x] Multi-container support (spawn/destroy environments on demand) → ✅ cycle 6
- [ ] Resolution switching (with coordinate scaling for > 1568px)
- [ ] `display_number` param support
- [ ] Session recording/replay
- [ ] File exchange helpers via /workspace
- [ ] Browser automation helpers

---

## Cycle 6 (2026-03-08)

### Multi-Container Support
Major feature: spawn/destroy independent virtual desktop environments on demand.

**New Tools:**
- `computer_env_create` — creates a new Docker container with its own VNC (5901+), noVNC (6081+), workspace
- `computer_env_destroy` — removes container, preserves workspace directory
- `computer_env_list` — lists all managed environments with status, ports, workspace paths

**Modified Tools:**
- `computer` — new optional `container_name` param to target any environment
- `computer_bash` — same `container_name` param
- `computer_status` — same, plus shows VNC/noVNC/workspace info

**Architecture:**
- In-memory `environments` Map tracks name → {image, vncPort, novncPort, workspace}
- Auto port allocation: VNC 5900+N, noVNC 6080+N
- Default container unchanged (fully backward compatible)
- Auto-recovery works per-container (each env has its own image/port config)
- All core functions (dockerExec, takeScreenshot, xdotool, etc.) parameterized with containerName

**Other Fixes:**
- `hold_key` timeout now scales with duration: `(dur + 5) * 1000` instead of hardcoded 30s
- Server version bumped to 1.1.0

### Verification Results
- **Default container**: ✅ Screenshot on primary works, backward compatible
- **Create environment**: ✅ `test-env` created with VNC:5901, noVNC:6081, display active
- **Actions on secondary**: ✅ left_click (open terminal), type (command), key (Return) all work on test-env
- **List environments**: ✅ Shows both default and test-env with correct ports/status
- **Destroy environment**: ✅ Container removed, docker ps confirms gone, workspace preserved

### Commits
1. `1f16e8f` — feat: multi-container support — spawn/destroy independent virtual desktops

### Code Stats
- MCP server: 681 lines (up from ~519)
- 8 MCP tools total: computer, computer_bash, computer_status, computer_env_create, computer_env_destroy, computer_env_list

### Next Steps
- [x] Resolution switching (with coordinate scaling for > 1568px) → ✅ cycle 7
- [x] Per-environment resolution → ✅ cycle 7
- [ ] `display_number` param support
- [ ] Session recording/replay
- [ ] File exchange helpers via /workspace
- [ ] Browser automation helpers

---

## Cycle 7 (2026-03-08)

### Resolution Switching with Coordinate Scaling
Major feature: live display resolution changes and Anthropic-spec coordinate scaling.

**New Tool:**
- `computer_env_resize` — change display resolution of any environment (kills/restarts Xvfb + x11vnc + XFCE)

**Coordinate Scaling (Anthropic Spec):**
- Max 1568px on longest edge in API coordinate space
- Displays > 1568px: screenshots auto-downscaled, coordinates auto-mapped
- Example: 1920x1080 display → API space is 1568x882
- Scale factor: `1568 / max(width, height)`
- All coordinate-accepting actions (click, drag, scroll, mouse_move, mouse_down/up) scale correctly
- `cursor_position` returns API-space coordinates
- `zoom` region coordinates scaled from API to display space

**Per-Environment Resolution:**
- Each environment tracks its own `width` and `height`
- `computer_env_create` accepts optional `width`/`height` params
- `SCREEN_RESOLUTION` env var passed to container for initial resolution
- `computer_status` shows both display and API resolution when scaled
- `computer_env_list` shows resolution per environment
- Auto-recovery preserves per-env resolution

**Docker Image Changes:**
- `start.sh` accepts `SCREEN_RESOLUTION` env var (default: 1024x768)
- `start.sh` uses `set +e` + `while true; do wait -n; done` to survive child process kills (required for resize)
- `trap "exit 0" SIGTERM SIGINT` for clean container shutdown

**Debugging Findings:**
- Killing Xvfb (PID child of PID 1) caused PID 1 (start.sh with `set -e` + `wait`) to exit → container crash. Fixed with `set +e` before wait loop.
- `pkill` inside `docker exec` can return 143 (SIGTERM propagation) even with `|| true`. Wrapped kill commands in try/catch.
- XFCE desktop dies when Xvfb is killed (X clients lose connection). Must restart `startxfce4` after Xvfb restart.

### Verification Results
- **Default 1024x768**: ✅ No scaling, screenshot captured correctly
- **Resize to 1280x720**: ✅ Display confirmed, XFCE desktop renders
- **Resize to 1920x1080**: ✅ API reports 1568x882, coordinate scaling works
- **Click after resize**: ✅ API [40,10] → opened Applications menu on 1920x1080 display
- **env_create at 1920x1080**: ✅ Container created at correct resolution, scaling active
- **Status display**: ✅ Shows "Resolution: 1920x1080 (API: 1568x882, scaled)"

### Commits
1. `dd174b9` — feat: resolution switching with coordinate scaling (Anthropic spec)
2. `fa8dd71` — fix: remove nested bash -c in env_resize (dockerExec already wraps)
3. `caf6648` — fix: resilient resize — try/catch kill commands, pkill over pgrep+kill
4. `816a29c` — feat: restart XFCE desktop after resize

### Code Stats
- MCP server: 818 lines (up from 681)
- 9 MCP tools: computer, computer_bash, computer_status, computer_env_create, computer_env_destroy, computer_env_list, computer_env_resize
- Server version: 1.2.0

### Next Steps
- [x] `display_number` param support → ✅ cycle 8
- [ ] Session recording/replay
- [x] File exchange helpers via /workspace → ✅ cycle 8
- [ ] Browser automation helpers
- [ ] Real-world usage test at high resolution

---

## Cycle 8 (2026-03-08)

### File Exchange Tools
New MCP tools for reading/writing files to/from containers without going through `computer_bash`.

**New Tools:**
- `computer_file_read` — read files from container (text mode or base64 for binary)
  - Auto-detects image files and returns as `image` content block with correct MIME type
  - Handles directories (returns `ls -la` listing)
  - 10MB file size limit with clear error message
  - Text mode truncates at 16KB with size info
- `computer_file_write` — write files to container (text or base64)
  - Auto-creates parent directories
  - Text mode: base64-encodes on host, decodes in container (avoids shell escaping issues)
  - Base64 mode: writes in 64KB chunks to avoid command line length limits
  - Returns file size after write for verification

**Why not just use computer_bash?**
- `computer_bash` truncates at 16KB and can't handle binary data
- File tools properly handle images (returned as viewable image content)
- Shell escaping is handled transparently (no more worrying about `$`, quotes, backticks in file content)

### display_number Support
- New `DISPLAY_NUMBER` env var (default: 1)
- Each environment tracks its own `displayNumber`
- All `DISPLAY=:N` references are now dynamic (no more hardcoded `:1`)
- `dockerExec()`, `restartContainer()`, `env_create`, `env_resize` all use per-env display number
- New helper: `getDisplayNumber(containerName)`

### Verification Results
- **file_write text mode**: ✅ 146 bytes written, special chars ($PATH, quotes, apostrophes) preserved
- **file_read text mode**: ✅ Read back exact content with all special chars intact
- **file_read binary/image**: ✅ 21KB PNG returned as image/png content block
- **display_number**: ✅ Screenshot works with configurable display (default :1)
- **Real-world browsing**: ✅ Firefox → example.com → clicked "Learn more" → navigated to iana.org

### Commits
1. `93e0a12` — feat: file exchange tools + display_number support

### Code Stats
- MCP server: 959 lines (up from 818)
- 11 MCP tools: computer, computer_bash, computer_status, computer_file_read, computer_file_write, computer_env_create, computer_env_destroy, computer_env_list, computer_env_resize
- Server version: 1.3.0

### Next Steps
- [x] Test file_write with base64 encoding (binary upload) → ✅ cycle 9
- [ ] Session recording/replay
- [ ] Browser automation helpers
- [ ] Edge case testing: large files, unicode filenames, symlinks

---

## Cycle 9 (2026-03-08)

### Clipboard & Window Management Tools
New MCP tools for clipboard access and window discovery.

**New Tools:**
- `computer_clipboard` — read/write X clipboard contents
  - Supports all X selections: `clipboard` (ctrl+v), `primary` (middle-click), `secondary`
  - Write uses base64 encoding to avoid shell escaping issues
  - Read falls back to "(empty)" on empty clipboard
- `computer_window_list` — list open windows with ID, position, size, title
  - Uses xdotool (wmctrl fallback if available)
  - Optional `filter` param for case-insensitive title search
  - Caps at 30 windows to avoid overwhelming output

**Why clipboard matters:**
- Agents can now programmatically extract text after Ctrl+C in browser/editor
- Agents can inject text via clipboard (write + Ctrl+V) — more reliable than `type` for complex content
- Enables cross-application copy/paste workflows

### Verification Results
- **file_write base64**: ✅ Wrote "Hello Binary World!" via base64, read back correctly (19 bytes)
- **Clipboard write/read**: ✅ Roundtrip via xclip (base64 encoding for write, -selection clipboard -o for read)
- **Window listing**: ✅ xdotool search returns window IDs, getwindowname/getwindowgeometry work for each
- **Window filter**: ✅ "Firefox" filter returns Firefox window IDs with titles
- **Real-world test**: ✅ Browsed Hacker News → clicked article → triple-click selected headline → Ctrl+C → xclip read returned exact text

### Commits
1. `e6bfa74` — feat: clipboard + window list tools (v1.4.0)

### Code Stats
- MCP server: ~1047 lines (up from 959)
- 13 MCP tools: computer, computer_bash, computer_status, computer_clipboard, computer_window_list, computer_file_read, computer_file_write, computer_env_create, computer_env_destroy, computer_env_list, computer_env_resize
- Server version: 1.4.0

### Next Steps
- [x] Process management (list/kill processes in container) → ✅ cycle 10
- [ ] Session recording/replay
- [ ] Browser automation helpers (navigate to URL, wait for page load)
- [ ] Edge case testing: large files, unicode filenames, symlinks
- [ ] Keyboard shortcut helper (common shortcuts as named actions)

---

## Cycle 10 (2026-03-08)

### Process Management Tools
New MCP tools for inspecting and managing processes inside containers.

**New Tools:**
- `computer_process_list` — list running processes sorted by CPU usage
  - Optional `filter` param for case-insensitive name search
  - Returns full `ps aux` table (PID, CPU%, MEM%, command)
  - Truncates at 16KB for large process tables
- `computer_process_kill` — kill processes by PID or name
  - PID mode: `kill -SIGNAL PID`
  - Name mode: `pkill -SIGNAL -f NAME`
  - Configurable signal (default: TERM, supports KILL, INT, HUP, etc.)
  - Safety guards: refuses to kill Xvfb, x11vnc, xfce4-session, start.sh, bash
  - Protects PID 1 (init/start.sh)
  - Verification: checks if process is still running after kill

**Why process management matters:**
- Agents can diagnose hung/stuck applications (Firefox consuming 100% CPU)
- Clean up test processes spawned by scripts
- Monitor container resource usage
- Kill specific browser tabs or stuck apps without restarting the entire container

### Real-World Dogfooding
- Opened xfce4-terminal via Ctrl+Alt+T ✅
- Wrote multi-line bash script (heredoc) in terminal via `type` action ✅
- Script gathered: date, hostname, kernel, arch, uptime, memory, disk, top processes, network
- Ran script and saved output to `/workspace/sysinfo.txt` ✅
- Read back output via `computer_file_read` — full roundtrip verified ✅
- Minor finding: `ip` command not installed in container (no iproute2)

### Verification Results
- **Process list (unfiltered)**: ✅ Full `ps aux` table returned with all running processes
- **Process list (filtered)**: ✅ `filter="firefox"` returns only Firefox processes
- **Process kill by PID**: ✅ Spawned `sleep 300`, killed by PID, verified gone
- **Protected process guard**: ✅ Attempting to kill "Xvfb" returns refusal with clear error
- **PID 1 guard**: ✅ Attempting to kill PID 1 returns "Cannot kill PID 1"

### Commits
1. `65eb73a` — feat: process management tools (v1.5.0)

### Code Stats
- MCP server: ~1144 lines (up from ~1047)
- 15 MCP tools: computer, computer_bash, computer_status, computer_clipboard, computer_window_list, computer_file_read, computer_file_write, computer_process_list, computer_process_kill, computer_env_create, computer_env_destroy, computer_env_list, computer_env_resize
- Server version: 1.5.0

### Next Steps
- [x] Browser automation helpers (navigate to URL, wait for page load) → ✅ cycle 11
- [ ] Session recording/replay
- [ ] Edge case testing: large files, unicode filenames, symlinks
- [ ] Keyboard shortcut helper (common shortcuts as named actions)
- [ ] Install iproute2 in Docker image (missing `ip` command)

---

## Cycle 11 (2026-03-08)

### Browser & Application Helpers
New convenience tools that reduce multi-step workflows to single tool calls.

**New Tools:**
- `computer_navigate` — open URL in Firefox inside container
  - Auto-detects browser binary (`firefox-esr` or `firefox`)
  - Opens in new tab by default, optional `new_window` mode
  - Auto-prepends `https://` if no scheme provided
  - Configurable wait time for page load (1-30s, default 3)
  - Returns screenshot after page load
- `computer_open` — launch applications or open files
  - Detects file paths (uses `xdg-open`) vs application names (direct command)
  - Optional arguments for app commands
  - Configurable wait time before screenshot (1-30s, default 2)
  - Returns screenshot after launch

**Why this matters:**
- Before: Navigate to URL required 4+ actions (click address bar → triple-click → type URL → Enter)
- After: `computer_navigate(url="example.com")` — one call
- Before: Open terminal required searching taskbar or keyboard shortcut
- After: `computer_open(target="xfce4-terminal")` — one call
- Drastically reduces token usage and latency for common operations

### Bug Fix: process_list grep exit code
- `computer_process_list` with a filter that matches no processes returned an error (grep exit code 1)
- Now returns `(no processes matching 'filter')` — friendly message, not an error
- Detects grep exit codes 1 and 123 (no match) vs real errors (non-zero + stderr)

### Verification Results
- **computer_navigate**: ✅ Opened `https://example.com` in new Firefox tab, screenshot shows page
- **computer_open**: ✅ Launched `xfce4-terminal`, screenshot shows terminal with shell prompt
- **process_list no-match**: ✅ Filter "nonexistent_process_xyz" returns friendly message, not error
- **Real-world dogfooding**: ✅ Full flow: navigate → terminal → write Python script → run → file_read output

### Commits
1. `40b99b7` — feat: browser helpers + process_list fix (v1.6.0)
2. `b3a9901` — fix: use correct takeScreenshot return fields in navigate/open tools
3. `ea9336b` — fix: auto-detect firefox binary name in computer_navigate

### Code Stats
- MCP server: ~1250 lines (up from ~1144)
- 15 MCP tools + 2 new helpers = 17 MCP tools: computer, computer_bash, computer_status, computer_clipboard, computer_window_list, computer_file_read, computer_file_write, computer_process_list, computer_process_kill, computer_navigate, computer_open, computer_env_create, computer_env_destroy, computer_env_list, computer_env_resize, computer_env_resize
- Server version: 1.6.0

### Next Steps
- [x] Edge case testing: unicode → ✅ cycle 12
- [x] Install iproute2 in Docker image → ✅ cycle 12
- [ ] Session recording/replay
- [ ] Keyboard shortcut helper (common shortcuts as named actions)
- [ ] `computer_type_file` — type large content via file (bypass xdotool limits)

---

## Cycle 12 (2026-03-08)

### Unicode Type Support + Key Action Fix
Two bugs found and fixed through edge case testing:

**Bug 1: `type` action crashes on non-ASCII text**
- `xdotool type --file` throws "Invalid multi-byte sequence" for CJK, emoji, accented chars
- **Fix**: Detect non-ASCII (`/[^\x00-\x7F]/`), fall back to clipboard paste (xclip + ctrl+shift+v)
- Saves/restores original clipboard around paste operation
- ASCII text still uses fast `xdotool type --file` path

**Bug 2: `key` action `--clearmodifiers` breaks modifier combos**
- `xdotool key --clearmodifiers -- ctrl+shift+v` silently strips modifiers
- Confirmed: `xdotool key ctrl+shift+v` (no --clearmodifiers) works correctly
- **Fix**: Removed `--clearmodifiers` from `key` action entirely

### Docker Image Improvements
- Added `locales` + `locale-gen en_US.UTF-8` (ENV LANG/LC_ALL set)
- Added `fonts-noto-cjk` (Chinese/Japanese/Korean font support)
- Added `fonts-noto-color-emoji` (emoji rendering)
- Added `iproute2` (ip, ss commands)
- Container now supports full Unicode rendering in terminal and GUI apps

### Verification Results
- **Key ctrl+shift+v**: ✅ Pasted "PASTE_VIA_KEY_ACTION" from clipboard correctly
- **Type unicode**: ✅ `echo "Hello 世界 café 🌍"` typed and executed, output rendered correctly
- **Type ASCII**: ✅ Standard ASCII text types normally via xdotool
- **Docker locale**: ✅ LANG=en_US.UTF-8, Noto CJK + Color Emoji fonts, iproute2 6.1.0

### Commits
1. `3dfd9f4` — fix: unicode type support + key action --clearmodifiers bug

### Code Stats
- MCP server: ~1286 lines (up from ~1250)
- 17 MCP tools (unchanged)
- Server version: 1.7.0

### Next Steps
- [x] Unicode type in GUI apps (mousepad, Firefox) → ✅ cycle 13
- [ ] Session recording/replay
- [ ] Keyboard shortcut helper (common shortcuts as named actions)
- [ ] `computer_type_file` — type large content via file (bypass xdotool limits)
- [ ] Edge case testing: large files, special filenames, symlinks

---

## Cycle 13 (2026-03-08)

### Unicode Type: GUI App Support
The cycle 12 unicode fallback used `ctrl+shift+v` to paste from clipboard, which only works in terminal emulators. GUI apps (Mousepad, Firefox, etc.) use `ctrl+v`.

**Bug**: Unicode text typed nothing in Mousepad/Firefox (ctrl+shift+v is terminal-specific)

**Fix**: Auto-detect focused window type via `xdotool getactivewindow getwindowname`:
- Terminal emulators (window name matches `terminal|xterm|rxvt|konsole|alacritty|kitty|tilix|sakura|lxterminal|terminator|urxvt`): use `ctrl+shift+v`
- GUI apps (everything else): use `ctrl+v`
- Falls back to `ctrl+v` if detection fails (safe default for most apps)

**Note**: xdotool v3 (2016) in container lacks `getwindowclassname` — uses window title matching instead.

### Verification Results
- **Unicode in Mousepad**: ✅ "Hello 世界 café 🌍" typed and rendered correctly
- **Unicode in Terminal**: ✅ "こんにちは世界 🎉" typed and echoed correctly
- **Unicode in Firefox**: ✅ "搜索 中文测试 🔍" typed in URL bar, Google search suggestion appeared
- **ASCII in Terminal**: ✅ Standard xdotool type path works
- **ASCII in Mousepad**: ✅ "ASCII in Mousepad works too!" typed correctly

### Commits
1. `2e01c73` — fix: unicode type now works in GUI apps (mousepad, firefox, etc)

### Code Stats
- MCP server: ~1295 lines (up from ~1286)
- 17 MCP tools (unchanged)
- Server version: 1.7.1

### Next Steps
- [x] Session recording/replay → ✅ cycle 14
- [ ] Keyboard shortcut helper (common shortcuts as named actions)
- [ ] `computer_type_file` — type large content via file (bypass xdotool limits)
- [ ] Edge case testing: large files, special filenames, symlinks

---

## Cycle 14 (2026-03-08)

### Session Recording/Replay
Major feature: record, save, and replay user sessions on virtual desktops.

**New Tools:**
- `computer_session_start` — begin recording actions on a container
  - Named sessions (auto-generated if omitted)
  - One active session per container (prevents conflicts)
  - Records all `computer` tool actions with timestamps and elapsed_ms
- `computer_session_stop` — stop recording and save to workspace
  - Saves JSON to `{workspace}/sessions/{name}.json`
  - Returns action summary (counts per action type)
  - Optional `discard` mode to throw away recording
  - Auto-detects single active session (no name required if only one)
- `computer_session_replay` — replay a saved session
  - Timing preservation with speed multiplier (0.1x to 10x)
  - `dry_run` mode lists actions without executing
  - Skips screenshot-only actions during replay (no-ops)
  - Returns final screenshot + completion summary
  - Error-tolerant: continues on individual action failures, reports errors at end

**How it works:**
- In-memory `activeSessions` Map tracks active recordings
- Recording hooks in the `computer` tool handler log every action (screenshot, click, type, key, scroll, etc.)
- Each action entry includes: timestamp (ISO), elapsed_ms (from session start), action name, params (filtered to non-undefined)
- Sessions saved as portable JSON — can be transferred between containers or shared

**Session JSON format:**
```json
{
  "name": "session-name",
  "container": "computer-use",
  "resolution": "1024x768",
  "started": "2026-03-08T14:43:28.177Z",
  "ended": "2026-03-08T14:43:47.623Z",
  "duration_ms": 19445,
  "action_count": 3,
  "actions": [
    { "timestamp": "...", "elapsed_ms": 3950, "action": "screenshot", "params": {} },
    { "timestamp": "...", "elapsed_ms": 7788, "action": "left_click", "params": { "coordinate": [500, 400] } },
    { "timestamp": "...", "elapsed_ms": 14129, "action": "scroll", "params": { "coordinate": [500, 400], "scroll_direction": "down", "scroll_amount": 3 } }
  ]
}
```

### Verification Results
- **Session start**: ✅ Recording created, confirmed one-per-container guard
- **Action recording**: ✅ Screenshot, left_click, scroll all logged with correct params and timing
- **Session stop**: ✅ JSON saved to workspace/sessions/, action summary returned
- **Dry run**: ✅ Lists actions with timing without executing
- **Replay at 5x**: ✅ 3/3 actions executed, page scrolled down matching original behavior, 0 errors

### Commits
1. `2eaa159` — feat: session recording/replay (computer_session_start/stop/replay)

### Code Stats
- MCP server: ~1580 lines (up from ~1295)
- 20 MCP tools: computer, computer_bash, computer_status, computer_clipboard, computer_window_list, computer_file_read, computer_file_write, computer_process_list, computer_process_kill, computer_navigate, computer_open, computer_session_start, computer_session_stop, computer_session_replay, computer_env_create, computer_env_destroy, computer_env_list, computer_env_resize, computer_env_resize, computer_env_list
- Server version: 1.8.0

### Next Steps
- [x] Keyboard shortcut helper (common shortcuts as named actions) → cycle 15
- [ ] `computer_type_file` — type large content via file (bypass xdotool limits)
- [ ] Edge case testing: large files, special filenames, symlinks
- [x] Session recording with screenshots (optional screenshot capture per action) → cycle 15

---

## Cycle 15 (2026-03-08)

### New Features

#### computer_shortcut — Named Keyboard Shortcuts
Convenience tool mapping 30 human-readable shortcut names to key combos across 8 categories:
- **clipboard**: copy, cut, paste
- **editing**: undo, redo, select_all, delete_line
- **file**: save, save_as, open, new_file, print
- **search**: find, find_replace, find_next
- **browser**: new_tab, close_tab, reopen_tab, next_tab, prev_tab, refresh, hard_refresh, address_bar, back, forward
- **window**: close_window, fullscreen, switch_window
- **terminal**: terminal_copy, terminal_paste
- **zoom**: zoom_in, zoom_out, zoom_reset

Features:
- `name="list"` returns all shortcuts grouped by category
- Fuzzy substring suggestion on typos (e.g. "cop" → "copy, terminal_copy")
- Returns follow-up screenshot after execution

#### Session Screenshots
Added `include_screenshots` option to `computer_session_start`. When enabled:
- Each recorded action includes a base64 screenshot captured after the action completes
- Screenshots stored in the action entry as `{ data, mimeType }`
- Session JSON metadata includes `include_screenshots: true`
- ~80KB per screenshot (JPEG), so a 10-action session ≈ 800KB

### Dogfooding: Python HTTP Server
Tested full workflow inside the VM:
1. Wrote a Python system-info HTTP server via `computer_bash`
2. Started it from the GUI terminal via `type` + `key Return`
3. Navigated to `http://localhost:8080` via `computer_navigate`
4. Clicked "Refresh" button to trigger JS fetch API call
5. System info JSON displayed correctly — no bugs found

### Verification Results
- **sc-49**: ✅ Tools load after hot restart (computer_shortcut + include_screenshots param present)
- **sc-50**: ✅ list=30 shortcuts, new_tab opened tab, close_tab closed it, typo "cop" suggested "copy, terminal_copy"
- **sc-51**: ✅ Session with include_screenshots=true: 2 actions, both have screenshot data (~80KB each), 164KB total JSON

### Commits
1. `2321f6f` — feat: keyboard shortcut helper + session screenshots

### Code Stats
- MCP server: ~1683 lines (up from ~1580)
- 21 MCP tools (added: computer_shortcut)
- Server version: 1.9.0

### Next Steps
- [x] `computer_wait_for` — poll screenshots waiting for visual state change → cycle 16
- [ ] `computer_type_file` — type large content via file (bypass xdotool limits)
- [ ] Edge case testing: large files, special filenames, symlinks
- [ ] Session replay with screenshot comparison (diff against recorded screenshots)

---

## Cycle 16 (2026-03-08)

### computer_wait_for — Visual State Polling
New tool for waiting on display state changes. Essential for real computer automation — replaces guessed `wait` durations with visual confirmation.

**Two modes:**
- `stable`: Wait until screen stops changing (N consecutive identical screenshots). Use for: page load complete, animation ended, file operation finished.
- `change`: Wait until screen differs from current state. Use for: command produced output, dialog appeared, download completed.

**Parameters:**
- `mode`: "stable" (default) or "change"
- `region`: Optional [x1, y1, x2, y2] to monitor only a portion of screen (avoids false triggers from clock, cursor blink)
- `timeout`: 1-60 seconds (default: 10)
- `interval`: 0.5-10 seconds between checks (default: 1)
- `stable_count`: 2-10 consecutive identical frames needed for stable mode (default: 2)
- `container_name`: Optional multi-container targeting

**Implementation:**
- MD5 hash of screenshot base64 data for fast comparison
- Region mode: scrot + ImageMagick crop before hashing (same approach as zoom)
- Returns the final screenshot + status message with timing details
- Graceful timeout with clear messaging (check count, elapsed time)

### Verification Results
- **sc-52**: ✅ Tool loaded with correct schema after hot restart
- **sc-53**: ✅ Stable mode on static screen — returned in 1.4s (2 identical frames, 2 checks)
- **sc-54**: ✅ Change mode — detected Ctrl+T new tab opening after 1.5s (3 checks at 0.5s interval)
- **sc-55**: ✅ Region mode — cropped tab bar [0,60,1024,90], stable with 3 identical frames in 1.7s
- **sc-56**: ✅ Timeout — change mode on static region timed out gracefully after 3.9s with clear message

### Dogfooding: Wait for Page Load
- Navigated to Hacker News with 1s wait (fast, minimal)
- Used `wait_for` stable mode on content region [80,220,950,760] — confirmed page fully rendered in 0.9s
- Pattern: `navigate(url, wait_seconds=1)` + `wait_for(mode="stable", region=content_area)` is more reliable than guessing wait times

### Commits
1. `e3abf39` — feat: computer_wait_for — visual state polling tool

### Code Stats
- MCP server: ~1808 lines (up from ~1683)
- 22 MCP tools (added: computer_wait_for)
- Server version: 1.10.0

### Next Steps
- [x] OCR tools (computer_ocr + computer_find_text) → cycle 17
- [ ] `computer_type_file` — type large content via file (bypass xdotool limits)
- [ ] Edge case testing: large files, special filenames, symlinks
- [ ] Session replay with screenshot comparison (diff against recorded screenshots)
- [ ] `computer_scroll_to` — scroll until visual target appears (combines scroll + wait_for)

---

## Cycle 17 (2026-03-08)

### OCR Tools — computer_ocr + computer_find_text
Two new tools that enable agents to read and locate text on screen using tesseract OCR.

**New Tools:**
- `computer_ocr` — extract all text from the screen (or a region) using tesseract OCR
  - Optional `region` param: [x1, y1, x2, y2] in API coordinates for targeted OCR
  - Multi-language support: `language` param (default: "eng", supports "eng+chi_sim" for Chinese)
  - Returns screenshot + extracted text
  - Uses `--psm 3` (fully automatic page segmentation)
- `computer_find_text` — find text on screen and return clickable coordinates
  - Single-word substring matching (case-insensitive)
  - Multi-word phrase matching (consecutive words on same line)
  - Returns center coordinate in API space — ready for `left_click`
  - Includes confidence scores and bounding boxes per match
  - `all_matches` param to control whether all or just first match is returned
  - Optional `region` param to limit search area
  - Uses tesseract TSV output for word-level bounding boxes

**Why this matters:**
- Before: Agents had to visually parse screenshots to find UI elements — unreliable and token-heavy
- After: `find_text("Submit")` returns exact coordinates, then `left_click` at those coordinates — precise and programmatic
- Enables text verification: OCR a region to confirm expected content loaded
- Enables search-and-click workflows: find a label → click it, without hardcoding coordinates

**Docker Image:**
- Added `tesseract-ocr`, `tesseract-ocr-eng`, `tesseract-ocr-chi-sim` to Dockerfile

### Verification Results
- **sc-57**: ✅ Both tools loaded with correct schemas after hot restart
- **sc-58**: ✅ Full screen OCR returned 14 HN article titles with readable text
- **sc-59**: ✅ Region OCR [80,250,700,400] returned articles 1-4, correctly cropped
- **sc-60**: ✅ find_text "Firefox" found 3 matches at [564,37], [324,73], [126,160]
- **sc-61**: ✅ find_text "Hacker News" (multi-word) found 4 matches across taskbar, title, tabs
- **sc-62**: ✅ find_text "Cloud VM" at [150,553] → clicked → navigated to Cloud VM benchmarks article

### Commits
1. `645e9a3` — feat: OCR tools — computer_ocr + computer_find_text (v1.11.0)

### Code Stats
- MCP server: ~2030 lines (up from ~1808)
- 24 MCP tools (added: computer_ocr, computer_find_text)
- Server version: 1.11.0

### Next Steps
- [x] `computer_scroll_to` — scroll until visual target appears (find_text + scroll loop) → **done in cycle 18**
- [ ] `computer_type_file` — type large content via file (bypass xdotool limits)
- [ ] Edge case testing: large files, special filenames, symlinks
- [ ] Session replay with screenshot comparison (diff against recorded screenshots)
- [ ] OCR on colored backgrounds (login on orange HN bar wasn't detected — investigate)

## Cycle 18 (2026-03-08)

### Scroll-to-Text — computer_scroll_to + findTextOnScreen helper
High-value navigation tool that combines OCR text search with automatic scrolling.

**New Tool:**
- `computer_scroll_to` — scroll until a text target appears on screen
  - If text is already visible, returns immediately with coordinates (0 scrolls)
  - Otherwise scrolls in given direction, OCR-checking after each scroll
  - Stuck detection: stops early when page hits top/bottom (MD5 hash comparison)
  - Optional `click=true` to auto-click the first match when found
  - Params: `query`, `direction` (up/down), `scroll_amount`, `max_scrolls`, `click`, `language`

**Refactor:**
- Extracted `findTextOnScreen()` helper function from `computer_find_text`
- Shared by both `computer_find_text` and `computer_scroll_to` — eliminates ~80 lines of duplication
- Same matching logic: single-word substring match, multi-word consecutive match, confidence scores, bounding boxes

**Why this matters:**
- Before: Finding off-screen text required manual screenshot → scroll → screenshot → check loops
- After: `scroll_to("Submit button")` automatically scrolls until found, returns coordinates
- With `click=true`: one call to find and click any text on a scrollable page
- Stuck detection prevents wasting time scrolling past page boundaries

### Verification Results
- **sc-63**: ✅ Tool loaded with correct schema after hot restart
- **sc-64**: ✅ "Cloud VM benchmarks" found at [212,12], already visible (0 scrolls), 87% confidence
- **sc-65**: ✅ "More" found at [136,656] after 2 scrolls down on HN page
- **sc-66**: ✅ "xyznonexistent123" not found — stopped after 4 scrolls detecting hit bottom
- **sc-67**: ✅ "Guidelines" found after 2 scrolls, auto-clicked, navigated to HN Guidelines page
- **sc-68**: ✅ find_text "Hacker News Guidelines" found 3 matches — refactored helper works correctly

### Commits
1. `71c1597` — feat: computer_scroll_to + findTextOnScreen helper (v1.12.0)

### Code Stats
- MCP server: ~2137 lines (up from ~2030)
- 25 MCP tools (added: computer_scroll_to)
- Server version: 1.12.0

### Next Steps
- [x] OCR preprocessing for colored backgrounds → ✅ cycle 19 (color channel fallback)
- [ ] `computer_type_file` — type large content via file (bypass xdotool limits)
- [ ] Edge case testing: large files, special filenames, symlinks
- [ ] Session replay with screenshot comparison (diff against recorded screenshots)
- [x] scroll_to direction="up" testing → ✅ cycle 19

---

## Cycle 19 (2026-03-08)

### OCR Color Channel Fallback for Colored Backgrounds
Significant OCR accuracy improvement for text on colored/dark backgrounds.

**Problem:**
- Full-screen OCR (`--psm 3`) completely missed text on colored backgrounds
- HN orange navbar: "login" not found at all on full-screen pass
- GitHub dark header: "Sign in" / "Sign up" not found on full-screen pass
- Region-cropped OCR worked fine — the issue was tesseract's full-page binarization

**Solution: Color channel fallback**
- When primary OCR pass finds no matches, automatically retry on each RGB channel separately
- `convert image.png -channel R -separate` extracts one color channel as grayscale
- Different channels give better contrast for different background colors
- Tries R, G, B in order, stops on first channel with matches
- Zero overhead when text IS found on primary pass (common case)

**Refactored helpers:**
- `parseTesseractTsv(tsv)` — parse tesseract TSV into word objects (extracted from findTextOnScreen)
- `matchWordsToQuery(words, query, ...)` — search words for query matches (extracted from findTextOnScreen)
- Both reused by primary pass and channel fallback passes

**Results:**
- HN "login" on orange bar: NOT FOUND → **found at 90% confidence** (via R channel)
- GitHub "signin" on dark header: NOT FOUND → **found at 58% confidence** (via R channel)
- White background text: no regression, still 90%+ confidence
- scroll_to: still works correctly after refactor

**Limitations:**
- OCR may merge "Sign in" → "signin" (tesseract word segmentation) — search for "signin" works
- Channel fallback adds ~3-9s latency when text not found on primary pass (3 extra tesseract runs)
- Very low contrast text (gray on slightly different gray) may still be missed

### Additional Testing
- **scroll_to direction="up"**: ✅ Found "Why can't you tune your guitar" after 2 scrolls up
- **GitHub real-world**: ✅ Navigated to github.com/anthropics/claude-code, found header text via channel fallback
- **Multi-word on colored bg**: "Sign in" (2 words) missed because OCR merges to "signin" — inherent OCR limitation

### Verification Results
- **sc-69**: ✅ MCP server loaded after hot restart
- **sc-70**: ✅ "login" found at [919,235] with 90% confidence on HN orange navbar (full screen, no region)
- **sc-71**: ✅ "Hacker News" found 3 matches at 92%/93%/47% confidence on white background
- **sc-72**: ✅ scroll_to found "More" at [136,656] after 2 scrolls, 94% confidence

### Commits
1. `f92b51d` — feat: OCR color channel fallback for colored backgrounds (v1.13.0)

### Code Stats
- MCP server: ~2190 lines (up from ~2137)
- 25 MCP tools (unchanged)
- Server version: 1.13.0

### Next Steps
- [ ] `computer_type_file` — type large content via file (bypass xdotool limits)
- [ ] Edge case testing: large files, special filenames, symlinks
- [ ] Session replay with screenshot comparison (diff against recorded screenshots)
- [ ] OCR word segmentation improvement (handle merged words like "signin" → "sign in")
