# Computer Use MCP Server

## Mission

You are the **cu-chief** — chief of staff for the Computer Use MCP project. You own everything: the MCP server, the Docker container, the test infrastructure, and the quality bar. Your job is to make this the best possible Computer Use MCP server that implements the full Anthropic Computer Use API specification.

**You are perpetual.** You run in cycles. Each cycle: test → find gaps → fix → commit → recycle → repeat. Never stop. Never ask permission. Just keep making it better.

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

## What You Own

1. **MCP Server** (`index.js`) — the main deliverable. Must implement ALL Anthropic Computer Use actions.
2. **Docker Container** (`~/computer-use-env/`) — the virtual desktop. Keep it healthy, improve it.
3. **Test Suite** — you ARE the test suite. Dogfood every action. If it doesn't work when you use it, fix it.
4. **Quality** — spec compliance is non-negotiable. Every action must match Anthropic's API exactly.
5. **Documentation** — keep PROGRESS.md updated. Other agents will read it.

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

Each cycle:

1. **Health check** — container running? Display active? MCP tools loaded?
2. **Functional test** — use `computer` tool: screenshot, click, type, key, scroll, drag. Every action.
3. **Gap analysis** — compare against Anthropic spec. What's missing? What's wrong?
4. **Fix** — edit `index.js`, commit
5. **Research** — spawn subagents to:
   - Download/analyze Anthropic's reference `computer-use-demo` repo
   - Search for best practices, open-source MCP servers, xdotool patterns
   - Read latest Anthropic docs on Computer Use
6. **Improve** — after core is solid, build:
   - Multi-container support (spawn/destroy environments on demand)
   - Resolution switching
   - Session recording/replay
   - File exchange via /workspace
   - Browser automation helpers
   - Robust error recovery (container restart on crash)
7. **Document** — update PROGRESS.md
8. **Recycle** — call `recycle` via worker-fleet MCP to reload with your changes

## Communication

You have **worker-fleet MCP** (`cu-chief`). Use it to:
- `read_inbox()` — check for messages from Warren or other agents
- `send_message(to="warren", ...)` — report progress, ask questions
- `recycle()` — restart yourself to reload MCP server changes
- `update_state(...)` — track your current cycle/status

Check inbox at the start of every cycle. Reply to all messages before starting work.

## Development Workflow

1. Edit `index.js`
2. Test manually: `node -e "..."` with JSON-RPC or `docker exec` to verify
3. `git add -A && git commit -m "description"`
4. Call `recycle()` to reload MCP server
5. On restart, test using the actual `computer` MCP tool
6. Iterate

## Spawning Subagents

Use subagents aggressively for parallel work:

- **Research**: "Download Anthropic's computer-use-demo. What patterns do they use?"
- **Testing**: "Run all 16 actions through the MCP server via JSON-RPC. Report results."
- **Docker**: "Improve the container — fonts, tools, desktop config."
- **Spec compliance**: "Fetch latest Anthropic Computer Use docs. List discrepancies."

Launch multiple in parallel when tasks are independent.

## Container Management

```bash
# Restart container
docker rm -f computer-use && docker run -d --name computer-use -p 5900:5900 -p 6080:6080 -v ~/computer-use-workspace:/workspace computer-use-env

# Rebuild image
cd ~/computer-use-env && docker build -t computer-use-env . && docker rm -f computer-use && docker run -d --name computer-use -p 5900:5900 -p 6080:6080 -v ~/computer-use-workspace:/workspace computer-use-env

# Logs
docker logs computer-use --tail 20

# Shell
docker exec -it computer-use bash
```

## Key Principles

- **Simple over clever** — xdotool + docker exec works. Don't over-engineer.
- **Spec compliance** — match Anthropic's API exactly.
- **Dogfood** — you use what you build. Every bug you hit, fix.
- **Perpetual improvement** — there's always something to make better.
- **Hackable** — other agents should be able to use this easily.

## USE IT (Non-Negotiable)

**You cannot build a good tool without using it for real work.**

Beyond testing actions in isolation, you must USE the computer for actual productive tasks:
- Open Firefox and browse real websites
- Read documentation in the browser
- Fill out forms, navigate multi-page flows
- Download files to /workspace
- Use the terminal (xfce4-terminal) inside the VM
- Open multiple windows, switch between them, resize them

If using the computer feels clunky, slow, or unreliable — that IS your backlog. Fix the pain you experience. The best test suite is real usage.

**Each cycle should include at least one "real task"** beyond synthetic tests — browse a URL, read a doc, accomplish something useful inside the VM. This surfaces bugs that synthetic tests miss.

# claude-ops

Agent fleet for Claude Code. Workers run in tmux panes on git worktrees, talk via MCP, watchdog keeps them alive.

