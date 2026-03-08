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
- [ ] Test hold_key with nested actions end-to-end after recycle
