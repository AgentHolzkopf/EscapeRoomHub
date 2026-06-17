/*
  CustomLedBridge
  Runs next to CommunikationAgent.js and toggles a board LED when the Agent
  receives Custom("button pressed").

  Start:
    node CustomLedBridge.js

  Optional environment variables:
    AGENT_URL=http://127.0.0.1:5001
    CUSTOM_TRIGGER=button pressed
    POLL_MS=100
    LED_GPIO=17
    LED_ACTIVE_LOW=0

  Notes:
    - CommunikationAgent.js exposes HTTP by default, not HTTPS.
    - HTTPS URLs are supported if AGENT_URL starts with https://.
    - On systems without /sys/class/gpio, the script logs the LED state only.
*/

const fs = require("fs");
const http = require("http");
const https = require("https");

const AGENT_URL = process.env.AGENT_URL || "http://127.0.0.1:5001";
const CUSTOM_TRIGGER = process.env.CUSTOM_TRIGGER || "button pressed";
const POLL_MS = Math.max(25, parseInt(process.env.POLL_MS || "100", 10) || 100);
const LED_GPIO = process.env.LED_GPIO || "17";
const LED_ACTIVE_LOW = process.env.LED_ACTIVE_LOW === "1";

let lastCustomStamp = null;
let ledOn = false;
let gpioAvailable = false;

function gpioPath(file) {
  return `/sys/class/gpio/gpio${LED_GPIO}/${file}`;
}

function writeFileIfChanged(path, value) {
  try {
    if (fs.existsSync(path) && fs.readFileSync(path, "utf8").trim() === value) return true;
    fs.writeFileSync(path, value);
    return true;
  } catch (_) {
    return false;
  }
}

function setupGpio() {
  if (!fs.existsSync("/sys/class/gpio")) {
    console.log("[CustomLedBridge] GPIO sysfs not available; using log-only LED mode.");
    return;
  }

  if (!fs.existsSync(`/sys/class/gpio/gpio${LED_GPIO}`)) {
    try {
      fs.writeFileSync("/sys/class/gpio/export", LED_GPIO);
    } catch (_) {
      // Already exported or not permitted.
    }
  }

  if (!fs.existsSync(`/sys/class/gpio/gpio${LED_GPIO}`)) {
    console.log(`[CustomLedBridge] GPIO ${LED_GPIO} unavailable; using log-only LED mode.`);
    return;
  }

  gpioAvailable = writeFileIfChanged(gpioPath("direction"), "out");
  if (gpioAvailable) {
    console.log(`[CustomLedBridge] Using GPIO ${LED_GPIO} for LED output.`);
    writeLed(false);
  } else {
    console.log(`[CustomLedBridge] Cannot configure GPIO ${LED_GPIO}; using log-only LED mode.`);
  }
}

function writeLed(on) {
  ledOn = !!on;
  const raw = LED_ACTIVE_LOW ? (ledOn ? "0" : "1") : (ledOn ? "1" : "0");

  if (gpioAvailable) {
    try {
      fs.writeFileSync(gpioPath("value"), raw);
    } catch (err) {
      gpioAvailable = false;
      console.warn(`[CustomLedBridge] GPIO write failed; using log-only mode: ${err.message}`);
    }
  }

  console.log(`[CustomLedBridge] LED ${ledOn ? "ON" : "OFF"}`);
}

function toggleLed() {
  writeLed(!ledOn);
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;
    const req = client.get(parsed, { timeout: 2000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${body}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
  });
}

async function pollCustom() {
  try {
    const payload = await getJson(`${AGENT_URL.replace(/\/$/, "")}/getCustom`);
    const custom = payload && payload.custom ? payload.custom : {};
    const value = custom.value == null ? "" : String(custom.value);
    const updatedAt = custom.updatedAt == null ? "" : String(custom.updatedAt);
    const stamp = `${updatedAt}:${value}`;

    if (value === CUSTOM_TRIGGER && stamp !== lastCustomStamp) {
      lastCustomStamp = stamp;
      toggleLed();
    } else if (value !== CUSTOM_TRIGGER && stamp !== lastCustomStamp) {
      lastCustomStamp = stamp;
    }
  } catch (err) {
    console.warn(`[CustomLedBridge] Agent request failed: ${err.message}`);
  } finally {
    setTimeout(pollCustom, POLL_MS);
  }
}

function main() {
  console.log(`[CustomLedBridge] Agent: ${AGENT_URL}`);
  console.log(`[CustomLedBridge] Trigger: Custom("${CUSTOM_TRIGGER}")`);
  setupGpio();
  pollCustom();
}

main();
