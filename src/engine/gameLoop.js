const { LiteGraph, LGraph } = require('litegraph.js');
const http = require('http');
const EventEmitter = require('events');
const { spawn } = require('child_process');
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
let outputTransferState = {}; // { transferKey: { hubSentAt, forwardedAt } }
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
const RESTART_IGNORE_SOLVED_UNTIL_FRESH_MS = 15000;
const RESTART_ALLOW_UNSOLVE_MS = 30000;
const restartFreshStateSeen = {};
let hintTimers = {}; // { puzzleId: [timeoutId, ...] }
let hintProgress = {}; // { puzzleId: nextIndex }
let hintRuntimeQueues = {}; // { puzzleId: [ { text, delayFromStart, delayAfterPrev, dueAt } ] }
let activeHintsByScreen = {}; // { screenPath: [ { puzzleId, puzzleName, index, text, auto, at } ] }
let pendingMediaFallbackTimers = {}; // { puzzleId: { key: timeoutId } }
let systemSettings = { mqttPort: mqttClient.getCurrentPort(), screenSaverImage: null, victoryScreen: null, mediaServerEnabled: false, autostartEnabled: false, zigbeeBridgeEnabled: false, dmxServiceEnabled: false };
let dmxAdapterCache = { at: 0, info: null };
let zigbeeAdapterCache = { at: 0, info: null };
let soundOutputCache = { at: 0, info: null };
let zigbeeDevices = {}; // { deviceId: { id, friendlyName, ieeeAddress, vendor, model, type, description, online, lastSeen, lastTopic, lastPayload } }
let zigbeeFriendlyIndex = {}; // { normalizedFriendlyName: deviceId }
let zigbeeBridgeRuntime = { state: "unknown", lastSeen: 0, discoveryUntil: 0 };
let zigbeeHiddenDeviceIds = new Set();
let zigbeeMessageLogs = [];
let zigbeeMessageTriggers = { nextTriggerId: 1, triggers: [] };
let puzzleScriptingVariables = {};
let puzzleScriptingActiveUntil = {};
let puzzleScriptingSeq = {};
let roomScriptingVariables = {};
let roomScriptingActiveUntil = 0;
let roomScriptingSeq = 0;
let roomScriptingSensorInstances = {}; // { deviceId: { field: value } }
let roomScriptingLastRoomState = null; // "running" | "solved" | null
let roomScriptingLastBranchStates = {}; // { branchId: "running" | "solved" }
let puzzleScriptingSensorInstances = {}; // { puzzleId: { deviceId: { field: value } } }
let scriptingForeverTimers = new Set();
let puzzleForeverRunners = new Map();
let roomForeverRunners = new Map();
let puzzleScriptingTriggerLocks = new Set();
let roomScriptingTriggerLocks = new Set();
let puzzleLoopGeneration = new Map();
let roomLoopGeneration = 0;
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
    autostartEnabled: 'autostart_on_startup',
    zigbeeBridgeEnabled: 'zigbee_bridge_enabled',
    dmxServiceEnabled: 'dmx_service_enabled',
    zigbeeDeviceCache: 'zigbee_device_cache'
};
const AUTOSTART_SERVICE_NAME = 'md2-hub.service';
const AUTOSTART_SERVICE_PATH = '/etc/systemd/system/md2-hub.service';
const AUTOSTART_WORKDIR = '/home/admin/md2-hub/Server';
const AUTOSTART_SCRIPT = '/home/admin/md2-hub/Server/server.js';
const ZIGBEE_BRIDGE_SERVICE_NAME = 'zigbee2mqtt.service';
const DMX_SERVICE_NAME = 'olad.service';
const UPLOAD_DIR = path.join(__dirname, '../../public/uploads');
const MEDIA_DIR = path.join(__dirname, '../../MediaStorage');
const SOUNDS_DIR = path.join(__dirname, '../../SoundStorage');
const SOUNDS_META_PATH = path.join(SOUNDS_DIR, '.sound-metadata.json');
const DMX_ADAPTER_CACHE_MS = 10000;
const DMX_KEYWORDS = ['dmx', 'enttec', 'dmxking', 'ultradmx', 'opendmx', 'eurolite', 'daslight', 'sunlite', 'mydmx'];
const ZIGBEE_ADAPTER_CACHE_MS = 3000;
const SOUND_OUTPUT_CACHE_MS = 5000;
const ZIGBEE_KEYWORDS = ['zigbee', 'conbee', 'cc2652', 'zbdongle', 'sonoff', 'deconz', 'ezsp', 'ember', 'skyconnect'];
const SERIAL_HINT_KEYWORDS = ['ftdi', 'vid_0403', 'cp210', 'silicon labs', 'ch340', 'ch341', 'prolific', 'usb serial', 'uart'];
const DMX_MAX_CHANNEL = 512;
const DMX_MIN_VALUE = 0;
const DMX_MAX_VALUE = 255;
const DMX_OLA_COMMAND_CACHE_MS = 300000;
const DMX_DEFAULT_UNIVERSE = Number.isFinite(parseInt(process.env.DMX_UNIVERSE, 10))
    ? parseInt(process.env.DMX_UNIVERSE, 10)
    : 0;
const DMX_OLA_COMMANDS = ['ola_set_dmx', 'ola_streaming_client'];
const DMX_FADE_STEP_MS = 50;
const SERIAL_UDEV_CACHE_MS = 300000;
const ZIGBEE_TOPIC_PREFIX = "zigbee2mqtt/";
const ZIGBEE_BRIDGE_DEVICES_TOPIC = "zigbee2mqtt/bridge/devices";
const ZIGBEE_BRIDGE_STATE_TOPIC = "zigbee2mqtt/bridge/state";
const ZIGBEE_BRIDGE_EVENT_TOPIC = "zigbee2mqtt/bridge/event";
const ZIGBEE_BRIDGE_RESPONSE_PREFIX = "zigbee2mqtt/bridge/response/";
const ZIGBEE_LOG_LIMIT = 250;
const ZIGBEE_CACHE_PERSIST_DELAY_MS = 700;
let dmxOlaCommandCache = { at: 0, command: null };
let dmxUniverseBuffer = new Array(DMX_MAX_CHANNEL).fill(0);
let dmxSendErrorGateAt = 0;
let dmxCueTokenCounter = 0;
let dmxPlaybackTimers = new Map();
let dmxActiveCueInstances = new Map();
let dmxSceneScheduleTimers = new Set();
let activeSoundCueProcesses = new Set();
let soundCuePendingRequest = null;
let soundCueWorkerRunning = false;
let dmxSendInFlight = false;
let dmxQueuedSendJob = null;
let dmxOlaCommandProbeInFlight = false;
let preferredSoundCuePlayer = null;
let linuxSerialMetaCache = { at: 0, byPath: {} };
let linuxSerialMetaProbeInFlight = false;
let zigbeeCachePersistTimer = null;
let zigbeeRealtimeEmitTimer = null;
const offlineErrorState = {};
const pendingOutputErrors = {};
const eventBus = new EventEmitter();
eventBus.setMaxListeners(0);

function emitUpdate(type, payload = {}) {
    eventBus.emit('update', { type, at: Date.now(), ...payload });
}

function scheduleZigbeeRealtimeUpdate(payload = {}) {
    if (zigbeeRealtimeEmitTimer) return;
    zigbeeRealtimeEmitTimer = setTimeout(() => {
        zigbeeRealtimeEmitTimer = null;
        emitUpdate('zigbee-message', payload || {});
    }, 120);
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

function scoreDmxCandidateText(text) {
    const base = (text || '').toString().toLowerCase();
    let score = 0;
    DMX_KEYWORDS.forEach(keyword => {
        if (base.includes(keyword)) score += 100;
    });
    SERIAL_HINT_KEYWORDS.forEach(keyword => {
        if (base.includes(keyword)) score += 12;
    });
    return score;
}

function scoreZigbeeCandidateText(text) {
    const base = (text || '').toString().toLowerCase();
    let score = 0;
    ZIGBEE_KEYWORDS.forEach(keyword => {
        if (base.includes(keyword)) score += 100;
    });
    SERIAL_HINT_KEYWORDS.forEach(keyword => {
        if (base.includes(keyword)) score += 12;
    });
    return score;
}

function runCommandCaptureAsync(cmd, args = [], timeoutMs = 1500) {
    return new Promise((resolve) => {
        let child = null;
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        try {
            child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
            resolve({ ok: false, status: -1, stdout: '', stderr: err?.message || 'spawn failed' });
            return;
        }
        const timeoutId = setTimeout(() => {
            timedOut = true;
            try { child.kill('SIGKILL'); } catch (e) {}
        }, Math.max(100, Number(timeoutMs) || 1500));
        if (child.stdout) {
            child.stdout.on('data', (chunk) => {
                try { stdout += chunk.toString(); } catch (e) {}
            });
        }
        if (child.stderr) {
            child.stderr.on('data', (chunk) => {
                try { stderr += chunk.toString(); } catch (e) {}
            });
        }
        child.on('error', (err) => {
            clearTimeout(timeoutId);
            resolve({ ok: false, status: -1, stdout, stderr: err?.message || stderr || 'spawn error' });
        });
        child.on('close', (code) => {
            clearTimeout(timeoutId);
            resolve({
                ok: !timedOut && code === 0,
                status: timedOut ? -1 : code,
                stdout: (stdout || '').toString(),
                stderr: timedOut ? (stderr || 'timeout') : (stderr || '').toString()
            });
        });
    });
}

function parseUdevProperties(stdout) {
    const props = {};
    String(stdout || '').split(/\r?\n/).forEach(line => {
        const idx = line.indexOf('=');
        if (idx <= 0) return;
        const k = line.slice(0, idx).trim();
        const v = line.slice(idx + 1).trim();
        if (!k) return;
        props[k] = v;
    });
    return props;
}

function buildSerialLabelFromUdev(devName, props = {}) {
    const vendor = props.ID_VENDOR_FROM_DATABASE || props.ID_VENDOR || '';
    const model = props.ID_MODEL_FROM_DATABASE || props.ID_MODEL || '';
    const serial = props.ID_SERIAL_SHORT || '';
    let label = [vendor, model].filter(Boolean).join(' ').trim() || devName;
    if (serial) label = `${label} (${serial})`;
    return label;
}

function scheduleLinuxSerialMetadataRefresh() {
    if (process.platform !== 'linux') return;
    const now = Date.now();
    if (linuxSerialMetaProbeInFlight) return;
    if ((now - Number(linuxSerialMetaCache.at || 0)) < SERIAL_UDEV_CACHE_MS && Object.keys(linuxSerialMetaCache.byPath || {}).length) {
        return;
    }
    linuxSerialMetaProbeInFlight = true;
    let devEntries = [];
    try {
        devEntries = fs.readdirSync('/dev').filter(name => /^tty(USB|ACM)\d+$/i.test(name));
    } catch (e) {
        devEntries = [];
    }
    void (async () => {
        try {
            const byPath = {};
            await Promise.all(devEntries.map(async (name) => {
                const devPath = `/dev/${name}`;
                const res = await runCommandCaptureAsync('udevadm', ['info', '--query=property', `--name=${devPath}`], 1200);
                if (!res.ok || !res.stdout) return;
                const props = parseUdevProperties(res.stdout);
                byPath[devPath] = {
                    label: buildSerialLabelFromUdev(name, props),
                    props
                };
            }));
            linuxSerialMetaCache = { at: Date.now(), byPath };
        } catch (e) {
        } finally {
            linuxSerialMetaProbeInFlight = false;
        }
    })();
}

function normalizeDmxAdapterInfo(raw) {
    if (!raw || !raw.connected) {
        return { connected: false, label: 'No adapter connected', port: null, source: null };
    }
    return {
        connected: true,
        label: raw.label || 'USB DMX adapter',
        port: raw.port || null,
        source: raw.source || null
    };
}

function normalizeZigbeeAdapterInfo(raw) {
    if (!raw || !raw.connected) {
        return { connected: false, label: 'No adapter connected', port: null, source: null };
    }
    return {
        connected: true,
        label: raw.label || 'USB Zigbee adapter',
        port: raw.port || null,
        source: raw.source || null
    };
}

function detectDmxAdapterLinux() {
    scheduleLinuxSerialMetadataRefresh();
    const candidates = [];
    const seenPorts = new Set();
    const addCandidate = (candidate) => {
        if (!candidate) return;
        const key = (candidate.port || candidate.label || '').toLowerCase();
        if (key && seenPorts.has(key)) return;
        if (key) seenPorts.add(key);
        const text = `${candidate.label || ''} ${candidate.port || ''} ${candidate.source || ''}`;
        candidates.push({ ...candidate, score: scoreDmxCandidateText(text) });
    };

    const byIdDir = '/dev/serial/by-id';
    if (fs.existsSync(byIdDir)) {
        try {
            const entries = fs.readdirSync(byIdDir);
            entries.forEach(name => {
                const abs = path.join(byIdDir, name);
                let realPath = abs;
                try { realPath = fs.realpathSync(abs); } catch (e) {}
                addCandidate({
                    label: name.replace(/_/g, ' '),
                    port: realPath,
                    source: 'linux-by-id'
                });
            });
            // Fast path: if by-id already contains a strong DMX match, skip
            // slower udev scanning of every tty device.
            const bestById = candidates
                .filter(c => c.source === 'linux-by-id')
                .sort((a, b) => b.score - a.score)[0];
            if (bestById && bestById.score >= 100) {
                return normalizeDmxAdapterInfo({
                    connected: true,
                    label: bestById.label,
                    port: bestById.port,
                    source: bestById.source
                });
            }
        } catch (e) {}
    }

    const udevByPath = linuxSerialMetaCache.byPath || {};
    try {
        const devEntries = fs.readdirSync('/dev').filter(name => /^tty(USB|ACM)\d+$/i.test(name));
        devEntries.forEach(name => {
            const devPath = `/dev/${name}`;
            const meta = udevByPath[devPath];
            const label = meta?.label || name;
            addCandidate({
                label,
                port: devPath,
                source: 'linux-tty'
            });
        });
    } catch (e) {}

    if (!candidates.length) return normalizeDmxAdapterInfo(null);

    candidates.sort((a, b) => b.score - a.score);
    const strongest = candidates[0];
    if (strongest.score >= 100) {
        return normalizeDmxAdapterInfo({ connected: true, label: strongest.label, port: strongest.port, source: strongest.source });
    }
    const lowScoreCandidates = candidates.filter(c => c.score >= 12);
    if (lowScoreCandidates.length === 1) {
        const picked = lowScoreCandidates[0];
        return normalizeDmxAdapterInfo({ connected: true, label: picked.label, port: picked.port, source: picked.source });
    }
    return normalizeDmxAdapterInfo(null);
}

function detectZigbeeAdapterLinux() {
    scheduleLinuxSerialMetadataRefresh();
    const candidates = [];
    const seenPorts = new Set();
    const addCandidate = (candidate) => {
        if (!candidate) return;
        const key = (candidate.port || candidate.label || '').toLowerCase();
        if (key && seenPorts.has(key)) return;
        if (key) seenPorts.add(key);
        const text = `${candidate.label || ''} ${candidate.port || ''} ${candidate.source || ''}`;
        candidates.push({ ...candidate, score: scoreZigbeeCandidateText(text) });
    };

    const byIdDir = '/dev/serial/by-id';
    if (fs.existsSync(byIdDir)) {
        try {
            const entries = fs.readdirSync(byIdDir);
            entries.forEach(name => {
                const abs = path.join(byIdDir, name);
                let realPath = abs;
                try { realPath = fs.realpathSync(abs); } catch (e) {}
                addCandidate({
                    label: name.replace(/_/g, ' '),
                    port: realPath,
                    source: 'linux-by-id'
                });
            });
            // Fast path: if by-id already contains a strong Zigbee match, skip
            // slower udev scanning of every tty device.
            const bestById = candidates
                .filter(c => c.source === 'linux-by-id')
                .sort((a, b) => b.score - a.score)[0];
            if (bestById && bestById.score >= 100) {
                return normalizeZigbeeAdapterInfo({
                    connected: true,
                    label: bestById.label,
                    port: bestById.port,
                    source: bestById.source
                });
            }
        } catch (e) {}
    }

    const udevByPath = linuxSerialMetaCache.byPath || {};
    try {
        const devEntries = fs.readdirSync('/dev').filter(name => /^tty(USB|ACM)\d+$/i.test(name));
        devEntries.forEach(name => {
            const devPath = `/dev/${name}`;
            const meta = udevByPath[devPath];
            const label = meta?.label || name;
            addCandidate({
                label,
                port: devPath,
                source: 'linux-tty'
            });
        });
    } catch (e) {}

    if (!candidates.length) return normalizeZigbeeAdapterInfo(null);

    candidates.sort((a, b) => b.score - a.score);
    const strongest = candidates[0];
    if (strongest.score >= 100) {
        return normalizeZigbeeAdapterInfo({ connected: true, label: strongest.label, port: strongest.port, source: strongest.source });
    }
    const lowScoreCandidates = candidates.filter(c => c.score >= 12);
    if (lowScoreCandidates.length === 1) {
        const picked = lowScoreCandidates[0];
        return normalizeZigbeeAdapterInfo({ connected: true, label: picked.label, port: picked.port, source: picked.source });
    }
    return normalizeZigbeeAdapterInfo(null);
}

function detectDmxAdapter() {
    try {
        if (process.platform === 'linux') return detectDmxAdapterLinux();
        return normalizeDmxAdapterInfo(null);
    } catch (e) {
        return normalizeDmxAdapterInfo(null);
    }
}

function detectZigbeeAdapter() {
    try {
        if (process.platform === 'linux') return detectZigbeeAdapterLinux();
        return normalizeZigbeeAdapterInfo(null);
    } catch (e) {
        return normalizeZigbeeAdapterInfo(null);
    }
}

function parseAlsaDefaultDeviceFromText(text) {
    const raw = String(text || "");
    const match = raw.match(/slave\.pcm\s+"([^"]+)"/i);
    if (match && match[1]) return match[1].trim();
    const cardMatch = raw.match(/card\s+([^\s]+)/i);
    if (cardMatch && cardMatch[1]) return `hw:CARD=${String(cardMatch[1]).trim()}`;
    return null;
}

function readConfiguredAlsaDefaultDeviceLinux() {
    const paths = ['/etc/asound.conf', '/home/admin/.asoundrc'];
    for (const p of paths) {
        try {
            if (!fs.existsSync(p)) continue;
            const txt = fs.readFileSync(p, 'utf8');
            const parsed = parseAlsaDefaultDeviceFromText(txt);
            if (parsed) return { device: parsed, source: p };
        } catch (e) {}
    }
    return { device: null, source: null };
}

function listAlsaCardsLinux() {
    try {
        const raw = fs.readFileSync('/proc/asound/cards', 'utf8');
        const lines = raw.split(/\r?\n/);
        const cards = [];
        for (const line of lines) {
            const m = line.match(/^\s*(\d+)\s+\[([^\]]+)\]\s*:\s*(.+)$/);
            if (!m) continue;
            cards.push({
                index: Number.parseInt(m[1], 10),
                id: String(m[2] || '').trim(),
                description: String(m[3] || '').trim()
            });
        }
        return cards;
    } catch (e) {
        return [];
    }
}

function detectSoundOutputLinux() {
    const configured = readConfiguredAlsaDefaultDeviceLinux();
    const cards = listAlsaCardsLinux();
    const hasUc02 = cards.some((c) => String(c.id || '').toUpperCase() === 'UC02');
    if (configured.device) {
        return {
            available: true,
            device: configured.device,
            source: configured.source,
            status: `Configured: ${configured.device}`,
            cards
        };
    }
    if (hasUc02) {
        return {
            available: true,
            device: 'plughw:CARD=UC02,DEV=0',
            source: 'detected',
            status: 'Detected UC02 (using system default)',
            cards
        };
    }
    return {
        available: cards.length > 0,
        device: null,
        source: null,
        status: cards.length ? 'Using system default' : 'No ALSA cards detected',
        cards
    };
}

function getSoundOutputInfo() {
    const now = Date.now();
    if (soundOutputCache.info && (now - soundOutputCache.at) < SOUND_OUTPUT_CACHE_MS) {
        return soundOutputCache.info;
    }
    const info = process.platform === 'linux'
        ? detectSoundOutputLinux()
        : { available: false, device: null, source: null, status: 'Unsupported', cards: [] };
    soundOutputCache = { at: now, info };
    return info;
}

function getDmxAdapterInfo() {
    const now = Date.now();
    if (dmxAdapterCache.info && (now - dmxAdapterCache.at) < DMX_ADAPTER_CACHE_MS) {
        return dmxAdapterCache.info;
    }
    const info = detectDmxAdapter();
    dmxAdapterCache = { at: now, info };
    return info;
}

function getZigbeeAdapterInfo() {
    const now = Date.now();
    if (zigbeeAdapterCache.info && (now - zigbeeAdapterCache.at) < ZIGBEE_ADAPTER_CACHE_MS) {
        return zigbeeAdapterCache.info;
    }
    const info = detectZigbeeAdapter();
    zigbeeAdapterCache = { at: now, info };
    return info;
}

function normalizeZigbeeKey(value) {
    return String(value || "").trim().toLowerCase();
}

function normalizeZigbeeFriendlyName(value, fallback = "") {
    const raw = String(value || fallback || "").trim();
    if (!raw) return "";
    return raw.replace(/\s+/g, "_");
}

function normalizeZigbeeSignalEntries(rawEntries, fallbackSeenAt = Date.now()) {
    if (!Array.isArray(rawEntries)) return [];
    const map = new Map();
    rawEntries.forEach((entry) => {
        const key = String(entry?.key || entry?.label || "").trim();
        if (!key || key.startsWith("_")) return;
        const label = String(entry?.label || key).trim() || key;
        const value = String(entry?.value ?? "").trim();
        const lastSeenRaw = Number(entry?.lastSeen);
        const lastSeen = Number.isFinite(lastSeenRaw) && lastSeenRaw > 0 ? lastSeenRaw : fallbackSeenAt;
        map.set(key, { key, label, value, lastSeen });
    });
    return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));
}

function extractZigbeeSignalEntriesFromPayload(payload, seenAt = Date.now()) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
    const entries = [];
    Object.keys(payload).forEach((rawKey) => {
        const key = String(rawKey || "").trim();
        if (!key || key.startsWith("_")) return;
        const value = payload[key];
        const valueType = typeof value;
        if (value == null || valueType === "object" || valueType === "function" || valueType === "undefined") return;
        let valueText = "";
        if (valueType === "string") valueText = value;
        else if (valueType === "number" || valueType === "boolean") valueText = String(value);
        else return;
        entries.push({
            key,
            label: key,
            value: valueText.trim(),
            lastSeen: seenAt
        });
    });
    return entries.sort((a, b) => a.label.localeCompare(b.label));
}

function mergeZigbeeSignalEntries(existingEntries, incomingEntries, seenAt = Date.now()) {
    const map = new Map();
    normalizeZigbeeSignalEntries(existingEntries, seenAt).forEach((entry) => {
        map.set(entry.key, { ...entry });
    });
    normalizeZigbeeSignalEntries(incomingEntries, seenAt).forEach((entry) => {
        const current = map.get(entry.key);
        map.set(entry.key, {
            key: entry.key,
            label: entry.label || current?.label || entry.key,
            value: entry.value,
            lastSeen: Number.isFinite(Number(entry.lastSeen)) ? Number(entry.lastSeen) : seenAt
        });
    });
    return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));
}

function rebuildZigbeeFriendlyIndex() {
    zigbeeFriendlyIndex = {};
    Object.values(zigbeeDevices || {}).forEach((entry) => {
        const normalizedFriendly = normalizeZigbeeKey(entry?.friendlyName);
        if (normalizedFriendly) zigbeeFriendlyIndex[normalizedFriendly] = entry.id;
    });
}

function serializeZigbeeDeviceCache() {
    const devices = Object.values(zigbeeDevices || {}).map((entry) => ({
        id: entry?.id || null,
        friendlyName: entry?.friendlyName || null,
        ieeeAddress: entry?.ieeeAddress || null,
        vendor: entry?.vendor || null,
        model: entry?.model || null,
        type: entry?.type || "unknown",
        description: entry?.description || null,
        battery: entry?.battery ?? null,
        online: entry?.online === true,
        resetOnPuzzleReset: entry?.resetOnPuzzleReset === true,
        lastSeen: Number(entry?.lastSeen) || 0,
        lastTopic: entry?.lastTopic || null,
        lastPayload: entry?.lastPayload ?? null,
        messageEntries: normalizeZigbeeSignalEntries(entry?.messageEntries, Number(entry?.lastSeen) || Date.now())
    }));
    return {
        devices,
        hiddenDeviceIds: Array.from(zigbeeHiddenDeviceIds || [])
    };
}

async function persistZigbeeDeviceCacheNow() {
    const payload = serializeZigbeeDeviceCache();
    try {
        await db.run(
            "INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)",
            [SETTINGS_KEYS.zigbeeDeviceCache, JSON.stringify(payload)]
        );
    } catch (err) {}
}

function schedulePersistZigbeeDeviceCache() {
    if (zigbeeCachePersistTimer) {
        clearTimeout(zigbeeCachePersistTimer);
    }
    zigbeeCachePersistTimer = setTimeout(() => {
        zigbeeCachePersistTimer = null;
        persistZigbeeDeviceCacheNow().catch(() => {});
    }, ZIGBEE_CACHE_PERSIST_DELAY_MS);
}

function restoreZigbeeDeviceCache(rawJson) {
    if (!rawJson || typeof rawJson !== "string") return;
    try {
        const parsed = JSON.parse(rawJson);
        const rows = Array.isArray(parsed?.devices) ? parsed.devices : [];
        zigbeeDevices = {};
        rows.forEach((row) => {
            const id = String(row?.id || "").trim();
            if (!id) return;
            const now = Date.now();
            zigbeeDevices[id] = {
                id,
                friendlyName: normalizeZigbeeFriendlyName(row?.friendlyName || id),
                ieeeAddress: String(row?.ieeeAddress || "").trim() || null,
                vendor: String(row?.vendor || "").trim() || null,
                model: String(row?.model || "").trim() || null,
                type: String(row?.type || "unknown").trim() || "unknown",
                description: String(row?.description || "").trim() || null,
                battery: Number.isFinite(Number(row?.battery)) ? Number(row.battery) : null,
                online: row?.online === true,
                resetOnPuzzleReset: row?.resetOnPuzzleReset === true,
                lastSeen: Number.isFinite(Number(row?.lastSeen)) ? Number(row.lastSeen) : now,
                lastTopic: String(row?.lastTopic || "").trim() || null,
                lastPayload: row?.lastPayload ?? null,
                messageEntries: normalizeZigbeeSignalEntries(row?.messageEntries, Number(row?.lastSeen) || now)
            };
        });
        zigbeeHiddenDeviceIds = new Set(
            (Array.isArray(parsed?.hiddenDeviceIds) ? parsed.hiddenDeviceIds : [])
                .map((entry) => String(entry || "").trim())
                .filter(Boolean)
        );
        rebuildZigbeeFriendlyIndex();
    } catch (err) {}
}

