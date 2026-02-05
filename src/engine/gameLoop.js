const { LiteGraph, LGraph } = require('litegraph.js');
const http = require('http');
const EventEmitter = require('events');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const db = require('./database'); 
const mqttClient = require('./mqttClient');
require('./customNodesBackend'); 

const graph = new LGraph();
let isRunning = false;
let knownDevices = {}; 
let currentRoomName = null;
let puzzleSolvedState = {}; // Track which puzzles are solved: { nodeId: true/false }
let puzzleActivationState = {}; // Track which puzzles are currently active: { nodeId: true/false }
let gameStartTime = null; // Timestamp when game was started 
let branchStartTimes = {};
let puzzleStateDetails = {}; // Extended state info incl. notes/timestamps
let puzzleTelemetry = {}; // Stores latest heartbeat payload per puzzle
let puzzleDataStore = {}; // Stores latest output data per puzzle { puzzleId: { outputs: { key: {type,data,updatedAt} } } }
let puzzleInputFallbackStore = {}; // Stores fallback input values used per puzzle { puzzleId: { inputs: { key: {type,data,updatedAt,fallback} } } }
let externalCheckRuntime = {}; // { puzzleId: { active, value, updatedAt } }
let queueStates = {}; // { queueNodeId: { entries: [{ puzzleId, branchId, payload }], active: { puzzleId, branchId } } }
let queueTimers = {}; // { queueNodeId: timeoutId }
let puzzleQueueLocks = {}; // { puzzleId: { queueNodeId, branchId } }
let queueSolvedState = {}; // { branchId: { puzzleId: true } }
let queueBranchChoices = {}; // { queueNodeId: { branchId: { requiredPuzzleIds: [], controlledPuzzleIds: [] } } }
let branchSolvedState = {}; // { branchId: true }
let autoRestartConfig = { enabled: false, delaySec: 5 };
let autoRestartTimers = new Map();
const restartRequestedAt = {};
const RESTART_IGNORE_RUNNING_MS = 2000;
let hintTimers = {}; // { puzzleId: [timeoutId, ...] }
let hintProgress = {}; // { puzzleId: nextIndex }
let hintRuntimeQueues = {}; // { puzzleId: [ { text, delayFromStart, delayAfterPrev, dueAt } ] }
let activeHintsByScreen = {}; // { screenPath: [ { puzzleId, puzzleName, index, text, auto, at } ] }
let pendingMediaFallbackTimers = {}; // { puzzleId: { key: timeoutId } }
let systemSettings = { mqttPort: mqttClient.getCurrentPort(), screenSaverImage: null, victoryScreen: null, mediaServerEnabled: false, autostartEnabled: false };
let suppressDeviceStateUntil = 0;
const ONLINE_THRESHOLD_MS = 5000;
const VALID_PUZZLE_STATES = ['locked', 'active', 'starting', 'running', 'solved', 'error', 'uploading', 'downloading'];
const DEVICE_PORT = parseInt(process.env.PUZZLE_PORT || '5001', 10);
const ACTION_TYPES = new Set([LiteGraph.ACTION, LiteGraph.EVENT, "action", "event", -1]);
const EXTERNAL_CHECK_SOLUTION = "__PUZZLE_SOLUTION__";
const OUTPUT_MISSING_GRACE_MS = 5000;
const MEDIA_FALLBACK_DELAY_MS = OUTPUT_MISSING_GRACE_MS;
const SETTINGS_KEYS = {
    mqttPort: 'mqtt_port',
    screenSaverImage: 'screen_saver_image',
    victoryScreen: 'victory_screen',
    mediaServerEnabled: 'media_server_enabled',
    autostartEnabled: 'autostart_on_startup'
};
const AUTOSTART_SERVICE_NAME = 'md2-hub.service';
const AUTOSTART_SERVICE_PATH = '/etc/systemd/system/md2-hub.service';
const AUTOSTART_WORKDIR = '/home/admin/md2-hub/Server';
const AUTOSTART_SCRIPT = '/home/admin/md2-hub/Server/server.js';
const UPLOAD_DIR = path.join(__dirname, '../../public/uploads');
const MEDIA_DIR = path.join(__dirname, '../../MediaStorage');
const offlineErrorState = {};
const pendingOutputErrors = {};
const eventBus = new EventEmitter();
eventBus.setMaxListeners(0);

function emitUpdate(type, payload = {}) {
    eventBus.emit('update', { type, at: Date.now(), ...payload });
}

const isValidPuzzleState = (state) => VALID_PUZZLE_STATES.includes(state);

function sanitizeScreenPath(pathStr, fallback) {
    const base = (pathStr || "").toString().trim().toLowerCase();
    const cleaned = base.replace(/[^a-z0-9-_]/g, "");
    return cleaned || fallback;
}

function parseMqttPort(port) {
    const parsed = parseInt(port, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) return null;
    return parsed;
}

function parseBoolSetting(value, fallback = false) {
    if (value === null || value === undefined) return fallback;
    const normalized = String(value).trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    return fallback;
}

function sanitizeFileName(name, fallback = 'image') {
    const safeBase = (name || fallback).toString().replace(/[^a-z0-9-_]/gi, "").slice(0, 60);
    return safeBase || fallback;
}

async function ensureUploadDir() {
    if (!fs.existsSync(UPLOAD_DIR)) {
        await fsp.mkdir(UPLOAD_DIR, { recursive: true });
    }
}

async function ensureMediaStorageDir() {
    if (!fs.existsSync(MEDIA_DIR)) {
        await fsp.mkdir(MEDIA_DIR, { recursive: true });
    }
}

function mimeToExtension(mime) {
    if (!mime || typeof mime !== "string") return ".html";
    if (mime.toLowerCase().includes("html")) return ".html";
    return ".html";
}

async function loadSystemSettings() {
    try {
        const rows = await db.all(
            `SELECT key, value FROM config WHERE key IN (?, ?, ?, ?, ?)`,
            [SETTINGS_KEYS.mqttPort, SETTINGS_KEYS.screenSaverImage, SETTINGS_KEYS.victoryScreen, SETTINGS_KEYS.mediaServerEnabled, SETTINGS_KEYS.autostartEnabled]
        );
        const map = {};
        rows.forEach(r => { map[r.key] = r.value; });
        const storedPort = parseMqttPort(map[SETTINGS_KEYS.mqttPort]);
        const chosenPort = storedPort || mqttClient.getCurrentPort();
        systemSettings.mqttPort = chosenPort;
        mqttClient.restart(chosenPort);
        systemSettings.screenSaverImage = map[SETTINGS_KEYS.screenSaverImage] || null;
        systemSettings.victoryScreen = map[SETTINGS_KEYS.victoryScreen] || null;
        systemSettings.mediaServerEnabled = parseBoolSetting(map[SETTINGS_KEYS.mediaServerEnabled], false);
        systemSettings.autostartEnabled = parseBoolSetting(map[SETTINGS_KEYS.autostartEnabled], false);
    } catch (err) {
        console.error('System settings load failed:', err);
    }
}

async function setMqttPort(port) {
    const parsed = parseMqttPort(port);
    if (parsed === null) {
        return { success: false, error: "Invalid port. Allowed range: 1-65535." };
    }
    systemSettings.mqttPort = parsed;
    await db.run(
        "INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)",
        [SETTINGS_KEYS.mqttPort, String(parsed)]
    );
    mqttClient.restart(parsed);
    logSystem(`MQTT restarted on port ${parsed}`, "info");
    return { success: true, port: parsed };
}

async function setScreenSaverImage(imageName, dataUrl) {
    if (!dataUrl || typeof dataUrl !== "string") {
        return { success: false, error: "No file received." };
    }
    const match = dataUrl.match(/^data:text\/html(?:;charset=[^;]+)?;base64,(.+)$/i);
    if (!match) {
        return { success: false, error: "Invalid format (only HTML is allowed)." };
    }
    const mime = "text/html";
    const base64 = match[1];
    const buffer = Buffer.from(base64, 'base64');
    const ext = mimeToExtension(mime);
    const safeBase = sanitizeFileName(path.parse(imageName || "").name || "screen-saver", "screen-saver");
    const filename = `${safeBase}${ext}`;
    await ensureUploadDir();
    const targetPath = path.join(UPLOAD_DIR, filename);
    await fsp.writeFile(targetPath, buffer);
    const publicPath = `/uploads/${filename}`;
    systemSettings.screenSaverImage = publicPath;
    await db.run(
        "INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)",
        [SETTINGS_KEYS.screenSaverImage, publicPath]
    );
    logSystem(`Screen saver saved: ${publicPath}`, "info");
    return { success: true, path: publicPath, mime };
}

function getSystemSettings() {
    const autostartState = getAutostartState();
    return {
        ...systemSettings,
        autostartEnabled: autostartState.enabled,
        autostartStatus: autostartState.status
    };
}

async function setMediaServerEnabled(enabled) {
    const next = !!enabled;
    if (next) {
        try {
            await ensureMediaStorageDir();
        } catch (err) {
            return { success: false, error: "MediaStorage konnte nicht erstellt werden." };
        }
    }
    systemSettings.mediaServerEnabled = next;
    await db.run(
        "INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)",
        [SETTINGS_KEYS.mediaServerEnabled, next ? "1" : "0"]
    );
    logSystem(`Media server ${next ? "enabled" : "disabled"}.`, "info");
    return { success: true, enabled: next };
}

function buildAutostartServiceDefinition() {
    const nodePath = process.execPath || '/usr/bin/node';
    return [
        '[Unit]',
        'Description=MD2 Hub Server',
        'After=network.target',
        '',
        '[Service]',
        'Type=simple',
        `WorkingDirectory=${AUTOSTART_WORKDIR}`,
        `ExecStart=${nodePath} ${AUTOSTART_SCRIPT}`,
        'Restart=on-failure',
        'RestartSec=2',
        'User=root',
        '',
        '[Install]',
        'WantedBy=multi-user.target',
        ''
    ].join('\n');
}

function isLinuxSystem() {
    return process.platform === 'linux';
}

function runSystemctl(args) {
    return execFileSync('systemctl', args, { encoding: 'utf8' }).trim();
}

function querySystemctl(args) {
    const res = spawnSync('systemctl', args, { encoding: 'utf8' });
    if (res.error) {
        return { ok: false, output: '', error: res.error.message || 'systemctl failed' };
    }
    return {
        ok: res.status === 0,
        output: (res.stdout || '').trim(),
        error: (res.stderr || '').trim()
    };
}

function ensureAutostartServiceFile() {
    if (fs.existsSync(AUTOSTART_SERVICE_PATH)) return { success: true };
    const content = buildAutostartServiceDefinition();
    fs.writeFileSync(AUTOSTART_SERVICE_PATH, content, { encoding: 'utf8' });
    return { success: true };
}

function getAutostartState() {
    if (!isLinuxSystem()) {
        return { enabled: systemSettings.autostartEnabled, status: 'Unsupported' };
    }
    const enabledRes = querySystemctl(['is-enabled', AUTOSTART_SERVICE_NAME]);
    const enabled = enabledRes.output === 'enabled';
    const activeRes = querySystemctl(['is-active', AUTOSTART_SERVICE_NAME]);
    const active = activeRes.output === 'active';
    if (!enabledRes.output && !activeRes.output) {
        return { enabled: systemSettings.autostartEnabled, status: 'Unknown' };
    }
    const status = enabled ? (active ? 'Enabled (Running)' : 'Enabled') : 'Disabled';
    return { enabled, status };
}

async function setAutostartEnabled(enabled) {
    if (!isLinuxSystem()) {
        return { success: false, error: 'Autostart only supported on Linux.' };
    }
    const next = !!enabled;
    try {
        if (next) {
            ensureAutostartServiceFile();
            runSystemctl(['daemon-reload']);
            runSystemctl(['enable', AUTOSTART_SERVICE_NAME]);
        } else {
            runSystemctl(['disable', AUTOSTART_SERVICE_NAME]);
        }
        systemSettings.autostartEnabled = next;
        await db.run(
            "INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)",
            [SETTINGS_KEYS.autostartEnabled, next ? "1" : "0"]
        );
        const state = getAutostartState();
        return { success: true, enabled: state.enabled, status: state.status };
    } catch (err) {
        return { success: false, error: err.message || 'Autostart update failed.' };
    }
}

async function setVictoryScreen(imageName, dataUrl) {
    if (!dataUrl || typeof dataUrl !== "string") {
        return { success: false, error: "No file received." };
    }
    const match = dataUrl.match(/^data:text\/html(?:;charset=[^;]+)?;base64,(.+)$/i);
    if (!match) {
        return { success: false, error: "Invalid format (only HTML is allowed)." };
    }
    const mime = "text/html";
    const base64 = match[1];
    const buffer = Buffer.from(base64, 'base64');
    const ext = mimeToExtension(mime);
    const safeBase = sanitizeFileName(path.parse(imageName || "").name || "victory-screen", "victory-screen");
    const filename = `${safeBase}${ext}`;
    await ensureUploadDir();
    const targetPath = path.join(UPLOAD_DIR, filename);
    await fsp.writeFile(targetPath, buffer);
    const publicPath = `/uploads/${filename}`;
    systemSettings.victoryScreen = publicPath;
    await db.run(
        "INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)",
        [SETTINGS_KEYS.victoryScreen, publicPath]
    );
    logSystem(`Victory screen saved: ${publicPath}`, "info");
    return { success: true, path: publicPath, mime };
}

function normalizeScreensConfig() {
    const cfg = graph.config || (graph.config = {});
    const rawScreens = Array.isArray(cfg.screens) ? cfg.screens : [];
    const used = new Set();
    const normalizeRole = (role) => {
        if (role === "hint") return "hint";
        if (role === "progress") return "progress";
        return "player";
    };
    const normalizeProgressStyle = (style) => {
        const key = String(style || "").trim().toLowerCase();
        if (key === "simple" || key === "progress-tree" || key === "entire-tree") return key;
        return "simple";
    };
    const normalized = rawScreens.map((s, idx) => {
        const id = typeof s.id === "number" ? s.id : parseInt(s.id || (idx + 1), 10) || (idx + 1);
        const basePath = sanitizeScreenPath(s.path || s.slug || `screen-${idx + 1}`, `screen-${id}`);
        let candidate = basePath || `screen-${id}`;
        let suffix = 2;
        while (used.has(candidate)) {
            candidate = `${basePath || `screen-${id}`}-${suffix++}`;
        }
        used.add(candidate);
        const branchIds = Array.isArray(s.branchIds)
            ? s.branchIds.map(v => parseInt(v, 10)).filter(v => Number.isFinite(v))
            : [];
        return {
            ...s,
            id,
            name: s.name || `Screen ${idx + 1}`,
            role: normalizeRole(s.role),
            progressStyle: normalizeProgressStyle(s.progressStyle),
            branchIds,
            showRunningTime: parseBoolSetting(s.showRunningTime, false),
            path: candidate
        };
    });
    cfg.screens = normalized;
    return normalized;
}

function getAllPuzzleNodes() {
    const nodes = graph.findNodesByType("escape/Puzzle");
    return nodes || [];
}
function getQueueNodes() {
    const nodes = graph.findNodesByType("escape/Logic") || [];
    return nodes.filter(n => (n?.properties?.logicType || "").toUpperCase() === "QUEUE");
}
function isQueueTargetPuzzleId(puzzleId) {
    if (!Number.isFinite(puzzleId)) return false;
    return getQueueNodes().some(queueNode => getQueueControlledPuzzleIds(queueNode).includes(puzzleId));
}
function getQueueNodesForTargetPuzzle(puzzleId) {
    if (!Number.isFinite(puzzleId)) return [];
    return getQueueNodes().filter(queueNode => getQueueControlledPuzzleIds(queueNode).includes(puzzleId));
}
function getQueueState(queueNodeId) {
    if (!queueStates[queueNodeId]) {
        queueStates[queueNodeId] = { entries: [], active: null, cooldownUntil: null };
    }
    return queueStates[queueNodeId];
}
function clearQueueTimer(queueNodeId) {
    if (!queueNodeId) return;
    if (queueTimers[queueNodeId]) {
        clearTimeout(queueTimers[queueNodeId]);
        delete queueTimers[queueNodeId];
    }
}
function clearQueueSolvedForBranch(branchId) {
    if (!Number.isFinite(branchId)) return;
    delete queueSolvedState[branchId];
}
function clearQueueSolvedForPuzzle(puzzleId) {
    Object.keys(queueSolvedState).forEach(branchId => {
        if (queueSolvedState[branchId]) {
            delete queueSolvedState[branchId][puzzleId];
        }
    });
}
function markBranchSolved(branchId) {
    if (!Number.isFinite(branchId)) return;
    branchSolvedState[branchId] = true;
}

function normalizeHints(node) {
    if (!node || !node.properties) return [];
    const hints = Array.isArray(node.properties.hints) ? node.properties.hints : [];
    return hints.map(h => {
        if (typeof h === "string") {
            return { text: h, delayFromStart: 0, delayAfterPrev: 0 };
        }
        return {
            text: h.text || "",
            delayFromStart: Number.isFinite(h.delayFromStart) ? h.delayFromStart : 0,
            delayAfterPrev: Number.isFinite(h.delayAfterPrev) ? h.delayAfterPrev : 0
        };
    });
}

function getHintRuntimeQueue(node) {
    if (!node) return [];
    const puzzleId = node.id;
    if (!hintRuntimeQueues[puzzleId]) {
        const hints = normalizeHints(node);
        const progress = hintProgress[puzzleId] || 0;
        hintRuntimeQueues[puzzleId] = hints.slice(progress).map(h => ({ ...h, dueAt: null }));
    }
    return hintRuntimeQueues[puzzleId];
}

