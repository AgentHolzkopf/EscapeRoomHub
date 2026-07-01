const http = require("http");
const https = require("https");
const url = require("url");
const fs = require("fs");
const path = require("path");

function loadConfigFile() {
  const cfgPath = path.join(__dirname, "CommunikationAgent.config.json");
  try {
    const raw = fs.readFileSync(cfgPath, "utf-8").replace(/^\uFEFF/, "");
    return JSON.parse(raw);
  } catch (e) {
    console.warn(`Config could not be loaded from ${cfgPath}: ${e.message}`);
    return {};
  }
}

function loadDeviceIdFile() {
  const idPath = path.join(__dirname, ".agent-device-id");
  try {
    return fs.readFileSync(idPath, "utf-8").trim();
  } catch (e) {
    return "";
  }
}

const FILE_CFG = loadConfigFile();
const FILE_DEVICE_ID = loadDeviceIdFile();

const HUB_HOST = process.env.HUB_HOST || FILE_CFG.hubHost || "escapehub.local";
const MQTT_BROKER = process.env.MQTT_BROKER || FILE_CFG.mqttBroker || HUB_HOST;
const MQTT_PORT = parseInt(process.env.MQTT_PORT || FILE_CFG.mqttPort || "1883", 10);
let DEVICE_ID = process.env.DEVICE_ID || FILE_CFG.deviceId || FILE_DEVICE_ID || null;
const PUZZLE_NAME = process.env.PUZZLE_NAME || FILE_CFG.puzzleName || "Puzzle";
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.HEARTBEAT_INTERVAL_MS || FILE_CFG.heartbeatIntervalMs || "2000", 10);
const DEBUG = (process.env.DEBUG || FILE_CFG.debug) ? (process.env.DEBUG === "1" || process.env.DEBUG === "true" || FILE_CFG.debug === true) : false;
const LOCAL_IP_OVERRIDE = process.env.LOCAL_IP || FILE_CFG.localIp || null;
const MEDIA_SERVER = process.env.MEDIA_SERVER || FILE_CFG.mediaServer || `http://${HUB_HOST}`;
const MEDIA_LOCAL_DIR = process.env.MEDIA_LOCAL_DIR || FILE_CFG.mediaLocalDir || "MediaStorage";
let NEED_RESTART = (process.env.NEED_RESTART || FILE_CFG.needRestart) ? (process.env.NEED_RESTART === "1" || process.env.NEED_RESTART === "true" || FILE_CFG.needRestart === true) : false;
const MQTT_TOPIC_PREFIX = "puzzle";

let MQTT_CLIENT = null;
let LOCAL_IP = null;
let MQTT_TOPIC_HEARTBEAT = null;
let MQTT_TOPIC_COMMAND = null;
let MQTT_TOPIC_DATA = null;
let MQTT_TOPIC_CUSTOM = null;
let MQTT_TOPIC_EXTERNAL_CHECK = null;

const STATE = {
  state: "locked",
  inputs: {},
  outputs: {},
  custom: "",
  externalCheck: { active: false, value: null }
};

const VALID_STATES = new Set(["locked", "starting", "running", "solved"]);
const TYPE_STRING = "string";
const TYPE_MEDIA = "media";
const PENDING_MEDIA_DOWNLOADS = new Set();

function setDeviceId(id) {
  DEVICE_ID = id;
  MQTT_TOPIC_HEARTBEAT = `${MQTT_TOPIC_PREFIX}/${DEVICE_ID}/heartbeat`;
  MQTT_TOPIC_COMMAND = `${MQTT_TOPIC_PREFIX}/${DEVICE_ID}/command`;
  MQTT_TOPIC_DATA = `${MQTT_TOPIC_PREFIX}/${DEVICE_ID}/data`;
  MQTT_TOPIC_CUSTOM = `${MQTT_TOPIC_PREFIX}/${DEVICE_ID}/custom`;
  MQTT_TOPIC_EXTERNAL_CHECK = `${MQTT_TOPIC_PREFIX}/${DEVICE_ID}/external-check`;
}