function pushZigbeeMessageLog(topic, rawText) {
    const text = String(rawText || "").replace(/\s+/g, " ").trim();
    const short = text.length > 360 ? `${text.slice(0, 357)}...` : text;
    zigbeeMessageLogs.unshift({
        at: Date.now(),
        topic: String(topic || ""),
        text: short
    });
    if (zigbeeMessageLogs.length > ZIGBEE_LOG_LIMIT) {
        zigbeeMessageLogs.length = ZIGBEE_LOG_LIMIT;
    }
}

function pickZigbeeDeviceId(raw = {}, fallbackFriendly = "") {
    const ieee = String(raw?.ieeeAddress || raw?.ieee_address || "").trim();
    if (ieee) return ieee;
    const fromRaw = String(raw?.id || raw?.deviceId || "").trim();
    if (fromRaw) return fromRaw;
    const friendly = normalizeZigbeeFriendlyName(raw?.friendlyName || raw?.friendly_name, fallbackFriendly);
    if (friendly) return `name:${friendly}`;
    return "";
}

function upsertZigbeeDevice(raw = {}, options = {}) {
    const fallbackFriendly = normalizeZigbeeFriendlyName(options.fallbackFriendlyName || "");
    const deviceId = pickZigbeeDeviceId(raw, fallbackFriendly);
    if (!deviceId) return null;

    const existing = zigbeeDevices[deviceId] || {};
    const friendlyName = normalizeZigbeeFriendlyName(
        raw?.friendlyName || raw?.friendly_name || existing.friendlyName || fallbackFriendly
    );
    const ieeeAddress = String(raw?.ieeeAddress || raw?.ieee_address || existing.ieeeAddress || "").trim() || null;
    const vendor = String(raw?.vendor || raw?.manufacturer || raw?.definition?.vendor || existing.vendor || "").trim() || null;
    const model = String(raw?.model || raw?.definition?.model || existing.model || "").trim() || null;
    const type = String(raw?.type || existing.type || "unknown").trim() || "unknown";
    const description = String(raw?.description || existing.description || "").trim() || null;
    const batteryCandidate = raw?.battery ?? raw?.lastPayload?.battery;
    const parsedBattery = Number(batteryCandidate);
    const battery = Number.isFinite(parsedBattery)
        ? Math.max(0, Math.min(100, Math.round(parsedBattery)))
        : (Number.isFinite(Number(existing?.battery)) ? Number(existing.battery) : null);
    const now = Date.now();
    const onlineRaw = raw?.online;
    const online = onlineRaw === undefined || onlineRaw === null
        ? (existing.online !== undefined ? !!existing.online : true)
        : !!onlineRaw;
    const lastSeen = Number.isFinite(raw?.lastSeen) ? raw.lastSeen : now;
    let messageEntries = normalizeZigbeeSignalEntries(existing?.messageEntries, lastSeen);
    if (Array.isArray(raw?.messageEntries)) {
        messageEntries = normalizeZigbeeSignalEntries(raw.messageEntries, lastSeen);
    }
    if (options.captureSignals === true) {
        const captured = extractZigbeeSignalEntriesFromPayload(raw?.lastPayload, lastSeen);
        if (captured.length) {
            messageEntries = mergeZigbeeSignalEntries(messageEntries, captured, lastSeen);
        }
    }
    if (options.resetSignals === true) {
        messageEntries = [];
    }

    zigbeeDevices[deviceId] = {
        id: deviceId,
        friendlyName: friendlyName || existing.friendlyName || deviceId,
        ieeeAddress,
        vendor,
        model,
        type,
        description,
        battery,
        online,
        resetOnPuzzleReset: existing?.resetOnPuzzleReset === true,
        lastSeen,
        lastTopic: options.topic || existing.lastTopic || null,
        lastPayload: raw?.lastPayload !== undefined ? raw.lastPayload : (existing.lastPayload || null),
        messageEntries
    };

    if (options.unhide === true) {
        zigbeeHiddenDeviceIds.delete(deviceId);
    }

    const normalizedFriendly = normalizeZigbeeKey(zigbeeDevices[deviceId].friendlyName);
    if (normalizedFriendly) zigbeeFriendlyIndex[normalizedFriendly] = deviceId;
    schedulePersistZigbeeDeviceCache();
    return zigbeeDevices[deviceId];
}

function findZigbeeDeviceByFriendlyName(friendlyName) {
    const key = normalizeZigbeeKey(friendlyName);
    if (!key) return null;
    const deviceId = zigbeeFriendlyIndex[key];
    if (!deviceId) return null;
    return zigbeeDevices[deviceId] || null;
}

function getZigbeeDevicesSnapshot() {
    const now = Date.now();
    const bridgeSeenRecently = zigbeeBridgeRuntime.lastSeen > 0 && (now - zigbeeBridgeRuntime.lastSeen) < 30000;
    const adapter = getZigbeeAdapterInfo();
    const devices = Object.values(zigbeeDevices)
        .filter((entry) => !zigbeeHiddenDeviceIds.has(entry.id))
        .map((entry) => {
            const ageMs = entry.lastSeen ? Math.max(0, now - entry.lastSeen) : null;
            const online = entry.online === true && ageMs !== null ? ageMs < 120000 : !!entry.online;
            return {
                ...entry,
                online,
                ageMs
            };
        })
        .sort((a, b) => {
            const aName = (a.friendlyName || a.id || "").toLowerCase();
            const bName = (b.friendlyName || b.id || "").toLowerCase();
            return aName.localeCompare(bName);
        });
    const discoveryRemainingMs = Math.max(0, (zigbeeBridgeRuntime.discoveryUntil || 0) - now);
    return {
        bridgeEnabled: !!systemSettings.zigbeeBridgeEnabled,
        adapterConnected: !!adapter?.connected,
        bridgeState: zigbeeBridgeRuntime.state || "unknown",
        bridgeSeenRecently,
        discoveryActive: discoveryRemainingMs > 0,
        discoveryRemainingSec: Math.ceil(discoveryRemainingMs / 1000),
        devices,
        logs: zigbeeMessageLogs,
        triggers: Array.isArray(zigbeeMessageTriggers?.triggers) ? zigbeeMessageTriggers.triggers : []
    };
}

function normalizeZigbeeMessageTriggers() {
    const cfg = graph?.config || (graph.config = {});
    const source = cfg.zigbee && typeof cfg.zigbee === 'object' ? cfg.zigbee : {};
    const rawTriggers = Array.isArray(source.triggers) ? source.triggers : [];
    let maxId = 0;
    const nextTriggers = rawTriggers
        .map((entry, idx) => {
            const parsedId = parseInt(entry?.id, 10);
            const id = Number.isFinite(parsedId) && parsedId > 0 ? parsedId : (idx + 1);
            maxId = Math.max(maxId, id);
            const name = String(entry?.name || `Trigger_${id}`).trim() || `Trigger_${id}`;
            const deviceId = String(entry?.deviceId || '').trim();
            const messageKey = String(entry?.messageKey || '').trim();
            if (!deviceId || !messageKey) return null;
            return { id, name, deviceId, messageKey };
        })
        .filter(Boolean);
    const nextRaw = parseInt(source.nextTriggerId, 10);
    const nextTriggerId = Number.isFinite(nextRaw) && nextRaw > maxId ? nextRaw : (maxId + 1);
    zigbeeMessageTriggers = { nextTriggerId, triggers: nextTriggers };
    cfg.zigbee = {
        ...(cfg.zigbee && typeof cfg.zigbee === 'object' ? cfg.zigbee : {}),
        nextTriggerId,
        triggers: nextTriggers
    };
    return zigbeeMessageTriggers;
}

function syncZigbeeTriggerConfigToGraph() {
    const cfg = graph?.config || (graph.config = {});
    cfg.zigbee = {
        ...(cfg.zigbee && typeof cfg.zigbee === 'object' ? cfg.zigbee : {}),
        nextTriggerId: zigbeeMessageTriggers.nextTriggerId,
        triggers: Array.isArray(zigbeeMessageTriggers.triggers) ? zigbeeMessageTriggers.triggers : []
    };
}

function upsertZigbeeMessageTrigger(payload = {}) {
    normalizeZigbeeMessageTriggers();
    const name = String(payload?.name || '').trim();
    const deviceId = String(payload?.deviceId || '').trim();
    const messageKey = String(payload?.messageKey || '').trim();
    if (!name) return { success: false, error: 'Trigger name required' };
    if (!deviceId) return { success: false, error: 'Device required' };
    if (!messageKey) return { success: false, error: 'Message required' };

    const idRaw = parseInt(payload?.id, 10);
    if (Number.isFinite(idRaw) && idRaw > 0) {
        const idx = zigbeeMessageTriggers.triggers.findIndex((entry) => entry.id === idRaw);
        if (idx === -1) return { success: false, error: 'Trigger not found' };
        zigbeeMessageTriggers.triggers[idx] = { id: idRaw, name, deviceId, messageKey };
        syncZigbeeTriggerConfigToGraph();
        return { success: true, trigger: zigbeeMessageTriggers.triggers[idx] };
    }

    const nextId = Number.isFinite(parseInt(zigbeeMessageTriggers.nextTriggerId, 10))
        ? parseInt(zigbeeMessageTriggers.nextTriggerId, 10)
        : 1;
    const trigger = { id: nextId, name, deviceId, messageKey };
    zigbeeMessageTriggers.triggers.push(trigger);
    zigbeeMessageTriggers.nextTriggerId = nextId + 1;
    syncZigbeeTriggerConfigToGraph();
    return { success: true, trigger };
}

function deleteZigbeeMessageTrigger(triggerIdRaw) {
    normalizeZigbeeMessageTriggers();
    const triggerId = parseInt(triggerIdRaw, 10);
    if (!Number.isFinite(triggerId)) return { success: false, error: 'triggerId required' };
    const before = zigbeeMessageTriggers.triggers.length;
    zigbeeMessageTriggers.triggers = zigbeeMessageTriggers.triggers.filter((entry) => entry.id !== triggerId);
    if (zigbeeMessageTriggers.triggers.length === before) {
        return { success: false, error: 'Trigger not found' };
    }
    syncZigbeeTriggerConfigToGraph();
    return { success: true };
}

function publishZigbeeBridgeRequest(pathSuffix, payload = {}) {
    const suffix = String(pathSuffix || "").replace(/^\/+/, "");
    if (!suffix) return false;
    const topic = `zigbee2mqtt/bridge/request/${suffix}`;
    try {
        mqttClient.publish(topic, JSON.stringify(payload || {}));
        return true;
    } catch (err) {
        return false;
    }
}

function requestZigbeeDevicesRefresh() {
    publishZigbeeBridgeRequest("devices", {});
}

function startZigbeeDiscovery(durationSec = 60) {
    const seconds = clampDmxInt(durationSec, 5, 600, 60);
    const ok = publishZigbeeBridgeRequest("permit_join", { value: true, time: seconds });
    if (ok) {
        zigbeeBridgeRuntime.discoveryUntil = Date.now() + (seconds * 1000);
        requestZigbeeDevicesRefresh();
    }
    return { success: ok, discoveryActive: ok, durationSec: seconds };
}

function stopZigbeeDiscovery() {
    const ok = publishZigbeeBridgeRequest("permit_join", { value: false });
    zigbeeBridgeRuntime.discoveryUntil = 0;
    return { success: ok, discoveryActive: false };
}

function processZigbeeMqttMessage(topic, payload, rawText = "") {
    if (!topic || !topic.startsWith(ZIGBEE_TOPIC_PREFIX)) return false;
    pushZigbeeMessageLog(topic, rawText);
    zigbeeBridgeRuntime.lastSeen = Date.now();
    if (topic === ZIGBEE_BRIDGE_DEVICES_TOPIC && Array.isArray(payload)) {
        logSystem(`Zigbee ${topic} (${payload.length} devices)`, "zigbee");
    } else {
        logSystem(`Zigbee ${topic}`, "zigbee", { topic, payload });
    }

    if (topic === ZIGBEE_BRIDGE_STATE_TOPIC) {
        const stateText = typeof payload === "string"
            ? payload
            : String(payload?.state || rawText || "unknown");
        zigbeeBridgeRuntime.state = stateText.trim() || "unknown";
        scheduleZigbeeRealtimeUpdate({ topic, bridgeState: zigbeeBridgeRuntime.state });
        return true;
    }

    if (topic === ZIGBEE_BRIDGE_DEVICES_TOPIC && Array.isArray(payload)) {
        payload.forEach((entry) => {
            if (!entry || typeof entry !== "object") return;
            const mapped = {
                id: entry.ieee_address || null,
                friendlyName: entry.friendly_name || null,
                ieeeAddress: entry.ieee_address || null,
                vendor: entry.definition?.vendor || null,
                model: entry.definition?.model || null,
                type: entry.type || "unknown",
                description: entry.description || null,
                battery: entry.battery,
                online: entry.interview_completed === false ? false : true,
                lastPayload: entry
            };
            upsertZigbeeDevice(mapped, { topic });
        });
        return true;
    }

    if (topic.startsWith(ZIGBEE_BRIDGE_RESPONSE_PREFIX) && payload && typeof payload === "object") {
        const responseType = topic.slice(ZIGBEE_BRIDGE_RESPONSE_PREFIX.length);
        if (responseType === "devices" && Array.isArray(payload?.data)) {
            payload.data.forEach((entry) => {
                if (!entry || typeof entry !== "object") return;
                const mapped = {
                    id: entry.ieee_address || null,
                    friendlyName: entry.friendly_name || null,
                    ieeeAddress: entry.ieee_address || null,
                    vendor: entry.definition?.vendor || null,
                    model: entry.definition?.model || null,
                    type: entry.type || "unknown",
                    description: entry.description || null,
                    battery: entry.battery,
                    online: entry.interview_completed === false ? false : true,
                    lastPayload: entry
                };
                upsertZigbeeDevice(mapped, { topic });
            });
        }
        if (responseType === "permit_join") {
            const rawValue = payload?.data?.value ?? payload?.data?.permit_join;
            if (rawValue === false || rawValue === 0 || rawValue === "false" || rawValue === "0") {
                zigbeeBridgeRuntime.discoveryUntil = 0;
            }
        }
        return true;
    }

    if (topic === ZIGBEE_BRIDGE_EVENT_TOPIC && payload && typeof payload === "object") {
        const data = payload?.data && typeof payload.data === "object" ? payload.data : null;
        const friendly = data?.friendly_name || data?.friendlyName || payload?.friendly_name || payload?.friendlyName || "";
        const ieee = data?.ieee_address || data?.ieeeAddress || payload?.ieee_address || payload?.ieeeAddress || "";
        if (friendly || ieee) {
            const updated = upsertZigbeeDevice({
                id: ieee || null,
                friendlyName: friendly || null,
                ieeeAddress: ieee || null,
                battery: data?.battery ?? payload?.battery,
                lastPayload: payload
            }, { topic, fallbackFriendlyName: friendly, unhide: true });
            const deviceId = updated?.id || ieee || null;
            if (deviceId) {
                dispatchZigbeeSensorDataEvent(deviceId, payload, { topic, source: "bridge_event" });
                scheduleZigbeeRealtimeUpdate({ topic, deviceId, friendlyName: friendly || updated?.friendlyName || '' });
            }
        }
        return true;
    }

    const subPath = topic.slice(ZIGBEE_TOPIC_PREFIX.length);
    const firstSlash = subPath.indexOf("/");
    const friendly = firstSlash >= 0 ? subPath.slice(0, firstSlash) : subPath;
    const subTopic = firstSlash >= 0 ? subPath.slice(firstSlash + 1) : "";
    if (!friendly || friendly === "bridge") return true;
    if (subTopic === "set") return true;

    const existing = findZigbeeDeviceByFriendlyName(friendly);
    // Ignore unknown topic-friendly names here; device inventory should come from bridge/devices.
    // This avoids accidental duplicate entries while a rename is still propagating.
    if (!existing) return true;
    const nextOnline = subTopic === "availability"
        ? String(payload?.state || rawText || "").toLowerCase() === "online"
        : (existing?.online !== undefined ? existing.online : true);
    const updated = upsertZigbeeDevice({
        id: existing?.id || null,
        friendlyName: friendly,
        ieeeAddress: existing?.ieeeAddress || null,
        vendor: existing?.vendor || null,
        model: existing?.model || null,
        type: existing?.type || "unknown",
        description: existing?.description || null,
        battery: payload?.battery ?? existing?.battery ?? null,
        online: nextOnline,
        lastPayload: payload
    }, { topic, fallbackFriendlyName: friendly, unhide: true, captureSignals: subTopic !== "availability" });
    if (subTopic !== "availability") {
        const deviceId = updated?.id || existing?.id || null;
        if (deviceId) {
            dispatchZigbeeSensorDataEvent(deviceId, payload, { topic, source: "sensor_topic", subTopic });
            scheduleZigbeeRealtimeUpdate({ topic, deviceId, friendlyName: updated?.friendlyName || friendly });
        }
    }
    return true;
}

function clampDmxInt(value, min, max, fallback) {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function normalizeScriptingRules(node) {
    if (!node || !node.properties) return [];
    const rawRules = Array.isArray(node.properties.scriptingRules)
        ? node.properties.scriptingRules
        : (Array.isArray(node.properties.automationRules) ? node.properties.automationRules : []);
    return rawRules.map((rule) => ({
        triggerType: (() => {
            const raw = String(rule?.triggerType || '').trim().toLowerCase();
            return raw === 'on_activate' ? 'on_running' : raw;
        })(),
        id: Number.isFinite(Number(rule?.id)) ? Number(rule.id) : null,
        triggerValue: String(rule?.triggerValue || ''),
        triggerField: String(rule?.triggerField || ''),
        triggerExpected: String(rule?.triggerExpected || ''),
        conditionType: String(rule?.conditionType || 'none').trim().toLowerCase(),
        conditionVar: String(rule?.conditionVar || ''),
        conditionField: String(rule?.conditionField || ''),
        conditionExpr: (rule?.conditionExpr && typeof rule.conditionExpr === 'object' && !Array.isArray(rule.conditionExpr))
            ? rule.conditionExpr
            : null,
        conditionOp: String(rule?.conditionOp || 'eq').trim().toLowerCase(),
        conditionValue: String(rule?.conditionValue || ''),
        actionType: String(rule?.actionType || '').trim().toLowerCase(),
        actionValue: String(rule?.actionValue || ''),
        actionTargetPuzzle: String(rule?.actionTargetPuzzle || ''),
        actionExpr: (rule?.actionExpr && typeof rule.actionExpr === 'object' && !Array.isArray(rule.actionExpr))
            ? rule.actionExpr
            : null,
        actionSourceDevice: String(rule?.actionSourceDevice || ''),
        actionSourceField: String(rule?.actionSourceField || ''),
        loopMode: String(rule?.loopMode || '').trim().toLowerCase() === 'forever' ? 'forever' : '',
        loopIntervalSec: Number.isFinite(Number(rule?.loopIntervalSec)) ? Math.max(0.2, Number(rule.loopIntervalSec)) : 1,
        loopStack: Array.isArray(rule?.loopStack)
            ? rule.loopStack.map((entry) => ({
                type: String(entry?.type || '').trim().toLowerCase(),
                key: String(entry?.key || ''),
                iter: Number.isFinite(Number(entry?.iter)) ? Number(entry.iter) : null
            }))
            : [],
        loopBreakKey: String(rule?.loopBreakKey || ''),
        loopBreakType: String(rule?.loopBreakType || '').trim().toLowerCase()
    }));
}

function hasScriptingBlocks(node) {
    if (!node || !node.properties) return false;
    const blockState = node.properties.scriptingBlocklyState;
    const topBlocks = blockState?.blocks?.blocks;
    if (Array.isArray(topBlocks) && topBlocks.length > 0) return true;
    const rules = Array.isArray(node.properties.scriptingRules)
        ? node.properties.scriptingRules
        : (Array.isArray(node.properties.automationRules) ? node.properties.automationRules : []);
    return rules.length > 0;
}

function normalizeRoomScriptingRules() {
    const rawRules = Array.isArray(graph?.config?.roomScripting?.rules) ? graph.config.roomScripting.rules : [];
    return rawRules.map((rule) => ({
        id: Number.isFinite(Number(rule?.id)) ? Number(rule.id) : null,
        triggerType: String(rule?.triggerType || '').trim().toLowerCase(),
        triggerValue: String(rule?.triggerValue || ''),
        triggerField: String(rule?.triggerField || ''),
        triggerExpected: String(rule?.triggerExpected || ''),
        conditionType: String(rule?.conditionType || 'none').trim().toLowerCase(),
        conditionVar: String(rule?.conditionVar || ''),
        conditionField: String(rule?.conditionField || ''),
        conditionExpr: (rule?.conditionExpr && typeof rule.conditionExpr === 'object' && !Array.isArray(rule.conditionExpr))
            ? rule.conditionExpr
            : null,
        conditionOp: String(rule?.conditionOp || 'eq').trim().toLowerCase(),
        conditionValue: String(rule?.conditionValue || ''),
        actionType: String(rule?.actionType || '').trim().toLowerCase(),
        actionValue: String(rule?.actionValue || ''),
        actionTargetPuzzle: String(rule?.actionTargetPuzzle || ''),
        actionExpr: (rule?.actionExpr && typeof rule.actionExpr === 'object' && !Array.isArray(rule.actionExpr))
            ? rule.actionExpr
            : null,
        actionSourceDevice: String(rule?.actionSourceDevice || ''),
        actionSourceField: String(rule?.actionSourceField || ''),
        loopMode: String(rule?.loopMode || '').trim().toLowerCase() === 'forever' ? 'forever' : '',
        loopIntervalSec: Number.isFinite(Number(rule?.loopIntervalSec)) ? Math.max(0.2, Number(rule.loopIntervalSec)) : 1,
        loopStack: Array.isArray(rule?.loopStack)
            ? rule.loopStack.map((entry) => ({
                type: String(entry?.type || '').trim().toLowerCase(),
                key: String(entry?.key || ''),
                iter: Number.isFinite(Number(entry?.iter)) ? Number(entry.iter) : null
            }))
            : [],
        loopBreakKey: String(rule?.loopBreakKey || ''),
        loopBreakType: String(rule?.loopBreakType || '').trim().toLowerCase()
    }));
}

function hasRoomScriptingBlocks() {
    const roomScripting = graph?.config?.roomScripting;
    const topBlocks = roomScripting?.blocklyState?.blocks?.blocks;
    if (Array.isArray(topBlocks) && topBlocks.length > 0) return true;
    const rules = Array.isArray(roomScripting?.rules) ? roomScripting.rules : [];
    return rules.length > 0;
}

function getPuzzleVariableMap(puzzleId) {
    const key = parseInt(puzzleId, 10);
    if (!Number.isFinite(key)) return {};
    if (!puzzleScriptingVariables[key] || typeof puzzleScriptingVariables[key] !== 'object') {
        puzzleScriptingVariables[key] = {};
    }
    return puzzleScriptingVariables[key];
}

function parseScriptingComparable(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return '';
    const asNum = Number(raw);
    if (Number.isFinite(asNum)) return asNum;
    return raw;
}

function compareScriptingValues(leftRaw, op, rightRaw) {
    const left = parseScriptingComparable(leftRaw);
    const right = parseScriptingComparable(rightRaw);
    if (op === 'eq') return String(left) === String(right);
    if (op === 'neq') return String(left) !== String(right);
    if (typeof left === 'number' && typeof right === 'number') {
        if (op === 'gt') return left > right;
        if (op === 'gte') return left >= right;
        if (op === 'lt') return left < right;
        if (op === 'lte') return left <= right;
    }
    return false;
}

function extractSensorDataMap(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
    const out = {};
    Object.keys(payload).forEach((key) => {
        const safeKey = String(key || '').trim();
        if (!safeKey || safeKey.startsWith('_')) return;
        const value = payload[safeKey];
        const type = typeof value;
        if (value == null) return;
        if (type === 'string' || type === 'number' || type === 'boolean') {
            out[safeKey] = value;
        }
    });
    return out;
}

function getSensorFieldValue(eventPayload, sourceDeviceId, sourceField) {
    const field = String(sourceField || '').trim();
    if (!field) return '-';
    const eventDevice = String(eventPayload?.sensorDeviceId || '').trim();
    const wantedDevice = String(sourceDeviceId || '').trim();
    if (eventPayload && eventPayload.sensorData && (!wantedDevice || wantedDevice === eventDevice)) {
        if (Object.prototype.hasOwnProperty.call(eventPayload.sensorData, field)) {
            return eventPayload.sensorData[field];
        }
    }

    const scope = String(eventPayload?.scriptScope || '').trim().toLowerCase();
    const deviceKey = wantedDevice || eventDevice;
    if (scope === 'puzzle') {
        const numericPuzzleId = parseInt(eventPayload?.currentPuzzleId, 10);
        if (Number.isFinite(numericPuzzleId)) {
            const byPuzzle = puzzleScriptingSensorInstances[numericPuzzleId];
            const byDevice = byPuzzle && deviceKey ? byPuzzle[deviceKey] : null;
            if (byDevice && Object.prototype.hasOwnProperty.call(byDevice, field)) {
                return byDevice[field];
            }
        }
    } else {
        const byDevice = deviceKey ? roomScriptingSensorInstances[deviceKey] : null;
        if (byDevice && Object.prototype.hasOwnProperty.call(byDevice, field)) {
            return byDevice[field];
        }
    }
    return '-';
}

function updateRoomScriptSensorInstance(deviceId, sensorData = {}) {
    const id = String(deviceId || '').trim();
    if (!id) return;
    const data = sensorData && typeof sensorData === 'object' && !Array.isArray(sensorData) ? sensorData : {};
    if (!roomScriptingSensorInstances[id]) roomScriptingSensorInstances[id] = {};
    Object.keys(data).forEach((key) => {
        roomScriptingSensorInstances[id][key] = data[key];
    });
}

function updatePuzzleScriptSensorInstance(puzzleId, deviceId, sensorData = {}) {
    const numericPuzzleId = parseInt(puzzleId, 10);
    const id = String(deviceId || '').trim();
    if (!Number.isFinite(numericPuzzleId) || !id) return;
    const data = sensorData && typeof sensorData === 'object' && !Array.isArray(sensorData) ? sensorData : {};
    if (!puzzleScriptingSensorInstances[numericPuzzleId]) puzzleScriptingSensorInstances[numericPuzzleId] = {};
    if (!puzzleScriptingSensorInstances[numericPuzzleId][id]) puzzleScriptingSensorInstances[numericPuzzleId][id] = {};
    Object.keys(data).forEach((key) => {
        puzzleScriptingSensorInstances[numericPuzzleId][id][key] = data[key];
    });
}

function resetPuzzleScriptSensorInstanceByPolicy(puzzleId) {
    const numericPuzzleId = parseInt(puzzleId, 10);
    if (!Number.isFinite(numericPuzzleId)) return;
    const byPuzzle = puzzleScriptingSensorInstances[numericPuzzleId];
    if (!byPuzzle || typeof byPuzzle !== 'object') return;
    Object.keys(byPuzzle).forEach((deviceId) => {
        const device = zigbeeDevices[deviceId];
        if (device?.resetOnPuzzleReset === true) {
            delete byPuzzle[deviceId];
            if (roomScriptingSensorInstances[deviceId]) {
                delete roomScriptingSensorInstances[deviceId];
            }
        }
    });
    if (!Object.keys(byPuzzle).length) {
        delete puzzleScriptingSensorInstances[numericPuzzleId];
    }
}

function getLightingFixturesFromGraph() {
    const lighting = graph?.config?.lighting;
    if (!lighting || !Array.isArray(lighting.fixtures)) return [];
    return lighting.fixtures;
}

function getLightingFixtureById(fixtureId) {
    const numericId = parseInt(fixtureId, 10);
    if (!Number.isFinite(numericId)) return null;
    return getLightingFixturesFromGraph().find(fixture => parseInt(fixture?.id, 10) === numericId) || null;
}

function getLightingCueByRef(cueRef) {
    const text = String(cueRef || '').trim();
    if (!text) return null;
    const [fixtureRaw, cueRaw] = text.split(':');
    const fixtureId = parseInt(fixtureRaw, 10);
    const cueId = parseInt(cueRaw, 10);
    if (!Number.isFinite(fixtureId) || !Number.isFinite(cueId)) return null;
    const fixture = getLightingFixtureById(fixtureId);
    if (!fixture || !Array.isArray(fixture.cues)) return null;
    const cue = fixture.cues.find(entry => parseInt(entry?.id, 10) === cueId);
    if (!cue) return null;
    return { fixture, cue };
}

function isLightingGroupFixture(fixture) {
    return !!fixture && fixture.presetId === 'group';
}

function normalizeGroupCueAssignments(cue) {
    const raw = Array.isArray(cue?.groupAssignments) ? cue.groupAssignments : [];
    const seen = new Set();
    const normalized = [];
    raw.forEach((entry) => {
        const fixtureId = parseInt(entry?.fixtureId, 10);
        const cueId = parseInt(entry?.cueId, 10);
        if (!Number.isFinite(fixtureId) || !Number.isFinite(cueId)) return;
        const key = `${fixtureId}:${cueId}`;
        if (seen.has(key)) return;
        seen.add(key);
        normalized.push({ fixtureId, cueId });
    });
    return normalized;
}

function buildGroupCueResolvedEntries(groupCue) {
    const entries = [];
    const assignments = normalizeGroupCueAssignments(groupCue);
    assignments.forEach((assignment) => {
        const sourceFixture = getLightingFixtureById(assignment.fixtureId);
        if (!sourceFixture || !Array.isArray(sourceFixture.cues)) return;
        const sourceCue = sourceFixture.cues.find((entry) => parseInt(entry?.id, 10) === assignment.cueId);
        if (!sourceCue) return;
        entries.push({ fixture: sourceFixture, cue: sourceCue });
    });
    return entries;
}

function normalizeSceneTimelineSlots(groupCue) {
    const normalized = [];
    const pushCueSlot = (rawItems) => {
        const source = Array.isArray(rawItems) ? rawItems : [];
        const seen = new Set();
        const items = [];
        source.forEach((entry) => {
            const fixtureId = parseInt(entry?.fixtureId, 10);
            const cueId = parseInt(entry?.cueId, 10);
            if (!Number.isFinite(fixtureId) || !Number.isFinite(cueId)) return;
            const key = `${fixtureId}:${cueId}`;
            if (seen.has(key)) return;
            seen.add(key);
            items.push({ fixtureId, cueId });
        });
        if (items.length) normalized.push({ type: 'cues', items });
    };

    const rawTimeline = Array.isArray(groupCue?.sceneTimeline) ? groupCue.sceneTimeline : null;
    if (rawTimeline && rawTimeline.length) {
        rawTimeline.forEach((slot) => {
            const type = String(slot?.type || '').trim().toLowerCase();
            if (type === 'delay') {
                const ms = clampDmxInt(slot?.ms, 0, 600000, 0);
                if (ms > 0) normalized.push({ type: 'delay', ms });
                return;
            }
            if (type === 'cues') {
                pushCueSlot(slot?.items || slot?.cues || slot?.assignments || []);
            }
        });
        if (normalized.length) return normalized;
    }

    // Backward compatibility: old scene cues only had groupAssignments (all parallel).
    const assignments = normalizeGroupCueAssignments(groupCue);
    assignments.forEach((assignment) => {
        normalized.push({ type: 'cues', items: [{ fixtureId: assignment.fixtureId, cueId: assignment.cueId }] });
    });
    return normalized;
}

function estimateCueRuntimeMsByRef(fixtureId, cueId, stack = new Set()) {
    const sourceFixture = getLightingFixtureById(fixtureId);
    if (!sourceFixture || !Array.isArray(sourceFixture.cues)) return 0;
    const sourceCue = sourceFixture.cues.find((entry) => parseInt(entry?.id, 10) === parseInt(cueId, 10));
    if (!sourceCue) return 0;
    if (!isLightingGroupFixture(sourceFixture)) {
        const fx = normalizeCueEffects(sourceCue);
        const fi = clampDmxInt(fx?.fadeInMs, 0, 600000, 0);
        const du = clampDmxInt(fx?.durationMs, 0, 600000, 0);
        const fo = clampDmxInt(fx?.fadeOutMs, 0, 600000, 0);
        if (du === 0) return null;
        return fi + du + fo;
    }
    const refKey = `${parseInt(fixtureId, 10)}:${parseInt(cueId, 10)}`;
    if (stack.has(refKey)) return null;
    const nextStack = new Set(stack);
    nextStack.add(refKey);
    const timeline = normalizeSceneTimelineSlots(sourceCue);
    let totalMs = 0;
    for (let slotIndex = 0; slotIndex < timeline.length; slotIndex += 1) {
        const slot = timeline[slotIndex];
        if (slot?.type === 'delay') {
            totalMs += clampDmxInt(slot?.ms, 0, 600000, 0);
            continue;
        }
        const items = Array.isArray(slot?.items) ? slot.items : [];
        let stepMs = 0;
        for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
            const item = items[itemIndex];
            const childMs = estimateCueRuntimeMsByRef(item?.fixtureId, item?.cueId, nextStack);
            if (childMs == null) return null;
            stepMs = Math.max(stepMs, childMs);
        }
        totalMs += stepMs;
    }
    return totalMs;
}

