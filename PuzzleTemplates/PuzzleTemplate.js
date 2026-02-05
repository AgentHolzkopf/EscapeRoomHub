/**
 * Lightweight puzzle template in Node.js (no external deps required).
 * Optional MQTT publish for heartbeats if "mqtt" package is installed.
 *
 * Routes (HTTP mainly for testing):
 *   POST /setState        { state: "locked"|"starting"|"running"|"solved" }
 *   GET  /getState        -> { state }
 *   POST /sendParam       { type: "<datatype>", data: <payload> }
 *   GET  /getParam?type=  -> { type, data }
 *   POST /setOutput       { key, type, data }
 *   POST /setExternalCheck { value, active }
 *   GET  /getExternalCheck -> { externalCheck }
 *   POST /triggerExternalCheck { value, active }
 *   POST /sendHeartbeat   { name, state }
 *   POST /restartComplete -> { ok: true }
 *   POST /restartConfig   { needRestart: true }
 *   POST /media/upload    { localPath, remoteName? }
 *   POST /media/download  { remoteName, localPath? }
 *
 * MQTT (Hub-driven):
 *   Sub: puzzle/<DEVICE_ID>/command  payload {action:"restart"|"setState"|"requestData"|"sendParam", ...}
 *   Pub: puzzle/<DEVICE_ID>/heartbeat payload {name,state,deviceId,ip}
 *   Pub: puzzle/<DEVICE_ID>/data      payload {type,data,deviceId}
 *   Pub: puzzle/<DEVICE_ID>/external-check payload {active,variable,deviceId}
 *
 * Config:
 *   - Env vars (highest priority)
 *   - puzzle.config.json in same folder (secondary)
 *   - built-in defaults
 *
 * Usage:
 *   node WindowsPuzzleTemplate.js --port 5001
 *   (optional) edit puzzle.config.json or set env HUB_HOST / MQTT_BROKER / MQTT_PORT / DEVICE_ID / PUZZLE_NAME / DEBUG / MEDIA_SERVER / MEDIA_LOCAL_DIR / NEED_RESTART
 */

/**
 * Quickstart (for puzzle creators):
 *   // 1) set state
 *   setState("running");
 *   // 2) send output
 *   setOutput("Result", "string", "ok");
 *   // 3) send input param (from hub to puzzle logic)
 *   sendParam("Target", "number", 3);
 *   // 4) external check
 *   triggerExternalCheck("1234", { active: true });
 *   // 5) media upload
 *   uploadMediaFile("./MediaStorage/video.mp4", "video.mp4");
 */


const http = require("http");
const https = require("https");
const url = require("url");
const fs = require("fs");
const path = require("path");

// Public API (for puzzle creators)
// setState(state): change puzzle state (locked/starting/running/solved)
function setState(state) { return transitionState(state); }
// setOutput(key, type, data): publish output to Hub
// sendParam(key, type, data): store input param (local)
function sendParam(key, type, data) { return setInput(key, type, data); }
// triggerExternalCheck(value, {active}): push external check payload
// uploadMediaFile(localPath, remoteName): upload file to media server
// downloadMediaFile(remoteName, localPath): download file from media server
const PuzzleAPI = {
  setState,
  setOutput,
  sendParam,
  triggerExternalCheck,
  uploadMediaFile,
  downloadMediaFile,
  setExternalCheckValue
};

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
  if (FILE_CFG.externalCheck) {
    const value = FILE_CFG.externalCheck.value ?? null;
    const active = FILE_CFG.externalCheck.active === true;
    setExternalCheckValue(value, { active });
  }
}


