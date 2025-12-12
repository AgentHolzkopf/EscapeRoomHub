const { LiteGraph, LGraph } = require('litegraph.js');
const http = require('http');
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
let puzzleActivationState = {}; // Track which puzzles are currently active/unlocked: { nodeId: true/false }
let gameStartTime = null; // Timestamp when game was started 
let puzzleStateDetails = {}; // Extended state info incl. notes/timestamps
let puzzleTelemetry = {}; // Stores latest heartbeat payload per puzzle
let puzzleDataStore = {}; // Stores latest output data per puzzle { puzzleId: { outputs: { key: {type,data,updatedAt} } } }
let autoRestartConfig = { enabled: false, delaySec: 5 };
let autoRestartTimer = null;
let hintTimers = {}; // { puzzleId: [timeoutId, ...] }
let hintProgress = {}; // { puzzleId: nextIndex }
let activeHintsByScreen = {}; // { screenPath: [ { puzzleId, puzzleName, index, text, auto, at } ] }
let systemSettings = { mqttPort: mqttClient.getCurrentPort(), screenSaverImage: null, victoryScreen: null };

const ONLINE_THRESHOLD_MS = 5000;
const VALID_PUZZLE_STATES = ['locked', 'active', 'running', 'solved', 'error', 'unlocked'];
const DEVICE_PORT = parseInt(process.env.PUZZLE_PORT || '5001', 10);
const ACTION_TYPES = new Set([LiteGraph.ACTION, LiteGraph.EVENT, "action", "event", -1]);
const SETTINGS_KEYS = {
    mqttPort: 'mqtt_port',
    screenSaverImage: 'screen_saver_image',
    victoryScreen: 'victory_screen'
};
const UPLOAD_DIR = path.join(__dirname, '../../public/uploads');

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

function sanitizeFileName(name, fallback = 'image') {
    const safeBase = (name || fallback).toString().replace(/[^a-z0-9-_]/gi, "").slice(0, 60);
    return safeBase || fallback;
}