function isCueInfiniteByRef(fixtureId, cueId, stack = new Set()) {
    const sourceFixture = getLightingFixtureById(fixtureId);
    if (!sourceFixture || !Array.isArray(sourceFixture.cues)) return false;
    const sourceCue = sourceFixture.cues.find((entry) => parseInt(entry?.id, 10) === parseInt(cueId, 10));
    if (!sourceCue) return false;
    if (!isLightingGroupFixture(sourceFixture)) {
        const fx = normalizeCueEffects(sourceCue);
        return clampDmxInt(fx?.durationMs, 0, 600000, 0) === 0;
    }
    const refKey = `${parseInt(fixtureId, 10)}:${parseInt(cueId, 10)}`;
    if (stack.has(refKey)) return true;
    const nextStack = new Set(stack);
    nextStack.add(refKey);
    const timeline = normalizeSceneTimelineSlots(sourceCue);
    for (let slotIndex = 0; slotIndex < timeline.length; slotIndex += 1) {
        const slot = timeline[slotIndex];
        if (slot?.type !== 'cues') continue;
        const items = Array.isArray(slot?.items) ? slot.items : [];
        for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
            const item = items[itemIndex];
            if (isCueInfiniteByRef(item?.fixtureId, item?.cueId, nextStack)) return true;
        }
    }
    return false;
}

function mergeGroupCueChannels(entries) {
    const byChannel = new Map();
    entries.forEach(({ cue }) => {
        if (!Array.isArray(cue?.channels)) return;
        cue.channels.forEach((entry) => {
            const channel = clampDmxInt(entry?.channel, 1, DMX_MAX_CHANNEL, -1);
            if (channel < 1) return;
            const value = clampDmxInt(entry?.value, DMX_MIN_VALUE, DMX_MAX_VALUE, 0);
            byChannel.set(channel, value);
        });
    });
    return Array.from(byChannel.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([channel, value]) => ({ channel, value }));
}

function mergeGroupCueEffects(entries, fallbackCue) {
    const fallback = normalizeCueEffects(fallbackCue);
    if (!entries.length) return fallback;
    const merged = entries.reduce((acc, entry) => {
        const fx = normalizeCueEffects(entry?.cue);
        return {
            delayMs: Math.max(acc.delayMs, fx.delayMs),
            fadeInMs: Math.max(acc.fadeInMs, fx.fadeInMs),
            fadeOutMs: Math.max(acc.fadeOutMs, fx.fadeOutMs),
            durationMs: Math.max(acc.durationMs, fx.durationMs)
        };
    }, { delayMs: 0, fadeInMs: 0, fadeOutMs: 0, durationMs: 0 });
    if (merged.delayMs === 0 && merged.fadeInMs === 0 && merged.fadeOutMs === 0 && merged.durationMs === 0) {
        return fallback;
    }
    return merged;
}

function findOlaDmxCommand() {
    if (process.platform !== 'linux') return null;
    const now = Date.now();
    if ((now - dmxOlaCommandCache.at) < DMX_OLA_COMMAND_CACHE_MS) {
        return dmxOlaCommandCache.command;
    }
    scheduleOlaDmxCommandProbe();
    return dmxOlaCommandCache.command;
}

function scheduleOlaDmxCommandProbe() {
    if (process.platform !== 'linux') return;
    const now = Date.now();
    if (dmxOlaCommandProbeInFlight) return;
    if ((now - dmxOlaCommandCache.at) < DMX_OLA_COMMAND_CACHE_MS) return;
    dmxOlaCommandProbeInFlight = true;
    void (async () => {
        let found = null;
        try {
            for (const cmd of DMX_OLA_COMMANDS) {
                const probe = await runCommandCaptureAsync('which', [cmd], 700);
                if (probe.ok && String(probe.stdout || '').trim()) {
                    found = cmd;
                    break;
                }
            }
        } catch (e) {
        } finally {
            dmxOlaCommandCache = { at: Date.now(), command: found };
            dmxOlaCommandProbeInFlight = false;
        }
    })();
}

function sendCurrentDmxUniverseToOla() {
    if (process.platform !== 'linux') return { ok: false, error: 'unsupported-platform' };
    const adapter = getDmxAdapterInfo();
    if (!adapter?.connected) return { ok: false, error: 'no-adapter' };
    const cmd = findOlaDmxCommand();
    if (!cmd) return { ok: false, error: 'no-ola-cli' };

    const universe = clampDmxInt(DMX_DEFAULT_UNIVERSE, 0, 9999, 0);
    const dmx = dmxUniverseBuffer
        .map(value => clampDmxInt(value, DMX_MIN_VALUE, DMX_MAX_VALUE, 0))
        .join(',');
    dmxQueuedSendJob = {
        cmd,
        args: ['-u', String(universe), '-d', dmx]
    };
    flushDmxSendQueue();
    return { ok: true, queued: true };
}

function flushDmxSendQueue() {
    if (dmxSendInFlight) return;
    const job = dmxQueuedSendJob;
    if (!job || !job.cmd || !Array.isArray(job.args)) return;
    dmxQueuedSendJob = null;
    dmxSendInFlight = true;

    let child = null;
    let timedOut = false;
    let stderr = '';
    try {
        child = spawn(job.cmd, job.args, {
            stdio: ['ignore', 'ignore', 'pipe']
        });
    } catch (err) {
        dmxSendInFlight = false;
        const now = Date.now();
        if ((now - dmxSendErrorGateAt) > 1500) {
            dmxSendErrorGateAt = now;
            logSystem(`DMX send failed (${job.cmd}): ${err?.message || 'spawn failed'}`, 'warn');
        }
        if (dmxQueuedSendJob) setImmediate(flushDmxSendQueue);
        return;
    }

    const timeoutId = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGKILL'); } catch (e) {}
    }, 1500);

    if (child.stderr) {
        child.stderr.on('data', (chunk) => {
            try { stderr += chunk.toString(); } catch (e) {}
        });
    }
    child.on('error', (err) => {
        if (!stderr) stderr = err?.message || '';
    });
    child.on('close', (code) => {
        clearTimeout(timeoutId);
        dmxSendInFlight = false;
        const ok = !timedOut && code === 0;
        if (!ok) {
            const now = Date.now();
            if ((now - dmxSendErrorGateAt) > 1500) {
                dmxSendErrorGateAt = now;
                const trimmed = String(stderr || '').trim();
                const reason = timedOut ? 'timeout' : (trimmed || `exit=${code ?? 'unknown'}`);
                logSystem(`DMX send failed (${job.cmd}): ${reason}`, 'warn');
            }
        }
        if (dmxQueuedSendJob) {
            setImmediate(flushDmxSendQueue);
        }
    });
}

function applyCueChannelsToDmxBuffer(cue) {
    if (!cue || !Array.isArray(cue.channels)) return { changed: false };
    let changed = false;
    cue.channels.forEach((entry) => {
        const channel = clampDmxInt(entry?.channel, 1, DMX_MAX_CHANNEL, -1);
        if (channel < 1) return;
        const value = clampDmxInt(entry?.value, DMX_MIN_VALUE, DMX_MAX_VALUE, 0);
        const idx = channel - 1;
        if (dmxUniverseBuffer[idx] !== value) {
            dmxUniverseBuffer[idx] = value;
            changed = true;
        }
    });
    return { changed };
}

function normalizeCueEffects(cue) {
    const durationRaw = cue?.effects?.durationMs !== undefined
        ? cue.effects.durationMs
        : cue?.effects?.holdMs;
    return {
        delayMs: clampDmxInt(cue?.effects?.delayMs, 0, 600000, 0),
        fadeInMs: clampDmxInt(cue?.effects?.fadeInMs, 0, 600000, 0),
        fadeOutMs: clampDmxInt(cue?.effects?.fadeOutMs, 0, 600000, 0),
        durationMs: clampDmxInt(durationRaw, 0, 600000, 0)
    };
}

function getCueChannelTargets(cue) {
    const channelMap = new Map();
    if (!cue || !Array.isArray(cue.channels)) return [];
    cue.channels.forEach((entry) => {
        const channel = clampDmxInt(entry?.channel, 1, DMX_MAX_CHANNEL, -1);
        if (channel < 1) return;
        const value = clampDmxInt(entry?.value, DMX_MIN_VALUE, DMX_MAX_VALUE, 0);
        channelMap.set(channel, value);
    });
    return Array.from(channelMap.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([channel, value]) => ({ channel, value }));
}

function clearDmxPlaybackTimers() {
    if (!(dmxPlaybackTimers instanceof Map)) {
        dmxPlaybackTimers = new Map();
        return;
    }
    dmxPlaybackTimers.forEach((_, timerId) => clearTimeout(timerId));
    dmxPlaybackTimers.clear();
}

function clearDmxSceneScheduleTimers() {
    if (!(dmxSceneScheduleTimers instanceof Set)) {
        dmxSceneScheduleTimers = new Set();
        return;
    }
    dmxSceneScheduleTimers.forEach((timerId) => {
        try { clearTimeout(timerId); } catch (e) {}
    });
    dmxSceneScheduleTimers.clear();
}

function registerCueInstance(token, channels, snapshotMap) {
    const safeToken = clampDmxInt(token, 1, Number.MAX_SAFE_INTEGER, 0);
    if (!safeToken) return;
    const channelSet = new Set();
    (Array.isArray(channels) ? channels : []).forEach((channel) => {
        const safeChannel = clampDmxInt(channel, 1, DMX_MAX_CHANNEL, -1);
        if (safeChannel >= 1) channelSet.add(safeChannel);
    });
    const safeSnapshot = new Map();
    if (snapshotMap instanceof Map) {
        snapshotMap.forEach((value, channel) => {
            const safeChannel = clampDmxInt(channel, 1, DMX_MAX_CHANNEL, -1);
            if (safeChannel < 1) return;
            safeSnapshot.set(safeChannel, clampDmxInt(value, DMX_MIN_VALUE, DMX_MAX_VALUE, 0));
        });
    }
    dmxActiveCueInstances.set(safeToken, {
        token: safeToken,
        channels: channelSet,
        snapshotMap: safeSnapshot,
        startedAt: Date.now()
    });
}

function unregisterCueToken(token) {
    const safeToken = clampDmxInt(token, 1, Number.MAX_SAFE_INTEGER, 0);
    if (!safeToken) return;
    dmxActiveCueInstances.delete(safeToken);
}

function restoreCueSnapshot(token) {
    const safeToken = clampDmxInt(token, 1, Number.MAX_SAFE_INTEGER, 0);
    if (!safeToken) return { ok: true, noop: true };
    const instance = dmxActiveCueInstances.get(safeToken);
    if (!instance || !(instance.snapshotMap instanceof Map) || !instance.snapshotMap.size) {
        unregisterCueToken(safeToken);
        return { ok: true, noop: true };
    }
    const result = sendFrameFromChannelValues(instance.snapshotMap);
    unregisterCueToken(safeToken);
    return result;
}

function interruptDmxCueLayersForChannels(channels) {
    const safeChannels = (Array.isArray(channels) ? channels : [])
        .map((channel) => clampDmxInt(channel, 1, DMX_MAX_CHANNEL, -1))
        .filter((channel) => channel >= 1);
    if (!safeChannels.length) return;

    const interruptedTokens = new Set();
    const safeChannelSet = new Set(safeChannels);
    if (dmxActiveCueInstances instanceof Map) {
        dmxActiveCueInstances.forEach((instance, token) => {
            if (!(instance?.channels instanceof Set) || !instance.channels.size) return;
            for (const channel of instance.channels.values()) {
                if (safeChannelSet.has(channel)) {
                    interruptedTokens.add(token);
                    break;
                }
            }
        });
    }
    if (!interruptedTokens.size) return;

    if (!(dmxPlaybackTimers instanceof Map)) {
        dmxPlaybackTimers = new Map();
    }
    dmxPlaybackTimers.forEach((meta, timerId) => {
        const token = clampDmxInt(meta?.token, 1, Number.MAX_SAFE_INTEGER, 0);
        if (!token || !interruptedTokens.has(token)) return;
        clearTimeout(timerId);
        dmxPlaybackTimers.delete(timerId);
    });

    interruptedTokens.forEach((token) => {
        restoreCueSnapshot(token);
    });
}

function buildZeroMapForChannels(channels) {
    const zeroMap = new Map();
    if (!channels) return zeroMap;
    channels.forEach((channel) => {
        const safeChannel = clampDmxInt(channel, 1, DMX_MAX_CHANNEL, -1);
        if (safeChannel < 1) return;
        zeroMap.set(safeChannel, 0);
    });
    return zeroMap;
}

function setCueChannelValuesOnBuffer(valuesByChannel) {
    let changed = false;
    valuesByChannel.forEach((value, channel) => {
        const safeChannel = clampDmxInt(channel, 1, DMX_MAX_CHANNEL, -1);
        if (safeChannel < 1) return;
        const safeValue = clampDmxInt(value, DMX_MIN_VALUE, DMX_MAX_VALUE, 0);
        const idx = safeChannel - 1;
        if (dmxUniverseBuffer[idx] !== safeValue) {
            dmxUniverseBuffer[idx] = safeValue;
            changed = true;
        }
    });
    return changed;
}

function dmxChannelMapToObject(valuesByChannel) {
    const out = {};
    if (!valuesByChannel || typeof valuesByChannel.forEach !== 'function') return out;
    valuesByChannel.forEach((value, channel) => {
        const safeChannel = clampDmxInt(channel, 1, DMX_MAX_CHANNEL, -1);
        if (safeChannel < 1) return;
        out[String(safeChannel)] = clampDmxInt(value, DMX_MIN_VALUE, DMX_MAX_VALUE, 0);
    });
    const ordered = {};
    Object.keys(out).sort((a, b) => Number(a) - Number(b)).forEach((key) => {
        ordered[key] = out[key];
    });
    return ordered;
}

function sendFrameFromChannelValues(valuesByChannel) {
    const changed = setCueChannelValuesOnBuffer(valuesByChannel);
    if (!changed) return { ok: true, noop: true };
    const result = sendCurrentDmxUniverseToOla();
    if (result?.ok) {
        logSystem('DMX frame sent', 'dmx', {
            direction: 'outbound',
            payload: dmxChannelMapToObject(valuesByChannel)
        });
    }
    return result;
}

function runDmxCueWithEffects(cue, effects) {
    const targets = getCueChannelTargets(cue);
    if (!targets.length) return { success: false, error: 'cue-empty' };
    if (process.platform !== 'linux') return { success: false, error: 'unsupported-platform' };
    const adapter = getDmxAdapterInfo();
    if (!adapter?.connected) return { success: false, error: 'no-adapter' };
    const olaCmd = findOlaDmxCommand();
    if (!olaCmd) return { success: false, error: 'no-ola-cli' };

    const targetMap = new Map();
    targets.forEach((entry) => {
        targetMap.set(entry.channel, entry.value);
    });
    const targetChannels = targets.map(entry => entry.channel);
    interruptDmxCueLayersForChannels(targetChannels);
    const token = ++dmxCueTokenCounter;
    const snapshotMap = new Map();
    targetChannels.forEach((channel) => {
        const idx = channel - 1;
        snapshotMap.set(channel, clampDmxInt(dmxUniverseBuffer[idx], DMX_MIN_VALUE, DMX_MAX_VALUE, 0));
    });
    registerCueInstance(token, targetChannels, snapshotMap);

    const schedule = (delayMs, fn) => {
        const safeDelay = Math.max(0, clampDmxInt(delayMs, 0, 600000, 0));
        const timerId = setTimeout(() => {
            dmxPlaybackTimers.delete(timerId);
            fn();
        }, safeDelay);
        dmxPlaybackTimers.set(timerId, { token });
    };

    const renderLerpFrame = (fromMap, toMap, ratio) => {
        const safeRatio = Math.max(0, Math.min(1, ratio));
        const frame = new Map();
        toMap.forEach((toValue, channel) => {
            const fromValue = fromMap.has(channel) ? fromMap.get(channel) : toValue;
            const value = Math.round(fromValue + ((toValue - fromValue) * safeRatio));
            frame.set(channel, clampDmxInt(value, DMX_MIN_VALUE, DMX_MAX_VALUE, 0));
        });
        return sendFrameFromChannelValues(frame);
    };

    const delayMs = clampDmxInt(effects?.delayMs, 0, 600000, 0);
    const fadeInMs = effects.fadeInMs;
    const durationMs = effects.durationMs;
    const fadeOutMs = effects.fadeOutMs;
    const infiniteDuration = durationMs === 0;
    const currentStartMap = new Map();
    snapshotMap.forEach((value, channel) => currentStartMap.set(channel, value));

    if (fadeInMs > 0) {
        const stepCount = Math.max(1, Math.ceil(fadeInMs / DMX_FADE_STEP_MS));
        for (let step = 1; step <= stepCount; step += 1) {
            const ratio = step / stepCount;
            const at = delayMs + Math.round((fadeInMs * step) / stepCount);
            schedule(at, () => {
                renderLerpFrame(currentStartMap, targetMap, ratio);
            });
        }
    } else {
        const sendAt = delayMs;
        if (sendAt > 0) {
            schedule(sendAt, () => {
                sendFrameFromChannelValues(targetMap);
            });
        } else {
            const sendTarget = sendFrameFromChannelValues(targetMap);
            if (!sendTarget.ok) return { success: false, error: sendTarget.error || 'send-failed' };
        }
    }

    if (infiniteDuration) {
        return {
            success: true,
            started: true,
            infinite: true,
            durationMs: null,
            delayMs,
            channelCount: targets.length
        };
    }

    const fadeInDoneAt = delayMs + fadeInMs;
    const fadeOutStartAt = fadeInDoneAt + durationMs;

    if (fadeOutMs > 0) {
        const fadeOutTargetMap = snapshotMap;
        const stepCountOut = Math.max(1, Math.ceil(fadeOutMs / DMX_FADE_STEP_MS));
        for (let step = 1; step <= stepCountOut; step += 1) {
            const ratio = step / stepCountOut;
            const at = fadeOutStartAt + Math.round((fadeOutMs * step) / stepCountOut);
            schedule(at, () => {
                renderLerpFrame(targetMap, fadeOutTargetMap, ratio);
            });
        }
        schedule(fadeOutStartAt + fadeOutMs + 5, () => {
            restoreCueSnapshot(token);
        });
    } else {
        schedule(fadeOutStartAt, () => {
            restoreCueSnapshot(token);
        });
    }

    return {
        success: true,
        started: true,
        durationMs: delayMs + fadeInMs + durationMs + fadeOutMs,
        delayMs,
        channelCount: targets.length
    };
}

function resetDmxUniverseBuffer({ send = false } = {}) {
    clearDmxPlaybackTimers();
    dmxCueTokenCounter += 1;
    dmxActiveCueInstances = new Map();
    if (!Array.isArray(dmxUniverseBuffer) || dmxUniverseBuffer.length !== DMX_MAX_CHANNEL) {
        dmxUniverseBuffer = new Array(DMX_MAX_CHANNEL).fill(0);
    } else {
        dmxUniverseBuffer.fill(0);
    }
    if (send) {
        sendCurrentDmxUniverseToOla();
    }
}

function stopAllDmxCuePlayback() {
    clearDmxPlaybackTimers();
    clearDmxSceneScheduleTimers();
    const tokens = Array.from((dmxActiveCueInstances instanceof Map ? dmxActiveCueInstances.keys() : []));
    tokens.forEach((token) => {
        try { restoreCueSnapshot(token); } catch (e) {}
    });
    dmxActiveCueInstances = new Map();
    return { success: true, stopped: tokens.length };
}

