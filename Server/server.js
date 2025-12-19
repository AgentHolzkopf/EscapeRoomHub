const express = require('express');
const http = require('http');
const bodyParser = require('body-parser');
const path = require('path');

// Base paths so imports still work after moving this file into /Server
const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

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
app.use(bodyParser.json({ limit: '15mb' }));

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

    const isHint = (screen.role || "player") === "hint";
    if (isHint) {
        return res.sendFile(path.join(PUBLIC_DIR, 'hint-screen.html'));
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
