const express = require('express');
const http = require('http');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const Module = require('module');

// Base paths so imports still work after moving this file into /Server
const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const MEDIA_DIR = path.join(ROOT_DIR, 'MediaStorage');
const SOUNDS_DIR = path.join(ROOT_DIR, 'SoundStorage');

// Engine modules live outside /Server but dependencies are installed in /Server/node_modules.
const SERVER_NODE_MODULES = path.join(__dirname, 'node_modules');
process.env.NODE_PATH = [SERVER_NODE_MODULES, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
Module._initPaths();

function ensureMediaStorage() {
    if (!fs.existsSync(MEDIA_DIR)) {
        fs.mkdirSync(MEDIA_DIR, { recursive: true });
    }
}

function ensureSoundsStorage() {
    if (!fs.existsSync(SOUNDS_DIR)) {
        fs.mkdirSync(SOUNDS_DIR, { recursive: true });
    }
}

// Module laden (Pfade angepasst auf src/)
const db = require(path.join(ROOT_DIR, 'src/engine/database'));
const mqttClient = require(path.join(ROOT_DIR, 'src/engine/mqttClient'));
const gameEngine = require(path.join(ROOT_DIR, 'src/engine/gameLoop'));
const apiRoutes = require(path.join(ROOT_DIR, 'src/routes/routes'));

const app = express();
const server = http.createServer(app);

app.set('etag', false);
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }
    next();
});

function sanitizeMediaName(name) {
    const raw = (name || '').toString().trim();
    if (!raw) return null;
    const baseName = path.basename(raw);
    const parsed = path.parse(baseName);
    const safeBase = parsed.name.replace(/[^a-z0-9-_]/gi, '').slice(0, 80);
    const safeExt = parsed.ext.replace(/[^a-z0-9.]/gi, '').slice(0, 12);
    if (!safeBase) return null;
    return `${safeBase}${safeExt}`;
}

function findMediaByBaseName(baseName) {
    const safeBase = sanitizeMediaName(baseName);
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

function sanitizeSoundName(name) {
    const raw = (name || '').toString().trim();
    if (!raw) return null;
    const baseName = path.basename(raw);
    const parsed = path.parse(baseName);
    const safeBase = parsed.name.replace(/[^a-z0-9-_]/gi, '').slice(0, 80);
    const safeExt = parsed.ext.replace(/[^a-z0-9.]/gi, '').slice(0, 12);
    if (!safeBase) return null;
    return `${safeBase}${safeExt}`;
}

let activeSoundTestProcess = null;
let preferredSoundPlayer = null;

function clampSoundVolumePercent(value) {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) return 100;
    return Math.max(0, Math.min(100, parsed));
}

function runCommandSilently(cmd, args = []) {
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

async function setSystemAudioToMaxOnHubStart() {
    // Best-effort only: keep startup robust even if amixer/card names differ.
    const commands = [
        ['amixer', ['set', 'Master', '100%', 'unmute']],
        ['amixer', ['set', 'PCM', '100%', 'unmute']],
        ['amixer', ['-c', 'UC02', 'set', 'PCM', '100%', 'unmute']],
        ['amixer', ['-c', '2', 'set', 'PCM', '100%', 'unmute']]
    ];
    for (const [cmd, args] of commands) {
        try { await runCommandSilently(cmd, args); } catch (e) {}
    }
}

async function ensureSystemAudioMax() {
    await setSystemAudioToMaxOnHubStart();
}

function stopActiveSoundTestProcess() {
    if (!activeSoundTestProcess) return;
    const child = activeSoundTestProcess;
    activeSoundTestProcess = null;
    try { child.kill('SIGTERM'); } catch (e) {}
    setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (e) {}
    }, 300);
}

