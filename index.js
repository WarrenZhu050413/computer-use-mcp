#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFileSync } from "child_process";
import { randomUUID, createHash } from "crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { basename, extname } from "path";

// Default configuration (from environment)
const DEFAULT_CONTAINER = process.env.CONTAINER_NAME || "computer-use";
const DEFAULT_IMAGE = process.env.CONTAINER_IMAGE || "computer-use-env";
const DEFAULT_VNC_PORT = parseInt(process.env.CONTAINER_VNC_PORT || "5900", 10);
const DEFAULT_NOVNC_PORT = parseInt(process.env.CONTAINER_NOVNC_PORT || "6080", 10);
const DEFAULT_WORKSPACE = process.env.CONTAINER_WORKSPACE || `${process.env.HOME}/computer-use-workspace`;
const DISPLAY_WIDTH = parseInt(process.env.DISPLAY_WIDTH || "1024", 10);
const DISPLAY_HEIGHT = parseInt(process.env.DISPLAY_HEIGHT || "768", 10);
const SCREENSHOT_DELAY_MS = parseInt(process.env.SCREENSHOT_DELAY_MS || "1000", 10);
const SCREENSHOT_FORMAT = (process.env.SCREENSHOT_FORMAT || "jpeg").toLowerCase();
const SCREENSHOT_QUALITY = parseInt(process.env.SCREENSHOT_QUALITY || "80", 10);
const DEFAULT_DISPLAY_NUMBER = parseInt(process.env.DISPLAY_NUMBER || "1", 10);
const TYPING_DELAY_MS = 12;
const MAX_RESPONSE_LEN = 16000;
const MAX_API_DIMENSION = 1568; // Anthropic spec: max longest edge in API space
const MAX_API_PIXELS = 1_150_000; // Anthropic spec: max ~1.15 megapixels total

// === Session recording ===
const activeSessions = new Map(); // sessionName -> { name, container, started, actions[] }

// === Keyboard shortcuts map ===
const SHORTCUTS = {
  // Clipboard
  copy: "ctrl+c", cut: "ctrl+x", paste: "ctrl+v",
  // Editing
  undo: "ctrl+z", redo: "ctrl+shift+z", select_all: "ctrl+a",
  delete_line: "ctrl+shift+k",
  // File
  save: "ctrl+s", save_as: "ctrl+shift+s", open: "ctrl+o",
  new_file: "ctrl+n", print: "ctrl+p",
  // Search
  find: "ctrl+f", find_replace: "ctrl+h", find_next: "ctrl+g",
  // Browser/Tab
  new_tab: "ctrl+t", close_tab: "ctrl+w", reopen_tab: "ctrl+shift+t",
  next_tab: "ctrl+Tab", prev_tab: "ctrl+shift+Tab",
  refresh: "ctrl+r", hard_refresh: "ctrl+shift+r",
  address_bar: "ctrl+l", back: "alt+Left", forward: "alt+Right",
  // Window
  close_window: "alt+F4", fullscreen: "F11", switch_window: "alt+Tab",
  // Terminal-specific
  terminal_copy: "ctrl+shift+c", terminal_paste: "ctrl+shift+v",
  // Zoom
  zoom_in: "ctrl+plus", zoom_out: "ctrl+minus", zoom_reset: "ctrl+0",
};

// === Multi-container environment tracking ===
const environments = new Map();
let nextEnvPort = 1;

// Register the default container
environments.set(DEFAULT_CONTAINER, {
  image: DEFAULT_IMAGE,
  vncPort: DEFAULT_VNC_PORT,
  novncPort: DEFAULT_NOVNC_PORT,
  workspace: DEFAULT_WORKSPACE,
  width: DISPLAY_WIDTH,
  height: DISPLAY_HEIGHT,
  displayNumber: DEFAULT_DISPLAY_NUMBER,
});

// === Coordinate scaling (Anthropic spec: max 1568px on longest edge) ===

function getScaleFactor(width, height) {
  const longEdgeScale = MAX_API_DIMENSION / Math.max(width, height);
  const totalPixelsScale = Math.sqrt(MAX_API_PIXELS / (width * height));
  return Math.min(1, longEdgeScale, totalPixelsScale);
}

function getApiDimensions(containerName = DEFAULT_CONTAINER) {
  const env = environments.get(containerName);
  const w = env?.width || DISPLAY_WIDTH;
  const h = env?.height || DISPLAY_HEIGHT;
  const s = getScaleFactor(w, h);
  return { width: Math.round(w * s), height: Math.round(h * s) };
}

function apiToDisplay(apiX, apiY, containerName = DEFAULT_CONTAINER) {
  const env = environments.get(containerName);
  const w = env?.width || DISPLAY_WIDTH;
  const h = env?.height || DISPLAY_HEIGHT;
  const s = getScaleFactor(w, h);
  if (s === 1) return [apiX, apiY];
  return [Math.round(apiX / s), Math.round(apiY / s)];
}

function resolveContainer(name) {
  const cn = name || DEFAULT_CONTAINER;
  if (!environments.has(cn)) {
    throw new Error(`Unknown environment '${cn}'. Use computer_env_list to see available environments.`);
  }
  return cn;
}

// Find a window by title substring or exact window ID. Returns the window ID string.
function findWindowByTitleOrId(title, window_id, cn) {
  if (!title && !window_id) throw new Error("Provide either title or window_id");
  if (window_id) return String(window_id);
  const wids = dockerExec("xdotool search --onlyvisible --name '.'", 10000, cn)
    .toString().trim().split("\n").filter(Boolean);
  for (const wid of wids.slice(0, 50)) {
    try {
      const name = dockerExec(`xdotool getwindowname ${wid}`, 5000, cn).toString().trim();
      if (name.toLowerCase().includes(title.toLowerCase())) return wid;
    } catch { /* skip inaccessible windows */ }
  }
  throw new Error(`No window matching "${title}" found`);
}

// Get all visible, named windows (excludes desktop/panel). Returns [{wid, name, x, y, w, h}].
function getVisibleWindows(cn) {
  // Use --name '.' to only match windows with non-empty names (regex: any char)
  // This avoids iterating dozens of unnamed XFCE internal windows
  const wids = dockerExec("xdotool search --onlyvisible --name '.'", 10000, cn)
    .toString().trim().split("\n").filter(Boolean);
  const windows = [];
  const skipPatterns = ["desktop", "xfce4-panel", "xfdesktop", "xfwm4", "wrapper-"];
  for (const wid of wids.slice(0, 50)) {
    try {
      const name = dockerExec(`xdotool getwindowname ${wid}`, 5000, cn).toString().trim();
      if (!name || skipPatterns.some(p => name.toLowerCase().includes(p))) continue;
      const geom = dockerExec(`xdotool getwindowgeometry ${wid}`, 5000, cn).toString().trim();
      const posMatch = geom.match(/Position: (\d+),(\d+)/);
      const sizeMatch = geom.match(/Geometry: (\d+)x(\d+)/);
      if (posMatch && sizeMatch) {
        windows.push({
          wid, name,
          x: parseInt(posMatch[1]), y: parseInt(posMatch[2]),
          w: parseInt(sizeMatch[1]), h: parseInt(sizeMatch[2])
        });
      }
    } catch { /* skip inaccessible */ }
  }
  return windows;
}

function isContainerRunning(containerName = DEFAULT_CONTAINER) {
  try {
    const status = execFileSync("docker", [
      "inspect", "--format={{.State.Status}}", containerName
    ], { timeout: 5000 }).toString().trim();
    return status === "running";
  } catch { return false; }
}

function restartContainer(containerName = DEFAULT_CONTAINER) {
  const env = environments.get(containerName);
  if (!env) return false;
  try {
    // Full recreation: rm + run (docker start leaves stale X11 lock files)
    try { execFileSync("docker", ["rm", "-f", containerName], { timeout: 10000 }); } catch {}
    const envW = env.width || DISPLAY_WIDTH;
    const envH = env.height || DISPLAY_HEIGHT;
    execFileSync("docker", [
      "run", "-d", "--name", containerName,
      "-e", `SCREEN_RESOLUTION=${envW}x${envH}`,
      "-p", `${env.vncPort}:5900`,
      "-p", `${env.novncPort}:6080`,
      "-v", `${env.workspace}:/workspace`,
      env.image
    ], { timeout: 30000 });
    // Wait for display to come up
    const dn = env.displayNumber || DEFAULT_DISPLAY_NUMBER;
    for (let i = 0; i < 15; i++) {
      try {
        execFileSync("docker", [
          "exec", containerName, "bash", "-c", `DISPLAY=:${dn} xdotool getdisplaygeometry`
        ], { timeout: 5000 });
        return true;
      } catch { /* display not ready yet */ }
      execFileSync("sleep", ["1"]);
    }
  } catch { /* restart failed */ }
  return false;
}

function getDisplayNumber(containerName = DEFAULT_CONTAINER) {
  const env = environments.get(containerName);
  return env?.displayNumber || DEFAULT_DISPLAY_NUMBER;
}

