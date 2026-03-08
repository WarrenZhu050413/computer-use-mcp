#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execSync } from "child_process";

const CONTAINER = process.env.CONTAINER_NAME || "computer-use";
const DISPLAY_WIDTH = 1024;
const DISPLAY_HEIGHT = 768;

function dockerExec(cmd) {
  const escaped = cmd.replace(/"/g, '\\"');
  return execSync(
    `docker exec ${CONTAINER} bash -c "DISPLAY=:1 ${escaped}"`,
    { timeout: 15000, maxBuffer: 10 * 1024 * 1024 }
  );
}

function takeScreenshot() {
  dockerExec("import -window root /tmp/_screenshot.png");
  const b64 = dockerExec("base64 /tmp/_screenshot.png").toString().replace(/\s/g, "");
  return b64;
}

function xdotool(args) {
  dockerExec(`xdotool ${args}`);
}

function validateCoord(coord, name = "coordinate") {
  if (!coord || coord.length !== 2) throw new Error(`${name} must be [x, y]`);
  const [x, y] = coord;
  if (x < 0 || x >= DISPLAY_WIDTH || y < 0 || y >= DISPLAY_HEIGHT) {
    throw new Error(`${name} [${x},${y}] out of bounds (display is ${DISPLAY_WIDTH}x${DISPLAY_HEIGHT})`);
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

const server = new McpServer({
  name: "computer-use",
  version: "1.0.0",
});

server.tool(
  "computer",
  `Full Anthropic Computer Use tool. Interact with a virtual desktop (${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}).
Actions: screenshot, left_click, right_click, middle_click, double_click, triple_click,
left_click_drag, type, key, mouse_move, scroll, left_mouse_down, left_mouse_up, hold_key, wait, zoom.
Every action (except screenshot, wait) returns a screenshot showing the result.`,
  {
    action: z.enum([
      "screenshot", "left_click", "right_click", "middle_click",
      "double_click", "triple_click", "left_click_drag", "type",
      "key", "mouse_move", "scroll", "left_mouse_down", "left_mouse_up",
      "hold_key", "wait", "zoom"
    ]).describe("The action to perform"),
    coordinate: z.array(z.number()).optional().describe("[x, y] coordinates for click/move/scroll actions"),
    text: z.string().optional().describe("Text to type, key combo to press (e.g. 'ctrl+s'), or modifier for click"),
    scroll_direction: z.enum(["up", "down", "left", "right"]).optional().describe("Scroll direction"),
    scroll_amount: z.number().optional().describe("Number of scroll clicks (default 3)"),
    start_coordinate: z.array(z.number()).optional().describe("[x, y] start position for drag"),
    duration: z.number().optional().describe("Seconds to wait (for wait action) or hold key duration"),
    key_to_hold: z.string().optional().describe("Key to hold while performing action (for hold_key)"),
    held_action: z.object({
      action: z.string(),
      coordinate: z.array(z.number()).optional(),
      text: z.string().optional(),
    }).optional().describe("Action to perform while holding key"),
    region: z.array(z.number()).optional().describe("[x1, y1, x2, y2] region to zoom into"),
  },
  async ({ action, coordinate, text, scroll_direction, scroll_amount,
           start_coordinate, duration, key_to_hold, held_action, region }) => {
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

        case "left_click": {
          const [x, y] = validateCoord(coordinate);
          if (text) {
            const mod = mapKey(text);
            xdotool(`mousemove ${x} ${y} keydown ${mod} click 1 keyup ${mod}`);
          } else {
            xdotool(`mousemove ${x} ${y} click 1`);
          }
          break;
        }

        case "right_click": {
          const [x, y] = validateCoord(coordinate);
          xdotool(`mousemove ${x} ${y} click 3`);
          break;
        }

        case "middle_click": {
          const [x, y] = validateCoord(coordinate);
          xdotool(`mousemove ${x} ${y} click 2`);
          break;
        }

        case "double_click": {
          const [x, y] = validateCoord(coordinate);
          xdotool(`mousemove ${x} ${y} click --repeat 2 --delay 100 1`);
          break;
        }

        case "triple_click": {
          const [x, y] = validateCoord(coordinate);
          xdotool(`mousemove ${x} ${y} click --repeat 3 --delay 100 1`);
          break;
        }

        case "left_click_drag": {
          const [sx, sy] = validateCoord(start_coordinate, "start_coordinate");
          const [ex, ey] = validateCoord(coordinate, "coordinate (end)");
          xdotool(`mousemove ${sx} ${sy} mousedown 1 mousemove ${ex} ${ey} mouseup 1`);
          break;
        }

        case "type": {
          if (!text) throw new Error("text required for type action");
          const escaped = text.replace(/'/g, "'\\''");
          dockerExec(`xdotool type --clearmodifiers --delay 12 '${escaped}'`);
          break;
        }

        case "key": {
          if (!text) throw new Error("text required for key action");
          const mapped = mapKey(text);
          xdotool(`key --clearmodifiers ${mapped}`);
          break;
        }

        case "mouse_move": {
          const [x, y] = validateCoord(coordinate);
          xdotool(`mousemove ${x} ${y}`);
          break;
        }

        case "scroll": {
          const [x, y] = validateCoord(coordinate);
          const dir = scroll_direction || "down";
          const amount = scroll_amount || 3;
          xdotool(`mousemove ${x} ${y}`);
          const buttonMap = { up: 4, down: 5, left: 6, right: 7 };
          const btn = buttonMap[dir] || 5;
          for (let i = 0; i < amount; i++) {
            xdotool(`click ${btn}`);
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

        case "hold_key": {
          if (!key_to_hold) throw new Error("key_to_hold required");
          const k = mapKey(key_to_hold);
          if (held_action) {
            xdotool(`keydown ${k}`);
            if (held_action.action === "left_click" && held_action.coordinate) {
              xdotool(`mousemove ${held_action.coordinate[0]} ${held_action.coordinate[1]} click 1`);
            } else if (held_action.action === "type" && held_action.text) {
              const esc = held_action.text.replace(/'/g, "'\\''");
              dockerExec(`xdotool type --delay 12 '${esc}'`);
            } else if (held_action.action === "key" && held_action.text) {
              xdotool(`key ${mapKey(held_action.text)}`);
            }
            xdotool(`keyup ${k}`);
          } else {
            const dur = duration || 1;
            xdotool(`keydown ${k}`);
            dockerExec(`sleep ${dur}`);
            xdotool(`keyup ${k}`);
          }
          break;
        }

        case "wait": {
          const secs = duration || 1;
          await new Promise(r => setTimeout(r, secs * 1000));
          const b64 = takeScreenshot();
          return {
            content: [
              { type: "image", data: b64, mimeType: "image/png" },
              { type: "text", text: `Waited ${secs} seconds` }
            ]
          };
        }

        case "zoom": {
          if (!region) throw new Error("region [x1, y1, x2, y2] required for zoom");
          const [x1, y1, x2, y2] = region;
          const w = x2 - x1;
          const h = y2 - y1;
          dockerExec("import -window root /tmp/_screenshot.png");
          dockerExec(`convert /tmp/_screenshot.png -crop ${w}x${h}+${x1}+${y1} +repage -resize ${DISPLAY_WIDTH}x${DISPLAY_HEIGHT} /tmp/_zoom.png`);
          const b64 = dockerExec("base64 /tmp/_zoom.png").toString().replace(/\s/g, "");
          return {
            content: [
              { type: "image", data: b64, mimeType: "image/png" },
              { type: "text", text: `Zoomed into region [${x1},${y1},${x2},${y2}]` }
            ]
          };
        }

        default:
          throw new Error(`Unknown action: ${action}`);
      }

      // For all non-screenshot/wait/zoom actions, capture follow-up screenshot
      await new Promise(r => setTimeout(r, 300));
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
          ]
        };
      } catch {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  }
);

server.tool(
  "computer_bash",
  "Run a bash command inside the computer-use container. Returns stdout/stderr.",
  {
    command: z.string().describe("Bash command to execute inside the container"),
    timeout: z.number().optional().describe("Timeout in seconds (default 30)")
  },
  async ({ command, timeout }) => {
    try {
      const ms = (timeout || 30) * 1000;
      const escaped = command.replace(/"/g, '\\"');
      const result = execSync(
        `docker exec ${CONTAINER} bash -c "DISPLAY=:1 ${escaped}"`,
        { timeout: ms, maxBuffer: 5 * 1024 * 1024 }
      ).toString();
      return { content: [{ type: "text", text: result || "(no output)" }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.stderr?.toString() || err.message}` }] };
    }
  }
);

server.tool(
  "computer_status",
  "Check if the computer-use container is running and healthy.",
  {},
  async () => {
    try {
      const status = execSync(`docker inspect --format='{{.State.Status}}' ${CONTAINER}`,
        { timeout: 5000 }).toString().trim();
      const uptime = execSync(`docker inspect --format='{{.State.StartedAt}}' ${CONTAINER}`,
        { timeout: 5000 }).toString().trim();
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
      return { content: [{ type: "text", text: `Container not found or not running: ${err.message}` }] };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