// Config (env > file > default)
const HUB_HOST = process.env.HUB_HOST || FILE_CFG.hubHost || "escapehub.local";
const MQTT_BROKER = process.env.MQTT_BROKER || FILE_CFG.mqttBroker || HUB_HOST;
const MQTT_PORT = parseInt(process.env.MQTT_PORT || FILE_CFG.mqttPort || "1883", 10);
let DEVICE_ID = process.env.DEVICE_ID || FILE_CFG.deviceId || null; // will default to LOCAL_IP later
let MQTT_TOPIC_HEARTBEAT = null;
let MQTT_TOPIC_COMMAND = null;
let MQTT_TOPIC_DATA = null;
let MQTT_TOPIC_EXTERNAL_CHECK = null;
const PUZZLE_NAME = process.env.PUZZLE_NAME || FILE_CFG.puzzleName || "Puzzle";
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.HEARTBEAT_INTERVAL_MS || FILE_CFG.heartbeatIntervalMs || "2000", 10); // 2s default
const DEBUG = (process.env.DEBUG || FILE_CFG.debug) ? (process.env.DEBUG === "1" || process.env.DEBUG === "true" || FILE_CFG.debug === true) : false;
const PRINT_DATA = (process.env.PRINT_DATA || FILE_CFG.printData) ? true : false;
const LOCAL_IP_OVERRIDE = process.env.LOCAL_IP || FILE_CFG.localIp || null;
const MEDIA_SERVER = process.env.MEDIA_SERVER || FILE_CFG.mediaServer || `http://${HUB_HOST}`;
const MEDIA_LOCAL_DIR = process.env.MEDIA_LOCAL_DIR || FILE_CFG.mediaLocalDir || "MediaStorage";
let NEED_RESTART = (process.env.NEED_RESTART || FILE_CFG.needRestart) ? (process.env.NEED_RESTART === "1" || process.env.NEED_RESTART === "true" || FILE_CFG.needRestart === true) : false;
const RESTART_COMMAND_KEY = process.env.RESTART_COMMAND_KEY || FILE_CFG.restartCommandKey || "SystemCommand";
const RESTART_COMMAND_VALUE = process.env.RESTART_COMMAND_VALUE || FILE_CFG.restartCommandValue || "restart";


let MQTT_CLIENT = null;
let LOCAL_IP = null;
function setDeviceId(id) {
  DEVICE_ID = id;
  MQTT_TOPIC_HEARTBEAT = `puzzle/${DEVICE_ID}/heartbeat`;
  MQTT_TOPIC_COMMAND = `puzzle/${DEVICE_ID}/command`;
  MQTT_TOPIC_DATA = `puzzle/${DEVICE_ID}/data`;
  MQTT_TOPIC_EXTERNAL_CHECK = `puzzle/${DEVICE_ID}/external-check`;
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
      const raw = msg.toString();
      console.log("[MQTT recv]", topic, raw);
      try {
        const parsed = JSON.parse(raw);
        console.log("[MQTT recv payload]", topic, parsed);
      } catch (e) {}
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

function resolveMediaServerUrl() {
  try {
    return new URL(MEDIA_SERVER);
  } catch (e) {
    return new URL(`http://${HUB_HOST}`);
  }
}

function resolveLocalPath(inputPath) {
  if (!inputPath) return null;
  return path.isAbsolute(inputPath) ? inputPath : path.join(__dirname, inputPath);
}

function ensureMediaLocalDir() {
  const dir = resolveLocalPath(MEDIA_LOCAL_DIR);
  if (!dir) return null;
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function findLocalMediaByKey(baseName) {
  const safeBase = (baseName || "").toString().trim();
  if (!safeBase) return null;
  const dir = ensureMediaLocalDir();
  if (!dir) return null;
  try {
    const files = fs.readdirSync(dir);
    const match = files.find(name => path.parse(name).name === safeBase);
    return match ? path.join(dir, match) : null;
  } catch (e) {
    return null;
  }
}

function resolveRemoteMediaName(baseName) {
  return new Promise((resolve, reject) => {
    const key = (baseName || "").toString().trim();
    if (!key) return reject(new Error("remoteName required"));
    const baseUrl = resolveMediaServerUrl();
    const resolveUrl = new URL("/api/media/resolve", baseUrl);
    resolveUrl.searchParams.set("name", key);
    const client = resolveUrl.protocol === "https:" ? https : http;
    const req = client.request(resolveUrl, { method: "GET" }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        let payload = null;
        try { payload = JSON.parse(text); } catch (e) {}
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          return resolve(payload?.name || key);
        }
        const msg = payload?.error || text || `Resolve failed (${res.statusCode})`;
        return reject(new Error(msg));
      });
    });
    req.on("error", (e) => reject(e));
    req.end();
  });
}