function runDmxCueAction(cueRef, context = {}) {
    const resolved = getLightingCueByRef(cueRef);
    if (!resolved) {
        logSystem(`Scripting play_cue skipped: unknown cue "${cueRef}"`, 'warn');
        return { success: false, error: 'cue-not-found' };
    }
    const { fixture, cue } = resolved;
    const sceneStack = context && context._sceneStack instanceof Set ? context._sceneStack : new Set();
    const sceneRefKey = `${parseInt(fixture?.id, 10)}:${parseInt(cue?.id, 10)}`;
    if (sceneStack.has(sceneRefKey)) {
        logSystem(`DMX Cue skipped (scene cycle): ${cueRef}`, 'warn');
        return { success: false, error: 'scene-cycle-detected' };
    }
    if (isLightingGroupFixture(fixture)) {
        const nextSceneStack = new Set(sceneStack);
        nextSceneStack.add(sceneRefKey);
        const timeline = normalizeSceneTimelineSlots(cue);
        if (!timeline.length) {
            logSystem(`Scripting play_cue skipped: empty group cue "${cueRef}"`, 'warn');
            return { success: false, error: 'group-cue-empty' };
        }
        let okCount = 0;
        const failures = [];
        let timelineDelayMs = 0;
        let blockedByInfiniteStep = false;
        const scheduleSceneCueStart = (delayMs, runner) => {
            const safeDelay = Math.max(0, clampDmxInt(delayMs, 0, 600000, 0));
            if (safeDelay <= 0) {
                runner();
                return;
            }
            const timerId = setTimeout(() => {
                dmxSceneScheduleTimers.delete(timerId);
                try { runner(); } catch (e) {}
            }, safeDelay);
            dmxSceneScheduleTimers.add(timerId);
        };
        for (let slotIndex = 0; slotIndex < timeline.length; slotIndex += 1) {
            const slot = timeline[slotIndex];
            if (slot?.type === 'delay') {
                timelineDelayMs += clampDmxInt(slot?.ms, 0, 600000, 0);
                continue;
            }
            const slotItems = Array.isArray(slot?.items) ? slot.items : [];
            let stepDurationMs = 0;
            let stepHasInfiniteCue = false;
            slotItems.forEach((item) => {
                const sourceFixture = getLightingFixtureById(item?.fixtureId);
                const sourceCue = sourceFixture?.cues?.find((entry) => parseInt(entry?.id, 10) === parseInt(item?.cueId, 10));
                if (!sourceFixture || !sourceCue) return;
                const assignmentMeta = {
                    direction: 'outbound',
                    action: 'playCue',
                    triggerType: context.triggerType || 'event',
                    fixtureId: parseInt(sourceFixture?.id, 10),
                    fixtureName: sourceFixture?.name || null,
                    cueId: parseInt(sourceCue?.id, 10),
                    cueName: sourceCue?.name || null,
                    parentFixtureId: parseInt(fixture?.id, 10),
                    parentFixtureName: fixture?.name || null,
                    parentCueId: parseInt(cue?.id, 10),
                    parentCueName: cue?.name || null
                };
                const cueLabel = `${sourceFixture?.name || `Lamp ${sourceFixture?.id}`}/${sourceCue?.name || `Cue ${sourceCue?.id}`}`;
                const sceneLabel = `${fixture?.name || fixture?.id}`;
                const ownDurationMs = estimateCueRuntimeMsByRef(sourceFixture?.id, sourceCue?.id, nextSceneStack);
                if (ownDurationMs == null || isCueInfiniteByRef(sourceFixture?.id, sourceCue?.id, nextSceneStack)) {
                    stepHasInfiniteCue = true;
                } else {
                    stepDurationMs = Math.max(stepDurationMs, ownDurationMs);
                }
                const channelPayload = {};
                (Array.isArray(sourceCue?.channels) ? sourceCue.channels : []).forEach((chEntry) => {
                    const ch = clampDmxInt(chEntry?.channel, 1, DMX_MAX_CHANNEL, null);
                    if (!Number.isFinite(ch)) return;
                    channelPayload[String(ch)] = clampDmxInt(chEntry?.value, DMX_MIN_VALUE, DMX_MAX_VALUE, 0);
                });
                const delayMs = clampDmxInt(timelineDelayMs, 0, 600000, 0);
                if (delayMs > 0) {
                    logSystem(
                        `DMX Cue scheduled: ${cueLabel} (Scene ${sceneLabel}; +${delayMs}ms; ${context.triggerType || 'event'})`,
                        'dmx',
                        { ...assignmentMeta, status: 'scheduled', delayMs, payload: channelPayload }
                    );
                }
                scheduleSceneCueStart(delayMs, () => {
                    const played = isLightingGroupFixture(sourceFixture)
                        ? runDmxCueAction(`${parseInt(sourceFixture?.id, 10)}:${parseInt(sourceCue?.id, 10)}`, { ...context, _sceneStack: nextSceneStack })
                        : runDmxCueWithEffects(sourceCue, { ...normalizeCueEffects(sourceCue), delayMs: 0 });
                    if (!played.success) {
                        failures.push(played.error || 'unknown-error');
                        logSystem(
                            `DMX Cue failed: ${cueLabel} (Scene ${sceneLabel}: ${played.error || 'unknown-error'})`,
                            'dmx',
                            { ...assignmentMeta, status: 'failed', error: played.error || 'unknown-error' }
                        );
                        return;
                    }
                    okCount += 1;
                    logSystem(
                        `DMX Cue played: ${cueLabel} (Scene ${sceneLabel}; ${context.triggerType || 'event'})`,
                        'dmx',
                        { ...assignmentMeta, status: 'played', payload: channelPayload }
                    );
                });
            });
            if (stepHasInfiniteCue) {
                blockedByInfiniteStep = true;
                break;
            }
            timelineDelayMs += stepDurationMs;
        }
        if (!okCount) return { success: false, error: failures[0] || 'group-cue-failed' };
        return {
            success: true,
            group: true,
            assignmentCount: okCount,
            failedCount: failures.length,
            blockedByInfiniteStep,
            infinite: blockedByInfiniteStep === true,
            durationMs: blockedByInfiniteStep === true ? null : Math.max(0, clampDmxInt(timelineDelayMs, 0, 600000, 0))
        };
    }
    const effectiveCue = cue;
    const effects = normalizeCueEffects(cue);
    const baseMeta = {
        direction: 'outbound',
        action: 'playCue',
        triggerType: context.triggerType || 'event',
        fixtureId: parseInt(fixture?.id, 10),
        fixtureName: fixture?.name || null,
        cueId: parseInt(cue?.id, 10),
        cueName: cue?.name || null
    };
    const played = runDmxCueWithEffects(effectiveCue, effects);
    if (!played.success) {
        logSystem(
            `DMX Cue failed: ${fixture?.name || `Lamp ${fixture?.id}`}/${cue?.name || `Cue ${cue?.id}`} (${played.error || 'unknown-error'})`,
            'dmx',
            {
                ...baseMeta,
                status: 'failed',
                error: played.error || 'unknown-error'
            }
        );
        if (played.error === 'no-adapter') {
            const fixtureLabel = isLightingGroupFixture(fixture)
                ? `Scene ${fixture?.name || fixture?.id || ''}`.trim()
                : `Lamp ${fixture?.name || fixture?.id || ''}`.trim();
            const cueLabel = cue?.name ? ` / ${cue.name}` : '';
            logSystem(
                `No DMX adapter connected: ${fixtureLabel}${cueLabel} could not be played (${context.triggerType || 'event'}).`,
                'error'
            );
        }
        return played;
    }
    const channelPayload = {};
    (Array.isArray(effectiveCue?.channels) ? effectiveCue.channels : []).forEach((entry) => {
        const ch = clampDmxInt(entry?.channel, 1, DMX_MAX_CHANNEL, null);
        if (!Number.isFinite(ch)) return;
        channelPayload[String(ch)] = clampDmxInt(entry?.value, DMX_MIN_VALUE, DMX_MAX_VALUE, 0);
    });
    const delayMs = clampDmxInt(played?.delayMs, 0, 600000, 0);
    const cueLabel = `${fixture?.name || `Lamp ${fixture?.id}`}/${cue?.name || `Cue ${cue?.id}`}`;
    if (delayMs > 0) {
        logSystem(
            `DMX Cue scheduled: ${cueLabel} (+${delayMs}ms; ${context.triggerType || 'event'})`,
            'dmx',
            {
                ...baseMeta,
                status: 'scheduled',
                delayMs,
                payload: channelPayload
            }
        );
    } else {
        logSystem(
            `DMX Cue played: ${cueLabel} (${context.triggerType || 'event'})`,
            'dmx',
            {
                ...baseMeta,
                status: 'played',
                payload: channelPayload
            }
        );
    }
    return {
        success: true,
        fixtureId: parseInt(fixture?.id, 10),
        cueId: parseInt(cue?.id, 10),
        ...played
    };
}

function sanitizeSoundCueName(name) {
    const raw = String(name || '').trim();
    if (!raw) return '';
    const baseName = path.basename(raw);
    const parsed = path.parse(baseName);
    const safeBase = parsed.name.replace(/[^a-z0-9-_]/gi, '').slice(0, 80);
    const safeExt = parsed.ext.replace(/[^a-z0-9.]/gi, '').slice(0, 12);
    if (!safeBase) return '';
    return `${safeBase}${safeExt}`;
}

function resolveSoundCueFilePath(soundName) {
    const safeName = sanitizeSoundCueName(soundName);
    if (!safeName) return null;
    try {
        if (!fs.existsSync(SOUNDS_DIR)) return null;
        const directPath = path.join(SOUNDS_DIR, safeName);
        if (fs.existsSync(directPath) && fs.statSync(directPath).isFile()) return directPath;
        const files = fs.readdirSync(SOUNDS_DIR);
        const match = files.find((entry) => String(entry || '').toLowerCase() === safeName.toLowerCase());
        if (!match) return null;
        const matchPath = path.join(SOUNDS_DIR, match);
        if (fs.existsSync(matchPath) && fs.statSync(matchPath).isFile()) return matchPath;
        return null;
    } catch (e) {
        return null;
    }
}

function normalizeSoundCueTrim(trim) {
    const startMs = Math.max(0, Math.floor(Number(trim?.startMs) || 0));
    const rawEnd = Number(trim?.endMs);
    const rawDuration = Number(trim?.durationMs);
    const durationMs = Number.isFinite(rawDuration) && rawDuration > 0 ? Math.floor(rawDuration) : 0;
    let endMs = Number.isFinite(rawEnd) && rawEnd > 0 ? Math.floor(rawEnd) : 0;
    if (durationMs > 0) endMs = endMs > 0 ? Math.min(endMs, durationMs) : durationMs;
    if (endMs > 0 && endMs < startMs) endMs = startMs;
    return { startMs, endMs, durationMs };
}

function getSoundCueTrim(soundName) {
    const safeName = sanitizeSoundCueName(soundName);
    if (!safeName) return { startMs: 0, endMs: 0, durationMs: 0 };
    try {
        if (!fs.existsSync(SOUNDS_META_PATH)) return { startMs: 0, endMs: 0, durationMs: 0 };
        const parsed = JSON.parse(fs.readFileSync(SOUNDS_META_PATH, 'utf8'));
        return normalizeSoundCueTrim(parsed?.[safeName]?.trim || {});
    } catch (e) {
        return { startMs: 0, endMs: 0, durationMs: 0 };
    }
}

function clampSoundVolumePercent(value) {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) return 100;
    return Math.max(0, Math.min(100, parsed));
}

function trySpawnSoundCuePlayer(cmd, args, startupMs = 220) {
    return new Promise((resolve) => {
        let child = null;
        let settled = false;
        try {
            child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'ignore'] });
            activeSoundCueProcesses.add(child);
        } catch (err) {
            resolve({ ok: false, error: err?.message || 'spawn failed' });
            return;
        }
        child.on('close', () => {
            activeSoundCueProcesses.delete(child);
        });
        child.on('error', () => {
            activeSoundCueProcesses.delete(child);
        });
        const promoteTimer = setTimeout(() => {
            if (settled) return;
            settled = true;
            resolve({ ok: true, player: cmd });
        }, Math.max(100, Number(startupMs) || 220));
        child.on('error', (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(promoteTimer);
            resolve({ ok: false, error: err?.message || 'spawn error' });
        });
        child.on('close', (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(promoteTimer);
            if (code === 0) {
                resolve({ ok: true, player: cmd });
            } else {
                resolve({ ok: false, error: `exit ${code}` });
            }
        });
    });
}

function stopAllSoundCuePlayback() {
    if (!(activeSoundCueProcesses instanceof Set)) {
        activeSoundCueProcesses = new Set();
        return;
    }
    activeSoundCueProcesses.forEach((child) => {
        try { child.kill('SIGTERM'); } catch (e) {}
        setTimeout(() => {
            try { child.kill('SIGKILL'); } catch (e) {}
        }, 250);
    });
    activeSoundCueProcesses.clear();
}

function waitMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function runSoundCommandSilently(cmd, args = []) {
    return new Promise((resolve) => {
        let child = null;
        try {
            child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'ignore'] });
        } catch (err) {
            resolve(false);
            return;
        }
        child.on('error', () => resolve(false));
        child.on('close', (code) => resolve(code === 0));
    });
}

async function ensureSoundSystemMixerMax() {
    // Best-effort only; keep cue playback resilient.
    const commands = [
        ['amixer', ['set', 'Master', '100%', 'unmute']],
        ['amixer', ['set', 'PCM', '100%', 'unmute']],
        ['amixer', ['-c', 'UC02', 'set', 'PCM', '100%', 'unmute']],
        ['amixer', ['-c', '2', 'set', 'PCM', '100%', 'unmute']]
    ];
    for (const [cmd, args] of commands) {
        try { await runSoundCommandSilently(cmd, args); } catch (e) {}
    }
}

async function processSoundCueQueue() {
    if (soundCueWorkerRunning) return;
    soundCueWorkerRunning = true;
    try {
        while (soundCuePendingRequest) {
            const request = soundCuePendingRequest;
            soundCuePendingRequest = null;
            stopAllSoundCuePlayback();
            // Give ALSA/pulseaudio a brief moment to release the previous process.
            await waitMs(70);
            const result = await playSoundCueOnPi(request.filePath, request.volume || 100, request.trim || {});
            if (result?.success) {
                logSystem(
                    `Sound Cue played: ${request.rawName} (${request.triggerType})`,
                    'system',
                    { direction: 'outbound', action: 'playSoundCue', triggerType: request.triggerType, sound: request.rawName, player: result.player }
                );
            } else {
                logSystem(`Sound Cue failed: ${request.rawName} (${result?.error || 'unknown-error'})`, 'error');
            }
        }
    } finally {
        soundCueWorkerRunning = false;
    }
}

async function playSoundCueOnPi(filePath, volumePercent = 100, trim = {}) {
    await ensureSoundSystemMixerMax();
    const vol = clampSoundVolumePercent(volumePercent);
    const paplayVolume = Math.round((vol / 100) * 65536);
    const mpg123Scale = Math.max(0, Math.min(32768, Math.round((vol / 100) * 32768)));
    const normalizedTrim = normalizeSoundCueTrim(trim);
    const startSec = normalizedTrim.startMs > 0 ? (normalizedTrim.startMs / 1000).toFixed(3) : null;
    const lengthMs = normalizedTrim.endMs > normalizedTrim.startMs ? normalizedTrim.endMs - normalizedTrim.startMs : 0;
    const lengthSec = lengthMs > 0 ? (lengthMs / 1000).toFixed(3) : null;
    const ffplayArgs = ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-volume', String(vol)];
    if (startSec) ffplayArgs.push('-ss', startSec);
    if (lengthSec) ffplayArgs.push('-t', lengthSec);
    ffplayArgs.push(filePath);
    const mpvArgs = ['--no-video', '--really-quiet', `--volume=${vol}`];
    if (startSec) mpvArgs.push(`--start=${startSec}`);
    if (lengthSec) mpvArgs.push(`--length=${lengthSec}`);
    mpvArgs.push(filePath);
    const baseCandidates = [
        { cmd: 'ffplay', args: ffplayArgs },
        { cmd: 'mpv', args: mpvArgs },
        ...((normalizedTrim.startMs || lengthSec) ? [] : [
            { cmd: 'paplay', args: [`--volume=${paplayVolume}`, filePath] },
            { cmd: 'mpg123', args: ['-q', '-f', String(mpg123Scale), filePath] },
            { cmd: 'aplay', args: [filePath] }
        ])
    ];
    const candidates = preferredSoundCuePlayer
        ? [
            ...baseCandidates.filter((c) => c.cmd === preferredSoundCuePlayer),
            ...baseCandidates.filter((c) => c.cmd !== preferredSoundCuePlayer)
        ]
        : baseCandidates;
    let lastError = 'no player available';
    for (const candidate of candidates) {
        const result = await trySpawnSoundCuePlayer(candidate.cmd, candidate.args);
        if (result?.ok) {
            preferredSoundCuePlayer = candidate.cmd;
            return { success: true, player: candidate.cmd };
        }
        lastError = result?.error || lastError;
    }
    return { success: false, error: lastError };
}

function runSoundCueAction(soundName, context = {}) {
    const rawName = String(soundName || '').trim();
    if (!rawName) {
        logSystem('Scripting play_sound skipped: missing sound name', 'warn');
        return { success: false, error: 'sound-missing' };
    }
    const filePath = resolveSoundCueFilePath(rawName);
    if (!filePath) {
        logSystem(`Scripting play_sound skipped: unknown sound "${rawName}"`, 'warn');
        return { success: false, error: 'sound-not-found' };
    }
    const triggerType = String(context?.triggerType || 'event');
    soundCuePendingRequest = { rawName, filePath, triggerType, volume: 100, trim: getSoundCueTrim(rawName) };
    processSoundCueQueue().catch((err) => {
        logSystem(`Sound Cue worker failed: ${err?.message || 'unknown-error'}`, 'error');
    });
    return { success: true, pending: true };
}

function runSendCustomAction(node, customText) {
    if (!node) return { success: false, error: 'puzzle-missing' };
    const deviceId = getDeviceIdForPuzzle(node);
    const value = String(customText || '');
    const topic = deviceId ? `puzzle/${deviceId}/command` : '';
    if (!canSendToDevice(node, deviceId)) {
        logSystem(
            `MQTT sendCustom blocked for ${deviceId || 'unknown-device'} (offline/missing)`,
            "warn",
            { topic, payload: { action: "sendCustom", value }, direction: "outbound", command: "sendCustom", blocked: true }
        );
        return { success: false, error: 'device-offline-or-missing' };
    }
    publishCommand(deviceId, { action: 'sendCustom', value });
    return { success: true };
}

function evaluateScriptingCondition(rule, customValue) {
    const condition = String(rule?.conditionType || 'none').toLowerCase();
    if (condition === 'none') return true;
    const expected = String(rule?.conditionValue || '');
    const actual = String(customValue || '');
    if (condition === 'custom_equals') return actual === expected;
    if (condition === 'custom_contains') return expected ? actual.includes(expected) : false;
    return true;
}

function evaluateVariableCondition(rule, variableMap) {
    const condition = String(rule?.conditionType || 'none').toLowerCase();
    if (condition !== 'var_compare') return true;
    const varName = String(rule?.conditionVar || '').trim();
    if (!varName) return false;
    const op = String(rule?.conditionOp || 'eq').toLowerCase();
    const left = Object.prototype.hasOwnProperty.call(variableMap || {}, varName) ? variableMap[varName] : '';
    const right = String(rule?.conditionValue || '');
    return compareScriptingValues(left, op, right);
}

function evaluateSensorCondition(rule, eventPayload = {}) {
    const condition = String(rule?.conditionType || 'none').toLowerCase();
    if (condition !== 'sensor_compare') return true;
    const field = String(rule?.conditionField || '').trim();
    if (!field) return false;
    const op = String(rule?.conditionOp || 'eq').toLowerCase();
    const sensorData = (eventPayload && typeof eventPayload.sensorData === 'object' && !Array.isArray(eventPayload.sensorData))
        ? eventPayload.sensorData
        : {};
    const left = Object.prototype.hasOwnProperty.call(sensorData, field) ? sensorData[field] : '';
    const right = String(rule?.conditionValue || '');
    return compareScriptingValues(left, op, right);
}

function coerceExprNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'boolean') return value ? 1 : 0;
    const parsed = Number(String(value ?? '').trim());
    return Number.isFinite(parsed) ? parsed : 0;
}

function coerceExprBoolean(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) && value !== 0;
    const raw = String(value ?? '').trim().toLowerCase();
    if (!raw) return false;
    if (raw === 'false' || raw === '0' || raw === 'no' || raw === 'off' || raw === 'null' || raw === 'undefined') return false;
    return true;
}

function evaluateDataExpressionNode(expr, eventPayload = {}) {
    if (!expr || typeof expr !== 'object' || Array.isArray(expr)) return null;
    const type = String(expr.type || '').trim().toLowerCase();
    const sensorData = (eventPayload && typeof eventPayload.sensorData === 'object' && !Array.isArray(eventPayload.sensorData))
        ? eventPayload.sensorData
        : {};
    if (type === 'field') {
        const source = String(expr.source || '').trim().toLowerCase();
        if (source === 'custom') {
            return String(eventPayload?.customValue ?? '');
        }
        if (source === 'player_input') {
            const field = String(expr.field || 'submitted').trim().toLowerCase();
            if (field === 'expected') return String(eventPayload?.expectedValue ?? '');
            if (field === 'active') {
                const currentPuzzleId = parseInt(eventPayload?.currentPuzzleId, 10);
                const runtime = Number.isFinite(currentPuzzleId) ? getExternalCheckRuntime(currentPuzzleId) : null;
                return runtime?.active ? 'true' : 'false';
            }
            return String(eventPayload?.submittedValue ?? '');
        }
        if (source === 'state') {
            const explicitTarget = String(expr.puzzle || expr.field || '').trim().toLowerCase();
            if (explicitTarget === 'room') {
                return getRoomStateKey();
            }
            if (explicitTarget.startsWith('branch')) {
                const branchRaw = explicitTarget.includes(':')
                    ? explicitTarget.split(':').slice(1).join(':')
                    : explicitTarget.replace('branch', '').trim();
                const branchId = parseInt(branchRaw, 10);
                if (Number.isFinite(branchId)) {
                    return getBranchStateKey(branchId);
                }
            }
            const explicitId = parseInt(explicitTarget, 10);
            const fallbackId = parseInt(eventPayload?.currentPuzzleId, 10);
            const targetId = Number.isFinite(explicitId) ? explicitId : (Number.isFinite(fallbackId) ? fallbackId : null);
            if (!Number.isFinite(targetId)) return '';
            return getPuzzleStateKey(targetId);
        }
        const field = String(expr.field || '').trim();
        if (!field) return '';
        const selectedDevice = String(expr.device || '').trim();
        return getSensorFieldValue(eventPayload, selectedDevice, field);
    }
    if (type === 'number') {
        const parsed = Number(expr.value);
        return Number.isFinite(parsed) ? parsed : 0;
    }
    if (type === 'text') {
        return String(expr.value || '');
    }
    if (type === 'compare') {
        const op = String(expr.op || 'eq').trim().toLowerCase();
        const left = evaluateDataExpressionNode(expr.left, eventPayload);
        const right = evaluateDataExpressionNode(expr.right, eventPayload);
        return compareScriptingValues(left, op, right);
    }
    if (type === 'logic') {
        const op = String(expr.op || 'and').trim().toLowerCase();
        const left = coerceExprBoolean(evaluateDataExpressionNode(expr.left, eventPayload));
        const right = coerceExprBoolean(evaluateDataExpressionNode(expr.right, eventPayload));
        return op === 'or' ? (left || right) : (left && right);
    }
    if (type === 'not') {
        return !coerceExprBoolean(evaluateDataExpressionNode(expr.value, eventPayload));
    }
    if (type === 'math') {
        const op = String(expr.op || 'add').trim().toLowerCase();
        const left = coerceExprNumber(evaluateDataExpressionNode(expr.left, eventPayload));
        const right = coerceExprNumber(evaluateDataExpressionNode(expr.right, eventPayload));
        if (op === 'sub') return left - right;
        if (op === 'mul') return left * right;
        if (op === 'div') return right === 0 ? 0 : (left / right);
        return left + right;
    }
    return null;
}

function evaluateExpressionCondition(rule, eventPayload = {}) {
    const condition = String(rule?.conditionType || 'none').toLowerCase();
    if (condition !== 'expr') return true;
    const expr = (rule?.conditionExpr && typeof rule.conditionExpr === 'object' && !Array.isArray(rule.conditionExpr))
        ? rule.conditionExpr
        : null;
    if (!expr) return false;
    return coerceExprBoolean(evaluateDataExpressionNode(expr, eventPayload));
}

function resolveSendCustomPayload(rule, eventPayload = {}) {
    const expr = (rule?.actionExpr && typeof rule.actionExpr === 'object' && !Array.isArray(rule.actionExpr))
        ? rule.actionExpr
        : null;
    if (!expr) return String(rule?.actionValue || '');
    const evaluated = evaluateDataExpressionNode(expr, eventPayload);
    if (evaluated == null) return '';
    return String(evaluated);
}

function resolveSystemPrintPayload(rule, eventPayload = {}) {
    const expr = (rule?.actionExpr && typeof rule.actionExpr === 'object' && !Array.isArray(rule.actionExpr))
        ? rule.actionExpr
        : null;
    if (!expr) return String(rule?.actionValue || '');
    const evaluated = evaluateDataExpressionNode(expr, eventPayload);
    if (evaluated == null) return '';
    return String(evaluated);
}

function resolveScriptingStateTarget(stateRaw) {
    const value = String(stateRaw || '').trim().toLowerCase();
    if (value === 'activate') return 'active';
    return normalizePuzzleState(value || 'locked');
}

function resolveRuleTargetPuzzleId(rule) {
    const numericId = parseInt(rule?.actionTargetPuzzle, 10);
    if (!Number.isFinite(numericId)) return null;
    return getPuzzleNodeById(numericId) ? numericId : null;
}

function setBranchSolvedFromRoomScripting(branchId) {
    const numericBranchId = parseInt(branchId, 10);
    if (!Number.isFinite(numericBranchId)) return false;
    const flowData = buildBranchFlowData();
    const branch = (flowData.branches || []).find((entry) => entry.id === numericBranchId);
    if (!branch) return false;

    const puzzleIds = (branch.puzzles || [])
        .map((puzzle) => parseInt(puzzle?.id, 10))
        .filter((id) => Number.isFinite(id))
        .filter((id) => isBranchPuzzleRequired(numericBranchId, id));

    puzzleIds.forEach((puzzleId) => {
        try {
            module.exports.markPuzzleSolved(puzzleId, { branchId: numericBranchId });
        } catch (e) {
            // Ignore single puzzle failures and continue.
        }
    });
    markBranchSolved(numericBranchId);
    checkAutoRestartCondition();
    return true;
}

