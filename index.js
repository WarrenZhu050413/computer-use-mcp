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
  const longest = Math.max(width, height);
  if (longest <= MAX_API_DIMENSION) return 1;
  return MAX_API_DIMENSION / longest;
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
      // Check if text contains non-ASCII characters (xdotool type crashes on multi-byte)
      const hasNonAscii = /[^\x00-\x7F]/.test(text);
      if (hasNonAscii) {
        // Clipboard paste fallback for unicode text:
        // 1. Save original clipboard
        // 2. Set clipboard to our text
        // 3. Detect window type (terminal vs GUI) and paste with correct shortcut
        // 4. Restore original clipboard
        let originalClipboard = "";
        try {
          originalClipboard = dockerExec(`xclip -selection clipboard -o 2>/dev/null || true`, 5000, containerName).toString();
        } catch { /* empty clipboard is fine */ }
        const b64Full = Buffer.from(text).toString("base64");
        const id = randomUUID().slice(0, 8);
        const tmpPath = `/tmp/_type_uni_${id}.txt`;
        dockerExec(`echo ${b64Full} | base64 -d > ${tmpPath}`, 30000, containerName);
        dockerExec(`cat ${tmpPath} | xclip -selection clipboard -i && rm -f ${tmpPath}`, 30000, containerName);
        // Detect if focused window is a terminal emulator (ctrl+shift+v) vs GUI app (ctrl+v)
        // Terminal emulators intercept ctrl+v as "literal next char", so they need ctrl+shift+v
        let isTerminal = false;
        try {
          const winName = dockerExec(`xdotool getactivewindow getwindowname 2>/dev/null || echo ""`, 5000, containerName).toString().trim().toLowerCase();
          isTerminal = /terminal|xterm|rxvt|konsole|alacritty|kitty|tilix|sakura|lxterminal|terminator|urxvt/.test(winName);
        } catch { /* default to GUI paste if detection fails */ }
        const pasteKey = isTerminal ? "ctrl+shift+v" : "ctrl+v";
        xdotool(`key ${pasteKey}`, containerName);
        // Restore original clipboard after a brief delay
        if (originalClipboard) {
          const b64Orig = Buffer.from(originalClipboard).toString("base64");
          const origPath = `/tmp/_type_orig_${id}.txt`;
          dockerExec(`sleep 0.2 && echo ${b64Orig} | base64 -d > ${origPath} && cat ${origPath} | xclip -selection clipboard -i && rm -f ${origPath}`, 30000, containerName);
        }
      } else {
        // ASCII text: use xdotool type (fast, reliable for ASCII)
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
  version: "1.12.0",
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
      try {
        const ss = takeScreenshot(container_name || DEFAULT_CONTAINER);
        return {
          content: [
            { type: "image", data: ss.data, mimeType: ss.mimeType },
            { type: "text", text: `Error during '${action}': ${err.message}` }
          ],
          isError: true
        };
      } catch {
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
        const winIds = dockerExec("xdotool search --onlyvisible --name ''", 10000, cn).toString().trim().split("\n").filter(Boolean);
        const lines = [];
        for (const wid of winIds.slice(0, 30)) { // Cap at 30 windows
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

// Shared text-finding logic used by computer_find_text and computer_scroll_to
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

  const outBase = `/tmp/_fts_${id}_out`;
  dockerExec(`tesseract ${ocrInput} ${outBase} -l ${lang} --psm 3 tsv 2>/dev/null`, 60000, cn);
  const tsv = dockerExec(`cat ${outBase}.tsv && rm -f /tmp/_fts_${id}*`, 10000, cn).toString();

  const lines = tsv.split("\n").slice(1);
  const queryLower = query.toLowerCase();
  const matches = [];

  const words = [];
  for (const line of lines) {
    const cols = line.split("\t");
    if (cols.length < 12) continue;
    const level = parseInt(cols[0]);
    if (level !== 5) continue;
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

  const queryWords = queryLower.split(/\s+/).filter(w => w.length > 0);

  if (queryWords.length === 1) {
    for (const w of words) {
      if (w.text.toLowerCase().includes(queryLower)) {
        const displayCenterX = w.left + regionOffsetX + Math.round(w.width / 2);
        const displayCenterY = w.top + regionOffsetY + Math.round(w.height / 2);
        const env = environments.get(cn);
        const dw = env?.width || DISPLAY_WIDTH;
        const dh = env?.height || DISPLAY_HEIGHT;
        const s = getScaleFactor(dw, dh);
        const apiX = Math.round(displayCenterX * s);
        const apiY = Math.round(displayCenterY * s);
        matches.push({
          text: w.text,
          coordinate: [apiX, apiY],
          confidence: Math.round(w.conf),
          bounds: { left: Math.round((w.left + regionOffsetX) * s), top: Math.round((w.top + regionOffsetY) * s), width: Math.round(w.width * s), height: Math.round(w.height * s) }
        });
        if (!returnAll) break;
      }
    }
  } else {
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
        const first = words[i];
        const last = words[i + queryWords.length - 1];
        const spanLeft = first.left + regionOffsetX;
        const spanTop = Math.min(first.top, last.top) + regionOffsetY;
        const spanRight = last.left + last.width + regionOffsetX;
        const spanBottom = Math.max(first.top + first.height, last.top + last.height) + regionOffsetY;
        const displayCenterX = Math.round((spanLeft + spanRight) / 2);
        const displayCenterY = Math.round((spanTop + spanBottom) / 2);
        const env = environments.get(cn);
        const dw = env?.width || DISPLAY_WIDTH;
        const dh = env?.height || DISPLAY_HEIGHT;
        const s = getScaleFactor(dw, dh);
        const apiX = Math.round(displayCenterX * s);
        const apiY = Math.round(displayCenterY * s);
        const matchedText = words.slice(i, i + queryWords.length).map(w => w.text).join(" ");
        matches.push({
          text: matchedText,
          coordinate: [apiX, apiY],
          confidence: Math.round(Math.min(...words.slice(i, i + queryWords.length).map(w => w.conf))),
          bounds: { left: Math.round(spanLeft * s), top: Math.round(spanTop * s), width: Math.round((spanRight - spanLeft) * s), height: Math.round((spanBottom - spanTop) * s) }
        });
        if (!returnAll) break;
      }
    }
  }

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

const transport = new StdioServerTransport();
await server.connect(transport);
