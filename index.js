#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFileSync } from "child_process";
import { randomUUID } from "crypto";

const CONTAINER = process.env.CONTAINER_NAME || "computer-use";
const DISPLAY_WIDTH = parseInt(process.env.DISPLAY_WIDTH || "1024", 10);
const DISPLAY_HEIGHT = parseInt(process.env.DISPLAY_HEIGHT || "768", 10);
const SCREENSHOT_DELAY_MS = parseInt(process.env.SCREENSHOT_DELAY_MS || "1000", 10);
const TYPING_GROUP_SIZE = 50;
const TYPING_DELAY_MS = 12;
const MAX_RESPONSE_LEN = 16000;

function dockerExec(cmd, timeoutMs = 30000) {
  // Use execFileSync with arg array to avoid host shell interpretation.
  // The command is passed directly to bash -c inside the container,
  // so pipes, redirects, $vars etc. work inside container but aren't
  // mangled by the host shell.
  return execFileSync("docker", [
    "exec", CONTAINER, "bash", "-c", `DISPLAY=:1 ${cmd}`
  ], { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
}

function takeScreenshot() {
  const id = randomUUID().slice(0, 8);
  const path = `/tmp/_ss_${id}.png`;
  dockerExec(`scrot -o ${path}`);
  const b64 = dockerExec(`base64 ${path} && rm -f ${path}`).toString().replace(/\s/g, "");
  return b64;
}

function xdotool(args) {
  dockerExec(`xdotool ${args}`);
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

function clickWithModifier(x, y, button, modifier) {
  if (modifier) {
    const mod = mapKey(modifier);
    xdotool(`mousemove ${x} ${y} keydown ${mod} click ${button} keyup ${mod}`);
  } else {
    xdotool(`mousemove ${x} ${y} click ${button}`);
  }
}

// Core action executor — used by main handler and recursively by hold_key
function executeAction({ action, coordinate, text, scroll_direction, scroll_amount,
                         start_coordinate, duration, region }) {
  switch (action) {
    case "left_click": {
      if (coordinate) {
        const [x, y] = validateCoord(coordinate);
        clickWithModifier(x, y, 1, text);
      } else {
        if (text) {
          const mod = mapKey(text);
          xdotool(`keydown ${mod} click 1 keyup ${mod}`);
        } else {
          xdotool(`click 1`);
        }
      }
      break;
    }

    case "right_click": {
      if (coordinate) {
        const [x, y] = validateCoord(coordinate);
        clickWithModifier(x, y, 3, text);
      } else {
        xdotool(`click 3`);
      }
      break;
    }

    case "middle_click": {
      if (coordinate) {
        const [x, y] = validateCoord(coordinate);
        clickWithModifier(x, y, 2, text);
      } else {
        xdotool(`click 2`);
      }
      break;
    }

    case "double_click": {
      if (coordinate) {
        const [x, y] = validateCoord(coordinate);
        xdotool(`mousemove ${x} ${y} click --repeat 2 --delay 10 1`);
      } else {
        xdotool(`click --repeat 2 --delay 10 1`);
      }
      break;
    }

    case "triple_click": {
      if (coordinate) {
        const [x, y] = validateCoord(coordinate);
        xdotool(`mousemove ${x} ${y} click --repeat 3 --delay 10 1`);
      } else {
        xdotool(`click --repeat 3 --delay 10 1`);
      }
      break;
    }

    case "left_click_drag": {
      if (!start_coordinate) throw new Error("start_coordinate required for left_click_drag");
      if (!coordinate) throw new Error("coordinate (end position) required for left_click_drag");
      const [sx, sy] = validateCoord(start_coordinate, "start_coordinate");
      const [ex, ey] = validateCoord(coordinate, "coordinate (end)");
      xdotool(`mousemove ${sx} ${sy} mousedown 1 mousemove ${ex} ${ey} mouseup 1`);
      break;
    }

    case "type": {
      if (!text) throw new Error("text required for type action");
      // xdotool type --file silently drops newline characters.
      // Split on newlines and press Return between segments.
      // Normalize \r\n and \r to \n first.
      const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].length > 0) {
          const b64Text = Buffer.from(lines[i]).toString("base64");
          const id = randomUUID().slice(0, 8);
          const path = `/tmp/_type_${id}.txt`;
          dockerExec(`echo ${b64Text} | base64 -d > ${path}`);
          dockerExec(`xdotool type --clearmodifiers --delay ${TYPING_DELAY_MS} --file ${path} && rm -f ${path}`);
        }
        if (i < lines.length - 1) {
          xdotool("key Return");
        }
      }
      break;
    }

    case "key": {
      if (!text) throw new Error("text required for key action");
      const mapped = mapKey(text);
      xdotool(`key --clearmodifiers -- ${mapped}`);
      break;
    }

    case "mouse_move": {
      if (!coordinate) throw new Error("coordinate required for mouse_move");
      const [x, y] = validateCoord(coordinate);
      xdotool(`mousemove ${x} ${y}`);
      break;
    }

    case "scroll": {
      const dir = scroll_direction || "down";
      const amount = scroll_amount || 3;
      if (amount < 0) throw new Error("scroll_amount must be non-negative");
      if (coordinate) {
        const [x, y] = validateCoord(coordinate);
        xdotool(`mousemove ${x} ${y}`);
      }
      const buttonMap = { up: 4, down: 5, left: 6, right: 7 };
      const btn = buttonMap[dir] || 5;
      if (text) {
        const mod = mapKey(text);
        xdotool(`keydown ${mod} click --repeat ${amount} --delay 50 ${btn} keyup ${mod}`);
      } else {
        xdotool(`click --repeat ${amount} --delay 50 ${btn}`);
      }
      break;
    }

    case "left_mouse_down": {
      if (coordinate) {
        const [x, y] = validateCoord(coordinate);
        xdotool(`mousemove ${x} ${y} mousedown 1`);
      } else {
        xdotool(`mousedown 1`);
      }
      break;
    }

    case "left_mouse_up": {
      if (coordinate) {
        const [x, y] = validateCoord(coordinate);
        xdotool(`mousemove ${x} ${y} mouseup 1`);
      } else {
        xdotool(`mouseup 1`);
      }
      break;
    }

    default:
      throw new Error(`Unknown action for executeAction: ${action}`);
  }
}