function syncHintProgress(node) {
    if (!node) return;
    const puzzleId = node.id;
    const total = normalizeHints(node).length;
    const remaining = hintRuntimeQueues[puzzleId]?.length ?? Math.max(0, total - (hintProgress[puzzleId] || 0));
    hintProgress[puzzleId] = Math.max(0, total - remaining);
}

function getScreensConfig() {
    return normalizeScreensConfig();
}

function findScreenById(id) {
    return getScreensConfig().find(s => String(s.id) === String(id));
}

function findScreenByPath(pathStr) {
    if (!pathStr) return null;
    const normalized = String(pathStr).replace(/^\/+/, "").toLowerCase();
    return getScreensConfig().find(s => (s.path || "").toLowerCase() === normalized);
}

function resolveHintScreen(node) {
    if (!node) return null;
    const direct = node.properties?.hintScreenId ? findScreenById(node.properties.hintScreenId) : null;
    if (direct && (direct.role || "player") === "hint") return direct;
    return null;
}

function isPuzzleStateActive(state) {
    return normalizePuzzleState(state) === 'running';
}

function getPuzzleStateKey(puzzleId) {
    return normalizePuzzleState(puzzleStateDetails[puzzleId]?.state || 'locked');
}

function getPuzzleOutputValue(node, key) {
    if (!node || !key) return null;
    const outputs = puzzleDataStore[node.id]?.outputs || {};
    if (!Object.prototype.hasOwnProperty.call(outputs, key)) return null;
    const entry = outputs[key];
    if (!entry) return null;
    return { value: entry.data, type: entry.type, updatedAt: entry.updatedAt || null };
}

function setExternalCheckRuntime(puzzleId, { active = true, value = null } = {}) {
    const normalizedValue = value === undefined ? null : value;
    externalCheckRuntime[puzzleId] = {
        active: !!active,
        value: normalizedValue,
        updatedAt: Date.now()
    };
}

function getExternalCheckRuntime(puzzleId) {
    return externalCheckRuntime[puzzleId] || null;
}

function clearExternalCheckRuntime(puzzleId) {
    delete externalCheckRuntime[puzzleId];
}

function isExternalCheckActive(node, stateKey) {
    if (!node || node.type !== "escape/Puzzle") return false;
    const screenId = node.properties?.externalScreenId || "";
    const variable = node.properties?.externalCheckVariable || "";
    if (!screenId || !variable) return false;
    if (!isPuzzleStateActive(stateKey)) return false;
    if (variable === EXTERNAL_CHECK_SOLUTION) {
        const runtime = getExternalCheckRuntime(node.id);
        return !!runtime?.active;
    }
    return true;
}

async function resolveExternalCheckValue(node) {
    if (!node || node.type !== "escape/Puzzle") return { value: null, type: null, source: null };
    const key = node.properties?.externalCheckVariable || "";
    if (!key) return { value: null, type: null, source: null };

    if (key === EXTERNAL_CHECK_SOLUTION) {
        const runtime = getExternalCheckRuntime(node.id);
        if (!runtime?.active) return { value: null, type: "string", source: "solution" };
        return { value: runtime.value ?? null, type: "string", source: "solution" };
    }

    const [direction, name] = key.split(":", 2);
    if (!direction || !name) {
        return { value: null, type: null, source: null };
    }

    if (direction === "internal") {
        const entry = node.properties?.internalVariables?.[name];
        if (!entry) return { value: null, type: null, source: "internal" };
        const parsed = parseFallbackValueForType(entry.value, entry.type);
        if (!parsed.ok) return { value: null, type: null, source: "internal" };
        return { value: parsed.value, type: entry.type || null, source: "internal" };
    }

    if (direction === "out") {
        const out = getPuzzleOutputValue(node, name);
        return { value: out?.value ?? null, type: out?.type ?? null, source: "output" };
    }

    if (direction === "in") {
        const telemetry = puzzleTelemetry[node.id];
        if (telemetry && telemetry.inputs && Object.prototype.hasOwnProperty.call(telemetry.inputs, name)) {
            clearInputFallbackUsage(node.id, name);
            return { value: telemetry.inputs[name], type: typeof telemetry.inputs[name], source: "input" };
        }
        const linked = getLinkedOutputValueForInput(node, name);
        if (linked) {
            clearInputFallbackUsage(node.id, name);
            return linked;
        }
        if (!isUpstreamSolvedForInput(node, name)) {
            return { value: null, type: null, source: "input" };
        }
        const fallbackRaw = getInputFallbackRaw(node, name);
        const inputType = name && node.inputs ? node.inputs.find(inp => inp && inp.name === name)?.type : null;
        const parsed = parseFallbackValueForType(fallbackRaw, inputType);
        if (parsed.ok) {
            recordInputFallbackUsage(node.id, name, inputType, parsed.value);
            return { value: parsed.value, type: typeof parsed.value, source: "fallback" };
        }
        return { value: null, type: null, source: "input" };
    }

    return { value: null, type: null, source: null };
}

async function buildExternalCheckPayload(node, screen) {
    if (!node || !screen) return null;
    const stateKey = getPuzzleStateKey(node.id);
    const externalActive = isExternalCheckActive(node, stateKey);

    const { value, type, source } = await resolveExternalCheckValue(node);
    const normalizedValue = value === undefined || value === null ? null : String(value);

    const varLabelRaw = node.properties?.externalCheckVariable || "";
    const variableLabel = varLabelRaw === EXTERNAL_CHECK_SOLUTION
        ? "Puzzle Solution"
        : varLabelRaw
            ? varLabelRaw
                .replace(/^in:/, "Input: ")
                .replace(/^out:/, "Output: ")
                .replace(/^internal:/, "Internal: ")
            : "";

    return {
        id: node.id,
        name: getPuzzleName(node, node.id),
        state: stateKey,
        active: externalActive,
        expectedLength: normalizedValue ? normalizedValue.length : null,
        variableLabel,
        showAssignment: node.properties?.externalShowAssignment !== false,
        valueDefined: normalizedValue !== null,
        source: source || null,
        type: type || null
    };
}

async function collectExternalChecksForScreen(screen) {
    if (!screen) return [];
    const targetId = screen.id;
    const nodes = getAllPuzzleNodes().filter(n => String(n?.properties?.externalScreenId || "") === String(targetId));
    const payloads = await Promise.all(nodes.map(n => buildExternalCheckPayload(n, screen)));
    return payloads.filter(Boolean);
}

function triggerHintForPuzzle(puzzleId, { auto = false } = {}) {
    const node = getPuzzleNodeById(puzzleId);
    if (!node) return { success: false, error: "Puzzle not found" };
    const stateRec = getPuzzleStateRecord(puzzleId);
    if (stateRec.state === 'solved') return { success: false, error: "Puzzle already solved" };
    const screen = resolveHintScreen(node);
    if (!screen) {
        return { success: false, error: "No hint screen assigned" };
    }
    const queue = getHintRuntimeQueue(node);
    if (!queue.length) return { success: false, error: "All hints already shown" };
    const nextIdx = hintProgress[puzzleId] || 0;
    const next = queue[0];
    const nextText = next?.text || "";
    if (!nextText) return { success: false, error: "No hints configured" };

    const now = Date.now();
    const entry = {
        puzzleId,
        puzzleName: node.properties?.Name || node.title || `Puzzle ${puzzleId}`,
        index: nextIdx,
        text: nextText,
        auto: !!auto,
        at: now,
        showAssignment: node.properties?.showHintAssignment !== false
    };

    const pathKey = sanitizeScreenPath(screen.path || "", `screen-${screen.id}`);
    if (!activeHintsByScreen[pathKey]) activeHintsByScreen[pathKey] = [];
    activeHintsByScreen[pathKey].push(entry);
    queue.shift();
    syncHintProgress(node);
    emitUpdate('hints', { puzzleId });

    return { success: true, hint: entry, screen: { id: screen.id, name: screen.name, path: screen.path } };
}

function triggerCustomHint(puzzleId, text, { showAssignment } = {}) {
    const node = getPuzzleNodeById(puzzleId);
    if (!node) return { success: false, error: "Puzzle not found" };
    const screen = resolveHintScreen(node);
    if (!screen) return { success: false, error: "No hint screen assigned" };
    const cleaned = (text || "").toString().trim();
    if (!cleaned) return { success: false, error: "Hint text required" };
    const assignmentFlag = (showAssignment === undefined || showAssignment === null)
        ? (node.properties?.showHintAssignment !== false)
        : !!showAssignment;
    const now = Date.now();
    const entry = {
        puzzleId,
        puzzleName: node.properties?.Name || node.title || `Puzzle ${puzzleId}`,
        index: hintProgress[puzzleId] || 0,
        text: cleaned,
        auto: false,
        at: now,
        showAssignment: assignmentFlag,
        custom: true
    };
    const pathKey = sanitizeScreenPath(screen.path || "", `screen-${screen.id}`);
    if (!activeHintsByScreen[pathKey]) activeHintsByScreen[pathKey] = [];
    activeHintsByScreen[pathKey].push(entry);
    emitUpdate('hints', { puzzleId });
    return { success: true, hint: entry, screen: { id: screen.id, name: screen.name, path: screen.path } };
}

function scheduleHintTimers(node) {
    if (!node || !node.properties) return;
    clearHintTimers(node.id);
    if (!node.properties.automaticHintTrigger) return;
    const screen = resolveHintScreen(node);
    if (!screen) return;

    const queue = getHintRuntimeQueue(node);
    if (!queue.length) return;

    const timers = [];
    let accumulated = 0;
    const now = Date.now();
    queue.forEach((h, idx) => {
        const delaySec = idx === 0 ? (h.delayFromStart || 0) : (h.delayAfterPrev || 0);
        accumulated += Math.max(0, delaySec) * 1000;
        h.dueAt = now + accumulated;
        const targetIdx = idx;
        const timerId = setTimeout(() => {
            const progress = hintProgress[node.id] || 0;
            if (targetIdx < progress) return;
            triggerHintForPuzzle(node.id, { auto: true });
        }, accumulated);
        timers.push(timerId);
    });
    hintTimers[node.id] = timers;
}

function clearHintTimers(puzzleId) {
    if (!hintTimers[puzzleId]) return;
    hintTimers[puzzleId].forEach(id => clearTimeout(id));
    delete hintTimers[puzzleId];
}

function removeHintsForPuzzle(puzzleId) {
    Object.keys(activeHintsByScreen).forEach(path => {
        activeHintsByScreen[path] = (activeHintsByScreen[path] || []).filter(h => h.puzzleId !== puzzleId);
        if (!activeHintsByScreen[path].length) delete activeHintsByScreen[path];
    });
    delete hintProgress[puzzleId];
    delete hintRuntimeQueues[puzzleId];
}

function getPuzzleNodeById(puzzleId) {
    const nodes = getAllPuzzleNodes();
    return nodes.find(n => n.id === puzzleId);
}

function stringifyIOType(t){
    if (typeof t === "string") return t;
    return String(t);
}

function collectIOKeys(node){
    const inputs = (node.inputs || []).map(i => ({ key: i.name, type: stringifyIOType(i.type) }));
    const outputs = (node.outputs || [])
        .filter(o => !ACTION_TYPES.has(o.type) && o.name !== "Done")
        .map(o => ({ key: o.name, type: stringifyIOType(o.type) }));
    return { inputs, outputs };
}

function normalizeDataType(t) {
    const str = stringifyIOType(t).toLowerCase();
    if (["string", "number", "boolean", "media"].includes(str)) return str;
    return "string";
}

function isDataKeyAllowed(key, type) {
    if (!key) return false;
    if (key === "Done") return false;
    if (ACTION_TYPES.has(type)) return false;
    return true;
}

function normalizeMediaKey(rawKey) {
    const raw = (rawKey || "").toString().trim();
    if (!raw) return null;
    return path.basename(raw);
}

function findMediaByBaseName(baseName) {
    const safeBase = normalizeMediaKey(baseName);
    if (!safeBase) return null;
    try {
        const files = fs.readdirSync(MEDIA_DIR);
        const target = safeBase.toLowerCase();
        const match = files.find(name => path.parse(name).name.toLowerCase() === target);
        return match || null;
    } catch (err) {
        return null;
    }
}

function getInputFallbackRaw(node, name) {
    if (!node || !node.properties || !node.properties.inputFallbacks) return null;
    if (!Object.prototype.hasOwnProperty.call(node.properties.inputFallbacks, name)) return null;
    const entry = node.properties.inputFallbacks[name];
    if (entry && typeof entry === "object" && Object.prototype.hasOwnProperty.call(entry, "value")) {
        return entry.value;
    }
    return entry;
}

function getOutputFallbackRaw(node, name) {
    if (!node || !node.properties || !node.properties.outputValues) return null;
    if (!Object.prototype.hasOwnProperty.call(node.properties.outputValues, name)) return null;
    const entry = node.properties.outputValues[name];
    if (entry && typeof entry === "object" && Object.prototype.hasOwnProperty.call(entry, "value")) {
        return entry.value;
    }
    return entry;
}

function parseFallbackValueForType(raw, type) {
    if (raw === undefined || raw === null) return { ok: false };
    const normalized = normalizeDataType(type);
    if (normalized === "string" || normalized === "media") {
        return { ok: true, value: String(raw) };
    }
    if (normalized === "number") {
        if (typeof raw === "number" && Number.isFinite(raw)) return { ok: true, value: raw };
        const str = String(raw).trim();
        if (!/^-?\d+(?:\.\d+)?$/.test(str)) return { ok: false };
        const num = parseFloat(str);
        if (!Number.isFinite(num)) return { ok: false };
        return { ok: true, value: num };
    }
    if (normalized === "boolean") {
        if (typeof raw === "boolean") return { ok: true, value: raw };
        const str = String(raw).trim().toLowerCase();
        if (["true", "1", "yes", "on"].includes(str)) return { ok: true, value: true };
        if (["false", "0", "no", "off"].includes(str)) return { ok: true, value: false };
        return { ok: false };
    }
    return { ok: false };
}
function getOutputDataForPuzzleOutput(originNode, outName, outType) {
    if (!originNode) return null;
    const stored = puzzleDataStore[originNode.id]?.outputs?.[outName];
    if (stored && stored.data !== null && stored.data !== undefined) {
        return { data: stored.data, type: stored.type || normalizeDataType(outType) };
    }
    const fallbackRaw = getOutputFallbackRaw(originNode, outName);
    if (fallbackRaw === null || fallbackRaw === undefined) return null;
    const parsed = parseFallbackValueForType(fallbackRaw, outType);
    if (!parsed.ok) return null;
    return { data: parsed.value, type: normalizeDataType(outType) };
}

function allPuzzlesSolved() {
    const puzzles = getAllPuzzleNodes();
    if (!puzzles.length) return false;
    return puzzles.every(p => puzzleSolvedState[p.id]);
}

function clearAllAutoRestartTimers() {
    autoRestartTimers.forEach(timerId => clearTimeout(timerId));
    autoRestartTimers.clear();
}

function getBranchForPuzzle(puzzleId) {
    const flowData = buildBranchFlowData();
    const branch = (flowData.branches || []).find(b => (b.puzzles || []).some(p => p.id === puzzleId));
    return branch || null;
}

function getUpstreamPuzzleIds(targetId) {
    if (!Number.isFinite(targetId)) return [];
    const { adjacencyMap, allNodes } = getGraphIndex();
    const reverseMap = {};
    Object.keys(adjacencyMap).forEach(originKey => {
        const originId = parseInt(originKey, 10);
        (adjacencyMap[originKey] || []).forEach(conn => {
            const targetKey = conn.targetId;
            if (!reverseMap[targetKey]) reverseMap[targetKey] = [];
            reverseMap[targetKey].push(originId);
        });
    });
    const visited = new Set();
    const result = new Set();
    const queue = [targetId];
    while (queue.length) {
        const current = queue.shift();
        if (visited.has(current)) continue;
        visited.add(current);
        const node = allNodes[current];
        if (node && node.type === "escape/Puzzle") {
            result.add(node.id);
        }
        const incoming = reverseMap[current] || [];
        incoming.forEach(prevId => {
            if (!visited.has(prevId)) queue.push(prevId);
        });
    }
    return Array.from(result);
}

function isBranchSolved(branch) {
    if (!branch || !Array.isArray(branch.puzzles) || !branch.puzzles.length) return false;
    if (branchSolvedState[branch.id]) return true;
    const queueSolved = queueSolvedState[branch.id] || {};
    return branch.puzzles.every(p => puzzleSolvedState[p.id] || queueSolved[p.id]);
}

function scheduleBranchAutoRestart(branch) {
    if (!autoRestartConfig.enabled || !branch) return;
    if (autoRestartTimers.has(branch.id)) return;
    if (!isBranchSolved(branch)) return;
    const delayMs = Math.max(0, (autoRestartConfig.delaySec || 0) * 1000);
    logSystem(`Auto-restart scheduled for branch ${branch.id} in ${autoRestartConfig.delaySec}s.`, "info");
    const timerId = setTimeout(() => {
        autoRestartTimers.delete(branch.id);
        module.exports.restartBranch({ branchId: branch.id });
    }, delayMs);
    autoRestartTimers.set(branch.id, timerId);
}

function checkAutoRestartCondition() {
    if (!autoRestartConfig.enabled) {
        clearAllAutoRestartTimers();
        return;
    }
    const flowData = buildBranchFlowData();
    (flowData.branches || []).forEach(branch => {
        scheduleBranchAutoRestart(branch);
    });
}

function primeDataStoreWithOutputs() {
    puzzleDataStore = {};
    getAllPuzzleNodes().forEach(node => {
        const io = collectIOKeys(node);
        if (!io.outputs || !io.outputs.length) return;
        puzzleDataStore[node.id] = { outputs: {} };
        io.outputs.forEach(out => {
            const key = out.key || out.type;
            if (!key) return;
            puzzleDataStore[node.id].outputs[key] = { type: normalizeDataType(out.type), data: null, updatedAt: null };
        });
    });
}

