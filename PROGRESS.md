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
- [x] OCR word segmentation improvement (handle merged words like "signin" → "sign in") ✅ Done in cycle 20

---

## Cycle 20 (2026-03-08)

### New Features

#### 1. `computer_window_focus` — Window Activation Tool
- Focus/activate any window by title substring (case-insensitive) or X window ID
- Uses `xdotool windowactivate` + `windowfocus`
- Returns screenshot after focus with window title confirmation
- Works with `computer_window_list` for discovery → focus workflow

#### 2. `computer_wait_for_text` — OCR Text Polling
- Waits until specific text appears on screen via periodic OCR polling
- Configurable timeout (1-120s, default 30), interval (0.5-10s, default 2)
- Optional auto-click when text found
- Region support for targeted waiting
- Returns coordinate of found text (ready for clicking) + elapsed time
- Uses `findTextOnScreen()` with full color channel fallback
- Clean timeout message when text never appears

#### 3. OCR Concatenation Fallback — Word Segmentation Fix
- **Problem**: Tesseract merges adjacent words on colored backgrounds (e.g. "Sign in" → "signin")
- **Fix**: `matchWordsToQuery()` now checks concatenation of adjacent same-line words
  - Single-word queries: after direct match fails, tries concatenating 2-3 adjacent words
  - Multi-word queries: after multi-word match fails, checks if single OCR words contain the joined query
  - Both directions covered: "sign in" finds "signin", and "signin" still finds "signin" directly
- Refactored match result building into shared `buildMatch()` helper

### Real-World Dogfooding
- Wrote and ran a Python fibonacci script via terminal (type + key actions)
- Window switching: terminal → Firefox → back, all smooth
- GitHub header text found via concatenation fallback ("sign in" → "signin" at 43%)

### Verification Results
- **sc-73**: ✅ All 25 MCP tools loaded after hot restart
- **sc-74**: ✅ `window_focus` focused terminal by title, then Firefox by title
- **sc-75**: ✅ "sign in" found "signin" on GitHub dark header via concatenation fallback
- **sc-76**: ✅ `wait_for_text` found visible text in 1.0s, timeout exits cleanly after 5s

### Commits
1. `b814e59` — feat: window focus, wait-for-text, OCR word concatenation (v1.14.0)

### Code Stats
- MCP server: ~2303 lines (up from ~2190)
- 27 MCP tools (up from 25)
- Server version: 1.14.0

### Next Steps
- [x] `computer_window_move` / `computer_window_resize` — window manipulation ✅ (cycle 21)
- [ ] `computer_type_file` — type large content via file (bypass xdotool limits)
- [ ] Edge case testing: large files, special filenames, symlinks
- [ ] Session replay with screenshot comparison

## Cycle 21 (2026-03-08)

### New Features

#### 1. `computer_window_move` — Window Positioning
- Move any window to specific x,y coordinates in API space
- Auto-scales for high-res displays (>1568px)
- Supports title substring match or exact window ID
- Returns screenshot + confirmation of new position

#### 2. `computer_window_resize` — Window Resizing
- Resize any window to specific width x height in API space
- Auto-scales for high-res displays
- Supports title substring match or exact window ID
- Returns screenshot + confirmation of new dimensions

#### 3. `computer_window_manage` — Window State Management
- 5 actions: minimize, maximize, restore, close, raise
- minimize: `xdotool windowminimize` (hides window)
- maximize: activate + move to 0,0 + resize to screen dimensions
- restore: activate + resize to 60%x70% + reposition
- close: `xdotool windowclose` (destroys window)
- raise: `xdotool windowraise` (bring to front without focusing)
- All actions support title or window_id targeting

### Real-World Dogfooding
- Created side-by-side split-screen layout: Mousepad (left half) + Terminal (right half)
- Full workflow: open terminal → close extra windows → resize both to 512x741 → position at x=0 and x=512
- Tested all 5 manage actions: close (removed 3 extra terminals), minimize (hid terminal), maximize (Mousepad filled screen), restore, raise

### Verification Results
- **sc-77**: ✅ 28 MCP tools loaded after hot restart (+3 new)
- **sc-78**: ✅ `window_move` moved terminal to [50,50], confirmed via xdotool geometry
- **sc-79**: ✅ `window_resize` resized terminal 397x293 → 600x400, visually confirmed
- **sc-80**: ✅ `window_manage` minimize/maximize/close all working
- **sc-81**: ✅ Side-by-side split layout achieved programmatically

### Commits
1. `e518de2` — feat: window move, resize, and manage tools (v1.15.0)

### Code Stats
- MCP server: ~2503 lines (up from ~2303)
- 28 MCP tools (up from 27)
- Server version: 1.15.0

### Next Steps
- [x] Tiling layout helper (auto split-screen arrangements) → done in cycle 22
- [ ] `computer_type_file` — type large content via file (bypass xdotool limits)
- [ ] Edge case testing: large files, special filenames, symlinks
- [ ] Session replay with screenshot comparison

## Cycle 22 (2026-03-08)

### New Features

#### 1. `computer_window_tile` — Auto Window Tiling
- 5 layout presets: `left_right`, `top_bottom`, `grid`, `cascade`, `thirds`
- Optional `titles` array to select specific windows (in order), or auto-discover all visible app windows
- Optional `gap` parameter for spacing between windows
- `grid` auto-calculates NxM grid based on window count (ceil(sqrt(n)) cols)
- `cascade` offsets windows 30px diagonally with 70% screen size
- `thirds` splits screen into 3 equal vertical columns
- Filters out desktop/panel windows automatically via `getVisibleWindows()` helper

#### 2. DRY Window Helper Refactor
- Extracted `findWindowByTitleOrId(title, window_id, cn)` — shared by 4 window tools
- Extracted `getVisibleWindows(cn)` — returns named, visible app windows with geometry
- Refactored `window_focus`, `window_move`, `window_resize`, `window_manage` to use shared helper
- Eliminated 4x duplicated window search logic (~60 lines removed)

#### 3. Version Fix
- Server version bumped from 1.13.0 to 1.16.0 (was not bumped in cycles 14-21)

### Real-World Dogfooding
- Tiled Firefox + Mousepad + Terminal in `thirds` layout (3 equal columns)
- Ran system info commands in terminal (uname, df, date)
- Triple-clicked "Example Domain" in Firefox, ctrl+c copied, switched to Mousepad, ctrl+v pasted
- Re-tiled Firefox + Mousepad in `left_right` for clean side-by-side view
- All window tools (focus, move, resize, tile) work together smoothly

### Verification Results
- **sc-82**: ✅ 29 MCP tools loaded after hot restart (+1 new)
- **sc-83**: ✅ `window_tile` left_right: Mousepad 512x768 at (0,0), Terminal 512x768 at (512,0)
- **sc-84**: ✅ `window_tile` grid: 3 windows in 2x2 grid, correct auto-layout
- **sc-85**: ✅ Refactored tools: focus, move, resize all work with shared helper
- **sc-86**: ✅ Real-world workflow: tile, type, select, copy, paste across 3 apps

### Commits
1. `469660d` — feat: window tiling tool + DRY window helper refactor (v1.16.0)

### Code Stats
- MCP server: ~2593 lines (up from ~2503)
- 29 MCP tools (up from 28)
- Server version: 1.16.0

### Next Steps
- [x] `computer_type_file` — type large content via file (done in cycle 23)
- [ ] Edge case testing: large files, special filenames, symlinks
- [ ] Session replay with screenshot comparison
- [ ] `computer_window_tile` gap testing + cascade layout verification

## Cycle 23 (2026-03-08)

### New Features

#### 1. `computer_type_file` — Type File Contents Into Active Window
- Reads a file from the container and pastes into the active window via clipboard
- Optional `line_range` parameter (e.g. '1-50') to type specific lines
- Auto-detects terminal vs GUI for correct paste shortcut (ctrl+shift+v vs ctrl+v)
- Saves and restores original clipboard contents
- Much faster than character-by-character typing for large content

#### 2. `clipboardPaste()` DRY Helper
- Extracted clipboard paste logic into shared `clipboardPaste(content, containerName)` function
- Used by 3 callers: unicode type, large ASCII type, and type_file tool
- Eliminates ~30 lines of duplicated code across the codebase
- Handles: save clipboard → base64 encode → set clipboard → detect paste shortcut → paste → restore

#### 3. Large ASCII Text Optimization
- `type` action now uses clipboard paste for ASCII text >500 characters
- Previously: character-by-character xdotool typing with 12ms delay per char (~6s for 500 chars)
- Now: instant clipboard paste for large text blocks
- Short ASCII text (<500 chars) still uses xdotool type for compatibility

### Real-World Dogfooding
- Wrote fibonacci.py (792 bytes, 26 lines) to /workspace via file_write
- Used `type_file` to paste entire script into Mousepad — instant, all indentation preserved
- Used `type_file` with line_range '7-15' to paste just the fibonacci function — correct extraction
- Typed 830-char Lorem ipsum via `type` action — clipboard paste optimization kicked in
- Ran fibonacci.py in terminal: correct output (F(0)=0 through F(14)=377, cache info)
- Browsed Hacker News in Firefox, clicked through to arXiv paper (SWE-CI)