function uploadMediaFile(localPath, remoteName) {
  return new Promise((resolve, reject) => {
    const resolvedPath = resolveLocalPath(localPath);
    if (!resolvedPath) {
      return reject(new Error("localPath required"));
    }
    fs.stat(resolvedPath, (err, stat) => {
      if (err || !stat.isFile()) {
        return reject(new Error("Local file not found"));
      }
      const name = (remoteName || path.basename(resolvedPath)).toString();
      const baseUrl = resolveMediaServerUrl();
      const uploadUrl = new URL("/api/media/upload", baseUrl);
      uploadUrl.searchParams.set("name", name);
      const client = uploadUrl.protocol === "https:" ? https : http;

      const req = client.request(uploadUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": stat.size
        }
      }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          let payload = null;
          try { payload = JSON.parse(text); } catch (e) {}
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            return resolve(payload || { success: true, name });
          }
          const msg = payload?.error || text || `Upload failed (${res.statusCode})`;
          return reject(new Error(msg));
        });
      });
      req.on("error", (e) => reject(e));
      fs.createReadStream(resolvedPath).pipe(req);
    });
  });
}

function downloadMediaFile(remoteName, localPath) {
  return new Promise((resolve, reject) => {
    const name = (remoteName || "").toString().trim();
    if (!name) return reject(new Error("remoteName required"));
    const baseUrl = resolveMediaServerUrl();
    const downloadUrl = new URL(`/media/${encodeURIComponent(name)}`, baseUrl);
    const client = downloadUrl.protocol === "https:" ? https : http;

    const resolvedLocal = localPath
      ? resolveLocalPath(localPath)
      : path.join(ensureMediaLocalDir() || __dirname, name);
    const tempPath = `${resolvedLocal}.download`;
    const targetDir = path.dirname(resolvedLocal);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const req = client.request(downloadUrl, { method: "GET" }, (res) => {
      if (res.statusCode !== 200) {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          return reject(new Error(text || `Download failed (${res.statusCode})`));
        });
        return;
      }
      const file = fs.createWriteStream(tempPath);
      res.pipe(file);
      file.on("finish", () => {
        file.close(() => {
          fs.rename(tempPath, resolvedLocal, (err) => {
            if (err) return reject(err);
            resolve({ success: true, path: resolvedLocal, name });
          });
        });
      });
      file.on("error", (err) => {
        try { fs.unlinkSync(tempPath); } catch (e) {}
        reject(err);
      });
    });
    req.on("error", (err) => {
      try { fs.unlinkSync(tempPath); } catch (e) {}
      reject(err);
    });
    req.end();
  });
}

// In-memory state
const STATE = {
  state: "locked",
  inputs: {},  // key -> {type,data}
  outputs: {}, // key -> {type,data}
  heartbeat: { name: null, state: null },
  externalCheck: { active: false, value: null },
};

const ALLOWED_TYPES = ["string", "number", "boolean", "media"];

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

function applyInitKeys(payload) {
  if (!payload) return;
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
}

function hasInitKeys(payload) {
  return Array.isArray(payload?.inputs) || Array.isArray(payload?.outputs);
}

function setInput(key, type, data) {
  if (!key) return;
  const finalType = normalizeType(type);
  STATE.inputs[key] = { type: finalType, data: coerceType(finalType, data) };
}

function setOutput(key, type, data) {
  if (!key) return;
  const finalType = normalizeType(type);
  if (finalType === "media") {
    STATE.outputs[key] = { type: finalType, data: key };
    return;
  }
  STATE.outputs[key] = { type: finalType, data: coerceType(finalType, data) };
}

function setExternalCheckValue(value, { active } = {}) {
  const next = value === undefined ? null : value;
  STATE.externalCheck.value = next;
  if (active !== undefined) {
    STATE.externalCheck.active = !!active;
  }
}

function setRestartRequired(value) {
  NEED_RESTART = !!value;
}