function applyRoomScriptingBranchState(rule) {
    const targetRaw = String(rule?.actionTargetPuzzle || '').trim().toLowerCase();
    const desiredState = String(rule?.actionValue || '').trim().toLowerCase();
    if (!targetRaw || !desiredState) return { success: false };

    if (targetRaw === 'room') {
        if (desiredState === 'running') {
            return beginRoomRestart({});
        }
        if (desiredState === 'solved') {
            const flowData = buildBranchFlowData();
            (flowData.branches || []).forEach((branch) => {
                setBranchSolvedFromRoomScripting(branch?.id);
            });
            return { success: true };
        }
        return { success: false };
    }

    const branchId = parseInt(targetRaw, 10);
    if (!Number.isFinite(branchId)) return { success: false };
    if (desiredState === 'running') {
        return module.exports.restartBranch({ branchId });
    }
    if (desiredState === 'solved') {
        const success = setBranchSolvedFromRoomScripting(branchId);
        return { success };
    }
    return { success: false };
}

function getScriptingRuleId(rule, fallbackIndex = 0) {
    const parsed = Number(rule?.id);
    return Number.isFinite(parsed) ? parsed : (fallbackIndex + 1);
}

function logScripting(message, meta = null) {
    logSystem(message, 'scripting', meta);
}

function logScriptingRuntimeError(scope, context, error) {
    const errMsg = error?.message ? String(error.message) : String(error || 'Unknown error');
    const where = String(context || 'runtime');
    logSystem(`[${scope}] ${where} failed: ${errMsg}`, 'error');
}

function markPuzzleScriptingActive(puzzleId, durationMs = 2000) {
    const numericId = Number(puzzleId);
    if (!Number.isFinite(numericId)) return;
    const until = Date.now() + Math.max(0, Number(durationMs) || 0);
    puzzleScriptingActiveUntil[numericId] = until;
    puzzleScriptingSeq[numericId] = Number(puzzleScriptingSeq[numericId] || 0) + 1;
    emitUpdate('puzzle-scripting-active', { puzzleId: numericId, until, seq: puzzleScriptingSeq[numericId] });
}

function markRoomScriptingActive(durationMs = 2000) {
    const until = Date.now() + Math.max(0, Number(durationMs) || 0);
    roomScriptingActiveUntil = until;
    roomScriptingSeq = Number(roomScriptingSeq || 0) + 1;
    emitUpdate('room-scripting-active', { until, seq: roomScriptingSeq });
}

function clearScriptingForeverTimers() {
    if (!scriptingForeverTimers || typeof scriptingForeverTimers.forEach !== 'function') {
        scriptingForeverTimers = new Set();
        return;
    }
    scriptingForeverTimers.forEach((timer) => {
        try { clearInterval(timer); } catch (e) {}
    });
    scriptingForeverTimers.clear();
    puzzleForeverRunners.forEach((runner) => { if (runner) runner.stopped = true; });
    roomForeverRunners.forEach((runner) => { if (runner) runner.stopped = true; });
    puzzleForeverRunners.clear();
    roomForeverRunners.clear();
    puzzleScriptingTriggerLocks.clear();
    roomScriptingTriggerLocks.clear();
    puzzleLoopGeneration.clear();
    roomLoopGeneration = 0;
}

function waitTracked(ms) {
    const delay = Math.max(0, Math.round(Number(ms) || 0));
    return new Promise((resolve) => {
        if (delay <= 0) {
            resolve();
            return;
        }
        const timer = setTimeout(() => {
            scriptingForeverTimers.delete(timer);
            resolve();
        }, delay);
        scriptingForeverTimers.add(timer);
    });
}

function waitTrackedRunner(ms, runner) {
    const delay = Math.max(0, Math.round(Number(ms) || 0));
    return new Promise((resolve) => {
        if (delay <= 0 || (runner && runner.stopped)) {
            resolve();
            return;
        }
        const timer = setTimeout(() => {
            scriptingForeverTimers.delete(timer);
            if (runner && runner.__waitTimer === timer) runner.__waitTimer = null;
            resolve();
        }, delay);
        scriptingForeverTimers.add(timer);
        if (runner) runner.__waitTimer = timer;
    });
}

function stopPuzzleForeverLoops(puzzleId) {
    const numericId = Number(puzzleId);
    if (Number.isFinite(numericId)) {
        const nextGeneration = (Number(puzzleLoopGeneration.get(numericId)) || 0) + 1;
        puzzleLoopGeneration.set(numericId, nextGeneration);
    }
    puzzleForeverRunners.forEach((runner, key) => {
        if (!runner) return;
        if (!Number.isFinite(numericId)) {
            runner.stopped = true;
            if (runner.__waitTimer) {
                try { clearTimeout(runner.__waitTimer); } catch (e) {}
                scriptingForeverTimers.delete(runner.__waitTimer);
                runner.__waitTimer = null;
            }
            return;
        }
        if (String(key || '').startsWith(`puzzle:${numericId}:`)) {
            runner.stopped = true;
            if (runner.__waitTimer) {
                try { clearTimeout(runner.__waitTimer); } catch (e) {}
                scriptingForeverTimers.delete(runner.__waitTimer);
                runner.__waitTimer = null;
            }
        }
    });
}

function stopRoomForeverLoops() {
    roomLoopGeneration += 1;
    roomForeverRunners.forEach((runner) => {
        if (!runner) return;
        runner.stopped = true;
        if (runner.__waitTimer) {
            try { clearTimeout(runner.__waitTimer); } catch (e) {}
            scriptingForeverTimers.delete(runner.__waitTimer);
            runner.__waitTimer = null;
        }
    });
}

async function waitForCueActionCompletion(result) {
    if (!result || result.success === false) return result;
    if (result.infinite === true || result.durationMs == null) {
        return { ...result, blocking: true, infinite: true };
    }
    const ms = clampDmxInt(result.durationMs, 0, 600000, 0);
    if (ms > 0) await waitTracked(ms);
    return { ...result, blocking: true, waitedMs: ms };
}

async function runPuzzleScriptingEvent(node, triggerType, eventPayload = {}) {
    if (!isRunning) return [];
    if (!node || node.type !== 'escape/Puzzle') return [];
    const normalizedTrigger = String(triggerType || '').trim().toLowerCase();
    if (!normalizedTrigger) return [];

    const customValue = String(eventPayload?.customValue || '');
    const sensorDeviceId = String(eventPayload?.sensorDeviceId || '');
    const sensorData = (eventPayload && typeof eventPayload.sensorData === 'object' && !Array.isArray(eventPayload.sensorData))
        ? eventPayload.sensorData
        : {};
    const runtimePayload = Object.assign({}, eventPayload, { currentPuzzleId: node?.id, scriptScope: 'puzzle' });
    const puzzleVarMap = getPuzzleVariableMap(node.id);
    const rules = normalizeScriptingRules(node)
        .filter(rule => rule.triggerType === normalizedTrigger)
        .filter(rule => normalizedTrigger !== 'on_sensor_data' || !rule.triggerValue || String(rule.triggerValue) === sensorDeviceId)
        .filter((rule) => {
            if (normalizedTrigger !== 'on_sensor_match') return true;
            const ruleDevice = String(rule.triggerValue || '').trim();
            if (ruleDevice && ruleDevice !== sensorDeviceId) return false;
            const ruleField = String(rule.triggerField || '').trim();
            if (!ruleField) return false;
            const actual = Object.prototype.hasOwnProperty.call(sensorData, ruleField) ? sensorData[ruleField] : '';
            const expected = String(rule.triggerExpected || '');
            return compareScriptingValues(actual, 'eq', expected);
        });
    if (!rules.length) return [];
    const puzzleName = getPuzzleName(node, node?.id);
    const scriptScope = `Puzzle Script "${puzzleName}"`;
    const touchPuzzleScripting = () => markPuzzleScriptingActive(node.id, 2000);
    touchPuzzleScripting();
    logScripting(`[Puzzle Script] "${puzzleName}" trigger "${normalizedTrigger}" matched ${rules.length} rule(s).`);

    const results = [];
    let delayMs = 0;
    const foreverGroups = new Map();
    const brokenLoopKeys = new Set();
    const brokenForeverLoopKeys = new Set();
    const getRuleLoopStack = (rule) => (Array.isArray(rule?.loopStack) ? rule.loopStack : []);
    const isRuleSuppressed = (rule) => {
        const stack = getRuleLoopStack(rule);
        for (let i = 0; i < stack.length; i += 1) {
            const key = String(stack[i]?.key || '');
            if (key && brokenLoopKeys.has(key)) return true;
        }
        return false;
    };
    const getInnermostLoop = (rule) => {
        const stack = getRuleLoopStack(rule);
        if (!stack.length) return null;
        const entry = stack[stack.length - 1] || {};
        const key = String(entry?.key || '');
        const type = String(entry?.type || '').trim().toLowerCase();
        if (!key || !type) return null;
        return { key, type };
    };
    const markLoopBroken = (rule) => {
        const fallback = getInnermostLoop(rule);
        const key = String(rule?.loopBreakKey || fallback?.key || '');
        const type = String(rule?.loopBreakType || fallback?.type || '').trim().toLowerCase();
        if (!key) return null;
        brokenLoopKeys.add(key);
        if (type === 'forever') {
            brokenForeverLoopKeys.add(key);
        }
        return { key, type };
    };
    const schedule = async (fn, label = '') => {
        if (delayMs <= 0) {
            touchPuzzleScripting();
            if (label) logScripting(label);
            return await fn();
        }
        if (label) logScripting(`${label} (scheduled +${delayMs}ms)`);
        await waitTracked(delayMs);
        if (!isRunning) return { success: false, aborted: true };
        touchPuzzleScripting();
        try { return await fn(); } catch (e) { logScriptingRuntimeError(scriptScope, 'scheduled action', e); }
        return { success: true, scheduled: true, delayMs };
    };
    const getForeverOwnerKey = (rule) => {
        const stack = getRuleLoopStack(rule);
        const owner = [...stack].reverse().find((entry) => String(entry?.type || '').trim().toLowerCase() === 'forever');
        return String(owner?.key || '');
    };
    const registerForeverEntry = (rule, entry) => {
        const key = getForeverOwnerKey(rule) || String(rule?.loopBreakKey || '');
        if (!key) return;
        if (!foreverGroups.has(key)) {
            const intervalSec = Number(rule?.loopIntervalSec);
            foreverGroups.set(key, {
                cycleDelayMs: Number.isFinite(intervalSec) ? Math.max(0, Math.round(intervalSec * 1000)) : 0,
                entries: []
            });
        }
        foreverGroups.get(key).entries.push({ rule, ...entry });
    };
    const evaluateRuleNow = (rule) => {
        try {
            if (isRuleSuppressed(rule)) return false;
            if (!evaluateScriptingCondition(rule, customValue)) return false;
            if (!evaluateVariableCondition(rule, puzzleVarMap)) return false;
            if (!evaluateSensorCondition(rule, runtimePayload)) return false;
            if (!evaluateExpressionCondition(rule, runtimePayload)) return false;
            return true;
        } catch (e) {
            logScriptingRuntimeError(scriptScope, 'evaluate rule condition', e);
            return false;
        }
    };
    for (let index = 0; index < rules.length; index += 1) {
        const rule = rules[index];
        const ruleId = getScriptingRuleId(rule, index);
        const rulePrefix = `[Puzzle Script] "${puzzleName}" rule #${ruleId}`;
        const isForeverRule = String(rule?.loopMode || '').trim().toLowerCase() === 'forever';
        if (!isForeverRule && !evaluateRuleNow(rule)) continue;
        if (rule.actionType === 'wait') {
            const seconds = Number(rule.actionValue);
            if (isForeverRule) {
                registerForeverEntry(rule, { kind: 'wait', seconds: Number.isFinite(seconds) ? seconds : 0, rulePrefix });
                return;
            }
            if (Number.isFinite(seconds) && seconds > 0) {
                delayMs += Math.round(seconds * 1000);
                logScripting(`${rulePrefix} wait ${seconds}s.`);
            }
            continue;
        }
        if (rule.actionType === 'break') {
            const execute = () => {
                if (!evaluateRuleNow(rule)) return;
                const broken = markLoopBroken(rule);
                if (!broken) return;
                logScripting(`${rulePrefix} break loop "${broken.type}:${broken.key}".`);
                return { success: true };
            };
            if (isForeverRule) {
                registerForeverEntry(rule, { kind: 'break', execute, rulePrefix });
            } else {
                const scheduled = await schedule(execute, `${rulePrefix} break.`);
                if (scheduled) results.push(scheduled);
            }
            continue;
        }
        if (rule.actionType === 'break_all_loops') {
            const execute = () => {
                if (!evaluateRuleNow(rule)) return;
                stopPuzzleForeverLoops(node?.id);
                brokenForeverLoopKeys.forEach((key) => brokenLoopKeys.add(key));
                logScripting(`${rulePrefix} break all loops.`);
                return { success: true };
            };
            if (isForeverRule) {
                registerForeverEntry(rule, { kind: 'break', execute, rulePrefix });
            } else {
                const scheduled = await schedule(execute, `${rulePrefix} break all loops.`);
                if (scheduled) results.push(scheduled);
            }
            continue;
        }
        if (rule.actionType === 'set_var_from_sensor') {
            const varName = String(rule.actionValue || '').trim();
            if (!varName) continue;
            const execute = () => {
                if (!evaluateRuleNow(rule)) return;
                const value = getSensorFieldValue(runtimePayload, rule.actionSourceDevice, rule.actionSourceField);
                puzzleVarMap[varName] = value;
                logScripting(`${rulePrefix} set variable "${varName}" = ${JSON.stringify(value)}`);
            };
            if (isForeverRule) {
                registerForeverEntry(rule, { kind: 'action', execute, rulePrefix });
            } else {
                const scheduled = await schedule(execute, `${rulePrefix} set variable "${varName}" from sensor.`);
                if (scheduled) results.push(scheduled);
            }
            continue;
        }
        if (rule.actionType === 'get_state') {
            const varName = String(rule.actionValue || '').trim();
            if (!varName) continue;
            const execute = () => {
                if (!evaluateRuleNow(rule)) return;
                puzzleVarMap[varName] = getPuzzleStateKey(node.id);
                logScripting(`${rulePrefix} read state -> "${varName}" = ${puzzleVarMap[varName]}`);
                return { success: true };
            };
            if (isForeverRule) {
                registerForeverEntry(rule, { kind: 'action', execute, rulePrefix });
            } else {
                const scheduled = await schedule(execute, `${rulePrefix} get puzzle state.`);
                if (scheduled) results.push(scheduled);
            }
            continue;
        }
        if (rule.actionType === 'set_state') {
            const targetState = resolveScriptingStateTarget(rule.actionValue);
            const execute = () => {
                if (!evaluateRuleNow(rule)) return;
                applyPuzzleState(node.id, targetState);
                logScripting(`${rulePrefix} set puzzle state to "${targetState}".`);
                return { success: true };
            };
            if (isForeverRule) {
                registerForeverEntry(rule, { kind: 'action', execute, rulePrefix });
            } else {
                const scheduled = await schedule(execute, `${rulePrefix} set puzzle state.`);
                if (scheduled) results.push(scheduled);
            }
            continue;
        }
        if (rule.actionType === 'play_cue') {
            if (rule.actionValue.trim()) {
                const execute = async () => {
                    if (!evaluateRuleNow(rule)) return;
                    const cueResult = runDmxCueAction(rule.actionValue, { triggerType: normalizedTrigger });
                    return await waitForCueActionCompletion(cueResult);
                };
                if (isForeverRule) {
                    registerForeverEntry(rule, { kind: 'action', execute, rulePrefix });
                } else {
                    const scheduled = await schedule(
                        execute,
                        `${rulePrefix} play cue "${rule.actionValue}".`
                    );
                    if (scheduled) results.push(scheduled);
                }
            }
            continue;
        }
        if (rule.actionType === 'play_sound') {
            if (String(rule.actionValue || '').trim()) {
                const execute = () => {
                    if (!evaluateRuleNow(rule)) return;
                    return runSoundCueAction(rule.actionValue, { triggerType: normalizedTrigger });
                };
                if (isForeverRule) {
                    registerForeverEntry(rule, { kind: 'action', execute, rulePrefix });
                } else {
                    const scheduled = await schedule(
                        execute,
                        `${rulePrefix} play sound "${rule.actionValue}".`
                    );
                    if (scheduled) results.push(scheduled);
                }
            }
            continue;
        }
        if (rule.actionType === 'send_custom') {
            const execute = () => {
                if (!evaluateRuleNow(rule)) return;
                const payload = resolveSendCustomPayload(rule, runtimePayload);
                logScripting(`${rulePrefix} send custom "${payload}".`);
                return runSendCustomAction(node, payload);
            };
            if (isForeverRule) {
                registerForeverEntry(rule, { kind: 'action', execute, rulePrefix });
            } else {
                const scheduled = await schedule(execute, `${rulePrefix} send custom.`);
                if (scheduled) results.push(scheduled);
            }
            continue;
        }
        if (rule.actionType === 'print_system') {
            const execute = () => {
                if (!evaluateRuleNow(rule)) return;
                const payload = resolveSystemPrintPayload(rule, runtimePayload);
                logSystem(`Puzzle Message: ${payload}`, 'system');
                return { success: true };
            };
            if (isForeverRule) {
                registerForeverEntry(rule, { kind: 'action', execute, rulePrefix });
            } else {
                const scheduled = await schedule(execute, '');
                if (scheduled) results.push(scheduled);
            }
            continue;
        }
        if (rule.actionType === 'give_hint') {
            const execute = () => {
                if (!evaluateRuleNow(rule)) return;
                const rawValue = String(rule.actionValue || '').trim();
                if (rawValue.startsWith('hint:')) {
                    const hintIndex = parseInt(rawValue.slice(5), 10);
                    const result = triggerHintByIndexForPuzzle(node.id, hintIndex, {
                        showAssignment: node.properties?.showHintAssignment !== false
                    });
                    if (!result?.success) {
                        logSystem(`Give Hint failed (${puzzleName}): ${result?.error || 'Unknown error'}`, 'error');
                    }
                    return result;
                }
                const payload = resolveSendCustomPayload(rule, runtimePayload).trim();
                if (!payload) return { success: false, error: 'Hint text required' };
                const result = triggerCustomHint(node.id, payload, {
                    showAssignment: node.properties?.showHintAssignment !== false
                });
                if (!result?.success) {
                    logSystem(`Give Hint failed (${puzzleName}): ${result?.error || 'Unknown error'}`, 'error');
                }
                return result;
            };
            if (isForeverRule) {
                registerForeverEntry(rule, { kind: 'action', execute, rulePrefix });
            } else {
                const scheduled = await schedule(execute, `${rulePrefix} give hint.`);
                if (scheduled) results.push(scheduled);
            }
            continue;
        }
        if (rule.actionType === 'send_custom_var') {
            const execute = () => {
                if (!evaluateRuleNow(rule)) return;
                const varName = String(rule.actionValue || '').trim();
                const value = Object.prototype.hasOwnProperty.call(puzzleVarMap, varName) ? puzzleVarMap[varName] : '';
                logScripting(`${rulePrefix} send custom variable "${varName}" = ${JSON.stringify(value)}`);
                return runSendCustomAction(node, String(value ?? ''));
            };
            if (isForeverRule) {
                registerForeverEntry(rule, { kind: 'action', execute, rulePrefix });
            } else {
                const scheduled = await schedule(execute, `${rulePrefix} send custom variable.`);
                if (scheduled) results.push(scheduled);
            }
        }
    }
    const foreverRunnerTasks = [];
    const puzzleIdNumeric = Number(node?.id);
    const localLoopGeneration = Number(puzzleLoopGeneration.get(puzzleIdNumeric)) || 0;
    foreverGroups.forEach((group, loopKey) => {
        const runnerKey = `puzzle:${node.id}:${normalizedTrigger}:${loopKey}`;
        if (!group?.entries?.length || puzzleForeverRunners.has(runnerKey)) return;
        const runner = { stopped: false, generation: localLoopGeneration };
        puzzleForeverRunners.set(runnerKey, runner);
        const hasWait = group.entries.some((entry) => entry.kind === 'wait');
        const runnerTask = (async () => {
            try {
                while (isRunning && !runner.stopped) {
                    const currentGeneration = Number(puzzleLoopGeneration.get(puzzleIdNumeric)) || 0;
                    if (runner.generation !== currentGeneration) {
                        runner.stopped = true;
                        break;
                    }
                    for (const entry of group.entries) {
                        if (!isRunning || runner.stopped) break;
                        const currentGenerationInner = Number(puzzleLoopGeneration.get(puzzleIdNumeric)) || 0;
                        if (runner.generation !== currentGenerationInner) {
                            runner.stopped = true;
                            break;
                        }
                        if (brokenForeverLoopKeys.has(loopKey)) {
                            runner.stopped = true;
                            break;
                        }
                        const rule = entry.rule;
                        if (!evaluateRuleNow(rule)) continue;
                        if (entry.kind === 'wait') {
                            const sec = Number(entry.seconds);
                            if (Number.isFinite(sec) && sec > 0) {
                                touchPuzzleScripting();
                                logScripting(`${entry.rulePrefix} wait ${sec}s.`);
                                await waitTrackedRunner(sec * 1000, runner);
                            }
                            continue;
                        }
                        if (entry.kind === 'break') {
                            touchPuzzleScripting();
                            const broken = markLoopBroken(rule);
                            if (broken) logScripting(`${entry.rulePrefix} break loop "${broken.type}:${broken.key}".`);
                            runner.stopped = true;
                            break;
                        }
                        touchPuzzleScripting();
                        try { await entry.execute(); } catch (e) { logScriptingRuntimeError(scriptScope, 'forever action', e); }
                    }
                    // No implicit gap between loop cycles.
                    // Timing should be controlled only by explicit Wait actions
                    // or by blocking actions (e.g. cue/scene duration).
                }
            } finally {
                puzzleForeverRunners.delete(runnerKey);
            }
        })();
        foreverRunnerTasks.push(runnerTask);
    });
    if (foreverRunnerTasks.length) {
        await Promise.allSettled(foreverRunnerTasks);
    }
    return results;
}