function recordOutputData(puzzleId, key, type, data) {
    if (!isDataKeyAllowed(key, type)) return;
    if (!puzzleDataStore[puzzleId]) puzzleDataStore[puzzleId] = { outputs: {} };
    const baseType = puzzleDataStore[puzzleId].outputs[key]?.type;
    const finalType = normalizeDataType(type || baseType || "string");
    let finalData = data;
    if (finalType === "media") {
        const mediaKey = normalizeMediaKey(key);
        const node = getPuzzleNodeById(puzzleId);
        const puzzleName = getPuzzleName(node, puzzleId);
        if (!mediaKey) {
            logSystem(`Media reference missing for "${puzzleName}" (${key || "unknown"}).`, "error");
            finalData = null;
        } else {
            if (mediaKey !== key) {
                logSystem(`Media reference sanitized for "${puzzleName}": "${key}" -> "${mediaKey}".`, "warn");
            }
            const match = findMediaByBaseName(mediaKey);
            if (!match) {
                logSystem(`Media reference not found for "${puzzleName}": ${mediaKey}.`, "error");
                finalData = null;
            }
            if (finalData !== null) {
                finalData = mediaKey;
            }
        }
    }
    puzzleDataStore[puzzleId].outputs[key] = {
        type: finalType,
        data: finalData,
        updatedAt: Date.now()
    };
    clearPendingOutputError(puzzleId, key);
}

function shouldIgnoreInboundState() {
    return Date.now() < suppressDeviceStateUntil;
}

function shouldApplyDeviceState(puzzleId, incomingState) {
    if (!isRunning) return false;
    const rawState = (incomingState || "").toString().toLowerCase();
    if (rawState === 'restarting' || rawState === 'ready') return false;
    const state = normalizePuzzleState(incomingState);
    const current = puzzleStateDetails[puzzleId]?.state || 'locked';
    if (current === 'locked' && state !== 'locked') return false;
    if (current === 'solved' && state !== 'solved') return false;
    if ((current === 'active' || current === 'starting' || current === 'running') && state === 'locked') return false;
    if (current === 'starting' && state === 'running') {
        const since = restartRequestedAt[puzzleId];
        if (since && (Date.now() - since) < RESTART_IGNORE_RUNNING_MS) {
            return false;
        }
    }
    return true;
}

function recordInputFallbackUsage(puzzleId, key, type, data) {
    if (!key) return;
    const existing = puzzleInputFallbackStore[puzzleId]?.inputs?.[key];
    const normalizedType = normalizeDataType(type || "string");
    const hasChanged = !existing || existing.data !== data || existing.type !== normalizedType;
    if (!puzzleInputFallbackStore[puzzleId]) puzzleInputFallbackStore[puzzleId] = { inputs: {} };
    puzzleInputFallbackStore[puzzleId].inputs[key] = {
        type: normalizedType,
        data: data,
        updatedAt: Date.now(),
        fallback: true
    };
    if (hasChanged) {
        const node = getPuzzleNodeById(puzzleId);
        const puzzleName = getPuzzleName(node, puzzleId);
        logSystem(`Fallback input used for "${puzzleName}" (${key}).`, "warn");
    }
}

function clearInputFallbackUsage(puzzleId, key) {
    if (!puzzleInputFallbackStore[puzzleId] || !puzzleInputFallbackStore[puzzleId].inputs) return;
    delete puzzleInputFallbackStore[puzzleId].inputs[key];
    if (!Object.keys(puzzleInputFallbackStore[puzzleId].inputs).length) {
        delete puzzleInputFallbackStore[puzzleId];
    }
}

function clearPendingMediaFallback(puzzleId, key) {
    if (!pendingMediaFallbackTimers[puzzleId]) return;
    const timers = pendingMediaFallbackTimers[puzzleId];
    if (timers[key]) {
        clearTimeout(timers[key]);
        delete timers[key];
    }
    if (!Object.keys(timers).length) {
        delete pendingMediaFallbackTimers[puzzleId];
    }
}

function hasLinkedOutputData(targetNode, inputName) {
    if (!targetNode || !inputName || !targetNode.inputs) return false;
    const inputIdx = targetNode.inputs.findIndex(inp => inp && inp.name === inputName);
    if (inputIdx === -1) return false;
    const input = targetNode.inputs[inputIdx];
    const linkIds = [];
    if (Array.isArray(input.links)) {
        input.links.forEach(l => { if (l !== null && l !== undefined && l !== -1) linkIds.push(l); });
    } else if (input.link !== null && input.link !== undefined && input.link !== -1) {
        linkIds.push(input.link);
    }
    if (!linkIds.length) return false;
    const links = graph.links || {};
    for (const linkId of linkIds) {
        const link = links[linkId];
        if (!link) continue;
        const origin = graph.getNodeById ? graph.getNodeById(link.origin_id) : getPuzzleNodeById(link.origin_id);
        if (!origin || origin.type !== "escape/Puzzle") continue;
        const out = origin.outputs && origin.outputs[link.origin_slot];
        if (!out || ACTION_TYPES.has(out.type)) continue;
        const outName = out.name || `Output ${link.origin_slot + 1}`;
        const stored = puzzleDataStore[origin.id]?.outputs?.[outName];
        if (stored && stored.data !== null && stored.data !== undefined) {
            return true;
        }
    }
    return false;
}

function scheduleMediaInputFallback(targetNode, inputName, type, data) {
    if (!targetNode || !inputName) return;
    const puzzleId = targetNode.id;
    if (!pendingMediaFallbackTimers[puzzleId]) pendingMediaFallbackTimers[puzzleId] = {};
    if (pendingMediaFallbackTimers[puzzleId][inputName]) return;
    pendingMediaFallbackTimers[puzzleId][inputName] = setTimeout(() => {
        clearPendingMediaFallback(puzzleId, inputName);
        if (!isPuzzleStateActive(getPuzzleStateKey(puzzleId))) return;
        if (hasLinkedOutputData(targetNode, inputName)) return;
        const targetDevId = getDeviceIdForPuzzle(targetNode);
        if (!canSendToDevice(targetNode, targetDevId)) return;
        publishCommand(targetDevId, {
            action: "sendParam",
            key: inputName,
            type: normalizeDataType(type),
            data,
            fallback: true
        });
        logSystem(
            `Data sent to "${getPuzzleName(targetNode, targetNode.id)}" (${inputName}): ${JSON.stringify(data)}`,
            "system"
        );
        recordInputFallbackUsage(targetNode.id, inputName, type, data);
    }, MEDIA_FALLBACK_DELAY_MS);
}

function schedulePendingOutputErrors(node) {
    if (!node || node.type !== "escape/Puzzle") return;
    if (node.properties?.isAnalog) return;
    const devId = getDeviceIdForPuzzle(node);
    if (!devId) return;
    const outputs = node.outputs || [];
    outputs.forEach((out, idx) => {
        const outName = out.name || `Output ${idx + 1}`;
        if (!isDataKeyAllowed(outName, out.type)) return;
        const targets = getOutputTargets(node, idx);
        if (!targets.length) return;
        const stored = puzzleDataStore[node.id]?.outputs?.[outName];
        if (stored && stored.data !== null && stored.data !== undefined) return;
        const puzzleKey = String(node.id);
        if (!pendingOutputErrors[puzzleKey]) pendingOutputErrors[puzzleKey] = {};
        if (!pendingOutputErrors[puzzleKey][outName]) {
            pendingOutputErrors[puzzleKey][outName] = {
                dueAt: Date.now() + OUTPUT_MISSING_GRACE_MS,
                targets,
                logged: false
            };
        }
    });
}

function clearPendingOutputError(puzzleId, key) {
    const puzzleKey = String(puzzleId);
    if (!pendingOutputErrors[puzzleKey]) return;
    delete pendingOutputErrors[puzzleKey][key];
    if (!Object.keys(pendingOutputErrors[puzzleKey]).length) {
        delete pendingOutputErrors[puzzleKey];
    }
}

function clearPendingOutputErrors(puzzleId) {
    const puzzleKey = String(puzzleId);
    delete pendingOutputErrors[puzzleKey];
}

function checkPendingOutputErrors() {
    if (!isRunning) return;
    const now = Date.now();
    Object.entries(pendingOutputErrors).forEach(([puzzleKey, outputs]) => {
        const puzzleId = parseInt(puzzleKey, 10);
        const node = getPuzzleNodeById(puzzleId);
        if (!node) {
            delete pendingOutputErrors[puzzleKey];
            return;
        }
        Object.entries(outputs).forEach(([outKey, info]) => {
            const stored = puzzleDataStore[puzzleId]?.outputs?.[outKey];
            if (stored && stored.data !== null && stored.data !== undefined) {
                clearPendingOutputError(puzzleId, outKey);
                return;
            }
            if (info.logged || (info.dueAt && now < info.dueAt)) return;
            const puzzleName = getPuzzleName(node, puzzleId);
            const targetList = Array.isArray(info.targets) && info.targets.length ? ` -> ${info.targets.join(", ")}` : "";
            logSystem(`Missing output from "${puzzleName}" (${outKey})${targetList}.`, "error");
            info.logged = true;
        });
    });
}

function checkHeartbeatErrors() {
    if (!isRunning) return;
    const now = Date.now();
    const puzzles = getAllPuzzleNodes();
    puzzles.forEach(node => {
        if (!node || node.properties?.isAnalog) return;
        const deviceId = getDeviceIdForPuzzle(node);
        if (!deviceId) return;
        const lastSeen = knownDevices[deviceId]?.lastSeen;
        if (!lastSeen) return;
        const isOnline = (now - lastSeen) < ONLINE_THRESHOLD_MS;
        const key = `${node.id}:${deviceId}`;
        if (!isOnline) {
            const entry = offlineErrorState[key] || { lastLoggedAt: 0 };
            if (!entry.lastLoggedAt || now - entry.lastLoggedAt >= 2000) {
                const name = getPuzzleName(node, node.id);
                const seconds = Math.max(0, Math.floor((now - lastSeen) / 1000));
                logSystem(`Heartbeat missing for "${name}" (${deviceId}) for ${seconds}s.`, "error");
                entry.lastLoggedAt = now;
            }
            offlineErrorState[key] = entry;
        } else if (offlineErrorState[key]) {
            delete offlineErrorState[key];
            logSystem(`Heartbeat restored for "${getPuzzleName(node, node.id)}" (${deviceId}).`, "info");
        }
    });
}

function forwardOutputToTargets(sourceNode, key, type, data) {
    if (!sourceNode || !sourceNode.outputs) return;
    if (!isDataKeyAllowed(key, type)) return;
    const links = graph.links || {};
    sourceNode.outputs.forEach((out, idx) => {
        const outName = out.name || `Output ${idx + 1}`;
        if (key && outName !== key) return;
        if (!isDataKeyAllowed(outName, out.type)) return;
        const linkIds = Array.isArray(out.links) ? out.links : (out.link !== undefined ? [out.link] : []);
        if (!linkIds) return;
        linkIds.forEach(linkId => {
            const link = links[linkId];
            if (!link) return;
              const targetNode = getPuzzleNodeById(link.target_id);
              if (!targetNode || targetNode.type !== "escape/Puzzle") return;
              if (targetNode.properties?.isAnalog) return; // analog puzzles are not device-driven
              const targetDevId = getDeviceIdForPuzzle(targetNode);
              if (!targetDevId) return;
              publishCommand(targetDevId, { action: "sendParam", key: key || outName, type: type || out.type || "string", data });
              logSystem(
                  `Data sent to "${getPuzzleName(targetNode, targetNode.id)}" (${key || outName}): ${JSON.stringify(data)}`,
                  "system"
              );
              clearInputFallbackUsage(targetNode.id, key || outName);
              clearPendingMediaFallback(targetNode.id, key || outName);
          });
      });
}

function seedInputsForPuzzle(targetNode) {
    if (!targetNode || targetNode.type !== "escape/Puzzle") return;
    if (targetNode.properties?.isAnalog) return;
    const targetDevId = getDeviceIdForPuzzle(targetNode);
    if (!targetDevId) return;

    const links = graph.links || {};
    const inputs = targetNode.inputs || [];
    inputs.forEach((input, idx) => {
        if (!input || ACTION_TYPES.has(input.type)) return;

        const linkIds = [];
        if (Array.isArray(input.links)) {
            input.links.forEach(l => { if (l !== null && l !== undefined && l !== -1) linkIds.push(l); });
        } else if (input.link !== null && input.link !== undefined && input.link !== -1) {
            linkIds.push(input.link);
        }
        if (!linkIds.length) return;

        let sentValue = false;
        for (const linkId of linkIds) {
            const link = links[linkId];
            if (!link) continue;
            const originNode = getPuzzleNodeById(link.origin_id);
            if (!originNode || originNode.type !== "escape/Puzzle") continue;
            const out = originNode.outputs && originNode.outputs[link.origin_slot];
            if (!out || ACTION_TYPES.has(out.type)) continue;
            const outName = out.name || `Output ${link.origin_slot + 1}`;
            const stored = puzzleDataStore[originNode.id]?.outputs?.[outName];
              if (stored && stored.data !== null && stored.data !== undefined) {
                  publishCommand(targetDevId, {
                      action: "sendParam",
                      key: outName,
                      type: stored.type || normalizeDataType(out.type),
                      data: stored.data
                  });
                  logSystem(
                      `Data sent to "${getPuzzleName(targetNode, targetNode.id)}" (${outName}): ${JSON.stringify(stored.data)}`,
                      "system"
                  );
                  sentValue = true;
                  break;
              }
        }
        if (sentValue) return;

        const fallbackRaw = getInputFallbackRaw(targetNode, input.name);
        if (fallbackRaw !== null && fallbackRaw !== undefined) {
            const parsed = parseFallbackValueForType(fallbackRaw, input.type);
            if (parsed.ok) {
                const inputType = normalizeDataType(input.type);
                if (inputType === "media") {
                    if (!isUpstreamSolvedForInput(targetNode, input.name)) return;
                    scheduleMediaInputFallback(targetNode, input.name, input.type, parsed.value);
                } else {
                    publishCommand(targetDevId, {
                        action: "sendParam",
                        key: input.name,
                        type: inputType,
                        data: parsed.value,
                        fallback: true
                    });
                    logSystem(
                        `Data sent to "${getPuzzleName(targetNode, targetNode.id)}" (${input.name}): ${JSON.stringify(parsed.value)}`,
                        "system"
                    );
                    recordInputFallbackUsage(targetNode.id, input.name, input.type, parsed.value);
                }
            }
            return;
        }

        for (const linkId of linkIds) {
            const link = links[linkId];
            if (!link) continue;
            const originNode = getPuzzleNodeById(link.origin_id);
            if (!originNode || originNode.type !== "escape/Puzzle") continue;
            const out = originNode.outputs && originNode.outputs[link.origin_slot];
            if (!out || ACTION_TYPES.has(out.type)) continue;
            const outName = out.name || `Output ${link.origin_slot + 1}`;
            const outFallbackRaw = getOutputFallbackRaw(originNode, outName);
            if (outFallbackRaw === null || outFallbackRaw === undefined) continue;
            const parsed = parseFallbackValueForType(outFallbackRaw, out.type);
            if (!parsed.ok) continue;
            const outType = normalizeDataType(out.type);
            if (outType === "media") {
                if (!isUpstreamSolvedForInput(targetNode, outName)) continue;
                scheduleMediaInputFallback(targetNode, outName, out.type, parsed.value);
                sentValue = true;
                break;
            }
            publishCommand(targetDevId, {
                action: "sendParam",
                key: outName,
                type: outType,
                data: parsed.value,
                fallback: true
            });
            logSystem(
                `Data sent to "${getPuzzleName(targetNode, targetNode.id)}" (${outName}): ${JSON.stringify(parsed.value)}`,
                "system"
            );
            sentValue = true;
            break;
        }
      });
  }

function getOutputTargets(node, outputIdx) {
    const links = graph.links || {};
    const out = node.outputs && node.outputs[outputIdx];
    if (!out) return [];
    const linkIds = Array.isArray(out.links) ? out.links : (out.link !== undefined ? [out.link] : []);
    const targets = [];
    linkIds.forEach(id => {
        const link = links[id];
        if (!link) return;
        const targetNode = graph.getNodeById ? graph.getNodeById(link.target_id) : getPuzzleNodeById(link.target_id);
        if (targetNode && targetNode.type === "escape/Puzzle") {
            targets.push(getPuzzleName(targetNode, targetNode.id));
        }
    });
    return targets;
}

function getInputLinkIds(targetNode) {
    if (!targetNode || !targetNode.inputs) return [];
    const ids = [];
    targetNode.inputs.forEach(inp => {
        if (!inp) return;
        if (Array.isArray(inp.links)) {
            inp.links.forEach(l => { if (l !== null && l !== undefined && l !== -1) ids.push(l); });
        } else if (inp.link !== null && inp.link !== undefined && inp.link !== -1) {
            ids.push(inp.link);
        }
    });
    return ids;
}

function getIncomingActionLinks(targetNode) {
    if (!targetNode) return [];
    const links = graph.links || {};
    return Object.values(links).filter(link => {
        if (!link || link.target_id !== targetNode.id) return false;
        const inp = targetNode.inputs && targetNode.inputs[link.target_slot];
        return inp && ACTION_TYPES.has(inp.type);
    });
}

