/**
 * Lightweight puzzle template in Node.js (no external deps required).
 * Optional MQTT publish for heartbeats if "mqtt" package is installed.
 *
 * Routes (HTTP mainly for testing):
 *   POST /setState        { state: "locked"|"running"|"solved" }
 *   GET  /getState        -> { state }
 *   POST /sendParam       { type: "<datatype>", data: <payload> }
 *   GET  /getParam?type=  -> { type, data }
 *   POST /sendHeartbeat   { name, state }
 *   POST /resetPuzzle     { reset: true }
 *
 * MQTT (Hub-driven):
 *   Sub: puzzle/<DEVICE_ID>/command  payload {action:"reset"|"setState"|"requestData"|"sendParam", ...}
 *   Pub: puzzle/<DEVICE_ID>/heartbeat payload {name,state,deviceId,ip}
 *   Pub: puzzle/<DEVICE_ID>/status    payload "locked|running|solved"
 *   Pub: puzzle/<DEVICE_ID>/data      payload {type,data,deviceId}
 *
 * Config:
 *   - Env vars (highest priority)
 *   - puzzle.config.json in same folder (secondary)
 *   - built-in defaults
 *
 * Usage:
 *   node WindowsPuzzleTemplate.js --port 5001
 *   (optional) edit puzzle.config.json or set env HUB_HOST / MQTT_BROKER / MQTT_PORT / DEVICE_ID / PUZZLE_NAME / DEBUG
 */


const http = require("http");
const url = require("url");
const fs = require("fs");
const path = require("path");

function loadConfigFile() {
  const cfgPath = path.join(__dirname, "puzzle.config.json");
  try {
    const raw = fs.readFileSync(cfgPath, "utf-8");
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}

const FILE_CFG = loadConfigFile();

function loadParamsFromConfig() {
  if (FILE_CFG.outputs) {
    STATE.outputs = {};
    Object.entries(FILE_CFG.outputs).forEach(([key, val]) => {
      if (val) setOutput(key, val.type || "string", val.data);
    });
  }
}


// Config (env > file > default)
const HUB_HOST = process.env.HUB_HOST || FILE_CFG.hubHost || "escapehub.local";
const MQTT_BROKER = process.env.MQTT_BROKER || FILE_CFG.mqttBroker || HUB_HOST;
const MQTT_PORT = parseInt(process.env.MQTT_PORT || FILE_CFG.mqttPort || "1883", 10);
let DEVICE_ID = process.env.DEVICE_ID || null; // will default to LOCAL_IP later
let MQTT_TOPIC_HEARTBEAT = null;
let MQTT_TOPIC_STATUS = null;
let MQTT_TOPIC_COMMAND = null;
let MQTT_TOPIC_DATA = null;
const PUZZLE_NAME = process.env.PUZZLE_NAME || FILE_CFG.puzzleName || "Puzzle";
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.HEARTBEAT_INTERVAL_MS || FILE_CFG.heartbeatIntervalMs || "2000", 10); // 2s default
const DEBUG = (process.env.DEBUG || FILE_CFG.debug) ? (process.env.DEBUG === "1" || process.env.DEBUG === "true" || FILE_CFG.debug === true) : false;
const PRINT_DATA = (process.env.PRINT_DATA || FILE_CFG.printData) ? true : false;
const LOCAL_IP_OVERRIDE = process.env.LOCAL_IP || FILE_CFG.localIp || null;


let MQTT_CLIENT = null;
let LOCAL_IP = null;
function setDeviceId(id) {
  DEVICE_ID = id;
  MQTT_TOPIC_HEARTBEAT = `puzzle/${DEVICE_ID}/heartbeat`;
  MQTT_TOPIC_STATUS = `puzzle/${DEVICE_ID}/status`;
  MQTT_TOPIC_COMMAND = `puzzle/${DEVICE_ID}/command`;
  MQTT_TOPIC_DATA = `puzzle/${DEVICE_ID}/data`;
}

function logDebug(...args) {
  if (DEBUG) console.log("[DEBUG]", ...args);
}
function initMqtt() {
  try {
    const mqtt = require("mqtt"); // optional dependency
    MQTT_CLIENT = mqtt.connect(`mqtt://${MQTT_BROKER}:${MQTT_PORT}`);
    MQTT_CLIENT.on("connect", () => {
      console.log(`MQTT connected ${MQTT_BROKER}:${MQTT_PORT}`);
      MQTT_CLIENT.subscribe(MQTT_TOPIC_COMMAND);
    });
    MQTT_CLIENT.on("error", (err) => console.warn("MQTT error:", err.message));
    MQTT_CLIENT.on("message", (topic, msg) => {
      console.log("[MQTT recv]", topic, msg.toString());
      if (topic === MQTT_TOPIC_COMMAND) {
        handleMqttCommand(msg);
      }
    });
  } catch (e) {
    console.log('MQTT disabled (install with "npm install mqtt" to enable).');
    MQTT_CLIENT = null;
  }
}
function publishMqtt(topic, payload) {
  if (!MQTT_CLIENT) return;
  try {
    console.log("[MQTT publish]", topic, JSON.stringify(payload));
    MQTT_CLIENT.publish(topic, JSON.stringify(payload));
  } catch (e) {
    console.warn("MQTT publish failed:", e.message);
  }
}