async function ensureUploadDir() {
    if (!fs.existsSync(UPLOAD_DIR)) {
        await fsp.mkdir(UPLOAD_DIR, { recursive: true });
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
            `SELECT key, value FROM config WHERE key IN (?, ?, ?)`,
            [SETTINGS_KEYS.mqttPort, SETTINGS_KEYS.screenSaverImage, SETTINGS_KEYS.victoryScreen]
        );
        const map = {};
        rows.forEach(r => { map[r.key] = r.value; });
        const storedPort = parseMqttPort(map[SETTINGS_KEYS.mqttPort]);
        const chosenPort = storedPort || mqttClient.getCurrentPort();
        systemSettings.mqttPort = chosenPort;
        mqttClient.restart(chosenPort);
        systemSettings.screenSaverImage = map[SETTINGS_KEYS.screenSaverImage] || null;
        systemSettings.victoryScreen = map[SETTINGS_KEYS.victoryScreen] || null;
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
    return { ...systemSettings };
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
    const normalized = rawScreens.map((s, idx) => {
        const id = typeof s.id === "number" ? s.id : parseInt(s.id || (idx + 1), 10) || (idx + 1);
        const basePath = sanitizeScreenPath(s.path || s.slug || `screen-${idx + 1}`, `screen-${id}`);
        let candidate = basePath || `screen-${id}`;
        let suffix = 2;
        while (used.has(candidate)) {
            candidate = `${basePath || `screen-${id}`}-${suffix++}`;
        }
        used.add(candidate);
        return {
            ...s,
            id,
            name: s.name || `Screen ${idx + 1}`,
            role: s.role === "hint" ? "hint" : "player",
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

function triggerHintForPuzzle(puzzleId, { auto = false } = {}) {
    const node = getPuzzleNodeById(puzzleId);
    if (!node) return { success: false, error: "Puzzle not found" };
    const stateRec = getPuzzleStateRecord(puzzleId);
    if (stateRec.state === 'solved') return { success: false, error: "Puzzle already solved" };
    const screen = resolveHintScreen(node);
    if (!screen) {
        return { success: false, error: "No hint screen assigned" };
    }
    const hints = normalizeHints(node);
    if (!hints.length) return { success: false, error: "No hints configured" };

    const nextIdx = hintProgress[puzzleId] || 0;
    if (nextIdx >= hints.length) return { success: false, error: "All hints already shown" };

    const now = Date.now();
    const entry = {
        puzzleId,
        puzzleName: node.properties?.Name || node.title || `Puzzle ${puzzleId}`,
        index: nextIdx,
        text: hints[nextIdx].text || "",
        auto: !!auto,
        at: now,
        showAssignment: node.properties?.showHintAssignment !== false
    };

    const pathKey = sanitizeScreenPath(screen.path || "", `screen-${screen.id}`);
    if (!activeHintsByScreen[pathKey]) activeHintsByScreen[pathKey] = [];
    activeHintsByScreen[pathKey].push(entry);
    hintProgress[puzzleId] = nextIdx + 1;

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
    return { success: true, hint: entry, screen: { id: screen.id, name: screen.name, path: screen.path } };
}

function scheduleHintTimers(node) {
    if (!node || !node.properties) return;
    clearHintTimers(node.id);
    if (!node.properties.automaticHintTrigger) return;
    const screen = resolveHintScreen(node);
    if (!screen) return;

    const hints = normalizeHints(node);
    if (!hints.length) return;

    const timers = [];
    let accumulated = 0;
    hints.forEach((h, idx) => {
        const delaySec = idx === 0 ? (h.delayFromStart || 0) : (h.delayAfterPrev || 0);
        accumulated += Math.max(0, delaySec) * 1000;
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
    if (["string", "number", "boolean"].includes(str)) return str;
    return "string";
}

function isDataKeyAllowed(key, type) {
    if (!key) return false;
    if (key === "Done") return false;
    if (ACTION_TYPES.has(type)) return false;
    return true;
}

function allPuzzlesSolved() {
    const puzzles = getAllPuzzleNodes();
    if (!puzzles.length) return false;
    return puzzles.every(p => puzzleSolvedState[p.id]);
}

function scheduleAutoRestart() {
    if (!autoRestartConfig.enabled || autoRestartTimer) return;
    if (!allPuzzlesSolved()) return;
    const delayMs = Math.max(0, (autoRestartConfig.delaySec || 0) * 1000);
    logSystem(`Auto-restart scheduled in ${autoRestartConfig.delaySec}s.`, "info");
    autoRestartTimer = setTimeout(() => {
        autoRestartTimer = null;
        // reset then start
        module.exports.resetRoom();
        module.exports.startGame();
    }, delayMs);
}

function checkAutoRestartCondition() {
    if (!autoRestartConfig.enabled) return;
    scheduleAutoRestart();
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
    puzzleDataStore[puzzleId].outputs[key] = {
        type: finalType,
        data: data,
        updatedAt: Date.now()
    };
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
        });
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

function activateDownstreamPuzzles(node) {
    if (!node || !node.outputs) return;
    const links = graph.links || {};
    node.outputs.forEach(out => {
        if (!out.links) return;
        out.links.forEach(linkId => {
            const link = links[linkId];
            if (!link) return;
            const targetId = link.target_id;
            const targetNode = getPuzzleNodeById(targetId);
            if (targetNode) {
                applyPuzzleState(targetId, 'running');
            }
        });
    });
}

function normalizePuzzleState(state) {
    if (state === 'unlocked') return 'active';
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
    const state = normalizePuzzleState(desiredState);
    const now = Date.now();
    const prevState = puzzleStateDetails[puzzleId]?.state || 'locked';

    puzzleStateDetails[puzzleId] = {
        state,
        note: note || null,
        updatedAt: now
    };

    if (state === 'solved') {
        puzzleSolvedState[puzzleId] = true;
        delete puzzleActivationState[puzzleId];
        checkAutoRestartCondition();
    } else {
        delete puzzleSolvedState[puzzleId];
        if (state === 'active' || state === 'running') {
            puzzleActivationState[puzzleId] = true;
        } else {
            delete puzzleActivationState[puzzleId];
        }
    }

    if (options.outbound) {
        const node = getPuzzleNodeById(puzzleId);
        if (node) {
            const deviceId = getDeviceIdForPuzzle(node);
            const outboundState = state === 'active' ? 'running' : state;
            publishCommand(deviceId, { action: "setState", state: outboundState });
        }
    }

    const node = getPuzzleNodeById(puzzleId);
    if (state === 'locked' || state === 'solved' || state === 'error') {
        clearHintTimers(puzzleId);
        if (state === 'locked' || state === 'solved') removeHintsForPuzzle(puzzleId);
    } else if (['active', 'running'].includes(state) && !['active', 'running'].includes(prevState)) {
        scheduleHintTimers(node);
    }
}

function resetAllPuzzleStates(defaultState = 'locked') {
    puzzleSolvedState = {};
    puzzleActivationState = {};
    puzzleStateDetails = {};
    puzzleDataStore = {};
    activeHintsByScreen = {};
    hintTimers = {};
    hintProgress = {};
    if (autoRestartTimer) {
        clearTimeout(autoRestartTimer);
        autoRestartTimer = null;
    }
    getAllPuzzleNodes().forEach(node => {
        const devId = getDeviceIdForPuzzle(node);
        publishCommand(devId, { action: "clearData" });
        publishCommand(devId, { action: "reset" });
        removeHintsForPuzzle(node.id);
        applyPuzzleState(node.id, defaultState);
    });
}

function getDeviceIdForPuzzle(node) {
    if (!node) return null;
    return node.properties?.selectedDeviceID || null;
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

function collectConnectionWarnings() {
    const warnings = [];
    if (!graph || !graph._nodes) return warnings;

    graph._nodes.forEach(node => {
        if (!node) return;
        const nodeName = node.title || `Node ${node.id}`;

        (node.inputs || []).forEach((input, idx) => {
            if (!input) return;
            if (input.link === null || input.link === undefined || input.link === -1) {
                const label = input.name || `Input ${idx + 1}`;
                warnings.push(`${nodeName}: Eingang "${label}" nicht verbunden`);
            }
        });

        (node.outputs || []).forEach((output, idx) => {
            if (!output) return;
            const hasLinks = Array.isArray(output.links) ? output.links.length > 0 : !!output.link;
            if (!hasLinks) {
                const label = output.name || `Output ${idx + 1}`;
                warnings.push(`${nodeName}: Ausgang "${label}" nicht verbunden`);
            }
        });
    });

    return warnings;
}

function buildReadinessWarnings() {
    return [...collectDeviceWarnings(), ...collectConnectionWarnings()];
}

function buildPuzzleFlowData() {
    if (!currentRoomName) return { puzzles: [], error: "No active room" };

    try {
        const puzzleNodes = graph.findNodesByType("escape/Puzzle");
        const startNodes = graph.findNodesByType("escape/Start");
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
        graph._nodes.forEach(node => {
            allNodes[node.id] = node;
        });

        const visited = new Set();
        const puzzleOrder = [];

        function traverse(nodeId, depth = 0) {
            if (visited.has(nodeId)) return;
            visited.add(nodeId);

            const node = allNodes[nodeId];
            if (!node) return;

            if (node.type === "escape/Puzzle") {
                const hints = normalizeHints(node);
                const hintScreen = resolveHintScreen(node);
                const nextIdx = hintProgress[node.id] || 0;
                puzzleOrder.push({
                    id: node.id,
                    name: node.properties.Name || node.title || "Unnamed Puzzle",
                    description: "",
                    depth: depth,
                    isAnalog: node.properties.isAnalog || false,
                    device: node.properties.selectedDeviceID || null,
                    hintAvailable: !!(hintScreen && nextIdx < hints.length),
                    hintScreenPath: hintScreen?.path || null
                });
            }

            if (adjacencyMap[nodeId]) {
                adjacencyMap[nodeId].forEach(conn => {
                    traverse(conn.targetId, depth + 1);
                });
            }
        }

        if (startNodes && startNodes.length > 0) {
            startNodes.forEach(startNode => {
                if (adjacencyMap[startNode.id]) {
                    adjacencyMap[startNode.id].forEach(conn => {
                        traverse(conn.targetId, 0);
                    });
                }
            });
        }

        puzzleOrder.sort((a, b) => {
            if (a.depth !== b.depth) return a.depth - b.depth;
            return a.id - b.id;
        });

        return { puzzles: puzzleOrder, error: null };
    } catch (e) {
        return { puzzles: [], error: e.message };
    }
}

function initializePuzzleStatesOnStart() {
    const flowData = buildPuzzleFlowData();
    const puzzles = flowData.puzzles || [];
    if (!puzzles.length) return;

    const minDepth = puzzles.reduce((min, p) => Math.min(min, p.depth || 0), Infinity);
    if (!Number.isFinite(minDepth)) return;

    puzzles.forEach(puzzle => {
        const node = getPuzzleNodeById(puzzle.id);
        if (!node) return;
        const devId = getDeviceIdForPuzzle(node);
        const isOnline = node.properties?.isAnalog || isDeviceOnline(devId);

        if (!isOnline) {
            applyPuzzleState(puzzle.id, 'locked');
            return;
        }

        if (node.properties?.isStartNode) {
            applyPuzzleState(puzzle.id, 'running');
        } else if ((puzzle.depth || 0) === minDepth) {
            applyPuzzleState(puzzle.id, 'active');
        } else {
            applyPuzzleState(puzzle.id, 'locked');
        }
    });
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
function logSystem(msg, type = "info") {
    const timestamp = new Date().toLocaleTimeString();
    systemLogs.unshift({ timestamp, type, msg });
    if (systemLogs.length > 100) systemLogs.pop();
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

module.exports = {
    getLogs: () => systemLogs,
    getDevices: () => knownDevices,
    getCurrentRoomName: () => currentRoomName,
    getScreens: () => getScreensConfig(),
    findScreenByPath: (pathStr) => findScreenByPath(pathStr),
    getSystemSettings: () => getSystemSettings(),
    setMqttPort,
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
    validateRoomReadiness: () => {
        const warnings = buildReadinessWarnings();
        return { warnings, ok: warnings.length === 0 };
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
            
            return true;
        } catch (e) { return false; }
    },

    removeDevice: async (id) => {
        if (knownDevices[id]) delete knownDevices[id];
        await db.run("DELETE FROM devices WHERE id = ?", [id]);
        return true;
    },

    startGame: () => {
        const startNodes = graph.findNodesByType("escape/Start");
        if(startNodes) {
            // Reset states when starting game
            resetAllPuzzleStates('locked');
            primeDataStoreWithOutputs();
            getAllPuzzleNodes().forEach(node => {
                const devId = getDeviceIdForPuzzle(node);
                const io = collectIOKeys(node);
                publishCommand(devId, { action: "clearData" });
                publishCommand(devId, { action: "initKeys", inputs: io.inputs, outputs: io.outputs });
            });
            initializePuzzleStatesOnStart();
            puzzleTelemetry = {};
            gameStartTime = Date.now();
            isRunning = true;
            if (autoRestartTimer) {
                clearTimeout(autoRestartTimer);
                autoRestartTimer = null;
            }
            startNodes.forEach(n => n.triggerSlot(0));
            logSystem("Game started.", "success");
        }
    },

    getPuzzleStatuses: () => {
        const statusList = {};
        const puzzleNodes = getAllPuzzleNodes();
        puzzleNodes.forEach(node => {
            const devId = getDeviceIdForPuzzle(node);
            const stateRecord = getPuzzleStateRecord(node.id);
            statusList[node.id] = { 
                online: isDeviceOnline(devId),
                solved: stateRecord.state === 'solved' || !!puzzleSolvedState[node.id],
                active: ['active', 'running'].includes(stateRecord.state) || !!puzzleActivationState[node.id],
                state: stateRecord.state,
                note: stateRecord.note,
                updatedAt: stateRecord.updatedAt
            };
        });
        return statusList;
    },

    getDataSnapshot: () => {
        const puzzles = getAllPuzzleNodes().map(node => {
            const outputsObj = puzzleDataStore[node.id]?.outputs || {};
            const outputs = Object.entries(outputsObj).map(([key, val]) => {
                // try find targets based on output slot name
                let targetNames = [];
                if (node.outputs) {
                    node.outputs.forEach((out, idx) => {
                        if (!out || out.name !== key) return;
                        targetNames = getOutputTargets(node, idx);
                    });
                }
                return {
                    key,
                    type: val?.type || "string",
                    data: (val && Object.prototype.hasOwnProperty.call(val, "data")) ? val.data : null,
                    updatedAt: val?.updatedAt || null,
                    target: targetNames.join(", ")
                };
            });
            return {
                id: node.id,
                name: getPuzzleName(node, node.id),
                outputs
            };
        });
        return { roomName: currentRoomName, puzzles };
    },

    getRuntimeRoomStatus: () => {
        const puzzleNodes = getAllPuzzleNodes();
        const totalPuzzles = puzzleNodes.length;
        const solvedCount = Object.values(puzzleSolvedState).filter(Boolean).length;
        const activeCount = Object.values(puzzleActivationState).filter(Boolean).length;
        return {
            roomName: currentRoomName,
            running: isRunning,
            gameStartTime,
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

        return { 
            puzzles: flowData.puzzles,
            roomName: currentRoomName,
            gameStartTime: gameStartTime,
            autoRestart: autoRestartConfig.enabled,
            autoRestartDelay: autoRestartConfig.delaySec
        };
    },

    // Manually mark puzzle as solved
    markPuzzleSolved: (puzzleId) => {
        const puzzleNodes = graph.findNodesByType("escape/Puzzle");
        const targetNode = puzzleNodes.find(n => n.id === puzzleId);
        
        if (!targetNode) {
            return { success: false, error: "Puzzle not found" };
        }
        
        applyPuzzleState(puzzleId, 'solved');
        if (targetNode.setSolved) {
            targetNode.setSolved();
            logSystem(`Puzzle manually solved: ${targetNode.properties.Name || targetNode.title}`, "success");
        }
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

        if (payload.status && isValidPuzzleState(payload.status)) {
            applyPuzzleState(numericId, payload.status, payload.note || null, { outbound: false });
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
        resetAllPuzzleStates('locked');
        puzzleTelemetry = {};
        gameStartTime = null;
        isRunning = false;
        primeDataStoreWithOutputs();
        if (autoRestartTimer) {
            clearTimeout(autoRestartTimer);
            autoRestartTimer = null;
        }
        getAllPuzzleNodes().forEach(node => {
            const devId = getDeviceIdForPuzzle(node);
            const io = collectIOKeys(node);
            publishCommand(devId, { action: "clearData" });
            publishCommand(devId, { action: "initKeys", inputs: io.inputs, outputs: io.outputs });
        });
        logSystem("Room reset.", "info");
        return { success: true };
    },

    setAutoRestart: (enabled, delaySec) => {
        autoRestartConfig.enabled = !!enabled;
        const d = parseInt(delaySec, 10);
        autoRestartConfig.delaySec = Number.isFinite(d) ? d : autoRestartConfig.delaySec;
        if (autoRestartTimer) {
            clearTimeout(autoRestartTimer);
            autoRestartTimer = null;
        }
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

        if (action === 'heartbeat') {
            const deviceName = payload.name || "Unknown";
            const deviceIp = payload.ip || "?.?.?.?";
            const now = Date.now();

            if (!knownDevices[deviceId] || knownDevices[deviceId].name !== deviceName) {
                logSystem(`Device detected: ${deviceName}`, "success");
                await db.run(`INSERT OR REPLACE INTO devices (id, name, ip, last_seen) VALUES (?, ?, ?, ?)`, [deviceId, deviceName, deviceIp, now]);
            }
            knownDevices[deviceId] = { id: deviceId, name: deviceName, ip: deviceIp, lastSeen: now };
            if (payload.state) {
                const puzzleNodes = graph.findNodesByType("escape/Puzzle");
                const targetNode = puzzleNodes.find(n => n.properties.selectedDeviceID === deviceId);
                if (targetNode) {
                    applyPuzzleState(targetNode.id, payload.state, null, { outbound: false });
                }
            }
        }

        if (action === 'status' && payload === 'solved') {
             const puzzleNodes = graph.findNodesByType("escape/Puzzle");
             const targetNode = puzzleNodes.find(n => n.properties.selectedDeviceID === deviceId);
             if (targetNode && targetNode.setSolved) {
                 applyPuzzleState(targetNode.id, 'solved', null, { outbound: false });
                 logSystem(`Puzzle solved: ${targetNode.title}`, "success");
                 targetNode.setSolved();
                 activateDownstreamPuzzles(targetNode);
                 checkAutoRestartCondition();
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
                forwardOutputToTargets(targetNode, key, type, payload.data);
            }
        }
    }
};