function dockerExec(cmd, timeoutMs = 30000, containerName = DEFAULT_CONTAINER) {
  const dn = getDisplayNumber(containerName);
  try {
    return execFileSync("docker", [
      "exec", containerName, "bash", "-c", `DISPLAY=:${dn} ${cmd}`
    ], { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
  } catch (err) {
    // If container is down, attempt auto-recovery (single retry)
    if (!isContainerRunning(containerName)) {
      if (restartContainer(containerName)) {
        return execFileSync("docker", [
          "exec", containerName, "bash", "-c", `DISPLAY=:${dn} ${cmd}`
        ], { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
      }
      throw new Error(`Container '${containerName}' is not running and auto-restart failed. Original: ${err.message}`);
    }
    throw err;
  }
}

function takeScreenshot(containerName = DEFAULT_CONTAINER) {
  const id = randomUUID().slice(0, 8);
  const pngPath = `/tmp/_ss_${id}.png`;
  dockerExec(`scrot -o ${pngPath}`, 30000, containerName);

  const api = getApiDimensions(containerName);
  const env = environments.get(containerName);
  const displayW = env?.width || DISPLAY_WIDTH;
  const displayH = env?.height || DISPLAY_HEIGHT;
  const needsScale = api.width !== displayW || api.height !== displayH;
  const useJpeg = SCREENSHOT_FORMAT === "jpeg" || SCREENSHOT_FORMAT === "jpg";

  if (needsScale || useJpeg) {
    const outExt = useJpeg ? "jpg" : "png";
    const outPath = `/tmp/_ss_${id}_out.${outExt}`;
    const resizeFlag = needsScale ? `-resize ${api.width}x${api.height}!` : "";
    const qualityFlag = useJpeg ? `-quality ${SCREENSHOT_QUALITY}` : "";
    dockerExec(`convert ${pngPath} ${resizeFlag} ${qualityFlag} ${outPath}`, 30000, containerName);
    const b64 = dockerExec(`base64 ${outPath} && rm -f ${pngPath} ${outPath}`, 30000, containerName).toString().replace(/\s/g, "");
    return { data: b64, mimeType: useJpeg ? "image/jpeg" : "image/png", apiWidth: api.width, apiHeight: api.height };
  }

  const b64 = dockerExec(`base64 ${pngPath} && rm -f ${pngPath}`, 30000, containerName).toString().replace(/\s/g, "");
  return { data: b64, mimeType: "image/png", apiWidth: api.width, apiHeight: api.height };
}

function xdotool(args, containerName = DEFAULT_CONTAINER) {
  dockerExec(`xdotool ${args}`, 30000, containerName);
}

function validateCoord(coord, name = "coordinate", containerName = DEFAULT_CONTAINER) {
  if (!coord || coord.length !== 2) throw new Error(`${name} must be [x, y]`);
  const [x, y] = coord;
  if (typeof x !== "number" || typeof y !== "number" || x < 0 || y < 0) {
    throw new Error(`${name} values must be non-negative numbers`);
  }
  const api = getApiDimensions(containerName);
  if (x >= api.width || y >= api.height) {
    throw new Error(`${name} [${x},${y}] out of bounds (API space is ${api.width}x${api.height}, max [${api.width-1},${api.height-1}])`);
  }
  // Scale from API coordinates to actual display coordinates
  const [dx, dy] = apiToDisplay(x, y, containerName);
  return [Math.round(dx), Math.round(dy)];
}

function mapKey(key) {
  const keyMap = {
    Return: "Return", Enter: "Return",
    Tab: "Tab", Escape: "Escape",
    Backspace: "BackSpace", Delete: "Delete",
    Home: "Home", End: "End",
    Page_Up: "Page_Up", PageUp: "Page_Up",
    Page_Down: "Page_Down", PageDown: "Page_Down",
    Up: "Up", Down: "Down", Left: "Left", Right: "Right",
    space: "space", Space: "space",
    F1: "F1", F2: "F2", F3: "F3", F4: "F4",
    F5: "F5", F6: "F6", F7: "F7", F8: "F8",
    F9: "F9", F10: "F10", F11: "F11", F12: "F12",
  };
  return key.split("+").map(k => {
    const kl = k.trim();
    if (kl === "ctrl" || kl === "Ctrl" || kl === "Control") return "ctrl";
    if (kl === "alt" || kl === "Alt") return "alt";
    if (kl === "shift" || kl === "Shift") return "shift";
    if (kl === "super" || kl === "Super" || kl === "meta" || kl === "Meta" || kl === "cmd") return "super";
    return keyMap[kl] || kl;
  }).join("+");
}

function clickWithModifier(x, y, button, modifier, containerName = DEFAULT_CONTAINER) {
  if (modifier) {
    const mod = mapKey(modifier);
    xdotool(`mousemove ${x} ${y} keydown ${mod} click ${button} keyup ${mod}`, containerName);
  } else {
    xdotool(`mousemove ${x} ${y} click ${button}`, containerName);
  }
}

// Clipboard paste helper — pastes text into active window via clipboard
// Auto-detects terminal vs GUI for correct paste shortcut, restores original clipboard
function clipboardPaste(content, containerName = DEFAULT_CONTAINER) {
  // Save original clipboard
  let originalClipboard = "";
  try {
    originalClipboard = dockerExec(`xclip -selection clipboard -o 2>/dev/null || true`, 5000, containerName).toString();
  } catch { /* empty clipboard is fine */ }

  // Set clipboard via base64 (safe for all content including special chars)
  const b64 = Buffer.from(content).toString("base64");
  const id = randomUUID().slice(0, 8);
  const tmpPath = `/tmp/_cp_${id}.txt`;
  dockerExec(`echo '${b64}' | base64 -d > '${tmpPath}' && cat '${tmpPath}' | xclip -selection clipboard -i && rm -f '${tmpPath}'`, 30000, containerName);

  // Verify clipboard content was set correctly (read back and compare)
  // Only verify for content up to 10KB — larger content is too expensive to round-trip
  if (content.length <= 10240) {
    try {
      const verifyPath = `/tmp/_cp_verify_${id}.txt`;
      dockerExec(`xclip -selection clipboard -o > '${verifyPath}' 2>/dev/null`, 5000, containerName);
      const readBack = dockerExec(`cat '${verifyPath}' && rm -f '${verifyPath}'`, 5000, containerName).toString();
      if (readBack !== content) {
        // Retry once — clipboard can be racy with X11 selection events
        dockerExec(`echo '${b64}' | base64 -d > '${tmpPath}' && cat '${tmpPath}' | xclip -selection clipboard -i && rm -f '${tmpPath}'`, 30000, containerName);
      }
    } catch { /* verification failed — proceed anyway, paste may still work */ }
  }

  // Detect terminal vs GUI for correct paste shortcut
  // Check both window name and WM_CLASS (more reliable than title alone)
  let isTerminal = false;
  try {
    const activeWin = dockerExec(`xdotool getactivewindow`, 5000, containerName).toString().trim();
    const winName = dockerExec(`xdotool getwindowname ${activeWin} 2>/dev/null || echo ""`, 5000, containerName).toString().trim().toLowerCase();
    const winClass = dockerExec(`xprop -id ${activeWin} WM_CLASS 2>/dev/null || echo ""`, 5000, containerName).toString().trim().toLowerCase();
    isTerminal = /terminal|xterm|rxvt|konsole|alacritty|kitty|tilix|sakura|lxterminal|terminator|urxvt|st-256color|foot|wezterm/.test(winName)
      || /xfce4-terminal|gnome-terminal|xterm|rxvt|konsole|alacritty|kitty|tilix|terminator|sakura|st-256color|foot|wezterm/.test(winClass);
  } catch { /* default to GUI paste */ }

  const pasteKey = isTerminal ? "ctrl+shift+v" : "ctrl+v";
  xdotool(`key ${pasteKey}`, containerName);

  // Restore original clipboard in background after delay
  // Uses nohup + & so the restore doesn't block the paste action.
  // 2s delay allows paste (including paste safety dialogs) to complete before restore.
  if (originalClipboard) {
    const b64Orig = Buffer.from(originalClipboard).toString("base64");
    const origPath = `/tmp/_cp_orig_${id}.txt`;
    try {
      dockerExec(`nohup bash -c 'sleep 2 && echo '"'"'${b64Orig}'"'"' | base64 -d > '"'"'${origPath}'"'"' && cat '"'"'${origPath}'"'"' | xclip -selection clipboard -i && rm -f '"'"'${origPath}'"'"'' >/dev/null 2>&1 &`, 5000, containerName);
    } catch { /* background restore is best-effort */ }
  }
}

// Core action executor — used by main handler and recursively by hold_key
function executeAction({ action, coordinate, text, scroll_direction, scroll_amount,
                         start_coordinate, duration, region }, containerName = DEFAULT_CONTAINER) {
  switch (action) {
    case "left_click": {
      if (coordinate) {
        const [x, y] = validateCoord(coordinate, "coordinate", containerName);
        clickWithModifier(x, y, 1, text, containerName);
      } else {
        if (text) {
          const mod = mapKey(text);
          xdotool(`keydown ${mod} click 1 keyup ${mod}`, containerName);
        } else {
          xdotool(`click 1`, containerName);
        }
      }
      break;
    }

    case "right_click": {
      if (coordinate) {
        const [x, y] = validateCoord(coordinate, "coordinate", containerName);
        clickWithModifier(x, y, 3, text, containerName);
      } else {
        xdotool(`click 3`, containerName);
      }
      break;
    }

    case "middle_click": {
      if (coordinate) {
        const [x, y] = validateCoord(coordinate, "coordinate", containerName);
        clickWithModifier(x, y, 2, text, containerName);
      } else {
        xdotool(`click 2`, containerName);
      }
      break;
    }

    case "double_click": {
      if (coordinate) {
        const [x, y] = validateCoord(coordinate, "coordinate", containerName);
        xdotool(`mousemove ${x} ${y} click --repeat 2 --delay 10 1`, containerName);
      } else {
        xdotool(`click --repeat 2 --delay 10 1`, containerName);
      }
      break;
    }

    case "triple_click": {
      if (coordinate) {
        const [x, y] = validateCoord(coordinate, "coordinate", containerName);
        xdotool(`mousemove ${x} ${y} click --repeat 3 --delay 10 1`, containerName);
      } else {
        xdotool(`click --repeat 3 --delay 10 1`, containerName);
      }
      break;
    }

    case "left_click_drag": {
      if (!start_coordinate) throw new Error("start_coordinate required for left_click_drag");
      if (!coordinate) throw new Error("coordinate (end position) required for left_click_drag");
      const [sx, sy] = validateCoord(start_coordinate, "start_coordinate", containerName);
      const [ex, ey] = validateCoord(coordinate, "coordinate (end)", containerName);
      xdotool(`mousemove ${sx} ${sy} mousedown 1 mousemove ${ex} ${ey} mouseup 1`, containerName);
      break;
    }

    case "type": {
      if (!text) throw new Error("text required for type action");
      const hasNonAscii = /[^\x00-\x7F]/.test(text);
      // Use clipboard paste for: non-ASCII text, or large ASCII text (>500 chars = much faster)
      if (hasNonAscii || text.length > 500) {
        clipboardPaste(text, containerName);
      } else {
        // ASCII text (short): use xdotool type (preserves modifier state)
        // Split on newlines and press Return between segments (xdotool --file drops \n)
        const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].length > 0) {
            const b64Text = Buffer.from(lines[i]).toString("base64");
            const id = randomUUID().slice(0, 8);
            const path = `/tmp/_type_${id}.txt`;
            dockerExec(`echo ${b64Text} | base64 -d > ${path}`, 30000, containerName);
            dockerExec(`xdotool type --clearmodifiers --delay ${TYPING_DELAY_MS} --file ${path} && rm -f ${path}`, 30000, containerName);
          }
          if (i < lines.length - 1) {
            xdotool("key Return", containerName);
          }
        }
      }
      break;
    }

    case "key": {
      if (!text) throw new Error("text required for key action");
      const mapped = mapKey(text);
      // Note: --clearmodifiers breaks modifier combos (e.g. ctrl+shift+v) so we don't use it
      xdotool(`key -- ${mapped}`, containerName);
      break;
    }

    case "mouse_move": {
      if (!coordinate) throw new Error("coordinate required for mouse_move");
      const [x, y] = validateCoord(coordinate, "coordinate", containerName);
      xdotool(`mousemove ${x} ${y}`, containerName);
      break;
    }

    case "scroll": {
      const dir = scroll_direction || "down";
      const amount = scroll_amount || 3;
      if (amount < 0) throw new Error("scroll_amount must be non-negative");
      if (coordinate) {
        const [x, y] = validateCoord(coordinate, "coordinate", containerName);
        xdotool(`mousemove ${x} ${y}`, containerName);
      }
      const buttonMap = { up: 4, down: 5, left: 6, right: 7 };
      const btn = buttonMap[dir] || 5;
      if (text) {
        const mod = mapKey(text);
        xdotool(`keydown ${mod} click --repeat ${amount} --delay 50 ${btn} keyup ${mod}`, containerName);
      } else {
        xdotool(`click --repeat ${amount} --delay 50 ${btn}`, containerName);
      }
      break;
    }

    case "left_mouse_down": {
      if (coordinate) {
        const [x, y] = validateCoord(coordinate, "coordinate", containerName);
        xdotool(`mousemove ${x} ${y} mousedown 1`, containerName);
      } else {
        xdotool(`mousedown 1`, containerName);
      }
      break;
    }

    case "left_mouse_up": {
      if (coordinate) {
        const [x, y] = validateCoord(coordinate, "coordinate", containerName);
        xdotool(`mousemove ${x} ${y} mouseup 1`, containerName);
      } else {
        xdotool(`mouseup 1`, containerName);
      }
      break;
    }

    default:
      throw new Error(`Unknown action for executeAction: ${action}`);
  }
}

// === MCP Server ===

const server = new McpServer({
  name: "computer-use",
  version: "1.25.0",
});

const actionSchema = {
  action: z.enum([
    "screenshot", "left_click", "right_click", "middle_click",
    "double_click", "triple_click", "left_click_drag", "type",
    "key", "mouse_move", "scroll", "left_mouse_down", "left_mouse_up",
    "hold_key", "wait", "zoom", "cursor_position"
  ]).describe("The action to perform"),
  coordinate: z.array(z.number()).optional().describe("[x, y] position. Required for most actions, optional for clicks (uses current position)"),
  text: z.string().optional().describe("Text to type, key combo (e.g. 'ctrl+s'), modifier key for click/scroll ('shift','ctrl','alt','super'), or key to hold"),
  scroll_direction: z.enum(["up", "down", "left", "right"]).optional().describe("Scroll direction"),
  scroll_amount: z.number().optional().describe("Number of scroll clicks (default 3)"),
  start_coordinate: z.array(z.number()).optional().describe("[x, y] start position for left_click_drag"),
  duration: z.number().optional().describe("Seconds to wait (for wait/hold_key actions)"),
  region: z.array(z.number()).optional().describe("[x1, y1, x2, y2] region to zoom into"),
  hold_key_action: z.object({
    action: z.string().describe("Nested action to perform while key is held"),
    coordinate: z.array(z.number()).optional(),
    text: z.string().optional(),
    scroll_direction: z.enum(["up", "down", "left", "right"]).optional(),
    scroll_amount: z.number().optional(),
    start_coordinate: z.array(z.number()).optional(),
  }).optional().describe("Nested action to execute while holding the key (for hold_key action)"),
  container_name: z.string().optional().describe("Target container name (default: primary). Use computer_env_list to see available environments."),
};

server.tool(
  "computer",
  `Anthropic Computer Use tool. Interact with a virtual desktop.
Actions: screenshot, left_click, right_click, middle_click, double_click, triple_click,
left_click_drag, type, key, mouse_move, scroll, left_mouse_down, left_mouse_up,
hold_key, wait, zoom, cursor_position.
Coordinates are [x, y] from top-left origin in API space. Every action returns a follow-up screenshot.
Displays > 1568px longest edge are auto-scaled (coordinates and screenshots mapped).
hold_key: holds a key and executes a nested action (via hold_key_action param), or holds for duration seconds.
Multi-container: use container_name to target a specific environment (see computer_env_create/list).`,
  actionSchema,
  async ({ action, coordinate, text, scroll_direction, scroll_amount,
           start_coordinate, duration, region, hold_key_action, container_name }) => {
    // Early validation — return error objects instead of throwing so MCP SDK doesn't swallow messages
    if (coordinate) {
      if (!Array.isArray(coordinate) || coordinate.length !== 2) {
        return { content: [{ type: "text", text: `Error: coordinate must be [x, y], got: ${JSON.stringify(coordinate)}` }], isError: true };
      }
      const [cx, cy] = coordinate;
      if (typeof cx !== "number" || typeof cy !== "number") {
        return { content: [{ type: "text", text: `Error: coordinate values must be numbers` }], isError: true };
      }
      if (cx < 0 || cy < 0) {
        return { content: [{ type: "text", text: `Error: coordinate [${cx},${cy}] values must be non-negative` }], isError: true };
      }
      const api = getApiDimensions(container_name || DEFAULT_CONTAINER);
      if (cx >= api.width || cy >= api.height) {
        return { content: [{ type: "text", text: `Error: coordinate [${cx},${cy}] out of bounds (display is ${api.width}x${api.height}, max [${api.width-1},${api.height-1}])` }], isError: true };
      }
    }
    if (start_coordinate) {
      if (!Array.isArray(start_coordinate) || start_coordinate.length !== 2) {
        return { content: [{ type: "text", text: `Error: start_coordinate must be [x, y]` }], isError: true };
      }
      const [sx, sy] = start_coordinate;
      if (typeof sx !== "number" || typeof sy !== "number" || sx < 0 || sy < 0) {
        return { content: [{ type: "text", text: `Error: start_coordinate values must be non-negative numbers` }], isError: true };
      }
      const api = getApiDimensions(container_name || DEFAULT_CONTAINER);
      if (sx >= api.width || sy >= api.height) {
        return { content: [{ type: "text", text: `Error: start_coordinate [${sx},${sy}] out of bounds (display is ${api.width}x${api.height}, max [${api.width-1},${api.height-1}])` }], isError: true };
      }
    }
    if (action === "left_click_drag" && !start_coordinate) {
      return { content: [{ type: "text", text: `Error: start_coordinate required for left_click_drag` }], isError: true };
    }
    if (action === "left_click_drag" && !coordinate) {
      return { content: [{ type: "text", text: `Error: coordinate (end position) required for left_click_drag` }], isError: true };
    }
    if (scroll_amount !== undefined && scroll_amount !== null) {
      if (scroll_amount < 0) {
        return { content: [{ type: "text", text: `Error: scroll_amount must be non-negative` }], isError: true };
      }
      if (scroll_amount > 100) {
        return { content: [{ type: "text", text: `Error: scroll_amount too large (max 100), got ${scroll_amount}` }], isError: true };
      }
    }
    if (duration !== undefined && duration !== null) {
      if (duration < 0) {
        return { content: [{ type: "text", text: `Error: duration must be non-negative` }], isError: true };
      }
      if (duration > 60) {
        return { content: [{ type: "text", text: `Error: duration too large (max 60 seconds), got ${duration}` }], isError: true };
      }
    }

    try {
      const cn = resolveContainer(container_name);
      const label = cn !== DEFAULT_CONTAINER ? ` [${cn}]` : "";

      switch (action) {
        case "screenshot": {
          // Record screenshot action if session is active
          for (const [, session] of activeSessions) {
            if (session.container === cn) {
              session.actions.push({
                timestamp: new Date().toISOString(),
                elapsed_ms: Date.now() - session.startedMs,
                action: "screenshot",
                params: {},
              });
            }
          }
          const ss = takeScreenshot(cn);
          return {
            content: [
              { type: "image", data: ss.data, mimeType: ss.mimeType },
              { type: "text", text: `Screenshot captured (${ss.apiWidth}x${ss.apiHeight}, ${ss.mimeType})${label}` }
            ]
          };
        }

        case "left_click":
        case "right_click":
        case "middle_click":
        case "double_click":
        case "triple_click":
        case "left_click_drag":
        case "type":
        case "key":
        case "mouse_move":
        case "scroll":
        case "left_mouse_down":
        case "left_mouse_up": {
          executeAction({ action, coordinate, text, scroll_direction, scroll_amount,
                          start_coordinate, duration, region }, cn);
          break;
        }

        case "hold_key": {
          if (!text) throw new Error("text required for hold_key (the key to hold)");
          const k = mapKey(text);
          xdotool(`keydown ${k}`, cn);
          try {
            if (hold_key_action) {
              executeAction(hold_key_action, cn);
            } else {
              const dur = duration || 1;
              if (dur <= 0 || dur > 100) throw new Error("duration must be between 0 and 100 seconds");
              dockerExec(`sleep ${dur}`, (dur + 5) * 1000, cn);
            }
          } finally {
            xdotool(`keyup ${k}`, cn);
          }
          break;
        }

        case "wait": {
          if (!duration) throw new Error("duration required for wait action");
          if (duration <= 0 || duration > 100) throw new Error("duration must be between 0 and 100 seconds");
          // Record wait action
          for (const [, session] of activeSessions) {
            if (session.container === cn) {
              session.actions.push({
                timestamp: new Date().toISOString(),
                elapsed_ms: Date.now() - session.startedMs,
                action: "wait",
                params: { duration },
              });
            }
          }
          await new Promise(r => setTimeout(r, duration * 1000));
          const ss = takeScreenshot(cn);
          return {
            content: [
              { type: "image", data: ss.data, mimeType: ss.mimeType },
              { type: "text", text: `Waited ${duration} seconds${label}` }
            ]
          };
        }

        case "zoom": {
          if (!region || region.length !== 4) throw new Error("region [x1, y1, x2, y2] required for zoom");
          const [rx1, ry1, rx2, ry2] = region;
          // Region coords are in API space — scale to display coords
          const [dx1, dy1] = apiToDisplay(rx1, ry1, cn);
          const [dx2, dy2] = apiToDisplay(rx2, ry2, cn);
          const cropW = dx2 - dx1;
          const cropH = dy2 - dy1;
          if (cropW <= 0 || cropH <= 0) throw new Error("zoom region must have positive width and height");
          const zApi = getApiDimensions(cn);
          const zId = randomUUID().slice(0, 8);
          const ssPath = `/tmp/_ss_${zId}.png`;
          const useJpeg = SCREENSHOT_FORMAT === "jpeg" || SCREENSHOT_FORMAT === "jpg";
          const outExt = useJpeg ? "jpg" : "png";
          const zoomPath = `/tmp/_zoom_${zId}.${outExt}`;
          dockerExec(`scrot -o ${ssPath}`, 30000, cn);
          const qualityFlag = useJpeg ? `-quality ${SCREENSHOT_QUALITY}` : "";
          // Crop at display coords, resize to API dimensions
          dockerExec(`convert ${ssPath} -crop ${cropW}x${cropH}+${dx1}+${dy1} +repage -resize ${zApi.width}x${zApi.height} ${qualityFlag} ${zoomPath}`, 30000, cn);
          const b64 = dockerExec(`base64 ${zoomPath} && rm -f ${ssPath} ${zoomPath}`, 30000, cn).toString().replace(/\s/g, "");
          const zoomMime = useJpeg ? "image/jpeg" : "image/png";
          return {
            content: [
              { type: "image", data: b64, mimeType: zoomMime },
              { type: "text", text: `Zoomed into region [${rx1},${ry1},${rx2},${ry2}]${label}` }
            ]
          };
        }

        case "cursor_position": {
          const pos = dockerExec("xdotool getmouselocation --shell", 30000, cn).toString();
          const xMatch = pos.match(/X=(\d+)/);
          const yMatch = pos.match(/Y=(\d+)/);
          const rawX = xMatch ? parseInt(xMatch[1]) : 0;
          const rawY = yMatch ? parseInt(yMatch[1]) : 0;
          // Convert display coordinates to API space
          const cEnv = environments.get(cn);
          const cW = cEnv?.width || DISPLAY_WIDTH;
          const cH = cEnv?.height || DISPLAY_HEIGHT;
          const cS = getScaleFactor(cW, cH);
          const apiX = cS === 1 ? rawX : Math.round(rawX * cS);
          const apiY = cS === 1 ? rawY : Math.round(rawY * cS);
          return {
            content: [{ type: "text", text: `X=${apiX},Y=${apiY}` }]
          };
        }

        default:
          throw new Error(`Unknown action: ${action}`);
      }

      // Record action if a session is active for this container
      for (const [, session] of activeSessions) {
        if (session.container === cn) {
          session.actions.push({
            timestamp: new Date().toISOString(),
            elapsed_ms: Date.now() - session.startedMs,
            action,
            params: Object.fromEntries(
              Object.entries({ coordinate, text, scroll_direction, scroll_amount, start_coordinate, duration, region })
                .filter(([, v]) => v !== undefined)
            ),
          });
        }
      }

      // For non-screenshot/wait/zoom/cursor_position actions, capture follow-up screenshot
      await new Promise(r => setTimeout(r, SCREENSHOT_DELAY_MS));
      const ss = takeScreenshot(cn);

      // Attach screenshot to session recording if include_screenshots is enabled
      for (const [, session] of activeSessions) {
        if (session.container === cn && session.includeScreenshots && session.actions.length > 0) {
          session.actions[session.actions.length - 1].screenshot = {
            data: ss.data,
            mimeType: ss.mimeType,
          };
        }
      }

      return {
        content: [
          { type: "image", data: ss.data, mimeType: ss.mimeType },
          { type: "text", text: `Action '${action}' completed successfully${label}` }
        ]
      };

    } catch (err) {
      console.error(`[computer] Error in '${action}':`, err.message);
      try {
        const ss = takeScreenshot(container_name || DEFAULT_CONTAINER);
        return {
          content: [
            { type: "image", data: ss.data, mimeType: ss.mimeType },
            { type: "text", text: `Error during '${action}': ${err.message}` }
          ],
          isError: true
        };
      } catch (ssErr) {
        console.error(`[computer] Screenshot also failed:`, ssErr.message);
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true
        };
      }
    }
  }
);

server.tool(
  "computer_bash",
  "Run a bash command inside a computer-use container. Returns stdout/stderr.",
  {
    command: z.string().describe("Bash command to execute inside the container"),
    timeout: z.number().optional().describe("Timeout in seconds (default 120)"),
    container_name: z.string().optional().describe("Target container (default: primary)"),
  },
  async ({ command, timeout, container_name }) => {
    try {
      const cn = resolveContainer(container_name);
      const ms = (timeout || 120) * 1000;
      let result = dockerExec(command, ms, cn).toString();
      if (result.length > MAX_RESPONSE_LEN) {
        result = result.slice(0, MAX_RESPONSE_LEN) + `\n... (truncated at ${MAX_RESPONSE_LEN} chars)`;
      }
      return { content: [{ type: "text", text: result || "(no output)" }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${err.stderr?.toString() || err.message}` }],
        isError: true
      };
    }
  }
);

server.tool(
  "computer_status",
  "Check if a computer-use container is running and healthy.",
  {
    container_name: z.string().optional().describe("Target container (default: primary)"),
  },
  async ({ container_name }) => {
    try {
      const cn = resolveContainer(container_name);
      const status = execFileSync("docker", [
        "inspect", "--format={{.State.Status}}", cn
      ], { timeout: 5000 }).toString().trim();
      const uptime = execFileSync("docker", [
        "inspect", "--format={{.State.StartedAt}}", cn
      ], { timeout: 5000 }).toString().trim();
      let display = "unknown";
      try {
        dockerExec("xdotool getdisplaygeometry", 30000, cn);
        display = "active";
      } catch { display = "inactive"; }
      const env = environments.get(cn);
      const sApi = getApiDimensions(cn);
      const resDisplay = env ? `${env.width}x${env.height}` : `${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}`;
      const resApi = `${sApi.width}x${sApi.height}`;
      const resLine = resDisplay === resApi ? `Resolution: ${resDisplay}` : `Resolution: ${resDisplay} (API: ${resApi}, scaled)`;
      return {
        content: [{ type: "text", text:
          `Container: ${status}\nName: ${cn}\nStarted: ${uptime}\nDisplay: ${display}\n${resLine}` +
          (env ? `\nVNC: ${env.vncPort}\nnoVNC: ${env.novncPort}\nWorkspace: ${env.workspace}` : "")
        }]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Container not found or not running: ${err.message}` }],
        isError: true
      };
    }
  }
);

// === Multi-container management tools ===

server.tool(
  "computer_env_create",
  "Create a new virtual desktop environment (Docker container with Xvfb, VNC, XFCE). Each environment is independent with its own display and workspace.",
  {
    name: z.string().optional().describe("Environment name (auto-generated if omitted)"),
    image: z.string().optional().describe(`Docker image to use (default: ${DEFAULT_IMAGE})`),
    width: z.number().optional().describe("Display width in pixels (default: 1024)"),
    height: z.number().optional().describe("Display height in pixels (default: 768)"),
  },
  async ({ name, image, width, height }) => {
    const envName = name || `env-${randomUUID().slice(0, 6)}`;
    if (environments.has(envName)) {
      return {
        content: [{ type: "text", text: `Environment '${envName}' already exists` }],
        isError: true
      };
    }

    const envImage = image || DEFAULT_IMAGE;
    const envWidth = width || DISPLAY_WIDTH;
    const envHeight = height || DISPLAY_HEIGHT;
    const vncPort = DEFAULT_VNC_PORT + nextEnvPort;
    const novncPort = DEFAULT_NOVNC_PORT + nextEnvPort;
    const workspace = `${DEFAULT_WORKSPACE}-${envName}`;
    nextEnvPort++;

    // Create workspace directory on host
    try { mkdirSync(workspace, { recursive: true }); } catch {}

    // Register before starting so restartContainer can find the config
    environments.set(envName, { image: envImage, vncPort, novncPort, workspace, width: envWidth, height: envHeight, displayNumber: DEFAULT_DISPLAY_NUMBER });

    try {
      execFileSync("docker", [
        "run", "-d", "--name", envName,
        "-e", `SCREEN_RESOLUTION=${envWidth}x${envHeight}`,
        "-p", `${vncPort}:5900`,
        "-p", `${novncPort}:6080`,
        "-v", `${workspace}:/workspace`,
        envImage
      ], { timeout: 30000 });

      // Wait for display readiness
      const envDn = environments.get(envName)?.displayNumber || DEFAULT_DISPLAY_NUMBER;
      let ready = false;
      for (let i = 0; i < 15; i++) {
        try {
          execFileSync("docker", [
            "exec", envName, "bash", "-c", `DISPLAY=:${envDn} xdotool getdisplaygeometry`
          ], { timeout: 5000 });
          ready = true;
          break;
        } catch {}
        execFileSync("sleep", ["1"]);
      }

      const cApi = getApiDimensions(envName);
      const resInfo = cApi.width !== envWidth ? `${envWidth}x${envHeight} (API: ${cApi.width}x${cApi.height})` : `${envWidth}x${envHeight}`;
      return {
        content: [{ type: "text", text:
          `Environment created: ${envName}\n` +
          `Image: ${envImage}\n` +
          `Resolution: ${resInfo}\n` +
          `VNC port: ${vncPort}\n` +
          `noVNC port: ${novncPort}\n` +
          `noVNC URL: http://localhost:${novncPort}/vnc.html\n` +
          `Workspace: ${workspace}\n` +
          `Display: ${ready ? "active" : "starting (may need a few more seconds)"}\n\n` +
          `Use container_name="${envName}" in computer/computer_bash/computer_status to interact with this environment.`
        }]
      };
    } catch (err) {
      environments.delete(envName);
      return {
        content: [{ type: "text", text: `Failed to create environment: ${err.message}` }],
        isError: true
      };
    }
  }
);

