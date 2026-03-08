# Computer Use MCP Server — Progress

## Cycle 1 (2026-03-08)

### Container Status
- Docker container `computer-use` running (Ubuntu 24.04 ARM64)
- Xvfb :1 at 1024x768x24
- XFCE4 desktop, x11vnc on :5900, noVNC on :6080
- xdotool, ImageMagick (import/convert), scrot all available
- Firefox installed

### What Works
- **screenshot**: Captures via `import -window root`, base64 encodes, returns as image content ✅
- **left_click**: mousemove + click 1 ✅
- **right_click**: mousemove + click 3 ✅
- **middle_click**: mousemove + click 2 ✅
- **double_click**: mousemove + click --repeat 2 ✅
- **triple_click**: mousemove + click --repeat 3 ✅
- **type**: xdotool type with --clearmodifiers ✅
- **key**: xdotool key with key mapping ✅
- **mouse_move**: xdotool mousemove ✅
- **scroll**: mousemove + click button 4/5/6/7 ✅
- **left_mouse_down**: mousedown 1 ✅
- **left_mouse_up**: mouseup 1 ✅
- **hold_key**: keydown + nested action + keyup ✅
- **wait**: setTimeout + screenshot ✅
- **zoom**: import + convert crop + resize ✅
- **left_click_drag**: mousemove + mousedown + mousemove + mouseup ✅
- **computer_bash**: docker exec with configurable timeout ✅
- **computer_status**: container status + display geometry check ✅

### Bugs Found & Fixed
1. **`--sync` flag hangs**: `xdotool mousemove --sync` hangs indefinitely in Xvfb. Removed all `--sync` flags.
2. **`xdpyinfo` not installed**: Replaced with `xdotool getdisplaygeometry` for display health check.
3. **`left_click_drag` non-standard params**: Fixed to use spec-compliant `start_coordinate` + `coordinate` (end). Removed non-standard `end_coordinate`.
4. **`.mcp.json` missing**: Created for Claude Code auto-loading.

### Known Issues
- MCP server needs recycle after edits to reload
- `hold_key` uses `key_to_hold` param instead of spec's `text` (intentional to avoid param collision)
- No input validation for coordinate bounds (should be within 0-1024, 0-768)

### Next Steps
- [ ] Add coordinate bounds validation
- [ ] Research Anthropic's reference implementation (subagent running)
- [ ] Research other MCP computer-use implementations (subagent running)
- [ ] Add scrot as fallback for screenshot capture
- [ ] Add proper error messages for common failures
- [ ] Test with actual browser automation workflow (open Firefox, navigate, etc.)
- [ ] Multi-container support
- [ ] Resolution switching