function logDebug(...args) {
  if (DEBUG) console.log("[DEBUG]", ...args);
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
        if (iface.address.startsWith("169.254.") || iface.address.startsWith("127.") || iface.address.startsWith("192.168.56.")) continue;
        candidates.push(iface.address);
      }
    }
    return candidates.find(ip => ip.startsWith("192.168.") || ip.startsWith("10.") || ip.startsWith("172.")) || candidates[0] || "0.0.0.0";
  } catch (e) {
    return "0.0.0.0";
  }
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
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function normalizeType(type) {
  return String(type || "").toLowerCase() === TYPE_MEDIA ? TYPE_MEDIA : TYPE_STRING;
}

function valueToString(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function setInput(key, type, data) {
  if (!key) return false;
  const finalType = normalizeType(type);
  STATE.inputs[key] = { type: finalType, data: finalType === TYPE_MEDIA ? valueToString(data) : valueToString(data), present: true };
  if (finalType === TYPE_MEDIA && valueToString(data)) {
    scheduleMediaDownload(key, valueToString(data));
  }
  return true;
}

function clearInput(key) {
  if (!STATE.inputs[key]) return;
  STATE.inputs[key].data = "";
  STATE.inputs[key].present = false;
}

function deleteInput(key) {
  clearInput(key);
}

function clearCustom() {
  STATE.custom = "";
}

function deleteCustom() {
  clearCustom();
}

function setOutput(key, data, options = {}) {
  if (!key) return false;
  const finalType = normalizeType(options.type);
  STATE.outputs[key] = { type: finalType, data: finalType === TYPE_MEDIA ? key : valueToString(data), present: true };
  return true;
}

function clearOutput(key) {
  if (!STATE.outputs[key]) return;
  STATE.outputs[key].data = "";
  STATE.outputs[key].present = false;
}

function clearTransientData() {
  Object.keys(STATE.inputs).forEach(clearInput);
  Object.keys(STATE.outputs).forEach(clearOutput);
  clearCustom();
}

function getInput(key) {
  const entry = STATE.inputs[key];
  return entry && entry.present ? valueToString(entry.data) : "";
}

function inputAvailable(key) {
  const entry = STATE.inputs[key];
  return !!(entry && entry.present);
}

function getInputType(key) {
  const entry = STATE.inputs[key];
  return entry ? entry.type : TYPE_STRING;
}

function setCustomValue(value) {
  STATE.custom = valueToString(value);
}

function customAvailable() {
  return STATE.custom !== "";
}

function getCustom() {
  return STATE.custom;
}

function setExternalCheckValue(value, { active } = {}) {
  STATE.externalCheck.value = value === undefined ? null : valueToString(value);
  if (active !== undefined) STATE.externalCheck.active = !!active;
}

function getExternalCheck() {
  return { ...STATE.externalCheck };
}

function resolveRemoteMediaName(baseName) {
  return new Promise((resolve, reject) => {
    const key = valueToString(baseName).trim();
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
        return reject(new Error(payload?.error || text || `Resolve failed (${res.statusCode})`));
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function uploadMediaFile(localPath, remoteName) {
  return new Promise((resolve, reject) => {
    const resolvedPath = resolveLocalPath(localPath);
    if (!resolvedPath) return reject(new Error("localPath required"));
    fs.stat(resolvedPath, (err, stat) => {
      if (err || !stat.isFile()) return reject(new Error("Local file not found"));
      const name = valueToString(remoteName || path.basename(resolvedPath));
      const baseUrl = resolveMediaServerUrl();
      const uploadUrl = new URL("/api/media/upload", baseUrl);
      uploadUrl.searchParams.set("name", name);
      const client = uploadUrl.protocol === "https:" ? https : http;
      const req = client.request(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", "Content-Length": stat.size }
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
          return reject(new Error(payload?.error || text || `Upload failed (${res.statusCode})`));
        });
      });
      req.on("error", reject);
      fs.createReadStream(resolvedPath).pipe(req);
    });
  });
}

function downloadMediaFile(remoteName, localPath) {
  return new Promise((resolve, reject) => {
    const name = valueToString(remoteName).trim();
    if (!name) return reject(new Error("remoteName required"));
    const baseUrl = resolveMediaServerUrl();
    const downloadUrl = new URL(`/media/${encodeURIComponent(name)}`, baseUrl);
    const client = downloadUrl.protocol === "https:" ? https : http;
    const resolvedLocal = localPath ? resolveLocalPath(localPath) : path.join(ensureMediaLocalDir() || __dirname, name);
    const tempPath = `${resolvedLocal}.download`;
    fs.mkdirSync(path.dirname(resolvedLocal), { recursive: true });
    const req = client.request(downloadUrl, { method: "GET" }, (res) => {
      if (res.statusCode !== 200) {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => reject(new Error(Buffer.concat(chunks).toString() || `Download failed (${res.statusCode})`)));
        return;
      }
      const file = fs.createWriteStream(tempPath);
      res.pipe(file);
      file.on("finish", () => file.close(() => fs.rename(tempPath, resolvedLocal, (err) => err ? reject(err) : resolve({ success: true, path: resolvedLocal, name }))));
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

function findLocalMediaByKey(key) {
  const dir = ensureMediaLocalDir();
  if (!dir || !key) return "";
  const direct = path.join(dir, path.basename(key));
  if (fs.existsSync(direct)) return direct;
  const baseName = path.parse(key).name;
  const files = fs.readdirSync(dir);
  const match = files.find((name) => path.parse(name).name === baseName);
  return match ? path.join(dir, match) : "";
}

function scheduleMediaDownload(key, remoteName) {
  if (!key || !remoteName || PENDING_MEDIA_DOWNLOADS.has(key)) return;
  PENDING_MEDIA_DOWNLOADS.add(key);
  resolveRemoteMediaName(remoteName)
    .then((resolvedName) => {
      const targetPath = path.join(ensureMediaLocalDir() || __dirname, resolvedName);
      return downloadMediaFile(resolvedName, targetPath).then((result) => {
        STATE.outputs[key] = STATE.outputs[key] || { type: TYPE_MEDIA, data: key, present: false };
        STATE.inputs[key] = STATE.inputs[key] || { type: TYPE_MEDIA, data: remoteName, present: true };
        STATE.inputs[key].localPath = result.path;
      });
    })
    .catch((err) => console.warn(`Media download failed for ${key}: ${err.message || err}`))
    .finally(() => PENDING_MEDIA_DOWNLOADS.delete(key));
}

function setMedia(key, sourcePath) {
  if (!key || !sourcePath) return false;
  const resolvedSource = resolveLocalPath(sourcePath);
  if (!resolvedSource || !fs.existsSync(resolvedSource)) return false;
  ensureMediaLocalDir();
  const targetPath = path.join(resolveLocalPath(MEDIA_LOCAL_DIR), path.basename(resolvedSource));
  if (path.resolve(resolvedSource) !== path.resolve(targetPath)) {
    fs.copyFileSync(resolvedSource, targetPath);
  }
  STATE.outputs[key] = { type: TYPE_MEDIA, data: key, present: true };
  return true;
}

async function sendMedia(key) {
  const localPath = findLocalMediaByKey(key);
  if (!localPath || !fs.existsSync(localPath)) return false;
  await uploadMediaFile(localPath, path.basename(localPath));
  STATE.outputs[key] = { type: TYPE_MEDIA, data: key, present: true };
  publishData(key);
  return true;
}

function getMedia(key) {
  if (!key) return "";
  const inputEntry = STATE.inputs[key];
  if (inputEntry && inputEntry.type === TYPE_MEDIA && inputEntry.localPath && fs.existsSync(inputEntry.localPath)) {
    return inputEntry.localPath;
  }
  const outputPath = findLocalMediaByKey(key);
  return outputPath && fs.existsSync(outputPath) ? outputPath : "";
}

function deleteMedia(key) {
  const localPath = findLocalMediaByKey(key);
  if (STATE.outputs[key]) STATE.outputs[key] = { type: TYPE_MEDIA, data: "", present: false };
  if (STATE.inputs[key]) delete STATE.inputs[key].localPath;
  if (localPath && fs.existsSync(localPath)) {
    fs.unlinkSync(localPath);
  }
  return true;
}

function publishHeartbeat() {
  const payload = { name: PUZZLE_NAME, state: STATE.state, deviceId: DEVICE_ID, ip: LOCAL_IP, needRestart: NEED_RESTART };
  console.log("[HEARTBEAT]", payload);
  publishMqtt(MQTT_TOPIC_HEARTBEAT, payload);
}

function publishData(key) {
  const entry = STATE.outputs[key];
  if (!entry || !entry.present) return;
  const payloadData = entry.type === TYPE_MEDIA ? key : valueToString(entry.data);
  publishMqtt(MQTT_TOPIC_DATA, { key, type: entry.type, data: payloadData, deviceId: DEVICE_ID });
}

function publishAllOutputs() {
  Object.keys(STATE.outputs).forEach((key) => publishData(key));
}

function publishCustom(value) {
  setCustomValue(value);
  publishMqtt(MQTT_TOPIC_CUSTOM, { value: STATE.custom, deviceId: DEVICE_ID });
}

function triggerExternalCheck(value, { active = true } = {}) {
  setExternalCheckValue(value, { active });
  publishMqtt(MQTT_TOPIC_EXTERNAL_CHECK, { active: !!STATE.externalCheck.active, variable: STATE.externalCheck.value, deviceId: DEVICE_ID });
}

function setRestartRequired(value) {
  NEED_RESTART = !!value;
}

function transitionState(newState) {
  const desired = valueToString(newState).toLowerCase() === "active" ? "running" : valueToString(newState).toLowerCase();
  if (!VALID_STATES.has(desired)) return false;
  STATE.state = desired;
  publishHeartbeat();
  return true;
}

function restartComplete() {
  return transitionState(NEED_RESTART ? "running" : "locked");
}

function setState(state) {
  return transitionState(state);
}

function getState() {
  return STATE.state;
}

function initMqtt() {
  try {
    const mqtt = require("mqtt");
    MQTT_CLIENT = mqtt.connect(`mqtt://${MQTT_BROKER}:${MQTT_PORT}`);
    MQTT_CLIENT.on("connect", () => {
      console.log(`MQTT connected ${MQTT_BROKER}:${MQTT_PORT}`);
      MQTT_CLIENT.subscribe(MQTT_TOPIC_COMMAND);
      publishHeartbeat();
    });
    MQTT_CLIENT.on("error", (err) => console.warn("MQTT error:", err.message));
    MQTT_CLIENT.on("message", (topic, msg) => {
      if (topic === MQTT_TOPIC_COMMAND) handleMqttCommand(msg);
    });
  } catch (e) {
    console.log('MQTT disabled (install with "npm install mqtt" to enable).');
    MQTT_CLIENT = null;
  }
}

function publishMqtt(topic, payload) {
  if (!MQTT_CLIENT) return;
  try {
    MQTT_CLIENT.publish(topic, JSON.stringify(payload));
  } catch (e) {
    console.warn("MQTT publish failed:", e.message);
  }
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
    clearTransientData();
    publishHeartbeat();
    return;
  }

  if (action === "restart") {
    clearTransientData();
    STATE.state = NEED_RESTART ? "starting" : "running";
    publishHeartbeat();
    return;
  }

  if (action === "setState") {
    setState(payload.state || getState());
    return;
  }

  if (action === "requestData") {
    const key = payload.key || payload.type;
    if (key) publishData(key); else publishAllOutputs();
    publishHeartbeat();
    return;
  }

  if (action === "sendParam") {
    const key = payload.key || payload.name;
    if (key) setInput(key, payload.type, payload.data);
    publishHeartbeat();
    return;
  }

  if (action === "sendOutput") {
    const key = payload.key;
    if (key) publishData(key);
    publishHeartbeat();
    return;
  }

  if (action === "sendCustom" || action === "custom") {
    setCustomValue(payload?.value ?? payload?.data ?? payload?.text ?? "");
    publishHeartbeat();
  }
}

function applyInitKeys(payload) {
  const existingOutputs = { ...STATE.outputs };
  if (Array.isArray(payload.inputs)) {
    STATE.inputs = {};
    payload.inputs.forEach((inp) => {
      const key = inp.key || inp.name;
      if (!key) return;
      STATE.inputs[key] = { type: normalizeType(inp.type), data: "", present: false };
    });
  }
  if (Array.isArray(payload.outputs)) {
    STATE.outputs = {};
    payload.outputs.forEach((out) => {
      const key = out.key || out.name;
      if (!key) return;
      const type = normalizeType(out.type);
      const previous = existingOutputs[key];
      STATE.outputs[key] = previous ? { type, data: previous.data, present: previous.present } : { type, data: "", present: false };
    });
  }
}

function sendJson(res, status, payload) {
  const data = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": data.length,
    "Access-Control-Allow-Origin": "*"
  });
  res.end(data);
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentTypes = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".mp4": "video/mp4",
    ".webm": "video/webm"
  };
  const contentType = contentTypes[ext] || "application/octet-stream";
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      return sendJson(res, 404, { error: "File not found" });
    }
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": stat.size,
      "Access-Control-Allow-Origin": "*"
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => body += chunk);
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (e) { resolve({}); }
    });
  });
}

