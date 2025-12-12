const express = require('express');
const http = require('http');
const bodyParser = require('body-parser');
const path = require('path');

// Module laden (Pfade angepasst auf src/)
const db = require('./src/engine/database');
const mqttClient = require('./src/engine/mqttClient');
const gameEngine = require('./src/engine/gameLoop');
const apiRoutes = require('./src/routes/routes');

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
app.use(express.static(path.join(__dirname, 'public'), staticOptions));

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
        return res.sendFile(path.join(__dirname, 'public', 'hint-screen.html'));
    }
    const label = "Eingabe";
    const description = "Eingabe fuer Player Input.";

    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.type('html').send(`<!DOCTYPE html>
<html lang="de">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${label} - ${safeName || slug}</title>
    <style>
        :root { --bg:#0b1220; --card:#0f172a; --text:#e5ecf5; --muted:#8da0bc; --accent:#3b82f6; }
        * { box-sizing:border-box; }
        body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; background:radial-gradient(circle at 20% 20%, rgba(59,130,246,0.08), transparent 35%), var(--bg); color:var(--text); font-family:"Segoe UI", Tahoma, Geneva, Verdana, sans-serif; }
        .card { width:min(480px, 92vw); padding:32px 28px; border-radius:16px; background:var(--card); border:1px solid rgba(255,255,255,0.05); box-shadow:0 20px 60px rgba(0,0,0,0.45); text-align:center; }
        .pill { display:inline-flex; align-items:center; gap:8px; padding:6px 12px; border-radius:999px; background:rgba(59,130,246,0.12); color:var(--accent); font-weight:700; letter-spacing:0.4px; text-transform:uppercase; font-size:12px; }
        h1 { margin:14px 0 6px; font-size:28px; }
        p { margin:0; color:var(--muted); font-size:14px; line-height:1.6; }
        .missing { position:fixed; inset:0; display:none; align-items:center; justify-content:center; background:rgba(0,0,0,0.75); z-index:10; color:#e5ecf5; font-family:"Segoe UI",sans-serif; }
        .missing.active { display:flex; }
        .missing .box { background:#111827; padding:24px 28px; border-radius:12px; border:1px solid #1f2a3d; text-align:center; width:min(420px,90vw); box-shadow:0 16px 40px rgba(0,0,0,0.45); }
        .missing h2 { margin:0 0 8px; font-size:20px; }
        .missing p { margin:4px 0; color:#9fb1c8; }
        .missing small { color:#7b8aa4; }
    </style>
</head>
<body>
    <div class="missing" id="missing-overlay">
        <div class="box">
            <h2>Screen not found</h2>
            <p id="missing-status">Checking...</p>
            <small>URL: ${slug}</small>
        </div>
    </div>
    <div class="card">
        <div class="pill">${label} Screen</div>
        <h1>${safeName || slug}</h1>
        <p>${description}</p>
    </div>
    <script>
        const originalPath = window.location.pathname + window.location.search;
        const screenSlug = '${slug}';
        let redirected = false;
        let missingHandled = false;

        async function poll() {
            try {
                const screenRes = await fetch('/api/screens/' + encodeURIComponent(screenSlug) + '/status', { cache: 'no-store' });
                if (!screenRes.ok) {
                    throw new Error('screen status failed');
                }
                const screen = await screenRes.json();
                if (!screen.exists) {
                    if (!missingHandled) {
                        missingHandled = true;
                        const url = new URL(window.location.href);
                        url.searchParams.set('_r', Date.now());
                        window.location.replace(url.toString());
                    }
                    return;
                }
                // screen exists: reset missing flag for future changes
                missingHandled = false;

                const statusRes = await fetch('/api/runtime/room/status', { cache: 'no-store' });
                const status = await statusRes.json();
                const running = !!status.running;
                const total = status?.puzzles?.total || 0;
                const solved = status?.puzzles?.solved || 0;
                const solvedAll = total > 0 && solved >= total;
                if (solvedAll && !redirected) {
                    redirected = true;
                    window.location.replace('/screensaver.html?type=victory&return=' + encodeURIComponent(originalPath));
                    return;
                }
                if (!solvedAll) {
                    redirected = false; // allow normal flow after restart/exit
                }
                if (!running && !redirected) {
                    redirected = true;
                    window.location.replace('/screensaver.html?type=player&return=' + encodeURIComponent(originalPath));
                    return;
                }
                redirected = false;
            } catch (e) {
                // stay and try again
            }
        }

        poll();
        setInterval(poll, 2000);
    </script>
</body>
</html>`);
});

// Server Start (fixed 3000)
const PORT = 80;
server.listen(PORT, () => {
console.log(`Escape Room Hub running on http://localhost:${PORT}`);
});