server.tool(
  "computer_env_destroy",
  "Destroy a virtual desktop environment. Removes the container but preserves the workspace directory.",
  {
    name: z.string().describe("Environment name to destroy"),
  },
  async ({ name }) => {
    if (name === DEFAULT_CONTAINER) {
      return {
        content: [{ type: "text", text: `Cannot destroy the default environment '${DEFAULT_CONTAINER}'` }],
        isError: true
      };
    }
    if (!environments.has(name)) {
      return {
        content: [{ type: "text", text: `Unknown environment '${name}'` }],
        isError: true
      };
    }

    try {
      execFileSync("docker", ["rm", "-f", name], { timeout: 10000 });
    } catch {}

    const env = environments.get(name);
    environments.delete(name);

    return {
      content: [{ type: "text", text:
        `Environment '${name}' destroyed.\nWorkspace preserved at: ${env.workspace}`
      }]
    };
  }
);

server.tool(
  "computer_env_resize",
  "Change the display resolution of a virtual desktop environment. Restarts Xvfb and VNC — open windows may be rearranged.",
  {
    name: z.string().optional().describe("Environment name (default: primary)"),
    width: z.number().describe("New display width in pixels"),
    height: z.number().describe("New display height in pixels"),
  },
  async ({ name, width, height }) => {
    const cn = resolveContainer(name);
    if (width < 320 || height < 240) {
      return { content: [{ type: "text", text: "Minimum resolution is 320x240" }], isError: true };
    }
    if (width > 3840 || height > 2160) {
      return { content: [{ type: "text", text: "Maximum resolution is 3840x2160" }], isError: true };
    }

    try {
      // Kill Xvfb and x11vnc, restart with new resolution
      // Kill commands may return non-zero (143/SIGTERM propagation) — catch and continue
      const dn = getDisplayNumber(cn);
      try { dockerExec(`pkill -f 'Xvfb :${dn}' || true; exit 0`, 10000, cn); } catch {}
      try { dockerExec(`pkill x11vnc || true; exit 0`, 10000, cn); } catch {}
      await new Promise(r => setTimeout(r, 1500));

      // Start new Xvfb with requested resolution (nohup + & to background)
      dockerExec(`nohup Xvfb :${dn} -screen 0 ${width}x${height}x24 +extension GLX +render -noreset > /dev/null 2>&1 &`, 10000, cn);
      await new Promise(r => setTimeout(r, 2000));

      // Restart x11vnc
      dockerExec(`nohup x11vnc -display :${dn} -forever -passwd secret -noxdamage -shared -rfbport 5900 -noscr > /dev/null 2>&1 &`, 10000, cn);
      await new Promise(r => setTimeout(r, 1000));

      // Restart XFCE desktop (killed when Xvfb died)
      dockerExec(`nohup startxfce4 > /dev/null 2>&1 &`, 10000, cn);
      await new Promise(r => setTimeout(r, 3000));

      // Verify new resolution
      const geom = dockerExec("xdotool getdisplaygeometry", 10000, cn).toString().trim();

      // Update tracked resolution
      const env = environments.get(cn);
      if (env) {
        env.width = width;
        env.height = height;
      }

      const rApi = getApiDimensions(cn);
      const resInfo = rApi.width !== width ? `${width}x${height} (API: ${rApi.width}x${rApi.height})` : `${width}x${height}`;

      const ss = takeScreenshot(cn);
      return {
        content: [
          { type: "image", data: ss.data, mimeType: ss.mimeType },
          { type: "text", text: `Resolution changed to ${resInfo}\nActual display: ${geom}` }
        ]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Failed to resize: ${err.message}` }],
        isError: true
      };
    }
  }
);

// === File exchange tools ===

server.tool(
  "computer_file_read",
  "Read a file from a computer-use container. Returns text content or base64-encoded data for binary files. Useful for extracting screenshots, logs, or any file from the VM.",
  {
    path: z.string().describe("Absolute path to the file inside the container (e.g. /workspace/output.txt, /home/agent/screenshot.png)"),
    encoding: z.enum(["text", "base64"]).optional().describe("How to return the file content: 'text' for UTF-8 text (default), 'base64' for binary files"),
    container_name: z.string().optional().describe("Target container (default: primary)"),
  },
  async ({ path, encoding, container_name }) => {
    try {
      const cn = resolveContainer(container_name);
      const enc = encoding || "text";

      // Check file exists and get size
      const stat = dockerExec(`stat -c '%s %F' '${path.replace(/'/g, "'\\''")}'`, 10000, cn).toString().trim();
      const [sizeStr, fileType] = stat.split(" ", 2);
      const size = parseInt(sizeStr, 10);

      if (fileType?.includes("directory")) {
        // If it's a directory, list contents instead
        const listing = dockerExec(`ls -la '${path.replace(/'/g, "'\\''")}'`, 10000, cn).toString();
        return { content: [{ type: "text", text: listing }] };
      }

      const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
      if (size > MAX_FILE_SIZE) {
        return {
          content: [{ type: "text", text: `File too large: ${size} bytes (max ${MAX_FILE_SIZE}). Use computer_bash to process it first.` }],
          isError: true
        };
      }

      if (enc === "base64") {
        const b64 = dockerExec(`base64 '${path.replace(/'/g, "'\\''")}'`, 60000, cn).toString().replace(/\s/g, "");
        // Detect mime type from extension
        const ext = path.split(".").pop()?.toLowerCase() || "";
        const mimeMap = {
          png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
          svg: "image/svg+xml", pdf: "application/pdf", zip: "application/zip", tar: "application/x-tar",
          gz: "application/gzip", mp4: "video/mp4", mp3: "audio/mpeg", wav: "audio/wav",
        };
        const mime = mimeMap[ext] || "application/octet-stream";
        // Return image types as image content, others as text with base64
        if (mime.startsWith("image/")) {
          return {
            content: [
              { type: "image", data: b64, mimeType: mime },
              { type: "text", text: `File: ${path} (${size} bytes, ${mime})` }
            ]
          };
        }
        return {
          content: [{ type: "text", text: `File: ${path} (${size} bytes, ${mime})\nBase64:\n${b64}` }]
        };
      }

      // Text mode
      let text = dockerExec(`cat '${path.replace(/'/g, "'\\''")}'`, 60000, cn).toString();
      if (text.length > MAX_RESPONSE_LEN) {
        text = text.slice(0, MAX_RESPONSE_LEN) + `\n... (truncated at ${MAX_RESPONSE_LEN} chars, ${size} bytes total)`;
      }
      return { content: [{ type: "text", text: text || "(empty file)" }] };

    } catch (err) {
      return {
        content: [{ type: "text", text: `Error reading file: ${err.stderr?.toString() || err.message}` }],
        isError: true
      };
    }
  }
);

server.tool(
  "computer_file_write",
  "Write content to a file inside a computer-use container. Supports text and base64-encoded binary data. Creates parent directories automatically.",
  {
    path: z.string().describe("Absolute path for the file inside the container (e.g. /workspace/input.txt)"),
    content: z.string().describe("File content: plain text (default) or base64-encoded string (set encoding='base64')"),
    encoding: z.enum(["text", "base64"]).optional().describe("Content encoding: 'text' (default) or 'base64' for binary data"),
    container_name: z.string().optional().describe("Target container (default: primary)"),
  },
  async ({ path: filePath, content, encoding, container_name }) => {
    try {
      const cn = resolveContainer(container_name);
      const enc = encoding || "text";
      const safePath = filePath.replace(/'/g, "'\\''");

      // Create parent directory
      const dir = filePath.substring(0, filePath.lastIndexOf("/"));
      if (dir) {
        dockerExec(`mkdir -p '${dir.replace(/'/g, "'\\''")}'`, 10000, cn);
      }

      if (enc === "base64") {
        // Content is already base64 — write to temp file in chunks, then decode
        const id = randomUUID().slice(0, 8);
        const tmpPath = `/tmp/_fw_${id}.b64`;
        // base64 chars (A-Za-z0-9+/=) are shell-safe, can pass through echo directly
        const CHUNK = 65536;
        dockerExec(`true > '${tmpPath}'`, 10000, cn);
        for (let i = 0; i < content.length; i += CHUNK) {
          const chunk = content.slice(i, i + CHUNK);
          dockerExec(`echo -n '${chunk}' >> '${tmpPath}'`, 30000, cn);
        }
        dockerExec(`base64 -d '${tmpPath}' > '${safePath}' && rm -f '${tmpPath}'`, 30000, cn);
      } else {
        // Text mode: write via base64 to avoid shell escaping issues
        const b64 = Buffer.from(content).toString("base64");
        dockerExec(`echo '${b64}' | base64 -d > '${safePath}'`, 30000, cn);
      }

      // Verify
      const stat = dockerExec(`stat -c '%s' '${safePath}'`, 10000, cn).toString().trim();
      return {
        content: [{ type: "text", text: `Written: ${filePath} (${stat} bytes)` }]
      };

    } catch (err) {
      return {
        content: [{ type: "text", text: `Error writing file: ${err.stderr?.toString() || err.message}` }],
        isError: true
      };
    }
  }
);

server.tool(
  "computer_clipboard",
  "Read or write the clipboard of a computer-use container. Useful for extracting copied text or injecting paste content.",
  {
    action: z.enum(["read", "write"]).describe("'read' to get clipboard contents, 'write' to set clipboard"),
    text: z.string().optional().describe("Text to write to clipboard (required for 'write' action)"),
    selection: z.enum(["clipboard", "primary", "secondary"]).optional().describe("X selection to use (default: 'clipboard'). 'primary' = middle-click paste, 'clipboard' = ctrl+v paste"),
    container_name: z.string().optional().describe("Target container (default: primary)"),
  },
  async ({ action, text, selection, container_name }) => {
    try {
      const cn = resolveContainer(container_name);
      const sel = selection || "clipboard";

      if (action === "write") {
        if (!text) throw new Error("text required for clipboard write");
        // Write via base64 to avoid shell escaping issues
        const b64 = Buffer.from(text).toString("base64");
        dockerExec(`echo '${b64}' | base64 -d | xclip -selection ${sel}`, 10000, cn);
        return {
          content: [{ type: "text", text: `Clipboard (${sel}) set: ${text.length} chars` }]
        };
      }

      // Read
      const content = dockerExec(`xclip -selection ${sel} -o 2>/dev/null || echo "(empty)"`, 10000, cn).toString();
      return {
        content: [{ type: "text", text: content }]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Clipboard error: ${err.stderr?.toString() || err.message}` }],
        isError: true
      };
    }
  }
);

server.tool(
  "computer_window_list",
  "List open windows in a computer-use container. Returns window IDs, titles, and geometry. Useful for finding and targeting specific windows.",
  {
    filter: z.string().optional().describe("Filter windows by title substring (case-insensitive)"),
    container_name: z.string().optional().describe("Target container (default: primary)"),
  },
  async ({ filter, container_name }) => {
    try {
      const cn = resolveContainer(container_name);
      // Get list of window IDs
      const wmctrlAvail = await (async () => {
        try { dockerExec("which wmctrl", 5000, cn); return true; } catch { return false; }
      })();

      let output;
      if (wmctrlAvail) {
        output = dockerExec("wmctrl -l -G", 10000, cn).toString();
      } else {
        // Fallback: xdotool search
        const winIds = dockerExec("xdotool search --onlyvisible --name '.'", 10000, cn).toString().trim().split("\n").filter(Boolean);
        const lines = [];
        for (const wid of winIds.slice(0, 50)) { // Cap at 50 windows
          try {
            const name = dockerExec(`xdotool getwindowname ${wid}`, 5000, cn).toString().trim();
            const geom = dockerExec(`xdotool getwindowgeometry ${wid}`, 5000, cn).toString().trim();
            const posMatch = geom.match(/Position: (\d+),(\d+)/);
            const sizeMatch = geom.match(/Geometry: (\d+x\d+)/);
            lines.push(`${wid}  ${posMatch ? posMatch[1] + "," + posMatch[2] : "?"}  ${sizeMatch ? sizeMatch[1] : "?"}  ${name}`);
          } catch {}
        }
        output = "WID  Position  Size  Title\n" + lines.join("\n");
      }

      if (filter) {
        const f = filter.toLowerCase();
        output = output.split("\n").filter(l => l.toLowerCase().includes(f)).join("\n") || "(no matching windows)";
      }

      return { content: [{ type: "text", text: output || "(no windows)" }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Window list error: ${err.stderr?.toString() || err.message}` }],
        isError: true
      };
    }
  }
);

// === Window Focus Tool ===

server.tool(
  "computer_window_focus",
  `Focus/activate a window by title pattern or window ID. Brings the window to the front and gives it input focus.
Use with computer_window_list to discover window IDs and titles first.`,
  {
    title: z.string().optional().describe("Window title substring to match (case-insensitive). First match is focused."),
    window_id: z.number().optional().describe("Exact X window ID (from computer_window_list) to focus."),
    container_name: z.string().optional().describe("Target container (default: primary)"),
  },
  async ({ title, window_id, container_name }) => {
    try {
      const cn = resolveContainer(container_name);
      const targetWid = findWindowByTitleOrId(title, window_id, cn);

      // Activate and focus the window
      dockerExec(`xdotool windowactivate ${targetWid}`, 10000, cn);
      dockerExec(`xdotool windowfocus ${targetWid}`, 10000, cn);
      await new Promise(r => setTimeout(r, SCREENSHOT_DELAY_MS));

      const ss = takeScreenshot(cn);
      let winName = "";
      try { winName = dockerExec(`xdotool getwindowname ${targetWid}`, 5000, cn).toString().trim(); } catch {}
      return {
        content: [
          { type: "image", data: ss.data, mimeType: ss.mimeType },
          { type: "text", text: `Focused window ${targetWid}: "${winName}"` }
        ]
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Window focus error: ${err.message}` }], isError: true };
    }
  }
);

// === Window Move Tool ===

server.tool(
  "computer_window_move",
  `Move a window to a specific position on screen. Coordinates are in API space (auto-scaled for high-res displays).
Use with computer_window_list to discover window IDs and titles.`,
  {
    x: z.number().describe("Target X position (left edge of window) in API coordinates"),
    y: z.number().describe("Target Y position (top edge of window) in API coordinates"),
    title: z.string().optional().describe("Window title substring to match (case-insensitive). First match is moved."),
    window_id: z.number().optional().describe("Exact X window ID (from computer_window_list) to move."),
    container_name: z.string().optional().describe("Target container (default: primary)"),
  },
  async ({ x, y, title, window_id, container_name }) => {
    try {
      const cn = resolveContainer(container_name);
      const targetWid = findWindowByTitleOrId(title, window_id, cn);

      // Convert API coordinates to display coordinates
      const [dx, dy] = apiToDisplay(x, y, cn);
      dockerExec(`xdotool windowmove ${targetWid} ${dx} ${dy}`, 10000, cn);
      await new Promise(r => setTimeout(r, SCREENSHOT_DELAY_MS));

      const ss = takeScreenshot(cn);
      let winName = "";
      try { winName = dockerExec(`xdotool getwindowname ${targetWid}`, 5000, cn).toString().trim(); } catch {}
      return {
        content: [
          { type: "image", data: ss.data, mimeType: ss.mimeType },
          { type: "text", text: `Moved window ${targetWid} ("${winName}") to [${x}, ${y}] (display: ${dx}, ${dy})` }
        ]
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Window move error: ${err.message}` }], isError: true };
    }
  }
);

// === Window Resize Tool ===

server.tool(
  "computer_window_resize",
  `Resize a window to specific dimensions. Dimensions are in API space (auto-scaled for high-res displays).
Use with computer_window_list to discover window IDs and titles.`,
  {
    width: z.number().describe("Target width in API pixels"),
    height: z.number().describe("Target height in API pixels"),
    title: z.string().optional().describe("Window title substring to match (case-insensitive). First match is resized."),
    window_id: z.number().optional().describe("Exact X window ID (from computer_window_list) to resize."),
    container_name: z.string().optional().describe("Target container (default: primary)"),
  },
  async ({ width, height, title, window_id, container_name }) => {
    try {
      const cn = resolveContainer(container_name);
      const targetWid = findWindowByTitleOrId(title, window_id, cn);

      // Convert API dimensions to display dimensions
      const [dw, dh] = apiToDisplay(width, height, cn);
      dockerExec(`xdotool windowsize ${targetWid} ${dw} ${dh}`, 10000, cn);
      await new Promise(r => setTimeout(r, SCREENSHOT_DELAY_MS));

      const ss = takeScreenshot(cn);
      let winName = "";
      try { winName = dockerExec(`xdotool getwindowname ${targetWid}`, 5000, cn).toString().trim(); } catch {}
      return {
        content: [
          { type: "image", data: ss.data, mimeType: ss.mimeType },
          { type: "text", text: `Resized window ${targetWid} ("${winName}") to ${width}x${height} (display: ${dw}x${dh})` }
        ]
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Window resize error: ${err.message}` }], isError: true };
    }
  }
);

// === Window Manage Tool ===

server.tool(
  "computer_window_manage",
  `Manage window state: minimize, maximize, restore, close, or raise a window.
Use with computer_window_list to discover window IDs and titles.`,
  {
    action: z.enum(["minimize", "maximize", "restore", "close", "raise"]).describe("Window action: minimize (hide), maximize (fill screen), restore (unmaximize), close (destroy), raise (bring to front without focusing)"),
    title: z.string().optional().describe("Window title substring to match (case-insensitive). First match is acted on."),
    window_id: z.number().optional().describe("Exact X window ID (from computer_window_list)."),
    container_name: z.string().optional().describe("Target container (default: primary)"),
  },
  async ({ action, title, window_id, container_name }) => {
    try {
      const cn = resolveContainer(container_name);
      const targetWid = findWindowByTitleOrId(title, window_id, cn);

      let resultText;
      switch (action) {
        case "minimize":
          dockerExec(`xdotool windowminimize ${targetWid}`, 10000, cn);
          resultText = "minimized";
          break;
        case "maximize": {
          // First activate, then get screen dimensions and resize+move to fill
          dockerExec(`xdotool windowactivate ${targetWid}`, 10000, cn);
          const env = environments.get(cn);
          const w = env?.width || DISPLAY_WIDTH;
          const h = env?.height || DISPLAY_HEIGHT;
          dockerExec(`xdotool windowmove ${targetWid} 0 0`, 10000, cn);
          dockerExec(`xdotool windowsize ${targetWid} ${w} ${h}`, 10000, cn);
          resultText = `maximized (${w}x${h})`;
          break;
        }
        case "restore":
          // Unminimize (activate) + resize to reasonable default
          dockerExec(`xdotool windowactivate ${targetWid}`, 10000, cn);
          const env2 = environments.get(cn);
          const rw = Math.round((env2?.width || DISPLAY_WIDTH) * 0.6);
          const rh = Math.round((env2?.height || DISPLAY_HEIGHT) * 0.7);
          dockerExec(`xdotool windowsize ${targetWid} ${rw} ${rh}`, 10000, cn);
          dockerExec(`xdotool windowmove ${targetWid} 50 30`, 10000, cn);
          resultText = `restored (${rw}x${rh})`;
          break;
        case "close":
          dockerExec(`xdotool windowclose ${targetWid}`, 10000, cn);
          resultText = "closed";
          break;
        case "raise":
          dockerExec(`xdotool windowraise ${targetWid}`, 10000, cn);
          resultText = "raised";
          break;
      }

      await new Promise(r => setTimeout(r, SCREENSHOT_DELAY_MS));
      const ss = takeScreenshot(cn);
      let winName = "";
      try { winName = dockerExec(`xdotool getwindowname ${targetWid}`, 5000, cn).toString().trim(); } catch {}
      return {
        content: [
          { type: "image", data: ss.data, mimeType: ss.mimeType },
          { type: "text", text: `Window ${targetWid} ("${winName}"): ${resultText}` }
        ]
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Window manage error: ${err.message}` }], isError: true };
    }
  }
);