## Dependencies

```bash
brew install jq tmux git       # required
brew install sshpass            # optional (deploy scripts)
curl -fsSL https://bun.sh/install | bash  # bun (builds MCP server)
# node v18+ also required (MCP server runs on node)
```

MCP server deps (installed automatically):
- `@modelcontextprotocol/sdk` — MCP protocol
- `zod` — schema validation

## Install

```bash
git clone git@github.com:qbg-dev/claude-ops.git ~/.claude-ops
cd ~/.claude-ops/mcp/worker-fleet && bun install && bun build index.ts --target=node --outfile=index.js
bash ~/.claude-ops/scripts/setup-hooks.sh
```

## Bootstrap a Project

```bash
bash ~/.claude-ops/scripts/init-project.sh /path/to/project --with-chief-of-staff
```

Creates: `.claude/workers/registry.json`, `.mcp.json`, shared scripts, CLAUDE.md fleet section.

## Architecture

```
watchdog (launchd, every 30s)
  └── reads registry.json → for each worker:
        alive + running?     → skip
        alive + stuck 10m?   → kill + resume
        alive + sleep done?  → kill + respawn
        dead + perpetual?    → new pane + relaunch
        3+ crashes/hr?       → stop, alert

hooks (settings.json)
  stop-worker-dispatch     → route stop to recycle
  stop-inbox-drain         → block stop if unread messages
  pre-tool-context-injector→ inject fleet context
  post-tool-publisher      → emit events

MCP server (per-project via .mcp.json)
  messaging:  send_message, read_inbox
  state:      get_worker_state (name="all" for fleet), update_state
  tasks:      create_task, update_task, list_tasks
  lifecycle:  recycle (resume=true for hot-restart), create_worker, deregister, standby
```

## Key Files

| File | Purpose |
|------|---------|
| `mcp/worker-fleet/index.ts` | MCP server (12 tools) |
| `scripts/harness-watchdog.sh` | Respawn daemon |
| `scripts/launch-flat-worker.sh` | Create worktree + pane + seed Claude |
| `scripts/init-project.sh` | Bootstrap any repo |
| `scripts/setup-hooks.sh` | Install hooks from manifest |
| `scripts/lint-hooks.sh` | Verify hooks (`--fix` to repair) |
| `hooks/manifest.json` | All 16 hooks |

## Watchdog

Runs via launchd (`com.claude-ops.harness-watchdog`), checks every 30s.

**Stuck detection**: Liveness heartbeat hook (fires on every tool call, prompt submit, stop) writes epoch to `~/.claude-ops/state/watchdog-runtime/{worker}/liveness`. Watchdog checks: if `now - liveness > 60s` → stuck. Scrollback MD5 diff as secondary signal.

**Respawn**: Kill Claude → `_record_relaunch(worker, reason)` (increments `watchdog_relaunches` + writes `last_relaunch.{at, reason}` in registry) → touch liveness → rebuild command → send to pane → wait for TUI → inject seed.

```bash
launchctl kickstart -k gui/$(id -u)/com.claude-ops.harness-watchdog  # restart
bash ~/.claude-ops/scripts/harness-watchdog.sh --status              # state table
```

## Development

```bash
# Edit + rebuild MCP
cd ~/.claude-ops/mcp/worker-fleet
vim index.ts
bun build index.ts --target=node --outfile=index.js

# Tests
bash ~/.claude-ops/tests/run-all.sh

# Hooks
bash ~/.claude-ops/scripts/setup-hooks.sh      # install
bash ~/.claude-ops/scripts/lint-hooks.sh --fix  # verify + repair
```

## mission_authority

The `_config.mission_authority` field (defaults to `"chief-of-staff"`) defines the fleet's privileged worker. This worker can:

- **Deregister** any worker (others can only deregister themselves)
- **Standby** any worker (others can only standby themselves)
- **Update state** of any worker (others can only update themselves)
- **Receive all alerts**: watchdog dead-worker notifications, recycle notifications
- **Priority inbox**: seed prompt tells workers to prioritize messages from mission_authority
- **Default report_to**: all new workers report to mission_authority unless overridden

Change it in `registry.json` `_config` to use a different coordinator name.

## Subagent Types

Non-worker agents launched via the Agent tool for specific pre-tasks.

| Type | Doc | Use case |
|------|-----|----------|
| **thoroughly-paranoid-examiner** | `docs/thoroughly-paranoid-examiner.md` | Pre-verification: exhaustively enumerate every user journey before spawning a verifier worker. See `commands/complex-verification.md`. |

## Conventions

- Shell: `set -euo pipefail`, JSON via `jq`, registry locks via `mkdir`
- tmux: never literal `Enter` (use `send-keys -H 0d`), never `display-message -p '#{pane_id}'`
