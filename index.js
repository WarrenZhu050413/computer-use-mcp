#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFileSync } from "child_process";
import { randomUUID } from "crypto";
import { mkdirSync } from "fs";

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
const TYPING_DELAY_MS = 12;
const MAX_RESPONSE_LEN = 16000;

// === Multi-container environment tracking ===
const environments = new Map();
let nextEnvPort = 1;

// Register the default container
environments.set(DEFAULT_CONTAINER, {
  image: DEFAULT_IMAGE,
  vncPort: DEFAULT_VNC_PORT,
  novncPort: DEFAULT_NOVNC_PORT,
  workspace: DEFAULT_WORKSPACE,
});

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
    execFileSync("docker", [
      "run", "-d", "--name", containerName,
      "-p", `${env.vncPort}:5900`,
      "-p", `${env.novncPort}:6080`,
      "-v", `${env.workspace}:/workspace`,
      env.image
    ], { timeout: 30000 });
    // Wait for display to come up
    for (let i = 0; i < 15; i++) {
      try {
        execFileSync("docker", [
          "exec", containerName, "bash", "-c", "DISPLAY=:1 xdotool getdisplaygeometry"
        ], { timeout: 5000 });
        return true;
      } catch { /* display not ready yet */ }
      execFileSync("sleep", ["1"]);
    }
  } catch { /* restart failed */ }
  return false;
}