function canActivatePuzzleFromActions(node) {
    if (!node || node.type !== "escape/Puzzle") return false;
    const actionLinks = getIncomingActionLinks(node);
    if (!actionLinks.length) return true;
    const origins = actionLinks
        .map(l => graph.getNodeById ? graph.getNodeById(l.origin_id) : getPuzzleNodeById(l.origin_id))
        .filter(Boolean);
    if (!origins.length) return false;
    return origins.every(origin => {
        if (origin.type === "escape/Start") return true;
        if (origin.type === "escape/Puzzle") {
            return puzzleStateDetails[origin.id]?.state === 'solved';
        }
        if (origin.type === "escape/Logic") {
            return isLogicNodeSatisfied(origin);
        }
        return false;
    });
}
function getQueueGroupInputs(queueNode) {
    if (!queueNode || !queueNode.inputs) return [];
    const inputs = [];
    queueNode.inputs.forEach((input, idx) => {
        if (!input) return;
        if (ACTION_TYPES.has(input.type)) return;
        inputs.push({ input, index: idx });
    });
    return inputs;
}
function getQueueTargetPuzzleIds(queueNode) {
    if (!queueNode || !queueNode.outputs) return [];
    const links = graph.links || {};
    const ids = new Set();
    for (let outIdx = 0; outIdx < queueNode.outputs.length; outIdx += 1) {
        const out = queueNode.outputs[outIdx];
        if (!out || !ACTION_TYPES.has(out.type)) continue;
        const linkIds = Array.isArray(out.links) ? out.links : (out.link !== undefined ? [out.link] : []);
        for (const linkId of linkIds) {
            const link = links[linkId];
            if (!link) continue;
            const targetNode = graph.getNodeById ? graph.getNodeById(link.target_id) : getPuzzleNodeById(link.target_id);
            if (targetNode && targetNode.type === "escape/Puzzle") {
                ids.add(targetNode.id);
            }
        }
    }
    return Array.from(ids);
}
function getQueueTargetPuzzleId(queueNode) {
    const ids = getQueueTargetPuzzleIds(queueNode);
    return ids.length ? ids[0] : null;
}
function isActionLink(originNode, targetNode, conn) {
    if (!originNode || !targetNode || !conn) return false;
    const out = originNode.outputs && originNode.outputs[conn.originSlot];
    if (!out || !ACTION_TYPES.has(out.type)) return false;
    const inp = targetNode.inputs && targetNode.inputs[conn.targetSlot];
    if (!inp || !ACTION_TYPES.has(inp.type)) return false;
    return true;
}
function collectDownstreamPuzzleIds(startNodeId) {
    const { adjacencyMap, allNodes } = getGraphIndex();
    const visited = new Set();
    const puzzleIds = new Set();
    const queue = [startNodeId];
    while (queue.length) {
        const current = queue.shift();
        if (visited.has(current)) continue;
        visited.add(current);
        const node = allNodes[current];
        if (!node) continue;
        if (node.type === "escape/Puzzle") {
            puzzleIds.add(node.id);
        }
        if (node.type === "escape/End") continue;
        if (node.type === "escape/Logic" && (node.properties?.logicType || "").toUpperCase() === "QUEUE") continue;
        const outgoing = adjacencyMap[current] || [];
        outgoing.forEach(conn => {
            const targetNode = allNodes[conn.targetId];
            if (!isActionLink(node, targetNode, conn)) return;
            queue.push(conn.targetId);
        });
    }
    return Array.from(puzzleIds);
}
function getQueueControlledPuzzleIds(queueNode) {
    const directTargets = getQueueTargetPuzzleIds(queueNode);
    const ids = new Set();
    directTargets.forEach(targetId => {
        const downstream = collectDownstreamPuzzleIds(targetId);
        const list = downstream.length ? downstream : [targetId];
        list.forEach(id => ids.add(id));
    });
    return Array.from(ids);
}
function buildQueuePayload(queueNode, originNode) {
    if (!queueNode || !originNode) return {};
    const payload = {};
    const links = graph.links || {};
    const groupInputs = getQueueGroupInputs(queueNode);
    groupInputs.forEach(({ input, index }) => {
        const linkIds = [];
        if (Array.isArray(input.links)) {
            input.links.forEach(l => { if (l !== null && l !== undefined && l !== -1) linkIds.push(l); });
        } else if (input.link !== null && input.link !== undefined && input.link !== -1) {
            linkIds.push(input.link);
        }
        for (const linkId of linkIds) {
            const link = links[linkId];
            if (!link || link.origin_id !== originNode.id) continue;
            const out = originNode.outputs && originNode.outputs[link.origin_slot];
            if (!out || ACTION_TYPES.has(out.type)) continue;
            const outName = out.name || `Output ${link.origin_slot + 1}`;
            const stored = getOutputDataForPuzzleOutput(originNode, outName, out.type);
            if (!stored) continue;
            payload[input.name] = { data: stored.data, type: stored.type || normalizeDataType(out.type) };
            break;
        }
    });
    return payload;
}
function sendQueuePayloadToTargets(queueNode, payload) {
    if (!queueNode || !queueNode.outputs) return;
    const links = graph.links || {};
    queueNode.outputs.forEach((out, idx) => {
        if (!out || ACTION_TYPES.has(out.type)) return;
        const entry = payload && payload[out.name];
        if (!entry) return;
        const linkIds = Array.isArray(out.links) ? out.links : (out.link !== undefined ? [out.link] : []);
        linkIds.forEach(linkId => {
            const link = links[linkId];
            if (!link) return;
            const targetNode = getPuzzleNodeById(link.target_id);
            if (!targetNode || targetNode.type !== "escape/Puzzle") return;
            if (targetNode.properties?.isAnalog) return;
            const targetDevId = getDeviceIdForPuzzle(targetNode);
            if (!targetDevId) return;
            const targetInput = targetNode.inputs && targetNode.inputs[link.target_slot];
            const key = targetInput?.name || out.name || `Input ${link.target_slot + 1}`;
            publishCommand(targetDevId, { action: "sendParam", key, type: entry.type || out.type || "string", data: entry.data });
            logSystem(
                `Queue data sent to "${getPuzzleName(targetNode, targetNode.id)}" (${key}): ${JSON.stringify(entry.data)}`,
                "system"
            );
            clearInputFallbackUsage(targetNode.id, key);
            clearPendingMediaFallback(targetNode.id, key);
        });
    });
}
function enqueueQueueEntry(queueNode, originNode) {
    if (!queueNode || !originNode) return;
    const branch = getBranchForPuzzle(originNode.id);
    const branchId = branch?.id;
    if (!Number.isFinite(branchId)) return;
    const state = getQueueState(queueNode.id);
    const exists = state.entries.some(e => e.puzzleId === originNode.id && e.branchId === branchId);
    if (exists) return;
    const payload = buildQueuePayload(queueNode, originNode);
    state.entries.push({ puzzleId: originNode.id, branchId, payload });
}
function isPuzzleFreeForQueue(puzzleId, branchId) {
    const current = puzzleStateDetails[puzzleId]?.state;
    if (['running', 'starting', 'active', 'uploading', 'downloading', 'solved', 'error'].includes(current)) return false;
    if (Number.isFinite(branchId) && branchSolvedState[branchId]) return false;
    const lock = puzzleQueueLocks[puzzleId];
    if (lock && Number.isFinite(lock.branchId) && lock.branchId !== branchId) return false;
    return true;
}
function processQueueNode(queueNode) {
    if (!queueNode) return;
    const targetPuzzleIds = getQueueTargetPuzzleIds(queueNode);
    if (!targetPuzzleIds.length) return;
    const state = getQueueState(queueNode.id);
    const now = Date.now();
    if (state.cooldownUntil && state.cooldownUntil > now) return;
    if (state.cooldownUntil && state.cooldownUntil <= now) state.cooldownUntil = null;
    if (!state.entries.length) return;
    const entry = state.entries[0];
    const requirements = new Map();
    const freeTargets = targetPuzzleIds.filter(targetId => {
        const required = collectDownstreamPuzzleIds(targetId);
        const requiredRaw = required.length ? required : [targetId];
        const requiredList = requiredRaw.filter(id => id === targetId || puzzleStateDetails[id]?.state !== 'locked');
        requirements.set(targetId, requiredList);
        return requiredList.every(reqId => isPuzzleFreeForQueue(reqId, entry.branchId));
    });
    if (!freeTargets.length) return;
    const activateAllFree = queueNode.properties?.queueActivateAllFree === true;
    if (activateAllFree && freeTargets.length !== targetPuzzleIds.length) return;
    const activateIds = activateAllFree
        ? freeTargets
        : [freeTargets[Math.floor(Math.random() * freeTargets.length)]];
    const requiredSet = new Set();
    activateIds.forEach(targetId => {
        const required = requirements.get(targetId) || [targetId];
        required.forEach(id => requiredSet.add(id));
    });
    state.entries.shift();
    state.active = {
        puzzleId: entry.puzzleId,
        branchId: entry.branchId,
        puzzleIds: activateIds.slice(),
        requiredPuzzleIds: Array.from(requiredSet)
    };
    if (!activateAllFree) {
        if (!queueBranchChoices[queueNode.id]) queueBranchChoices[queueNode.id] = {};
        queueBranchChoices[queueNode.id][entry.branchId] = {
            requiredPuzzleIds: Array.from(requiredSet),
            controlledPuzzleIds: getQueueControlledPuzzleIds(queueNode)
        };
    } else if (queueBranchChoices[queueNode.id]) {
        delete queueBranchChoices[queueNode.id][entry.branchId];
        if (!Object.keys(queueBranchChoices[queueNode.id]).length) {
            delete queueBranchChoices[queueNode.id];
        }
    }
    if (!queueSolvedState[entry.branchId]) queueSolvedState[entry.branchId] = {};
    Array.from(requiredSet).forEach(targetPuzzleId => {
        puzzleQueueLocks[targetPuzzleId] = { queueNodeId: queueNode.id, branchId: entry.branchId };
        delete queueSolvedState[entry.branchId][targetPuzzleId];
    });
    activateIds.forEach(targetPuzzleId => {
        applyPuzzleState(targetPuzzleId, 'active');
    });
    sendQueuePayloadToTargets(queueNode, entry.payload);
}
function scheduleQueueProcessing(queueNode) {
    if (!queueNode) return;
    const state = getQueueState(queueNode.id);
    if (!state.entries.length) {
        state.cooldownUntil = null;
        clearQueueTimer(queueNode.id);
        return;
    }
    const rawDelay = parseFloat(queueNode.properties?.queueDelaySec);
    const delaySec = Number.isFinite(rawDelay) && rawDelay > 0 ? rawDelay : 0;
    if (delaySec <= 0) {
        state.cooldownUntil = null;
        clearQueueTimer(queueNode.id);
        processQueueNode(queueNode);
        return;
    }
    const delayMs = Math.round(delaySec * 1000);
    state.cooldownUntil = Date.now() + delayMs;
    clearQueueTimer(queueNode.id);
    queueTimers[queueNode.id] = setTimeout(() => {
        const currentState = getQueueState(queueNode.id);
        currentState.cooldownUntil = null;
        processQueueNode(queueNode);
    }, delayMs);
}
function processAllQueues() {
    getQueueNodes().forEach(node => processQueueNode(node));
}
function clearQueueEntriesForBranch(branchId) {
    if (!Number.isFinite(branchId)) return;
    Object.keys(queueStates).forEach(queueId => {
        const state = queueStates[queueId];
        if (!state) return;
        state.entries = (state.entries || []).filter(entry => entry.branchId !== branchId);
        if (state.active && state.active.branchId === branchId) {
            state.active = null;
        }
    });
    Object.keys(queueBranchChoices).forEach(queueId => {
        if (queueBranchChoices[queueId]) {
            delete queueBranchChoices[queueId][branchId];
            if (!Object.keys(queueBranchChoices[queueId]).length) {
                delete queueBranchChoices[queueId];
            }
        }
    });
    Object.keys(puzzleQueueLocks).forEach(pid => {
        if (puzzleQueueLocks[pid]?.branchId === branchId) {
            delete puzzleQueueLocks[pid];
        }
    });
}
function getLinkedQueueNodesForPuzzle(node) {
    if (!node || !node.outputs) return [];
    const links = graph.links || {};
    const found = new Map();
    node.outputs.forEach((out, idx) => {
        if (!out || !ACTION_TYPES.has(out.type)) return;
        const linkIds = Array.isArray(out.links) ? out.links : (out.link !== undefined ? [out.link] : []);
        linkIds.forEach(linkId => {
            const link = links[linkId];
            if (!link) return;
            const targetNode = graph.getNodeById ? graph.getNodeById(link.target_id) : null;
            if (!targetNode || targetNode.type !== "escape/Logic") return;
            if ((targetNode.properties?.logicType || "").toUpperCase() !== "QUEUE") return;
            const targetInput = targetNode.inputs && targetNode.inputs[link.target_slot];
            if (!targetInput || !ACTION_TYPES.has(targetInput.type)) return;
            found.set(targetNode.id, targetNode);
        });
    });
    return Array.from(found.values());
}
function getLinkedEndBranchIdsForPuzzle(node) {
    if (!node || !node.outputs) return [];
    const links = graph.links || {};
    const branchIds = new Set();
    node.outputs.forEach(out => {
        if (!out || !ACTION_TYPES.has(out.type)) return;
        const linkIds = Array.isArray(out.links) ? out.links : (out.link !== undefined ? [out.link] : []);
        linkIds.forEach(linkId => {
            const link = links[linkId];
            if (!link) return;
            const targetNode = graph.getNodeById ? graph.getNodeById(link.target_id) : null;
            if (!targetNode || targetNode.type !== "escape/End") return;
            const branchId = Number(targetNode?.properties?.pairId);
            if (Number.isFinite(branchId) && branchId > 0) {
                branchIds.add(branchId);
            }
        });
    });
    return Array.from(branchIds);
}

function getLinkedOutputValueForInput(node, inputName) {
    if (!node || !inputName || !node.inputs) return null;
    const inputIdx = node.inputs.findIndex(inp => inp && inp.name === inputName);
    if (inputIdx === -1) return null;
    const input = node.inputs[inputIdx];
    const linkIds = [];
    if (Array.isArray(input.links)) {
        input.links.forEach(l => { if (l !== null && l !== undefined && l !== -1) linkIds.push(l); });
    } else if (input.link !== null && input.link !== undefined && input.link !== -1) {
        linkIds.push(input.link);
    }
    if (!linkIds.length) return null;
    const links = graph.links || {};
    for (const linkId of linkIds) {
        const link = links[linkId];
        if (!link) continue;
        const origin = graph.getNodeById ? graph.getNodeById(link.origin_id) : getPuzzleNodeById(link.origin_id);
        if (!origin || origin.type !== "escape/Puzzle") continue;
        const out = origin.outputs && origin.outputs[link.origin_slot];
        if (!out || ACTION_TYPES.has(out.type)) continue;
        const outName = out.name || `Output ${link.origin_slot + 1}`;
        const stored = puzzleDataStore[origin.id]?.outputs?.[outName];
        if (stored && stored.data !== null && stored.data !== undefined) {
            return { value: stored.data, type: stored.type || normalizeDataType(out.type), source: "output" };
        }
    }
    const inputFallbackRaw = getInputFallbackRaw(node, inputName);
    if (inputFallbackRaw !== null && inputFallbackRaw !== undefined) {
        return null;
    }
    for (const linkId of linkIds) {
        const link = links[linkId];
        if (!link) continue;
        const origin = graph.getNodeById ? graph.getNodeById(link.origin_id) : getPuzzleNodeById(link.origin_id);
        if (!origin || origin.type !== "escape/Puzzle") continue;
        const out = origin.outputs && origin.outputs[link.origin_slot];
        if (!out || ACTION_TYPES.has(out.type)) continue;
        const outName = out.name || `Output ${link.origin_slot + 1}`;
        const fallbackRaw = getOutputFallbackRaw(origin, outName);
        if (fallbackRaw === null || fallbackRaw === undefined) continue;
        const parsed = parseFallbackValueForType(fallbackRaw, out.type);
        if (!parsed.ok) continue;
        return { value: parsed.value, type: normalizeDataType(out.type), source: "output-fallback" };
    }
    return null;
}

function isUpstreamSolvedForInput(node, inputName) {
    if (!node || !inputName || !node.inputs) return false;
    const inputIdx = node.inputs.findIndex(inp => inp && inp.name === inputName);
    if (inputIdx === -1) return false;
    const input = node.inputs[inputIdx];
    const linkIds = [];
    if (Array.isArray(input.links)) {
        input.links.forEach(l => { if (l !== null && l !== undefined && l !== -1) linkIds.push(l); });
    } else if (input.link !== null && input.link !== undefined && input.link !== -1) {
        linkIds.push(input.link);
    }
    if (!linkIds.length) return false;
    const links = graph.links || {};
    const origins = linkIds.map(id => links[id]).filter(Boolean)
        .map(l => graph.getNodeById ? graph.getNodeById(l.origin_id) : getPuzzleNodeById(l.origin_id))
        .filter(Boolean);
    if (!origins.length) return false;
    return origins.every(origin => {
        if (origin.type === "escape/Puzzle") {
            return puzzleStateDetails[origin.id]?.state === 'solved';
        }
        if (origin.type === "escape/Logic") {
            return isLogicNodeSatisfied(origin);
        }
        return false;
    });
}

function isLogicNodeSatisfied(node, visited = new Set()) {
    if (!node) return false;
    if (visited.has(node.id)) return false;
    visited.add(node.id);
    const inputLinks = getIncomingActionLinks(node);
    if (!inputLinks.length) return false;
    const origins = inputLinks
        .map(l => graph.getNodeById ? graph.getNodeById(l.origin_id) : getPuzzleNodeById(l.origin_id))
        .filter(Boolean);
    if (!origins.length) return false;
    const logicType = (node.properties?.logicType || "AND").toUpperCase();
    if (logicType === "QUEUE") return false;
    const isSolvedOrigin = (origin) => {
        if (origin.type === "escape/Puzzle") {
            return puzzleStateDetails[origin.id]?.state === 'solved';
        }
        if (origin.type === "escape/Logic") {
            return isLogicNodeSatisfied(origin, visited);
        }
        return false;
    };
    if (logicType === "OR") {
        return origins.some(isSolvedOrigin);
    }
    // default AND
    return origins.every(isSolvedOrigin);
}