const server = new McpServer({
  name: "computer-use",
  version: "1.0.0",
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
};

server.tool(
  "computer",
  `Anthropic Computer Use tool. Interact with a virtual desktop (${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}).
Actions: screenshot, left_click, right_click, middle_click, double_click, triple_click,
left_click_drag, type, key, mouse_move, scroll, left_mouse_down, left_mouse_up,
hold_key, wait, zoom, cursor_position.
Coordinates are [x, y] from top-left origin. Every action returns a follow-up screenshot.
hold_key: holds a key and executes a nested action (via hold_key_action param), or holds for duration seconds.`,
  actionSchema,
  async ({ action, coordinate, text, scroll_direction, scroll_amount,
           start_coordinate, duration, region, hold_key_action }) => {
    try {
      switch (action) {
        case "screenshot": {
          const b64 = takeScreenshot();
          return {
            content: [
              { type: "image", data: b64, mimeType: "image/png" },
              { type: "text", text: `Screenshot captured (${DISPLAY_WIDTH}x${DISPLAY_HEIGHT})` }
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
                          start_coordinate, duration, region });
          break;
        }

        case "hold_key": {
          if (!text) throw new Error("text required for hold_key (the key to hold)");
          const k = mapKey(text);
          xdotool(`keydown ${k}`);
          try {
            if (hold_key_action) {
              // Execute nested action while key is held
              executeAction(hold_key_action);
            } else {
              // Fallback: hold for duration seconds
              const dur = duration || 1;
              if (dur <= 0 || dur > 100) throw new Error("duration must be between 0 and 100 seconds");
              dockerExec(`sleep ${dur}`);
            }
          } finally {
            xdotool(`keyup ${k}`);
          }
          break;
        }

        case "wait": {
          if (!duration) throw new Error("duration required for wait action");
          if (duration <= 0 || duration > 100) throw new Error("duration must be between 0 and 100 seconds");
          await new Promise(r => setTimeout(r, duration * 1000));
          const b64 = takeScreenshot();
          return {
            content: [
              { type: "image", data: b64, mimeType: "image/png" },
              { type: "text", text: `Waited ${duration} seconds` }
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
          const zoomPath = `/tmp/_zoom_${id}.png`;
          dockerExec(`scrot -o ${ssPath}`);
          dockerExec(`convert ${ssPath} -crop ${w}x${h}+${x1}+${y1} +repage -resize ${DISPLAY_WIDTH}x${DISPLAY_HEIGHT} ${zoomPath}`);
          const b64 = dockerExec(`base64 ${zoomPath} && rm -f ${ssPath} ${zoomPath}`).toString().replace(/\s/g, "");
          return {
            content: [
              { type: "image", data: b64, mimeType: "image/png" },
              { type: "text", text: `Zoomed into region [${x1},${y1},${x2},${y2}]` }
            ]
          };
        }

        case "cursor_position": {
          const pos = dockerExec("xdotool getmouselocation --shell").toString();
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

      // For all non-screenshot/wait/zoom/cursor_position actions, capture follow-up screenshot
      await new Promise(r => setTimeout(r, SCREENSHOT_DELAY_MS));
      const b64 = takeScreenshot();
      return {
        content: [
          { type: "image", data: b64, mimeType: "image/png" },
          { type: "text", text: `Action '${action}' completed successfully` }
        ]
      };

    } catch (err) {
      try {
        const b64 = takeScreenshot();
        return {
          content: [
            { type: "image", data: b64, mimeType: "image/png" },
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
  "Run a bash command inside the computer-use container. Returns stdout/stderr.",
  {
    command: z.string().describe("Bash command to execute inside the container"),
    timeout: z.number().optional().describe("Timeout in seconds (default 120)")
  },
  async ({ command, timeout }) => {
    try {
      const ms = (timeout || 120) * 1000;
      let result = dockerExec(command, ms).toString();
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
  "Check if the computer-use container is running and healthy.",
  {},
  async () => {
    try {
      const status = execFileSync("docker", [
        "inspect", "--format={{.State.Status}}", CONTAINER
      ], { timeout: 5000 }).toString().trim();
      const uptime = execFileSync("docker", [
        "inspect", "--format={{.State.StartedAt}}", CONTAINER
      ], { timeout: 5000 }).toString().trim();
      let display = "unknown";
      try {
        dockerExec("xdotool getdisplaygeometry");
        display = "active";
      } catch { display = "inactive"; }
      return {
        content: [{ type: "text", text:
          `Container: ${status}\nStarted: ${uptime}\nDisplay: ${display}\nResolution: ${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}`
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

const transport = new StdioServerTransport();
await server.connect(transport);
