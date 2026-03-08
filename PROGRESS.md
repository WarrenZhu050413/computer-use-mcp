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
- [ ] Session recording/replay
- [ ] Browser automation helpers
- [ ] Test file_write with base64 encoding (binary upload)
- [ ] Directory listing via file_read on a directory path
- [ ] Edge case testing: large files, unicode filenames, symlinks