// === Window Tile Tool ===

server.tool(
  "computer_window_tile",
  `Auto-arrange visible windows in a tiling layout. Layouts:
- left_right: 2 windows side by side (50/50)
- top_bottom: 2 windows stacked (50/50)
- grid: auto-grid (fills NxM grid based on window count)
- cascade: offset windows diagonally (30px step)
- thirds: 3 windows in equal vertical thirds
Provide titles array to select specific windows, or omit to tile all visible app windows.`,
  {
    layout: z.enum(["left_right", "top_bottom", "grid", "cascade", "thirds"]).describe("Tiling layout preset"),
    titles: z.array(z.string()).optional().describe("Window title substrings to include (in order). Omit to tile all visible windows."),
    gap: z.number().optional().describe("Gap in pixels between windows (default: 0)"),
    container_name: z.string().optional().describe("Target container (default: primary)"),
  },
  async ({ layout, titles, gap = 0, container_name }) => {
    try {
      const cn = resolveContainer(container_name);
      const env = environments.get(cn);
      const screenW = env?.width || DISPLAY_WIDTH;
      const screenH = env?.height || DISPLAY_HEIGHT;

      // Get windows to tile
      let windows;
      if (titles && titles.length > 0) {
        windows = [];
        for (const t of titles) {
          try {
            const wid = findWindowByTitleOrId(t, undefined, cn);
            const name = dockerExec(`xdotool getwindowname ${wid}`, 5000, cn).toString().trim();
            windows.push({ wid, name });
          } catch { /* skip unfound windows */ }
        }
      } else {
        windows = getVisibleWindows(cn);
      }

      if (windows.length === 0) throw new Error("No windows found to tile");

      // Compute slots based on layout
      const slots = [];
      const n = windows.length;
      const g = gap;

      switch (layout) {
        case "left_right": {
          const count = Math.min(n, 2);
          const w = Math.floor((screenW - g * (count - 1)) / count);
          for (let i = 0; i < count; i++) {
            slots.push({ x: i * (w + g), y: 0, w, h: screenH });
          }
          break;
        }
        case "top_bottom": {
          const count = Math.min(n, 2);
          const h = Math.floor((screenH - g * (count - 1)) / count);
          for (let i = 0; i < count; i++) {
            slots.push({ x: 0, y: i * (h + g), w: screenW, h });
          }
          break;
        }
        case "grid": {
          const cols = Math.ceil(Math.sqrt(n));
          const rows = Math.ceil(n / cols);
          const cellW = Math.floor((screenW - g * (cols - 1)) / cols);
          const cellH = Math.floor((screenH - g * (rows - 1)) / rows);
          for (let i = 0; i < n; i++) {
            const col = i % cols;
            const row = Math.floor(i / cols);
            slots.push({ x: col * (cellW + g), y: row * (cellH + g), w: cellW, h: cellH });
          }
          break;
        }
        case "cascade": {
          const step = 30;
          const baseW = Math.floor(screenW * 0.7);
          const baseH = Math.floor(screenH * 0.7);
          for (let i = 0; i < n; i++) {
            slots.push({ x: i * step, y: i * step, w: baseW, h: baseH });
          }
          break;
        }
        case "thirds": {
          const count = Math.min(n, 3);
          const w = Math.floor((screenW - g * (count - 1)) / count);
          for (let i = 0; i < count; i++) {
            slots.push({ x: i * (w + g), y: 0, w, h: screenH });
          }
          break;
        }
      }

      // Apply layout: move + resize each window to its slot
      const results = [];
      for (let i = 0; i < Math.min(windows.length, slots.length); i++) {
        const win = windows[i];
        const slot = slots[i];
        try {
          dockerExec(`xdotool windowactivate ${win.wid}`, 10000, cn);
          dockerExec(`xdotool windowsize ${win.wid} ${slot.w} ${slot.h}`, 10000, cn);
          dockerExec(`xdotool windowmove ${win.wid} ${slot.x} ${slot.y}`, 10000, cn);
          results.push(`${win.name}: ${slot.w}x${slot.h} at (${slot.x},${slot.y})`);
        } catch (e) {
          results.push(`${win.name}: FAILED — ${e.message}`);
        }
      }

      await new Promise(r => setTimeout(r, SCREENSHOT_DELAY_MS));
      const ss = takeScreenshot(cn);
      return {
        content: [
          { type: "image", data: ss.data, mimeType: ss.mimeType },
          { type: "text", text: `Tiled ${Math.min(windows.length, slots.length)} windows (${layout}):\n${results.join("\n")}` }
        ]
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Window tile error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "computer_process_list",
  "List running processes inside a computer-use container. Returns a process table (PID, CPU%, MEM%, command). Useful for debugging, finding stuck processes, or checking what's running.",
  {
    filter: z.string().optional().describe("Filter by process name (case-insensitive grep)"),
    container_name: z.string().optional().describe("Target container (default: primary)"),
  },
  async ({ filter, container_name }) => {
    try {
      const cn = resolveContainer(container_name);
      let cmd = "ps aux --sort=-%cpu";
      if (filter) {
        // grep -i for case-insensitive, grep -v grep to exclude the grep process itself
        cmd += ` | grep -i '${filter.replace(/'/g, "'\\''")}' | grep -v grep`;
      }
      const output = dockerExec(cmd, 10000, cn).toString();
      let result = output;
      if (result.length > MAX_RESPONSE_LEN) {
        result = result.slice(0, MAX_RESPONSE_LEN) + "\n... (truncated)";
      }
      return { content: [{ type: "text", text: result || "(no processes)" }] };
    } catch (err) {
      // grep returns exit code 1 when no matches found — not a real error
      const stderr = err.stderr?.toString() || "";
      if (filter && !stderr && (err.status === 1 || err.status === 123)) {
        return { content: [{ type: "text", text: `(no processes matching '${filter}')` }] };
      }
      return {
        content: [{ type: "text", text: `Process list error: ${stderr || err.message}` }],
        isError: true
      };
    }
  }
);

server.tool(
  "computer_process_kill",
  "Kill a process inside a computer-use container by PID or name. Use computer_process_list first to find the target.",
  {
    pid: z.number().optional().describe("Process ID to kill"),
    name: z.string().optional().describe("Process name to kill (uses pkill — kills all matching processes)"),
    signal: z.string().optional().describe("Signal to send (default: TERM). Common: TERM, KILL, INT, HUP"),
    container_name: z.string().optional().describe("Target container (default: primary)"),
  },
  async ({ pid, name, signal, container_name }) => {
    try {
      const cn = resolveContainer(container_name);
      if (!pid && !name) throw new Error("Either pid or name required");
      const sig = signal || "TERM";

      // Safety: prevent killing critical system processes
      const protectedNames = ["Xvfb", "x11vnc", "xfce4-session", "start.sh", "bash"];
      if (name && protectedNames.some(p => name.toLowerCase() === p.toLowerCase())) {
        return {
          content: [{ type: "text", text: `Refusing to kill protected process '${name}'. Critical for VM operation.` }],
          isError: true
        };
      }

      let cmd;
      if (pid) {
        // Protect PID 1 and low PIDs
        if (pid <= 1) {
          return { content: [{ type: "text", text: "Cannot kill PID 1 (init process)" }], isError: true };
        }
        cmd = `kill -${sig} ${pid}`;
      } else {
        cmd = `pkill -${sig} -f '${name.replace(/'/g, "'\\''")}'`;
      }

      try {
        dockerExec(cmd, 10000, cn);
      } catch {}

      // Verify
      let still_running = false;
      try {
        if (pid) {
          dockerExec(`kill -0 ${pid} 2>/dev/null`, 5000, cn);
          still_running = true;
        }
      } catch {}

      const target = pid ? `PID ${pid}` : `'${name}'`;
      return {
        content: [{
          type: "text",
          text: still_running
            ? `Signal ${sig} sent to ${target} — process still running (may need KILL signal)`
            : `Signal ${sig} sent to ${target}`
        }]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Kill error: ${err.stderr?.toString() || err.message}` }],
        isError: true
      };
    }
  }
);

server.tool(
  "computer_env_list",
  "List all managed virtual desktop environments and their status.",
  {},
  async () => {
    try {
      const results = [];
      for (const [name, env] of environments) {
        let status = "unknown";
        try {
          status = execFileSync("docker", [
            "inspect", "--format={{.State.Status}}", name
          ], { timeout: 5000 }).toString().trim();
        } catch { status = "not found"; }

        const lApi = getApiDimensions(name);
        const lRes = env.width ? `${env.width}x${env.height}` : `${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}`;
        const lApiRes = `${lApi.width}x${lApi.height}`;
        const lResInfo = lRes !== lApiRes ? `${lRes} (API:${lApiRes})` : lRes;
        results.push(
          `${name}${name === DEFAULT_CONTAINER ? " (default)" : ""}: ${status}` +
          `  ${lResInfo}  VNC:${env.vncPort}  noVNC:${env.novncPort}  workspace:${env.workspace}`
        );
      }
      return {
        content: [{ type: "text", text: results.length > 0 ? results.join("\n") : "No environments registered" }]
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Env list error: ${err.message}` }], isError: true };
    }
  }
);

// === Browser & Application Helpers ===

server.tool(
  "computer_navigate",
  "Open a URL in Firefox inside the container. If Firefox is not running, launches it. If it is running, opens the URL in a new tab. Returns a screenshot after page load.",
  {
    url: z.string().describe("URL to navigate to (e.g. 'https://example.com')"),
    wait_seconds: z.number().optional().describe("Seconds to wait for page load before screenshot (default: 3)"),
    new_window: z.boolean().optional().describe("Open in a new window instead of a new tab (default: false)"),
    container_name: z.string().optional().describe("Target container (default: primary)"),
  },
  async ({ url, wait_seconds, new_window, container_name }) => {
    try {
      const cn = resolveContainer(container_name);
      const waitSec = Math.min(Math.max(wait_seconds || 3, 1), 30);

      // Validate URL - must have a scheme
      let targetUrl = url;
      if (!targetUrl.match(/^[a-zA-Z]+:\/\//)) {
        targetUrl = "https://" + targetUrl;
      }

      // Auto-detect browser binary (firefox-esr on Debian/Ubuntu, firefox on others)
      let browserBin;
      try {
        browserBin = dockerExec("which firefox-esr || which firefox", 5000, cn).toString().trim().split("\n")[0];
      } catch {
        browserBin = "firefox-esr"; // fallback
      }

      const firefoxArgs = new_window ? ["--new-window", targetUrl] : [targetUrl];
      try {
        dockerExec(
          `DISPLAY=:${getDisplayNumber(cn)} ${browserBin} ${firefoxArgs.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ")} &`,
          5000, cn
        );
      } catch {
        // browser CLI sometimes exits non-zero even when it works (async launch)
      }

      // Wait for page load
      await new Promise(r => setTimeout(r, waitSec * 1000));

      // Take screenshot
      const ss = takeScreenshot(cn);
      return {
        content: [
          { type: "image", data: ss.data, mimeType: ss.mimeType },
          { type: "text", text: `Navigated to ${targetUrl} (${ss.apiWidth}x${ss.apiHeight}, waited ${waitSec}s)` }
        ]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Navigate error: ${err.message}` }],
        isError: true
      };
    }
  }
);

server.tool(
  "computer_open",
  "Open a file or launch an application inside the container. Uses xdg-open for files or direct command for apps.",
  {
    target: z.string().describe("File path to open, application name (e.g. 'xfce4-terminal', 'mousepad', 'thunar'), or command to run"),
    args: z.array(z.string()).optional().describe("Additional arguments"),
    wait_seconds: z.number().optional().describe("Seconds to wait before screenshot (default: 2)"),
    container_name: z.string().optional().describe("Target container (default: primary)"),
  },
  async ({ target, args, wait_seconds, container_name }) => {
    try {
      const cn = resolveContainer(container_name);
      const waitSec = Math.min(Math.max(wait_seconds || 2, 1), 30);
      const extraArgs = args ? " " + args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ") : "";

      // Determine if it's a file path or an application
      const isPath = target.startsWith("/") || target.startsWith("~") || target.startsWith("./");
      const cmd = isPath
        ? `DISPLAY=:${getDisplayNumber(cn)} xdg-open '${target.replace(/'/g, "'\\''")}' &`
        : `DISPLAY=:${getDisplayNumber(cn)} ${target}${extraArgs} &`;

      try {
        dockerExec(cmd, 5000, cn);
      } catch {
        // Async launch may exit non-zero
      }

      await new Promise(r => setTimeout(r, waitSec * 1000));

      const ss = takeScreenshot(cn);
      return {
        content: [
          { type: "image", data: ss.data, mimeType: ss.mimeType },
          { type: "text", text: `Opened ${target}${extraArgs} (${ss.apiWidth}x${ss.apiHeight})` }
        ]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Open error: ${err.message}` }],
        isError: true
      };
    }
  }
);

// === Session Recording/Replay Tools ===

server.tool(
  "computer_session_start",
  "Start recording actions performed on a virtual desktop. All subsequent computer actions will be logged to the session. Use computer_session_stop to save the recording.",
  {
    name: z.string().optional().describe("Session name (auto-generated if omitted)"),
    include_screenshots: z.boolean().optional().describe("Capture a screenshot after each action (default: false). Makes session files larger but provides visual state for debugging."),
    container_name: z.string().optional().describe("Container to record (default: primary)"),
  },
  async ({ name, include_screenshots, container_name }) => {
    try {
      const cn = resolveContainer(container_name);
      const sessionName = name || `session-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;

      if (activeSessions.has(sessionName)) {
        return {
          content: [{ type: "text", text: `Session '${sessionName}' is already recording` }],
          isError: true
        };
      }

      // Only one active session per container
      for (const [existingName, session] of activeSessions) {
        if (session.container === cn) {
          return {
            content: [{ type: "text", text: `Container '${cn}' already has active session '${existingName}'. Stop it first.` }],
            isError: true
          };
        }
      }

      const env = environments.get(cn);
      activeSessions.set(sessionName, {
        name: sessionName,
        container: cn,
        started: new Date().toISOString(),
        startedMs: Date.now(),
        resolution: `${env?.width || DISPLAY_WIDTH}x${env?.height || DISPLAY_HEIGHT}`,
        includeScreenshots: !!include_screenshots,
        actions: [],
      });

      return {
        content: [{ type: "text", text: `Recording started: '${sessionName}' on container '${cn}'\nAll computer actions will be logged. Use computer_session_stop to save.` }]
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Session start error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "computer_session_stop",
  "Stop recording and save the session to the workspace. Returns a summary of recorded actions.",
  {
    name: z.string().optional().describe("Session name to stop (stops the only active session if omitted)"),
    discard: z.boolean().optional().describe("If true, discard the recording instead of saving (default: false)"),
  },
  async ({ name, discard }) => {
    try {
      let sessionName = name;

      // If no name given and exactly one active session, use that
      if (!sessionName) {
        if (activeSessions.size === 0) {
          return { content: [{ type: "text", text: "No active recording sessions" }], isError: true };
        }
        if (activeSessions.size === 1) {
          sessionName = activeSessions.keys().next().value;
        } else {
          const names = [...activeSessions.keys()].join(", ");
          return {
            content: [{ type: "text", text: `Multiple active sessions: ${names}. Specify which to stop.` }],
            isError: true
          };
        }
      }

      const session = activeSessions.get(sessionName);
      if (!session) {
        return { content: [{ type: "text", text: `No active session '${sessionName}'` }], isError: true };
      }

      activeSessions.delete(sessionName);

      if (discard) {
        return {
          content: [{ type: "text", text: `Session '${sessionName}' discarded (${session.actions.length} actions)` }]
        };
      }

      // Save session to workspace
      const sessionData = {
        name: session.name,
        container: session.container,
        resolution: session.resolution,
        include_screenshots: session.includeScreenshots,
        started: session.started,
        ended: new Date().toISOString(),
        duration_ms: Date.now() - session.startedMs,
        action_count: session.actions.length,
        actions: session.actions,
      };

      const env = environments.get(session.container);
      const workspace = env?.workspace || DEFAULT_WORKSPACE;
      const sessionsDir = `${workspace}/sessions`;
      try { mkdirSync(sessionsDir, { recursive: true }); } catch {}
      const filePath = `${sessionsDir}/${sessionName}.json`;
      writeFileSync(filePath, JSON.stringify(sessionData, null, 2));

      // Build action summary
      const actionCounts = {};
      for (const a of session.actions) {
        actionCounts[a.action] = (actionCounts[a.action] || 0) + 1;
      }
      const summary = Object.entries(actionCounts).map(([k, v]) => `  ${k}: ${v}`).join("\n");

      return {
        content: [{ type: "text", text:
          `Session '${sessionName}' saved (${session.actions.length} actions, ${Math.round(sessionData.duration_ms / 1000)}s)\n` +
          `File: ${filePath}\n` +
          `Resolution: ${session.resolution}\n` +
          `Actions:\n${summary}\n\n` +
          `Use computer_session_replay to replay this session.`
        }]
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Session stop error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "computer_session_replay",
  "Replay a previously recorded session. Executes all recorded actions in order with timing preservation.",
  {
    name: z.string().describe("Session name or path to session JSON file"),
    speed: z.number().optional().describe("Playback speed multiplier (default: 1.0, use 2.0 for 2x speed, 0.5 for half speed)"),
    container_name: z.string().optional().describe("Target container (default: uses container from recording)"),
    dry_run: z.boolean().optional().describe("If true, just list the actions without executing them"),
  },
  async ({ name, speed, container_name, dry_run }) => {
    try {
    const playbackSpeed = Math.max(0.1, Math.min(speed || 1.0, 10.0));

    // Load session — check workspace first, then treat as absolute path
    let sessionData;
    const env = environments.get(container_name || DEFAULT_CONTAINER);
    const workspace = env?.workspace || DEFAULT_WORKSPACE;
    const sessionPath = `${workspace}/sessions/${name}.json`;

    try {
      if (existsSync(sessionPath)) {
        sessionData = JSON.parse(readFileSync(sessionPath, "utf-8"));
      } else if (existsSync(name)) {
        sessionData = JSON.parse(readFileSync(name, "utf-8"));
      } else {
        // Try listing available sessions
        let available = "";
        const sessDir = `${workspace}/sessions`;
        try {
          available = readdirSync(sessDir).filter(f => f.endsWith(".json")).map(f => f.replace(".json", "")).join(", ");
        } catch {}
        return {
          content: [{ type: "text", text: `Session '${name}' not found at ${sessionPath}${available ? `\nAvailable sessions: ${available}` : ""}` }],
          isError: true
        };
      }
    } catch (err) {
      return {
        content: [{ type: "text", text: `Failed to load session: ${err.message}` }],
        isError: true
      };
    }

    const cn = resolveContainer(container_name || sessionData.container);
    const actions = sessionData.actions || [];

    if (actions.length === 0) {
      return { content: [{ type: "text", text: `Session '${name}' has no actions to replay` }] };
    }

    // Dry run — just list actions
    if (dry_run) {
      const listing = actions.map((a, i) =>
        `${i + 1}. [${(a.elapsed_ms / 1000).toFixed(1)}s] ${a.action}${a.params ? " " + JSON.stringify(a.params) : ""}`
      ).join("\n");
      return {
        content: [{ type: "text", text:
          `Session '${sessionData.name}' (${actions.length} actions, ${Math.round(sessionData.duration_ms / 1000)}s)\n` +
          `Speed: ${playbackSpeed}x → ~${Math.round(sessionData.duration_ms / playbackSpeed / 1000)}s\n\n${listing}`
        }]
      };
    }

    // Execute replay
    let completed = 0;
    let errors = [];
    let prevElapsed = 0;

    for (const actionEntry of actions) {
      // Wait for timing (preserve relative delays between actions)
      const delay = actionEntry.elapsed_ms - prevElapsed;
      if (delay > 0) {
        await new Promise(r => setTimeout(r, delay / playbackSpeed));
      }
      prevElapsed = actionEntry.elapsed_ms;

      try {
        const { action, params } = actionEntry;
        // Skip screenshot-only actions during replay (they don't do anything)
        if (action === "screenshot") {
          completed++;
          continue;
        }

        if (action === "wait") {
          const waitDur = (params?.duration || 1) / playbackSpeed;
          await new Promise(r => setTimeout(r, waitDur * 1000));
          completed++;
          continue;
        }

        // Execute the action
        executeAction({
          action,
          coordinate: params?.coordinate,
          text: params?.text,
          scroll_direction: params?.scroll_direction,
          scroll_amount: params?.scroll_amount,
          start_coordinate: params?.start_coordinate,
          duration: params?.duration,
          region: params?.region,
        }, cn);
        completed++;

        // Brief delay after each action (let the UI catch up)
        await new Promise(r => setTimeout(r, Math.max(200, SCREENSHOT_DELAY_MS / 2) / playbackSpeed));

      } catch (err) {
        errors.push(`Action ${completed + 1} (${actionEntry.action}): ${err.message}`);
        completed++;
      }
    }

    // Final screenshot
    const ss = takeScreenshot(cn);
    const resultText = [
      `Replay complete: '${sessionData.name}'`,
      `${completed}/${actions.length} actions executed at ${playbackSpeed}x speed`,
      errors.length > 0 ? `\nErrors (${errors.length}):\n${errors.join("\n")}` : "",
    ].filter(Boolean).join("\n");

    return {
      content: [
        { type: "image", data: ss.data, mimeType: ss.mimeType },
        { type: "text", text: resultText }
      ]
    };
    } catch (err) {
      return { content: [{ type: "text", text: `Session replay error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "computer_wait_for",
  `Wait for the display to reach a visual state. Two modes:
- "stable": Wait until the screen stops changing (e.g. page finished loading, animation ended). Returns when N consecutive screenshots are identical.
- "change": Wait until the screen changes from its current state (e.g. waiting for command output, dialog to appear).
Optional region parameter monitors only a portion of the screen (avoids false triggers from clocks, cursors, etc.).`,
  {
    mode: z.enum(["stable", "change"]).default("stable").describe("'stable' = wait for screen to stop changing; 'change' = wait for screen to differ from current"),
    region: z.array(z.number()).optional().describe("[x1, y1, x2, y2] monitor only this region (API coordinates). Omit to monitor full screen."),
    timeout: z.number().min(1).max(60).default(10).describe("Max seconds to wait before returning (default: 10)"),
    interval: z.number().min(0.5).max(10).default(1).describe("Seconds between screenshot checks (default: 1)"),
    stable_count: z.number().min(2).max(10).default(2).describe("For 'stable' mode: consecutive identical frames needed (default: 2)"),
    container_name: z.string().optional().describe("Target container (default: primary)"),
  },
  async ({ mode, region, timeout, interval, stable_count, container_name }) => {
    try {
    const cn = resolveContainer(container_name);

    // Helper: take screenshot and return hash + data
    function captureAndHash() {
      if (region && region.length === 4) {
        // Crop to region for comparison
        const [rx1, ry1, rx2, ry2] = region;
        const [dx1, dy1] = apiToDisplay(rx1, ry1, cn);
        const [dx2, dy2] = apiToDisplay(rx2, ry2, cn);
        const cropW = dx2 - dx1;
        const cropH = dy2 - dy1;
        if (cropW <= 0 || cropH <= 0) throw new Error("region must have positive width and height");
        const id = randomUUID().slice(0, 8);
        const ssPath = `/tmp/_wf_${id}.png`;
        const useJpeg = SCREENSHOT_FORMAT === "jpeg" || SCREENSHOT_FORMAT === "jpg";
        const outExt = useJpeg ? "jpg" : "png";
        const cropPath = `/tmp/_wf_${id}_crop.${outExt}`;
        const qualityFlag = useJpeg ? `-quality ${SCREENSHOT_QUALITY}` : "";
        dockerExec(`scrot -o ${ssPath}`, 30000, cn);
        dockerExec(`convert ${ssPath} -crop ${cropW}x${cropH}+${dx1}+${dy1} +repage ${qualityFlag} ${cropPath}`, 30000, cn);
        const b64 = dockerExec(`base64 ${cropPath} && rm -f ${ssPath} ${cropPath}`, 30000, cn).toString().replace(/\s/g, "");
        const hash = createHash("md5").update(b64).digest("hex");
        const mime = useJpeg ? "image/jpeg" : "image/png";
        return { hash, data: b64, mimeType: mime };
      } else {
        // Full screenshot
        const ss = takeScreenshot(cn);
        const hash = createHash("md5").update(ss.data).digest("hex");
        return { hash, data: ss.data, mimeType: ss.mimeType };
      }
    }

    const startTime = Date.now();
    const timeoutMs = timeout * 1000;
    const intervalMs = interval * 1000;
    let checks = 0;
    let lastCapture = null;

    if (mode === "change") {
      // Take initial screenshot, then wait for it to differ
      const initial = captureAndHash();
      checks = 1;
      while (Date.now() - startTime < timeoutMs) {
        await new Promise(r => setTimeout(r, intervalMs));
        const current = captureAndHash();
        checks++;
        if (current.hash !== initial.hash) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          return {
            content: [
              { type: "image", data: current.data, mimeType: current.mimeType },
              { type: "text", text: `Screen changed after ${elapsed}s (${checks} checks)${region ? ` [region ${region.join(",")}]` : ""}` }
            ]
          };
        }
      }
      // Timeout — return last screenshot
      const final = captureAndHash();
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      return {
        content: [
          { type: "image", data: final.data, mimeType: final.mimeType },
          { type: "text", text: `Timeout: no change detected after ${elapsed}s (${checks + 1} checks)${region ? ` [region ${region.join(",")}]` : ""}` }
        ]
      };
    }

    // mode === "stable": wait for consecutive identical frames
    let consecutiveMatches = 0;
    let prevHash = null;

    while (Date.now() - startTime < timeoutMs) {
      const current = captureAndHash();
      checks++;
      if (prevHash !== null && current.hash === prevHash) {
        consecutiveMatches++;
        if (consecutiveMatches >= stable_count - 1) {
          // We have stable_count identical frames (current + (stable_count-1) previous matches)
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          return {
            content: [
              { type: "image", data: current.data, mimeType: current.mimeType },
              { type: "text", text: `Screen stable after ${elapsed}s (${stable_count} identical frames, ${checks} checks)${region ? ` [region ${region.join(",")}]` : ""}` }
            ]
          };
        }
      } else {
        consecutiveMatches = 0;
      }
      prevHash = current.hash;
      lastCapture = current;
      await new Promise(r => setTimeout(r, intervalMs));
    }

    // Timeout — return last screenshot
    const final = lastCapture || captureAndHash();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    return {
      content: [
        { type: "image", data: final.data, mimeType: final.mimeType },
        { type: "text", text: `Timeout: screen did not stabilize after ${elapsed}s (max consecutive matches: ${consecutiveMatches}, needed ${stable_count - 1}, ${checks} checks)${region ? ` [region ${region.join(",")}]` : ""}` }
      ]
    };
    } catch (err) {
      return { content: [{ type: "text", text: `Wait-for error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "computer_shortcut",
  `Execute a named keyboard shortcut. Convenience wrapper around the key action.
Use name="list" to see all available shortcuts.
Categories: clipboard (copy/cut/paste), editing (undo/redo/select_all), file (save/open/new),
search (find/find_replace), browser (new_tab/close_tab/refresh/address_bar/back/forward),
window (close_window/fullscreen/switch_window), terminal (terminal_copy/terminal_paste),
zoom (zoom_in/zoom_out/zoom_reset).`,
  {
    name: z.string().describe("Shortcut name (e.g. 'copy', 'paste', 'undo', 'new_tab', 'fullscreen') or 'list' to show all"),
    container_name: z.string().optional().describe("Target container (default: primary)"),
  },
  async ({ name: shortcutName, container_name }) => {
    if (shortcutName === "list") {
      const grouped = {};
      const categories = {
        clipboard: ["copy", "cut", "paste"],
        editing: ["undo", "redo", "select_all", "delete_line"],
        file: ["save", "save_as", "open", "new_file", "print"],
        search: ["find", "find_replace", "find_next"],
        browser: ["new_tab", "close_tab", "reopen_tab", "next_tab", "prev_tab", "refresh", "hard_refresh", "address_bar", "back", "forward"],
        window: ["close_window", "fullscreen", "switch_window"],
        terminal: ["terminal_copy", "terminal_paste"],
        zoom: ["zoom_in", "zoom_out", "zoom_reset"],
      };
      let listing = "";
      for (const [cat, names] of Object.entries(categories)) {
        listing += `\n${cat}:\n`;
        for (const n of names) {
          listing += `  ${n} → ${SHORTCUTS[n]}\n`;
        }
      }
      return { content: [{ type: "text", text: `Available shortcuts:${listing}` }] };
    }

    const combo = SHORTCUTS[shortcutName];
    if (!combo) {
      const suggestions = Object.keys(SHORTCUTS).filter(k => k.includes(shortcutName)).slice(0, 5);
      return {
        content: [{ type: "text", text: `Unknown shortcut '${shortcutName}'${suggestions.length > 0 ? `. Did you mean: ${suggestions.join(", ")}?` : ""}\nUse name="list" to see all shortcuts.` }],
        isError: true
      };
    }

    try {
      const cn = resolveContainer(container_name);
      executeAction({ action: "key", text: combo }, cn);
      await new Promise(r => setTimeout(r, SCREENSHOT_DELAY_MS));
      const ss = takeScreenshot(cn);
      return {
        content: [
          { type: "image", data: ss.data, mimeType: ss.mimeType },
          { type: "text", text: `Shortcut '${shortcutName}' executed (${combo})` }
        ]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error executing shortcut '${shortcutName}': ${err.message}` }],
        isError: true
      };
    }
  }
);

// === OCR Helper ===

// Parse tesseract TSV output into word objects
function parseTesseractTsv(tsv) {
  const words = [];
  for (const line of tsv.split("\n").slice(1)) {
    const cols = line.split("\t");
    if (cols.length < 12) continue;
    if (parseInt(cols[0]) !== 5) continue;
    const conf = parseFloat(cols[10]);
    const text = cols[11]?.trim();
    if (!text || conf < 0) continue;
    words.push({
      text,
      left: parseInt(cols[6]),
      top: parseInt(cols[7]),
      width: parseInt(cols[8]),
      height: parseInt(cols[9]),
      conf,
      lineNum: parseInt(cols[4]),
      blockNum: parseInt(cols[2]),
      parNum: parseInt(cols[3]),
    });
  }
  return words;
}

// Search parsed words for query matches, return matches array
function matchWordsToQuery(words, query, regionOffsetX, regionOffsetY, cn, returnAll) {
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter(w => w.length > 0);
  const matches = [];
  const env = environments.get(cn);
  const dw = env?.width || DISPLAY_WIDTH;
  const dh = env?.height || DISPLAY_HEIGHT;
  const s = getScaleFactor(dw, dh);

  // Helper to build a match result from a span of words
  function buildMatch(wordSpan) {
    const first = wordSpan[0];
    const last = wordSpan[wordSpan.length - 1];
    const spanLeft = first.left + regionOffsetX;
    const spanTop = Math.min(...wordSpan.map(w => w.top)) + regionOffsetY;
    const spanRight = last.left + last.width + regionOffsetX;
    const spanBottom = Math.max(...wordSpan.map(w => w.top + w.height)) + regionOffsetY;
    const displayCenterX = Math.round((spanLeft + spanRight) / 2);
    const displayCenterY = Math.round((spanTop + spanBottom) / 2);
    return {
      text: wordSpan.map(w => w.text).join(" "),
      coordinate: [Math.round(displayCenterX * s), Math.round(displayCenterY * s)],
      confidence: Math.round(Math.min(...wordSpan.map(w => w.conf))),
      bounds: { left: Math.round(spanLeft * s), top: Math.round(spanTop * s), width: Math.round((spanRight - spanLeft) * s), height: Math.round((spanBottom - spanTop) * s) }
    };
  }

  if (queryWords.length === 1) {
    // Direct single-word match
    for (const w of words) {
      if (w.text.toLowerCase().includes(queryLower)) {
        matches.push(buildMatch([w]));
        if (!returnAll) break;
      }
    }
    // Concatenation fallback: tesseract sometimes merges adjacent words (e.g. "Sign in" → "signin")
    // or splits them unexpectedly. Check pairs/triples of adjacent same-line words.
    if (matches.length === 0) {
      const queryNoSpaces = queryLower.replace(/\s+/g, "");
      for (let i = 0; i < words.length; i++) {
        for (let span = 2; span <= Math.min(3, words.length - i); span++) {
          const group = words.slice(i, i + span);
          // Must be on the same line
          if (!group.every(w => w.lineNum === group[0].lineNum && w.blockNum === group[0].blockNum && w.parNum === group[0].parNum)) break;
          const concat = group.map(w => w.text.toLowerCase()).join("");
          if (concat.includes(queryNoSpaces)) {
            matches.push(buildMatch(group));
            if (!returnAll) { i = words.length; break; }
          }
        }
      }
    }
  } else {
    // Multi-word query: match each query word against consecutive OCR words on the same line
    for (let i = 0; i <= words.length - queryWords.length; i++) {
      let match = true;
      for (let j = 0; j < queryWords.length; j++) {
        const w = words[i + j];
        if (!w.text.toLowerCase().includes(queryWords[j])) { match = false; break; }
        if (j > 0) {
          const prev = words[i + j - 1];
          if (w.lineNum !== prev.lineNum || w.blockNum !== prev.blockNum || w.parNum !== prev.parNum) {
            match = false; break;
          }
        }
      }
      if (match) {
        matches.push(buildMatch(words.slice(i, i + queryWords.length)));
        if (!returnAll) break;
      }
    }
    // Concatenation fallback for multi-word queries: check if a single OCR word contains
    // all query words joined (e.g. searching "sign in" when tesseract returns "signin")
    if (matches.length === 0) {
      const queryNoSpaces = queryLower.replace(/\s+/g, "");
      for (const w of words) {
        if (w.text.toLowerCase().includes(queryNoSpaces)) {
          matches.push(buildMatch([w]));
          if (!returnAll) break;
        }
      }
    }
  }

  return matches;
}

// Shared text-finding logic used by computer_find_text and computer_scroll_to
// Color channel fallback: if text not found on primary OCR, retries on each RGB channel
// separately. This catches text on colored backgrounds (e.g. white text on orange bars)
// that tesseract's default binarization misses on full-screen images.
function findTextOnScreen(query, cn, lang = "eng", region = null, returnAll = true) {
  const id = randomUUID().slice(0, 8);
  const pngPath = `/tmp/_fts_${id}.png`;

  dockerExec(`scrot -o ${pngPath}`, 30000, cn);

  let regionOffsetX = 0, regionOffsetY = 0;
  let ocrInput = pngPath;

  if (region) {
    const [x1, y1, x2, y2] = region;
    const [dx1, dy1] = apiToDisplay(x1, y1, cn);
    const [dx2, dy2] = apiToDisplay(x2, y2, cn);
    const w = dx2 - dx1;
    const h = dy2 - dy1;
    if (w <= 0 || h <= 0) throw new Error("Invalid region: width and height must be positive");
    const cropPath = `/tmp/_fts_${id}_crop.png`;
    dockerExec(`convert ${pngPath} -crop ${w}x${h}+${dx1}+${dy1} +repage ${cropPath}`, 30000, cn);
    ocrInput = cropPath;
    regionOffsetX = dx1;
    regionOffsetY = dy1;
  }

  // Primary OCR pass
  const outBase = `/tmp/_fts_${id}_out`;
  dockerExec(`tesseract ${ocrInput} ${outBase} -l ${lang} --psm 3 tsv 2>/dev/null`, 60000, cn);
  const tsv = dockerExec(`cat ${outBase}.tsv`, 10000, cn).toString();
  const words = parseTesseractTsv(tsv);
  let matches = matchWordsToQuery(words, query, regionOffsetX, regionOffsetY, cn, returnAll);

  // Color channel fallback: retry on R, G, B channels if nothing found
  if (matches.length === 0) {
    const channels = ["R", "G", "B"];
    for (const ch of channels) {
      try {
        const chPath = `/tmp/_fts_${id}_${ch}.png`;
        dockerExec(`convert ${ocrInput} -channel ${ch} -separate ${chPath}`, 30000, cn);
        const chOutBase = `/tmp/_fts_${id}_${ch}_out`;
        dockerExec(`tesseract ${chPath} ${chOutBase} -l ${lang} --psm 3 tsv 2>/dev/null`, 60000, cn);
        const chTsv = dockerExec(`cat ${chOutBase}.tsv`, 10000, cn).toString();
        const chWords = parseTesseractTsv(chTsv);
        matches = matchWordsToQuery(chWords, query, regionOffsetX, regionOffsetY, cn, returnAll);
        if (matches.length > 0) break; // Found on this channel, stop
      } catch (e) { /* skip failed channel */ }
    }
  }

  // Cleanup temp files
  try { dockerExec(`rm -f /tmp/_fts_${id}*`, 10000, cn); } catch (e) { /* ignore */ }

  return matches;
}

// === OCR Tools ===

server.tool(
  "computer_ocr",
  `Extract text from the screen using OCR (tesseract). Returns all recognized text.
Use region to OCR only a portion of the screen. Supports English and Chinese (simplified).`,
  {
    region: z.array(z.number()).length(4).optional().describe("[x1, y1, x2, y2] region to OCR (API coordinates). Omit for full screen."),
    language: z.string().optional().describe("Tesseract language code (default: 'eng'). Use 'eng+chi_sim' for English + Chinese."),
    container_name: z.string().optional().describe("Target container (default: primary)"),
  },
  async ({ region, language, container_name }) => {
    try {
      const cn = resolveContainer(container_name);
      const lang = language || "eng";
      const id = randomUUID().slice(0, 8);
      const pngPath = `/tmp/_ocr_${id}.png`;

      // Capture screenshot
      dockerExec(`scrot -o ${pngPath}`, 30000, cn);

      // Crop to region if specified
      let ocrInput = pngPath;
      if (region) {
        const [x1, y1, x2, y2] = region;
        // Convert API coordinates to display coordinates
        const [dx1, dy1] = apiToDisplay(x1, y1, cn);
        const [dx2, dy2] = apiToDisplay(x2, y2, cn);
        const w = dx2 - dx1;
        const h = dy2 - dy1;
        if (w <= 0 || h <= 0) {
          return { content: [{ type: "text", text: "Invalid region: width and height must be positive" }], isError: true };
        }
        const cropPath = `/tmp/_ocr_${id}_crop.png`;
        dockerExec(`convert ${pngPath} -crop ${w}x${h}+${dx1}+${dy1} +repage ${cropPath}`, 30000, cn);
        ocrInput = cropPath;
      }

      // Run tesseract OCR
      const outBase = `/tmp/_ocr_${id}_out`;
      dockerExec(`tesseract ${ocrInput} ${outBase} -l ${lang} --psm 3 2>/dev/null`, 60000, cn);
      const text = dockerExec(`cat ${outBase}.txt && rm -f /tmp/_ocr_${id}*`, 10000, cn).toString().trim();

      // Also return screenshot for context
      const ss = takeScreenshot(cn);
      return {
        content: [
          { type: "image", data: ss.data, mimeType: ss.mimeType },
          { type: "text", text: text || "(no text detected)" }
        ]
      };
    } catch (err) {
      return { content: [{ type: "text", text: `OCR error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "computer_find_text",
  `Find text on the screen and return its coordinates. Uses OCR to locate text matches.
Returns the center coordinate of each match in API space — ready for clicking.
Useful for: finding buttons, labels, links, or any visible text element.`,
  {
    query: z.string().describe("Text to search for (case-insensitive substring match)"),
    region: z.array(z.number()).length(4).optional().describe("[x1, y1, x2, y2] region to search within (API coordinates). Omit for full screen."),
    language: z.string().optional().describe("Tesseract language code (default: 'eng'). Use 'eng+chi_sim' for English + Chinese."),
    all_matches: z.boolean().optional().describe("Return all matches (default: true). Set false for first match only."),
    container_name: z.string().optional().describe("Target container (default: primary)"),
  },
  async ({ query, region, language, all_matches, container_name }) => {
    try {
      const cn = resolveContainer(container_name);
      const lang = language || "eng";
      const returnAll = all_matches !== false;

      const matches = findTextOnScreen(query, cn, lang, region || null, returnAll);

      const ss = takeScreenshot(cn);
      if (matches.length === 0) {
        return {
          content: [
            { type: "image", data: ss.data, mimeType: ss.mimeType },
            { type: "text", text: `No matches found for "${query}"` }
          ]
        };
      }

      const resultText = matches.map((m, i) =>
        `${i + 1}. "${m.text}" at [${m.coordinate}] (confidence: ${m.confidence}%)`
      ).join("\n");

      return {
        content: [
          { type: "image", data: ss.data, mimeType: ss.mimeType },
          { type: "text", text: `Found ${matches.length} match${matches.length === 1 ? "" : "es"} for "${query}":\n${resultText}\n\nUse coordinate values directly with left_click to click on a match.` }
        ]
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Find text error: ${err.message}` }], isError: true };
    }
  }
);

// === Wait-for-text Tool ===

server.tool(
  "computer_wait_for_text",
  `Wait until specific text appears on screen. Polls the display with OCR at regular intervals.
Useful for waiting for: page loads, dialogs, progress completion, buttons to appear.
Returns the coordinate of the found text (ready for clicking) and a screenshot.
Optionally auto-clicks the text when found.`,
  {
    query: z.string().describe("Text to wait for (case-insensitive substring match, supports multi-word)"),
    timeout: z.number().min(1).max(120).default(30).describe("Max seconds to wait (default: 30)"),
    interval: z.number().min(0.5).max(10).default(2).describe("Seconds between OCR checks (default: 2)"),
    click: z.boolean().default(false).describe("Auto-click the text when found (default: false)"),
    region: z.array(z.number()).length(4).optional().describe("[x1, y1, x2, y2] region to search (API coordinates). Omit for full screen."),
    language: z.string().optional().describe("Tesseract language code (default: 'eng')"),
    container_name: z.string().optional().describe("Target container (default: primary)"),
  },
  async ({ query, timeout, interval, click: autoClick, region, language, container_name }) => {
    try {
      const cn = resolveContainer(container_name);
      const lang = language || "eng";
      const timeoutMs = (timeout || 30) * 1000;
      const intervalMs = (interval || 2) * 1000;
      const startTime = Date.now();

      while (Date.now() - startTime < timeoutMs) {
        const matches = findTextOnScreen(query, cn, lang, region || null, false);
        if (matches.length > 0) {
          const m = matches[0];
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          if (autoClick) {
            const [dx, dy] = apiToDisplay(m.coordinate[0], m.coordinate[1], cn);
            xdotool(`mousemove ${dx} ${dy} click 1`, cn);
            await new Promise(r => setTimeout(r, SCREENSHOT_DELAY_MS));
          }
          const ss = takeScreenshot(cn);
          return {
            content: [
              { type: "image", data: ss.data, mimeType: ss.mimeType },
              { type: "text", text: `Found "${m.text}" at [${m.coordinate}] after ${elapsed}s${autoClick ? " — clicked" : ""}\nconfidence: ${m.confidence}%` }
            ]
          };
        }
        await new Promise(r => setTimeout(r, intervalMs));
      }

      // Timeout — text never appeared
      const ss = takeScreenshot(cn);
      return {
        content: [
          { type: "image", data: ss.data, mimeType: ss.mimeType },
          { type: "text", text: `Timeout: "${query}" not found after ${timeout}s` }
        ]
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Wait-for-text error: ${err.message}` }], isError: true };
    }
  }
);

// === Scroll-to-text Tool ===

server.tool(
  "computer_scroll_to",
  `Scroll until a text target appears on screen. Combines OCR text search with automatic scrolling.
If the text is already visible, returns immediately with its coordinates.
Otherwise scrolls in the given direction, re-checking after each scroll, until found or max attempts reached.
Detects when the page stops scrolling (hit top/bottom) and stops early.
Optionally auto-clicks the found text.`,
  {
    query: z.string().describe("Text to find (case-insensitive substring match, supports multi-word)"),
    direction: z.enum(["up", "down"]).default("down").describe("Scroll direction (default: down)"),
    scroll_amount: z.number().min(1).max(20).default(5).describe("Scroll clicks per attempt (default: 5)"),
    max_scrolls: z.number().min(1).max(50).default(20).describe("Max scroll attempts before giving up (default: 20)"),
    click: z.boolean().default(false).describe("Auto-click the first match when found (default: false)"),
    language: z.string().optional().describe("Tesseract language code (default: 'eng')"),
    container_name: z.string().optional().describe("Target container (default: primary)"),
  },
  async ({ query, direction, scroll_amount, max_scrolls, click: autoClick, language, container_name }) => {
    try {
      const cn = resolveContainer(container_name);
      const lang = language || "eng";
      const scrollDir = direction || "down";
      const amount = scroll_amount || 5;
      const maxAttempts = max_scrolls || 20;

      // Check if text is already visible
      let matches = findTextOnScreen(query, cn, lang, null, false);
      if (matches.length > 0) {
        const m = matches[0];
        if (autoClick) {
          const [dx, dy] = apiToDisplay(m.coordinate[0], m.coordinate[1], cn);
          xdotool(`mousemove ${dx} ${dy} click 1`, cn);
          await new Promise(r => setTimeout(r, SCREENSHOT_DELAY_MS));
        }
        const ss = takeScreenshot(cn);
        return {
          content: [
            { type: "image", data: ss.data, mimeType: ss.mimeType },
            { type: "text", text: `Found "${m.text}" at [${m.coordinate}] (already visible, 0 scrolls)${autoClick ? " — clicked" : ""}\nconfidence: ${m.confidence}%` }
          ]
        };
      }

      // Scroll loop
      let prevScreenHash = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // Scroll
        const buttonMap = { up: 4, down: 5 };
        const btn = buttonMap[scrollDir] || 5;
        // Move to center of screen for scrolling
        const env = environments.get(cn);
        const dw = env?.width || DISPLAY_WIDTH;
        const dh = env?.height || DISPLAY_HEIGHT;
        xdotool(`mousemove ${Math.round(dw / 2)} ${Math.round(dh / 2)}`, cn);
        xdotool(`click --repeat ${amount} --delay 50 ${btn}`, cn);
        await new Promise(r => setTimeout(r, SCREENSHOT_DELAY_MS));

        // Detect stuck (page didn't scroll — hit top/bottom)
        const id = randomUUID().slice(0, 8);
        const checkPath = `/tmp/_st_${id}.png`;
        dockerExec(`scrot -o ${checkPath}`, 30000, cn);
        const hashOut = dockerExec(`md5sum ${checkPath} && rm -f ${checkPath}`, 10000, cn).toString().trim();
        const currentHash = hashOut.split(/\s+/)[0];
        if (prevScreenHash && currentHash === prevScreenHash) {
          // Screen didn't change — hit the end
          const ss = takeScreenshot(cn);
          return {
            content: [
              { type: "image", data: ss.data, mimeType: ss.mimeType },
              { type: "text", text: `"${query}" not found — page stopped scrolling ${scrollDir} after ${attempt} scroll${attempt === 1 ? "" : "s"} (hit ${scrollDir === "down" ? "bottom" : "top"})` }
            ]
          };
        }
        prevScreenHash = currentHash;

        // Check for text
        matches = findTextOnScreen(query, cn, lang, null, false);
        if (matches.length > 0) {
          const m = matches[0];
          if (autoClick) {
            const [dx, dy] = apiToDisplay(m.coordinate[0], m.coordinate[1], cn);
            xdotool(`mousemove ${dx} ${dy} click 1`, cn);
            await new Promise(r => setTimeout(r, SCREENSHOT_DELAY_MS));
          }
          const ss = takeScreenshot(cn);
          return {
            content: [
              { type: "image", data: ss.data, mimeType: ss.mimeType },
              { type: "text", text: `Found "${m.text}" at [${m.coordinate}] after ${attempt} scroll${attempt === 1 ? "" : "s"} ${scrollDir}${autoClick ? " — clicked" : ""}\nconfidence: ${m.confidence}%` }
            ]
          };
        }
      }

      // Max scrolls reached without finding
      const ss = takeScreenshot(cn);
      return {
        content: [
          { type: "image", data: ss.data, mimeType: ss.mimeType },
          { type: "text", text: `"${query}" not found after ${maxAttempts} scrolls ${scrollDir}` }
        ]
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Scroll-to error: ${err.message}` }], isError: true };
    }
  }
);

// === computer_screenshot_diff — visual comparison with named baselines ===
server.tool(
  "computer_screenshot_diff",
  `Compare screenshots to detect visual differences. Four modes:
- "save": Save current screenshot as a named baseline for later comparison.
- "compare": Compare current screenshot to a saved baseline. Returns a visual diff image, difference percentage, and bounding box of changed region.
- "list": List all saved baselines with their dimensions and timestamps.
- "delete": Delete a saved baseline by name, or all baselines with name="all".
Baselines are stored inside the container at /workspace/.baselines/. Useful for visual regression testing, monitoring UI changes, or verifying that actions produced expected results.`,
  {
    mode: z.enum(["save", "compare", "list", "delete"]).describe("'save' = capture baseline, 'compare' = diff against baseline, 'list' = show saved baselines, 'delete' = remove baseline"),
    name: z.string().optional().describe("Baseline name (required for save/compare). Alphanumeric, dashes, underscores only."),
    region: z.array(z.number()).optional().describe("[x1, y1, x2, y2] — compare only this region (API coordinates). Omit for full screen."),
    fuzz: z.number().min(0).max(100).default(5).describe("Color difference threshold percentage (0=exact, 100=all match). Default 5 — ignores minor compression artifacts."),
    container_name: z.string().optional().describe("Target container (default: primary)"),
  },
  async ({ mode, name, region, fuzz, container_name }) => {
    try {
      const cn = resolveContainer(container_name);
      const baselineDir = "/workspace/.baselines";

      // Ensure baselines directory exists
      try { dockerExec(`mkdir -p ${baselineDir}`, 5000, cn); } catch {}

      if (mode === "list") {
        try {
          const listing = dockerExec(`ls -la ${baselineDir}/*.png 2>/dev/null || echo "(no baselines)"`, 10000, cn).toString().trim();
          if (listing === "(no baselines)") {
            return { content: [{ type: "text", text: "No baselines saved yet. Use mode='save' to create one." }] };
          }
          // Get detailed info for each baseline
          const files = dockerExec(`ls ${baselineDir}/*.png 2>/dev/null`, 5000, cn).toString().trim().split("\n").filter(Boolean);
          const details = files.map(f => {
            const fname = f.split("/").pop().replace(".png", "");
            let info = "";
            try {
              info = dockerExec(`identify -format '%wx%h %b' '${f}'`, 5000, cn).toString().trim();
            } catch { info = "unknown"; }
            let mtime = "";
            try {
              mtime = dockerExec(`stat -c '%y' '${f}' 2>/dev/null | cut -d. -f1`, 5000, cn).toString().trim();
            } catch {}
            return `  ${fname}: ${info} (${mtime})`;
          });
          return { content: [{ type: "text", text: `Saved baselines (${files.length}):\n${details.join("\n")}` }] };
        } catch (err) {
          return { content: [{ type: "text", text: `List error: ${err.message}` }], isError: true };
        }
      }

      if (mode === "delete") {
        if (!name) {
          return { content: [{ type: "text", text: "Error: 'name' is required for delete mode. Use name='all' to delete all baselines." }], isError: true };
        }
        if (name === "all") {
          try {
            const count = dockerExec(`ls ${baselineDir}/*.png 2>/dev/null | wc -l`, 5000, cn).toString().trim();
            dockerExec(`rm -f ${baselineDir}/*.png`, 10000, cn);
            return { content: [{ type: "text", text: `Deleted all baselines (${count} files)` }] };
          } catch {
            return { content: [{ type: "text", text: "No baselines to delete" }] };
          }
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
          return { content: [{ type: "text", text: "Error: name must be alphanumeric with dashes/underscores only" }], isError: true };
        }
        const delPath = `${baselineDir}/${name}.png`;
        try {
          dockerExec(`test -f '${delPath}'`, 5000, cn);
        } catch {
          return { content: [{ type: "text", text: `Baseline '${name}' not found` }], isError: true };
        }
        dockerExec(`rm -f '${delPath}'`, 5000, cn);
        return { content: [{ type: "text", text: `Baseline '${name}' deleted` }] };
      }

      // save and compare require name
      if (!name) {
        return { content: [{ type: "text", text: "Error: 'name' is required for save and compare modes" }], isError: true };
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        return { content: [{ type: "text", text: "Error: name must be alphanumeric with dashes/underscores only" }], isError: true };
      }

      const baselinePath = `${baselineDir}/${name}.png`;

      if (mode === "save") {
        // Take a raw PNG screenshot (no JPEG compression — baselines should be lossless)
        const id = randomUUID().slice(0, 8);
        const ssPath = `/tmp/_sd_${id}.png`;
        dockerExec(`scrot -o ${ssPath}`, 30000, cn);

        if (region && region.length === 4) {
          const [rx1, ry1, rx2, ry2] = region;
          const [dx1, dy1] = apiToDisplay(rx1, ry1, cn);
          const [dx2, dy2] = apiToDisplay(rx2, ry2, cn);
          const cropW = dx2 - dx1;
          const cropH = dy2 - dy1;
          if (cropW <= 0 || cropH <= 0) {
            return { content: [{ type: "text", text: "Error: region must have positive width and height" }], isError: true };
          }
          dockerExec(`convert ${ssPath} -crop ${cropW}x${cropH}+${dx1}+${dy1} +repage ${baselinePath} && rm -f ${ssPath}`, 30000, cn);
        } else {
          dockerExec(`mv ${ssPath} ${baselinePath}`, 5000, cn);
        }

        const dims = dockerExec(`identify -format '%wx%h' '${baselinePath}'`, 5000, cn).toString().trim();
        // Return a preview of the saved baseline
        const api = getApiDimensions(cn);
        const useJpeg = SCREENSHOT_FORMAT === "jpeg" || SCREENSHOT_FORMAT === "jpg";
        const previewPath = `/tmp/_sd_${id}_preview.${useJpeg ? "jpg" : "png"}`;
        const qualityFlag = useJpeg ? `-quality ${SCREENSHOT_QUALITY}` : "";
        dockerExec(`convert '${baselinePath}' -resize ${api.width}x${api.height}! ${qualityFlag} ${previewPath}`, 30000, cn);
        const previewB64 = dockerExec(`base64 ${previewPath} && rm -f ${previewPath}`, 30000, cn).toString().replace(/\s/g, "");

        return {
          content: [
            { type: "image", data: previewB64, mimeType: useJpeg ? "image/jpeg" : "image/png" },
            { type: "text", text: `Baseline '${name}' saved (${dims})${region ? ` [region ${region.join(",")}]` : ""}` }
          ]
        };
      }

      if (mode === "compare") {
        // Check baseline exists
        try {
          dockerExec(`test -f '${baselinePath}'`, 5000, cn);
        } catch {
          return { content: [{ type: "text", text: `Baseline '${name}' not found. Use mode='save' first. Available baselines: ${(() => { try { return dockerExec(`ls ${baselineDir}/*.png 2>/dev/null | xargs -I{} basename {} .png`, 5000, cn).toString().trim().split("\n").join(", ") || "none"; } catch { return "none"; } })()}` }], isError: true };
        }

        // Take current screenshot (raw PNG for accurate comparison)
        const id = randomUUID().slice(0, 8);
        const currentPath = `/tmp/_sd_${id}_current.png`;
        dockerExec(`scrot -o ${currentPath}`, 30000, cn);

        // Crop if region specified
        if (region && region.length === 4) {
          const [rx1, ry1, rx2, ry2] = region;
          const [dx1, dy1] = apiToDisplay(rx1, ry1, cn);
          const [dx2, dy2] = apiToDisplay(rx2, ry2, cn);
          const cropW = dx2 - dx1;
          const cropH = dy2 - dy1;
          if (cropW <= 0 || cropH <= 0) {
            return { content: [{ type: "text", text: "Error: region must have positive width and height" }], isError: true };
          }
          const croppedPath = `/tmp/_sd_${id}_cropped.png`;
          dockerExec(`convert ${currentPath} -crop ${cropW}x${cropH}+${dx1}+${dy1} +repage ${croppedPath} && mv ${croppedPath} ${currentPath}`, 30000, cn);
        }

        // Ensure dimensions match (resize current to match baseline if needed)
        const baselineDims = dockerExec(`identify -format '%wx%h' '${baselinePath}'`, 5000, cn).toString().trim();
        const currentDims = dockerExec(`identify -format '%wx%h' '${currentPath}'`, 5000, cn).toString().trim();
        if (baselineDims !== currentDims) {
          dockerExec(`convert '${currentPath}' -resize ${baselineDims}! '${currentPath}'`, 30000, cn);
        }

        // Run ImageMagick compare
        const diffPath = `/tmp/_sd_${id}_diff.png`;
        const metricPath = `/tmp/_sd_${id}_metric.txt`;
        const fuzzPct = fuzz || 5;

        // compare returns exit code 1 if images differ (not an error), 2 on real error
        let diffMetric = "0";
        try {
          // AE (Absolute Error) = pixel count, redirect metric to stderr
          dockerExec(`compare -metric AE -fuzz ${fuzzPct}% '${baselinePath}' '${currentPath}' '${diffPath}' 2>${metricPath}`, 60000, cn);
          diffMetric = dockerExec(`cat ${metricPath}`, 5000, cn).toString().trim();
        } catch (err) {
          // Exit code 1 = images differ (normal), stderr has the pixel count
          try {
            diffMetric = dockerExec(`cat ${metricPath}`, 5000, cn).toString().trim();
          } catch {}
        }

        // Get total pixel count for percentage
        const [bw, bh] = baselineDims.split("x").map(Number);
        const totalPixels = bw * bh;
        const diffPixels = parseInt(diffMetric) || 0;
        const diffPct = totalPixels > 0 ? ((diffPixels / totalPixels) * 100).toFixed(2) : "0.00";

        // Get bounding box of differences using compare with subimage-search or trim
        let boundingBox = "";
        try {
          // Create a binary diff mask, then get the bounding box via trim
          const maskPath = `/tmp/_sd_${id}_mask.png`;
          try {
            dockerExec(`compare -fuzz ${fuzzPct}% '${baselinePath}' '${currentPath}' -compose Src -highlight-color White -lowlight-color Black '${maskPath}' 2>/dev/null`, 30000, cn);
          } catch {} // exit code 1 is expected
          const trimInfo = dockerExec(`identify -format '%@' '${maskPath}' 2>/dev/null`, 5000, cn).toString().trim();
          if (trimInfo && trimInfo !== "0x0+0+0") {
            boundingBox = trimInfo; // format: WxH+X+Y
          }
          dockerExec(`rm -f ${maskPath}`, 5000, cn);
        } catch {}

        // Scale diff image for return
        const api = getApiDimensions(cn);
        const useJpeg = SCREENSHOT_FORMAT === "jpeg" || SCREENSHOT_FORMAT === "jpg";
        const returnPath = `/tmp/_sd_${id}_return.${useJpeg ? "jpg" : "png"}`;
        const qualityFlag = useJpeg ? `-quality ${SCREENSHOT_QUALITY}` : "";
        dockerExec(`convert '${diffPath}' -resize ${api.width}x${api.height}! ${qualityFlag} '${returnPath}'`, 30000, cn);
        const diffB64 = dockerExec(`base64 '${returnPath}' && rm -f ${currentPath} ${diffPath} ${metricPath} '${returnPath}'`, 30000, cn).toString().replace(/\s/g, "");

        const identical = diffPixels === 0;
        let summary = identical
          ? `Screenshots are identical (fuzz=${fuzzPct}%)`
          : `Differences found: ${diffPixels.toLocaleString()} pixels (${diffPct}%) differ (fuzz=${fuzzPct}%)`;
        if (boundingBox && !identical) {
          summary += `\nBounding box of changes: ${boundingBox}`;
          // Convert bounding box to API coordinates
          const bbMatch = boundingBox.match(/(\d+)x(\d+)\+(\d+)\+(\d+)/);
          if (bbMatch) {
            const [, bbW, bbH, bbX, bbY] = bbMatch.map(Number);
            const scaleFactor = api.width / bw;
            const apiX1 = Math.round(bbX * scaleFactor);
            const apiY1 = Math.round(bbY * scaleFactor);
            const apiX2 = Math.round((bbX + bbW) * scaleFactor);
            const apiY2 = Math.round((bbY + bbH) * scaleFactor);
            summary += ` → API region: [${apiX1}, ${apiY1}, ${apiX2}, ${apiY2}]`;
          }
        }
        summary += `\nBaseline: ${name} (${baselineDims}), Compared: ${currentDims}`;

        return {
          content: [
            { type: "image", data: diffB64, mimeType: useJpeg ? "image/jpeg" : "image/png" },
            { type: "text", text: summary }
          ]
        };
      }

      return { content: [{ type: "text", text: `Unknown mode: ${mode}` }], isError: true };
    } catch (err) {
      return { content: [{ type: "text", text: `Screenshot-diff error: ${err.message}` }], isError: true };
    }
  }
);

// === computer_type_file — paste file contents into active window ===
server.tool(
  "computer_type_file",
  `Type the contents of a file from the container into the active window via clipboard paste.
Faster and more reliable than character-by-character typing for large content (code, configs, text).
Reads the file, sets the clipboard, pastes with the correct shortcut (auto-detects terminal vs GUI), and restores the original clipboard.`,
  {
    path: z.string().describe("Absolute path to the file inside the container (e.g. /workspace/code.py)"),
    line_range: z.string().optional().describe("Optional line range to type, e.g. '1-50' or '10-20'. Omit to type entire file"),
    container_name: z.string().optional().describe("Target container (default: primary)"),
  },
  async ({ path: filePath, line_range, container_name }) => {
    try {
      const cn = resolveContainer(container_name);
      const safePath = filePath.replace(/'/g, "'\\''");

      // Check file exists
      try {
        dockerExec(`test -f '${safePath}'`, 5000, cn);
      } catch {
        return { content: [{ type: "text", text: `File not found: ${filePath}` }], isError: true };
      }

      // Read file content (optionally with line range)
      let catCmd = `cat '${safePath}'`;
      if (line_range) {
        const rangeMatch = line_range.match(/^(\d+)-(\d+)$/);
        if (!rangeMatch) {
          return { content: [{ type: "text", text: `Invalid line_range format: ${line_range}. Use 'start-end' (e.g. '1-50')` }], isError: true };
        }
        catCmd = `sed -n '${rangeMatch[1]},${rangeMatch[2]}p' '${safePath}'`;
      }

      const content = dockerExec(catCmd, 30000, cn).toString();
      if (content.length === 0) {
        return { content: [{ type: "text", text: `File is empty${line_range ? ` (lines ${line_range})` : ""}: ${filePath}` }] };
      }

      // Paste via clipboard helper
      clipboardPaste(content, cn);

      await new Promise(r => setTimeout(r, SCREENSHOT_DELAY_MS));
      const ss = takeScreenshot(cn);
      const lineInfo = line_range ? ` (lines ${line_range})` : "";
      const lineCount = content.split("\n").length;

      return {
        content: [
          { type: "image", data: ss.data, mimeType: ss.mimeType },
          { type: "text", text: `Typed ${content.length} chars (${lineCount} lines) from ${filePath}${lineInfo}` }
        ]
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Type-file error: ${err.message}` }], isError: true };
    }
  }
);

// === computer_macro — define and replay named action sequences ===
server.tool(
  "computer_macro",
  `Define, run, list, edit, or delete reusable named action sequences (macros).
Macros are named sequences of computer actions that can be replayed on demand — like keyboard macros but for the full desktop.
- "save": Define a macro from a JSON array of actions, or convert a session recording into a macro.
- "run": Execute a saved macro. Supports repeat count and speed multiplier.
- "edit": Replace the actions in an existing macro. Preserves name and metadata, updates actions/description/count.
- "list": Show all saved macros with action counts.
- "delete": Remove a macro by name, or all macros with name="all".
Macros are stored in /workspace/.macros/ as JSON files.
Actions format: [{"action":"key","text":"ctrl+t"},{"action":"type","text":"example.com"},{"action":"key","text":"Return"}]`,
  {
    mode: z.enum(["save", "run", "list", "edit", "delete"]).describe("Operation mode"),
    name: z.string().optional().describe("Macro name (required for save/run/delete). Alphanumeric, dashes, underscores only."),
    actions: z.string().optional().describe("JSON array of actions for 'save' mode. Each action: {action, coordinate?, text?, scroll_direction?, scroll_amount?, start_coordinate?, duration?}"),
    from_session: z.string().optional().describe("Convert a saved session into a macro (session name). Alternative to 'actions' for save mode."),
    repeat: z.number().optional().describe("Number of times to run the macro (default: 1). For 'run' mode."),
    speed: z.number().optional().describe("Playback speed multiplier (default: 1.0). For 'run' mode."),
    delay_between: z.number().optional().describe("Seconds to wait between repetitions when repeat > 1 (default: 0.5)"),
    container_name: z.string().optional().describe("Target container (default: primary)"),
  },
  async ({ mode, name, actions, from_session, repeat, speed, delay_between, container_name }) => {
    try {
      const cn = resolveContainer(container_name);
      const macroDir = "/workspace/.macros";

      // Ensure macros directory exists
      try { dockerExec(`mkdir -p ${macroDir}`, 5000, cn); } catch {}

      if (mode === "list") {
        try {
          const listing = dockerExec(`ls ${macroDir}/*.json 2>/dev/null || echo "(none)"`, 10000, cn).toString().trim();
          if (listing === "(none)") {
            return { content: [{ type: "text", text: "No macros saved yet. Use mode='save' to create one." }] };
          }
          const files = listing.split("\n").filter(Boolean);
          const details = files.map(f => {
            const fname = f.split("/").pop().replace(".json", "");
            let info = "";
            try {
              const raw = dockerExec(`cat '${f}'`, 10000, cn).toString();
              const data = JSON.parse(raw);
              const count = (data.actions || []).length;
              const desc = data.description || "";
              info = `${count} actions${desc ? ` — ${desc}` : ""}`;
            } catch { info = "error reading"; }
            return `  ${fname}: ${info}`;
          });
          return { content: [{ type: "text", text: `Saved macros (${files.length}):\n${details.join("\n")}` }] };
        } catch (err) {
          return { content: [{ type: "text", text: `List error: ${err.message}` }], isError: true };
        }
      }

      if (mode === "delete") {
        if (!name) {
          return { content: [{ type: "text", text: "Error: 'name' is required for delete mode. Use name='all' to delete all macros." }], isError: true };
        }
        if (name === "all") {
          try {
            const count = dockerExec(`ls ${macroDir}/*.json 2>/dev/null | wc -l`, 5000, cn).toString().trim();
            dockerExec(`rm -f ${macroDir}/*.json`, 10000, cn);
            return { content: [{ type: "text", text: `Deleted all macros (${count} files)` }] };
          } catch {
            return { content: [{ type: "text", text: "No macros to delete" }] };
          }
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
          return { content: [{ type: "text", text: "Error: name must be alphanumeric with dashes/underscores only" }], isError: true };
        }
        const delPath = `${macroDir}/${name}.json`;
        try {
          dockerExec(`test -f '${delPath}'`, 5000, cn);
        } catch {
          return { content: [{ type: "text", text: `Macro '${name}' not found` }], isError: true };
        }
        dockerExec(`rm -f '${delPath}'`, 5000, cn);
        return { content: [{ type: "text", text: `Macro '${name}' deleted` }] };
      }

      // save and run require name
      if (!name) {
        return { content: [{ type: "text", text: `Error: 'name' is required for ${mode} mode` }], isError: true };
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        return { content: [{ type: "text", text: "Error: name must be alphanumeric with dashes/underscores only" }], isError: true };
      }

      const macroPath = `${macroDir}/${name}.json`;

      if (mode === "save") {
        let parsedActions;

        if (from_session) {
          // Load from a saved session file
          const env = environments.get(cn);
          const workspace = env?.workspace || DEFAULT_WORKSPACE;
          const sessionPath = `${workspace}/sessions/${from_session}.json`;
          try {
            if (!existsSync(sessionPath)) {
              return { content: [{ type: "text", text: `Session '${from_session}' not found at ${sessionPath}` }], isError: true };
            }
            const sessionData = JSON.parse(readFileSync(sessionPath, "utf-8"));
            parsedActions = (sessionData.actions || []).map(a => {
              // Strip timing and screenshot data, keep just the action params
              const { action, coordinate, text, scroll_direction, scroll_amount, start_coordinate, duration, region } = a;
              const clean = { action };
              if (coordinate) clean.coordinate = coordinate;
              if (text !== undefined) clean.text = text;
              if (scroll_direction) clean.scroll_direction = scroll_direction;
              if (scroll_amount !== undefined) clean.scroll_amount = scroll_amount;
              if (start_coordinate) clean.start_coordinate = start_coordinate;
              if (duration !== undefined) clean.duration = duration;
              if (region) clean.region = region;
              return clean;
            });
          } catch (err) {
            return { content: [{ type: "text", text: `Failed to load session: ${err.message}` }], isError: true };
          }
        } else if (actions) {
          // Parse actions from JSON string
          try {
            parsedActions = JSON.parse(actions);
            if (!Array.isArray(parsedActions)) {
              return { content: [{ type: "text", text: "Error: 'actions' must be a JSON array" }], isError: true };
            }
          } catch (err) {
            return { content: [{ type: "text", text: `Error parsing actions JSON: ${err.message}` }], isError: true };
          }
        } else {
          return { content: [{ type: "text", text: "Error: provide 'actions' (JSON array) or 'from_session' (session name) for save mode" }], isError: true };
        }

        // Validate each action has a valid 'action' field
        const validActions = ["screenshot", "left_click", "right_click", "middle_click", "double_click",
          "triple_click", "left_click_drag", "type", "key", "mouse_move", "scroll",
          "left_mouse_down", "left_mouse_up", "hold_key", "wait", "zoom", "cursor_position"];
        for (let i = 0; i < parsedActions.length; i++) {
          const a = parsedActions[i];
          if (!a.action || !validActions.includes(a.action)) {
            return { content: [{ type: "text", text: `Error: action[${i}] has invalid action '${a.action}'. Valid: ${validActions.join(", ")}` }], isError: true };
          }
        }

        if (parsedActions.length === 0) {
          return { content: [{ type: "text", text: "Error: macro must have at least one action" }], isError: true };
        }

        // Build macro description from action types
        const actionCounts = {};
        for (const a of parsedActions) {
          actionCounts[a.action] = (actionCounts[a.action] || 0) + 1;
        }
        const desc = Object.entries(actionCounts).map(([k, v]) => `${v}x ${k}`).join(", ");

        const macroData = {
          name,
          description: desc,
          created: new Date().toISOString(),
          action_count: parsedActions.length,
          source: from_session ? `session:${from_session}` : "manual",
          actions: parsedActions,
        };

        // Write macro file to container
        const tmpPath = `/tmp/_macro_${randomUUID().slice(0, 8)}.json`;
        const macroJson = JSON.stringify(macroData, null, 2);
        // Write via base64 to avoid shell escaping issues
        const b64 = Buffer.from(macroJson).toString("base64");
        dockerExec(`echo '${b64}' | base64 -d > '${tmpPath}' && mv '${tmpPath}' '${macroPath}'`, 10000, cn);

        return {
          content: [{ type: "text", text: `Macro '${name}' saved (${parsedActions.length} actions: ${desc})${from_session ? ` [from session '${from_session}']` : ""}\nRun with: computer_macro(mode="run", name="${name}")` }]
        };
      }

      if (mode === "edit") {
        // Load existing macro, replace its actions
        if (!actions) {
          return { content: [{ type: "text", text: "Error: 'actions' (JSON array) is required for edit mode" }], isError: true };
        }
        let existingData;
        try {
          const raw = dockerExec(`cat '${macroPath}'`, 10000, cn).toString();
          existingData = JSON.parse(raw);
        } catch {
          return { content: [{ type: "text", text: `Macro '${name}' not found. Use mode='save' to create it first.` }], isError: true };
        }

        // Parse and validate new actions
        let parsedActions;
        try {
          parsedActions = JSON.parse(actions);
          if (!Array.isArray(parsedActions)) {
            return { content: [{ type: "text", text: "Error: 'actions' must be a JSON array" }], isError: true };
          }
        } catch (err) {
          return { content: [{ type: "text", text: `Error parsing actions JSON: ${err.message}` }], isError: true };
        }
        const validActions = ["screenshot", "left_click", "right_click", "middle_click", "double_click",
          "triple_click", "left_click_drag", "type", "key", "mouse_move", "scroll",
          "left_mouse_down", "left_mouse_up", "hold_key", "wait", "zoom", "cursor_position"];
        for (let i = 0; i < parsedActions.length; i++) {
          const a = parsedActions[i];
          if (!a.action || !validActions.includes(a.action)) {
            return { content: [{ type: "text", text: `Error: action[${i}] has invalid action '${a.action}'. Valid: ${validActions.join(", ")}` }], isError: true };
          }
        }
        if (parsedActions.length === 0) {
          return { content: [{ type: "text", text: "Error: macro must have at least one action" }], isError: true };
        }

        // Build updated description
        const actionCounts = {};
        for (const a of parsedActions) {
          actionCounts[a.action] = (actionCounts[a.action] || 0) + 1;
        }
        const desc = Object.entries(actionCounts).map(([k, v]) => `${v}x ${k}`).join(", ");

        const oldCount = (existingData.actions || []).length;
        existingData.actions = parsedActions;
        existingData.action_count = parsedActions.length;
        existingData.description = desc;
        existingData.modified = new Date().toISOString();

        // Write updated macro
        const tmpPath = `/tmp/_macro_${randomUUID().slice(0, 8)}.json`;
        const macroJson = JSON.stringify(existingData, null, 2);
        const b64 = Buffer.from(macroJson).toString("base64");
        dockerExec(`echo '${b64}' | base64 -d > '${tmpPath}' && mv '${tmpPath}' '${macroPath}'`, 10000, cn);

        return {
          content: [{ type: "text", text: `Macro '${name}' updated: ${oldCount} → ${parsedActions.length} actions (${desc})` }]
        };
      }

      if (mode === "run") {
        // Load macro
        let macroData;
        try {
          const raw = dockerExec(`cat '${macroPath}'`, 10000, cn).toString();
          macroData = JSON.parse(raw);
        } catch {
          // List available macros
          let available = "";
          try {
            available = dockerExec(`ls ${macroDir}/*.json 2>/dev/null | xargs -I{} basename {} .json`, 5000, cn).toString().trim().split("\n").filter(Boolean).join(", ");
          } catch {}
          return { content: [{ type: "text", text: `Macro '${name}' not found${available ? `. Available: ${available}` : ""}` }], isError: true };
        }

        const macroActions = macroData.actions || [];
        if (macroActions.length === 0) {
          return { content: [{ type: "text", text: `Macro '${name}' has no actions` }] };
        }

        const repeatCount = Math.max(1, Math.min(repeat || 1, 100));
        const playbackSpeed = Math.max(0.1, Math.min(speed || 1.0, 10.0));
        const delayMs = Math.max(0, (delay_between || 0.5) * 1000);
        let totalExecuted = 0;
        let errors = [];

        for (let rep = 0; rep < repeatCount; rep++) {
          for (let i = 0; i < macroActions.length; i++) {
            const a = macroActions[i];
            try {
              // Handle actions not covered by executeAction()
              if (a.action === "wait") {
                const waitMs = Math.max(0.1, Math.min(a.duration || 1, 30)) * 1000;
                await new Promise(r => setTimeout(r, waitMs));
              } else if (a.action === "screenshot" || a.action === "cursor_position") {
                // No-op in macro context (screenshots are taken at the end)
              } else if (a.action === "zoom") {
                // No-op in macro context
              } else {
                executeAction(a, cn);
              }
              totalExecuted++;

              // Wait between actions (scaled by speed)
              const actionDelay = Math.round(SCREENSHOT_DELAY_MS / playbackSpeed);
              if (i < macroActions.length - 1) {
                await new Promise(r => setTimeout(r, actionDelay));
              }
            } catch (err) {
              errors.push(`rep${rep + 1}:action${i + 1}(${a.action}): ${err.message}`);
            }
          }

          // Delay between repetitions
          if (rep < repeatCount - 1 && delayMs > 0) {
            await new Promise(r => setTimeout(r, Math.round(delayMs / playbackSpeed)));
          }
        }

        // Take final screenshot
        await new Promise(r => setTimeout(r, SCREENSHOT_DELAY_MS));
        const ss = takeScreenshot(cn);

        let summary = `Macro '${name}' completed: ${totalExecuted}/${macroActions.length * repeatCount} actions executed`;
        if (repeatCount > 1) summary += ` (${repeatCount} repetitions)`;
        if (playbackSpeed !== 1.0) summary += ` at ${playbackSpeed}x speed`;
        if (errors.length > 0) summary += `\nErrors (${errors.length}):\n  ${errors.slice(0, 10).join("\n  ")}`;

        return {
          content: [
            { type: "image", data: ss.data, mimeType: ss.mimeType },
            { type: "text", text: summary }
          ]
        };
      }

      return { content: [{ type: "text", text: `Unknown mode: ${mode}` }], isError: true };
    } catch (err) {
      return { content: [{ type: "text", text: `Macro error: ${err.message}` }], isError: true };
    }
  }
);

// === computer_annotate: draw visual annotations on screenshots ===

// Color name to RGB for semi-transparent fills
const COLOR_RGB = {
  red: "255,0,0", green: "0,128,0", blue: "0,0,255", yellow: "255,255,0",
  orange: "255,165,0", purple: "128,0,128", cyan: "0,255,255", magenta: "255,0,255",
  white: "255,255,255", black: "0,0,0", lime: "0,255,0", pink: "255,192,203"
};

function colorToRgb(c) {
  if (COLOR_RGB[c]) return COLOR_RGB[c];
  if (c && c.startsWith("#")) {
    const h = c.slice(1);
    if (h.length === 3) return `${parseInt(h[0]+h[0],16)},${parseInt(h[1]+h[1],16)},${parseInt(h[2]+h[2],16)}`;
    if (h.length >= 6) return `${parseInt(h.slice(0,2),16)},${parseInt(h.slice(2,4),16)},${parseInt(h.slice(4,6),16)}`;
  }
  return "255,0,0";
}

function apiLengthToDisplay(len, containerName = DEFAULT_CONTAINER) {
  const env = environments.get(containerName);
  const w = env?.width || DISPLAY_WIDTH;
  const h = env?.height || DISPLAY_HEIGHT;
  const s = getScaleFactor(w, h);
  return s === 1 ? len : Math.round(len / s);
}

// Sanitize text for ImageMagick -draw inside single-quoted bash strings
// Inside single quotes: everything is literal (ImageMagick sees \" as escaped quote)
// Only single quote itself cannot appear — replace with unicode right single quote
function sanitizeDrawText(text) {
  return text.slice(0, 100)
    .replace(/\\/g, "\\\\")   // escape backslash for IM
    .replace(/"/g, '\\"')      // escape double quote for IM
    .replace(/'/g, "\u2019");  // replace single quote (can't appear in bash single-quoted string)
}

server.tool(
  "computer_annotate",
  `Draw visual annotations on the current screenshot for visual communication.
Annotate elements with rectangles, arrows, circles, text labels, lines, and numbered markers.
All coordinates are in API space (same as the computer tool).
Annotations is a JSON array: [{"type":"rectangle","coordinate":[x1,y1],"end_coordinate":[x2,y2]}, ...]
Types: rectangle (coord+end_coord), arrow (coord start→end_coord tip), circle (coord center, optional radius),
text (coord+text), line (coord+end_coord), number (coord, optional number).
Optional on all: color (name or #hex, default red), thickness (1-20, default 3), fill (boolean), font_size (8-72), radius (5-500).`,
  {
    annotations: z.string().describe('JSON array of annotation objects. Example: [{"type":"rectangle","coordinate":[100,100],"end_coordinate":[300,200],"color":"red"},{"type":"text","coordinate":[100,80],"text":"Click here","color":"yellow"}]'),
    save_path: z.string().optional().describe("Save annotated image to this container path (e.g. /workspace/annotated.png)"),
    container_name: z.string().optional().describe("Target container (default: primary)"),
  },
  async ({ annotations, save_path, container_name }) => {
    try {
      const cn = resolveContainer(container_name);

      // Parse annotations
      let annots;
      try { annots = JSON.parse(annotations); } catch {
        return { content: [{ type: "text", text: "Error: annotations must be valid JSON array" }], isError: true };
      }
      if (!Array.isArray(annots) || annots.length === 0) {
        return { content: [{ type: "text", text: "Error: annotations must be a non-empty array" }], isError: true };
      }
      if (annots.length > 50) {
        return { content: [{ type: "text", text: "Error: max 50 annotations per call" }], isError: true };
      }

      const validTypes = ["rectangle", "arrow", "circle", "text", "line", "number"];
      const validColors = [...Object.keys(COLOR_RGB)];

      // Take screenshot
      const id = randomUUID().slice(0, 8);
      const ssPath = `/tmp/_ann_${id}.png`;
      dockerExec(`scrot -o ${ssPath}`, 30000, cn);

      // Build ImageMagick -draw command segments
      const drawSegments = [];

      const toDisp = (coord) => {
        if (!coord || coord.length !== 2) return null;
        const [dx, dy] = apiToDisplay(coord[0], coord[1], cn);
        return [Math.round(dx), Math.round(dy)];
      };

      const cleanup = () => { try { dockerExec(`rm -f ${ssPath}`, 5000, cn); } catch {} };
      const errReturn = (msg) => { cleanup(); return { content: [{ type: "text", text: msg }], isError: true }; };

      for (let i = 0; i < annots.length; i++) {
        const a = annots[i];
        if (!a.type || !validTypes.includes(a.type)) {
          return errReturn(`Error: annotation ${i}: type must be one of: ${validTypes.join(", ")}`);
        }

        const color = (a.color && (validColors.includes(a.color) || /^#[0-9a-fA-F]{3,8}$/.test(a.color))) ? a.color : "red";
        const sw = Math.max(1, Math.min(a.thickness || 3, 20));
        const p1 = toDisp(a.coordinate);
        const p2 = toDisp(a.end_coordinate);

        switch (a.type) {
          case "rectangle": {
            if (!p1 || !p2) return errReturn(`Error: annotation ${i}: rectangle needs coordinate and end_coordinate`);
            const fillOpt = a.fill ? `rgba(${colorToRgb(color)},0.3)` : "none";
            drawSegments.push(`-fill '${fillOpt}' -stroke '${color}' -strokewidth ${sw} -draw 'rectangle ${p1[0]},${p1[1]} ${p2[0]},${p2[1]}'`);
            break;
          }

          case "circle": {
            if (!p1) return errReturn(`Error: annotation ${i}: circle needs coordinate (center)`);
            const r = apiLengthToDisplay(Math.max(5, Math.min(a.radius || 20, 500)), cn);
            const fillOpt = a.fill ? `rgba(${colorToRgb(color)},0.3)` : "none";
            drawSegments.push(`-fill '${fillOpt}' -stroke '${color}' -strokewidth ${sw} -draw 'circle ${p1[0]},${p1[1]} ${p1[0]+r},${p1[1]}'`);
            break;
          }

          case "line": {
            if (!p1 || !p2) return errReturn(`Error: annotation ${i}: line needs coordinate and end_coordinate`);
            drawSegments.push(`-fill none -stroke '${color}' -strokewidth ${sw} -draw 'line ${p1[0]},${p1[1]} ${p2[0]},${p2[1]}'`);
            break;
          }

          case "arrow": {
            if (!p1 || !p2) return errReturn(`Error: annotation ${i}: arrow needs coordinate (start) and end_coordinate (tip)`);
            // Shaft
            drawSegments.push(`-fill none -stroke '${color}' -strokewidth ${sw} -draw 'line ${p1[0]},${p1[1]} ${p2[0]},${p2[1]}'`);
            // Arrowhead triangle
            const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
            const len = Math.sqrt(dx * dx + dy * dy);
            if (len > 0) {
              const headLen = Math.max(10, sw * 5);
              const headW = headLen * 0.6;
              const ux = dx / len, uy = dy / len;
              const px = -uy, py = ux;
              const t1x = Math.round(p2[0] - headLen * ux + headW * px);
              const t1y = Math.round(p2[1] - headLen * uy + headW * py);
              const t2x = Math.round(p2[0] - headLen * ux - headW * px);
              const t2y = Math.round(p2[1] - headLen * uy - headW * py);
              drawSegments.push(`-fill '${color}' -stroke '${color}' -strokewidth 1 -draw 'polygon ${p2[0]},${p2[1]} ${t1x},${t1y} ${t2x},${t2y}'`);
            }
            break;
          }

          case "text": {
            if (!p1) return errReturn(`Error: annotation ${i}: text needs coordinate`);
            if (!a.text) return errReturn(`Error: annotation ${i}: text needs 'text' field`);
            const fs = apiLengthToDisplay(Math.max(8, Math.min(a.font_size || 20, 72)), cn);
            const label = sanitizeDrawText(a.text);
            // Background for readability
            const textW = Math.round(label.length * fs * 0.6);
            const textH = Math.round(fs * 1.3);
            const pad = 4;
            drawSegments.push(`-fill 'rgba(0,0,0,0.7)' -stroke none -draw 'rectangle ${p1[0] - pad},${p1[1] - textH - pad} ${p1[0] + textW + pad},${p1[1] + pad}'`);
            drawSegments.push(`-fill '${color}' -stroke none -font Courier-Bold -pointsize ${fs} -draw 'text ${p1[0]},${p1[1]} "${label}"'`);
            break;
          }

          case "number": {
            if (!p1) return errReturn(`Error: annotation ${i}: number needs coordinate`);
            const num = String(a.number !== undefined ? a.number : (i + 1));
            const nr = apiLengthToDisplay(Math.max(12, Math.min(a.font_size || 16, 30)), cn);
            // Filled circle
            drawSegments.push(`-fill '${color}' -stroke white -strokewidth 2 -draw 'circle ${p1[0]},${p1[1]} ${p1[0] + nr},${p1[1]}'`);
            // Number label
            const nfs = Math.round(nr * 1.2);
            const nox = num.length > 1 ? Math.round(nfs * 0.3 * num.length) : Math.round(nfs * 0.3);
            drawSegments.push(`-fill white -stroke none -font Courier-Bold -pointsize ${nfs} -draw 'text ${p1[0] - nox},${p1[1] + Math.round(nfs * 0.35)} "${num}"'`);
            break;
          }
        }
      }

      // Build final convert command
      const api = getApiDimensions(cn);
      const env = environments.get(cn);
      const displayW = env?.width || DISPLAY_WIDTH;
      const displayH = env?.height || DISPLAY_HEIGHT;
      const needsScale = api.width !== displayW || api.height !== displayH;
      const useJpeg = SCREENSHOT_FORMAT === "jpeg" || SCREENSHOT_FORMAT === "jpg";
      const outExt = useJpeg ? "jpg" : "png";
      const outPath = `/tmp/_ann_${id}_out.${outExt}`;
      const scaleCmd = needsScale ? `-resize ${api.width}x${api.height}!` : "";
      const qualityCmd = useJpeg ? `-quality ${SCREENSHOT_QUALITY}` : "";

      const fullCmd = `convert ${ssPath} ${drawSegments.join(" ")} ${scaleCmd} ${qualityCmd} ${outPath}`;
      dockerExec(fullCmd, 30000, cn);

      // Save if requested
      if (save_path) {
        const safePath = save_path.replace(/'/g, "'\\''");
        dockerExec(`cp ${outPath} '${safePath}'`, 5000, cn);
      }

      const b64 = dockerExec(`base64 ${outPath} && rm -f ${ssPath} ${outPath}`, 30000, cn).toString().replace(/\s/g, "");
      const mime = useJpeg ? "image/jpeg" : "image/png";

      const typeCounts = {};
      annots.forEach(a => { typeCounts[a.type] = (typeCounts[a.type] || 0) + 1; });
      const typeStr = Object.entries(typeCounts).map(([t, c]) => `${c} ${t}${c > 1 ? "s" : ""}`).join(", ");
      let summary = `Annotated screenshot: ${typeStr}`;
      if (save_path) summary += ` (saved to ${save_path})`;

      return {
        content: [
          { type: "image", data: b64, mimeType: mime },
          { type: "text", text: summary }
        ]
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Annotate error: ${err.message}` }], isError: true };
    }
  }
);

// === Text Editor file history (for undo support) ===
// Map: "containerName::path" -> string[] (previous file contents)
const fileEditHistory = new Map();

function fileHistoryKey(containerName, filePath) {
  return `${containerName}::${filePath}`;
}

const TEXT_EDITOR_SNIPPET_LINES = 4;

const TRUNCATED_MESSAGE = `<response clipped><NOTE>To save on context only part of this file has been shown to you. You should retry this tool after you have searched inside the file with 'grep -n' in order to find the line numbers of what you are looking for.</NOTE>`;

function makeNumberedOutput(fileContent, fileDescriptor, initLine = 1, expandTabs = true, maxCharacters = null) {
  if (expandTabs) fileContent = fileContent.replace(/\t/g, "    ");
  // Truncate: use max_characters if provided, otherwise fall back to MAX_RESPONSE_LEN
  const truncateAfter = maxCharacters || MAX_RESPONSE_LEN;
  if (fileContent.length > truncateAfter) {
    fileContent = fileContent.slice(0, truncateAfter) + TRUNCATED_MESSAGE;
  }
  const numbered = fileContent.split("\n").map((line, i) =>
    `${String(i + initLine).padStart(6)}\t${line}`
  ).join("\n");
  return `Here's the result of running \`cat -n\` on ${fileDescriptor}:\n${numbered}\n`;
}

server.tool(
  "computer_text_editor",
  `File editor for viewing, creating, and editing files inside a computer-use container.
Implements the Anthropic text_editor (str_replace_based_edit_tool) spec.
Commands:
- view: View file contents with line numbers (or directory listing). Optional view_range=[start,end].
- create: Create a new file (fails if file exists). Requires file_text.
- str_replace: Replace exact text in a file. old_str must appear exactly once. new_str defaults to "" (deletion).
- insert: Insert text at a line number. insert_line=0 inserts at top.
- undo_edit: Revert the last edit to a file. Can be called multiple times to undo further.
Paths must be absolute (start with /).`,
  {
    command: z.enum(["view", "create", "str_replace", "insert", "undo_edit"]).describe("Editor command"),
    path: z.string().describe("Absolute path inside the container (e.g. /workspace/file.py)"),
    file_text: z.string().optional().describe("File content for 'create' command"),
    view_range: z.array(z.number()).optional().describe("[start_line, end_line] for 'view' (1-indexed, end=-1 for EOF)"),
    old_str: z.string().optional().describe("Text to find for 'str_replace' (must be unique in file)"),
    new_str: z.string().optional().describe("Replacement text for 'str_replace' (omit or '' to delete old_str). Also used as insert content for older API compat."),
    insert_line: z.number().optional().describe("Line number for 'insert' (0=before first line, N=after line N)"),
    insert_text: z.string().optional().describe("Text to insert at insert_line"),
    max_characters: z.number().optional().describe("Max characters to return for 'view' command. Content beyond this limit is truncated with a note."),
    container_name: z.string().optional().describe("Target container (default: primary)"),
  },
  async ({ command, path: filePath, file_text, view_range, old_str, new_str, insert_line, insert_text, max_characters, container_name }) => {
    try {
      const cn = resolveContainer(container_name);
      const safePath = filePath.replace(/'/g, "'\\''");

      // Validate path is absolute
      if (!filePath.startsWith("/")) {
        const suggested = "/" + filePath;
        return { content: [{ type: "text", text: `Error: path '${filePath}' is not absolute. Maybe you meant ${suggested}?` }], isError: true };
      }

      // Check if path exists and its type
      let pathExists = false;
      let isDir = false;
      try {
        const check = dockerExec(`test -e '${safePath}' && echo EXISTS || echo MISSING`, 10000, cn).toString().trim();
        pathExists = check === "EXISTS";
        if (pathExists) {
          const dirCheck = dockerExec(`test -d '${safePath}' && echo DIR || echo FILE`, 10000, cn).toString().trim();
          isDir = dirCheck === "DIR";
        }
      } catch {}

      // Path validation
      if (!pathExists && command !== "create") {
        return { content: [{ type: "text", text: `Error: path '${filePath}' does not exist. Provide a valid path.` }], isError: true };
      }
      if (pathExists && command === "create") {
        return { content: [{ type: "text", text: `Error: file already exists at ${filePath}. Cannot overwrite with 'create'. Use str_replace to edit.` }], isError: true };
      }
      if (isDir && command !== "view") {
        return { content: [{ type: "text", text: `Error: '${filePath}' is a directory. Only 'view' works on directories.` }], isError: true };
      }

      // Helper: read file from container
      const readFile = () => {
        try {
          return dockerExec(`cat '${safePath}'`, 30000, cn).toString();
        } catch (err) {
          throw new Error(`Failed to read ${filePath}: ${err.stderr?.toString() || err.message}`);
        }
      };

      // Helper: write file to container (via base64 to avoid shell escaping)
      const writeFile = (content) => {
        const dir = filePath.substring(0, filePath.lastIndexOf("/"));
        if (dir) {
          dockerExec(`mkdir -p '${dir.replace(/'/g, "'\\''")}'`, 10000, cn);
        }
        const b64 = Buffer.from(content).toString("base64");
        dockerExec(`echo '${b64}' | base64 -d > '${safePath}'`, 30000, cn);
      };

      // Helper: save to history
      const saveHistory = (content) => {
        const key = fileHistoryKey(cn, filePath);
        if (!fileEditHistory.has(key)) fileEditHistory.set(key, []);
        fileEditHistory.get(key).push(content);
      };

      // === COMMANDS ===

      if (command === "view") {
        if (isDir) {
          if (view_range) {
            return { content: [{ type: "text", text: "Error: view_range is not allowed for directories." }], isError: true };
          }
          const listing = dockerExec(`find '${safePath}' -maxdepth 2 -not -path '*/\\.*' 2>/dev/null`, 30000, cn).toString();
          return { content: [{ type: "text", text: `Files and directories up to 2 levels deep in ${filePath}, excluding hidden items:\n${listing}` }] };
        }

        let fileContent = readFile();
        let initLine = 1;

        if (view_range) {
          if (view_range.length !== 2 || !view_range.every(v => Number.isInteger(v))) {
            return { content: [{ type: "text", text: "Error: view_range must be [start_line, end_line] (two integers)." }], isError: true };
          }
          const lines = fileContent.split("\n");
          const nLines = lines.length;
          const [start, end] = view_range;
          if (start < 1 || start > nLines) {
            return { content: [{ type: "text", text: `Error: view_range start ${start} out of range [1, ${nLines}].` }], isError: true };
          }
          if (end !== -1 && end > nLines) {
            return { content: [{ type: "text", text: `Error: view_range end ${end} exceeds file length ${nLines}.` }], isError: true };
          }
          if (end !== -1 && end < start) {
            return { content: [{ type: "text", text: `Error: view_range end ${end} must be >= start ${start}.` }], isError: true };
          }
          initLine = start;
          fileContent = end === -1
            ? lines.slice(start - 1).join("\n")
            : lines.slice(start - 1, end).join("\n");
        }

        return { content: [{ type: "text", text: makeNumberedOutput(fileContent, filePath, initLine, true, max_characters) }] };
      }

      if (command === "create") {
        if (file_text === undefined || file_text === null) {
          return { content: [{ type: "text", text: "Error: file_text is required for 'create' command." }], isError: true };
        }
        writeFile(file_text);
        saveHistory(file_text);
        return { content: [{ type: "text", text: `File created successfully at: ${filePath}` }] };
      }

      if (command === "str_replace") {
        if (old_str === undefined || old_str === null) {
          return { content: [{ type: "text", text: "Error: old_str is required for 'str_replace' command." }], isError: true };
        }

        let fileContent = readFile().replace(/\t/g, "    ");
        const oldExpanded = old_str.replace(/\t/g, "    ");
        const newExpanded = (new_str || "").replace(/\t/g, "    ");

        // Check uniqueness
        const occurrences = fileContent.split(oldExpanded).length - 1;
        if (occurrences === 0) {
          return { content: [{ type: "text", text: `Error: old_str not found verbatim in ${filePath}. No replacement performed.` }], isError: true };
        }
        if (occurrences > 1) {
          const lineNums = [];
          fileContent.split("\n").forEach((line, idx) => {
            if (line.includes(oldExpanded)) lineNums.push(idx + 1);
          });
          return { content: [{ type: "text", text: `Error: old_str found ${occurrences} times (lines ${lineNums.join(", ")}). Must be unique. Add more context to disambiguate.` }], isError: true };
        }

        // Save before editing
        saveHistory(fileContent);

        // Replace
        const newFileContent = fileContent.replace(oldExpanded, newExpanded);
        writeFile(newFileContent);

        // Build snippet
        const replacementLine = fileContent.split(oldExpanded)[0].split("\n").length - 1;
        const startLine = Math.max(0, replacementLine - TEXT_EDITOR_SNIPPET_LINES);
        const endLine = replacementLine + TEXT_EDITOR_SNIPPET_LINES + newExpanded.split("\n").length - 1;
        const snippet = newFileContent.split("\n").slice(startLine, endLine + 1).join("\n");

        let msg = `The file ${filePath} has been edited. `;
        msg += makeNumberedOutput(snippet, `a snippet of ${filePath}`, startLine + 1);
        msg += "Review the changes and make sure they are as expected. Edit the file again if necessary.";
        return { content: [{ type: "text", text: msg }] };
      }

      if (command === "insert") {
        if (insert_line === undefined || insert_line === null) {
          return { content: [{ type: "text", text: "Error: insert_line is required for 'insert' command." }], isError: true };
        }
        // Accept insert_text (20250728 spec) or new_str (older compat)
        const textToInsert = insert_text !== undefined && insert_text !== null ? insert_text : new_str;
        if (textToInsert === undefined || textToInsert === null) {
          return { content: [{ type: "text", text: "Error: insert_text is required for 'insert' command." }], isError: true };
        }

        let fileContent = readFile().replace(/\t/g, "    ");
        const insertExpanded = textToInsert.replace(/\t/g, "    ");
        const lines = fileContent.split("\n");

        if (insert_line < 0 || insert_line > lines.length) {
          return { content: [{ type: "text", text: `Error: insert_line ${insert_line} out of range [0, ${lines.length}].` }], isError: true };
        }

        // Save before editing
        saveHistory(fileContent);

        const insertLines = insertExpanded.split("\n");
        const newLines = [
          ...lines.slice(0, insert_line),
          ...insertLines,
          ...lines.slice(insert_line)
        ];
        const snippetLines = [
          ...lines.slice(Math.max(0, insert_line - TEXT_EDITOR_SNIPPET_LINES), insert_line),
          ...insertLines,
          ...lines.slice(insert_line, insert_line + TEXT_EDITOR_SNIPPET_LINES)
        ];

        const newFileContent = newLines.join("\n");
        writeFile(newFileContent);

        let msg = `The file ${filePath} has been edited. `;
        msg += makeNumberedOutput(
          snippetLines.join("\n"),
          "a snippet of the edited file",
          Math.max(1, insert_line - TEXT_EDITOR_SNIPPET_LINES + 1)
        );
        msg += "Review the changes and make sure they are as expected (correct indentation, no duplicate lines, etc). Edit the file again if necessary.";
        return { content: [{ type: "text", text: msg }] };
      }

      if (command === "undo_edit") {
        const key = fileHistoryKey(cn, filePath);
        const history = fileEditHistory.get(key);
        if (!history || history.length === 0) {
          return { content: [{ type: "text", text: `Error: no edit history for ${filePath}. Nothing to undo.` }], isError: true };
        }

        const previousContent = history.pop();
        writeFile(previousContent);
        return { content: [{ type: "text", text: `Reverted ${filePath} to previous version. ${history.length} undo step(s) remaining.` }] };
      }

      return { content: [{ type: "text", text: `Error: unknown command '${command}'.` }], isError: true };

    } catch (err) {
      return { content: [{ type: "text", text: `Text editor error: ${err.message}` }], isError: true };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