function trySpawnSoundPlayer(cmd, args) {
    return new Promise((resolve) => {
        let child = null;
        let settled = false;
        try {
            child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'ignore'] });
        } catch (err) {
            resolve({ ok: false, error: err?.message || 'spawn failed' });
            return;
        }

        const promoteTimer = setTimeout(() => {
            if (settled) return;
            settled = true;
            activeSoundTestProcess = child;
            child.on('close', () => {
                if (activeSoundTestProcess === child) activeSoundTestProcess = null;
            });
            resolve({ ok: true, cmd, args });
        }, 220);

        child.on('error', (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(promoteTimer);
            resolve({ ok: false, error: err?.message || 'spawn error' });
        });

        child.on('close', (code) => {
            if (settled) {
                if (activeSoundTestProcess === child) activeSoundTestProcess = null;
                return;
            }
            settled = true;
            clearTimeout(promoteTimer);
            if (code === 0) {
                resolve({ ok: true, cmd, args, finished: true });
                return;
            }
            resolve({ ok: false, error: `exit ${code}` });
        });
    });
}

async function playSoundTestOnPi(filePath, volumePercent) {
    await ensureSystemAudioMax();
    const vol = clampSoundVolumePercent(volumePercent);
    const paplayVolume = Math.round((vol / 100) * 65536);
    const mpg123Scale = Math.max(0, Math.min(32768, Math.round((vol / 100) * 32768)));
    const baseCandidates = [
        { cmd: 'ffplay', args: ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-volume', String(vol), filePath] },
        { cmd: 'paplay', args: [`--volume=${paplayVolume}`, filePath] },
        { cmd: 'mpv', args: ['--no-video', '--really-quiet', `--volume=${vol}`, filePath] },
        { cmd: 'mpg123', args: ['-q', '-f', String(mpg123Scale), filePath] },
        { cmd: 'aplay', args: [filePath] }
    ];
    const candidates = preferredSoundPlayer
        ? [
            ...baseCandidates.filter((c) => c.cmd === preferredSoundPlayer),
            ...baseCandidates.filter((c) => c.cmd !== preferredSoundPlayer)
        ]
        : baseCandidates;

    let lastError = 'no player available';
    for (const candidate of candidates) {
        const result = await trySpawnSoundPlayer(candidate.cmd, candidate.args);
        if (result.ok) {
            preferredSoundPlayer = candidate.cmd;
            return { ok: true, player: candidate.cmd };
        }
        lastError = result.error || lastError;
    }
    return { ok: false, error: lastError };
}

app.get('/api/sounds/list', (req, res) => {
    try {
        ensureSoundsStorage();
        const files = fs.readdirSync(SOUNDS_DIR)
            .map((name) => {
                const abs = path.join(SOUNDS_DIR, name);
                const stat = fs.statSync(abs);
                if (!stat.isFile()) return null;
                return {
                    name,
                    size: stat.size,
                    modifiedAt: stat.mtimeMs,
                    path: `/sounds/${encodeURIComponent(name)}`
                };
            })
            .filter(Boolean)
            .sort((a, b) => a.name.localeCompare(b.name));
        return res.json({ success: true, sounds: files });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Could not load sounds list' });
    }
});

app.post('/api/sounds/upload', (req, res) => {
    try {
        ensureSoundsStorage();
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Sound storage unavailable' });
    }

    const nameParam = req.query?.name || req.headers['x-sound-name'] || req.headers['x-filename'];
    const safeName = sanitizeSoundName(nameParam);
    if (!safeName) {
        return res.status(400).json({ success: false, error: 'Missing or invalid sound name' });
    }

    const tempPath = path.join(SOUNDS_DIR, `${safeName}.uploading-${Date.now()}`);
    const targetPath = path.join(SOUNDS_DIR, safeName);
    const writeStream = fs.createWriteStream(tempPath);
    let totalBytes = 0;
    let finished = false;

    function cleanupTemp() {
        if (!fs.existsSync(tempPath)) return;
        try { fs.unlinkSync(tempPath); } catch (e) {}
    }

    req.on('data', (chunk) => { totalBytes += chunk.length; });
    req.on('aborted', () => {
        if (finished) return;
        finished = true;
        cleanupTemp();
    });
    req.on('error', (err) => {
        if (finished) return;
        finished = true;
        cleanupTemp();
        res.status(500).json({ success: false, error: err.message || 'Upload failed' });
    });

    writeStream.on('error', (err) => {
        if (finished) return;
        finished = true;
        cleanupTemp();
        res.status(500).json({ success: false, error: err.message || 'Upload failed' });
    });
    writeStream.on('finish', () => {
        if (finished) return;
        finished = true;
        fs.rename(tempPath, targetPath, (err) => {
            if (err) {
                cleanupTemp();
                return res.status(500).json({ success: false, error: 'Could not finalize upload' });
            }
            return res.json({ success: true, name: safeName, bytes: totalBytes, path: `/sounds/${encodeURIComponent(safeName)}` });
        });
    });

    req.pipe(writeStream);
});

app.post('/api/sounds/delete', (req, res) => {
    try {
        ensureSoundsStorage();
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Sound storage unavailable' });
    }
    const rawName = req.query?.name;
    const safeName = sanitizeSoundName(rawName);
    if (!safeName) {
        return res.status(400).json({ success: false, error: 'Missing or invalid sound name' });
    }
    const targetPath = path.join(SOUNDS_DIR, safeName);
    if (!fs.existsSync(targetPath)) {
        return res.status(404).json({ success: false, error: 'Sound not found' });
    }
    try {
        fs.unlinkSync(targetPath);
        return res.json({ success: true, name: safeName });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Could not delete sound' });
    }
});

app.post('/api/sounds/rename', (req, res) => {
    try {
        ensureSoundsStorage();
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Sound storage unavailable' });
    }
    const oldName = sanitizeSoundName(req.query?.oldName);
    const newName = sanitizeSoundName(req.query?.newName);
    if (!oldName || !newName) {
        return res.status(400).json({ success: false, error: 'Missing or invalid sound name' });
    }
    if (oldName === newName) {
        return res.json({ success: true, name: oldName });
    }
    const oldPath = path.join(SOUNDS_DIR, oldName);
    const newPath = path.join(SOUNDS_DIR, newName);
    if (!fs.existsSync(oldPath)) {
        return res.status(404).json({ success: false, error: 'Source sound not found' });
    }
    if (fs.existsSync(newPath)) {
        return res.status(409).json({ success: false, error: 'Target sound name already exists' });
    }
    try {
        fs.renameSync(oldPath, newPath);
        return res.json({ success: true, name: newName, oldName });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Could not rename sound' });
    }
});

app.post('/api/sounds/test', async (req, res) => {
    try {
        ensureSoundsStorage();
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Sound storage unavailable' });
    }
    const safeName = sanitizeSoundName(req.query?.name);
    if (!safeName) {
        return res.status(400).json({ success: false, error: 'Missing or invalid sound name' });
    }
    const targetPath = path.join(SOUNDS_DIR, safeName);
    if (!fs.existsSync(targetPath)) {
        return res.status(404).json({ success: false, error: 'Sound not found' });
    }

    stopActiveSoundTestProcess();
    const volume = clampSoundVolumePercent(req.query?.volume);
    const result = await playSoundTestOnPi(targetPath, volume);
    if (!result.ok) {
        return res.status(500).json({ success: false, error: `Could not play sound (${result.error || 'unknown'})` });
    }
    return res.json({ success: true, name: safeName, volume, player: result.player });
});

app.post('/api/sounds/stop', (req, res) => {
    stopActiveSoundTestProcess();
    try {
        if (typeof gameEngine.stopAllSoundPlayback === 'function') {
            gameEngine.stopAllSoundPlayback();
        }
    } catch (err) {}
    return res.json({ success: true });
});

app.post('/api/media/upload', (req, res) => {
    const enabled = !!gameEngine.getSystemSettings().mediaServerEnabled;
    if (!enabled) {
        return res.status(503).json({ success: false, error: 'Media server disabled' });
    }
    try {
        ensureMediaStorage();
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Media storage unavailable' });
    }

    const nameParam = req.query?.name || req.headers['x-media-name'] || req.headers['x-filename'];
    const safeName = sanitizeMediaName(nameParam);
    if (!safeName) {
        return res.status(400).json({ success: false, error: 'Missing or invalid media name' });
    }

    const tempPath = path.join(MEDIA_DIR, `${safeName}.uploading-${Date.now()}`);
    const targetPath = path.join(MEDIA_DIR, safeName);
    const writeStream = fs.createWriteStream(tempPath);
    let totalBytes = 0;
    let finished = false;

    function cleanupTemp() {
        if (!fs.existsSync(tempPath)) return;
        try { fs.unlinkSync(tempPath); } catch (e) {}
    }

    req.on('data', (chunk) => { totalBytes += chunk.length; });
    req.on('aborted', () => {
        if (finished) return;
        finished = true;
        cleanupTemp();
    });
    req.on('error', (err) => {
        if (finished) return;
        finished = true;
        cleanupTemp();
        res.status(500).json({ success: false, error: err.message || 'Upload failed' });
    });

    writeStream.on('error', (err) => {
        if (finished) return;
        finished = true;
        cleanupTemp();
        res.status(500).json({ success: false, error: err.message || 'Upload failed' });
    });
    writeStream.on('finish', () => {
        if (finished) return;
        finished = true;
        fs.rename(tempPath, targetPath, (err) => {
            if (err) {
                cleanupTemp();
                return res.status(500).json({ success: false, error: 'Could not finalize upload' });
            }
            return res.json({ success: true, name: safeName, bytes: totalBytes, path: `/media/${safeName}` });
        });
    });

    req.pipe(writeStream);
});

app.get('/api/media/resolve', (req, res) => {
    const enabled = !!gameEngine.getSystemSettings().mediaServerEnabled;
    if (!enabled) {
        return res.status(503).json({ success: false, error: 'Media server disabled' });
    }
    try {
        ensureMediaStorage();
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Media storage unavailable' });
    }
    const nameParam = req.query?.name;
    const match = findMediaByBaseName(nameParam);
    if (!match) {
        return res.status(404).json({ success: false, error: 'Media not found' });
    }
    return res.json({ success: true, name: match, path: `/media/${match}` });
});

app.use(bodyParser.json({ limit: '15mb' }));

const mediaStatic = express.static(MEDIA_DIR, {
    fallthrough: false,
    setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
});

app.use('/media', (req, res, next) => {
    const enabled = !!gameEngine.getSystemSettings().mediaServerEnabled;
    if (!enabled) {
        return res.status(503).json({ error: 'Media server disabled' });
    }
    try {
        ensureMediaStorage();
    } catch (err) {
        return res.status(500).json({ error: 'Media storage unavailable' });
    }
    return mediaStatic(req, res, next);
});

const soundsStatic = express.static(SOUNDS_DIR, {
    fallthrough: false,
    setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
});

app.use('/sounds', (req, res, next) => {
    try {
        ensureSoundsStorage();
    } catch (err) {
        return res.status(500).json({ error: 'Sound storage unavailable' });
    }
    return soundsStatic(req, res, next);
});

// Running room screen should only be reachable while the room is active
app.get('/room.html', (req, res) => {
    const status = gameEngine.getRuntimeRoomStatus();
    if (!status?.running) {
        res.setHeader('Cache-Control', 'no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        return res.redirect(302, '/index.html');
    }
    return res.sendFile(path.join(PUBLIC_DIR, 'room.html'));
});

// Statische Dateien aus 'public' laden, immer ohne Cache
const staticOptions = {
    setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
};
app.use(express.static(PUBLIC_DIR, staticOptions));

// API Routen
app.use('/api', apiRoutes(db, mqttClient));

// --- WICHTIG: MQTT VERBINDUNG ---
// Leitet Nachrichten vom Broker an die GameEngine weiter
mqttClient.on('message', (topic, message) => {
    gameEngine.processMqttMessage(topic.toString(), message);
});

// Dynamische Screens aus der Raum-Konfiguration bereitstellen
app.get('/:screenPath', (req, res, next) => {
    const slug = (req.params.screenPath || "").toLowerCase();
    if (!slug) return next();

    const screen = gameEngine.findScreenByPath(slug);
    const safeName = (screen?.name || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c] || ""));
    if (!screen) {
        const availableScreens = (gameEngine.getScreens?.() || [])
            .map((entry) => String(entry?.path || "").trim().toLowerCase())
            .filter((path, index, arr) => path && arr.indexOf(path) === index)
            .sort((a, b) => a.localeCompare(b));
        const availableListHtml = availableScreens.length
            ? availableScreens.map((path) => {
                const encodedPath = encodeURIComponent(path);
                const fullAddress = `http://escapehub.local/${path}`;
                return `<li><a href="/${encodedPath}" data-full="${fullAddress}">${fullAddress}</a></li>`;
            }).join("")
            : "<li>No configured screen addresses found.</li>";
        res.setHeader('Cache-Control', 'no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        return res.status(404).type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Screen not found</title>
    <link rel="icon" type="image/png" href="/favicon.png">
    <style>
        body { margin:0; display:flex; align-items:center; justify-content:center; min-height:100vh; background:#0f172a; color:#e5ecf5; font-family:"Segoe UI",sans-serif; }
        .card { text-align:left; padding:32px 28px; border:1px solid #1f2a3d; border-radius:12px; background:#111827; box-shadow:0 16px 40px rgba(0,0,0,0.45); width:min(640px,92vw); }
        h1 { margin:0 0 10px; font-size:22px; }
        p { margin:6px 0 0; color:#9fb1c8; }
        small { display:block; margin-top:12px; color:#7b8aa4; }
        h2 { margin:18px 0 8px; font-size:15px; color:#d8e6ff; }
        ul { margin:0; padding-left:18px; max-height:220px; overflow:auto; }
        li { margin:6px 0; color:#b8c8de; }
        a { color:#7ec4ff; text-decoration:none; word-break:break-all; }
        a:hover { text-decoration:underline; }
    </style>
</head>
<body>
    <div class="card">
        <h1>Screen not found</h1>
        <p>Waiting for screen <strong>${safeName || slug}</strong> to become available...</p>
        <h2>Available addresses</h2>
        <ul>${availableListHtml}</ul>
        <small id="status">Checking...</small>
    </div>
    <script>
        const statusEl = document.getElementById('status');
        document.querySelectorAll('a[data-full]').forEach((link) => {
            link.addEventListener('click', (event) => {
                event.preventDefault();
                const fullAddress = link.getAttribute('data-full');
                if (fullAddress) {
                    window.location.href = fullAddress;
                }
            });
        });
        async function poll() {
            try {
                const res = await fetch(window.location.pathname, { method: 'HEAD', cache: 'no-store' });
                statusEl.textContent = res.ok ? 'Screen is back, reloading...' : 'Still missing...';
                if (res.ok) {
                    const url = new URL(window.location.href);
                    url.searchParams.set('_r', Date.now());
                    window.location.replace(url.toString());
                }
            } catch (e) {
                statusEl.textContent = 'Still missing...';
            }
        }
        poll();
        setInterval(poll, 2000);
    </script>
</body>
</html>`);
    }

    const role = screen.role || "player";
    if (role === "hint") {
        return res.sendFile(path.join(PUBLIC_DIR, 'hint-screen.html'));
    }
    if (role === "progress") {
        return res.sendFile(path.join(PUBLIC_DIR, 'progress-screen.html'));
    }
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    // Serve the new player screen directly; the page reads the slug from the URL path.
    return res.sendFile(path.join(PUBLIC_DIR, 'player-screen.html'));
});

// Server Start (fixed 3000)
const PORT = 80;
server.listen(PORT, () => {
console.log(`Escape Room Hub running on http://localhost:${PORT}`);
void setSystemAudioToMaxOnHubStart();
});