function detectLocalIp() {
  if (LOCAL_IP_OVERRIDE) return LOCAL_IP_OVERRIDE;
  try {
    const os = require("os");
    const ifaces = os.networkInterfaces();
    const candidates = [];
    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name]) {
        if (iface.family !== "IPv4" || iface.internal) continue;
        const addr = iface.address;
        // Skip link-local, loopback and common host-only ranges (e.g., VirtualBox 192.168.56.x)
        if (addr.startsWith("169.254.")) continue;
        if (addr.startsWith("127.")) continue;
        if (addr.startsWith("192.168.56.")) continue;
        candidates.push(addr);
      }
    }
    // Prefer typical private ranges
    const preferred = candidates.find((ip) => ip.startsWith("192.168.") || ip.startsWith("10.") || ip.startsWith("172."));
    if (preferred) return preferred;
    if (candidates.length) return candidates[0];
  } catch (e) {}
  return null;
}

// In-memory state
const STATE = {
  state: "locked",
  inputs: {},  // key -> {type,data}
  outputs: {}, // key -> {type,data}
  heartbeat: { name: null, state: null },
};

const ALLOWED_TYPES = ["string", "number", "boolean"];

function normalizeType(type) {
  const t = (type || "").toString().toLowerCase();
  return ALLOWED_TYPES.includes(t) ? t : "string";
}

function coerceType(type, value) {
  const t = normalizeType(type);
  if (t === "number") {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (t === "boolean") {
    if (typeof value === "boolean") return value;
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0") return false;
  }
  return value; // string or fallback
}

function resetState() {
  STATE.state = "locked";
  STATE.inputs = {};
  STATE.outputs = {};
  STATE.heartbeat = { name: null, state: null };
}

function setInput(key, type, data) {
  if (!key) return;
  const finalType = normalizeType(type);
  STATE.inputs[key] = { type: finalType, data: coerceType(finalType, data) };
}

function setOutput(key, type, data) {
  if (!key) return;
  const finalType = normalizeType(type);
  STATE.outputs[key] = { type: finalType, data: coerceType(finalType, data) };
}

function publishHeartbeat() {
  publishMqtt(MQTT_TOPIC_HEARTBEAT, { name: PUZZLE_NAME, state: STATE.state, deviceId: DEVICE_ID, ip: LOCAL_IP });
}

function publishData(type) {
  const entry = STATE.outputs[type];
  if (!entry) return;
  publishMqtt(MQTT_TOPIC_DATA, { key: type, type: entry.type, data: entry.data, deviceId: DEVICE_ID });
  if (PRINT_DATA) console.log("[DATA OUT]", type, entry.data);
}

function publishAllOutputs() {
  Object.keys(STATE.outputs || {}).forEach((key) => publishData(key));
}

function handleMqttCommand(msg) {
  let payload = {};
  try { payload = JSON.parse(msg.toString()); } catch (e) {}
  const action = payload.action;
  logDebug("MQTT command", action, payload);
  if (action === "initKeys") {
    const existingOutputs = { ...STATE.outputs };
    if (Array.isArray(payload.inputs)) {
      STATE.inputs = {};
      payload.inputs.forEach((inp) => setInput(inp.key || inp.type, inp.type, null));
    }
    if (Array.isArray(payload.outputs)) {
      STATE.outputs = {};
      payload.outputs.forEach((out) => {
        const key = out.key || out.type;
        const prev = existingOutputs[key];
        const prevData = prev && Object.prototype.hasOwnProperty.call(prev, "data") ? prev.data : null;
        setOutput(key, out.type, prevData);
      });
    }
    publishHeartbeat();
    return;
  }
  if (action === "clearData") {
    STATE.inputs = {};
    STATE.outputs = {};
    loadParamsFromConfig();
    if (PRINT_DATA) console.log("[CLEAR DATA]");
    publishHeartbeat();
    return;
  }
  if (action === "reset") {
    resetState();
    loadParamsFromConfig();
    publishHeartbeat();
    return;
  }
  if (action === "setState") {
    const newState = payload.state;
    if (["locked","running","solved","active"].includes(newState)) {
      STATE.state = newState === "active" ? "running" : newState;
      publishMqtt(MQTT_TOPIC_STATUS, STATE.state === "solved" ? "solved" : STATE.state);
      publishHeartbeat();
      if (STATE.state === "solved") {
        publishAllOutputs();
      }
    }
    return;
  }
  if (action === "requestData") {
    const key = payload.key || payload.type;
    if (key) {
      publishData(key);
    } else {
      publishAllOutputs();
    }
    publishHeartbeat();
    return;
  }
  if (action === "sendParam") {
    const key = payload.key || payload.type;
    if (key) setInput(key, payload.type, payload.data);
    publishHeartbeat();
    return;
  }
  if (action === "sendOutput") {
    const key = payload.key || payload.type;
    if (key) {
      setOutput(key, payload.type, payload.data);
      publishData(key);
    }
    publishHeartbeat();
    return;
  }
}

// Helpers
function sendJson(res, status, payload) {
  const data = Buffer.from(JSON.stringify(payload));
  logDebug("Response", status, payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": data.length,
    "Access-Control-Allow-Origin": "*",
  });
  res.end(data);
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        logDebug("Request", req.method, req.url, parsed);
        resolve(parsed);
      } catch (e) {
        resolve({});
      }
    });
  });
}