async function runRoomScriptingEvent(triggerType, eventPayload = {}) {
    const runtimePayload = Object.assign({}, eventPayload, { scriptScope: 'room' });
    const normalizedTrigger = String(triggerType || '').trim().toLowerCase();
    if (!normalizedTrigger) return [];
    const isResetTrigger = normalizedTrigger === 'room_reset' || normalizedTrigger === 'branch_reset';
    if (!isRunning && !isResetTrigger) return [];
    const sensorDeviceId = String(eventPayload?.sensorDeviceId || '');
    const sensorData = (eventPayload && typeof eventPayload.sensorData === 'object' && !Array.isArray(eventPayload.sensorData))
        ? eventPayload.sensorData
        : {};
    const branchId = Number.isFinite(Number(eventPayload?.branchId)) ? String(Number(eventPayload.branchId)) : '';
    const eventState = String(eventPayload?.state || '').trim().toLowerCase();
    const rules = normalizeRoomScriptingRules()
        .filter((rule) => rule.triggerType === normalizedTrigger)
        .filter((rule) => (normalizedTrigger !== 'branch_reset' && normalizedTrigger !== 'branch_state_change')
            || !String(rule.triggerValue || '').trim()
            || String(rule.triggerValue).trim() === branchId)
        .filter((rule) => {
            if (normalizedTrigger !== 'any_puzzle_state'
                && normalizedTrigger !== 'room_state_change'
                && normalizedTrigger !== 'branch_state_change') {
                return true;
            }
            const expectedState = normalizedTrigger === 'branch_state_change'
                ? String(rule.triggerField || '').trim().toLowerCase()
                : String(rule.triggerValue || '').trim().toLowerCase();
            return !expectedState || expectedState === eventState;
        })
        .filter((rule) => normalizedTrigger !== 'sensor_data' || !rule.triggerValue || String(rule.triggerValue) === sensorDeviceId)
        .filter((rule) => {
            if (normalizedTrigger !== 'sensor_match') return true;
            const ruleDevice = String(rule.triggerValue || '').trim();
            if (ruleDevice && ruleDevice !== sensorDeviceId) return false;
            const ruleField = String(rule.triggerField || '').trim();
            if (!ruleField) return false;
            const actual = Object.prototype.hasOwnProperty.call(sensorData, ruleField) ? sensorData[ruleField] : '';
            const expected = String(rule.triggerExpected || '');
            return compareScriptingValues(actual, 'eq', expected);
        });
    if (!rules.length) return [];
    const touchRoomScripting = () => markRoomScriptingActive(2000);
    const scriptScope = 'Room Script';
    touchRoomScripting();
    logScripting(`[Room Script] trigger "${normalizedTrigger}" matched ${rules.length} rule(s).`);
    const results = [];
    let delayMs = 0;
    const foreverGroups = new Map();
    const brokenLoopKeys = new Set();
    const brokenForeverLoopKeys = new Set();
    const getRuleLoopStack = (rule) => (Array.isArray(rule?.loopStack) ? rule.loopStack : []);
    const isRuleSuppressed = (rule) => {
        const stack = getRuleLoopStack(rule);
        for (let i = 0; i < stack.length; i += 1) {
            const key = String(stack[i]?.key || '');
            if (key && brokenLoopKeys.has(key)) return true;
        }
        return false;
    };
    const getInnermostLoop = (rule) => {
        const stack = getRuleLoopStack(rule);
        if (!stack.length) return null;
        const entry = stack[stack.length - 1] || {};
        const key = String(entry?.key || '');
        const type = String(entry?.type || '').trim().toLowerCase();
        if (!key || !type) return null;
        return { key, type };
    };
    const markLoopBroken = (rule) => {
        const fallback = getInnermostLoop(rule);
        const key = String(rule?.loopBreakKey || fallback?.key || '');
        const type = String(rule?.loopBreakType || fallback?.type || '').trim().toLowerCase();
        if (!key) return null;
        brokenLoopKeys.add(key);
        if (type === 'forever') {
            brokenForeverLoopKeys.add(key);
        }
        return { key, type };
    };
    const schedule = async (fn, label = '') => {
        if (delayMs <= 0) {
            touchRoomScripting();
            if (label) logScripting(label);
            return await fn();
        }
        if (label) logScripting(`${label} (scheduled +${delayMs}ms)`);
        await waitTracked(delayMs);
        if (!isRunning) return { success: false, aborted: true };
        touchRoomScripting();
        try { return await fn(); } catch (e) { logScriptingRuntimeError(scriptScope, 'scheduled action', e); }
        return { success: true, scheduled: true, delayMs };
    };
    const getForeverOwnerKey = (rule) => {
        const stack = getRuleLoopStack(rule);
        const owner = [...stack].reverse().find((entry) => String(entry?.type || '').trim().toLowerCase() === 'forever');
        return String(owner?.key || '');
    };
    const registerForeverEntry = (rule, entry) => {
        const key = getForeverOwnerKey(rule) || String(rule?.loopBreakKey || '');
        if (!key) return;
        if (!foreverGroups.has(key)) {
            const intervalSec = Number(rule?.loopIntervalSec);
            foreverGroups.set(key, {
                cycleDelayMs: Number.isFinite(intervalSec) ? Math.max(0, Math.round(intervalSec * 1000)) : 0,
                entries: []
            });
        }
        foreverGroups.get(key).entries.push({ rule, ...entry });
    };
    const evaluateRuleNow = (rule) => {
        try {
            if (isRuleSuppressed(rule)) return false;
            if (!evaluateVariableCondition(rule, roomScriptingVariables)) return false;
            if (!evaluateSensorCondition(rule, runtimePayload)) return false;
            if (!evaluateExpressionCondition(rule, runtimePayload)) return false;
            return true;
        } catch (e) {
            logScriptingRuntimeError(scriptScope, 'evaluate rule condition', e);
            return false;
        }
    };
    for (let index = 0; index < rules.length; index += 1) {
        const rule = rules[index];
        const ruleId = getScriptingRuleId(rule, index);
        const rulePrefix = `[Room Script] rule #${ruleId}`;
        const isForeverRule = String(rule?.loopMode || '').trim().toLowerCase() === 'forever';
        if (!isForeverRule && !evaluateRuleNow(rule)) continue;
        if (rule.actionType === 'wait') {
            const seconds = Number(rule.actionValue);
            if (isForeverRule) {
                registerForeverEntry(rule, { kind: 'wait', seconds: Number.isFinite(seconds) ? seconds : 0, rulePrefix });
                return;
            }
            if (Number.isFinite(seconds) && seconds > 0) {
                delayMs += Math.round(seconds * 1000);
                logScripting(`${rulePrefix} wait ${seconds}s.`);
            }
            continue;
        }
        if (rule.actionType === 'break') {
            const execute = () => {
                if (!evaluateRuleNow(rule)) return;
                const broken = markLoopBroken(rule);
                if (!broken) return;
                logScripting(`${rulePrefix} break loop "${broken.type}:${broken.key}".`);
                return { success: true };
            };
            if (isForeverRule) {
                registerForeverEntry(rule, { kind: 'break', execute, rulePrefix });
            } else {
                const scheduled = await schedule(execute, `${rulePrefix} break.`);
                if (scheduled) results.push(scheduled);
            }
            continue;
        }
        if (rule.actionType === 'break_all_loops') {
            const execute = () => {
                if (!evaluateRuleNow(rule)) return;
                stopRoomForeverLoops();
                brokenForeverLoopKeys.forEach((key) => brokenLoopKeys.add(key));
                logScripting(`${rulePrefix} break all loops.`);
                return { success: true };
            };
            if (isForeverRule) {
                registerForeverEntry(rule, { kind: 'break', execute, rulePrefix });
            } else {
                const scheduled = await schedule(execute, `${rulePrefix} break all loops.`);
                if (scheduled) results.push(scheduled);
            }
            continue;
        }
        if (rule.actionType === 'set_var_from_sensor') {
            const varName = String(rule.actionValue || '').trim();
            if (!varName) continue;
            const execute = () => {
                if (!evaluateRuleNow(rule)) return;
                const value = getSensorFieldValue(runtimePayload, rule.actionSourceDevice, rule.actionSourceField);
                roomScriptingVariables[varName] = value;
                logScripting(`${rulePrefix} set variable "${varName}" = ${JSON.stringify(value)}`);
            };
            if (isForeverRule) {
                registerForeverEntry(rule, { kind: 'action', execute, rulePrefix });
            } else {
                const scheduled = await schedule(execute, `${rulePrefix} set variable from sensor.`);
                if (scheduled) results.push(scheduled);
            }
            continue;
        }
        if (rule.actionType === 'set_branch_state') {
            const target = String(rule.actionTargetPuzzle || 'room');
            const value = String(rule.actionValue || 'running');
            const execute = () => {
                if (!evaluateRuleNow(rule)) return;
                return applyRoomScriptingBranchState(rule);
            };
            if (isForeverRule) {
                registerForeverEntry(rule, { kind: 'action', execute, rulePrefix });
            } else {
                const scheduled = await schedule(
                    execute,
                    `${rulePrefix} set branch "${target}" to "${value}".`
                );
                if (scheduled) results.push(scheduled);
            }
            continue;
        }
        if (rule.actionType === 'play_cue' && String(rule.actionValue || '').trim()) {
            const execute = async () => {
                if (!evaluateRuleNow(rule)) return;
                const cueResult = runDmxCueAction(rule.actionValue, { triggerType: normalizedTrigger });
                return await waitForCueActionCompletion(cueResult);
            };
            if (isForeverRule) {
                registerForeverEntry(rule, { kind: 'action', execute, rulePrefix });
            } else {
                const scheduled = await schedule(
                    execute,
                    `${rulePrefix} play cue "${rule.actionValue}".`
                );
                if (scheduled) results.push(scheduled);
            }
            continue;
        }
        if (rule.actionType === 'play_sound' && String(rule.actionValue || '').trim()) {
            const execute = () => {
                if (!evaluateRuleNow(rule)) return;
                return runSoundCueAction(rule.actionValue, { triggerType: normalizedTrigger });
            };
            if (isForeverRule) {
                registerForeverEntry(rule, { kind: 'action', execute, rulePrefix });
            } else {
                const scheduled = await schedule(
                    execute,
                    `${rulePrefix} play sound "${rule.actionValue}".`
                );
                if (scheduled) results.push(scheduled);
            }
            continue;
        }
        if (rule.actionType === 'print_system') {
            const execute = () => {
                if (!evaluateRuleNow(rule)) return;
                const payload = resolveSystemPrintPayload(rule, runtimePayload);
                logSystem(`Room Message: ${payload}`, 'system');
                return { success: true };
            };
            if (isForeverRule) {
                registerForeverEntry(rule, { kind: 'action', execute, rulePrefix });
            } else {
                const scheduled = await schedule(execute, '');
                if (scheduled) results.push(scheduled);
            }
        }
    }
    const foreverRunnerTasks = [];
    const localLoopGeneration = roomLoopGeneration;
    foreverGroups.forEach((group, loopKey) => {
        const runnerKey = `room:${normalizedTrigger}:${loopKey}`;
        if (!group?.entries?.length || roomForeverRunners.has(runnerKey)) return;
        const runner = { stopped: false, generation: localLoopGeneration };
        roomForeverRunners.set(runnerKey, runner);
        const hasWait = group.entries.some((entry) => entry.kind === 'wait');
        const runnerTask = (async () => {
            try {
                while (isRunning && !runner.stopped) {
                    if (runner.generation !== roomLoopGeneration) {
                        runner.stopped = true;
                        break;
                    }
                    for (const entry of group.entries) {
                        if (!isRunning || runner.stopped) break;
                        if (runner.generation !== roomLoopGeneration) {
                            runner.stopped = true;
                            break;
                        }
                        if (brokenForeverLoopKeys.has(loopKey)) {
                            runner.stopped = true;
                            break;
                        }
                        const rule = entry.rule;
                        if (!evaluateRuleNow(rule)) continue;
                        if (entry.kind === 'wait') {
                            const sec = Number(entry.seconds);
                            if (Number.isFinite(sec) && sec > 0) {
                                touchRoomScripting();
                                logScripting(`${entry.rulePrefix} wait ${sec}s.`);
                                await waitTrackedRunner(sec * 1000, runner);
                            }
                            continue;
                        }
                        if (entry.kind === 'break') {
                            touchRoomScripting();
                            const broken = markLoopBroken(rule);
                            if (broken) logScripting(`${entry.rulePrefix} break loop "${broken.type}:${broken.key}".`);
                            runner.stopped = true;
                            break;
                        }
                        touchRoomScripting();
                        try { await entry.execute(); } catch (e) { logScriptingRuntimeError(scriptScope, 'forever action', e); }
                    }
                    // No implicit gap between loop cycles.
                    // Timing should be controlled only by explicit Wait actions
                    // or by blocking actions (e.g. cue/scene duration).
                }
            } finally {
                roomForeverRunners.delete(runnerKey);
            }
        })();
        foreverRunnerTasks.push(runnerTask);
    });
    if (foreverRunnerTasks.length) {
        await Promise.allSettled(foreverRunnerTasks);
    }
    return results;
}

function dispatchZigbeeSensorDataEvent(deviceId, payload, context = {}) {
    if (!isRunning) return;
    const safeDeviceId = String(deviceId || '').trim();
    if (!safeDeviceId) return;
    const sensorData = extractSensorDataMap(payload);
    const eventPayload = {
        sensorDeviceId: safeDeviceId,
        sensorData,
        topic: String(context?.topic || '')
    };
    updateRoomScriptSensorInstance(safeDeviceId, sensorData);
    const puzzleNodes = getAllPuzzleNodes();
    puzzleNodes.forEach((node) => {
        const stateKey = getPuzzleStateKey(node?.id);
        if (stateKey === 'running') {
            updatePuzzleScriptSensorInstance(node?.id, safeDeviceId, sensorData);
        }
    });
    puzzleNodes.forEach((node) => {
        runPuzzleScriptingEvent(node, 'on_sensor_data', eventPayload);
        runPuzzleScriptingEvent(node, 'on_sensor_match', eventPayload);
    });
    runRoomScriptingEvent('sensor_data', eventPayload);
    runRoomScriptingEvent('sensor_match', eventPayload);
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
            `SELECT key, value FROM config WHERE key IN (?, ?, ?, ?, ?, ?, ?, ?)`,
            [SETTINGS_KEYS.mqttPort, SETTINGS_KEYS.screenSaverImage, SETTINGS_KEYS.victoryScreen, SETTINGS_KEYS.mediaServerEnabled, SETTINGS_KEYS.autostartEnabled, SETTINGS_KEYS.zigbeeBridgeEnabled, SETTINGS_KEYS.dmxServiceEnabled, SETTINGS_KEYS.zigbeeDeviceCache]
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
        systemSettings.zigbeeBridgeEnabled = parseBoolSetting(map[SETTINGS_KEYS.zigbeeBridgeEnabled], false);
        systemSettings.dmxServiceEnabled = parseBoolSetting(map[SETTINGS_KEYS.dmxServiceEnabled], false);
        restoreZigbeeDeviceCache(map[SETTINGS_KEYS.zigbeeDeviceCache] || "");
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

async function getSystemSettings() {
    const [autostartState, zigbeeBridgeState, dmxServiceState] = await Promise.all([
        getAutostartState(),
        getZigbeeBridgeState(),
        getDmxServiceState()
    ]);
    return {
        ...systemSettings,
        autostartEnabled: autostartState.enabled,
        autostartStatus: autostartState.status,
        zigbeeBridgeEnabled: zigbeeBridgeState.enabled,
        zigbeeBridgeStatus: zigbeeBridgeState.status,
        zigbeeBridgeAvailable: zigbeeBridgeState.available,
        dmxServiceEnabled: dmxServiceState.enabled,
        dmxServiceStatus: dmxServiceState.status,
        dmxServiceAvailable: dmxServiceState.available,
        dmxAdapter: getDmxAdapterInfo(),
        zigbeeAdapter: getZigbeeAdapterInfo(),
        soundOutput: getSoundOutputInfo()
    };
}

function getZigbeeDevices() {
    return { success: true, ...getZigbeeDevicesSnapshot() };
}

function refreshZigbeeDevices() {
    requestZigbeeDevicesRefresh();
    return { success: true, ...getZigbeeDevicesSnapshot() };
}

function hideZigbeeDevice(deviceId) {
    const id = String(deviceId || "").trim();
    if (!id || !zigbeeDevices[id]) {
        return { success: false, error: "Device not found" };
    }
    // Deleting from list should also clear learned signal fields for this device.
    zigbeeDevices[id] = {
        ...zigbeeDevices[id],
        messageEntries: [],
        lastPayload: null
    };
    Object.keys(puzzleScriptingSensorInstances).forEach((puzzleId) => {
        if (puzzleScriptingSensorInstances[puzzleId] && Object.prototype.hasOwnProperty.call(puzzleScriptingSensorInstances[puzzleId], id)) {
            delete puzzleScriptingSensorInstances[puzzleId][id];
        }
    });
    if (roomScriptingSensorInstances[id]) delete roomScriptingSensorInstances[id];
    zigbeeHiddenDeviceIds.add(id);
    schedulePersistZigbeeDeviceCache();
    return { success: true, deviceId: id };
}

async function renameZigbeeDevice(deviceId, nextNameRaw) {
    const id = String(deviceId || "").trim();
    const nextName = normalizeZigbeeFriendlyName(nextNameRaw || "");
    if (!id) return { success: false, error: "deviceId required" };
    if (!nextName) return { success: false, error: "newName required" };
    const current = zigbeeDevices[id];
    if (!current) return { success: false, error: "Device not found" };

    const oldName = normalizeZigbeeFriendlyName(current.friendlyName || "");
    if (!oldName) return { success: false, error: "Device has no friendly name" };
    if (oldName.toLowerCase() === nextName.toLowerCase()) {
        return { success: true, unchanged: true, device: current };
    }
    const ok = publishZigbeeBridgeRequest("device/rename", { from: oldName, to: nextName });
    if (!ok) return { success: false, error: "Could not publish rename request" };

    const normalizedOld = normalizeZigbeeKey(oldName);
    zigbeeDevices[id] = {
        ...current,
        friendlyName: nextName,
        lastSeen: Date.now()
    };
    // Keep old->id alias temporarily to absorb late MQTT messages still using the old friendly name.
    if (normalizedOld) zigbeeFriendlyIndex[normalizedOld] = id;
    zigbeeFriendlyIndex[normalizeZigbeeKey(nextName)] = id;
    schedulePersistZigbeeDeviceCache();
    logSystem(`Zigbee device renamed: ${oldName} -> ${nextName}`, "info");
    return { success: true, device: zigbeeDevices[id] };
}

function setZigbeeDeviceResetOnPuzzleReset(deviceId, enabled) {
    const id = String(deviceId || "").trim();
    if (!id || !zigbeeDevices[id]) {
        return { success: false, error: "Device not found" };
    }
    zigbeeDevices[id] = {
        ...zigbeeDevices[id],
        resetOnPuzzleReset: !!enabled
    };
    schedulePersistZigbeeDeviceCache();
    return { success: true, device: zigbeeDevices[id] };
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

function getSystemctlSpawnArgs(args) {
    const normalizedArgs = Array.isArray(args) ? args : [];
    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
        return { command: 'sudo', args: ['-n', 'systemctl', ...normalizedArgs] };
    }
    return { command: 'systemctl', args: normalizedArgs };
}

function runSystemctlAsync(args) {
    return new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        let child = null;
        try {
            const spawnArgs = getSystemctlSpawnArgs(args);
            child = spawn(spawnArgs.command, spawnArgs.args, { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
            reject(err);
            return;
        }
        if (child.stdout) {
            child.stdout.on('data', (chunk) => {
                try { stdout += chunk.toString(); } catch (e) {}
            });
        }
        if (child.stderr) {
            child.stderr.on('data', (chunk) => {
                try { stderr += chunk.toString(); } catch (e) {}
            });
        }
        child.on('error', (err) => reject(err));
        child.on('close', (code) => {
            if (code === 0) {
                resolve((stdout || '').trim());
                return;
            }
            const msg = (stderr || stdout || `systemctl exited with code ${code}`).toString().trim();
            reject(new Error(msg));
        });
    });
}

function querySystemctlAsync(args) {
    return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let child = null;
        try {
            child = spawn('systemctl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
            resolve({ ok: false, output: '', error: err?.message || 'systemctl failed' });
            return;
        }
        if (child.stdout) {
            child.stdout.on('data', (chunk) => {
                try { stdout += chunk.toString(); } catch (e) {}
            });
        }
        if (child.stderr) {
            child.stderr.on('data', (chunk) => {
                try { stderr += chunk.toString(); } catch (e) {}
            });
        }
        child.on('error', (err) => {
            resolve({ ok: false, output: '', error: err?.message || 'systemctl failed' });
        });
        child.on('close', (code) => {
            resolve({
                ok: code === 0,
                output: (stdout || '').trim(),
                error: (stderr || '').trim()
            });
        });
    });
}

async function ensureAutostartServiceFile() {
    if (fs.existsSync(AUTOSTART_SERVICE_PATH)) return { success: true };
    const content = buildAutostartServiceDefinition();
    await fsp.writeFile(AUTOSTART_SERVICE_PATH, content, { encoding: 'utf8' });
    return { success: true };
}

async function getAutostartState() {
    if (!isLinuxSystem()) {
        return { enabled: systemSettings.autostartEnabled, status: 'Unsupported' };
    }
    const enabledRes = await querySystemctlAsync(['is-enabled', AUTOSTART_SERVICE_NAME]);
    const enabled = enabledRes.output === 'enabled';
    const activeRes = await querySystemctlAsync(['is-active', AUTOSTART_SERVICE_NAME]);
    const active = activeRes.output === 'active';
    if (!enabledRes.output && !activeRes.output) {
        return { enabled: systemSettings.autostartEnabled, status: 'Unknown' };
    }
    const status = enabled ? (active ? 'Enabled (Running)' : 'Enabled') : 'Disabled';
    return { enabled, status };
}

async function getZigbeeBridgeState() {
    if (!isLinuxSystem()) {
        return { enabled: systemSettings.zigbeeBridgeEnabled, running: false, available: false, status: 'Unsupported' };
    }
    const loadRes = await querySystemctlAsync(['show', ZIGBEE_BRIDGE_SERVICE_NAME, '--property=LoadState', '--value']);
    const loadState = (loadRes.output || '').trim();
    if (loadState === 'not-found') {
        return { enabled: false, running: false, available: false, status: 'Service not installed' };
    }
    const activeRes = await querySystemctlAsync(['is-active', ZIGBEE_BRIDGE_SERVICE_NAME]);
    const running = activeRes.output === 'active';
    const enabledRes = await querySystemctlAsync(['is-enabled', ZIGBEE_BRIDGE_SERVICE_NAME]);
    const unitEnabled = enabledRes.output === 'enabled';
    const enabled = unitEnabled;
    const status = running
        ? 'Running'
        : (unitEnabled ? 'Enabled (Stopped)' : 'Stopped');
    return { enabled, running, available: true, status };
}

async function getDmxServiceState() {
    if (!isLinuxSystem()) {
        return { enabled: systemSettings.dmxServiceEnabled, running: false, available: false, status: 'Unsupported' };
    }
    const loadRes = await querySystemctlAsync(['show', DMX_SERVICE_NAME, '--property=LoadState', '--value']);
    const loadState = (loadRes.output || '').trim();
    if (loadState === 'not-found') {
        return { enabled: false, running: false, available: false, status: 'Service not installed' };
    }
    const activeRes = await querySystemctlAsync(['is-active', DMX_SERVICE_NAME]);
    const running = activeRes.output === 'active';
    const enabledRes = await querySystemctlAsync(['is-enabled', DMX_SERVICE_NAME]);
    const unitEnabled = enabledRes.output === 'enabled';
    const enabled = unitEnabled;
    const status = running
        ? 'Running'
        : (unitEnabled ? 'Enabled (Stopped)' : 'Stopped');
    return { enabled, running, available: true, status };
}

async function setAutostartEnabled(enabled) {
    if (!isLinuxSystem()) {
        return { success: false, error: 'Autostart only supported on Linux.' };
    }
    const next = !!enabled;
    try {
        if (next) {
            await ensureAutostartServiceFile();
            await runSystemctlAsync(['daemon-reload']);
            await runSystemctlAsync(['enable', AUTOSTART_SERVICE_NAME]);
        } else {
            await runSystemctlAsync(['disable', AUTOSTART_SERVICE_NAME]);
        }
        systemSettings.autostartEnabled = next;
        await db.run(
            "INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)",
            [SETTINGS_KEYS.autostartEnabled, next ? "1" : "0"]
        );
        const state = await getAutostartState();
        return { success: true, enabled: state.enabled, status: state.status };
    } catch (err) {
        return { success: false, error: err.message || 'Autostart update failed.' };
    }
}

async function setZigbeeBridgeEnabled(enabled) {
    if (!isLinuxSystem()) {
        return { success: false, error: 'Zigbee Bridge service only supported on Linux.' };
    }
    const next = !!enabled;
    try {
        const currentState = await getZigbeeBridgeState();
        if (!currentState.available && next) {
            return { success: false, error: 'zigbee2mqtt.service not found. Install Zigbee2MQTT first.' };
        }
        if (!currentState.available && !next) {
            systemSettings.zigbeeBridgeEnabled = false;
            await db.run(
                "INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)",
                [SETTINGS_KEYS.zigbeeBridgeEnabled, "0"]
            );
            return { success: true, enabled: false, status: 'Service not installed', available: false, running: false };
        }
        await runSystemctlAsync(['daemon-reload']);
        if (next) {
            await runSystemctlAsync(['enable', ZIGBEE_BRIDGE_SERVICE_NAME]);
            await runSystemctlAsync(['start', ZIGBEE_BRIDGE_SERVICE_NAME]);
        } else {
            await runSystemctlAsync(['stop', ZIGBEE_BRIDGE_SERVICE_NAME]);
            await runSystemctlAsync(['disable', ZIGBEE_BRIDGE_SERVICE_NAME]);
        }
        const state = await getZigbeeBridgeState();
        systemSettings.zigbeeBridgeEnabled = state.enabled;
        await db.run(
            "INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)",
            [SETTINGS_KEYS.zigbeeBridgeEnabled, state.enabled ? "1" : "0"]
        );
        return { success: true, enabled: state.enabled, status: state.status, available: state.available, running: state.running };
    } catch (err) {
        return { success: false, error: err.message || 'Zigbee Bridge update failed.' };
    }
}

async function setDmxServiceEnabled(enabled) {
    if (!isLinuxSystem()) {
        return { success: false, error: 'DMX service only supported on Linux.' };
    }
    const next = !!enabled;
    try {
        const currentState = await getDmxServiceState();
        if (!currentState.available && next) {
            return { success: false, error: 'olad.service not found. Install OLA first.' };
        }
        if (!currentState.available && !next) {
            systemSettings.dmxServiceEnabled = false;
            await db.run(
                "INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)",
                [SETTINGS_KEYS.dmxServiceEnabled, "0"]
            );
            return { success: true, enabled: false, status: 'Service not installed', available: false, running: false };
        }
        await runSystemctlAsync(['daemon-reload']);
        if (next) {
            await runSystemctlAsync(['enable', DMX_SERVICE_NAME]);
            await runSystemctlAsync(['start', DMX_SERVICE_NAME]);
        } else {
            await runSystemctlAsync(['stop', DMX_SERVICE_NAME]);
            await runSystemctlAsync(['disable', DMX_SERVICE_NAME]);
        }
        const state = await getDmxServiceState();
        systemSettings.dmxServiceEnabled = state.enabled;
        await db.run(
            "INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)",
            [SETTINGS_KEYS.dmxServiceEnabled, state.enabled ? "1" : "0"]
        );
        return { success: true, enabled: state.enabled, status: state.status, available: state.available, running: state.running };
    } catch (err) {
        return { success: false, error: err.message || 'DMX service update failed.' };
    }
}

async function reconcileManagedServiceStateOnStartup() {
    if (!isLinuxSystem()) return;
    try {
        if (systemSettings.zigbeeBridgeEnabled) {
            const state = await getZigbeeBridgeState();
            if (state.available && !state.running) {
                await runSystemctlAsync(['daemon-reload']);
                await runSystemctlAsync(['enable', ZIGBEE_BRIDGE_SERVICE_NAME]);
                await runSystemctlAsync(['start', ZIGBEE_BRIDGE_SERVICE_NAME]);
            }
        }
    } catch (err) {
        logSystem(`Zigbee Bridge startup reconcile failed: ${err?.message || err}`, 'warn');
    }
    try {
        if (systemSettings.dmxServiceEnabled) {
            const state = await getDmxServiceState();
            if (state.available && !state.running) {
                await runSystemctlAsync(['daemon-reload']);
                await runSystemctlAsync(['enable', DMX_SERVICE_NAME]);
                await runSystemctlAsync(['start', DMX_SERVICE_NAME]);
            }
        }
    } catch (err) {
        logSystem(`DMX Service startup reconcile failed: ${err?.message || err}`, 'warn');
    }
}

