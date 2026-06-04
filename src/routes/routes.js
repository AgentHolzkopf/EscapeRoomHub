const express = require('express');
const router = express.Router();
const gameEngine = require('../engine/gameLoop');
const db = require('../engine/database'); 

module.exports = (dbWrapper, mqttClient) => {

    const noCache = (res) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    };

    // 1. Lade AKTUELLEN Raum
    router.get('/room', async (req, res) => {
        noCache(res);
        const currentName = gameEngine.getCurrentRoomName();
        
        if (!currentName) return res.json({ empty: true });

        try {
            const row = await db.get("SELECT json_data FROM rooms WHERE name = ?", [currentName]);
            if(row) res.json(JSON.parse(row.json_data)); 
            else res.json({ empty: true });
        } catch(e) { res.status(500).json({}); }
    });

    router.get('/events', (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders && res.flushHeaders();

        const emitter = gameEngine.getEventEmitter && gameEngine.getEventEmitter();
        const send = (payload) => {
            res.write(`event: update\ndata: ${JSON.stringify(payload)}\n\n`);
        };
        const onUpdate = (payload) => send(payload);
        if (emitter) {
            emitter.on('update', onUpdate);
        }
        const ping = setInterval(() => {
            res.write('event: ping\ndata: {}\n\n');
        }, 25000);

        send({ type: 'connected' });

        req.on('close', () => {
            clearInterval(ping);
            if (emitter) {
                emitter.off('update', onUpdate);
            }
        });
    });

    // 2. Speichern
    router.put('/room', async (req, res) => {
        const success = await gameEngine.updateGraph(req.body);
        if(success) res.json({status: "saved"});
        else res.status(500).json({error: "No active room"});
    });

    // 3. Start Room (Game)
    router.post('/room/start/check', (req, res) => {
        const currentName = gameEngine.getCurrentRoomName();
        if (!currentName) {
            return res.status(400).json({ error: "No active room selected" });
        }
        const readiness = gameEngine.validateRoomReadiness();
        res.json(readiness);
    });

    router.post('/room/start', (req, res) => {
        const currentName = gameEngine.getCurrentRoomName();
        if (!currentName) {
            return res.status(400).json({ status: "error", error: "No active room selected" });
        }

        const force = !!req.body?.force;
        const readiness = gameEngine.validateRoomReadiness();
        if (!force && readiness.warnings.length) {
            return res.status(400).json({ status: "warnings", warnings: readiness.warnings });
        }

        gameEngine.startGame();
        res.json({ status: "ok", warnings: readiness.warnings });
    });

    // 4. Liste
    router.get('/rooms/list', async (req, res) => {
        noCache(res);
        const list = await gameEngine.getRoomList();
        const current = gameEngine.getCurrentRoomName();
        res.json({ files: list, current: current });
    });

    // 5. Load
    router.post('/rooms/load', (req, res) => {
        gameEngine.switchRoom(req.body.filename);
        res.json({status: "ok"});
    });

    // 6. Create
    router.post('/rooms/create', async (req, res) => {
        const success = await gameEngine.createRoom(req.body.filename);
        if(success) res.json({status: "ok"});
        else res.status(400).json({error: "Name exists"});
    });

    // 7. Rename
    router.post('/rooms/rename', async (req, res) => {
        const success = await gameEngine.renameRoom(req.body.oldName, req.body.newName);
        res.json({status: success ? "ok" : "error"});
    });

    // 8. Delete
    router.post('/rooms/delete', async (req, res) => {
        const success = await gameEngine.deleteRoom(req.body.filename);
        res.json({status: "ok"});
    });

    // Standard
    router.get('/devices', (req, res) => { noCache(res); res.json(gameEngine.getDevices()); });
    router.post('/devices/delete', async (req, res) => { await gameEngine.removeDevice(req.body.id); res.json({status: "ok"}); });
    router.get('/logs', (req, res) => res.json(gameEngine.getLogs()));
    router.post('/logs/clear', (req, res) => res.json(gameEngine.clearLogs()));
    router.get('/runtime/status', (req, res) => { noCache(res); res.json(gameEngine.getPuzzleStatuses()); });
    router.get('/screens/:slug/status', (req, res) => {
        noCache(res);
        const slug = (req.params.slug || "").toLowerCase();
        const screen = gameEngine.findScreenByPath(slug);
        if (!screen) {
            return res.json({ exists: false });
        }
        res.json({
            exists: true,
            role: screen.role || "player",
            id: screen.id,
            name: screen.name || slug,
            path: screen.path || slug,
            progressStyle: screen.progressStyle || null,
            branchIds: Array.isArray(screen.branchIds) ? screen.branchIds : [],
            showRunningTime: !!screen.showRunningTime
        });
    });
    router.get('/player-input/:slug/state', async (req, res) => {
        noCache(res);
        const slug = req.params.slug || "";
        const data = await gameEngine.getExternalChecksForScreen(slug);
        if (!data.success && data.exists === false) {
            return res.status(404).json(data);
        }
        res.json(data);
    });
    router.post('/player-input/:slug/submit', async (req, res) => {
        const slug = req.params.slug || "";
        const puzzleId = req.body?.puzzleId;
        const answer = req.body?.answer;
        const result = await gameEngine.submitExternalPlayerInput(slug, puzzleId, answer);
        if (!result.success && result.code !== "NO_SOLUTION") {
            return res.status(400).json(result);
        }
        res.json(result);
    });
    router.get('/runtime/data', (req, res) => { noCache(res); res.json(gameEngine.getDataSnapshot()); });
    router.get('/runtime/room/status', (req, res) => { noCache(res); res.json(gameEngine.getRuntimeRoomStatus()); });
    router.post('/runtime/auto-restart', (req, res) => {
        const enabled = !!req.body?.enabled;
        const delay = req.body?.delaySec ?? req.body?.delay;
        const result = gameEngine.setAutoRestart(enabled, delay);
        res.json(result);
    });
    router.post('/runtime/dmx/cue/test', (req, res) => {
        const fixtureId = req.body?.fixtureId;
        const cueId = req.body?.cueId;
        const result = gameEngine.testDmxCue(fixtureId, cueId);
        if (!result.success) {
            return res.status(400).json(result);
        }
        res.json(result);
    });
    router.post('/runtime/dmx/cue/test/stop', (req, res) => {
        const result = gameEngine.stopDmxTestPlayback();
        if (!result.success) {
            return res.status(400).json(result);
        }
        res.json(result);
    });
    router.get('/zigbee/devices', (req, res) => {
        noCache(res);
        const result = gameEngine.getZigbeeDevices();
        res.json(result);
    });
    router.post('/zigbee/discovery/start', (req, res) => {
        const durationSec = req.body?.durationSec;
        const result = gameEngine.startZigbeeDiscovery(durationSec);
        if (!result.success) {
            return res.status(400).json(result);
        }
        res.json(result);
    });
    router.post('/zigbee/discovery/stop', (req, res) => {
        const result = gameEngine.stopZigbeeDiscovery();
        if (!result.success) {
            return res.status(400).json(result);
        }
        res.json(result);
    });
    router.post('/zigbee/discovery/refresh', (req, res) => {
        const result = gameEngine.refreshZigbeeDevices();
        res.json(result);
    });
    router.post('/zigbee/devices/hide', (req, res) => {
        const deviceId = req.body?.deviceId;
        const result = gameEngine.hideZigbeeDevice(deviceId);
        if (!result.success) {
            return res.status(400).json(result);
        }
        res.json(result);
    });
    router.post('/zigbee/devices/rename', async (req, res) => {
        const deviceId = req.body?.deviceId;
        const newName = req.body?.newName;
        const result = await gameEngine.renameZigbeeDevice(deviceId, newName);
        if (!result.success) {
            return res.status(400).json(result);
        }
        res.json(result);
    });
    router.post('/zigbee/devices/reset-on-puzzle-reset', (req, res) => {
        const deviceId = req.body?.deviceId;
        const enabled = !!req.body?.enabled;
        const result = gameEngine.setZigbeeDeviceResetOnPuzzleReset(deviceId, enabled);
        if (!result.success) {
            return res.status(400).json(result);
        }
        res.json(result);
    });
    router.post('/zigbee/triggers/upsert', (req, res) => {
        const result = gameEngine.upsertZigbeeMessageTrigger(req.body || {});
        if (!result.success) {
            return res.status(400).json(result);
        }
        res.json(result);
    });
    router.post('/zigbee/triggers/delete', (req, res) => {
        const result = gameEngine.deleteZigbeeMessageTrigger(req.body?.triggerId);
        if (!result.success) {
            return res.status(400).json(result);
        }
        res.json(result);
    });
    router.get('/system/settings', async (req, res) => {
        try {
            const settings = await gameEngine.getSystemSettings();
            res.json({ success: true, settings });
        } catch (err) {
            res.status(500).json({ success: false, error: 'Konnte Einstellungen nicht laden.' });
        }
    });
    router.post('/system/media-server', async (req, res) => {
        try {
            const enabled = !!req.body?.enabled;
            const result = await gameEngine.setMediaServerEnabled(enabled);
            if (!result.success) {
                return res.status(400).json(result);
            }
            res.json(result);
        } catch (err) {
            res.status(500).json({ success: false, error: 'Media Server konnte nicht gesetzt werden.' });
        }
    });
    router.post('/system/autostart', async (req, res) => {
        try {
            const enabled = !!req.body?.enabled;
            const result = await gameEngine.setAutostartEnabled(enabled);
            if (!result.success) {
                return res.status(400).json(result);
            }
            res.json(result);
        } catch (err) {
            res.status(500).json({ success: false, error: 'Autostart konnte nicht gesetzt werden.' });
        }
    });
    router.post('/system/zigbee-bridge', async (req, res) => {
        try {
            const enabled = !!req.body?.enabled;
            const result = await gameEngine.setZigbeeBridgeEnabled(enabled);
            if (!result.success) {
                return res.status(400).json(result);
            }
            res.json(result);
        } catch (err) {
            res.status(500).json({ success: false, error: 'Zigbee Bridge konnte nicht gesetzt werden.' });
        }
    });
    router.post('/system/dmx-service', async (req, res) => {
        try {
            const enabled = !!req.body?.enabled;
            const result = await gameEngine.setDmxServiceEnabled(enabled);
            if (!result.success) {
                return res.status(400).json(result);
            }
            res.json(result);
        } catch (err) {
            res.status(500).json({ success: false, error: 'DMX Service konnte nicht gesetzt werden.' });
        }
    });
    router.post('/system/mqtt-port', async (req, res) => {
        try {
            const result = await gameEngine.setMqttPort(req.body?.port);
            if (!result.success) {
                return res.status(400).json(result);
            }
            res.json(result);
        } catch (err) {
            res.status(500).json({ success: false, error: 'MQTT Port konnte nicht gesetzt werden.' });
        }
    });
    router.post('/system/screen-saver', async (req, res) => {
        try {
            const result = await gameEngine.setScreenSaverImage(req.body?.imageName, req.body?.data);
            if (!result.success) {
                return res.status(400).json(result);
            }
            res.json(result);
        } catch (err) {
            res.status(500).json({ success: false, error: 'Bild konnte nicht gespeichert werden.' });
        }
    });
    router.post('/system/victory-screen', async (req, res) => {
        try {
            const result = await gameEngine.setVictoryScreen(req.body?.imageName, req.body?.data);
            if (!result.success) {
                return res.status(400).json(result);
            }
            res.json(result);
        } catch (err) {
            res.status(500).json({ success: false, error: 'Victory Screen konnte nicht gespeichert werden.' });
        }
    });

    router.get('/runtime/puzzles/:puzzleId/status', (req, res) => {
        const status = gameEngine.getPuzzleStatus(parseInt(req.params.puzzleId, 10));
        if (!status) {
            return res.status(404).json({ error: "Puzzle not found" });
        }
        res.json(status);
    });

    router.post('/runtime/puzzle/hint', (req, res) => {
        const puzzleId = parseInt(req.body?.puzzleId, 10);
        if (!puzzleId) return res.status(400).json({ success: false, error: "puzzleId required" });
        const result = gameEngine.triggerHintForPuzzle(puzzleId, { auto: false });
        if (!result.success) return res.status(400).json(result);
        res.json(result);
    });

    router.post('/runtime/puzzles/:puzzleId/hint/custom', (req, res) => {
        const puzzleId = parseInt(req.params.puzzleId, 10);
        if (!puzzleId) return res.status(400).json({ success: false, error: "puzzleId required" });
        const text = req.body?.text || "";
        const showAssignment = req.body?.showAssignment;
        const result = gameEngine.triggerCustomHint(puzzleId, text, { showAssignment });
        if (!result.success) return res.status(400).json(result);
        res.json(result);
    });

    router.post('/runtime/puzzles/:puzzleId/hint/settings', async (req, res) => {
        const puzzleId = parseInt(req.params.puzzleId, 10);
        if (!puzzleId) return res.status(400).json({ success: false, error: "puzzleId required" });
        const showHintAssignment = req.body?.showHintAssignment;
        const automaticHintTrigger = req.body?.automaticHintTrigger;
        const result = await gameEngine.updateHintSettings(puzzleId, { showHintAssignment, automaticHintTrigger });
        if (!result.success) return res.status(400).json(result);
        res.json(result);
    });

    router.post('/runtime/puzzles/:puzzleId/hint/remaining', async (req, res) => {
        const puzzleId = parseInt(req.params.puzzleId, 10);
        if (!puzzleId) return res.status(400).json({ success: false, error: "puzzleId required" });
        const result = await gameEngine.updateRemainingHints(puzzleId, req.body || {});
        if (!result.success) return res.status(400).json(result);
        res.json(result);
    });

    router.post('/runtime/puzzles/:puzzleId/status', (req, res) => {
        const result = gameEngine.setPuzzleStatus(parseInt(req.params.puzzleId, 10), req.body?.status, req.body?.note);
        if (!result.success) {
            return res.status(400).json(result);
        }
        res.json(result);
    });

    router.post('/runtime/puzzles/:puzzleId/reset', (req, res) => {
        const result = gameEngine.resetPuzzle(parseInt(req.params.puzzleId, 10), { 
            hard: !!req.body?.hardReset,
            note: req.body?.note
        });
        if (!result.success) {
            return res.status(400).json(result);
        }
        res.json(result);
    });

    router.post('/runtime/puzzles/:puzzleId/heartbeat', async (req, res) => {
        try {
            const result = await gameEngine.recordPuzzleHeartbeat(parseInt(req.params.puzzleId, 10), req.body || {});
            if (!result.success) {
                return res.status(400).json(result);
            }
            res.json(result);
        } catch (err) {
            console.error('Heartbeat error', err);
            res.status(500).json({ success: false, error: 'Heartbeat processing failed' });
        }
    });

    router.get('/runtime/puzzles/:puzzleId/solution', async (req, res) => {
        try {
            const data = await gameEngine.getPuzzleSolution(parseInt(req.params.puzzleId, 10));
            if (!data) {
                return res.status(404).json({ error: "Puzzle not found" });
            }
            res.json(data);
        } catch (err) {
            res.status(500).json({ error: 'Could not load solution' });
        }
    });

    router.post('/runtime/puzzles/:puzzleId/solution', async (req, res) => {
        try {
            const result = await gameEngine.setPuzzleSolution(parseInt(req.params.puzzleId, 10), req.body?.solution);
            if (!result.success) {
                return res.status(400).json(result);
            }
            res.json(result);
        } catch (err) {
            res.status(500).json({ error: 'Could not store solution' });
        }
    });

    router.get('/hints', (req, res) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        const data = gameEngine.getHintsForScreen(req.query?.screen || "");
        if (!data.success) return res.status(404).json(data);
        res.json(data);
    });

    router.get('/hints/:screenPath', (req, res) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        const data = gameEngine.getHintsForScreen(req.params.screenPath || "");
        if (!data.success) return res.status(404).json(data);
        res.json(data);
    });


    // Puzzle Flow & Control
    router.get('/runtime/puzzle-flow', (req, res) => {
        noCache(res);
        res.json(gameEngine.getPuzzleFlow());
    });

    router.post('/runtime/puzzle/solve', (req, res) => {
        const puzzleId = parseInt(req.body.puzzleId);
        if (!puzzleId) {
            return res.status(400).json({ success: false, error: "puzzleId required" });
        }
        const rawBranchId = req.body.branchId;
        const branchId = Number.isFinite(parseInt(rawBranchId, 10)) ? parseInt(rawBranchId, 10) : null;
        const result = gameEngine.markPuzzleSolved(puzzleId, { branchId });
        res.json(result);
    });

    router.post('/runtime/reset', (req, res) => {
        const result = gameEngine.resetRoom();
        res.json(result);
    });

    router.post('/runtime/restart', (req, res) => {
        const result = gameEngine.restartRoom({ auto: !!req.body?.auto });
        res.json(result);
    });

    router.post('/runtime/branch/restart', (req, res) => {
        const branchId = Number(req.body?.branchId);
        if (!Number.isFinite(branchId)) {
            return res.status(400).json({ success: false, error: "branchId required" });
        }
        const result = gameEngine.restartBranch({ branchId });
        res.json(result);
    });

    return router;
};