function activateReadyPuzzles() {
    const links = graph.links || {};
    const puzzles = getAllPuzzleNodes();
    puzzles.forEach(p => {
        const state = puzzleStateDetails[p.id]?.state;
        if (['running', 'starting', 'active', 'solved'].includes(state)) return;
        const inputLinks = getInputLinkIds(p).map(id => links[id]).filter(Boolean);
        if (!inputLinks.length) {
            applyPuzzleState(p.id, 'running');
            return;
        }
        let ready = true;
        for (const l of inputLinks) {
            const origin = graph.getNodeById ? graph.getNodeById(l.origin_id) : getPuzzleNodeById(l.origin_id);
            if (!origin) { ready = false; break; }
            if (origin.type === "escape/Puzzle") {
                if (puzzleStateDetails[origin.id]?.state !== 'solved') { ready = false; break; }
            } else if (origin.type === "escape/Logic") {
                if (!isLogicNodeSatisfied(origin)) { ready = false; break; }
            } else {
                ready = false; break;
            }
        }
        if (ready) {
            applyPuzzleState(p.id, 'running');
        }
    });
}

function normalizePuzzleState(state) {
    if (isValidPuzzleState(state)) return state;
    return 'locked';
}

function publishCommand(deviceId, payload = {}) {
    if (!deviceId) return;
    try {
        mqttClient.publish(`puzzle/${deviceId}/command`, JSON.stringify(payload));
    } catch (e) {
        console.error("MQTT publish failed:", e.message);
    }
}

function postToDevice(device, path, payload = {}) {
    if (!device || !device.ip) return;
    const data = Buffer.from(JSON.stringify(payload));
    const options = {
        host: device.ip,
        port: DEVICE_PORT,
        path,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': data.length
        },
        timeout: 1500
    };
    const req = http.request(options, res => {
        res.on('data', ()=>{});
    });
    req.on('error', ()=>{});
    req.write(data);
    req.end();
}

function applyPuzzleState(puzzleId, desiredState, note = null, options = { outbound: true }) {
    const desired = normalizePuzzleState(desiredState);
    const now = Date.now();
    const prevState = puzzleStateDetails[puzzleId]?.state || 'locked';
    const node = getPuzzleNodeById(puzzleId);
    const deviceId = node ? getDeviceIdForPuzzle(node) : null;
    const isAnalog = !!node?.properties?.isAnalog;
    const normalizedDesired = (isAnalog && desired === 'active') ? 'running' : desired;
    const canRestartDevice = node
        && options.outbound
        && ['active', 'running'].includes(normalizedDesired)
        && !['active', 'starting', 'running'].includes(prevState)
        && !isAnalog
        && canSendToDevice(node, deviceId);
    const state = (['active', 'running'].includes(normalizedDesired) && canRestartDevice) ? 'starting' : normalizedDesired;

    puzzleStateDetails[puzzleId] = {
        state,
        note: note || null,
        updatedAt: now
    };
    emitUpdate('puzzle-state', { puzzleId, state });

    if (state === 'solved') {
        const queueLock = puzzleQueueLocks[puzzleId] || null;
        if (!queueLock) {
            puzzleSolvedState[puzzleId] = true;
        } else {
            delete puzzleSolvedState[puzzleId];
            if (!queueSolvedState[queueLock.branchId]) queueSolvedState[queueLock.branchId] = {};
            queueSolvedState[queueLock.branchId][puzzleId] = true;
        }
        delete puzzleActivationState[puzzleId];
        delete restartRequestedAt[puzzleId];
        if (node) {
            const queueNodes = getLinkedQueueNodesForPuzzle(node);
            queueNodes.forEach(q => {
                enqueueQueueEntry(q, node);
                processQueueNode(q);
            });
            if (queueLock) {
                const queueState = getQueueState(queueLock.queueNodeId);
                let shouldSchedule = true;
                let shouldMarkBranchSolved = true;
                if (queueState && queueState.active && queueState.active.branchId === queueLock.branchId) {
                    const required = Array.isArray(queueState.active.requiredPuzzleIds)
                        ? queueState.active.requiredPuzzleIds
                        : [puzzleId];
                    const solvedMap = queueSolvedState[queueLock.branchId] || {};
                    const allSolved = required.every(id => solvedMap[id]);
                    if (allSolved) {
                        required.forEach(id => {
                            const lock = puzzleQueueLocks[id];
                            if (lock && lock.queueNodeId === queueLock.queueNodeId && lock.branchId === queueLock.branchId) {
                                delete puzzleQueueLocks[id];
                            }
                        });
                        queueState.active = null;
                    } else {
                        shouldSchedule = false;
                        shouldMarkBranchSolved = false;
                    }
                }
                if (shouldMarkBranchSolved) {
                    markBranchSolved(queueLock.branchId);
                }
                const queueNode = graph.getNodeById ? graph.getNodeById(queueLock.queueNodeId) : null;
                if (queueNode && shouldSchedule) scheduleQueueProcessing(queueNode);
            } else {
                const endBranchIds = getLinkedEndBranchIdsForPuzzle(node);
                endBranchIds.forEach(markBranchSolved);
            }
        }
        checkAutoRestartCondition();
        if (prevState !== 'solved') {
            activateReadyPuzzles();
        }
    } else {
        delete puzzleSolvedState[puzzleId];
        if (state === 'active' || state === 'starting' || state === 'running') {
            puzzleActivationState[puzzleId] = true;
        } else {
            delete puzzleActivationState[puzzleId];
        }
        if (state !== 'starting') {
            delete restartRequestedAt[puzzleId];
        }
    }

    if (node && ['active', 'running'].includes(desired) && !['active', 'starting', 'running'].includes(prevState)) {
        seedInputsForPuzzle(node);
    }

    if (options.outbound && node) {
        if (canSendToDevice(node, deviceId)) {
            if (canRestartDevice) {
                restartRequestedAt[puzzleId] = Date.now();
                publishCommand(deviceId, { action: "restart" });
            } else if (!['active', 'starting', 'running'].includes(state)) {
                publishCommand(deviceId, { action: "setState", state });
            }
        }
    }

    if (state === 'locked' || state === 'solved' || state === 'error') {
        if (externalCheckRuntime[puzzleId]) {
            externalCheckRuntime[puzzleId].active = false;
            externalCheckRuntime[puzzleId].updatedAt = Date.now();
        }
        clearHintTimers(puzzleId);
        if (state === 'locked' || state === 'solved') removeHintsForPuzzle(puzzleId);
    } else if (state === 'running' && prevState !== 'running') {
        scheduleHintTimers(node);
    }

    if (state === 'solved' && prevState !== 'solved') {
        schedulePendingOutputErrors(node);
    } else if (state !== 'solved' && prevState === 'solved') {
        clearPendingOutputErrors(puzzleId);
    }
}

function resetAllPuzzleStates(defaultState = 'locked', options = {}) {
    const { outbound = true, resetDevices = true } = options;
    puzzleSolvedState = {};
    puzzleActivationState = {};
    puzzleStateDetails = {};
    puzzleDataStore = {};
    puzzleInputFallbackStore = {};
    queueStates = {};
    queueSolvedState = {};
    queueBranchChoices = {};
    Object.keys(queueTimers).forEach(queueId => clearQueueTimer(queueId));
    queueTimers = {};
    puzzleQueueLocks = {};
    branchSolvedState = {};
    Object.keys(pendingMediaFallbackTimers).forEach(pid => {
        Object.values(pendingMediaFallbackTimers[pid] || {}).forEach(timerId => clearTimeout(timerId));
    });
    pendingMediaFallbackTimers = {};
    externalCheckRuntime = {};
    Object.keys(pendingOutputErrors).forEach(key => delete pendingOutputErrors[key]);
    Object.keys(offlineErrorState).forEach(key => delete offlineErrorState[key]);
    activeHintsByScreen = {};
    hintTimers = {};
    hintProgress = {};
    clearAllAutoRestartTimers();
    getAllPuzzleNodes().forEach(node => {
        const devId = getDeviceIdForPuzzle(node);
        if (resetDevices && canSendToDevice(node, devId)) {
            publishCommand(devId, { action: "clearData" });
        }
        removeHintsForPuzzle(node.id);
        applyPuzzleState(node.id, defaultState, null, { outbound });
    });
}

function resetPuzzleRuntimeState(puzzleId) {
    delete puzzleSolvedState[puzzleId];
    clearQueueSolvedForPuzzle(puzzleId);
    delete puzzleActivationState[puzzleId];
    delete puzzleStateDetails[puzzleId];
    delete puzzleDataStore[puzzleId];
    delete puzzleInputFallbackStore[puzzleId];
    delete puzzleQueueLocks[puzzleId];
    if (pendingMediaFallbackTimers[puzzleId]) {
        Object.values(pendingMediaFallbackTimers[puzzleId] || {}).forEach(timerId => clearTimeout(timerId));
        delete pendingMediaFallbackTimers[puzzleId];
    }
    delete externalCheckRuntime[puzzleId];
    delete pendingOutputErrors[puzzleId];
    delete offlineErrorState[puzzleId];
    delete puzzleTelemetry[puzzleId];
    clearHintTimers(puzzleId);
    removeHintsForPuzzle(puzzleId);
}

function getRoomStatusLabel() {
    if (!isRunning) return "Stopped";
    if (allPuzzlesSolved()) return "Solved";
    return "Running";
}

function getDeviceIdForPuzzle(node) {
    if (!node) return null;
    return node.properties?.selectedDeviceID || null;
}

function canSendToDevice(node, deviceId) {
    if (!node || node.properties?.isAnalog) return false;
    return !!deviceId;
}

function isDeviceOnline(deviceId) {
    if (!deviceId || !knownDevices[deviceId]) return false;
    return (Date.now() - (knownDevices[deviceId].lastSeen || 0)) < ONLINE_THRESHOLD_MS;
}

function getPuzzleStateRecord(puzzleId) {
    if (!puzzleStateDetails[puzzleId]) {
        puzzleStateDetails[puzzleId] = {
            state: 'locked',
            note: null,
            updatedAt: Date.now()
        };
    }
    return puzzleStateDetails[puzzleId];
}

function countOnlineDevices() {
    const now = Date.now();
    return Object.values(knownDevices).reduce((sum, device) => {
        if (!device) return sum;
        return sum + ((now - (device.lastSeen || 0) < ONLINE_THRESHOLD_MS) ? 1 : 0);
    }, 0);
}

function buildPuzzleStatusPayload(puzzleId) {
    const node = getPuzzleNodeById(puzzleId);
    if (!node) return null;
    const stateRecord = getPuzzleStateRecord(puzzleId);
    const deviceId = getDeviceIdForPuzzle(node);
    return {
        puzzleId,
        name: node.properties?.Name || node.title || `Puzzle ${puzzleId}`,
        state: stateRecord.state,
        note: stateRecord.note,
        lastUpdate: stateRecord.updatedAt,
        online: isDeviceOnline(deviceId),
        deviceId,
        telemetry: puzzleTelemetry[puzzleId] || null
    };
}

function getPuzzleName(node, fallbackId) {
    if (!node) return `Puzzle ${fallbackId}`;
    return node.properties?.Name || node.title || `Puzzle ${fallbackId}`;
}

function collectDeviceWarnings() {
    const warnings = [];
    getAllPuzzleNodes().forEach(node => {
        if (!node || node.properties?.isAnalog) return;
        const deviceId = getDeviceIdForPuzzle(node);
        const puzzleName = getPuzzleName(node, node?.id);
        if (!deviceId) {
            warnings.push(`${puzzleName}: no device assigned`);
            return;
        }
        if (!isDeviceOnline(deviceId)) {
            warnings.push(`${puzzleName}: device offline`);
        }
    });
    return warnings;
}

function collectDuplicateDeviceWarnings() {
    const warnings = [];
    const byDevice = {};
    getAllPuzzleNodes().forEach(node => {
        if (!node || node.properties?.isAnalog) return;
        const deviceId = getDeviceIdForPuzzle(node);
        if (!deviceId) return;
        if (!byDevice[deviceId]) byDevice[deviceId] = [];
        byDevice[deviceId].push(getPuzzleName(node, node?.id));
    });
    Object.entries(byDevice).forEach(([deviceId, puzzles]) => {
        if (puzzles.length > 1) {
            warnings.push(`Device "${deviceId}" linked to multiple puzzles: ${puzzles.join(", ")}`);
        }
    });
    return warnings;
}

function collectConnectionWarnings() {
    const warnings = [];
    if (!graph || !graph._nodes) return warnings;

    graph._nodes.forEach(node => {
        if (!node) return;
        const nodeName = node.title || `Node ${node.id}`;

        (node.inputs || []).forEach((input, idx) => {
            if (!input) return;
            if (node.type === "escape/Puzzle" && node.properties?.isAnalog && input.name === "Begin Flow") {
                return;
            }
            if (node.type === "escape/Puzzle" && input.name === "Trigger") {
                return;
            }
            const hasLinks = Array.isArray(input.links) ? input.links.length > 0 : !!(input.link !== null && input.link !== undefined && input.link !== -1);
            if (!hasLinks) {
                const label = input.name || `Input ${idx + 1}`;
                warnings.push(`${nodeName}: input "${label}" not connected`);
            }
        });

        (node.outputs || []).forEach((output, idx) => {
            if (!output) return;
            const hasLinks = Array.isArray(output.links) ? output.links.length > 0 : !!output.link;
            if (!hasLinks) {
                const label = output.name || `Output ${idx + 1}`;
                warnings.push(`${nodeName}: output "${label}" not connected`);
            }
        });
    });

    return warnings;
}

function collectExternalCheckWarnings() {
    const warnings = [];
    getAllPuzzleNodes().forEach(node => {
        if (!node) return;
        const screenId = node.properties?.externalScreenId;
        if (!screenId) return;
        const variable = (node.properties?.externalCheckVariable || "").toString().trim();
        if (!variable) {
            const puzzleName = getPuzzleName(node, node?.id);
            warnings.push(`${puzzleName}: external check variable missing`);
            return;
        }
        if (variable.startsWith("internal:")) {
            const name = variable.split(":", 2)[1] || "";
            const entry = node.properties?.internalVariables?.[name];
            let missingValue = !entry || entry.value === undefined || entry.value === null || String(entry.value) === "";
            if (!missingValue) {
                const parsed = parseFallbackValueForType(entry.value, entry.type);
                if (!parsed.ok) missingValue = true;
            }
            if (missingValue) {
                const puzzleName = getPuzzleName(node, node?.id);
                warnings.push(`${puzzleName}: internal player input "${name}" value missing`);
            }
        }
    });
    return warnings;
}

function collectAnalogOutputWarnings() {
    const warnings = [];
    getAllPuzzleNodes().forEach(node => {
        if (!node || !node.properties?.isAnalog) return;
        const outputs = node.outputs || [];
        outputs.forEach(out => {
            if (!out) return;
            if (out.name === "Done") return;
            if (ACTION_TYPES.has(out.type)) return;
            const key = out.name;
            const values = node.properties.outputValues || {};
            const entry = Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
            const val = entry && typeof entry === "object" && Object.prototype.hasOwnProperty.call(entry, "value")
                ? entry.value
                : entry;
            if (val === undefined || val === null || String(val) === "") {
                const puzzleName = getPuzzleName(node, node?.id);
                warnings.push(`${puzzleName}: output "${key}" value missing`);
            }
        });
    });
    return warnings;
}

function collectMediaServerWarnings() {
    const warnings = [];
    if (systemSettings.mediaServerEnabled) return warnings;
    const puzzles = getAllPuzzleNodes();
    puzzles.forEach(node => {
        if (!node) return;
        const inputs = node.inputs || [];
        const outputs = node.outputs || [];
        const hasMedia = inputs.some(inp => inp && normalizeDataType(inp.type) === "media")
            || outputs.some(out => out && normalizeDataType(out.type) === "media");
        if (hasMedia) {
            const puzzleName = getPuzzleName(node, node?.id);
            warnings.push(`${puzzleName}: media server is disabled`);
        }
    });
    return warnings;
}

function buildReadinessWarnings() {
    return [
        ...collectDeviceWarnings(),
        ...collectDuplicateDeviceWarnings(),
        ...collectConnectionWarnings(),
        ...collectExternalCheckWarnings(),
        ...collectMediaServerWarnings()
    ];
}

function isValidBranchId(id) {
    return Number.isFinite(id) && id > 0;
}

function getGraphIndex() {
    const links = graph.links || [];
    const adjacencyMap = {};
    links.forEach(link => {
        if (!adjacencyMap[link.origin_id]) adjacencyMap[link.origin_id] = [];
        adjacencyMap[link.origin_id].push({
            targetId: link.target_id,
            originSlot: link.origin_slot,
            targetSlot: link.target_slot
        });
    });
    const allNodes = {};
    (graph._nodes || []).forEach(node => {
        allNodes[node.id] = node;
    });
    return { adjacencyMap, allNodes };
}

function getNextDepthForFlow(currentNode, targetNode, currentDepth) {
    if (!targetNode) return currentDepth;
    if (targetNode.type === "escape/Puzzle") {
        if (!currentNode) return currentDepth;
        if (currentNode.type === "escape/Start") return 0;
        if (currentNode.type === "escape/Puzzle") return currentDepth + 1;
        if (currentNode.type === "escape/Logic") return currentDepth + 1;
        return currentDepth;
    }
    return currentDepth;
}

