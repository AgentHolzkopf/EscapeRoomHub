const express = require('express');
const http = require('http');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

// Base paths so imports still work after moving this file into /Server
const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const MEDIA_DIR = path.join(ROOT_DIR, 'MediaStorage');

function ensureMediaStorage() {
    if (!fs.existsSync(MEDIA_DIR)) {
        fs.mkdirSync(MEDIA_DIR, { recursive: true });
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
        res.setHeader('Cache-Control', 'no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        return res.status(404).type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Screen not found</title>
    <style>
        body { margin:0; display:flex; align-items:center; justify-content:center; min-height:100vh; background:#0f172a; color:#e5ecf5; font-family:"Segoe UI",sans-serif; }
        .card { text-align:center; padding:32px 28px; border:1px solid #1f2a3d; border-radius:12px; background:#111827; box-shadow:0 16px 40px rgba(0,0,0,0.45); width:min(420px,90vw); }
        h1 { margin:0 0 10px; font-size:22px; }
        p { margin:6px 0 0; color:#9fb1c8; }
        small { display:block; margin-top:12px; color:#7b8aa4; }
    </style>
</head>
<body>
    <div class="card">
        <h1>Screen not found</h1>
        <p>Waiting for screen <strong>${safeName || slug}</strong> to become available...</p>
        <small id="status">Checking...</small>
    </div>
    <script>
        const statusEl = document.getElementById('status');
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
});