### Verification Results
- **sc-87**: ✅ 30 MCP tools loaded after hot restart (+1 new)
- **sc-88**: ✅ `type_file`: 792 chars from fibonacci.py pasted into Mousepad perfectly
- **sc-89**: ✅ Large ASCII optimization: ~830 chars pasted instantly via clipboard
- **sc-90**: ✅ `type_file` line_range: 243 chars (lines 7-15) extracted correctly
- **sc-91**: ✅ Real-world workflow: write → type_file → run → browse HN → arXiv

### Commits
1. `823f0b1` — feat: type-file tool + clipboardPaste DRY helper + large-text optimization (v1.17.0)

### Code Stats
- MCP server: ~2656 lines (up from ~2593)
- 30 MCP tools (up from 29)
- Server version: 1.17.0

## Cycle 24 (2026-03-08)

### Bug Fix: Descriptive Error Messages

#### Problem: "Unknown error" from MCP SDK
- The MCP SDK (`@modelcontextprotocol/sdk`) catches thrown `Error` objects inside async tool handlers and returns a generic "Unknown error" to the client
- Our `computer` tool threw errors for validation failures (bad coordinates, invalid scroll_amount) which were properly caught in our try/catch, but the MCP SDK intercepted them first
- Result: users got unhelpful "Unknown error" instead of descriptive messages

#### Fix: Early Input Validation
- Added pre-validation at the top of the `computer` tool handler that **returns** error objects instead of throwing
- Covers: coordinate bounds/negative, start_coordinate validation, scroll_amount max (100), duration max (60s), left_click_drag missing params
- All other tools already return `{isError: true}` objects, so this was specific to the main `computer` tool

#### Error Messages Now Returned
| Input | Before | After |
|-------|--------|-------|
| `coordinate: [1024, 768]` | "Unknown error" | "Error: coordinate [1024,768] out of bounds (display is 1024x768, max [1023,767])" |
| `coordinate: [-1, -1]` | "Unknown error" | "Error: coordinate [-1,-1] values must be non-negative" |
| `left_click_drag` missing start | "Unknown error" | "Error: start_coordinate required for left_click_drag" |
| `scroll_amount: 999` | "Unknown error" | "Error: scroll_amount too large (max 100), got 999" |

### Edge Case Testing Results
- **Unicode in GUI (Mousepad)**: emoji, CJK, Japanese, Korean, accented chars — all perfect ✅
- **Unicode in Terminal**: `echo "你好世界 🚀 café"` typed and executed correctly ✅
- **Special characters via type**: backticks, dollar signs, backslashes, double backslashes — all typed correctly ✅
- **Boundary coordinates**: [0,0] and [1023,767] both work correctly ✅
- **type_file with spaces in filename**: `/workspace/file with spaces.txt` — works ✅
- **type_file with symlinks**: symlink_test.py → edge_test.py — followed correctly ✅
- **type_file nonexistent file**: "File not found: /workspace/nonexistent.txt" ✅
- **type_file with special chars content**: backticks, $vars, quotes, emoji, CJK — all preserved ✅

### Real-World Dogfooding
- Browsed Hacker News in Firefox, scrolled through 30 items
- Read content, tested click/scroll/navigate in real workflow
- Verified unicode echo output in terminal

### Verification Results
- **sc-92**: ✅ Descriptive error messages for all invalid inputs
- **sc-93**: ✅ Normal operations (screenshot, click, type, scroll, navigate) unaffected
- **sc-94**: ✅ Real-world HN browsing workflow

### Commits
1. `56ce9b1` — fix: early input validation with descriptive error messages for computer tool (v1.18.0)

### Code Stats
- MCP server: ~2710 lines (up from ~2656)
- 30 MCP tools (unchanged)
- Server version: 1.18.0

## Cycle 25 (2026-03-08)

### Bug Fix: Comprehensive try/catch for All Tool Handlers

#### Problem: 5 tools missing try/catch wrappers
Audited all 30 MCP tool handlers. Found 5 tools where `throw new Error` calls could bubble up to the MCP SDK (which swallows them as "Unknown error"):

1. **`computer_env_list`** — entire handler had no try/catch
2. **`computer_wait_for`** — no try/catch, `captureAndHash()` throws on invalid region
3. **`computer_session_start`** — `resolveContainer()` throws outside try/catch on invalid container
4. **`computer_session_stop`** — `writeFileSync()` throws outside try/catch on disk errors
5. **`computer_session_replay`** — `resolveContainer()` at line 1948 outside try/catch

#### Fix
Wrapped all 5 tool handlers in try/catch blocks that return `{isError: true, content: [...]}` with descriptive messages. Continues the pattern from cycle 24.

#### Audit Results (28 other tools)
All 28 other tools already had proper try/catch wrapping with `{isError: true}` returns. The `throw new Error` calls inside helper functions (`resolveContainer`, `findWindowByTitleOrId`, `validateCoordinate`, `executeAction`) are all called within try/catch blocks of their parent tool handlers.

### Spec Compliance Re-verification
Browsed Anthropic Computer Use docs (platform.claude.com) inside the VM:
- **Basic actions (all versions)**: screenshot, left_click, type, key, mouse_move — ✅ all implemented
- **Enhanced (computer_20250124)**: scroll, left_click_drag, right/middle_click, double/triple_click, left_mouse_down/up, hold_key, wait — ✅ all implemented
- **Enhanced (computer_20251124)**: zoom — ✅ implemented
- **Full 16/16 Anthropic spec actions** compliant

### Real-World Dogfooding
- Navigated to Anthropic docs, used `scroll_to` to find "Available actions" (96% OCR confidence)
- Zoomed into doc section to verify spec version details
- Tiled terminal + Firefox side-by-side with `window_tile` (left_right, 4px gap)
- Created and executed sysinfo.sh script via `computer_bash` + terminal workflow
- Tested type, key, scroll, navigate, find_text, zoom, window_manage, window_tile — all working

### Commits
1. `c27a709` — fix: wrap 4 tool handlers in try/catch to prevent MCP SDK "Unknown error"

### Code Stats
- MCP server: ~2731 lines (up from ~2710)
- 30 MCP tools (unchanged)
- Server version: 1.18.1

### Next Steps
- [x] ~~Screenshot diff tool~~ → done in cycle 26
- [ ] `computer_window_tile` gap testing + cascade layout verification
- [ ] Terminal detection improvements (more shell/emulator patterns)
- [ ] Clipboard paste verification (ensure content actually arrived)
- [ ] `computer_macro` tool (record + replay named action sequences)

## Cycle 26 (2026-03-08)

### New Tool: `computer_screenshot_diff`

Visual regression testing tool with 3 modes:

#### Save Mode
- Captures current screenshot as a named PNG baseline in `/workspace/.baselines/`
- Baselines stored as lossless PNG (no JPEG compression artifacts)
- Supports region cropping via `[x1, y1, x2, y2]` API coordinates
- Returns preview image of saved baseline

#### Compare Mode
- Compares current screenshot to a saved baseline using ImageMagick `compare`
- Returns visual diff image (red highlights on changed pixels)
- Reports: pixel count, percentage of change, bounding box of changes
- Bounding box converted to API coordinates for programmatic use
- `fuzz` parameter (0-100%) controls color difference threshold (default 5%)
- Auto-resizes if baseline and current dimensions differ

#### List Mode
- Lists all saved baselines with dimensions, file size, and timestamps

### Verification Results
- **Save**: Full-screen (1024x768) and region (500x290 crop) baselines saved correctly
- **Compare — with changes**: Navigated from terminal to example.com → 52.53% diff (413,079 pixels), bounding box covers entire screen
- **Compare — identical**: Immediate re-compare shows 0% diff (fuzz absorbs clock changes)
- **List**: Shows all baselines with metadata

### Real-World Dogfooding
- Saved baseline of terminal state → typed command → compared: 0.77% diff with precise bounding box
- Saved baseline → navigated Firefox to example.com → compared: 52.53% diff, massive visual change detected
- Tested region-based save (terminal area only)
- Verified identical comparison returns 0% diff

### Commits
1. `7b2c448` — feat: add computer_screenshot_diff tool for visual regression testing

### Code Stats
- MCP server: ~2943 lines (up from ~2731)
- 31 MCP tools (up from 30)
- Server version: 1.19.0

### Next Steps
- [x] `computer_macro` tool (record + replay named action sequences)
- [ ] `computer_window_tile` gap testing + cascade layout verification
- [ ] Terminal detection improvements (more shell/emulator patterns)
- [ ] Clipboard paste verification (ensure content actually arrived)
- [x] Screenshot diff: add "delete" mode to remove old baselines

## Cycle 27 (2026-03-08)

### New Tool: `computer_macro`

Reusable named action sequences (macros) with 4 modes:

#### Save Mode
- Define macros from a JSON array of actions
- Convert existing session recordings into macros via `from_session`
- Validates all action types before saving
- Auto-generates description from action counts
- Stored as JSON in `/workspace/.macros/`

#### Run Mode
- Executes all actions in sequence with timing
- `repeat` param: run macro N times (1-100, default 1)
- `speed` param: playback speed multiplier (0.1x-10x, default 1.0)
- `delay_between` param: seconds between repetitions (default 0.5)
- Handles wait/screenshot/zoom actions inline (not covered by `executeAction()`)
- Per-action error tracking (continues on error, reports at end)
- Returns final screenshot