async function restartAllManagedServices() {
    if (!isLinuxSystem()) {
        return { success: false, error: 'Service restart is only supported on Linux.' };
    }
    try {
        try {
            await ensureSoundSystemMixerMax();
        } catch (err) {
            // Mixer setup is best-effort; service restart should still proceed.
        }

        const serviceNames = ['mosquitto.service', 'zigbee2mqtt.service', 'olad.service'];
        const results = [];

        for (const serviceName of serviceNames) {
            const loadRes = await querySystemctlAsync(['show', serviceName, '--property=LoadState', '--value']);
            const loadState = String(loadRes.output || '').trim();
            if (loadState === 'not-found' || !loadState) {
                results.push({ service: serviceName, skipped: true, reason: 'not-installed' });
                continue;
            }
            try {
                await runSystemctlAsync(['restart', serviceName]);
                results.push({ service: serviceName, restarted: true });
            } catch (err) {
                results.push({ service: serviceName, restarted: false, error: err?.message || 'restart failed' });
            }
        }

        const failed = results.filter((entry) => entry.restarted === false);
        if (failed.length) {
            const details = failed.map((entry) => `${entry.service}: ${entry.error}`).join('; ');
            logSystem(`Restart all services failed before hub restart: ${details}`, 'error');
            return { success: false, error: `One or more services could not be restarted: ${details}`, results };
        }

        const restartHubCommand = (typeof process.getuid === 'function' && process.getuid() !== 0)
            ? 'sudo -n systemctl restart md2-hub.service'
            : 'systemctl restart md2-hub.service';
        const script = `sleep 1; ${restartHubCommand}`;
        const child = spawn('sh', ['-c', script], {
            detached: true,
            stdio: 'ignore'
        });
        child.unref();
        logSystem('Restart all services requested. Hub restart scheduled.', 'warn');
        return {
            success: true,
            scheduled: true,
            results,
            services: [...serviceNames, 'md2-hub.service']
        };
    } catch (err) {
        const message = err?.message || 'Could not schedule service restart.';
        logSystem(`Restart all services failed: ${message}`, 'error');
        return { success: false, error: message };
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
        queueStates[queueNodeId] = { entries: [], activeEntries: [], cooldownUntil: null };
    }
    if (!Array.isArray(queueStates[queueNodeId].activeEntries)) {
        queueStates[queueNodeId].activeEntries = [];
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
    const flowData = buildBranchFlowData();
    const branch = (flowData.branches || []).find(b => b.id === branchId);
    if (branch && isBranchSolved(branch)) {
        branchSolvedState[branchId] = true;
    }
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
    logSystem(`Hint triggered: ${entry.puzzleName} (#${entry.index + 1}): ${entry.text}`, "info", {
        puzzleId,
        puzzleName: entry.puzzleName,
        hintIndex: entry.index,
        auto: !!entry.auto,
        custom: false
    });
    emitUpdate('hints', { puzzleId });
    runPuzzleScriptingEvent(node, 'on_hint', { customValue: nextText });
    runRoomScriptingEvent('hint_triggered', { puzzleId, customValue: nextText });

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
    logSystem(`Hint triggered: ${entry.puzzleName} (#${entry.index + 1}): ${entry.text}`, "info", {
        puzzleId,
        puzzleName: entry.puzzleName,
        hintIndex: entry.index,
        auto: false,
        custom: true
    });
    emitUpdate('hints', { puzzleId });
    runPuzzleScriptingEvent(node, 'on_hint', { customValue: cleaned });
    runRoomScriptingEvent('hint_triggered', { puzzleId, customValue: cleaned });
    return { success: true, hint: entry, screen: { id: screen.id, name: screen.name, path: screen.path } };
}

function triggerHintByIndexForPuzzle(puzzleId, hintIndex, { showAssignment } = {}) {
    const node = getPuzzleNodeById(puzzleId);
    if (!node) return { success: false, error: "Puzzle not found" };
    const hints = normalizeHints(node);
    const idx = Number(hintIndex);
    if (!Number.isFinite(idx) || idx < 0 || idx >= hints.length) {
        return { success: false, error: "Hint index out of range" };
    }
    const text = String(hints[idx]?.text || "").trim();
    if (!text) return { success: false, error: "Hint text missing" };
    return triggerCustomHint(puzzleId, text, { showAssignment });
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

function getOutputFallbackEntry(node, name) {
    if (!node || !node.properties || !node.properties.outputValues) return null;
    if (!Object.prototype.hasOwnProperty.call(node.properties.outputValues, name)) return null;
    const entry = node.properties.outputValues[name];
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        return {
            value: Object.prototype.hasOwnProperty.call(entry, "value") ? entry.value : undefined,
            type: entry.type,
            sendOnSolved: entry.sendOnSolved !== false,
            sendOnReceive: entry.sendOnReceive === true
        };
    }
    if (entry === undefined || entry === null) return null;
    return {
        value: entry,
        type: null,
        sendOnSolved: true,
        sendOnReceive: false
    };
}

function getOutputFallbackConfig(node, name, mode = 'solved') {
    const entry = getOutputFallbackEntry(node, name);
    if (!entry) return null;
    if (mode === 'receive' && !entry.sendOnReceive) return null;
    if (mode !== 'receive' && !entry.sendOnSolved) return null;
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
    const fallbackConfig = getOutputFallbackConfig(originNode, outName, 'solved');
    if (!fallbackConfig) return null;
    const parsed = parseFallbackValueForType(fallbackConfig.value, fallbackConfig.type || outType);
    if (!parsed.ok) return null;
    return { data: parsed.value, type: normalizeDataType(fallbackConfig.type || outType) };
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

function isBranchPuzzleRequired(branchId, puzzleId) {
    if (!Number.isFinite(branchId) || !Number.isFinite(puzzleId)) return true;
    const branchKey = String(branchId);
    for (const branchChoices of Object.values(queueBranchChoices || {})) {
        if (!branchChoices) continue;
        const choice = branchChoices[branchKey];
        if (!choice) continue;
        const controlled = Array.isArray(choice.controlledPuzzleIds) ? choice.controlledPuzzleIds : [];
        if (!controlled.includes(puzzleId)) continue;
        const required = Array.isArray(choice.requiredPuzzleIds) ? choice.requiredPuzzleIds : [];
        const requireAny = choice.requireAny === true;
        if (requireAny) {
            const solvedMap = queueSolvedState[branchId] || {};
            const anySolved = required.some(id => !!solvedMap[id]);
            if (anySolved) return false;
        }
        return required.includes(puzzleId);
    }
    return true;
}

function isBranchSolved(branch) {
    if (!branch || !Array.isArray(branch.puzzles) || !branch.puzzles.length) return false;
    const queueSolved = queueSolvedState[branch.id] || {};
    return branch.puzzles.every(p => {
        const pid = p.id;
        if (!isBranchPuzzleRequired(branch.id, pid)) return true;
        if (queueSolved[pid]) return true;
        // Queue targets are branch-instance specific. Do not inherit global solved
        // from a different branch instance.
        if (isQueueTargetPuzzleId(pid)) return false;
        return puzzleStateDetails[pid]?.state === 'solved';
    });
}

function scheduleBranchAutoRestart(branch) {
    if (!autoRestartConfig.enabled || !branch) return;
    if (autoRestartTimers.has(branch.id)) return;
    if (!isBranchSolved(branch)) return;
    const delayMs = Math.max(0, (autoRestartConfig.delaySec || 0) * 1000);
    logSystem(`Auto-restart scheduled for branch ${branch.id} in ${autoRestartConfig.delaySec}s.`, "info");
    const timerId = setTimeout(() => {
        autoRestartTimers.delete(branch.id);
        const flowData = buildBranchFlowData();
        const branchCount = Array.isArray(flowData?.branches) ? flowData.branches.length : 0;
        if (branchCount <= 1) {
            // Single-branch rooms should behave like a full room restart.
            beginRoomRestart({ emitRoomStarted: true });
            return;
        }
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
    const branches = flowData.branches || [];
    const validBranchIds = new Set(branches.map(b => b.id));

    // Clear timers for removed branches.
    autoRestartTimers.forEach((timerId, branchId) => {
        if (validBranchIds.has(branchId)) return;
        clearTimeout(timerId);
        autoRestartTimers.delete(branchId);
    });

    branches.forEach(branch => {
        if (isBranchSolved(branch)) {
            scheduleBranchAutoRestart(branch);
            return;
        }
        // Branch no longer solved: cancel pending timer.
        if (autoRestartTimers.has(branch.id)) {
            clearTimeout(autoRestartTimers.get(branch.id));
            autoRestartTimers.delete(branch.id);
        }
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
    const now = Date.now();
    const sinceRestartRequest = restartRequestedAt[puzzleId];
    const rawState = (incomingState || "").toString().toLowerCase();
    if (rawState === 'restarting' || rawState === 'ready') return false;
    const state = normalizePuzzleState(incomingState);
    if (sinceRestartRequest) {
        const restartAge = now - sinceRestartRequest;
        const freshSeen = !!restartFreshStateSeen[puzzleId];
        // After restart, ignore incoming "solved" until we have seen a fresh non-solved
        // status (or until timeout).
        if (state === 'solved' && !freshSeen && restartAge < RESTART_IGNORE_SOLVED_UNTIL_FRESH_MS) {
            return false;
        }
        if (state !== 'solved') {
            restartFreshStateSeen[puzzleId] = true;
        }
    }
    const current = puzzleStateDetails[puzzleId]?.state || 'locked';
    if (current === 'locked' && state !== 'locked') {
        // After we sent a restart command, allow the first fresh runtime state
        // from device (starting/running/...) to move out of locked.
        if (!sinceRestartRequest) return false;
    }
    if (current === 'solved' && state !== 'solved') {
        if (sinceRestartRequest && (now - sinceRestartRequest) < RESTART_ALLOW_UNSOLVE_MS) {
            // Recovery path: allow a fresh post-restart running state to replace
            // an accidentally accepted stale "solved".
            if (state === 'running' || state === 'active' || state === 'starting') {
                return true;
            }
        }
        return false;
    }
    if ((current === 'active' || current === 'starting' || current === 'running') && state === 'locked') return false;
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

function buildOutputTransferKey(originPuzzleId, outName, targetPuzzleId, inputName) {
    const originId = Number(originPuzzleId);
    const targetId = Number(targetPuzzleId);
    return [
        Number.isFinite(originId) ? originId : 0,
        String(outName || '').trim(),
        Number.isFinite(targetId) ? targetId : 0,
        String(inputName || '').trim()
    ].join('|');
}

function markOutputSentToHub(sourceNode, outName) {
    if (!sourceNode || !sourceNode.outputs) return;
    const links = graph.links || {};
    sourceNode.outputs.forEach((out, idx) => {
        const currentOutName = out?.name || `Output ${idx + 1}`;
        if (currentOutName !== outName) return;
        const linkIds = Array.isArray(out.links) ? out.links : (out?.link !== undefined ? [out.link] : []);
        linkIds.forEach((linkId) => {
            const link = links[linkId];
            if (!link) return;
            const targetNode = getPuzzleNodeById(link.target_id);
            if (!targetNode || targetNode.type !== "escape/Puzzle") return;
            const targetInput = targetNode.inputs && targetNode.inputs[link.target_slot];
            const inputName = targetInput?.name || currentOutName || `Input ${link.target_slot + 1}`;
            const key = buildOutputTransferKey(sourceNode.id, currentOutName, targetNode.id, inputName);
            const existing = outputTransferState[key] || {};
            outputTransferState[key] = { ...existing, hubSentAt: Date.now() };
        });
    });
}

function markOutputForwarded(originPuzzleId, outName, targetPuzzleId, inputName) {
    const key = buildOutputTransferKey(originPuzzleId, outName, targetPuzzleId, inputName);
    const existing = outputTransferState[key] || {};
    outputTransferState[key] = { ...existing, forwardedAt: Date.now() };
}

function getOutputTransferEntry(originPuzzleId, outName, targetPuzzleId, inputName) {
    return outputTransferState[buildOutputTransferKey(originPuzzleId, outName, targetPuzzleId, inputName)] || null;
}

function clearOutputTransferStateForPuzzle(puzzleId) {
    const numericPuzzleId = Number(puzzleId);
    Object.keys(outputTransferState).forEach((key) => {
        const parts = key.split('|');
        const originId = Number(parts[0]);
        const targetId = Number(parts[2]);
        if (originId === numericPuzzleId || targetId === numericPuzzleId) {
            delete outputTransferState[key];
        }
    });
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
        const configuredForward = getOutputFallbackConfig(sourceNode, outName, 'receive');
        let sendData = data;
        let sendType = type || out.type || "string";
        if (configuredForward) {
            const parsed = parseFallbackValueForType(configuredForward.value, configuredForward.type || out.type);
            if (parsed.ok) {
                sendData = parsed.value;
                sendType = configuredForward.type || out.type || sendType;
            }
        } else if (getOutputFallbackEntry(sourceNode, outName)) {
            return;
        }
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
            const targetInput = targetNode.inputs && targetNode.inputs[link.target_slot];
            const targetKey = targetInput?.name || key || outName || `Input ${link.target_slot + 1}`;
            publishCommand(targetDevId, { action: "sendParam", key: targetKey, type: sendType, data: sendData });
            logSystem(
                `Data sent to "${getPuzzleName(targetNode, targetNode.id)}" (${targetKey}): ${JSON.stringify(sendData)}`,
                "system"
            );
            markOutputForwarded(sourceNode.id, outName, targetNode.id, targetKey);
            clearInputFallbackUsage(targetNode.id, targetKey);
            clearPendingMediaFallback(targetNode.id, targetKey);
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
                  const targetKey = input.name || outName;
                  publishCommand(targetDevId, {
                      action: "sendParam",
                      key: targetKey,
                      type: stored.type || normalizeDataType(out.type),
                      data: stored.data
                  });
                  logSystem(
                      `Data sent to "${getPuzzleName(targetNode, targetNode.id)}" (${targetKey}): ${JSON.stringify(stored.data)}`,
                      "system"
                  );
                  markOutputForwarded(originNode.id, outName, targetNode.id, targetKey);
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
            const outFallbackConfig = getOutputFallbackConfig(originNode, outName, 'solved');
            if (!outFallbackConfig) continue;
            const parsed = parseFallbackValueForType(outFallbackConfig.value, outFallbackConfig.type || out.type);
            if (!parsed.ok) continue;
            const outType = normalizeDataType(out.type);
            if (outType === "media") {
                if (!isUpstreamSolvedForInput(targetNode, outName)) continue;
                scheduleMediaInputFallback(targetNode, outName, outFallbackConfig.type || out.type, parsed.value);
                sentValue = true;
                break;
            }
            publishCommand(targetDevId, {
                action: "sendParam",
                key: input.name || outName,
                type: normalizeDataType(outFallbackConfig.type || out.type),
                data: parsed.value,
                fallback: true
            });
            logSystem(
                `Data sent to "${getPuzzleName(targetNode, targetNode.id)}" (${input.name || outName}): ${JSON.stringify(parsed.value)}`,
                "system"
            );
            markOutputForwarded(originNode.id, outName, targetNode.id, input.name || outName);
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
function enqueueQueueEntry(queueNode, originNode, branchIdOverride = null) {
    if (!queueNode || !originNode) return;
    const branch = getBranchForPuzzle(originNode.id);
    const branchId = Number.isFinite(branchIdOverride) ? branchIdOverride : branch?.id;
    if (!Number.isFinite(branchId)) return;
    const state = getQueueState(queueNode.id);
    const exists = state.entries.some(e => e.puzzleId === originNode.id && e.branchId === branchId);
    if (exists) return;
    const payload = buildQueuePayload(queueNode, originNode);
    state.entries.push({ puzzleId: originNode.id, branchId, payload });
}
function isPuzzleFreeForQueue(puzzleId, branchId) {
    const current = puzzleStateDetails[puzzleId]?.state;
    // "solved" counts as free for queue handover; only active/busy/error states block.
    if (['running', 'starting', 'active', 'uploading', 'downloading', 'error'].includes(current)) return false;
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
    const activationRequirements = new Map();
    const flowRequirements = new Map();
    const freeTargets = targetPuzzleIds.filter(targetId => {
        const downstream = collectDownstreamPuzzleIds(targetId);
        const flowList = downstream.length ? downstream : [targetId];
        const activationList = [targetId];
        flowRequirements.set(targetId, flowList);
        activationRequirements.set(targetId, activationList);
        return activationList.every(reqId => isPuzzleFreeForQueue(reqId, entry.branchId));
    });
    if (!freeTargets.length) return;
    const activateAllFree = queueNode.properties?.queueActivateAllFree === true;
    if (activateAllFree && freeTargets.length !== targetPuzzleIds.length) return;
    const activateIds = activateAllFree
        ? freeTargets
        : [freeTargets[Math.floor(Math.random() * freeTargets.length)]];
    const activationRequiredSet = new Set();
    const flowRequiredSet = new Set();
    activateIds.forEach(targetId => {
        const activationReq = activationRequirements.get(targetId) || [targetId];
        activationReq.forEach(id => activationRequiredSet.add(id));
        const flowReq = flowRequirements.get(targetId) || [targetId];
        flowReq.forEach(id => flowRequiredSet.add(id));
    });
    state.entries.shift();
    const activeEntry = {
        puzzleId: entry.puzzleId,
        branchId: entry.branchId,
        puzzleIds: activateIds.slice(),
        requiredPuzzleIds: Array.from(flowRequiredSet),
        lockPuzzleIds: Array.from(flowRequiredSet),
        requireAny: activateAllFree === true
    };
    state.activeEntries.push(activeEntry);
    if (!queueBranchChoices[queueNode.id]) queueBranchChoices[queueNode.id] = {};
    queueBranchChoices[queueNode.id][entry.branchId] = {
        requiredPuzzleIds: Array.from(flowRequiredSet),
        controlledPuzzleIds: getQueueControlledPuzzleIds(queueNode),
        requireAny: activateAllFree === true
    };
    if (queueBranchChoices[queueNode.id] && !Object.keys(queueBranchChoices[queueNode.id]).length) {
        delete queueBranchChoices[queueNode.id];
    }
    if (!queueSolvedState[entry.branchId]) queueSolvedState[entry.branchId] = {};
    const activateSet = new Set(activateIds.map(id => parseInt(id, 10)).filter(id => Number.isFinite(id)));
    // Reset stale states from previous branch runs on the same arm.
    // Only direct queue targets are activated immediately; downstream stays flow-driven.
    Array.from(flowRequiredSet).forEach(pid => {
        const targetId = parseInt(pid, 10);
        if (!Number.isFinite(targetId)) return;
        if (activateSet.has(targetId)) return;
        if (puzzleStateDetails[targetId]?.state !== 'locked') {
            applyPuzzleState(targetId, 'locked');
        }
    });
    Array.from(flowRequiredSet).forEach(targetPuzzleId => {
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
        state.activeEntries = (state.activeEntries || []).filter(entry => entry.branchId !== branchId);
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
        const fallbackConfig = getOutputFallbackConfig(origin, outName, 'solved');
        if (!fallbackConfig) continue;
        const parsed = parseFallbackValueForType(fallbackConfig.value, fallbackConfig.type || out.type);
        if (!parsed.ok) continue;
        return { value: parsed.value, type: normalizeDataType(fallbackConfig.type || out.type), source: "output-fallback" };
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
    const topic = `puzzle/${deviceId}/command`;
    try {
        mqttClient.publish(topic, JSON.stringify(payload));
        logSystem(`MQTT command to ${deviceId}`, "mqtt", { topic, payload, direction: "outbound" });
    } catch (e) {
        console.error("MQTT publish failed:", e.message);
        logSystem(`MQTT command failed to ${deviceId}: ${e.message || e}`, "warn", { topic, payload, direction: "outbound" });
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
    const groupSyncActive = options?.__groupSyncing === true;
    const syncOnly = options?.__syncOnly === true;
    if (!groupSyncActive && ['locked', 'active', 'starting', 'running', 'solved'].includes(desired)) {
        const groupMemberIds = getPuzzleGroupMemberIds(puzzleId).filter(id => id !== puzzleId);
        groupMemberIds.forEach(memberId => {
            applyPuzzleState(memberId, desiredState, note, {
                ...options,
                __groupSyncing: true,
                __syncOnly: true
            });
        });
    }
    const now = Date.now();
    const prevState = puzzleStateDetails[puzzleId]?.state || 'locked';
    const node = getPuzzleNodeById(puzzleId);
    const externalWasActive = node ? isExternalCheckActive(node, prevState) : false;
    const deviceId = node ? getDeviceIdForPuzzle(node) : null;
    const isAnalog = !!node?.properties?.isAnalog;
    const normalizedDesired = (isAnalog && desired === 'active') ? 'running' : desired;
    const canRestartDevice = node
        && options.outbound
        && ['active', 'running'].includes(normalizedDesired)
        && !['active', 'starting', 'running'].includes(prevState)
        && !isAnalog
        && canSendToDevice(node, deviceId);
    const waitingForRestartHeartbeat = !isAnalog
        && !!restartRequestedAt[puzzleId]
        && !restartFreshStateSeen[puzzleId];
    // Digital puzzles that are (re)started by command should show "starting"
    // until a fresh device heartbeat reports the next runtime state.
    const state = canRestartDevice
        ? 'starting'
        : (waitingForRestartHeartbeat && prevState === 'starting' && ['active', 'running'].includes(normalizedDesired)
            ? 'starting'
            : normalizedDesired);

    puzzleStateDetails[puzzleId] = {
        state,
        note: note || null,
        updatedAt: now
    };
    emitUpdate('puzzle-state', { puzzleId, state });
    const becameActive = ['active', 'starting', 'running'].includes(state) && !['active', 'starting', 'running'].includes(prevState);
    const becameSolved = state === 'solved' && prevState !== 'solved';
    const becameLocked = state === 'locked' && prevState !== 'locked';
    const externalNowActive = node ? isExternalCheckActive(node, state) : false;
    const externalActivated = !!node && !externalWasActive && externalNowActive;
    if (node && becameActive) {
        runPuzzleScriptingEvent(node, 'on_running');
    }
    if (externalActivated) {
        Promise.resolve(resolveExternalCheckValue(node))
            .then(({ value }) => {
                runPuzzleScriptingEvent(node, 'on_external_input_activated', { expectedValue: value });
            })
            .catch(() => {
                runPuzzleScriptingEvent(node, 'on_external_input_activated', { expectedValue: null });
            });
    }
    if (node && becameSolved) {
        runPuzzleScriptingEvent(node, 'on_solved');
    }
    if (node && becameLocked) {
        runPuzzleScriptingEvent(node, 'on_reset');
    }
    if (prevState !== state) {
        runRoomScriptingEvent('any_puzzle_state', { puzzleId, state });
    }

    if (state === 'solved') {
        const shouldActivateDownstreamNow = prevState !== 'solved';
        const solvedBranchId = Number.isFinite(options?.branchId) ? options.branchId : null;
        const queueLock = puzzleQueueLocks[puzzleId] || null;
        if (!queueLock) {
            puzzleSolvedState[puzzleId] = true;
        } else {
            delete puzzleSolvedState[puzzleId];
            if (!queueSolvedState[queueLock.branchId]) queueSolvedState[queueLock.branchId] = {};
            queueSolvedState[queueLock.branchId][puzzleId] = true;
        }
        delete puzzleActivationState[puzzleId];
        // Important: activate downstream flow while this solved state is still "current".
        // Otherwise queue handover may immediately switch the same puzzle back to active,
        // causing intermittent missed activation of the next layer.
        if (shouldActivateDownstreamNow && !syncOnly) {
            activateReadyPuzzles();
        }
        if (node && !syncOnly) {
            const queueNodes = getLinkedQueueNodesForPuzzle(node);
            queueNodes.forEach(q => {
                enqueueQueueEntry(q, node, Number.isFinite(solvedBranchId) ? solvedBranchId : queueLock?.branchId);
                processQueueNode(q);
            });
            if (queueLock) {
                const queueState = getQueueState(queueLock.queueNodeId);
                let shouldMarkBranchSolved = false;
                let shouldSchedule = true;
                const activeEntries = Array.isArray(queueState?.activeEntries) ? queueState.activeEntries : [];
                const activeEntry = activeEntries.find(entry => entry && entry.branchId === queueLock.branchId
                    && Array.isArray(entry.lockPuzzleIds) && entry.lockPuzzleIds.includes(puzzleId));
                if (activeEntry) {
                    const completionIds = Array.isArray(activeEntry.requiredPuzzleIds)
                        ? activeEntry.requiredPuzzleIds
                        : [puzzleId];
                    const lockIds = Array.isArray(activeEntry.lockPuzzleIds)
                        ? activeEntry.lockPuzzleIds
                        : completionIds;
                    const requireAny = activeEntry.requireAny === true;
                    const solvedMap = queueSolvedState[queueLock.branchId] || {};
                    const resolved = requireAny
                        ? completionIds.some(id => !!solvedMap[id])
                        : completionIds.every(id => !!solvedMap[id]);
                    shouldMarkBranchSolved = resolved;
                    const armFree = lockIds.every(id => isPuzzleFreeForQueue(id, queueLock.branchId));
                    if (armFree) {
                        lockIds.forEach(id => {
                            const lock = puzzleQueueLocks[id];
                            if (lock && lock.queueNodeId === queueLock.queueNodeId && lock.branchId === queueLock.branchId) {
                                delete puzzleQueueLocks[id];
                            }
                        });
                        queueState.activeEntries = activeEntries.filter(entry => entry !== activeEntry);
                    }
                }
                if (shouldMarkBranchSolved) {
                    markBranchSolved(queueLock.branchId);
                }
                const queueNode = graph.getNodeById ? graph.getNodeById(queueLock.queueNodeId) : null;
                if (queueNode && shouldSchedule) scheduleQueueProcessing(queueNode);
            } else {
                if (Number.isFinite(solvedBranchId)) {
                    markBranchSolved(solvedBranchId);
                } else {
                    const endBranchIds = getLinkedEndBranchIdsForPuzzle(node);
                    endBranchIds.forEach(markBranchSolved);
                }
            }
        }
        if (!syncOnly) {
            checkAutoRestartCondition();
        }
    } else {
        delete puzzleSolvedState[puzzleId];
        if (state === 'active' || state === 'starting' || state === 'running') {
            puzzleActivationState[puzzleId] = true;
        } else {
            delete puzzleActivationState[puzzleId];
        }
        if (state === 'locked') {
            // If a queue-controlled puzzle is force-locked/reset, release current queue lock
            // so the next waiting branch instance can be activated.
            const queueLock = puzzleQueueLocks[puzzleId];
            if (queueLock) {
                const queueState = getQueueState(queueLock.queueNodeId);
                const activeEntries = Array.isArray(queueState?.activeEntries) ? queueState.activeEntries : [];
                const activeEntry = activeEntries.find(entry => entry && entry.branchId === queueLock.branchId
                    && Array.isArray(entry.lockPuzzleIds) && entry.lockPuzzleIds.includes(puzzleId));
                if (activeEntry) {
                    const lockIds = Array.isArray(activeEntry.lockPuzzleIds)
                        ? activeEntry.lockPuzzleIds
                        : (Array.isArray(activeEntry.requiredPuzzleIds)
                        ? activeEntry.requiredPuzzleIds
                        : [puzzleId]);
                    const armFree = lockIds.every(id => isPuzzleFreeForQueue(id, queueLock.branchId));
                    if (armFree) {
                        lockIds.forEach(id => {
                            const lock = puzzleQueueLocks[id];
                            if (lock && lock.queueNodeId === queueLock.queueNodeId && lock.branchId === queueLock.branchId) {
                                delete puzzleQueueLocks[id];
                            }
                        });
                        queueState.activeEntries = activeEntries.filter(entry => entry !== activeEntry);
                    }
                } else {
                    delete puzzleQueueLocks[puzzleId];
                }
                const queueNode = graph.getNodeById ? graph.getNodeById(queueLock.queueNodeId) : null;
                if (queueNode && !syncOnly) scheduleQueueProcessing(queueNode);
            }
        }
        if (state !== 'starting' && state !== 'solved') {
            // Keep restart tracking alive when activation just issued a restart
            // and we intentionally keep local state locked until fresh device state arrives.
            const keepRestartTracking = canRestartDevice || (!!restartRequestedAt[puzzleId] && state === 'locked');
            if (!keepRestartTracking) {
                delete restartRequestedAt[puzzleId];
                delete restartFreshStateSeen[puzzleId];
            }
        }
    }

    if (node && ['active', 'running'].includes(desired) && !['active', 'starting', 'running'].includes(prevState)) {
        seedInputsForPuzzle(node);
    }

    if (options.outbound && node) {
        if (canSendToDevice(node, deviceId)) {
            if (canRestartDevice) {
                restartRequestedAt[puzzleId] = Date.now();
                restartFreshStateSeen[puzzleId] = false;
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

    // Always re-check all queues when a puzzle becomes free.
    if ((state === 'solved' || state === 'locked') && prevState !== state) {
        if (!syncOnly) {
            processAllQueues();
        }
    }
    emitRoomAndBranchStateScriptingTransitions();
}

function resetAllPuzzleStates(defaultState = 'locked', options = {}) {
    const { outbound = true, resetDevices = true } = options;
    clearScriptingForeverTimers();
    puzzleSolvedState = {};
    puzzleActivationState = {};
    puzzleScriptingActiveUntil = {};
    puzzleScriptingSeq = {};
    roomScriptingActiveUntil = 0;
    roomScriptingSeq = 0;
    roomScriptingSensorInstances = {};
    roomScriptingLastRoomState = null;
    roomScriptingLastBranchStates = {};
    puzzleStateDetails = {};
    puzzleDataStore = {};
    puzzleInputFallbackStore = {};
    outputTransferState = {};
    queueStates = {};
    queueSolvedState = {};
    queueBranchChoices = {};
    Object.keys(queueTimers).forEach(queueId => clearQueueTimer(queueId));
    queueTimers = {};
    puzzleQueueLocks = {};
    branchSolvedState = {};
    Object.keys(restartRequestedAt).forEach(key => { delete restartRequestedAt[key]; });
    Object.keys(restartFreshStateSeen).forEach(key => { delete restartFreshStateSeen[key]; });
    resetDmxUniverseBuffer({ send: true });
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
        resetPuzzleScriptSensorInstanceByPolicy(node.id);
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
    delete puzzleScriptingActiveUntil[puzzleId];
    delete puzzleScriptingSeq[puzzleId];
    delete puzzleStateDetails[puzzleId];
    delete puzzleDataStore[puzzleId];
    delete puzzleInputFallbackStore[puzzleId];
    clearOutputTransferStateForPuzzle(puzzleId);
    delete puzzleQueueLocks[puzzleId];
    delete restartRequestedAt[puzzleId];
    delete restartFreshStateSeen[puzzleId];
    if (pendingMediaFallbackTimers[puzzleId]) {
        Object.values(pendingMediaFallbackTimers[puzzleId] || {}).forEach(timerId => clearTimeout(timerId));
        delete pendingMediaFallbackTimers[puzzleId];
    }
    delete externalCheckRuntime[puzzleId];
    delete pendingOutputErrors[puzzleId];
    delete offlineErrorState[puzzleId];
    delete puzzleTelemetry[puzzleId];
    resetPuzzleScriptSensorInstanceByPolicy(puzzleId);
    clearHintTimers(puzzleId);
    removeHintsForPuzzle(puzzleId);
}

function getRoomStatusLabel() {
    if (!isRunning) return "Stopped";
    if (allPuzzlesSolved()) return "Solved";
    return "Running";
}

function getRoomStateKey() {
    return allPuzzlesSolved() ? 'solved' : 'running';
}

function getBranchStateKey(branchId) {
    const numericBranchId = parseInt(branchId, 10);
    if (!Number.isFinite(numericBranchId)) return 'running';
    const flowData = buildBranchFlowData();
    const branch = (flowData.branches || []).find((entry) => entry.id === numericBranchId);
    if (!branch) return 'running';
    return isBranchSolved(branch) ? 'solved' : 'running';
}

function emitRoomAndBranchStateScriptingTransitions() {
    if (!isRunning) return;
    const nextRoomState = getRoomStateKey();
    if (roomScriptingLastRoomState !== nextRoomState) {
        roomScriptingLastRoomState = nextRoomState;
        runRoomScriptingEvent('room_state_change', { state: nextRoomState });
    }

    const flowData = buildBranchFlowData();
    const nextBranchStates = {};
    (flowData.branches || []).forEach((branch) => {
        const branchId = parseInt(branch?.id, 10);
        if (!Number.isFinite(branchId)) return;
        const state = isBranchSolved(branch) ? 'solved' : 'running';
        nextBranchStates[branchId] = state;
        if (roomScriptingLastBranchStates[branchId] !== state) {
            runRoomScriptingEvent('branch_state_change', { branchId, state });
        }
    });
    roomScriptingLastBranchStates = nextBranchStates;
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

function collectDmxAdapterWarnings() {
    const warnings = [];
    const puzzles = getAllPuzzleNodes();
    const requiresDmx = puzzles.some(node => {
        if (!node) return false;
        const rules = Array.isArray(node.properties?.scriptingRules)
            ? node.properties.scriptingRules
            : (Array.isArray(node.properties?.automationRules) ? node.properties.automationRules : []);
        return rules.some(rule => {
            const actionType = String(rule?.actionType || '').trim().toLowerCase();
            const actionValue = String(rule?.actionValue || '').trim();
            return actionType === 'play_cue' && actionValue.length > 0;
        });
    });
    if (!requiresDmx) return warnings;
    const adapter = getDmxAdapterInfo();
    if (!adapter?.connected) {
        warnings.push('no DMX adapter connected');
    }
    return warnings;
}

function buildReadinessWarnings() {
    return [
        ...collectDeviceWarnings(),
        ...collectDuplicateDeviceWarnings(),
        ...collectConnectionWarnings(),
        ...collectExternalCheckWarnings(),
        ...collectMediaServerWarnings(),
        ...collectDmxAdapterWarnings()
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

function normalizePuzzleGroupId(value) {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getPuzzleGroupIdForNode(node) {
    return normalizePuzzleGroupId(node?.properties?.groupId);
}

function getPuzzleGroupNameForNode(node) {
    const groupId = getPuzzleGroupIdForNode(node);
    if (!groupId) return null;
    const trimmed = String(node?.properties?.groupName || '').trim();
    return trimmed || `Group ${groupId}`;
}

function getPuzzleGroupMembers(groupId) {
    const normalized = normalizePuzzleGroupId(groupId);
    if (!normalized) return [];
    return getAllPuzzleNodes().filter(node => getPuzzleGroupIdForNode(node) === normalized);
}

function getPuzzleGroupMemberIds(puzzleId) {
    const node = getPuzzleNodeById(puzzleId);
    if (!node) return [];
    const groupId = getPuzzleGroupIdForNode(node);
    if (!groupId) return [puzzleId];
    const members = getPuzzleGroupMembers(groupId)
        .map(member => member?.id)
        .filter(id => Number.isFinite(id));
    return members.length ? members : [puzzleId];
}

function aggregatePuzzleFlowEntries(entries) {
    const grouped = new Map();
    (entries || []).forEach(entry => {
        if (!entry) return;
        const key = entry.groupId ? `group:${entry.groupId}` : `puzzle:${entry.id}`;
        if (!grouped.has(key)) {
            grouped.set(key, {
                ...entry,
                id: entry.id,
                isGroup: !!entry.groupId,
                groupName: entry.groupName || null,
                name: entry.groupId ? (entry.groupName || entry.name || `Group ${entry.groupId}`) : entry.name,
                memberIds: [entry.id],
                groupSize: 1
            });
            return;
        }
        const current = grouped.get(key);
        current.memberIds.push(entry.id);
        current.groupSize = current.memberIds.length;
        current.depth = Math.min(Number(current.depth) || 0, Number(entry.depth) || 0);
        current.hasScripting = !!current.hasScripting || !!entry.hasScripting;
        current.isAnalog = !!current.isAnalog && !!entry.isAnalog;
        current.hintAvailable = !!current.hintAvailable || !!entry.hintAvailable;
        current.externalInputConfigured = !!current.externalInputConfigured || !!entry.externalInputConfigured;
        current.automaticHintTrigger = !!current.automaticHintTrigger || !!entry.automaticHintTrigger;
        current.showHintAssignment = !!current.showHintAssignment || !!entry.showHintAssignment;
        if (!current.hintScreenPath && entry.hintScreenPath) current.hintScreenPath = entry.hintScreenPath;
        if (!current.externalScreenName && entry.externalScreenName) current.externalScreenName = entry.externalScreenName;
        if (Array.isArray(entry.hintRemaining) && entry.hintRemaining.length) {
            const existing = Array.isArray(current.hintRemaining) ? current.hintRemaining : [];
            current.hintRemaining = existing.concat(entry.hintRemaining);
        }
        if (current.device !== entry.device) {
            current.device = null;
            current.deviceName = "Multiple devices";
        } else if (!current.deviceName && entry.deviceName) {
            current.deviceName = entry.deviceName;
        }
    });
    return Array.from(grouped.values())
        .map(entry => ({
            ...entry,
            memberIds: Array.from(new Set((entry.memberIds || []).filter(id => Number.isFinite(id))))
        }))
        .sort((a, b) => {
            if ((a.depth || 0) !== (b.depth || 0)) return (a.depth || 0) - (b.depth || 0);
            return (a.id || 0) - (b.id || 0);
        });
}

function computeGroupStatusForNodes(nodes) {
    const members = (nodes || []).filter(Boolean);
    if (!members.length) return null;
    const digitalMembers = members.filter(node => !node?.properties?.isAnalog);
    const online = digitalMembers.length
        ? digitalMembers.every(node => isDeviceOnline(getDeviceIdForPuzzle(node)))
        : true;
    const records = members.map(node => ({
        node,
        stateRecord: getPuzzleStateRecord(node.id),
        stateKey: getPuzzleStateKey(node.id),
        checking: isExternalCheckActive(node, getPuzzleStateKey(node.id)),
        restartAt: Number(restartRequestedAt[node.id] || 0),
        restartPending: !!restartRequestedAt[node.id] && !restartFreshStateSeen[node.id],
        scriptingActiveUntil: Number(puzzleScriptingActiveUntil[node.id] || 0),
        scriptingSeq: Number(puzzleScriptingSeq[node.id] || 0),
        solved: getPuzzleStateRecord(node.id).state === 'solved' || !!puzzleSolvedState[node.id],
        active: ['active', 'starting', 'running', 'uploading', 'downloading'].includes(getPuzzleStateKey(node.id)) || !!puzzleActivationState[node.id]
    }));
    const solved = records.some(entry => entry.solved);
    const active = records.some(entry => entry.active);
    const checking = records.some(entry => entry.checking);
    const restartPending = records.some(entry => entry.restartPending);
    const updatedAt = Math.max(...records.map(entry => Number(entry.stateRecord?.updatedAt) || 0), 0);
    const restartAgeMs = (() => {
        const restartTimes = records.map(entry => entry.restartAt).filter(value => value > 0);
        if (!restartTimes.length) return null;
        return Math.max(0, Date.now() - Math.max(...restartTimes));
    })();
    const state = solved
        ? 'solved'
        : records.some(entry => entry.stateKey === 'starting')
            ? 'starting'
            : records.some(entry => ['uploading', 'downloading'].includes(entry.stateKey))
                ? records.find(entry => ['uploading', 'downloading'].includes(entry.stateKey))?.stateKey || 'locked'
                : records.some(entry => ['active', 'running'].includes(entry.stateKey) || entry.active)
                    ? 'active'
                    : 'locked';
    return {
        online,
        solved,
        active,
        state,
        note: records.map(entry => entry.stateRecord?.note).find(note => note) || null,
        updatedAt,
        restartPending,
        restartAgeMs,
        scriptingActiveUntil: Math.max(...records.map(entry => entry.scriptingActiveUntil), 0),
        scriptingSeq: Math.max(...records.map(entry => entry.scriptingSeq), 0),
        checking,
        externalInputActive: checking
    };
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
    const groupId = getPuzzleGroupIdForNode(node);
    const groupName = getPuzzleGroupNameForNode(node);
    return {
        id: node.id,
        name: node.properties.Name || node.title || "Unnamed Puzzle",
        isGroup: !!groupId,
        groupId,
        groupName,
        memberIds: [node.id],
        groupSize: 1,
        description: "",
        depth: depth,
        hasScripting: hasScriptingBlocks(node),
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
    const usedBranchIds = new Set();

    const sortedStarts = [...startNodes].sort((a, b) => {
        const aId = isValidBranchId(a?.properties?.pairId) ? a.properties.pairId : a.id;
        const bId = isValidBranchId(b?.properties?.pairId) ? b.properties.pairId : b.id;
        return aId - bId;
    });

    sortedStarts.forEach((startNode, idx) => {
        const rawBranchId = isValidBranchId(startNode?.properties?.pairId) ? startNode.properties.pairId : (startNode.id || (idx + 1));
        let branchId = rawBranchId;
        if (!Number.isFinite(branchId) || usedBranchIds.has(branchId)) {
            branchId = Number.isFinite(startNode?.id) ? startNode.id : (idx + 1);
        }
        while (usedBranchIds.has(branchId)) {
            branchId += 1;
        }
        usedBranchIds.add(branchId);
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

        const puzzleOrder = aggregatePuzzleFlowEntries(Array.from(puzzleMap.values()));

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
            targetPuzzleIds.forEach(pid => {
                const lock = puzzleQueueLocks[pid];
                // Already active/unlocked for this branch: do not render as queueing.
                if (lock && Number.isFinite(lock.branchId) && lock.branchId === entry.branchId) return;
                result[entry.branchId][pid] = true;
            });
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
    Object.keys(queueStates || {}).forEach(queueId => {
        const state = queueStates[queueId];
        if (!state) return;
        const activeEntries = Array.isArray(state.activeEntries) ? state.activeEntries : [];
        activeEntries.forEach(active => {
            if (!active || !Number.isFinite(active.branchId)) return;
            const branchId = active.branchId;
            const activePuzzleIds = Array.isArray(active.puzzleIds) ? active.puzzleIds : [];
            activePuzzleIds.forEach(pidRaw => {
                const pid = parseInt(pidRaw, 10);
                if (!Number.isFinite(pid)) return;
                map[pid] = branchId;
            });
        });
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
function buildQueueContextMap() {
    const map = {};
    const mark = (puzzleId) => {
        const id = parseInt(puzzleId, 10);
        if (!Number.isFinite(id)) return;
        map[id] = true;
    };
    getQueueNodes().forEach(queueNode => {
        const controlledIds = getQueueControlledPuzzleIds(queueNode);
        controlledIds.forEach(mark);
    });
    Object.keys(puzzleQueueLocks || {}).forEach(mark);
    Object.keys(queueStates || {}).forEach(queueId => {
        const queueNode = graph.getNodeById ? graph.getNodeById(parseInt(queueId, 10)) : null;
        if (!queueNode) return;
        const controlledIds = getQueueControlledPuzzleIds(queueNode);
        controlledIds.forEach(mark);
    });
    Object.keys(queueSolvedState || {}).forEach(branchId => {
        const solved = queueSolvedState[branchId] || {};
        Object.keys(solved).forEach(pid => {
            if (solved[pid]) mark(pid);
        });
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
    clearScriptingForeverTimers();
    clearAllAutoRestartTimers();
    stopAllSoundCuePlayback();
    stopAllDmxCuePlayback();
    const triggerStartNodes = options.triggerStartNodes !== false;
    const activateFirstDepth = options.activateFirstDepth !== false;
    const emitRoomStarted = options.emitRoomStarted === true;

    suppressDeviceStateUntil = Date.now() + 1500;
    puzzleScriptingVariables = {};
    roomScriptingVariables = {};

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
    runRoomScriptingEvent('room_reset', {});
    (flowData.branches || []).forEach((branch) => {
        const branchId = parseInt(branch?.id, 10);
        if (!Number.isFinite(branchId)) return;
        runRoomScriptingEvent('branch_reset', { branchId });
    });
    if (emitRoomStarted) {
        runRoomScriptingEvent('room_started', {});
        getAllPuzzleNodes().forEach((node) => {
            runPuzzleScriptingEvent(node, 'on_room_started', {});
        });
    }
    emitRoomAndBranchStateScriptingTransitions();
    logSystem("Room restart completed.", "success");
    emitUpdate('room-restart');
    if (emitRoomStarted) {
        emitUpdate('room-started');
    }
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
        scheduleLinuxSerialMetadataRefresh();
        scheduleOlaDmxCommandProbe();
    } catch (err) {}
    try {
        await loadSystemSettings();
    } catch (err) {
        console.error('System settings initialisation failed:', err);
    }
    try {
        await reconcileManagedServiceStateOnStartup();
    } catch (err) {
        console.error('Managed service reconcile failed:', err);
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
                normalizeZigbeeMessageTriggers();
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
    stopAllSoundPlayback: () => stopAllSoundCuePlayback(),
    getZigbeeDevices: () => getZigbeeDevices(),
    refreshZigbeeDevices: () => refreshZigbeeDevices(),
    hideZigbeeDevice: (deviceId) => hideZigbeeDevice(deviceId),
    setZigbeeDeviceResetOnPuzzleReset: (deviceId, enabled) => setZigbeeDeviceResetOnPuzzleReset(deviceId, enabled),
    upsertZigbeeMessageTrigger: (payload) => upsertZigbeeMessageTrigger(payload),
    deleteZigbeeMessageTrigger: (triggerId) => deleteZigbeeMessageTrigger(triggerId),
    startZigbeeDiscovery: (durationSec) => startZigbeeDiscovery(durationSec),
    stopZigbeeDiscovery: () => stopZigbeeDiscovery(),
    renameZigbeeDevice: async (deviceId, newName) => renameZigbeeDevice(deviceId, newName),
    setMqttPort,
    setMediaServerEnabled,
    setAutostartEnabled,
    setZigbeeBridgeEnabled,
    setDmxServiceEnabled,
    restartAllManagedServices,
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
        runPuzzleScriptingEvent(node, correct ? 'on_external_input_right' : 'on_external_input_false', {
            submittedValue: submitted,
            expectedValue: expected
        });

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
    testDmxCue: (fixtureId, cueId) => {
        const numericFixtureId = parseInt(fixtureId, 10);
        const numericCueId = parseInt(cueId, 10);
        if (!Number.isFinite(numericFixtureId) || !Number.isFinite(numericCueId)) {
            return { success: false, error: "fixtureId and cueId required" };
        }
        const cueRef = `${numericFixtureId}:${numericCueId}`;
        const result = runDmxCueAction(cueRef, { triggerType: "manual_test" });
        if (!result.success) return result;
        return {
            success: true,
            fixtureId: numericFixtureId,
            cueId: numericCueId,
            infinite: result.infinite === true,
            durationMs: result.infinite === true ? null : (result.durationMs || 0),
            channelCount: result.channelCount || 0
        };
    },
    stopDmxTestPlayback: () => {
        return stopAllDmxCuePlayback();
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
        const result = beginRoomRestart({ ...options, emitRoomStarted: true });
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
        clearScriptingForeverTimers();

        // Mirror room-restart behavior: briefly ignore inbound device states
        // so stale heartbeats (e.g. old "solved") cannot override fresh reset state.
        suppressDeviceStateUntil = Date.now() + 1500;

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
          resetPuzzleScriptSensorInstanceByPolicy(puzzleId);
          const isQueueTarget = isQueueTargetPuzzleId(puzzleId);
          const queueLock = puzzleQueueLocks[puzzleId];
          const lockedForOtherBranch = isQueueTarget && queueLock && queueLock.branchId !== branchId;
          if (lockedForOtherBranch) {
              return;
          }
          if (isQueueTarget) {
              if (queueLock && queueLock.branchId === branchId) {
                  const queueState = getQueueState(queueLock.queueNodeId);
                  if (queueState && Array.isArray(queueState.activeEntries)) {
                      queueState.activeEntries = queueState.activeEntries.filter(entry => !(entry && entry.branchId === branchId));
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
        runRoomScriptingEvent('branch_reset', { branchId });
        emitRoomAndBranchStateScriptingTransitions();
        logSystem(`Branch ${branchId} restarted.`, "info");
        emitUpdate('branch-restart', { branchId });
        return { success: true };
    },

    getPuzzleStatuses: () => {
        const statusList = {};
        const puzzleNodes = getAllPuzzleNodes();
        const groupedMembers = new Map();
        puzzleNodes.forEach(node => {
            const groupId = getPuzzleGroupIdForNode(node);
            if (groupId) {
                if (!groupedMembers.has(groupId)) groupedMembers.set(groupId, []);
                groupedMembers.get(groupId).push(node);
                return;
            }
            const devId = getDeviceIdForPuzzle(node);
            const stateRecord = getPuzzleStateRecord(node.id);
            const stateKey = getPuzzleStateKey(node.id);
            const checking = isExternalCheckActive(node, stateKey);
            const isActive = ['active', 'starting', 'running', 'uploading', 'downloading'].includes(stateKey);
            const restartAt = Number(restartRequestedAt[node.id] || 0);
            const restartAgeMs = restartAt > 0 ? Math.max(0, Date.now() - restartAt) : null;
            const restartPending = !!restartAt && !restartFreshStateSeen[node.id];
            statusList[node.id] = { 
                online: isDeviceOnline(devId),
                solved: stateRecord.state === 'solved' || !!puzzleSolvedState[node.id],
                active: isActive || !!puzzleActivationState[node.id],
                state: stateRecord.state,
                note: stateRecord.note,
                updatedAt: stateRecord.updatedAt,
                restartPending,
                restartAgeMs,
                scriptingActiveUntil: Number(puzzleScriptingActiveUntil[node.id] || 0),
                scriptingSeq: Number(puzzleScriptingSeq[node.id] || 0),
                checking,
                externalInputActive: checking
            };
        });
        groupedMembers.forEach((members) => {
            const groupStatus = computeGroupStatusForNodes(members);
            if (!groupStatus) return;
            members.forEach(node => {
                const devId = getDeviceIdForPuzzle(node);
                statusList[node.id] = {
                    ...groupStatus,
                    online: node.properties?.isAnalog || isDeviceOnline(devId)
                };
            });
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
            const originBranch = getBranchForPuzzle(origin.id);
            const ownerBranch = getBranchForPuzzle(ownerId);
            const branchId = Number.isFinite(originBranch?.id)
                ? originBranch.id
                : (Number.isFinite(ownerBranch?.id) ? ownerBranch.id : null);
            const originSolved = puzzleStateDetails[origin.id]?.state === 'solved' || !!puzzleSolvedState[origin.id];
            const originState = getPuzzleStateKey(origin.id);
            const stored = puzzleDataStore[origin.id]?.outputs?.[outName];
            const inputFallback = puzzleInputFallbackStore[targetNode.id]?.inputs?.[inputName];
            const hasStored = !!(stored && Object.prototype.hasOwnProperty.call(stored, "data") && stored.data !== null && stored.data !== undefined);
            const outputFallbackConfig = hasStored ? null : getOutputFallbackConfig(origin, outName, 'solved');
            const outputFallbackParsed = hasStored || !outputFallbackConfig ? null : parseFallbackValueForType(outputFallbackConfig.value, outputFallbackConfig.type || out.type);
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
            const transferEntry = getOutputTransferEntry(origin.id, outName, ownerId, inputName || outName);
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
                branchId,
                sourceKey: outName,
                inputKey: inputName,
                type: normalizeDataType(out.type),
                data,
                updatedAt,
                hubSentAt: transferEntry?.hubSentAt || null,
                forwardedAt: transferEntry?.forwardedAt || null,
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
            roomScriptingConfigured: hasRoomScriptingBlocks(),
            roomScriptingActiveUntil: Number(roomScriptingActiveUntil || 0),
            roomScriptingSeq: Number(roomScriptingSeq || 0),
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
        const queueContextMap = buildQueueContextMap();

        const attachRuntimeFlags = (entry, branchId) => {
            const memberIds = Array.isArray(entry?.memberIds) && entry.memberIds.length ? entry.memberIds : [entry.id];
            const any = (fn) => memberIds.some(fn);
            const every = (fn) => memberIds.every(fn);
            return {
                ...entry,
                queueState: any(id => !!queueingMap[branchId]?.[id]) ? "queueing" : null,
                queueTarget: any(id => !!queueTargetMap[id]),
                queueControlled: any(id => !!queueControlledMap[id]),
                queueActive: any(id => queueActiveMap[id] === branchId),
                queueBlocked: every(id => !!queueChoiceMaps.blockedMap?.[branchId]?.[id]),
                queueChosen: any(id => !!queueChoiceMaps.chosenMap?.[branchId]?.[id]),
                queueSolved: any(id => !!queueSolvedMap[branchId]?.[id]),
                queueInstanceState: (() => {
                    if (any(id => !!queueSolvedMap[branchId]?.[id])) return "solved";
                    if (any(id => queueActiveMap[id] === branchId)) return "running";
                    if (any(id => !!queueingMap[branchId]?.[id])) return "queueing";
                    if (any(id => !!queueChoiceMaps.chosenMap?.[branchId]?.[id])) return null;
                    if (every(id => !!queueChoiceMaps.blockedMap?.[branchId]?.[id])) return "locked";
                    const inQueueContext = any(id => !!queueContextMap[id]);
                    if (!inQueueContext) return null;
                    return "locked";
                })()
            };
        };

          return { 
              puzzles: flowData.puzzles,
              branches: (flowData.branches || []).map(branch => ({
                  ...branch,
                  puzzles: aggregatePuzzleFlowEntries((branch.puzzles || []).map(p => attachRuntimeFlags(p, branch.id))),
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
            applyPuzzleState(id, 'solved', null, { outbound: true, branchId: resolvedBranchId });
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
        clearScriptingForeverTimers();
        stopAllSoundCuePlayback();
        stopAllDmxCuePlayback();
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
        emitUpdate('room-reset');
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
        const topicStr = String(topic || "");
        const rawText = message ? message.toString() : "";
        let payload = {};
        try { payload = JSON.parse(rawText); } catch (e) {
            payload = rawText;
        }

        if (topicStr.startsWith(ZIGBEE_TOPIC_PREFIX)) {
            processZigbeeMqttMessage(topicStr, payload, rawText);
            if (!topicStr.startsWith("puzzle/")) return;
        }

        const parts = topicStr.split('/');
        if (parts.length < 3 || parts[0] !== 'puzzle') return;
        
        const deviceId = parts[1];
        const action = parts[2]; 

        if (action !== 'heartbeat') {
            logSystem(`MQTT ${action} from ${deviceId}`, "mqtt", { topic: topicStr, payload, direction: "inbound" });
        }

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
                markOutputSentToHub(targetNode, key);
                puzzleTelemetry[targetNode.id] = { lastData: payload, lastSeen: Date.now() };
                const puzzleName = getPuzzleName(targetNode, targetNode.id);
                logSystem(`Data received from "${puzzleName}" (${key}): ${JSON.stringify(payload.data)}`, "system");
                forwardOutputToTargets(targetNode, key, type, payload.data);
            }
        }

        if (action === 'custom' || action === 'custom-event' || action === 'custom_event') {
            const puzzleNodes = graph.findNodesByType("escape/Puzzle");
            const targetNode = puzzleNodes.find(n => n.properties.selectedDeviceID === deviceId);
            if (targetNode) {
                const customValueRaw = payload?.value ?? payload?.data ?? payload?.text ?? payload?.custom ?? '';
                const customValue = String(customValueRaw ?? '');
                runPuzzleScriptingEvent(targetNode, 'on_custom', { customValue });
                logSystem(`Custom event from "${getPuzzleName(targetNode, targetNode.id)}": ${customValue}`, "system");
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
            runPuzzleScriptingEvent(targetNode, 'on_external_input_activated', { expectedValue: value });
            logSystem(`External check activated for "${getPuzzleName(targetNode, targetNode.id)}"`, "system");
        }
    }
};