function createPuzzleFlowEntry(node, depth) {
    const hints = normalizeHints(node);
    const hintScreen = resolveHintScreen(node);
    const queue = getHintRuntimeQueue(node);
    const autoEnabled = node.properties?.automaticHintTrigger !== false;
    const externalScreenId = node.properties.externalScreenId || "";
    const externalScreen = externalScreenId ? findScreenById(externalScreenId) : null;
    const deviceId = node.properties.selectedDeviceID || null;
    const deviceInfo = deviceId ? knownDevices[deviceId] : null;
    return {
        id: node.id,
        name: node.properties.Name || node.title || "Unnamed Puzzle",
        description: "",
        depth: depth,
        isAnalog: node.properties.isAnalog || false,
        device: deviceId,
        deviceName: deviceInfo?.name || deviceInfo?.ip || deviceId,
        hintAvailable: !!(hintScreen && queue.length > 0),
        hintRemaining: queue.map(h => ({
            text: h.text || "",
            etaSec: autoEnabled && Number.isFinite(h.dueAt)
                ? Math.max(0, Math.ceil((h.dueAt - Date.now()) / 1000))
                : null
        })),
        showHintAssignment: node.properties?.showHintAssignment !== false,
        automaticHintTrigger: node.properties?.automaticHintTrigger !== false,
        hintScreenPath: hintScreen?.path || null,
        externalInputConfigured: !!externalScreenId,
        externalScreenName: externalScreen?.name || null
    };
}

function buildBranchFlowData() {
    if (!currentRoomName) return { branches: [], depthByNode: {}, adjacencyMap: {}, allNodes: {} };

    const startNodes = graph.findNodesByType("escape/Start") || [];
    const { adjacencyMap, allNodes } = getGraphIndex();
    const depthByNode = {};
    const branches = [];

    const sortedStarts = [...startNodes].sort((a, b) => {
        const aId = isValidBranchId(a?.properties?.pairId) ? a.properties.pairId : a.id;
        const bId = isValidBranchId(b?.properties?.pairId) ? b.properties.pairId : b.id;
        return aId - bId;
    });

    sortedStarts.forEach((startNode, idx) => {
        const branchId = isValidBranchId(startNode?.properties?.pairId) ? startNode.properties.pairId : (startNode.id || (idx + 1));
        const visited = new Set();
        const puzzles = [];

      function traverse(nodeId, depth = 0) {
          if (visited.has(nodeId)) return;
          visited.add(nodeId);

          const node = allNodes[nodeId];
          if (!node) return;

          if (depthByNode[node.id] === undefined || depth < depthByNode[node.id]) {
              depthByNode[node.id] = depth;
          }
          if (node.type === "escape/Puzzle") {
              puzzles.push(createPuzzleFlowEntry(node, depth));
          }

            if (adjacencyMap[nodeId]) {
                adjacencyMap[nodeId].forEach(conn => {
                    const targetNode = allNodes[conn.targetId];
                    const nextDepth = getNextDepthForFlow(node, targetNode, depth);
                    traverse(conn.targetId, nextDepth);
                });
            }
        }

        if (adjacencyMap[startNode.id]) {
            adjacencyMap[startNode.id].forEach(conn => {
                traverse(conn.targetId, 0);
            });
        }

        puzzles.sort((a, b) => {
            if (a.depth !== b.depth) return a.depth - b.depth;
            return a.id - b.id;
        });

      const puzzleIds = new Set(puzzles.map(p => p.id));
      const nodeIds = new Set(visited);
      branches.push({
          id: branchId,
          startId: startNode.id,
          puzzles,
          _puzzleIds: puzzleIds,
          _nodeIds: nodeIds
      });
    });

    const startPuzzles = (graph.findNodesByType("escape/Puzzle") || []).filter(node => node?.properties?.isStartNode);
    if (startPuzzles.length) {
        const computeDepthFromOutputs = (nodeId) => {
            const seen = new Set([nodeId]);
            const queue = [nodeId];
            let bestDepth = null;
            while (queue.length) {
                const current = queue.shift();
                const outgoing = adjacencyMap[current] || [];
                outgoing.forEach(conn => {
                    if (seen.has(conn.targetId)) return;
                    seen.add(conn.targetId);
                    const targetDepth = depthByNode[conn.targetId];
                    if (Number.isFinite(targetDepth)) {
                        bestDepth = bestDepth === null ? targetDepth : Math.min(bestDepth, targetDepth);
                        return;
                    }
                    queue.push(conn.targetId);
                });
            }
            return bestDepth !== null ? bestDepth : 0;
        };
        const canReachBranch = (startId, targetSet) => {
            if (!targetSet || !targetSet.size) return false;
            const seen = new Set([startId]);
            const queue = [startId];
            while (queue.length) {
                const current = queue.shift();
                const outgoing = adjacencyMap[current] || [];
                for (const conn of outgoing) {
                    const nextId = conn.targetId;
                    if (targetSet.has(nextId)) return true;
                    if (!seen.has(nextId)) {
                        seen.add(nextId);
                        queue.push(nextId);
                    }
                }
            }
            return false;
        };
        const pickNearestBranch = (node) => {
            if (branches.length === 1) return branches[0];
            const nodePos = Array.isArray(node?.pos) ? node.pos : [0, 0];
            let best = null;
            let bestDist = Infinity;
            branches.forEach(branch => {
                const startNode = allNodes[branch.startId];
                const startPos = Array.isArray(startNode?.pos) ? startNode.pos : null;
                if (!startPos) return;
                const dx = nodePos[0] - startPos[0];
                const dy = nodePos[1] - startPos[1];
                const dist = dx * dx + dy * dy;
                if (dist < bestDist) {
                    bestDist = dist;
                    best = branch;
                }
            });
            return best || branches[0];
        };

        startPuzzles.forEach(node => {
            const alreadyAssigned = branches.some(branch => branch._puzzleIds && branch._puzzleIds.has(node.id));
            if (alreadyAssigned) return;
            let targetBranch = null;
            for (const branch of branches) {
                if (canReachBranch(node.id, branch._nodeIds)) {
                    targetBranch = branch;
                    break;
                }
            }
            if (!targetBranch && branches.length) {
                targetBranch = pickNearestBranch(node);
            }
            if (!targetBranch) return;
            const depth = computeDepthFromOutputs(node.id);
            targetBranch.puzzles.push(createPuzzleFlowEntry(node, depth));
            if (targetBranch._puzzleIds) targetBranch._puzzleIds.add(node.id);
            if (depthByNode[node.id] === undefined || depthByNode[node.id] > depth) {
                depthByNode[node.id] = depth;
            }
            targetBranch.puzzles.sort((a, b) => {
                if (a.depth !== b.depth) return a.depth - b.depth;
                return a.id - b.id;
            });
        });
    }

    branches.forEach(branch => { delete branch._puzzleIds; delete branch._nodeIds; });
    return { branches, depthByNode, adjacencyMap, allNodes };
}

function buildPuzzleFlowData() {
    if (!currentRoomName) return { puzzles: [], error: "No active room" };

    try {
        const puzzleNodes = graph.findNodesByType("escape/Puzzle");
        const { branches, depthByNode, adjacencyMap, allNodes } = buildBranchFlowData();
        const puzzleMap = new Map();
        branches.forEach(branch => {
            (branch.puzzles || []).forEach(p => {
                const existing = puzzleMap.get(p.id);
                if (!existing || p.depth < existing.depth) {
                    puzzleMap.set(p.id, p);
                }
            });
        });
        const computeDepthFromOutputs = (nodeId) => {
            const seen = new Set([nodeId]);
            const queue = [nodeId];
            let bestDepth = null;
            while (queue.length) {
                const current = queue.shift();
                const outgoing = adjacencyMap[current] || [];
                outgoing.forEach(conn => {
                    if (seen.has(conn.targetId)) return;
                    seen.add(conn.targetId);
                    const targetDepth = depthByNode[conn.targetId];
                    if (Number.isFinite(targetDepth)) {
                        bestDepth = bestDepth === null ? targetDepth : Math.min(bestDepth, targetDepth);
                        return;
                    }
                    queue.push(conn.targetId);
                });
            }
            return bestDepth !== null ? bestDepth : 0;
        };
        if (puzzleNodes && puzzleNodes.length > 0) {
            puzzleNodes.forEach(node => {
                if (!node || puzzleMap.has(node.id)) return;
                const depth = computeDepthFromOutputs(node.id);
                puzzleMap.set(node.id, createPuzzleFlowEntry(node, depth));
            });
        }

        const puzzleOrder = Array.from(puzzleMap.values()).sort((a, b) => {
            if (a.depth !== b.depth) return a.depth - b.depth;
            return a.id - b.id;
        });

        return { puzzles: puzzleOrder, branches, error: null };
    } catch (e) {
        return { puzzles: [], error: e.message };
    }
}
function buildQueueingMap() {
    const result = {};
    getQueueNodes().forEach(queueNode => {
        const targetPuzzleIds = getQueueTargetPuzzleIds(queueNode);
        if (!targetPuzzleIds.length) return;
        const state = getQueueState(queueNode.id);
        (state.entries || []).forEach(entry => {
            if (!Number.isFinite(entry.branchId)) return;
            if (!result[entry.branchId]) result[entry.branchId] = {};
            targetPuzzleIds.forEach(pid => { result[entry.branchId][pid] = true; });
        });
    });
    return result;
}
function buildQueueTargetMap() {
    const map = {};
    getQueueNodes().forEach(queueNode => {
        const targetPuzzleIds = getQueueTargetPuzzleIds(queueNode);
        targetPuzzleIds.forEach(pid => { map[pid] = true; });
    });
    return map;
}
function buildQueueControlledMap() {
    const map = {};
    getQueueNodes().forEach(queueNode => {
        const controlledIds = getQueueControlledPuzzleIds(queueNode);
        controlledIds.forEach(pid => { map[pid] = true; });
    });
    return map;
}
function buildQueueChoiceMaps() {
    const blockedMap = {};
    const chosenMap = {};
    Object.entries(queueBranchChoices).forEach(([queueId, branchChoices]) => {
        if (!branchChoices) return;
        const queueNodeId = parseInt(queueId, 10);
        if (!Number.isFinite(queueNodeId)) return;
        Object.entries(branchChoices).forEach(([branchIdRaw, choice]) => {
            const branchId = parseInt(branchIdRaw, 10);
            if (!Number.isFinite(branchId)) return;
            const required = Array.isArray(choice?.requiredPuzzleIds) ? choice.requiredPuzzleIds : [];
            const controlled = Array.isArray(choice?.controlledPuzzleIds) ? choice.controlledPuzzleIds : [];
            if (!required.length || !controlled.length) return;
            if (!blockedMap[branchId]) blockedMap[branchId] = {};
            if (!chosenMap[branchId]) chosenMap[branchId] = {};
            controlled.forEach(pid => {
                if (required.includes(pid)) {
                    chosenMap[branchId][pid] = true;
                    return;
                }
                blockedMap[branchId][pid] = true;
            });
        });
    });
    return { blockedMap, chosenMap };
}
function buildQueueActiveMap() {
    const map = {};
    Object.keys(puzzleQueueLocks).forEach(puzzleId => {
        const lock = puzzleQueueLocks[puzzleId];
        const targetId = parseInt(puzzleId, 10);
        if (!Number.isFinite(targetId)) return;
        if (!lock || !Number.isFinite(lock.branchId)) return;
        map[targetId] = lock.branchId;
    });
    return map;
}
function buildQueueSolvedMap() {
    const map = {};
    Object.keys(queueSolvedState).forEach(branchId => {
        const entries = queueSolvedState[branchId];
        if (!entries) return;
        map[branchId] = Object.keys(entries).reduce((acc, puzzleId) => {
            if (entries[puzzleId]) acc[puzzleId] = true;
            return acc;
        }, {});
    });
    return map;
}

function buildInitialPuzzleStates(options = {}) {
    const activateFirstDepth = options.activateFirstDepth !== false;
    const flowData = buildPuzzleFlowData();
    const puzzles = flowData.puzzles || [];
    if (!puzzles.length) return {};

    const minDepth = puzzles.reduce((min, p) => Math.min(min, p.depth || 0), Infinity);
    if (!Number.isFinite(minDepth)) return {};

    const result = {};
    puzzles.forEach(puzzle => {
        const node = getPuzzleNodeById(puzzle.id);
        if (!node) return;
        const devId = getDeviceIdForPuzzle(node);
        const isOnline = node.properties?.isAnalog || isDeviceOnline(devId);

        if (!isOnline) {
            result[puzzle.id] = 'locked';
            return;
        }

        if (node.properties?.isStartNode) {
            result[puzzle.id] = 'running';
        } else if (activateFirstDepth && (puzzle.depth || 0) === minDepth) {
            result[puzzle.id] = 'active';
        } else {
            result[puzzle.id] = 'locked';
        }
    });
    return result;
}

function initializePuzzleStatesOnStart(options = {}) {
    const desiredStates = buildInitialPuzzleStates(options);
    Object.entries(desiredStates).forEach(([puzzleId, state]) => {
        applyPuzzleState(parseInt(puzzleId, 10), state);
    });
}

function beginRoomRestart(options = {}) {
    clearAllAutoRestartTimers();
    const triggerStartNodes = options.triggerStartNodes !== false;
    const activateFirstDepth = options.activateFirstDepth !== false;

    suppressDeviceStateUntil = Date.now() + 1500;

    resetAllPuzzleStates('locked', { outbound: false, resetDevices: false });
    puzzleTelemetry = {};
    gameStartTime = null;
    branchStartTimes = {};
    isRunning = false;

    primeDataStoreWithOutputs();
    getAllPuzzleNodes().forEach(node => {
        const devId = getDeviceIdForPuzzle(node);
        const io = collectIOKeys(node);
        if (canSendToDevice(node, devId)) {
            publishCommand(devId, { action: "clearData" });
            publishCommand(devId, { action: "initKeys", inputs: io.inputs, outputs: io.outputs });
        }
    });

    const desiredStates = buildInitialPuzzleStates({ activateFirstDepth });
    Object.entries(desiredStates).forEach(([puzzleId, state]) => {
        applyPuzzleState(parseInt(puzzleId, 10), state);
    });

    suppressDeviceStateUntil = 0;
    gameStartTime = Date.now();
    const flowData = buildBranchFlowData();
    branchStartTimes = {};
    (flowData.branches || []).forEach(branch => {
        branchStartTimes[branch.id] = gameStartTime;
    });
    isRunning = true;
    if (triggerStartNodes) {
        (graph.findNodesByType("escape/Start") || []).forEach(n => n.triggerSlot(0));
    }
    logSystem("Room restart completed.", "success");
    emitUpdate('room-restart');
    return { success: true, status: "running" };
}

// Template für neue Räume (MIT REMOVABLE: FALSE FLAGS)
const EMPTY_ROOM_TEMPLATE = {
    "last_node_id": 2,
    "last_link_id": 0,
    "nodes": [
        {
            "id": 1,
            "type": "escape/Start",
            "pos": [50, 200],
            "size": [140, 30],
            "flags": { "removable": false },
            "order": 0,
            "mode": 0,
            "outputs": [
                { "name": "Start Flow", "type": -1, "links": null }
            ],
            "properties": {}
        },
        {
            "id": 2,
            "type": "escape/End",
            "pos": [800, 200],
            "size": [140, 30],
            "flags": { "removable": false },
            "order": 1,
            "mode": 0,
            "inputs": [
                { "name": "Finish", "type": -1, "link": null }
            ],
            "properties": { "autoRestart": false, "restartDelay": 5 }
        }
    ],
    "links": [],
    "groups": [],
    "config": {},
    "version": 0.4
};

const systemLogs = [];
const SYSTEM_LOG_TTL_MS = 10 * 60 * 1000;
function pruneSystemLogs(now = Date.now()) {
    while (systemLogs.length && (now - (systemLogs[systemLogs.length - 1].ts || 0)) > SYSTEM_LOG_TTL_MS) {
        systemLogs.pop();
    }
}
function logSystem(msg, type = "info", meta = null) {
    const now = Date.now();
    const timestamp = new Date(now).toLocaleTimeString();
    systemLogs.unshift({ timestamp, type, msg, ts: now, meta });
    pruneSystemLogs(now);
    console.log(`[${type.toUpperCase()}] ${msg}`);
}

logSystem("Server started.", "success");

// --- INIT SYSTEM ---
async function initSystem() {
    try {
        await loadSystemSettings();
    } catch (err) {
        console.error('System settings initialisation failed:', err);
    }
    try {
        await ensureMediaStorageDir();
    } catch (err) {
        console.error('MediaStorage initialisation failed:', err);
    }
    try {
        const rows = await db.all("SELECT * FROM devices");
        rows.forEach(row => {
            knownDevices[row.id] = { id: row.id, name: row.name, ip: row.ip, lastSeen: row.last_seen };
        });
        logSystem(`${rows.length} known devices loaded.`, "info");
    } catch (e) { console.error(e); }

    try {
        const row = await db.get("SELECT value FROM config WHERE key = 'active_room'");
        if (row && row.value) {
            await loadRoomFromDB(row.value);
        } else {
            logSystem("No active room. Waiting for selection.", "info");
            currentRoomName = null;
        }
    } catch (e) {
        currentRoomName = null;
    }
}

async function loadRoomFromDB(roomName) {
    try {
        const row = await db.get("SELECT json_data FROM rooms WHERE name = ?", [roomName]);
        
        if (row) {
            currentRoomName = roomName;
            await db.run("INSERT OR REPLACE INTO config (key, value) VALUES ('active_room', ?)", [roomName]);
            
            try {
                const data = JSON.parse(row.json_data);
                graph.clear();
                graph.configure(data);
                primeDataStoreWithOutputs();
                
                // Add callback for puzzle activation tracking
                graph.onPuzzleActivated = (puzzleId) => {
                    const node = getPuzzleNodeById(puzzleId);
                    if (!node) return;
                    if (!canActivatePuzzleFromActions(node)) return;
                    applyPuzzleState(puzzleId, 'active');
                };
                
                graph.start();
                // When loading a room do NOT start it automatically; wait for operator
                isRunning = false;
                // Reset puzzle states when loading a room
                resetAllPuzzleStates('locked');
                puzzleTelemetry = {};
                gameStartTime = null;
                logSystem(`Room loaded (waiting to start): ${roomName}`, "success");
                return true;
            } catch (jsonErr) {
                logSystem(`JSON invalid in ${roomName}.`, "error");
                return false;
            }
        } else {
            logSystem(`Room '${roomName}' not found.`, "error");
            currentRoomName = null;
            return false;
        }
    } catch (e) { return false; }
}