#### List Mode
- Shows all saved macros with action counts and descriptions

#### Delete Mode
- Remove single macro by name, or all macros with `name="all"`

### Screenshot Diff: Delete Mode
- Added `delete` mode to `computer_screenshot_diff`
- Delete single baseline by name
- Delete all baselines with `name="all"`
- Now 4 modes: save, compare, list, delete

### Bug Fix: Macro Runner
- `executeAction()` only handles xdotool actions (click, type, key, scroll, etc.)
- `wait`, `screenshot`, `zoom`, `cursor_position` are handled in the main tool handler
- Macro runner now handles these inline: wait = async sleep, others = no-op in macro context

### Verification Results
- **screenshot_diff delete**: Single delete + delete all both work correctly
- **macro save (JSON)**: 4-action open-new-tab macro saved with correct description
- **macro save (from_session)**: Converted test-cycle14 session into macro (3 actions)
- **macro save (validation)**: Invalid action type rejected with helpful error
- **macro run**: open-new-tab 4/4 actions (including wait), close-tab 2/2 with repeat=2 speed=2x
- **macro list**: Shows 3 macros with action counts and descriptions
- **macro delete**: Single delete works, not-found error handled
- **dogfooding**: page-down-3x macro (3 scrolls + 2 waits) scrolled Anthropic docs; go-to-top returned to page top

### Anthropic Spec Note (from browsing docs)
- `computer-use-2025-11-24` now listed for: Claude Opus 4.6, Claude Sonnet 4.6, Claude Opus 4.5
- `computer-use-2025-01-24` deprecated (Sonnet 4.5, Haiku 4.5, Opus 4.1, Sonnet 4, Opus 4, Sonnet 3.7)

### Commits
1. `d4a3fe7` — feat: add computer_macro tool and screenshot_diff delete mode
2. `8a5a260` — fix: handle wait/screenshot/zoom actions in macro runner

### Code Stats
- MCP server: ~3230 lines (up from ~2943)
- 32 MCP tools (up from 31)
- Server version: 1.20.0

### Next Steps
- [x] `computer_annotate` tool (draw rectangles/arrows on screenshots) → cycle 28
- [ ] `computer_window_tile` gap testing + cascade layout verification
- [ ] Terminal detection improvements (more shell/emulator patterns)
- [ ] Clipboard paste verification (ensure content actually arrived)
- [ ] Macro: add "edit" mode to modify existing macros

## Cycle 28 (2026-03-08)

### New Tool: `computer_annotate`

Draw visual annotations on screenshots for visual communication. 6 annotation types:

| Type | Params | Description |
|------|--------|-------------|
| `rectangle` | coordinate + end_coordinate | Outline or filled rectangle |
| `arrow` | coordinate (start) + end_coordinate (tip) | Line with triangular arrowhead |
| `circle` | coordinate (center), optional radius | Outline or filled circle |
| `text` | coordinate + text | Text label with dark background for readability |
| `line` | coordinate + end_coordinate | Simple straight line |
| `number` | coordinate, optional number | Colored circle with white number (callout marker) |