// Server
function createServer(port) {
  const server = http.createServer(async (req, res) => {
    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      return res.end();
    }

    const parsed = url.parse(req.url, true);
    const path = parsed.pathname || "/";

    if (req.method === "GET" && path === "/getState") {
      return sendJson(res, 200, { state: STATE.state });
    }

    if (req.method === "GET" && path === "/getParam") {
      const type = parsed.query.type;
      return sendJson(res, 200, { type, data: STATE.inputs[type] });
    }

    const body = await parseBody(req);

    if (req.method === "POST" && path === "/setState") {
      const newState = body.state;
      if (!["locked", "running", "solved"].includes(newState)) {
        return sendJson(res, 400, { error: "Invalid state" });
      }
      STATE.state = newState;
      if (newState === "solved") {
        publishMqtt(MQTT_TOPIC_STATUS, "solved");
        publishAllOutputs();
      } else if (newState === "running") {
        publishMqtt(MQTT_TOPIC_STATUS, "running");
      } else {
        publishMqtt(MQTT_TOPIC_STATUS, "locked");
      }
      return sendJson(res, 200, { ok: true, state: STATE.state });
    }

    if (req.method === "POST" && path === "/sendParam") {
      const { key, type, data } = body;
      const finalKey = key || type;
      if (!finalKey) return sendJson(res, 400, { error: "key or type required" });
      setInput(finalKey, type, data);
      return sendJson(res, 200, { ok: true, stored: { key: finalKey, type: type || "string", data } });
    }

    if (req.method === "POST" && path === "/getParam") {
      const { key, type } = body;
      const lookup = key || type;
      return sendJson(res, 200, { key: lookup, data: STATE.inputs[lookup] });
    }

    if (req.method === "POST" && path === "/sendHeartbeat") {
      const { name, state } = body;
      STATE.heartbeat = { name, state };
      publishMqtt(MQTT_TOPIC_HEARTBEAT, { name, state, deviceId: DEVICE_ID, ip: LOCAL_IP });
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && path === "/resetPuzzle") {
      resetState();
      loadParamsFromConfig();
      return sendJson(res, 200, { ok: true, state: STATE.state });
    }

    if (req.method === "POST" && path === "/sendOutput") {
      const { key, type, data } = body;
      const finalKey = key || type;
      if (!finalKey) return sendJson(res, 400, { error: "key or type required" });
      setOutput(finalKey, type, data);
      publishData(finalKey);
      publishHeartbeat();
      return sendJson(res, 200, { ok: true, stored: { key: finalKey, type: type || "string", data: STATE.outputs[finalKey] } });
    }

    if (req.method === "GET" && path === "/getOutput") {
      const key = parsed.query.key || parsed.query.type;
      return sendJson(res, 200, { key, data: STATE.outputs[key] });
    }

    return sendJson(res, 404, { error: "Not found" });
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`Puzzle template listening on http://0.0.0.0:${port}`);
    console.log(`Hub/MQTT host: ${HUB_HOST}  MQTT: ${MQTT_BROKER}:${MQTT_PORT}`);
  });
}

function main() {
  const args = process.argv.slice(2);
  let port = 5001;
  const portIdx = args.indexOf("--port");
  if (portIdx !== -1 && args[portIdx + 1]) {
    port = parseInt(args[portIdx + 1], 10) || 5001;
  }
  LOCAL_IP = detectLocalIp();
  // Default deviceId to local IP if not provided
  setDeviceId(DEVICE_ID || LOCAL_IP || "puzzle-1");
  console.log(`Device ID: ${DEVICE_ID}`);
  loadParamsFromConfig();
  initMqtt();
  createServer(port);

  // Auto-heartbeat (MQTT only; no HTTP call)
  if (HEARTBEAT_INTERVAL_MS > 0) {
    setInterval(() => {
      publishHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);
  }
}

if (require.main === module) {
  main();
}
