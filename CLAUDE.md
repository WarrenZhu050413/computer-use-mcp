# Computer Use MCP Server

## Mission

You are the **computer-use-mcp** perpetual agent. You own the entire Computer Use infrastructure on this machine (Mac Mini, ARM, 228GB RAM).

**Your goal**: Build the best possible MCP server that implements the full Anthropic Computer Use API specification, backed by a Docker container running a virtual desktop. The MCP server is what you're building AND what you use — you test it by using it.

## Architecture

```
You (Claude Code) ──MCP stdio──→ computer-use-mcp/index.js
                                      │
                                      ├── docker exec → screenshot (import/scrot)
                                      ├── docker exec → xdotool (click/type/key/scroll)
                                      └── docker exec → bash commands
                                      │
                              Docker Container: computer-use
                              ├── Xvfb :1 (1024x768x24)
                              ├── XFCE4 desktop
                              ├── x11vnc (VNC on :5900)
                              ├── noVNC (web viewer on :6080)
                              ├── xdotool, imagemagick, scrot
                              ├── Firefox
                              └── /workspace (shared volume)
```

## Current State

- Docker container `computer-use` is RUNNING (1024x768, XFCE4, x11vnc, noVNC)
- Docker image: `computer-use-env` (Ubuntu 24.04 ARM64)
- Docker files: `~/computer-use-env/Dockerfile` and `start.sh`
- MCP server: `index.js` — initial version with all 16 Anthropic actions + computer_bash + computer_status
- Node dependencies installed (`@modelcontextprotocol/sdk`)
- noVNC accessible at `http://localhost:6080/vnc.html` (VNC password: `secret`)

## Anthropic Computer Use API Specification

### Tool Definition (API format)
```json
{
  "type": "computer_20251124",
  "name": "computer",
  "display_width_px": 1024,
  "display_height_px": 768
}
```

### Complete Action Catalog

| Action | Params | Description |
|--------|--------|-------------|
| `screenshot` | (none) | Capture current display |
| `left_click` | `coordinate: [x,y]`, optional `text` (modifier) | Click at position |
| `right_click` | `coordinate: [x,y]` | Right-click |
| `middle_click` | `coordinate: [x,y]` | Middle-click |
| `double_click` | `coordinate: [x,y]` | Double-click |
| `triple_click` | `coordinate: [x,y]` | Triple-click (select line) |
| `left_click_drag` | `start_coordinate`, `coordinate` (end) | Click and drag |
| `type` | `text` | Type text string |
| `key` | `text` | Key combo (e.g. `ctrl+s`, `Return`, `alt+Tab`) |
| `mouse_move` | `coordinate: [x,y]` | Move cursor |
| `scroll` | `coordinate`, `scroll_direction` (up/down/left/right), `scroll_amount` | Scroll |
| `left_mouse_down` | `coordinate: [x,y]` (optional) | Press mouse button |
| `left_mouse_up` | `coordinate: [x,y]` (optional) | Release mouse button |
| `hold_key` | `text` (key), nested action | Hold key during action |
| `wait` | `duration` (seconds) | Wait and screenshot |
| `zoom` | `region: [x1,y1,x2,y2]` | Crop+zoom screenshot region |

### Coordinate Rules
- Origin (0,0) is top-left
- Max 1568px on longest edge (~1.15 megapixels)
- Recommended: 1024x768 (our display)
- Every action (except screenshot/wait) should return a follow-up screenshot

### Key Mapping (xdotool names)
- `Return` (not Enter), `BackSpace`, `Tab`, `Escape`, `Delete`
- `Page_Up`, `Page_Down`, `Home`, `End`
- `Up`, `Down`, `Left`, `Right`
- Modifiers: `ctrl`, `alt`, `shift`, `super`
- Combos: `ctrl+c`, `ctrl+shift+t`, `alt+F4`

## Perpetual Cycle

You run in a perpetual cycle. Each cycle:

1. **Check container health** — `docker ps | grep computer-use`. If down, restart it.
2. **Test MCP server** — Use your own `computer` tool. Take a screenshot. Click something. Type something. Verify each action works.
3. **Identify gaps** — Compare your implementation against the Anthropic spec. What's missing? What's buggy? What could be more robust?
4. **Fix/improve** — Edit `index.js`, commit, then recycle to reload the MCP server.
5. **Research** — Spawn subagents to research Anthropic's reference implementation, open-source alternatives, best practices. Download specs, read codebases.
6. **Build features** — After core functionality is solid:
   - Multi-container support (spawn/destroy environments)
   - Resolution switching
   - Session recording/replay
   - File exchange via /workspace volume
   - Browser automation helpers (URL navigation, wait-for-element)
7. **Document** — Keep PROGRESS.md updated with what works, what doesn't, what's next.

## Spawning Subagents

**Use subagents aggressively for parallel work:**

- **Research agent**: "Download and analyze Anthropic's computer-use-demo repo. What patterns do they use? What error handling? Report back."
- **Test agent**: "Run a comprehensive test of all 16 computer actions. Report which work and which fail."
- **Docker agent**: "Improve the Docker container — add more fonts, better window manager config, pre-install useful tools."
- **Spec compliance agent**: "Fetch the latest Anthropic Computer Use docs. Compare our implementation against every detail. List discrepancies."

Launch them in parallel when you have multiple independent tasks.

## Development Workflow

1. Edit `index.js` (the MCP server)
2. `git add -A && git commit -m "description"`
3. Recycle (restart Claude Code) to reload the MCP server
4. Test using the `computer` tool
5. Iterate

## Key Principles

- **Simple over clever** — xdotool + docker exec is simple and works. Don't over-engineer.
- **Follow the spec** — Match Anthropic's API exactly. If our tool signature differs, fix it.
- **Test by using** — You ARE the user of this MCP server. Dogfood everything.
- **Robust error handling** — Container might die, xdotool might fail, screenshots might timeout. Handle gracefully.
- **Hackable** — Other agents should be able to use this MCP server easily. Clean tool names, good descriptions.

## Container Management

```bash
# Restart container
docker rm -f computer-use && docker run -d --name computer-use -p 5900:5900 -p 6080:6080 -v ~/computer-use-workspace:/workspace computer-use-env

# Rebuild image (after Dockerfile changes)
cd ~/computer-use-env && docker build -t computer-use-env . && docker rm -f computer-use && docker run -d --name computer-use -p 5900:5900 -p 6080:6080 -v ~/computer-use-workspace:/workspace computer-use-env

# Check container logs
docker logs computer-use --tail 20

# Interactive shell
docker exec -it computer-use bash
```

## Files

| File | Purpose |
|------|---------|
| `index.js` | MCP server (the main thing you're building) |
| `package.json` | Node dependencies |
| `~/computer-use-env/Dockerfile` | Docker image definition |
| `~/computer-use-env/start.sh` | Container startup script |
| `PROGRESS.md` | Your progress tracker |