function createServer(port) {
  const server = http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      });
      return res.end();
    }

    const parsed = url.parse(req.url, true);
    const requestPath = parsed.pathname || "/";
    const body = req.method === "POST" ? await parseBody(req) : {};

    if (req.method === "GET" && requestPath === "/getState") return sendJson(res, 200, { state: getState() });
    if (req.method === "POST" && requestPath === "/setState") {
      const ok = setState(body.state);
      return sendJson(res, ok ? 200 : 400, { ok, state: getState() });
    }

    if (req.method === "GET" && (requestPath === "/getInput" || requestPath === "/getParam")) {
      const key = parsed.query.key || parsed.query.type;
      return sendJson(res, 200, { key, type: getInputType(key), data: getInput(key), present: inputAvailable(key) });
    }
    if (req.method === "GET" && requestPath === "/inputAvailable") {
      const key = parsed.query.key;
      return sendJson(res, 200, { key, available: inputAvailable(key) });
    }
    if (req.method === "POST" && requestPath === "/deleteInput") {
      deleteInput(body.key);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "POST" && requestPath === "/sendParam") {
      const key = body.key || body.name || body.type;
      if (!key) return sendJson(res, 400, { error: "key required" });
      setInput(key, body.type, body.data);
      return sendJson(res, 200, { ok: true, key, type: getInputType(key), data: getInput(key) });
    }

    if (req.method === "POST" && requestPath === "/setOutput") {
      const key = body.key;
      if (!key) return sendJson(res, 400, { error: "key required" });
      const ok = setOutput(key, body.data ?? body.value, { type: body.type });
      return sendJson(res, ok ? 200 : 400, { ok, key, output: STATE.outputs[key] || null });
    }
    if (req.method === "POST" && requestPath === "/sendOutput") {
      const key = body.key;
      if (!key) return sendJson(res, 400, { error: "key required" });
      publishData(key);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "POST" && requestPath === "/sendAllOutputs") {
      publishAllOutputs();
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "GET" && requestPath === "/getOutput") {
      const key = parsed.query.key;
      return sendJson(res, 200, { key, output: STATE.outputs[key] || null });
    }

    if (req.method === "POST" && requestPath === "/sendCustom") {
      publishCustom(body?.value ?? body?.data ?? body?.text ?? "");
      return sendJson(res, 200, { ok: true, custom: getCustom() });
    }
    if (req.method === "GET" && requestPath === "/getCustom") return sendJson(res, 200, { value: getCustom(), available: customAvailable() });
    if (req.method === "GET" && requestPath === "/customAvailable") return sendJson(res, 200, { available: customAvailable() });
    if (req.method === "POST" && requestPath === "/deleteCustom") {
      deleteCustom();
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && requestPath === "/triggerExternalCheck") {
      triggerExternalCheck(body.value, { active: body.active !== false });
      return sendJson(res, 200, { ok: true, externalCheck: getExternalCheck() });
    }
    if (req.method === "GET" && requestPath === "/getExternalCheck") return sendJson(res, 200, { externalCheck: getExternalCheck() });

    if (req.method === "POST" && requestPath === "/restartComplete") return sendJson(res, 200, { ok: restartComplete(), state: getState() });
    if (req.method === "POST" && requestPath === "/restartConfig") {
      setRestartRequired(body?.needRestart);
      return sendJson(res, 200, { ok: true, needRestart: NEED_RESTART });
    }

    if (req.method === "POST" && requestPath === "/setMedia") {
      const ok = setMedia(body.key, body.sourcePath || body.localPath);
      return sendJson(res, ok ? 200 : 400, { ok });
    }
    if (req.method === "POST" && requestPath === "/sendMedia") {
      try {
        const ok = await sendMedia(body.key);
        return sendJson(res, ok ? 200 : 400, { ok });
      } catch (e) {
        return sendJson(res, 500, { error: e.message || "sendMedia failed" });
      }
    }
    if (req.method === "GET" && requestPath === "/getMedia") {
      const key = parsed.query.key;
      return sendJson(res, 200, { key, path: getMedia(key) });
    }
    if (req.method === "GET" && requestPath === "/media/file") {
      const key = parsed.query.key;
      const mediaPath = getMedia(key);
      if (!mediaPath) return sendJson(res, 404, { error: "Media not found" });
      return sendFile(res, mediaPath);
    }
    if (req.method === "POST" && requestPath === "/deleteMedia") {
      return sendJson(res, deleteMedia(body.key) ? 200 : 400, { ok: true });
    }

    if (req.method === "POST" && requestPath === "/media/upload") {
      try {
        const result = await uploadMediaFile(body.localPath, body.remoteName);
        return sendJson(res, 200, result);
      } catch (e) {
        return sendJson(res, 500, { error: e.message || "Upload failed" });
      }
    }
    if (req.method === "POST" && requestPath === "/media/download") {
      try {
        const result = await downloadMediaFile(body.remoteName, body.localPath);
        return sendJson(res, 200, result);
      } catch (e) {
        return sendJson(res, 500, { error: e.message || "Download failed" });
      }
    }

    if (req.method === "POST" && requestPath === "/sendHeartbeat") {
      publishHeartbeat();
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "GET" && requestPath === "/getAll") return sendJson(res, 200, { state: STATE.state, inputs: STATE.inputs, outputs: STATE.outputs, custom: STATE.custom, externalCheck: STATE.externalCheck });

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
  setDeviceId(DEVICE_ID || LOCAL_IP || "puzzle-1");
  console.log(`Device ID: ${DEVICE_ID}`);
  ensureMediaLocalDir();
  initMqtt();
  createServer(port);
  if (HEARTBEAT_INTERVAL_MS > 0) {
    setInterval(() => publishHeartbeat(), HEARTBEAT_INTERVAL_MS);
  }
}

module.exports = {
  start: main,
  run: () => {},
  stop: () => { try { MQTT_CLIENT?.end?.(); } catch (e) {} },
  getState,
  setState,
  sendCustom: (value) => { publishCustom(value); return true; },
  getCustom,
  customAvailable,
  deleteCustom,
  getInput,
  inputAvailable,
  deleteInput: clearInput,
  getInputType,
  setOutput: (key, value) => setOutput(key, value),
  sendOutput: (key) => { publishData(key); return true; },
  sendAllOutputs: () => { publishAllOutputs(); return true; },
  triggerExternalCheck: (value, active = true) => { triggerExternalCheck(value, { active }); return true; },
  restartComplete,
  setMedia,
  sendMedia,
  getMedia,
  deleteMedia,
  uploadMediaFile,
  downloadMediaFile
};

if (require.main === module) {
  main();
}