function triggerRestartCommand() {
  if (!RESTART_COMMAND_KEY) return;
  setInput(RESTART_COMMAND_KEY, "string", RESTART_COMMAND_VALUE);
}

function getExternalCheckValue() {
  return { ...STATE.externalCheck };
}

function triggerExternalCheck(value, { active = true } = {}) {
  setExternalCheckValue(value, { active });
  publishMqtt(MQTT_TOPIC_EXTERNAL_CHECK, {
    active: !!STATE.externalCheck.active,
    variable: STATE.externalCheck.value,
    deviceId: DEVICE_ID
  });
}

function publishHeartbeat() {
  const payload = { name: PUZZLE_NAME, state: STATE.state, deviceId: DEVICE_ID, ip: LOCAL_IP };
  console.log("[HEARTBEAT]", payload);
  publishMqtt(MQTT_TOPIC_HEARTBEAT, payload);
}

function publishData(type) {
  const entry = STATE.outputs[type];
  if (!entry) return;
  const payloadData = entry.type === "media" ? type : entry.data;
  publishMqtt(MQTT_TOPIC_DATA, { key: type, type: entry.type, data: payloadData, deviceId: DEVICE_ID });
  if (PRINT_DATA) console.log("[DATA OUT]", type, payloadData);
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
    applyInitKeys(payload);
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
  if (action === "restart") {
    handleRestartCommand().catch((err) => {
      console.warn("Restart failed:", err?.message || err);
    });
    return;
  }
  if (action === "setState") {
    const newState = payload.state;
    if (["locked","starting","running","solved","active","uploading","downloading"].includes(newState)) {
      transitionState(newState).catch((err) => {
        console.warn("State transition failed:", err.message || err);
      });
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

function getMediaInputEntries() {
  return Object.entries(STATE.inputs || {})
    .filter(([, val]) => val && val.type === "media")
    .map(([key, val]) => ({ key, ref: val?.data ?? null }));
}

function getMediaOutputKeys() {
  return Object.entries(STATE.outputs || {})
    .filter(([, val]) => val && val.type === "media")
    .map(([key]) => key);
}

async function setLocalState(nextState, { publishOutputs = false } = {}) {
  STATE.state = nextState;
  publishHeartbeat();
  if (publishOutputs) {
    publishAllOutputs();
  }
}

async function downloadMediaInputs(entries) {
  if (!entries.length) return;
  ensureMediaLocalDir();
  const errors = [];
  for (const entry of entries) {
    const ref = entry.ref || "";
    if (!ref) {
      errors.push(`Media reference missing: ${entry.key}`);
      continue;
    }
    try {
      const resolvedName = await resolveRemoteMediaName(ref);
      const targetPath = path.join(resolveLocalPath(MEDIA_LOCAL_DIR), resolvedName);
      await downloadMediaFile(resolvedName, targetPath);
    } catch (err) {
      errors.push(`Media download failed for ${entry.key}: ${err.message || err}`);
    }
  }
  return errors;
}

async function uploadMediaOutputs(keys) {
  if (!keys.length) return [];
  ensureMediaLocalDir();
  const errors = [];
  for (const key of keys) {
    const sourcePath = findLocalMediaByKey(key);
    if (!sourcePath) {
      errors.push(`Media file not found: ${key}`);
      continue;
    }
    try {
      await uploadMediaFile(sourcePath, path.basename(sourcePath));
    } catch (err) {
      errors.push(`Media upload failed for ${key}: ${err.message || err}`);
    }
  }
  return errors;
}

async function transitionState(newState) {
  const desired = newState === "active" ? "running" : newState;
  if (desired === "starting") {
    await setLocalState("starting");
    return;
  }
  if (desired === "running") {
    const mediaInputs = getMediaInputEntries().filter((entry) => {
      const ref = entry?.ref ?? "";
      return String(ref).trim().length > 0;
    });
    if (mediaInputs.length) {
      await setLocalState("downloading");
      const errors = await downloadMediaInputs(mediaInputs);
      if (errors.length) {
        console.warn("Media download errors:", errors.join(" | "));
      }
    }
    await setLocalState("running");
    return;
  }
  if (desired === "solved") {
    const mediaOutputs = getMediaOutputKeys();
    if (mediaOutputs.length) {
      await setLocalState("uploading");
      const errors = await uploadMediaOutputs(mediaOutputs);
      if (errors.length) {
        console.warn("Media upload errors:", errors.join(" | "));
      }
    }
    await setLocalState("solved", { publishOutputs: true });
    return;
  }
  if (["locked", "uploading", "downloading"].includes(desired)) {
    await setLocalState(desired);
    return;
  }
  await setLocalState(desired);
}

async function handleRestartCommand() {
  triggerRestartCommand();
  if (NEED_RESTART) {
    await setLocalState("starting");
  }
  const mediaInputs = getMediaInputEntries().filter((entry) => {
    const ref = entry?.ref ?? "";
    return String(ref).trim().length > 0;
  });
  if (mediaInputs.length) {
    await setLocalState("downloading");
    const errors = await downloadMediaInputs(mediaInputs);
    if (errors.length) {
      console.warn("Media download errors:", errors.join(" | "));
    }
  }
  if (!NEED_RESTART) {
    await setLocalState("running");
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

// --- DO NOT TOUCH BELOW (internal server/MQTT/state sync) ---
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
      if (!["locked", "starting", "running", "solved", "uploading", "downloading"].includes(newState)) {
        return sendJson(res, 400, { error: "Invalid state" });
      }
      try {
        await transitionState(newState);
        return sendJson(res, 200, { ok: true, state: STATE.state });
      } catch (e) {
        return sendJson(res, 500, { error: e.message || "State transition failed" });
      }
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

    if (req.method === "POST" && path === "/restartComplete") {
      if (STATE.state === "starting") {
        await setLocalState("running");
      }
      return sendJson(res, 200, { ok: true, state: STATE.state });
    }

    if (req.method === "POST" && path === "/restartConfig") {
      setRestartRequired(body?.needRestart);
      return sendJson(res, 200, { ok: true, needRestart: NEED_RESTART });
    }

    if (req.method === "POST" && path === "/media/upload") {
      const { localPath, remoteName } = body;
      try {
        const result = await uploadMediaFile(localPath, remoteName);
        return sendJson(res, 200, result);
      } catch (e) {
        return sendJson(res, 500, { error: e.message || "Upload failed" });
      }
    }

    if (req.method === "POST" && path === "/media/download") {
      const { remoteName, localPath } = body;
      try {
        const result = await downloadMediaFile(remoteName, localPath);
        return sendJson(res, 200, result);
      } catch (e) {
        return sendJson(res, 500, { error: e.message || "Download failed" });
      }
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

    if (req.method === "POST" && path === "/setOutput") {
      const { key, type, data } = body;
      const finalKey = key || type;
      if (!finalKey) return sendJson(res, 400, { error: "key or type required" });
      setOutput(finalKey, type, data);
      return sendJson(res, 200, { ok: true, stored: { key: finalKey, type: type || "string", data: STATE.outputs[finalKey] } });
    }

    if (req.method === "GET" && path === "/getOutput") {
      const key = parsed.query.key || parsed.query.type;
      return sendJson(res, 200, { key, data: STATE.outputs[key] });
    }

    if (req.method === "POST" && path === "/setExternalCheck") {
      const { value, active } = body;
      setExternalCheckValue(value, { active });
      return sendJson(res, 200, { ok: true, externalCheck: getExternalCheckValue() });
    }

    if (req.method === "GET" && path === "/getExternalCheck") {
      return sendJson(res, 200, { externalCheck: getExternalCheckValue() });
    }

    if (req.method === "GET" && path === "/getAll") {
      return sendJson(res, 200, { inputs: STATE.inputs, outputs: STATE.outputs, state: STATE.state });
    }

    if (req.method === "POST" && path === "/triggerExternalCheck") {
      const { value, active } = body;
      triggerExternalCheck(value, { active });
      return sendJson(res, 200, { ok: true, externalCheck: getExternalCheckValue() });
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
  ensureMediaLocalDir();
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