initSystem();
setInterval(() => {
    checkHeartbeatErrors();
    checkPendingOutputErrors();
}, 1000);

module.exports = {
    getLogs: () => {
        pruneSystemLogs();
        return systemLogs;
    },
    getDevices: () => knownDevices,
    getCurrentRoomName: () => currentRoomName,
    getScreens: () => getScreensConfig(),
    findScreenByPath: (pathStr) => findScreenByPath(pathStr),
    getSystemSettings: () => getSystemSettings(),
    setMqttPort,
    setMediaServerEnabled,
    setAutostartEnabled,
    setScreenSaverImage,
    setVictoryScreen,
    getHintsForScreen: (screenKey) => {
        const key = sanitizeScreenPath(screenKey || "", "");
        let screen = key ? findScreenByPath(key) : null;
        if (!screen) {
            const candidates = getScreensConfig().filter(s => (s.role || "player") === "hint");
            screen = candidates.length ? candidates[0] : null;
        }
        if (!screen) return { success: false, error: "No hint screen configured", hints: [] };
        if ((screen.role || "player") !== "hint") return { success: false, error: "Screen is not a hint screen", hints: [] };
        const pathKey = sanitizeScreenPath(screen.path || "", `screen-${screen.id}`);
        const hints = (activeHintsByScreen[pathKey] || []).map(h => ({
            ...h,
            showAssignment: h.showAssignment !== false
        }));
        return { success: true, screenName: screen.name || pathKey, hints };
    },
    getExternalChecksForScreen: async (screenKey) => {
        const slug = sanitizeScreenPath(screenKey || "", "");
        const screen = slug ? findScreenByPath(slug) : null;
        if (!screen) {
            return { success: false, error: "Screen not found", exists: false };
        }
        if ((screen.role || "player") !== "player") {
            return { success: false, error: "Screen is not a player input screen", exists: true, role: screen.role || "hint" };
        }

        const puzzles = await collectExternalChecksForScreen(screen);
        const totalPuzzles = getAllPuzzleNodes().length;
        const solvedCount = Object.values(puzzleSolvedState).filter(Boolean).length;
        const room = {
            running: isRunning,
            total: totalPuzzles,
            solved: solvedCount,
            active: Object.keys(puzzleActivationState).length,
            solvedAll: totalPuzzles > 0 && solvedCount >= totalPuzzles
        };

        return {
            success: true,
            screen: { id: screen.id, name: screen.name, path: screen.path, role: screen.role || "player" },
            puzzles,
            settings: { screenSaver: systemSettings.screenSaverImage || null, victoryScreen: systemSettings.victoryScreen || null },
            room
        };
    },
    submitExternalPlayerInput: async (screenKey, puzzleId, answerRaw) => {
        const slug = sanitizeScreenPath(screenKey || "", "");
        const screen = slug ? findScreenByPath(slug) : null;
        if (!screen) return { success: false, error: "Screen not found", code: "SCREEN_NOT_FOUND" };
        if ((screen.role || "player") !== "player") {
            return { success: false, error: "Screen is not a player input screen", code: "INVALID_SCREEN" };
        }

        const numericId = parseInt(puzzleId, 10);
        if (!Number.isFinite(numericId)) return { success: false, error: "Invalid puzzleId", code: "INVALID_PUZZLE" };

        const node = getPuzzleNodeById(numericId);
        if (!node || String(node.properties?.externalScreenId || "") !== String(screen.id)) {
            return { success: false, error: "Puzzle not linked to this screen", code: "NOT_ASSIGNED" };
        }

        const stateKey = getPuzzleStateKey(numericId);
        if (!isExternalCheckActive(node, stateKey)) {
            return { success: false, error: "External check is not active", code: "NOT_ACTIVE", state: stateKey };
        }

        const { value } = await resolveExternalCheckValue(node);
        const expected = value === undefined || value === null ? "" : String(value).trim();
        if (!expected) {
            return { success: false, error: "No solution defined", code: "NO_SOLUTION" };
        }

        const submitted = (answerRaw === undefined || answerRaw === null) ? "" : String(answerRaw).trim();
        const correct = submitted === expected;

        logSystem(`Player Input (${screen.name || screen.path || slug}) for "${getPuzzleName(node, numericId)}"- Eingabe: "${submitted}" => ${correct ? "richtig" : "falsch"}`, "system");

        if (correct) {
            applyPuzzleState(numericId, 'solved');
            if (node.setSolved) node.setSolved();
            checkAutoRestartCondition();
        }

        return {
            success: true,
            correct,
            puzzleId: numericId,
            state: puzzleStateDetails[numericId]?.state || 'locked',
            expectedLength: expected.length
        };
    },
    validateRoomReadiness: () => {
        const warnings = buildReadinessWarnings();
        return { warnings, ok: warnings.length === 0 };
    },
    clearLogs: () => {
        systemLogs.length = 0;
        return { success: true };
    },

    getRoomList: async () => {
        try {
            const rows = await db.all("SELECT name FROM rooms ORDER BY name ASC");
            return rows.map(r => r.name);
        } catch (e) { return []; }
    },

    switchRoom: (name) => {
        try { module.exports.resetRoom(); } catch (e) { /* ignore */ }
        loadRoomFromDB(name);
    },

    createRoom: async (name) => {
        try {
            const jsonStr = JSON.stringify(EMPTY_ROOM_TEMPLATE);
            await db.run("INSERT INTO rooms (name, json_data) VALUES (?, ?)", [name, jsonStr]);
            return true;
        } catch (e) { return false; }
    },

    renameRoom: async (oldName, newName) => {
        try {
            await db.run("UPDATE rooms SET name = ? WHERE name = ?", [newName, oldName]);
            if (currentRoomName === oldName) {
                currentRoomName = newName;
                await db.run("INSERT OR REPLACE INTO config (key, value) VALUES ('active_room', ?)", [newName]);
            }
            return true;
        } catch (e) { return false; }
    },

    deleteRoom: async (name) => {
        try {
            await db.run("DELETE FROM rooms WHERE name = ?", [name]);
            
            if (currentRoomName === name) {
                try { module.exports.resetRoom(); } catch (e) { /* ignore */ }
                currentRoomName = null;
                graph.clear();
                graph.stop();
                isRunning = false;
                await db.run("DELETE FROM config WHERE key = 'active_room'");
                logSystem("Active room deleted.", "warn");
            }
            return true;
        } catch (e) { return false; }
    },

    updateGraph: async (json) => {
        if (!currentRoomName) return false;
        try {
            const jsonStr = JSON.stringify(json);
            // 1. In DB speichern
            await db.run("UPDATE rooms SET json_data = ? WHERE name = ?", [jsonStr, currentRoomName]);
            
            // 2. WICHTIG: Live-Graphen im RAM aktualisieren!
            graph.configure(json);
            emitUpdate('room-config');
            return true;
        } catch (e) { return false; }
    },

    updateHintSettings: async (puzzleId, settings = {}) => {
        const numericId = parseInt(puzzleId, 10);
        if (!Number.isFinite(numericId)) return { success: false, error: "puzzleId required" };
        const node = getPuzzleNodeById(numericId);
        if (!node) return { success: false, error: "Puzzle not found" };
        if (typeof settings.showHintAssignment === "boolean") {
            node.properties.showHintAssignment = settings.showHintAssignment;
        }
        if (typeof settings.automaticHintTrigger === "boolean") {
            node.properties.automaticHintTrigger = settings.automaticHintTrigger;
        }
        scheduleHintTimers(node);
        if (!currentRoomName) return { success: true };
        try {
            const jsonStr = JSON.stringify(graph.serialize());
            await db.run("UPDATE rooms SET json_data = ? WHERE name = ?", [jsonStr, currentRoomName]);
            emitUpdate('hints', { puzzleId: numericId });
            return { success: true };
        } catch (e) {
            return { success: false, error: "Failed to save hint settings" };
        }
    },

    updateRemainingHints: async (puzzleId, payload = {}) => {
        const numericId = parseInt(puzzleId, 10);
        if (!Number.isFinite(numericId)) return { success: false, error: "puzzleId required" };
        const node = getPuzzleNodeById(numericId);
        if (!node) return { success: false, error: "Puzzle not found" };
        const queue = getHintRuntimeQueue(node);
        const remainingCount = queue.length;
        const index = parseInt(payload.index, 10);
        if (!Number.isFinite(index) || index < 0 || index >= remainingCount) {
            return { success: false, error: "Invalid hint index" };
        }
        const action = (payload.action || "").toString().toLowerCase();
        if (action === "move_up") {
            if (index === 0) return { success: true };
            const swapIndex = index - 1;
            const tmpText = queue[swapIndex]?.text;
            queue[swapIndex].text = queue[index]?.text || "";
            queue[index].text = tmpText || "";
        } else if (action === "move_down") {
            if (index >= remainingCount - 1) return { success: true };
            const swapIndex = index + 1;
            const tmpText = queue[swapIndex]?.text;
            queue[swapIndex].text = queue[index]?.text || "";
            queue[index].text = tmpText || "";
        } else if (action === "delete") {
            queue.splice(index, 1);
            syncHintProgress(node);
        } else if (action === "send") {
            const text = queue[index]?.text || "";
            if (!text.trim()) return { success: false, error: "Hint text missing" };
            const result = triggerCustomHint(numericId, text, { showAssignment: node.properties?.showHintAssignment !== false });
            if (!result.success) return result;
            queue.splice(index, 1);
            syncHintProgress(node);
        } else {
            return { success: false, error: "Unknown action" };
        }

        scheduleHintTimers(node);
        emitUpdate('hints', { puzzleId: numericId });
        return { success: true };
    },

    getEventEmitter: () => eventBus,

    removeDevice: async (id) => {
        if (knownDevices[id]) delete knownDevices[id];
        await db.run("DELETE FROM devices WHERE id = ?", [id]);
        return true;
    },

    startGame: (options = {}) => {
        const result = beginRoomRestart(options);
        if (!result.success) {
            logSystem(result.error || "Restart already in progress", "warn");
        }
        return result;
    },

    restartRoom: (options = {}) => {
        return beginRoomRestart(options);
    },

    restartBranch: (options = {}) => {
        const branchId = Number(options.branchId);
        if (!Number.isFinite(branchId)) {
            return { success: false, error: "branchId required" };
        }

        const flowData = buildBranchFlowData();
        const branch = (flowData.branches || []).find(b => b.id === branchId);
        if (!branch) {
            return { success: false, error: "Branch not found" };
        }

      if (autoRestartTimers.has(branchId)) {
          clearTimeout(autoRestartTimers.get(branchId));
          autoRestartTimers.delete(branchId);
      }
      delete branchSolvedState[branchId];
      clearQueueSolvedForBranch(branchId);
      clearQueueEntriesForBranch(branchId);

      const puzzleIds = (branch.puzzles || []).map(p => p.id);
      puzzleIds.forEach(puzzleId => {
          const node = getPuzzleNodeById(puzzleId);
          const isQueueTarget = isQueueTargetPuzzleId(puzzleId);
          const queueLock = puzzleQueueLocks[puzzleId];
          const lockedForOtherBranch = isQueueTarget && queueLock && queueLock.branchId !== branchId;
          if (lockedForOtherBranch) {
              return;
          }
          if (isQueueTarget) {
              if (queueLock && queueLock.branchId === branchId) {
                  const queueState = getQueueState(queueLock.queueNodeId);
                  if (queueState && queueState.active && queueState.active.branchId === branchId) {
                      queueState.active = null;
                  }
                  delete puzzleQueueLocks[puzzleId];
              }
              applyPuzzleState(puzzleId, 'locked');
              clearQueueSolvedForBranch(branchId);
              getQueueNodesForTargetPuzzle(puzzleId).forEach(queueNode => scheduleQueueProcessing(queueNode));
              return;
          }
          resetPuzzleRuntimeState(puzzleId);
          if (node) {
              const devId = getDeviceIdForPuzzle(node);
              const io = collectIOKeys(node);
              if (canSendToDevice(node, devId)) {
                  publishCommand(devId, { action: "clearData" });
                  publishCommand(devId, { action: "initKeys", inputs: io.inputs, outputs: io.outputs });
              }
          }
      });

        const minDepth = (branch.puzzles || []).reduce((min, p) => Math.min(min, p.depth || 0), Infinity);
        (branch.puzzles || []).forEach(p => {
            if (isQueueTargetPuzzleId(p.id)) return;
            const state = Number.isFinite(minDepth) && (p.depth || 0) === minDepth ? 'active' : 'locked';
            applyPuzzleState(p.id, state);
        });

        const startNode = (graph.findNodesByType("escape/Start") || []).find(n => n.id === branch.startId);
        if (startNode) {
            startNode.triggerSlot(0);
        }

        branchStartTimes[branchId] = Date.now();
        logSystem(`Branch ${branchId} restarted.`, "info");
        emitUpdate('branch-restart', { branchId });
        return { success: true };
    },

    getPuzzleStatuses: () => {
        const statusList = {};
        const puzzleNodes = getAllPuzzleNodes();
        puzzleNodes.forEach(node => {
            const devId = getDeviceIdForPuzzle(node);
            const stateRecord = getPuzzleStateRecord(node.id);
        const stateKey = getPuzzleStateKey(node.id);
        const checking = isExternalCheckActive(node, stateKey);
        const isActive = ['active', 'starting', 'running', 'uploading', 'downloading'].includes(stateKey);
            statusList[node.id] = { 
                online: isDeviceOnline(devId),
                solved: stateRecord.state === 'solved' || !!puzzleSolvedState[node.id],
                active: isActive || !!puzzleActivationState[node.id],
                state: stateRecord.state,
                note: stateRecord.note,
                updatedAt: stateRecord.updatedAt,
                checking,
                externalInputActive: checking
            };
        });
        return statusList;
    },

    getDataSnapshot: () => {
        const inputMap = {};
        const links = graph.links || {};
        const nodes = getAllPuzzleNodes();
        const addOutputEntry = (origin, out, outName, inputName, targetNode) => {
            const owner = targetNode || origin;
            const ownerId = owner.id;
            const originSolved = puzzleStateDetails[origin.id]?.state === 'solved' || !!puzzleSolvedState[origin.id];
            const originState = getPuzzleStateKey(origin.id);
            const stored = puzzleDataStore[origin.id]?.outputs?.[outName];
            const inputFallback = puzzleInputFallbackStore[targetNode.id]?.inputs?.[inputName];
            const hasStored = !!(stored && Object.prototype.hasOwnProperty.call(stored, "data") && stored.data !== null && stored.data !== undefined);
            const outputFallbackRaw = hasStored ? null : getOutputFallbackRaw(origin, outName);
            const outputFallbackParsed = hasStored ? null : parseFallbackValueForType(outputFallbackRaw, out.type);
            const outputFallback = outputFallbackParsed && outputFallbackParsed.ok ? outputFallbackParsed : null;
            const useInputFallback = !hasStored && !!inputFallback;
            const useOutputFallback = !hasStored && !inputFallback && !!outputFallback;
            const analogUnsolved = origin.properties?.isAnalog && !originSolved;
            const data = analogUnsolved
                ? null
                : hasStored
                    ? stored.data
                    : useInputFallback
                        ? inputFallback?.data ?? null
                        : useOutputFallback
                            ? outputFallback.value
                            : null;
            const updatedAt = analogUnsolved
                ? null
                : (hasStored ? stored?.updatedAt : null) || inputFallback?.updatedAt || null;
            const fallbackUsed = analogUnsolved
                ? false
                : !hasStored && (useInputFallback || (useOutputFallback && !origin.properties?.isAnalog));
            if (!inputMap[ownerId]) {
                inputMap[ownerId] = {
                    id: ownerId,
                    name: getPuzzleName(owner, ownerId),
                    state: getPuzzleStateKey(ownerId),
                    outputs: []
                };
            }
            const externalCheck = origin.properties?.externalCheckVariable === `out:${outName}`;
            inputMap[ownerId].outputs.push({
                key: inputName || outName,
                source: getPuzzleName(origin, origin.id),
                sourceKey: outName,
                inputKey: inputName,
                type: normalizeDataType(out.type),
                data,
                updatedAt,
                fallback: fallbackUsed,
                externalCheck,
                externalCheckActive: externalCheck ? isExternalCheckActive(origin, originState) : false,
                externalCheckSolved: externalCheck ? originSolved : false,
                externalCheckMode: externalCheck ? "expected" : null
            });
        };
        nodes.forEach(targetNode => {
            if (!targetNode || !targetNode.inputs) return;
            targetNode.inputs.forEach((input) => {
                if (!input || ACTION_TYPES.has(input.type)) return;
                if (input.name === "Trigger") return;
                const linkIds = [];
                if (Array.isArray(input.links)) {
                    input.links.forEach(l => { if (l !== null && l !== undefined && l !== -1) linkIds.push(l); });
                } else if (input.link !== null && input.link !== undefined && input.link !== -1) {
                    linkIds.push(input.link);
                }
                if (!linkIds.length) return;
                linkIds.forEach(linkId => {
                    const link = links[linkId];
                    if (!link) return;
                    const origin = graph.getNodeById ? graph.getNodeById(link.origin_id) : getPuzzleNodeById(link.origin_id);
                    if (!origin) return;
                    if (origin.type === "escape/Puzzle") {
                        const out = origin.outputs && origin.outputs[link.origin_slot];
                        if (!out || ACTION_TYPES.has(out.type)) return;
                        const outName = out.name || `Output ${link.origin_slot + 1}`;
                        addOutputEntry(origin, out, outName, input.name, targetNode);
                        return;
                    }
                    if (origin.type === "escape/Logic" && (origin.properties?.logicType || "").toUpperCase() === "QUEUE") {
                        const out = origin.outputs && origin.outputs[link.origin_slot];
                        if (!out || ACTION_TYPES.has(out.type)) return;
                        const outName = out.name || `Output ${link.origin_slot + 1}`;
                        const matchingInputs = (origin.inputs || []).filter(inp => inp && !ACTION_TYPES.has(inp.type) && inp.name === outName);
                        matchingInputs.forEach(qInput => {
                            const qLinkIds = [];
                            if (Array.isArray(qInput.links)) {
                                qInput.links.forEach(l => { if (l !== null && l !== undefined && l !== -1) qLinkIds.push(l); });
                            } else if (qInput.link !== null && qInput.link !== undefined && qInput.link !== -1) {
                                qLinkIds.push(qInput.link);
                            }
                            qLinkIds.forEach(qLinkId => {
                                const qLink = links[qLinkId];
                                if (!qLink) return;
                                const qOrigin = graph.getNodeById ? graph.getNodeById(qLink.origin_id) : getPuzzleNodeById(qLink.origin_id);
                                if (!qOrigin || qOrigin.type !== "escape/Puzzle") return;
                                const qOut = qOrigin.outputs && qOrigin.outputs[qLink.origin_slot];
                                if (!qOut || ACTION_TYPES.has(qOut.type)) return;
                                const qOutName = qOut.name || `Output ${qLink.origin_slot + 1}`;
                                addOutputEntry(qOrigin, qOut, qOutName, input.name, targetNode);
                            });
                        });
                    }
                });
            });
        });
        const internalRows = [];
        nodes.forEach(node => {
            if (!node || node.type !== "escape/Puzzle") return;
            const stateKey = getPuzzleStateKey(node.id);
            const showValue = stateKey === "running" || stateKey === "solved";
            const entries = node.properties?.internalVariables || {};
            Object.entries(entries).forEach(([key, entry]) => {
                const type = normalizeDataType(entry?.type || "string");
                const hasValue = entry && Object.prototype.hasOwnProperty.call(entry, "value");
                const data = (showValue && hasValue) ? entry.value : null;
                const externalCheck = node.properties?.externalCheckVariable === `internal:${key}`;
                const solved = puzzleStateDetails[node.id]?.state === 'solved';
                internalRows.push({
                    id: node.id,
                    name: getPuzzleName(node, node.id),
                    state: stateKey,
                    outputs: [{
                        key: key,
                        type: type,
                        data: data,
                        updatedAt: null,
                        target: "Internal",
                        fallback: false,
                        externalCheck,
                        externalCheckActive: externalCheck ? isExternalCheckActive(node, stateKey) : false,
                        externalCheckSolved: externalCheck ? solved : false,
                        externalCheckMode: externalCheck ? "expected" : null
                    }]
                });
            });
        });
        nodes.forEach(node => {
            if (!node || node.type !== "escape/Puzzle") return;
            const externalVar = node.properties?.externalCheckVariable;
            if (externalVar !== EXTERNAL_CHECK_SOLUTION) return;
            const runtime = getExternalCheckRuntime(node.id);
            const rawValue = runtime ? runtime.value ?? null : null;
            const normalizedType = normalizeDataType(rawValue === null ? "string" : typeof rawValue);
            const solved = puzzleStateDetails[node.id]?.state === 'solved';
            const entry = {
                key: "ExternalCheck",
                type: normalizedType,
                data: rawValue,
                updatedAt: runtime?.updatedAt || null,
                target: "External Check",
                fallback: false,
                externalCheck: true,
                externalCheckActive: !!runtime?.active,
                externalCheckSolved: solved,
                externalCheckMode: "runtime"
            };
            if (!inputMap[node.id]) {
                inputMap[node.id] = {
                    id: node.id,
                    name: getPuzzleName(node, node.id),
                    state: getPuzzleStateKey(node.id),
                    outputs: []
                };
            }
            inputMap[node.id].outputs.push(entry);
        });
        const puzzles = Object.values(inputMap);
        const merged = puzzles.concat(internalRows);
        return { roomName: currentRoomName, puzzles: merged };
    },

    getRuntimeRoomStatus: () => {
        const puzzleNodes = getAllPuzzleNodes();
        const totalPuzzles = puzzleNodes.length;
        const solvedCount = Object.values(puzzleSolvedState).filter(Boolean).length;
        const activeCount = Object.values(puzzleActivationState).filter(Boolean).length;
        return {
            roomName: currentRoomName,
            running: isRunning,
            roomStatus: getRoomStatusLabel(),
            gameStartTime,
            serverTime: Date.now(),
            puzzles: {
                total: totalPuzzles,
                solved: solvedCount,
                active: activeCount
            },
            devices: {
                total: Object.keys(knownDevices).length,
                online: countOnlineDevices()
            },
            autoRestart: autoRestartConfig.enabled,
            autoRestartDelay: autoRestartConfig.delaySec
        };
    },

    // Get puzzle flow structure (order of puzzles from graph)
      getPuzzleFlow: () => {
          const flowData = buildPuzzleFlowData();
          if (flowData.error) {
              return { puzzles: [], error: flowData.error };
          }
        const queueingMap = buildQueueingMap();
        const queueTargetMap = buildQueueTargetMap();
        const queueControlledMap = buildQueueControlledMap();
        const queueChoiceMaps = buildQueueChoiceMaps();
        const queueActiveMap = buildQueueActiveMap();
        const queueSolvedMap = buildQueueSolvedMap();

          return { 
              puzzles: flowData.puzzles,
              branches: (flowData.branches || []).map(branch => ({
                  ...branch,
                  puzzles: (branch.puzzles || []).map(p => ({
                      ...p,
                    queueState: queueingMap[branch.id]?.[p.id] ? "queueing" : null,
                    queueTarget: !!queueTargetMap[p.id],
                    queueControlled: !!queueControlledMap[p.id],
                    queueActive: queueActiveMap[p.id] === branch.id,
                    queueBlocked: !!queueChoiceMaps.blockedMap?.[branch.id]?.[p.id],
                    queueChosen: !!queueChoiceMaps.chosenMap?.[branch.id]?.[p.id],
                    queueSolved: !!queueSolvedMap[branch.id]?.[p.id]
                  })),
                  startTime: branchStartTimes[branch.id] || gameStartTime || null
              })),
            roomName: currentRoomName,
            gameStartTime: gameStartTime,
            autoRestart: autoRestartConfig.enabled,
            autoRestartDelay: autoRestartConfig.delaySec
        };
    },

    // Manually mark puzzle as solved
    markPuzzleSolved: (puzzleId, options = {}) => {
        const numericId = parseInt(puzzleId, 10);
        if (Number.isNaN(numericId)) {
            return { success: false, error: "Puzzle not found" };
        }
        const targetNode = getPuzzleNodeById(numericId);
        if (!targetNode) {
            return { success: false, error: "Puzzle not found" };
        }
        const queueTargetIds = getQueueNodes()
            .flatMap(queueNode => getQueueControlledPuzzleIds(queueNode))
            .filter(id => Number.isFinite(id));
        const isQueueTarget = queueTargetIds.includes(numericId);
        const providedBranchId = Number.isFinite(options.branchId) ? options.branchId : null;
        const activeBranchId = puzzleQueueLocks[numericId]?.branchId;
        const resolvedBranchId = Number.isFinite(providedBranchId)
            ? providedBranchId
            : (Number.isFinite(activeBranchId) ? activeBranchId : null);
        if (isQueueTarget && Number.isFinite(providedBranchId)) {
            if (activeBranchId !== providedBranchId) {
                if (!queueSolvedState[providedBranchId]) queueSolvedState[providedBranchId] = {};
                queueSolvedState[providedBranchId][numericId] = true;
                clearQueueEntriesForBranch(providedBranchId);
                const flowData = buildBranchFlowData();
                const branch = (flowData.branches || []).find(b => b.id === providedBranchId);
                if (branch && isBranchSolved(branch)) {
                    markBranchSolved(providedBranchId);
                }
                checkAutoRestartCondition();
                return { success: true, queued: true };
            }
        }

        let idsToSolve = getUpstreamPuzzleIds(numericId);
        if (!idsToSolve.length) idsToSolve = [numericId];
        if (isQueueTarget) {
            idsToSolve = [numericId];
        } else if (Number.isFinite(resolvedBranchId)) {
            const flowData = buildBranchFlowData();
            const branch = (flowData.branches || []).find(b => b.id === resolvedBranchId);
            if (branch && branch._puzzleIds) {
                idsToSolve = idsToSolve.filter(id => branch._puzzleIds.has(id));
            }
            if (!idsToSolve.length) idsToSolve = [numericId];
        }

        let solvedAny = false;
        idsToSolve.forEach(id => {
            if (puzzleStateDetails[id]?.state === 'solved' || puzzleSolvedState[id]) return;
            const node = getPuzzleNodeById(id);
            if (!node) return;
            applyPuzzleState(id, 'solved');
            if (node.setSolved) {
                node.setSolved();
            }
            logSystem(`Puzzle manually solved: ${node.properties.Name || node.title}`, "success");
            solvedAny = true;
        });
        checkAutoRestartCondition();

        return { success: true };
    },

    getPuzzleStatus: (puzzleId) => {
        const numericId = parseInt(puzzleId, 10);
        if (Number.isNaN(numericId)) return null;
        return buildPuzzleStatusPayload(numericId);
    },

    triggerHintForPuzzle,
    triggerCustomHint,

    setPuzzleStatus: (puzzleId, state, note = null) => {
        const numericId = parseInt(puzzleId, 10);
        if (Number.isNaN(numericId)) {
            return { success: false, error: "Invalid puzzleId" };
        }
        if (!isValidPuzzleState(state)) {
            return { success: false, error: "Invalid puzzle state" };
        }
        const node = getPuzzleNodeById(numericId);
        if (!node) {
            return { success: false, error: "Puzzle not found" };
        }
        applyPuzzleState(numericId, state, note);
        return { success: true, status: buildPuzzleStatusPayload(numericId) };
    },

    resetPuzzle: (puzzleId, options = {}) => {
        const numericId = parseInt(puzzleId, 10);
        if (Number.isNaN(numericId)) {
            return { success: false, error: "Invalid puzzleId" };
        }
        const node = getPuzzleNodeById(numericId);
        if (!node) {
            return { success: false, error: "Puzzle not found" };
        }
        applyPuzzleState(numericId, 'locked', options.note || null);
        delete puzzleTelemetry[numericId];
        clearHintTimers(numericId);
        removeHintsForPuzzle(numericId);
        if (options.hard) {
            logSystem(`Hard reset requested for puzzle ${numericId}.`, "warn");
        }
        return { success: true, hardReset: !!options.hard, status: buildPuzzleStatusPayload(numericId) };
    },

    recordPuzzleHeartbeat: async (puzzleId, payload = {}) => {
        const numericId = parseInt(puzzleId, 10);
        if (Number.isNaN(numericId)) {
            return { success: false, error: "Invalid puzzleId" };
        }
        const node = getPuzzleNodeById(numericId);
        if (!node) {
            return { success: false, error: "Puzzle not found" };
        }
        const now = Date.now();
        const deviceId = payload.deviceId || getDeviceIdForPuzzle(node);
        if (!deviceId) {
            return { success: false, error: "Puzzle has no device assigned" };
        }
        const deviceName = payload.deviceName || knownDevices[deviceId]?.name || node.properties?.Name || `Puzzle ${numericId}`;
        const deviceIp = payload.ip || knownDevices[deviceId]?.ip || "?.?.?.?";
        await db.run(`INSERT OR REPLACE INTO devices (id, name, ip, last_seen) VALUES (?, ?, ?, ?)`, [deviceId, deviceName, deviceIp, now]);
        knownDevices[deviceId] = { id: deviceId, name: deviceName, ip: deviceIp, lastSeen: now };

        puzzleTelemetry[numericId] = {
            lastSeen: now,
            ...(payload.telemetry || {})
        };
        logSystem(`Heartbeat: ${deviceName} (${deviceId})`, "heartbeat");

        if (payload.status && isValidPuzzleState(payload.status) && !shouldIgnoreInboundState() && shouldApplyDeviceState(numericId, payload.status)) {
            applyPuzzleState(numericId, payload.status, payload.note || null, { outbound: false });
            if (payload.status === 'solved') {
                activateReadyPuzzles();
            }
        }

        return { success: true, status: buildPuzzleStatusPayload(numericId) };
    },

    getPuzzleSolution: async (puzzleId) => {
        const numericId = parseInt(puzzleId, 10);
        if (Number.isNaN(numericId)) return null;
        const row = await db.get(`SELECT solution, updated_at FROM puzzle_solutions WHERE puzzle_id = ?`, [numericId]);
        if (!row) {
            return { puzzleId: numericId, solution: null, updatedAt: null };
        }
        return { puzzleId: numericId, solution: row.solution, updatedAt: row.updated_at };
    },

    setPuzzleSolution: async (puzzleId, solution) => {
        const numericId = parseInt(puzzleId, 10);
        if (Number.isNaN(numericId)) {
            return { success: false, error: "Invalid puzzleId" };
        }
        const node = getPuzzleNodeById(numericId);
        if (!node) {
            return { success: false, error: "Puzzle not found" };
        }
        const now = Date.now();
        await db.run(`INSERT OR REPLACE INTO puzzle_solutions (puzzle_id, solution, updated_at) VALUES (?, ?, ?)`, [numericId, solution || '', now]);
        return { success: true, puzzleId: numericId, solution: solution || '', updatedAt: now };
    },

    // Reset room (reset all puzzle states)
    resetRoom: () => {
        suppressDeviceStateUntil = Date.now() + 1500;
        resetAllPuzzleStates('locked');
        puzzleTelemetry = {};
        gameStartTime = null;
        branchStartTimes = {};
        isRunning = false;
        primeDataStoreWithOutputs();
        clearAllAutoRestartTimers();
        getAllPuzzleNodes().forEach(node => {
            const devId = getDeviceIdForPuzzle(node);
            const io = collectIOKeys(node);
            if (canSendToDevice(node, devId)) {
                publishCommand(devId, { action: "clearData" });
                publishCommand(devId, { action: "initKeys", inputs: io.inputs, outputs: io.outputs });
            }
        });
        logSystem("Room reset.", "info");
        return { success: true };
    },

    setAutoRestart: (enabled, delaySec) => {
        autoRestartConfig.enabled = !!enabled;
        const d = parseInt(delaySec, 10);
        autoRestartConfig.delaySec = Number.isFinite(d) ? d : autoRestartConfig.delaySec;
        clearAllAutoRestartTimers();
        checkAutoRestartCondition();
        return { success: true, autoRestart: autoRestartConfig };
    },

    getAutoRestart: () => ({ ...autoRestartConfig }),

    processMqttMessage: async (topic, message) => {
        const parts = topic.split('/');
        if (parts.length < 3 || parts[0] !== 'puzzle') return;
        
        const deviceId = parts[1];
        const action = parts[2]; 
        
        let payload = {};
        try { payload = JSON.parse(message.toString()); } catch (e) {}

        logSystem(`MQTT ${action} from ${deviceId}`, "mqtt", { topic, payload });

        if (action === 'heartbeat') {
            const deviceName = payload.name || "Unknown";
            const deviceIp = payload.ip || "?.?.?.?";
            const now = Date.now();

            if (!knownDevices[deviceId] || knownDevices[deviceId].name !== deviceName) {
                logSystem(`Device detected: ${deviceName}`, "success");
                await db.run(`INSERT OR REPLACE INTO devices (id, name, ip, last_seen) VALUES (?, ?, ?, ?)`, [deviceId, deviceName, deviceIp, now]);
            }
            knownDevices[deviceId] = { id: deviceId, name: deviceName, ip: deviceIp, lastSeen: now };
            logSystem(`Heartbeat: ${deviceName} (${deviceId})`, "heartbeat", { topic, payload });
            if (payload.state && !shouldIgnoreInboundState()) {
                const puzzleNodes = graph.findNodesByType("escape/Puzzle");
                const targetNode = puzzleNodes.find(n => n.properties.selectedDeviceID === deviceId);
                if (targetNode) {
                    if (shouldApplyDeviceState(targetNode.id, payload.state)) {
                        applyPuzzleState(targetNode.id, payload.state, null, { outbound: false });
                    }
                }
            }
        }

        if (action === 'data') {
            const puzzleNodes = graph.findNodesByType("escape/Puzzle");
            const targetNode = puzzleNodes.find(n => n.properties.selectedDeviceID === deviceId);
            const key = payload.key || payload.type;
            const type = payload.type;
            if (targetNode && key && isDataKeyAllowed(key, type)) {
                recordOutputData(targetNode.id, key, type, payload.data);
                puzzleTelemetry[targetNode.id] = { lastData: payload, lastSeen: Date.now() };
                const puzzleName = getPuzzleName(targetNode, targetNode.id);
                logSystem(`Data received from "${puzzleName}" (${key}): ${JSON.stringify(payload.data)}`, "system");
                forwardOutputToTargets(targetNode, key, type, payload.data);
            }
        }

        if (action === 'external-check' || action === 'external_check' || action === 'externalCheck') {
            const puzzleNodes = graph.findNodesByType("escape/Puzzle");
            const targetNode = puzzleNodes.find(n => n.properties.selectedDeviceID === deviceId);
            if (!targetNode) return;
            const active = payload?.active === false || payload?.enabled === false ? false : true;
            if (!active) {
                clearExternalCheckRuntime(targetNode.id);
                return;
            }
            const value = payload?.variable ?? payload?.value ?? payload?.solution ?? payload?.expected ?? payload?.data ?? null;
            setExternalCheckRuntime(targetNode.id, { active: true, value });
            logSystem(`External check activated for "${getPuzzleName(targetNode, targetNode.id)}"`, "system");
        }
    }
};