function dockerExec(cmd, timeoutMs = 30000, containerName = DEFAULT_CONTAINER) {
  try {
    return execFileSync("docker", [
      "exec", containerName, "bash", "-c", `DISPLAY=:1 ${cmd}`
    ], { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
  } catch (err) {
    // If container is down, attempt auto-recovery (single retry)
    if (!isContainerRunning(containerName)) {
      if (restartContainer(containerName)) {
        return execFileSync("docker", [
          "exec", containerName, "bash", "-c", `DISPLAY=:1 ${cmd}`
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

  if (SCREENSHOT_FORMAT === "jpeg" || SCREENSHOT_FORMAT === "jpg") {
    const jpgPath = `/tmp/_ss_${id}.jpg`;
    dockerExec(`convert ${pngPath} -quality ${SCREENSHOT_QUALITY} ${jpgPath}`, 30000, containerName);
    const b64 = dockerExec(`base64 ${jpgPath} && rm -f ${pngPath} ${jpgPath}`, 30000, containerName).toString().replace(/\s/g, "");
    return { data: b64, mimeType: "image/jpeg" };
  }

  const b64 = dockerExec(`base64 ${pngPath} && rm -f ${pngPath}`, 30000, containerName).toString().replace(/\s/g, "");
  return { data: b64, mimeType: "image/png" };
}

function xdotool(args, containerName = DEFAULT_CONTAINER) {
  dockerExec(`xdotool ${args}`, 30000, containerName);
}

function validateCoord(coord, name = "coordinate") {
  if (!coord || coord.length !== 2) throw new Error(`${name} must be [x, y]`);
  const [x, y] = coord;
  if (typeof x !== "number" || typeof y !== "number" || x < 0 || y < 0) {
    throw new Error(`${name} values must be non-negative numbers`);
  }
  if (x >= DISPLAY_WIDTH || y >= DISPLAY_HEIGHT) {
    throw new Error(`${name} [${x},${y}] out of bounds (display is ${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}, max [${DISPLAY_WIDTH-1},${DISPLAY_HEIGHT-1}])`);
  }
  return [Math.round(x), Math.round(y)];
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
        const [x, y] = validateCoord(coordinate);
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
        const [x, y] = validateCoord(coordinate);
        clickWithModifier(x, y, 3, text, containerName);
      } else {
        xdotool(`click 3`, containerName);
      }
      break;
    }

    case "middle_click": {
      if (coordinate) {
        const [x, y] = validateCoord(coordinate);
        clickWithModifier(x, y, 2, text, containerName);
      } else {
        xdotool(`click 2`, containerName);
      }
      break;
    }

    case "double_click": {
      if (coordinate) {
        const [x, y] = validateCoord(coordinate);
        xdotool(`mousemove ${x} ${y} click --repeat 2 --delay 10 1`, containerName);
      } else {
        xdotool(`click --repeat 2 --delay 10 1`, containerName);
      }
      break;
    }

    case "triple_click": {
      if (coordinate) {
        const [x, y] = validateCoord(coordinate);
        xdotool(`mousemove ${x} ${y} click --repeat 3 --delay 10 1`, containerName);
      } else {
        xdotool(`click --repeat 3 --delay 10 1`, containerName);
      }
      break;
    }

    case "left_click_drag": {
      if (!start_coordinate) throw new Error("start_coordinate required for left_click_drag");
      if (!coordinate) throw new Error("coordinate (end position) required for left_click_drag");
      const [sx, sy] = validateCoord(start_coordinate, "start_coordinate");
      const [ex, ey] = validateCoord(coordinate, "coordinate (end)");
      xdotool(`mousemove ${sx} ${sy} mousedown 1 mousemove ${ex} ${ey} mouseup 1`, containerName);
      break;
    }

    case "type": {
      if (!text) throw new Error("text required for type action");
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
      break;
    }

    case "key": {
      if (!text) throw new Error("text required for key action");
      const mapped = mapKey(text);
      xdotool(`key --clearmodifiers -- ${mapped}`, containerName);
      break;
    }

    case "mouse_move": {
      if (!coordinate) throw new Error("coordinate required for mouse_move");
      const [x, y] = validateCoord(coordinate);
      xdotool(`mousemove ${x} ${y}`, containerName);
      break;
    }

    case "scroll": {
      const dir = scroll_direction || "down";
      const amount = scroll_amount || 3;
      if (amount < 0) throw new Error("scroll_amount must be non-negative");
      if (coordinate) {
        const [x, y] = validateCoord(coordinate);
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
        const [x, y] = validateCoord(coordinate);
        xdotool(`mousemove ${x} ${y} mousedown 1`, containerName);
      } else {
        xdotool(`mousedown 1`, containerName);
      }
      break;
    }

    case "left_mouse_up": {
      if (coordinate) {
        const [x, y] = validateCoord(coordinate);
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
  version: "1.1.0",
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
  `Anthropic Computer Use tool. Interact with a virtual desktop (${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}).
Actions: screenshot, left_click, right_click, middle_click, double_click, triple_click,
left_click_drag, type, key, mouse_move, scroll, left_mouse_down, left_mouse_up,
hold_key, wait, zoom, cursor_position.
Coordinates are [x, y] from top-left origin. Every action returns a follow-up screenshot.
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
          const ss = takeScreenshot(cn);
          return {
            content: [
              { type: "image", data: ss.data, mimeType: ss.mimeType },
              { type: "text", text: `Screenshot captured (${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}, ${ss.mimeType})${label}` }
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
          const [x1, y1, x2, y2] = region;
          const w = x2 - x1;
          const h = y2 - y1;
          if (w <= 0 || h <= 0) throw new Error("zoom region must have positive width and height");
          const id = randomUUID().slice(0, 8);
          const ssPath = `/tmp/_ss_${id}.png`;
          const useJpeg = SCREENSHOT_FORMAT === "jpeg" || SCREENSHOT_FORMAT === "jpg";
          const outExt = useJpeg ? "jpg" : "png";
          const zoomPath = `/tmp/_zoom_${id}.${outExt}`;
          dockerExec(`scrot -o ${ssPath}`, 30000, cn);
          const qualityFlag = useJpeg ? `-quality ${SCREENSHOT_QUALITY}` : "";
          dockerExec(`convert ${ssPath} -crop ${w}x${h}+${x1}+${y1} +repage -resize ${DISPLAY_WIDTH}x${DISPLAY_HEIGHT} ${qualityFlag} ${zoomPath}`, 30000, cn);
          const b64 = dockerExec(`base64 ${zoomPath} && rm -f ${ssPath} ${zoomPath}`, 30000, cn).toString().replace(/\s/g, "");
          const zoomMime = useJpeg ? "image/jpeg" : "image/png";
          return {
            content: [
              { type: "image", data: b64, mimeType: zoomMime },
              { type: "text", text: `Zoomed into region [${x1},${y1},${x2},${y2}]${label}` }
            ]
          };
        }

        case "cursor_position": {
          const pos = dockerExec("xdotool getmouselocation --shell", 30000, cn).toString();
          const xMatch = pos.match(/X=(\d+)/);
          const yMatch = pos.match(/Y=(\d+)/);
          const x = xMatch ? parseInt(xMatch[1]) : 0;
          const y = yMatch ? parseInt(yMatch[1]) : 0;
          return {
            content: [{ type: "text", text: `X=${x},Y=${y}` }]
          };
        }

        default:
          throw new Error(`Unknown action: ${action}`);
      }

      // For non-screenshot/wait/zoom/cursor_position actions, capture follow-up screenshot
      await new Promise(r => setTimeout(r, SCREENSHOT_DELAY_MS));
      const ss = takeScreenshot(cn);
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
      return {
        content: [{ type: "text", text:
          `Container: ${status}\nName: ${cn}\nStarted: ${uptime}\nDisplay: ${display}\nResolution: ${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}` +
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
  },
  async ({ name, image }) => {
    const envName = name || `env-${randomUUID().slice(0, 6)}`;
    if (environments.has(envName)) {
      return {
        content: [{ type: "text", text: `Environment '${envName}' already exists` }],
        isError: true
      };
    }

    const envImage = image || DEFAULT_IMAGE;
    const vncPort = DEFAULT_VNC_PORT + nextEnvPort;
    const novncPort = DEFAULT_NOVNC_PORT + nextEnvPort;
    const workspace = `${DEFAULT_WORKSPACE}-${envName}`;
    nextEnvPort++;

    // Create workspace directory on host
    try { mkdirSync(workspace, { recursive: true }); } catch {}

    // Register before starting so restartContainer can find the config
    environments.set(envName, { image: envImage, vncPort, novncPort, workspace });

    try {
      execFileSync("docker", [
        "run", "-d", "--name", envName,
        "-p", `${vncPort}:5900`,
        "-p", `${novncPort}:6080`,
        "-v", `${workspace}:/workspace`,
        envImage
      ], { timeout: 30000 });

      // Wait for display readiness
      let ready = false;
      for (let i = 0; i < 15; i++) {
        try {
          execFileSync("docker", [
            "exec", envName, "bash", "-c", "DISPLAY=:1 xdotool getdisplaygeometry"
          ], { timeout: 5000 });
          ready = true;
          break;
        } catch {}
        execFileSync("sleep", ["1"]);
      }

      return {
        content: [{ type: "text", text:
          `Environment created: ${envName}\n` +
          `Image: ${envImage}\n` +
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

      results.push(
        `${name}${name === DEFAULT_CONTAINER ? " (default)" : ""}: ${status}` +
        `  VNC:${env.vncPort}  noVNC:${env.novncPort}  workspace:${env.workspace}`
      );
    }
    return {
      content: [{ type: "text", text: results.length > 0 ? results.join("\n") : "No environments registered" }]
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