Common options on all types: `color` (name or #hex, default red), `thickness` (1-20, default 3), `fill` (boolean), `font_size` (8-72), `radius` (5-500).

Implementation details:
- Uses ImageMagick `convert` with multiple inline `-draw` commands
- `sanitizeDrawText()` handles shell escaping for text annotations
- `colorToRgb()` maps color names to RGB for semi-transparent fills
- `apiLengthToDisplay()` converts distances from API to display space
- Arrowheads computed via vector math (unit vector + perpendicular for triangle)
- Text labels get dark semi-transparent background rectangles for readability
- Number markers: filled colored circle + white number text
- Optional `save_path` to persist annotated image in container
- Max 50 annotations per call

### Verification Results
- **sc-108**: Rectangle (outline+filled), circle (outline+filled), text (with dark background) — all colors/thickness correct
- **sc-109**: 3 arrows at different angles with correctly oriented arrowheads, 2 lines — all render correctly
- **sc-110**: 7 number markers (1-5 single digit, 10+99 multi-digit) with colored circles, white borders, centered text
- **sc-111**: 5 error cases (bad JSON, invalid type, missing end_coordinate, missing text, empty array) — all return descriptive messages
- **sc-112**: 12 mixed annotations on Anthropic docs page — real-world UI documentation use case

### Commits
1. `0856c3d` — feat: add computer_annotate tool for visual annotations on screenshots

### Code Stats
- MCP server: ~3440 lines (up from ~3230)
- 33 MCP tools (up from 32)
- Server version: 1.21.0

### Next Steps
- [x] `computer_window_tile` gap testing + cascade layout verification → ✅ cycle 29
- [ ] Terminal detection improvements (more shell/emulator patterns)
- [ ] Clipboard paste verification (ensure content actually arrived)
- [ ] Macro: add "edit" mode to modify existing macros
- [x] `computer_annotate` save_path verification + hex color testing → ✅ cycle 29

---

## Cycle 29 (2026-03-08)

### Critical Bug Fix: Window Discovery
**Bug**: `getVisibleWindows()`, `findWindowByTitleOrId()`, and `computer_window_list` all used `xdotool search --onlyvisible --name ''` which matches ALL windows including dozens of unnamed XFCE internal windows. Since results were capped at first 30, actual app windows (Terminal, Firefox, Mousepad) were never reached — causing `computer_window_tile` to return "No windows found" despite multiple visible apps.

**Fix**: Changed to `--name '.'` (regex: any character) to only match windows with non-empty names. Added `xfwm4` and `wrapper-` to skip patterns. Increased slice cap from 30 to 50. Applied to all 3 call sites.

### Spec Compliance Fix: Coordinate Scaling
**Bug**: Our `getScaleFactor()` only enforced the long edge constraint (`1568/max(w,h)`) but missed the Anthropic reference implementation's total pixels constraint (`sqrt(1,150,000 / (w*h))`). For 1920x1080, total pixels (0.745) is tighter than long edge (0.817) — would have sent oversized screenshots.

**Fix**: Added `MAX_API_PIXELS = 1,150,000` constant and `totalPixelsScale` calculation. Scale factor is now `min(1, longEdgeScale, totalPixelsScale)` matching the Anthropic reference exactly.

Verified across 6 resolutions:
| Resolution | Long Edge | Total Pixels | Used | Scale |
|-----------|-----------|-------------|------|-------|
| 1024x768 | 1.531 | 1.209 | none | 1.000 |
| 1920x1080 | 0.817 | 0.745 | tp | 0.745 |
| 2560x1440 | 0.613 | 0.559 | tp | 0.559 |
| 3840x2160 | 0.408 | 0.372 | tp | 0.372 |

### Window Tile Verification
- **Cascade**: 6 windows tiled with 30px diagonal offset ✓
- **Grid + gap**: 3x2 grid with 10px spacing between windows ✓
- **Left-right with title filter**: 2 windows side by side ✓

### Annotate Tool Verification
- Hex colors (#FF6600, #00FF00, #0088FF, #FF00FF) all render correctly ✓
- save_path creates file at specified container path (95KB PNG) ✓
- Mixed annotation types in single call (rect + arrow + text + circle + number + line) ✓

### Real-World Dogfooding
- Browsed GitHub anthropics/claude-quickstarts repo in Firefox
- Navigated to computer-use-demo/tools directory
- Typed unicode text (Chinese, emoji, accented) in Mousepad with real newlines ✓
- Window management (focus, tile, maximize, close) all working ✓

### Verification Results
- **sc-113**: cascade layout with 6 windows ✅
- **sc-114**: grid layout with gap=10 ✅
- **sc-115**: window_list shows named app windows ✅
- **sc-116**: window_focus by title ✅
- **sc-117**: scaling math verified for 6 resolutions ✅

### Commits
1. `97dbabf` — fix: getVisibleWindows/findWindowByTitleOrId miss app windows due to xdotool --name '' returning unnamed XFCE internals first
2. `f7ab1f7` — fix: add total pixels constraint to coordinate scaling (Anthropic spec compliance)

### Code Stats
- MCP server: ~3445 lines (up from ~3440)
- 33 MCP tools (unchanged)
- Server version: 1.22.0

### Next Steps
- [ ] Terminal detection improvements (more shell/emulator patterns)
- [ ] Clipboard paste verification (ensure content actually arrived)
- [ ] Macro: add "edit" mode to modify existing macros
- [ ] Research: check Anthropic reference computer.py for new actions/params
- [x] text_editor tool (Anthropic spec: str_replace_based_edit_tool) → ✅ cycle 30

---

## Cycle 30 (2026-03-08)

### New Tool: `computer_text_editor` (Anthropic str_replace_based_edit_tool spec)

Implements the `text_editor_20250728` specification as an MCP tool for editing files inside containers.

**Commands:**
| Command | Description | Key Params |
|---------|------------|------------|
| `view` | View file with `cat -n` line numbers, or directory listing | `view_range=[start,end]` |
| `create` | Create new file (fails if exists) | `file_text` |
| `str_replace` | Replace unique text occurrence | `old_str`, `new_str` |
| `insert` | Insert text at line number | `insert_line`, `insert_text` |
| `undo_edit` | Revert last edit (bonus over spec) | — |

**Spec Compliance:**
- `cat -n` style output with 6-char right-aligned line numbers
- Tab expansion (tabs → 4 spaces)
- SNIPPET_LINES = 4 context around edits
- str_replace requires exactly 1 occurrence (reports line numbers on duplicates)
- Path validation: absolute required, exists check, directory restrictions
- `view_range` with `end=-1` for EOF support
- `insert_line=0` for prepend support
- Accepts both `insert_text` (20250728 spec) and `new_str` (older compat) for insert

**Bonus Features:**
- `undo_edit` command with in-memory file history (per container, per path)
- File I/O via base64 encoding for shell safety
- Multi-container support (optional `container_name` param)

**Implementation Details:**
- `fileEditHistory` Map: `"containerName::path"` → `string[]` (previous contents)
- `makeNumberedOutput()` helper for `cat -n` style formatting
- All file operations via `dockerExec()` (read: `cat`, write: base64 encode/decode)
- Truncation at MAX_RESPONSE_LEN (16KB) for large files

### Anthropic Spec Research Summary
- Tool versions: `text_editor_20250728` (latest, Claude 4.x), `text_editor_20250429`, `text_editor_20250124` (Claude 3.7), `text_editor_20241022` (Claude 3.5)
- Latest version removed `undo_edit`, renamed tool to `str_replace_based_edit_tool`, uses `insert_text` instead of `new_str`
- Optional `max_characters` param in 20250728 for truncation control
- ~700 additional input tokens when included in API requests

### Real-World Dogfooding
- Created `/workspace/system_report.py` using text_editor create command
- Ran system report via computer_bash — all tools present, container healthy
- Also browsed Anthropic reference implementation in Firefox (edit.py on GitHub)

### Verification Results
- **sc-118**: view file + directory listing ✅
- **sc-119**: create + str_replace + undo_edit ✅
- **sc-120**: insert at line 2 with snippet context ✅
- **sc-121**: error cases (non-absolute path, missing file, existing file, duplicate old_str) ✅

### Commits
1. `feaad45` — feat: add computer_text_editor tool (Anthropic str_replace_based_edit_tool spec)

### Code Stats
- MCP server: ~3700 lines (up from ~3445)
- 34 MCP tools (up from 33)
- Server version: 1.23.0

### Next Steps
- [x] Terminal detection improvements (more shell/emulator patterns)
- [ ] Clipboard paste verification (ensure content actually arrived)
- [ ] Macro: add "edit" mode to modify existing macros
- [x] `max_characters` param for text_editor view truncation (20250728 spec)
- [ ] text_editor view_range with end=-1 edge case testing

## Cycle 31 (2026-03-08)

### text_editor: `max_characters` param (Anthropic spec compliance)

Added optional `max_characters` parameter to `computer_text_editor` view command, matching the `text_editor_20250728` specification.

**Behavior:**
- When set, truncates file content to that character count before adding line numbers
- Truncation message matches Anthropic's exact format: `<response clipped><NOTE>...</NOTE>` with grep suggestion
- When not set (null/undefined/0), falls back to existing `MAX_RESPONSE_LEN` (16KB) safety net
- `TRUNCATED_MESSAGE` constant extracted for consistency

### Terminal Detection: WM_CLASS via xprop

Improved clipboard paste terminal-vs-GUI detection to check X11 `WM_CLASS` property in addition to window name.

**Why:** Window titles change (e.g. "Terminal - user@host: ~/dir") but WM_CLASS is stable ("xfce4-terminal", "Xfce4-terminal"). Name matching can miss terminals with non-standard titles.

**Changes:**
- Added `xprop -id <window> WM_CLASS` check alongside `xdotool getwindowname`
- Added terminal patterns: `foot`, `wezterm`, `st-256color`, `gnome-terminal`
- Graceful fallback: if xprop not installed, falls back to name-only detection
- Added `x11-utils` package to Dockerfile for persistent xprop support

### Docker: x11-utils added to Dockerfile
- `x11-utils` package (provides `xprop`, `xdpyinfo`, `xlsfonts`, etc.)
- Committed to `~/computer-use-env/` repo

### Real-World Dogfooding
- Typed unicode text (CJK + emoji) into xfce4-terminal — WM_CLASS detection confirmed working
- Browsed Anthropic text_editor docs in Firefox to verify max_characters spec
- Used text_editor to create test files in /workspace

### Verification Results
- **sc-122**: text_editor max_characters truncation — 5/5 unit tests ✅
- **sc-123**: terminal WM_CLASS detection — unicode paste in xfce4-terminal ✅
- **sc-124**: max_characters=null fallback to MAX_RESPONSE_LEN ✅

### Commits
1. `d764ad7` — feat: add max_characters param to text_editor, improve terminal detection

### Code Stats
- MCP server: ~3710 lines (up from ~3700)
- 34 MCP tools (unchanged)
- Server version: 1.24.0

### Next Steps
- [x] Clipboard paste verification (ensure content actually arrived after paste) → ✅ cycle 32
- [x] Macro: add "edit" mode to modify existing macros → ✅ cycle 32
- [ ] text_editor view_range with end=-1 edge case testing
- [x] Real-world: use text_editor for a multi-step editing workflow inside VM → ✅ cycle 32
- [x] Research: latest Computer Use API changes (new actions, params) → ✅ cycle 32 (no changes)

---

## Cycle 35 (2026-03-08)

### Container Health Monitoring & Recovery

1. **computer_health_check tool**: Deep diagnostics with 8 checks — container status, X11 display, VNC, window manager, memory usage, disk usage, top processes, and restart history. Optional `repair=true` mode auto-restarts unhealthy containers. Returns HEALTHY/DEGRADED summary with per-check status.

2. **Restart event tracking**: In-memory log of all container restarts with timestamp, reason, and success/failure. Capped at 100 entries. `restartContainer()` now logs every restart attempt. Health check reports recent restart frequency (warns if ≥3 in last hour).

3. **Improved dockerExec retry**: 2 recovery attempts with backoff (immediate + 2s delay) instead of single retry. Each attempt logs descriptive reason (e.g. "auto-recovery attempt 1"). Reduces transient failure impact.

4. **API spec verification**: Browsed Anthropic Computer Use docs in VM. Confirmed no changes since `computer_20251124` / `text_editor_20250728`. All 16 spec actions + zoom match our implementation.

### Verification Results
- **sc-136**: health check tool — all 8 diagnostics returned ok (container, x11, vnc, wm, memory 19%, disk 50%, processes, restart history) ✅
- **sc-137**: restart logging — logRestart() wired at 3 call sites, empty state handled gracefully ✅
- **sc-138**: dogfooding — browsed Anthropic docs in Firefox using navigate/scroll/key/type/triple_click ✅

**Version**: 1.28.0 | **MCP tools**: 36

## Cycle 36 (2026-03-08)

### Session Management Improvements

1. **computer_session_list tool**: List all saved session recordings in the workspace with metadata — name, action count, duration, file size, and screenshot count per session. Totals up workspace storage. Useful for managing session recordings without shell access.

2. **computer_session_compress tool**: Compress saved session recordings by removing redundant screenshots. Three modes:
   - **deduplicate**: Remove consecutive identical screenshots (MD5 hash comparison). Keeps only the last of each identical run.
   - **keyframes**: Keep every Nth screenshot (configurable interval, default 5). Removes intermediate frames while preserving visual timeline.
   - **strip**: Remove ALL embedded screenshots. Maximum compression.
   - Supports `dry_run=true` to preview changes without modifying files.
   - Tested: 754KB session → 1.6KB after strip (99.8% reduction).

3. **API spec verified**: Browsed Anthropic Computer Use docs in VM. No changes since `computer_20251124` / `text_editor_20250728`.

### Verification Results
- **sc-139**: session_list — shows 3 sessions with correct metadata (action count, duration, file size, screenshot count) ✅
- **sc-140**: session_compress — all 3 modes tested: deduplicate (0 redundant, correct), keyframes dry_run (5→3), strip (754KB→1.6KB). Error cases handled. ✅
- **sc-141**: dogfooding — browsed docs, opened terminal, verified tesseract 5.3.4 + disk 7%, recorded 6-action session ✅

**Version**: 1.29.0 | **MCP tools**: 38

## Cycle 37 (2026-03-08)

### Container Snapshots

**computer_snapshot tool**: Save, restore, list, and delete container state snapshots using docker commit. 4 modes:
- **save**: `docker commit` current container to a named snapshot image. Stores description, container name, and timestamp as Docker labels.
- **restore**: Stop current container, run from snapshot image. Cleans stale X11 lock files (`/tmp/.X*-lock`) via `--entrypoint` override before starting services — fixes display startup failure caused by docker commit capturing active lock files.
- **list**: Show all snapshots with name, container tag, size, creation date, and description.
- **delete**: Remove snapshot by name or `name="all"` to purge all. Uses `docker rmi -f` to handle images referenced by running containers.

Snapshots preserve the full container filesystem (installed packages, file changes, desktop configuration) but NOT running processes — after restore, desktop services restart fresh via start.sh.

### Bugs Found & Fixed
1. **Snapshot restore X11 lock files (Bug #24)**: `docker commit` captures `/tmp/.X1-lock` and `/tmp/.X11-unix/X1` from the running container. When restored, `Xvfb :1` in start.sh fails silently because the lock already exists. **Fix**: restore uses `--entrypoint /bin/bash -c "rm -f /tmp/.X*-lock /tmp/.X11-unix/X* && exec /start.sh"` to clean stale locks before services start.
2. **Snapshot delete fails on in-use images**: `docker rmi` refuses to delete images referenced by running containers. **Fix**: use `docker rmi -f` (force flag).

### API Research
- Browsed Anthropic Computer Use docs in VM — no changes since `computer_20251124` / `text_editor_20250728`
- Same 3 tool versions listed: 20251124, 20250124, 20241022

### Verification Results
- **sc-142**: snapshot save/list/delete — docker commands all work, restore with X11 lock cleanup: display ready at attempt 1, filesystem correctly restored ✅
- **sc-143**: dogfooding — browsed Anthropic docs, opened terminal, ran system info. All tools responsive ✅

### Commits
1. `1b158b5` — feat: add computer_snapshot tool for save/restore container state
2. `08fdedc` — fix: snapshot restore X11 lock cleanup + force delete

**Version**: 1.30.0 | **MCP tools**: 39

## Cycle 34 (2026-03-08)

### Inline Action Batching

1. **computer_batch tool**: Execute multiple actions in a single MCP call, returning only the final screenshot. Supports up to 50 actions per batch with configurable delay (0-5000ms, default 100ms). Stops on first error by default; `continue_on_error=true` skips failures and continues. Actions: left_click, right_click, middle_click, double_click, triple_click, left_click_drag, type, key, mouse_move, scroll, left_mouse_down, left_mouse_up, wait.
2. **Real-world verification**: Used batch to write and execute a Python sysinfo script in VM terminal — 5 actions (heredoc write + execute) in a single tool call. Previously would have required 5 separate calls.

**Version**: 1.27.0 | **MCP tools**: 35

## Cycle 33 (2026-03-08)

### Macro Dry-Run Mode & Screenshot Performance Optimization

1. **Macro dry-run mode**: `dry_run=true` in run mode lists all actions with their parameters (coordinates, text, scroll direction, duration, etc.) without executing. Shows repeat count and speed configuration in header.

2. **Screenshot latency optimization**: Benchmarked 4 screenshot methods inside the container:
   - scrot PNG: ~17-22ms (128KB)
   - import PNG: ~37-42ms (127KB)
   - scrot + convert JPEG: ~29-32ms (86KB)
   - **scrot direct JPEG: ~4-6ms (92KB)** ← 6x faster

   Implemented fast path: when no coordinate scaling needed (common 1024x768 case), use scrot's native JPEG output (`-q` flag) instead of scrot PNG + ImageMagick convert. Eliminates a second docker exec + convert process spawn.

3. **text_editor edge case verification**: Tested view_range with end=-1 (EOF), single line [1,1], last line [20,20], out-of-range start (0 and 21), reversed range [10,5], max_characters truncation, directory listing, nonexistent path — all pass correctly with proper error messages.

4. **API monitoring**: Browsed Anthropic docs in VM. Confirmed `computer_20251124` still latest, now listing Opus 4.6/Sonnet 4.6 models. No new actions or parameters. `text_editor_20250728` unchanged.

**Version**: 1.26.0 | **Tools**: 34 | **Commits**: 2

## Cycle 32 (2026-03-08)

### Clipboard Paste Verification & Race Fix

Two improvements to clipboard-based typing reliability:

**1. Read-back verification** — after setting clipboard, read it back and compare. If mismatch, retry once. Only for content ≤10KB (larger content too expensive to round-trip). Catches xclip failures, encoding issues, and X11 selection race conditions.

**2. Paste safety dialog race fix** — XFCE terminal's "Potentially Unsafe Paste" dialog blocked multi-line clipboard paste. The 0.3s clipboard restore ran while the dialog was shown, causing the wrong content to be pasted.
- **Fix 1**: Changed clipboard restore from blocking `sleep 0.3` to background `nohup ... &` with 2s delay. Non-blocking—type action returns immediately.
- **Fix 2**: Disabled XFCE terminal unsafe paste dialog via `xfconf-query -c xfce4-terminal -p /misc-show-unsafe-paste-dialog -s false` (added to container `start.sh`).

### Macro Edit Mode

Added `mode="edit"` to `computer_macro` tool. Loads existing macro, replaces actions array, validates, writes back. Preserves name/source/created, updates actions/description/count + adds `modified` timestamp.

Schema: `computer_macro(mode="edit", name="my-macro", actions="[new JSON array]")`

### API Research: Implementation is Current

Researched latest Anthropic docs (March 2026). Findings:
- No new actions since `computer_20251124`
- No new text_editor versions since `text_editor_20250728`
- Our 34 MCP tools exceed the official 16-action spec with 18 bonus tools
- `max_characters` param (added cycle 31) matches latest spec exactly

### Real-World Dogfooding
- Created Python fibonacci script via `computer_bash`
- Opened in Mousepad GUI editor
- Used Find & Replace (Search menu → Ctrl+R) to change 15→20 occurrences
- Saved with Ctrl+S, ran in terminal — correct output (20 fibonacci numbers + F(50)=12586269025)
- Tested multi-line paste in terminal after paste dialog fix — no dialog, content pasted correctly

### Bug Found: Clipboard Paste Race Condition (Bug #23)
**Problem**: `clipboardPaste()` restored original clipboard after 0.3s blocking sleep. XFCE terminal's paste safety dialog intercepted the paste, but by the time it was confirmed (>0.3s), the clipboard had already been restored to old content, pasting wrong text.
**Root cause**: Synchronous `sleep 0.3` in `dockerExec` was too short for GUI interactions.
**Fix**: Background restore (nohup + 2s) + disable paste dialog entirely.

### Verification Results
- **sc-125**: clipboard read-back verification — 4/4 tests (basic text+emoji, multi-line, shell chars, file-based) ✅
- **sc-126**: macro edit mode — save→edit→verify round-trip, preserves metadata ✅
- **sc-127**: real-world dogfooding — full create→edit→save→run workflow in VM ✅
- **sc-128**: clipboard paste race fix — multi-line paste in terminal, no dialog ✅

### Commits
1. `66b4c9e` — feat: add clipboard paste verification and macro edit mode
2. `93fba69` — fix: clipboard paste race condition with XFCE paste safety dialog

### Code Stats
- MCP server: ~3787 lines (up from ~3710)
- 34 MCP tools (unchanged — edit is a mode, not a new tool)
- Server version: 1.25.0

### Next Steps
- [ ] text_editor view_range edge case testing (end=-1, large files)
- [ ] Macro dry-run mode (preview without executing)
- [ ] Computer Use API: monitor for 2026 updates
- [ ] Explore: idle detection (auto-screenshot if no actions for N seconds)
- [ ] Performance: benchmark screenshot latency, optimize if >500ms

---

## Cycle 38 (2026-03-08)

### New Features

#### Container Resource Limits (env_create)
- `memory_mb` and `cpus` params added to `computer_env_create`
- Docker `--memory` and `--cpus` flags applied to `docker run`
- Limits preserved across `restartContainer()` and `computer_snapshot` restore
- Shown in `computer_env_list` output (e.g. `limits:512MB/1cpu`)

#### computer_scrape (Content Extraction)
- Extract text from focused window via select-all + copy to clipboard
- Two methods: `select_all` (Ctrl+A → Ctrl+C, default) and `visible` (just copy current selection)
- Much faster and more accurate than OCR for browser pages, editors, terminals
- Saves original clipboard, restores in background after extraction
- Truncates output to 16KB with char count

#### computer_notify (Desktop Notifications)
- Display desktop notifications inside the container via `notify-send`
- Configurable: title, body, urgency (low/normal/critical), icon, timeout
- Useful for signaling status to VNC observers or testing notification flows
- Required adding `libnotify-bin` + `xfce4-notifyd` to Dockerfile

#### computer_inspect (Window/Element Inspection)
- Structured JSON output for window properties: class, instance, PID, position, size, state, type
- Three modes:
  - `active`: inspect focused window
  - `all`: list all visible application windows (filters internal XFCE windows)
  - `at`: find window at specific API coordinate
- Uses `xprop`, `xdotool`, `xwininfo` (requires `x11-utils`)
- Coordinates in API space (auto-scaled from display coords)

### API Research
- API unchanged: `computer_20251124` and `text_editor_20250728` still latest
- Anthropic now references Mutter + Tint2 as their desktop (we use XFCE — fine)
- Sonnet 3.7 now marked as deprecated
- Competitor landscape: Playwright MCP (28.4k stars) leads with accessibility tree snapshots, Windows-MCP (4.6k) has multiselect/multiedit. Our 41 tools exceed all competitors in scope.

### Real-World Dogfooding
- Browsed HN in Firefox, clicked articles, navigated GitHub repos
- Scrolled, used back button, opened terminal alongside browser
- Typed and executed shell commands in terminal
- Tested desktop notification (visible in screenshot top-right)
- No bugs found — all actions smooth

### Commits
1. `ea323f4` — feat: add memory_mb and cpus resource limits to env_create
2. `a7522ef` — feat: add computer_scrape and computer_notify tools
3. `1e5124e` — feat: add computer_inspect tool for window/element inspection

### Code Stats
- MCP server: ~4730 lines (up from ~4470)
- 41 MCP tools (up from 38)
- Server version: 1.31.0

### Next Steps
- [ ] AT-SPI accessibility tree extraction (needs Dockerfile + Python bindings)
- [ ] Web content extraction in computer_navigate (return page text + title)
- [ ] Monitor for API updates (next check in ~3 cycles)

---

## Cycle 39 (2026-03-08)

### Bug Fixes
- **computer_scrape terminal fix**: Terminals use `ctrl+shift+a`/`ctrl+shift+c` for select-all/copy. Old code sent `ctrl+a` (readline begin-of-line) + `ctrl+c` (SIGINT) — both wrong, returned empty text. Now auto-detects terminal via `isTerminalWindow()` helper and uses correct shortcuts.

### New Features

#### Resolution Presets (computer_env_resize)
- Added `preset` param with 7 device profiles:
  - `mobile_portrait` (375x812), `mobile_landscape` (812x375)
  - `tablet_portrait` (768x1024), `tablet_landscape` (1024x768)
  - `laptop` (1366x768), `desktop_hd` (1920x1080), `desktop_4k` (3840x2160)
- Custom width/height still supported, can override preset values
- Preset name shown in response text

#### isTerminalWindow() Helper
- Extracted terminal detection from `clipboardPaste()` inline code
- Shared by `clipboardPaste()` and `computer_scrape`
- Detects via WM_CLASS (xfce4-terminal, gnome-terminal, xterm, etc.) + window name fallback

### Real-World Dogfooding
- Tested all 3 cycle-38 tools via MCP: inspect (all/at modes), scrape (Firefox full page), notify
- Scraped full HN front page (30 stories) via computer_scrape — text accurate
- Discovered terminal scrape bug through actual usage — fixed same cycle
- Desktop notification rendered correctly in top-right corner

### Commits
1. `96a9942` — feat: fix terminal scrape, add resolution presets, extract isTerminalWindow helper

### Code Stats
- MCP server: ~4773 lines (up from ~4730)
- 41 MCP tools (unchanged)
- Server version: 1.32.0

### Next Steps
- [x] AT-SPI accessibility tree extraction → done in cycle 40
- [ ] Web content extraction in computer_navigate (return page text + title)
- [ ] Monitor for API updates (next check in ~2 cycles)

---

## Cycle 40 (2026-03-08)

### New Feature: computer_accessibility (AT-SPI2)

Major new tool — extracts the full accessibility tree from the desktop via AT-SPI2 (Assistive Technology Service Provider Interface). Provides **semantic UI understanding** that OCR alone cannot: buttons, menus, text fields, links, headings, with bounding boxes and available actions.

#### Docker Changes
- **Dockerfile**: Added `at-spi2-core`, `libatk-adaptor`, `gir1.2-atspi-2.0` packages
- **start.sh**: AT-SPI2 bus launcher + accessibility env vars (`GTK_MODULES`, `GNOME_ACCESSIBILITY`, `QT_ACCESSIBILITY`) started BEFORE XFCE so all apps register on the a11y bus. DBUS_SESSION_BUS_ADDRESS persisted to `/tmp/dbus-session` for docker exec access.
- **a11y_tree.py**: Python script at `/usr/local/bin/a11y_tree.py` using `gi.repository.Atspi`

#### MCP Tool: computer_accessibility
- **4 modes**: `all` (entire desktop), `app` (by name), `window` (by title), `diagnose` (bus health)
- **Configurable**: `max_depth` (1-100, default 10), `include_text`, `flat` (list vs tree)
- **Bounding boxes** converted from display to API coordinate space
- **Output truncation** at 16KB with helpful message about using lower depth/filters
- **Screenshot** included with every response

#### Test Results
- Diagnose: 12 apps on accessibility bus (xfce4-session, xfwm4, xfce4-panel, Thunar, Firefox, etc.)
- Firefox/Example Domain at depth 15: **813 nodes** including full DOM semantics:
  - `heading`: "Example Domain" with bbox
  - `paragraph` elements
  - `link`: "Learn more" with exact clickable coordinates
  - Full browser chrome: tabs, menus, navigation bar, URL bar
- GTK apps (XFCE terminal, Thunar, Mousepad) also expose rich a11y trees

#### Why This Matters
- Comparable to Playwright MCP's a11y tree snapshots, but for the **entire desktop** (not just the browser)
- Enables agents to understand UI semantics without OCR guessing
- Actionable: bounding boxes map to API coordinates for clicking
- Roles/states tell you what you can do (is it clickable? editable? focused?)

### Commits
1. `033759a` — feat: add computer_accessibility tool — AT-SPI2 accessibility tree extraction

### Code Stats
- MCP server: ~4886 lines (up from ~4773)
- 42 MCP tools (up from 41)
- Server version: 1.33.0

### Next Steps
- [x] Web content extraction in computer_navigate → done in cycle 41
- [ ] Monitor for API updates (next check in ~2 cycles)
- [x] Accessibility-driven click helper → done in cycle 41 (computer_a11y_click)
- [x] Real task: use a11y tree for productive work in VM → done in cycle 41

---

## Cycle 41 (2026-03-08)

### New Features

#### computer_navigate `extract_content` param
When `extract_content=true`, the navigate tool now also returns:
- **Page title**: extracted from window title bar (strips " — Mozilla Firefox" suffix)
- **Full page text**: via select-all + clipboard copy, with background clipboard restore

This enables agents to read web page content without OCR — much faster and more accurate for text-heavy pages.

#### computer_a11y_click (Tool #43)
Click UI elements by accessibility role and name — no coordinates needed. Queries the AT-SPI2 accessibility tree to find matching elements, then clicks at their center.

- **Parameters**: `role` (push button, link, menu item, etc.), `name` (substring match, case-insensitive), `app` (filter by app), `window_title` (filter by window), `click_type` (left/right/double), `index` (Nth match)
- **AT-SPI2 query**: flat tree at depth 20, filters by role/name, returns all matches with bounding boxes
- **Click execution**: converts a11y bbox center to API coordinates, performs click, returns screenshot
- **Error handling**: descriptive messages for no matches, no bbox, AT-SPI failures

#### Real-World Dogfooding
- Navigated to example.com with `extract_content=true` — got title + full page text
- Used `a11y_click` to click "Learn more" link by role+name — navigated to IANA page
- Navigated to Hacker News with `extract_content=true` — extracted all 30 story titles + metadata
- Used `a11y_click` to click article link by partial name match — opened blog post
- Both tools combined enable semantic web browsing: read content → click by meaning, not coordinates

### Commits
1. `174ebb0` — feat: add extract_content to computer_navigate, add computer_a11y_click tool

### Code Stats
- MCP server: ~5050 lines (up from ~4886)
- 43 MCP tools (up from 42)
- Server version: 1.34.0

### Next Steps
- [ ] Monitor for API updates (next check in ~2 cycles)
- [x] Accessibility-driven form filling → done in cycle 42 (computer_a11y_type)
- [ ] Browser tab management tool (list/close/switch tabs)
- [ ] Performance: reduce screenshot latency on high-frequency operations

---

## Cycle 42 (2026-03-08)

### New Features

#### computer_a11y_type (Tool #44)
Type text into UI elements found by accessibility role/name — no coordinates needed. Finds the element via AT-SPI2, clicks to focus it, optionally clears existing content (ctrl+a + Delete), then types. Supports unicode via clipboardPaste and short ASCII via xdotool type.

- **Parameters**: `role`, `name` (element filter), `text` (to type), `clear_first` (default true), `app`, `window_title`, `index`
- Ideal for form fields, search boxes, URL bars, text inputs

#### computer_a11y_read (Tool #45)
Read properties of UI elements without clicking — returns structured JSON about matching elements. Useful for verifying UI state programmatically (is this button enabled? is this checkbox checked?).

- **Returns**: role, name, states, text content, value, available actions, bounding box (API coords), a11y tree path
- **Parameters**: `role`, `name`, `app`, `window_title`, `max_results`, `include_text`

#### queryA11yFlat() Helper
Shared helper extracted from computer_a11y_click — queries AT-SPI2 flat tree and filters by role/name. Reused by all 3 a11y interaction tools (click, type, read), eliminating code duplication.

### Bug Fix
- `computer_a11y_read`: Used `--include-text` flag (doesn't exist) instead of `--no-text` (the actual flag). Default is text included; `--no-text` disables it.

### Real-World Dogfooding
- Used `a11y_type` to type URL into Firefox address bar by role="entry" name="Search" — worked perfectly
- Pressed Enter to navigate to httpbin.org/get — JSON response loaded
- Used `a11y_read` to enumerate 27 push buttons and 196 links in Firefox with full state/action data
- Full semantic browsing workflow: navigate → read page → type into fields → verify state — all via a11y

### Commits
1. `fddc0de` — docs: update PROGRESS.md with cycle 41, bump version to 1.34.0
2. `6678beb` — feat: add computer_a11y_type and computer_a11y_read tools, extract queryA11yFlat helper
3. `653486c` — fix: computer_a11y_read uses --no-text flag (not --include-text)

### Code Stats
- MCP server: ~5300 lines (up from ~5050)
- 45 MCP tools (up from 43)
- Server version: 1.35.0

### Next Steps
- [x] Browser tab management tool (list/close/switch tabs) → done in cycle 43
- [ ] Performance: reduce screenshot latency on high-frequency operations
- [ ] A11y-driven form automation (fill multiple fields in one call)

## Cycle 43 (2026-03-08)

### New Features

#### computer_tabs (Tool #46)
Browser tab management using AT-SPI2 accessibility tree. 4 actions: list, switch, close, new.

- **list**: Shows all browser tabs with index, title, active marker (→). Optional `include_url=true` reads active tab URL from address bar.
- **switch**: Activate a tab by index (0-based) or title substring (case-insensitive).
- **close**: Close a tab by index or title substring. Safety guard prevents closing last tab.
- **new**: Open new tab, optionally navigate to a URL.
- Filters browser tabs from in-page tabs (e.g. JSON/Raw Data/Headers) using a11y tree path (must be under "Browser tabs" toolbar).

### Research: Anthropic API Status
- No API changes since `computer_20251124` — still the latest computer use tool version
- No new text editor version since `text_editor_20250728`
- New Anthropic tools (code_execution, web_search, web_fetch) are server-side hosted tools — not relevant to desktop computer use
- Project remains fully spec-compliant with 46 tools exceeding all competitors

### Real-World Dogfooding
- Listed 5 browser tabs with titles and active URL extraction (https://httpbin.org/get)
- Switched to "Example Domain" tab by title substring — page loaded correctly
- Closed "Firefox Privacy Notice" tab — 4 tabs remaining confirmed
- Opened new tab with https://news.ycombinator.com — HN loaded successfully

### Commits
1. `69c5975` — feat: add computer_tabs tool for browser tab management

### Code Stats
- MCP server: ~5500 lines (up from ~5300)
- 46 MCP tools (up from 45)
- Server version: 1.36.0

### Next Steps
- [ ] Performance: reduce screenshot latency on high-frequency operations
- [x] A11y-driven form automation (fill multiple fields in one call) → done in cycle 44
- [ ] A11y-driven scroll (scroll within specific elements, not just the viewport)
- [ ] Monitor for Anthropic API updates (next check in ~3 cycles)

## Cycle 44 (2026-03-08)

### New Features

#### computer_a11y_fill (Tool #47)
Fill multiple form fields in one call using AT-SPI2 accessibility tree. Single tree query, sequential field fills.

- **fields**: Array of `{name, role, text, clear_first, index}` specs (1–20 fields)
- **tab_between**: Optional Tab key navigation between fields (faster when tab order matches)
- **submit**: Optional Enter press after the last field (for form submission)
- **app/window_title**: Filter to specific application or window
- Tested on httpbin.org/forms/post: filled Customer name, Telephone, E-mail in one call ✓

#### computer_tabs URL-all mode
Enhanced `computer_tabs list` to read URLs for ALL tabs, not just the active one.

- **include_url_mode="all"**: Switches to each tab, reads URL bar, switches back to original
- **include_url_mode="active"** (default): Fast path, only reads active tab URL
- Fixed bug where active tab got wrong URL (skipped click for originally-active tab)
- Tested: 5 tabs all returned correct URLs ✓

### Bug Fixes
- **tabs URL-all active tab bug**: When reading all tab URLs, the originally-active tab wasn't clicked before reading its URL bar. By that point we'd switched to another tab, so it read the wrong URL. Fix: always click each tab regardless of initial active state.

### Real-World Dogfooding
- Filled 3 form fields on httpbin.org/forms/post in one a11y_fill call
- Read URLs for all 5 browser tabs — all correct

### Commits
1. `38b069d` — feat: add computer_a11y_fill tool, enhance tabs URL listing
2. `4e6a2a8` — fix: tabs URL-all mode reads wrong URL for active tab

### Code Stats
- MCP server: ~5650 lines (up from ~5500)
- 47 MCP tools (up from 46)
- Server version: 1.37.0

### Next Steps
- [ ] Performance: reduce screenshot latency on high-frequency operations
- [ ] A11y-driven scroll (scroll within specific elements, not just the viewport)
- [ ] Test a11y_fill with tab_between=true and submit=true modes
- [ ] Monitor for Anthropic API updates (next check in ~2 cycles)

## Cycle 45 (2026-03-08)

### New Features

#### computer_a11y_select (Tool #48)
Select, check, or toggle UI elements by accessibility role/name. Completes the a11y form automation toolkit alongside a11y_fill.

- **Checkboxes**: Toggle on/off, or specify desired state (`value: "checked"/"unchecked"`) — skips if already correct
- **Radio buttons**: Click to select, skips if already selected
- **Combo boxes/dropdowns**: Expand → find option by name → click. Handles both menu items and list items
- **Toggle buttons**: Same as checkboxes (toggle/desired state)
- **Batch**: Up to 20 elements per call, single a11y tree query
- **State-aware**: Reports `already_checked`/`already_selected` with `○` icon vs `✓` for actions taken
- **Generic fallback**: Unknown roles just get clicked
- Tested on httpbin.org/forms/post: radio buttons (3/3), checkboxes (4/4, state-awareness verified) ✓
- Tested on w3schools select element: combo box Volvo→Saab ✓

### Real-World Dogfooding
- Full form interaction on httpbin.org: text fill (a11y_fill) + radio select + checkbox toggle + combo box selection
- Browsed w3schools HTML select tutorial, tested combo box on live iframe

### Commits
1. `50f8cf9` — feat: add computer_a11y_select tool for checkboxes, radio buttons, combo boxes

### Code Stats
- MCP server: ~5800 lines (up from ~5650)
- 48 MCP tools (up from 47)
- Server version: 1.38.0

### Next Steps
- [x] Test a11y_fill with tab_between=true and submit=true modes
- [ ] Performance: reduce screenshot latency on high-frequency operations
- [ ] A11y-driven scroll (scroll within specific elements, not just the viewport)
- [ ] Monitor for Anthropic API updates (next check in ~1 cycle)

## Cycle 46 (2026-03-08)

### Bug Fixes

#### A11y showing-state fix (da1cec2)
Firefox's a11y tree sometimes produces duplicate entries for the same element. The first (non-showing) entry may have stale state — e.g., a checkbox reports "checked" when it's actually unchecked visually. Fixed by sorting all a11y matches to prefer elements with "showing" state.

- **Before**: `a11y_select` on unchecked Bacon checkbox falsely reported "already_checked"
- **After**: Correctly clicks the checkbox (verified on httpbin form)
- Affects: `queryA11yFlat`, `a11y_select`, `a11y_fill`, and all a11y tools

### New Features

#### sortByNameRelevance helper (45578c3)
Smarter a11y element matching that prefers: exact name > starts-with > shorter name (closer match). Replaces simple substring matching.

- **Before**: `name: "Delivery"` matched "Preferred delivery time" before "Delivery instructions"
- **After**: Matches "Delivery instructions" first (starts with query, shorter name)
- Applied to: `queryA11yFlat`, `a11y_select`, `a11y_fill`

### Testing

#### a11y_fill modes verified
- `tab_between=true`: fills fields using Tab between them instead of clicking each ✓
- `submit=true`: presses Enter after last field to submit form ✓
- Full form flow on httpbin.org: fill 3 text fields + select radio + check 2 checkboxes + submit → JSON response confirmed all data ✓

### Commits
1. `da1cec2` — fix: prefer 'showing' a11y elements over duplicates with stale state
2. `45578c3` — feat: add sortByNameRelevance for smarter a11y element matching

### Code Stats
- MCP server: ~5850 lines
- 48 MCP tools (unchanged)
- Server version: 1.39.0

### Next Steps
- [x] A11y-driven scroll — done in cycle 47 (ensure_visible)
- [ ] Performance: reduce screenshot latency on high-frequency operations
- [ ] Monitor for Anthropic API updates

## Cycle 48 (2026-03-08)

### New Features

#### computer_a11y_wait — semantic element polling (9427b47)
New tool that waits for accessibility elements to appear or disappear using the AT-SPI2 tree. Much more reliable than OCR-based `wait_for_text` for UI elements like buttons, links, dialogs, and spinners.

Parameters:
- `role` / `name` — element matching (same as other a11y tools)
- `mode` — `"appear"` (default) or `"disappear"`
- `timeout` — 1-60s (default 10)
- `interval` — 200-5000ms poll interval (default 500)
- `click` — auto-click when found (appear mode only)
- `require_showing` — require AT-SPI2 "showing" state (visible on screen)
- `app` / `window_title` — filtering

### Bug Fixes

#### a11y_wait timeout must not use isError (f250889)
MCP SDK returns "Unknown error" when tool handlers return `isError: true` with image content. Timeout is an expected outcome (not an error), so changed to return a normal response — matching the `wait_for_text` pattern.

### Testing

1. **Appear mode**: Waited for "Learn more" link on example.com → found after 1.2s (1 poll) ✓
2. **Disappear mode**: Waited for "Learn more" to disappear → timed out gracefully after 4.6s with clear message ✓
3. **Click mode**: Waited for "FrameBook" link on HN → found and auto-clicked, navigated to fb.edoo.gg ✓

### Commits
1. `9427b47` — feat: add computer_a11y_wait for semantic element polling
2. `f250889` — fix: a11y_wait timeout returns normal response, not isError

### Code Stats
- MCP server: ~6060 lines (+110)
- 49 MCP tools (+1)
- Server version: 1.41.0 → 1.42.0

### Next Steps
- [ ] Performance: reduce screenshot latency on high-frequency operations
- [ ] A11y form validation reading (read error messages after submit)
- [ ] Smart form fill: combine a11y_fill + a11y_select in one call
- [ ] Monitor for Anthropic API updates

---

## Cycle 49 (2026-03-08)

### Performance Optimization

#### Combined docker exec calls for screenshots (6c5d1b6)
Reduced docker exec round trips across multiple tools:
- **takeScreenshot** fast path: 2 calls → 1 (scrot + base64 + cleanup in single exec)
- **takeScreenshot** standard path: 3 calls → 1 (scrot + convert + base64 in single exec)
- **zoom** tool: 3 calls → 1 (scrot + convert crop/resize + base64)
- **wait_for** region capture: 3 calls → 1
- **scroll_to** stuck detection hash: 2 calls → 1

Benchmarked: single combined call averages ~45ms vs ~75ms for 2 calls (~40% faster per screenshot).

### New Features

#### computer_tabs close_others action (600d893)
New `close_others` action closes all browser tabs except the active one (or a specified target tab). Closes from right to left to avoid index shift issues. Useful for cleanup after testing sessions.

#### Tabs close tooltip fix (600d893)
After closing a tab, mouse cursor now moves to viewport center to prevent Firefox tab preview tooltips from appearing. Previously required manual Escape key to dismiss.

### Research: Anthropic API Status
- No new tool versions beyond `computer_20251124` and `text_editor_20250728`
- Claude Sonnet 5 ("Fennec") leaked on Vertex AI but not officially released for computer use
- Anthropic acquired Vercept (Feb 25, 2026) — macOS computer-use AI startup
- Our v1.42.0 remains fully spec-compliant

### Testing
1. **Screenshot optimization**: Verified screenshot, zoom, and click actions all work correctly with combined docker exec calls ✓
2. **Real usage**: Browsed Hacker News, extracted content, cleaned up 14 stale tabs ✓
3. **close_others**: Code verified syntactically, needs MCP reload for runtime test (next cycle) ⏳

### Commits
1. `6c5d1b6` — perf: combine multi-call docker exec into single calls for screenshots
2. `600d893` — feat: add close_others to tabs, fix close tooltip, optimize docker exec

### Code Stats
- MCP server: ~6110 lines (+50)
- 49 MCP tools (unchanged — close_others is a new action on existing tool)
- Server version: 1.42.0

### Next Steps
- [x] Test close_others after MCP reload → Fixed phantom tab bug (cycle 50)
- [ ] A11y form validation reading (read error messages after submit)
- [ ] Smart form fill: combine a11y_fill + a11y_select in one call
- [ ] Investigate Sonnet 5 / Fennec computer use compatibility when released

## Cycle 51 (2026-03-08)

### Feature: exact_role parameter for all a11y tools (95def38)

Audited all a11y tools for the same substring role matching bug that caused the phantom tab issue in cycle 50. Found 4 locations with `.includes()` role matching that could cause false positives:
1. `queryA11yFlat()` — used by a11y_click, a11y_type
2. `computer_a11y_read` — inline filter
3. `computer_a11y_select` — inline filter
4. `computer_a11y_fill` — inline filter

**Fix**: Added `exact_role` boolean parameter (default `false`) to all 6 a11y tools + shared helpers:
- `queryA11yFlat()` and `scrollToA11yElement()` — core helpers
- `computer_a11y_click`, `computer_a11y_type`, `computer_a11y_read` — individual tools
- `computer_a11y_select`, `computer_a11y_fill`, `computer_a11y_wait` — batch tools

When `exact_role=true`, uses `===` instead of `.includes()` for role comparison. Default `false` preserves backward compatibility (e.g. `role="button"` still matches "push button").

**Verified**:
- `exact_role=false` + `role="page tab"` → 3 results (includes "page tab list") ✓
- `exact_role=true` + `role="page tab"` → 2 results (only "page tab") ✓
- `a11y_click` with `exact_role=true` → clicked correct tab ✓

### Real-world test: httpbin pizza form
Full a11y workflow end-to-end:
- `a11y_fill`: 3 text fields (name, phone, email) — all correct
- `a11y_select`: 1 radio button (Large), 2 checkboxes (Bacon, Mushroom) — all correct
- `a11y_click`: Submit button — form submitted, JSON response confirmed all values

### Code Stats
- MCP server: ~6120 lines
- 49 MCP tools
- Server version: 1.43.0

### Next Steps
- [ ] A11y form validation reading (read error messages after submit)
- [ ] Smart form fill: combine a11y_fill + a11y_select in one call
- [ ] Investigate adaptive screenshot delay (shorter for simple actions)

## Cycle 50 (2026-03-08)

### Critical Bug Fix: Phantom Tab in getBrowserTabs

#### Root cause discovery (38a782e)
`getBrowserTabs()` used `queryA11yFlat({ role: "page tab" })` which **substring-matched** `"page tab list"` (the AT-SPI2 container element for all tabs). This phantom entry:
- Had empty name → appeared as "(untitled)" in tab lists
- Had bbox covering the **entire tab bar** (x:42, y:51, width:942, height:44)
- When `clickTab()` targeted it, xdotool clicked the center of the whole tab bar, landing on random real tabs

**Impact**: Every tab-related operation was affected:
- `tabs list` showed inflated count (N+1 tabs)
- `close_others` clicked phantom → closed random tabs including keep tab → Firefox exited
- `close` could target wrong tab by index (off by one)

**Fix**: Added exact role filter `node.role === "page tab"` in `getBrowserTabs()`, rejecting `"page tab list"`.

#### close_others reimplemented
After fixing the phantom tab, close_others now:
1. Re-queries a11y tree before each close (fresh bbox coordinates)
2. Finds victim by title !== keepTitle
3. Clicks victim (accurate coords), waits 500ms, Ctrl+W
4. Repeats until 1 tab remains
5. Moves mouse to viewport center to prevent tooltip

Tested with both `target` param and default (keep active) modes. Both pass.

### Commits (5 iterations to diagnose)
1. `73deca1` — fix: close_others uses Firefox native context menu (failed: a11y can't find menu items)
2. `2bc6da0` — fix: close_others re-queries tabs before each close (failed: phantom tab)
3. `48a7c02` — fix: close_others increases delays, adds stuck detection (failed: phantom tab)
4. `59cf3d7` — fix: close_others uses keyboard-only Ctrl+Tab + Ctrl+W (failed: phantom tab)
5. `38a782e` — **fix: getBrowserTabs filters by exact role** — root cause fix

### Code Stats
- MCP server: ~6110 lines (net unchanged — added exact role filter, simplified close_others)
- 49 MCP tools
- Server version: 1.42.1

### Next Steps
- [ ] A11y form validation reading (read error messages after submit)
- [ ] Smart form fill: combine a11y_fill + a11y_select in one call
- [ ] Investigate adaptive screenshot delay (shorter for simple actions)

## Cycle 47 (2026-03-08)

### New Features

#### ensure_visible auto-scroll for a11y tools (d786682)
Added `scrollToA11yElement()` shared helper that detects off-screen elements (missing AT-SPI2 "showing" state) and automatically scrolls the viewport to bring them into view before interaction. Up to 10 scroll attempts with re-query for fresh coordinates after each scroll.

Added `ensure_visible` param (default: `true`) to:
- `computer_a11y_click` — scrolls before clicking
- `computer_a11y_type` — scrolls before typing
- `computer_a11y_select` — per-element scroll in batch operations
- `computer_a11y_fill` — per-field scroll in batch operations

- **Before**: Off-screen elements (below the fold) were clicked at wrong coordinates or missed entirely
- **After**: Elements are auto-scrolled into view, then interacted with using fresh coordinates
- **How it works**: Checks "showing" state → if missing, calculates scroll direction/amount from bbox → scrolls via xdotool → re-queries a11y tree → repeats until visible or max attempts

### Testing

#### ensure_visible verified on httpbin form
1. `a11y_click` on off-screen "Submit order" button → scrolled down, clicked, form submitted ✓
2. `a11y_fill` with mix of visible ("Customer name") and off-screen ("Delivery instructions") fields → filled both ✓
3. `ensure_visible=false` on visible "Medium" radio → clicked without scrolling, no regression ✓
4. Full form flow: fill 4 text fields + select Large radio + check Bacon/Mushroom + submit → all data in JSON response ✓

### Commits
1. `d786682` — feat: add ensure_visible auto-scroll to a11y tools

### Code Stats
- MCP server: ~5950 lines (+100)
- 48 MCP tools (unchanged — enhanced existing tools)
- Server version: 1.40.0

### Next Steps
- [ ] Performance: reduce screenshot latency on high-frequency operations
- [ ] A11y form validation reading (read error messages after submit)
- [ ] Smart form fill: combine a11y_fill + a11y_select in one call
- [ ] Monitor for Anthropic API updates
