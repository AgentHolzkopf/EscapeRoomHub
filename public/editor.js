// ===================================
// 1. LiteGraph Initialization
// ===================================
const graph = new LGraph();
const canvas = new LGraphCanvas("#graphcanvas", graph);
const statusDiv = document.getElementById("save-status");

const typeColors = {
    "string": "#d9b300",
    "number": "#2c7be5",
    "boolean": "#9b6bd3",
    [LiteGraph.ACTION]: "#c0c0ff",
    [LiteGraph.EVENT]: "#c0c0ff"
};
LGraphCanvas.link_type_colors = typeColors;
canvas.default_connection_color_byType = typeColors;     
canvas.default_connection_color_byTypeOff = typeColors; 
canvas.allow_searchbox = false; 
canvas.getCanvasMenuOptions = function() { return null; }; 
canvas.processContextMenu = function() { return false; };
LGraphNode.prototype.collapse = function() {}; 
canvas.allow_dragcanvas = true; 
canvas.canvas.tabIndex = 1; 
canvas.render_canvas_border = false;

LGraphCanvas.prototype.showLinkMenu = function(link, e) {
    var that = this;
    var menu = new LiteGraph.ContextMenu(["Delete"], {
        event: e, title: null, callback: (v) => { if(v==="Delete") that.graph.removeLink(link.id); }
    });
    return false;
};

graph.start();
const c = document.getElementById("graphcanvas");
function resizeCanvas() {
    if (!c) return;
    c.width = c.offsetWidth; c.height = c.offsetHeight; canvas.resize();
    canvas.draw(true, true);
}
resizeCanvas();
window.addEventListener("resize", resizeCanvas);

// ===================================
// 2. Backend Sync & Rooms
// ===================================
let currentRoomName = null;
let screens = [];
let nextScreenId = 1;
let lightingFixtures = [];
let lightingPresets = [];
let nextLightingFixtureId = 1;
let nextLightingCueId = 1;
let nextLightingPresetId = 1;
let roomScriptingConfig = { rules: [], nextRuleId: 1, blocklyState: null };
let zigbeeSnapshot = { devices: [], discoveryActive: false, discoveryRemainingSec: 0, bridgeState: "unknown", bridgeSeenRecently: false };
let zigbeePollTimer = null;
let zigbeeBackgroundPollTimer = null;
let zigbeeAgeRefreshTimer = null;
let zigbeeDiscoveryBusy = false;
let zigbeeEditingDeviceId = null;
const zigbeeLastSeenById = new Map();
const zigbeeMessageFlashUntil = new Map();
const zigbeeSignalFlashUntilByDevice = new Map();
const zigbeeDeviceMessagesById = new Map();
let selectedZigbeeDeviceId = null;
const puzzleStatusCache = {};
function sanitizeScreenPath(pathStr, fallback) {
    const base = (pathStr || "").toString().trim().toLowerCase();
    const cleaned = base.replace(/[^a-z0-9-_]/g, "");
    return cleaned || fallback;
}

function ensureUniqueScreenPath(pathStr, ownerId, usedSet) {
    const fallback = `screen-${ownerId || 1}`;
    const base = sanitizeScreenPath(pathStr, fallback);
    const currentUsed = usedSet || new Set(screens.filter(s => s.id !== ownerId && s.path).map(s => s.path));
    let candidate = base || fallback;
    let idx = 2;
    while (currentUsed.has(candidate)) {
        candidate = `${base || fallback}-${idx++}`;
    }
    if (usedSet) usedSet.add(candidate);
    return candidate;
}

const normalizeScreensData = (arr) => {
    if(!Array.isArray(arr)) return [];
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
    return arr.map((s,idx)=>{
        const id = typeof s.id === "number" ? s.id : parseInt(s.id || (idx+1),10) || (idx+1);
        return {
            id,
            name: s.name || `Screen ${(idx+1)}`,
            role: normalizeRole(s.role),
            progressStyle: normalizeProgressStyle(s.progressStyle),
            branchIds: Array.isArray(s.branchIds) ? s.branchIds.map(v => parseInt(v, 10)).filter(v => Number.isFinite(v)) : [],
            showRunningTime: !!s.showRunningTime,
            path: ensureUniqueScreenPath(s.path || s.slug || `screen-${idx+1}`, id, used)
        };
    });
};

function lightingClampInt(value, min, max, fallback = min) {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function normalizeLightingEffectsData(rawEffects) {
    const source = rawEffects && typeof rawEffects === "object" ? rawEffects : {};
    const durationRaw = source.durationMs !== undefined ? source.durationMs : source.holdMs;
    return {
        delayMs: lightingClampInt(source.delayMs, 0, 600000, 0),
        fadeInMs: lightingClampInt(source.fadeInMs, 0, 600000, 0),
        fadeOutMs: lightingClampInt(source.fadeOutMs, 0, 600000, 0),
        durationMs: lightingClampInt(durationRaw, 0, 600000, 0)
    };
}

function normalizeLightingChannelsData(rawChannels) {
    if (!rawChannels) return [];
    const map = new Map();

    if (Array.isArray(rawChannels)) {
        rawChannels.forEach((entry) => {
            const channel = lightingClampInt(entry?.channel, 1, 512, -1);
            if (channel < 1) return;
            const value = lightingClampInt(entry?.value, 0, 255, 0);
            const name = typeof entry?.name === "string" ? entry.name.trim() : "";
            const presetChannelId = Number.isFinite(parseInt(entry?.presetChannelId, 10)) ? parseInt(entry.presetChannelId, 10) : null;
            map.set(channel, { value, name: name || "", presetChannelId });
        });
    } else if (typeof rawChannels === "object") {
        Object.keys(rawChannels).forEach((key) => {
            const channel = lightingClampInt(key, 1, 512, -1);
            if (channel < 1) return;
            const value = lightingClampInt(rawChannels[key], 0, 255, 0);
            map.set(channel, { value, name: "", presetChannelId: null });
        });
    }

    return Array.from(map.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([channel, entry]) => ({
            channel,
            value: entry.value,
            name: entry.name || "",
            presetChannelId: Number.isFinite(entry.presetChannelId) ? entry.presetChannelId : null
        }));
}

function normalizeLightingPresetChannelsData(rawChannels) {
    if (!Array.isArray(rawChannels)) return [];
    return rawChannels
        .map((entry, idx) => {
            const id = Number.isFinite(parseInt(entry?.id, 10)) ? parseInt(entry.id, 10) : idx + 1;
            const name = (entry?.name || `Channel ${idx + 1}`).toString().trim() || `Channel ${idx + 1}`;
            const address = lightingClampInt(entry?.address, 1, 512, idx + 1);
            return { id, name, address };
        })
        .sort((a, b) => (a.id || 0) - (b.id || 0));
}

function normalizeLightingPresetsData(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.map((preset, idx) => {
        const id = Number.isFinite(parseInt(preset?.id, 10)) ? parseInt(preset.id, 10) : idx + 1;
        return {
            id,
            name: (preset?.name || `Preset ${idx + 1}`).toString(),
            channels: normalizeLightingPresetChannelsData(preset?.channels)
        };
    });
}

function normalizeLightingCueData(rawCue, idx) {
    const id = Number.isFinite(parseInt(rawCue?.id, 10)) ? parseInt(rawCue.id, 10) : idx + 1;
    const groupAssignmentsRaw = Array.isArray(rawCue?.groupAssignments) ? rawCue.groupAssignments : [];
    const groupAssignments = [];
    const seen = new Set();
    groupAssignmentsRaw.forEach((entry) => {
        const fixtureId = parseInt(entry?.fixtureId, 10);
        const cueId = parseInt(entry?.cueId, 10);
        if (!Number.isFinite(fixtureId) || !Number.isFinite(cueId)) return;
        const key = `${fixtureId}:${cueId}`;
        if (seen.has(key)) return;
        seen.add(key);
        groupAssignments.push({ fixtureId, cueId });
    });
    const rawTimeline = Array.isArray(rawCue?.sceneTimeline) ? rawCue.sceneTimeline : [];
    const sceneTimeline = rawTimeline
        .map((slot) => {
            const type = String(slot?.type || "").trim().toLowerCase();
            if (type === "delay") {
                const ms = lightingClampInt(slot?.ms, 0, 600000, 0);
                return ms > 0 ? { type: "delay", ms } : null;
            }
            const itemsRaw = Array.isArray(slot?.items) ? slot.items : (Array.isArray(slot?.cues) ? slot.cues : []);
            const items = itemsRaw
                .map((item) => {
                    const fixtureId = parseInt(item?.fixtureId, 10);
                    const cueId = parseInt(item?.cueId, 10);
                    if (!Number.isFinite(fixtureId) || !Number.isFinite(cueId)) return null;
                    return { fixtureId, cueId };
                })
                .filter(Boolean);
            return items.length ? { type: "cues", items } : null;
        })
        .filter(Boolean);
    return {
        id,
        name: (rawCue?.name || `Cue ${idx + 1}`).toString(),
        channels: normalizeLightingChannelsData(rawCue?.channels),
        effects: normalizeLightingEffectsData(rawCue?.effects),
        groupAssignments,
        sceneTimeline
    };
}

function normalizeLightingFixturesData(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.map((fixture, idx) => {
        const id = Number.isFinite(parseInt(fixture?.id, 10)) ? parseInt(fixture.id, 10) : idx + 1;
        const cuesRaw = Array.isArray(fixture?.cues) ? fixture.cues : [];
        const presetIdRaw = fixture?.presetId;
        const presetId = presetIdRaw === "custom" ? "custom" : parseInt(presetIdRaw, 10);
        const startAddress = lightingClampInt(fixture?.startAddress, 1, 512, 1);
        return {
            id,
            name: (fixture?.name || `Lamp ${idx + 1}`).toString(),
            presetId: presetIdRaw === "group" ? "group" : (Number.isFinite(presetId) ? presetId : "custom"),
            startAddress,
            groupMembers: Array.isArray(fixture?.groupMembers)
                ? fixture.groupMembers
                    .map((memberId) => parseInt(memberId, 10))
                    .filter((memberId, memberIdx, arr) => Number.isFinite(memberId) && arr.indexOf(memberId) === memberIdx)
                : [],
            cues: cuesRaw.map((cue, cueIdx) => normalizeLightingCueData(cue, cueIdx))
        };
    });
}

function migrateLegacyLightingCues(rawLighting, fixtures) {
    if (!Array.isArray(rawLighting?.cues) || !fixtures.length) return;
    const byFixtureId = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
    let localCueId = fixtures.reduce((maxFixtureCueId, fixture) => {
        const fixtureMax = (fixture.cues || []).reduce((maxCueId, cue) => Math.max(maxCueId, cue.id || 0), 0);
        return Math.max(maxFixtureCueId, fixtureMax);
    }, 0) + 1;

    rawLighting.cues.forEach((legacyCue, legacyCueIdx) => {
        const cueName = (legacyCue?.name || `Cue ${legacyCueIdx + 1}`).toString();
        if (!Array.isArray(legacyCue?.assignments)) return;
        legacyCue.assignments.forEach((assignment) => {
            const fixtureId = parseInt(assignment?.fixtureId, 10);
            const fixture = byFixtureId.get(fixtureId);
            if (!fixture) return;
            const values = Array.isArray(assignment?.values) ? assignment.values : [];
            const channels = values.map((value, idx) => ({
                channel: lightingClampInt(idx + 1, 1, 512, idx + 1),
                value: lightingClampInt(value, 0, 255, 0)
            }));
            fixture.cues.push({
                id: localCueId++,
                name: cueName,
                channels,
                effects: normalizeLightingEffectsData(null)
            });
        });
    });
}

function normalizeLightingConfigData(rawConfig) {
    const presets = normalizeLightingPresetsData(rawConfig?.presets);
    const fixtures = normalizeLightingFixturesData(rawConfig?.fixtures);
    const validPresetIds = new Set(presets.map((preset) => preset.id));
    const fixtureMap = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
    fixtures.forEach((fixture) => {
        if (fixture.presetId !== "custom" && fixture.presetId !== "group" && !validPresetIds.has(fixture.presetId)) {
            fixture.presetId = "custom";
        }
        if (fixture.presetId === "group") {
            const preservedSceneTimeline = Array.isArray(fixture?.cues?.[0]?.sceneTimeline)
                ? fixture.cues[0].sceneTimeline
                : [];
            const validMemberSet = new Set();
            fixture.cues = (fixture.cues || []).map((cue) => {
                ensureGroupCueAssignments(cue);
                cue.groupAssignments = cue.groupAssignments.filter((entry) => {
                    if (entry.fixtureId === fixture.id) return false;
                    const sourceFixture = fixtureMap.get(entry.fixtureId);
                    if (!sourceFixture || sourceFixture.presetId === "group") return false;
                    const hasCue = !!sourceFixture?.cues?.find((sourceCue) => parseInt(sourceCue?.id, 10) === entry.cueId);
                    if (hasCue) validMemberSet.add(entry.fixtureId);
                    return hasCue;
                });
                return cue;
            });
            const mergedAssignments = [];
            const seenAssign = new Set();
            fixture.cues.forEach((cue) => {
                ensureGroupCueAssignments(cue);
                (cue.groupAssignments || []).forEach((entry) => {
                    const key = `${entry.fixtureId}:${entry.cueId}`;
                    if (seenAssign.has(key)) return;
                    seenAssign.add(key);
                    mergedAssignments.push({ fixtureId: entry.fixtureId, cueId: entry.cueId });
                });
            });
            const sceneCueId = Number.isFinite(parseInt(fixture?.cues?.[0]?.id, 10)) ? parseInt(fixture.cues[0].id, 10) : 1;
            fixture.cues = [{
                id: sceneCueId,
                name: (fixture.name || `Scene ${fixture.id}`).toString(),
                channels: [],
                effects: normalizeLightingEffectsData(null),
                groupAssignments: mergedAssignments,
                sceneTimeline: preservedSceneTimeline
            }];
            fixture.groupMembers = Array.from(validMemberSet.values());
        }
    });
    migrateLegacyLightingCues(rawConfig, fixtures);
    return { fixtures, presets };
}

function normalizeRoomScriptingConfigData(rawConfig) {
    const source = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
    const rawRules = Array.isArray(source.rules) ? source.rules : [];
    let maxId = 0;
    const rules = rawRules.map((rawRule, idx) => {
        const idParsed = parseInt(rawRule?.id, 10);
        const id = Number.isFinite(idParsed) && idParsed > 0 ? idParsed : (idx + 1);
        maxId = Math.max(maxId, id);
        const triggerType = String(rawRule?.triggerType || "room_reset");
        const triggerValue = String(rawRule?.triggerValue || "");
        const triggerField = String(rawRule?.triggerField || "");
        const triggerExpected = String(rawRule?.triggerExpected || "");
        const conditionType = String(rawRule?.conditionType || "none");
        const conditionVar = String(rawRule?.conditionVar || "");
        const conditionField = String(rawRule?.conditionField || "");
        const conditionOp = String(rawRule?.conditionOp || "eq");
        const conditionValue = String(rawRule?.conditionValue || "");
        const conditionExpr = (rawRule?.conditionExpr && typeof rawRule.conditionExpr === "object") ? rawRule.conditionExpr : null;
        const actionType = String(rawRule?.actionType || "play_cue");
        const actionValue = String(rawRule?.actionValue || "");
        const actionTargetPuzzle = String(rawRule?.actionTargetPuzzle || "");
        const actionSourceDevice = String(rawRule?.actionSourceDevice || "");
        const actionSourceField = String(rawRule?.actionSourceField || "");
        return {
            id,
            triggerType,
            triggerValue,
            triggerField,
            triggerExpected,
            conditionType,
            conditionVar,
            conditionField,
            conditionOp,
            conditionValue,
            conditionExpr,
            actionType,
            actionValue,
            actionTargetPuzzle,
            actionSourceDevice,
            actionSourceField
        };
    });
    const nextRaw = parseInt(source.nextRuleId, 10);
    const nextRuleId = Number.isFinite(nextRaw) && nextRaw > maxId ? nextRaw : (maxId + 1);
    const blocklyState = source.blocklyState && typeof source.blocklyState === "object"
        ? source.blocklyState
        : null;
    return { rules, nextRuleId, blocklyState };
}

function updateStatus(msg, color = "#fff") {
    if (statusDiv) { 
        statusDiv.textContent = msg; 
        statusDiv.style.color = color;
        statusDiv.style.borderColor = color;
    }
}

function saveGraphToBackend() {
    if(!currentRoomName) return; 
    graph.config = Object.assign({}, graph.config, {
        screens,
        lighting: {
            fixtures: lightingFixtures,
            presets: lightingPresets
        },
        roomScripting: roomScriptingConfig
    });
    updateStatus("Saving...", "#ffff00"); const json = graph.serialize();
    fetch('/api/room', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json) })
    .then(res => { if(!res.ok) throw new Error(); return res.json(); })
    .then(() => { updateStatus("Saved", "#fff"); setTimeout(() => updateStatus("Ready", "#fff"), 2000); })
    .catch(() => updateStatus("Offline", "#ff0000"));
}

let saveTimeout;
const autoSave = () => {
    if(!currentRoomName) return; 
    updateStatus("Change...", "#aaa"); clearTimeout(saveTimeout); saveTimeout = setTimeout(saveGraphToBackend, 1000);
};

function getPuzzleDisplayName(node, baseName) {
    if (!node) return baseName || "";
    const name = (baseName || node.properties?.Name || node.title || `Puzzle ${node.id}`).toString();
    return name;
}

// --- ROOM MANAGER UI ---
const modal = document.getElementById("room-manager-overlay");
const manageBtn = document.getElementById("manage-rooms-btn");
const roomListContainer = document.getElementById("room-list-container");
const currentRoomDisplay = document.getElementById("current-room-display");
const createInput = document.getElementById("new-room-input");
const createBtn = document.getElementById("create-room-action-btn");
const statusMsg = document.getElementById("modal-status-msg");

function showModal() { 
    if(modal) {
        modal.style.display = "flex"; 
        renderRoomList();
    }
}

function hideModal() { 
    if(!currentRoomName) {
        if(statusMsg) {
            statusMsg.textContent = "Please load a room first.";
            statusMsg.style.color = "#ff5555";
        }
        return; 
    }
    modal.style.display = "none"; 
}

if(manageBtn) manageBtn.addEventListener("click", showModal);

if(createBtn) createBtn.addEventListener("click", () => {
    const name = createInput.value.trim();
    if(!name) {
        createInput.classList.add("input-error");
        setTimeout(() => createInput.classList.remove("input-error"), 400);
        return;
    }
    fetch('/api/rooms/create', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ filename: name })
    }).then(r=>r.json()).then(res => {
        if(res.status === 'ok') {
            createInput.value = ""; 
            renderRoomList(); 
            if(statusMsg) {
                statusMsg.textContent = `Room '${name}' created. Select it to load.`;
                statusMsg.style.color = "#4caf50";
            }
        }
        else if(statusMsg) {
            statusMsg.textContent = res.error;
            statusMsg.style.color = "#ff5555";
        }
    });
});

function renderRoomList() {
    if(!roomListContainer) return;
    roomListContainer.innerHTML = "Loading...";
    
    fetch('/api/rooms/list').then(r=>r.json()).then(data => {
        roomListContainer.innerHTML = "";
        if(currentRoomDisplay) currentRoomDisplay.textContent = data.current ? data.current.replace(".json", "") : "No Room";
        
        if (!data.files || data.files.length === 0) {
            roomListContainer.innerHTML = "<div style='padding:10px; color:#aaa; text-align:center;'>No rooms found. Create one below.</div>";
        }
        
        if(data.files) {
            data.files.forEach(room => {
                const row = document.createElement("div");
                row.className = "room-list-item " + (room === data.current ? "active-room" : "");
                
                const input = document.createElement("input");
                input.type = "text";
                input.className = "room-name-input";
                input.value = room.replace(".json", ""); 
                
                input.addEventListener("change", () => {
                    const newName = input.value.trim();
                    if(newName && newName !== room.replace(".json", "")) {
                        fetch('/api/rooms/rename', {
                            method: 'POST', headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({ oldName: room, newName: newName })
                        }).then(r=>r.json()).then(res => {
                            if(res.status === 'ok') renderRoomList(); 
                            else { alert(res.error); input.value = room.replace(".json", ""); }
                        });
                    }
                });

                const loadBtn = document.createElement("button");
                loadBtn.className = "room-action-btn btn-load";
                loadBtn.textContent = "Load";
                loadBtn.addEventListener("click", () => {
                    fetch('/api/rooms/load', {
                        method: 'POST', headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ filename: room })
                    }).then(r=>r.json()).then(res => {
                        if(res.status === 'ok') window.location.reload();
                    });
                });

                const delBtn = document.createElement("button");
                delBtn.className = "room-action-btn btn-delete";
                delBtn.textContent = "Delete";
                delBtn.addEventListener("click", () => {
                    if(confirm(`Delete room '${room}' permanently?`)) {
                        fetch('/api/rooms/delete', {
                            method: 'POST', headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({ filename: room })
                        }).then(r=>r.json()).then(res => {
                            if(res.status === 'ok') {
                                if(room === data.current) {
                                    currentRoomName = null;
                                    currentRoomDisplay.textContent = "No Room Loaded";
                                    updateStatus("No Room", "#aaa");
                                    graph.clear();
                                    renderRoomList(); 
                                } else {
                                    renderRoomList();
                                }
                            }
                        });
                    }
                });

                row.appendChild(input);
                row.appendChild(loadBtn);
                row.appendChild(delBtn);
                roomListContainer.appendChild(row);
            });
        }
    }).catch(e => {
        roomListContainer.innerHTML = "<div style='color:red'>Connection Error</div>";
    });
}

// ... NODE DEFINITIONS ...
function StartNode() { 
    this.addOutput("Start Flow", LiteGraph.ACTION); 
    this.title = "Start"; 
    this.color = "#2C3E50"; 
    this.bgcolor = "#34495E"; 
    this.properties = { pairId: null };
    this.removable = false; 
    this.clonable = false; 
    this.block_delete = true; 
}
StartNode.title = "Start"; 
StartNode.prototype.onConfigure = function() { 
    const hasPair = Number(this?.properties?.pairId) > 0;
    this.removable = !!hasPair;
    this.clonable = !!hasPair;
    this.block_delete = !hasPair;
}; 
StartNode.prototype.onDrawTitleText = function(ctx, title_height, size, scale, font, selected) {
    const pairId = Number(this?.properties?.pairId);
    if (!(pairId > 0)) return;
    if (getBranchCount() <= 1) return;
    ctx.save();
    ctx.font = font;
    ctx.textAlign = "right";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = selected ? LiteGraph.NODE_SELECTED_TITLE_COLOR : (this.constructor.title_text_color || (canvas && canvas.node_title_color) || "#999");
    ctx.fillText(String(pairId), (size ? size[0] : 140) - 8, LiteGraph.NODE_TITLE_TEXT_Y - title_height);
    ctx.restore();
};
StartNode.prototype.onSelected = function() {
    selectBranchPairForNode(this);
};
LiteGraph.registerNodeType("escape/Start", StartNode);

function EndNode() { 
    this.addInput("Finish", LiteGraph.ACTION); 
    this.title = "End"; 
    this.color = "#7f3030"; 
    this.bgcolor = "#a44141"; 
    this.properties = { autoRestart:false, restartDelay:5, pairId: null }; 
    this.removable = false; 
    this.clonable = false; 
    this.block_delete = true; 
}
EndNode.title = "End"; 
EndNode.prototype.onConfigure = function() { 
    const hasPair = Number(this?.properties?.pairId) > 0;
    this.removable = !!hasPair;
    this.clonable = !!hasPair;
    this.block_delete = !hasPair;
    const finishIdx = this.findInputSlot("Finish");
    if (finishIdx !== -1 && this.inputs && this.inputs[finishIdx]) {
        this.inputs[finishIdx].multiple = true;
        this.inputs[finishIdx].nameLocked = true;
    }
}; 
EndNode.prototype.onDrawTitleText = function(ctx, title_height, size, scale, font, selected) {
    const pairId = Number(this?.properties?.pairId);
    if (!(pairId > 0)) return;
    if (getBranchCount() <= 1) return;
    ctx.save();
    ctx.font = font;
    ctx.textAlign = "right";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = selected ? LiteGraph.NODE_SELECTED_TITLE_COLOR : (this.constructor.title_text_color || (canvas && canvas.node_title_color) || "#999");
    ctx.fillText(String(pairId), (size ? size[0] : 140) - 8, LiteGraph.NODE_TITLE_TEXT_Y - title_height);
    ctx.restore();
};
EndNode.prototype.onSelected = function() {
    selectBranchPairForNode(this);
};
LiteGraph.registerNodeType("escape/End", EndNode);

// --- PUZZLE NODE ---
function truncateSlotLabel(name){
    if(!name) return "";
    const str = String(name);
    if(str === "Trigger") return str;
    return str.length > 6 ? `${str.slice(0,6)}..` : str;
}
function updateSlotLabels(node){
    if(!node) return;
    (node.inputs || []).forEach(slot => { if(slot) slot.label = truncateSlotLabel(slot.name); });
    (node.outputs || []).forEach(slot => { if(slot) slot.label = truncateSlotLabel(slot.name); });
}
function syncPuzzleTriggerInput(node){
    if(!node || node.type !== "escape/Puzzle") return;
    const triggerIndex = node.findInputSlot("Trigger");
    const hasTrigger = triggerIndex !== -1;
    if(node.properties?.isStartNode){
        if(hasTrigger) node.removeInput(triggerIndex);
    } else {
        if(!hasTrigger){
            node.addInput("Trigger", LiteGraph.ACTION);
            if(node.inputs && node.inputs.length > 1){
                const trigger = node.inputs.pop();
                node.inputs.unshift(trigger);
            }
        }
    }
    updateSlotLabels(node);
}
function puzzleHasScripting(node){
    if(!node || !node.properties) return false;
    const blockState = node.properties.scriptingBlocklyState;
    const topBlocks = blockState?.blocks?.blocks;
    if(Array.isArray(topBlocks) && topBlocks.length > 0) return true;
    const rules = Array.isArray(node.properties.scriptingRules)
        ? node.properties.scriptingRules
        : (Array.isArray(node.properties.automationRules) ? node.properties.automationRules : []);
    return rules.length > 0;
}
function PuzzleNode() { 
    this.addInput("Trigger", LiteGraph.ACTION); 
    this.addOutput("Done", LiteGraph.ACTION); 
    this.properties={Name:"New Puzzle", selectedDeviceID:"", isStartNode:false, isAnalog: false, externalCheck: false, externalScreenId:"", externalCheckVariable:"", externalShowAssignment:true, hintEnabled:false, hintScreenId:"", hints: [], manualHintTrigger:false, automaticHintTrigger:true, showHintAssignment:true, scriptingRules: [], scriptingNextRuleId: 1, scriptingBlocklyState: null}; 
    this.title="Puzzle"; 
    this.size = [LiteGraph.NODE_WIDTH, this.size ? this.size[1] : 60];
    updateSlotLabels(this);
}
PuzzleNode.title="Puzzle"; 
PuzzleNode.prototype.computeSize = function(out){
    const size = LGraphNode.prototype.computeSize.call(this, out);
    size[0] = LiteGraph.NODE_WIDTH;
    return size;
};

// Manage optional external slot cleanup (keine neuen Outputs mehr anlegen)
PuzzleNode.prototype.updateSlots = function() {
    const slotName = "External Check";
    const slotIndex = this.findOutputSlot(slotName);

    if (!this.properties.externalCheck && slotIndex !== -1) {
        this.removeOutput(slotIndex);
    }
    updateSlotLabels(this);
};

PuzzleNode.prototype.onConfigure = function() {
    this.updateSlots(); // Slots wiederherstellen beim Laden
    syncPuzzleTriggerInput(this);
    ensureScriptingRules(this);
    if(this.properties?.isAnalog){
        removeNonActionInputsForAnalog(this);
    }
    if (this.size && this.size.length) {
        this.size[0] = LiteGraph.NODE_WIDTH;
    }
};

// Custom Draw fÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¼r Rahmen
PuzzleNode.prototype.onDrawBackground = function(ctx) {
    if(this.borderColor) {
        ctx.lineWidth = 3; 
        ctx.strokeStyle = this.borderColor;
        ctx.beginPath();
        if(ctx.roundRect) {
             ctx.roundRect(0, 0, this.size[0], this.size[1], 4);
        } else {
             ctx.rect(0, 0, this.size[0], this.size[1]);
        }
        ctx.stroke();
    }
};
LiteGraph.registerNodeType("escape/Puzzle", PuzzleNode);

// --- TABLET NODE (NEU) ---
function TabletNode() {
    this.addInput("Enable", LiteGraph.EVENT);
    this.addOutput("Success", LiteGraph.ACTION);
    this.addOutput("Fail", LiteGraph.ACTION);
    this.properties = {
        code: "1234",
        message: "Enter Code..."
    };
    this.title = "Tablet Input";
    this.color = "#2a363b";
    this.bgcolor = "#3f5159";
}
TabletNode.title = "Tablet Input";
LiteGraph.registerNodeType("escape/Tablet", TabletNode);


function LogicNode() { this.properties={logicType:"AND"}; this.addOutput("Done",LiteGraph.ACTION); this.addInput("Trigger",LiteGraph.ACTION,{nameLocked:true,multiple:true}); this.title="AND"; this.color="#4E342E"; this.bgcolor="#6D4C41"; updateSlotLabels(this); }
LogicNode.title="Logic";
LogicNode.prototype.onPropertyChanged = function(n,v){ if(n==="logicType"){this.properties.logicType=v; this.title=v;} };
LogicNode.prototype.onConfigure = function() { normalizeLogicNodeInputs(this); };
LiteGraph.registerNodeType("escape/Logic", LogicNode);

function isActionType(t){ return t===LiteGraph.ACTION || t===LiteGraph.EVENT || t==="action" || t==="event" || t===-1; }
function isQueueLogic(node){ return node && node.type === "escape/Logic" && node.properties?.logicType === "QUEUE"; }
function removeNonActionInputsForAnalog(node){
    if(!node || !Array.isArray(node.inputs)) return;
    for(let i = node.inputs.length - 1; i >= 0; i -= 1){
        const inp = node.inputs[i];
        if(!inp || isActionType(inp.type)) continue;
        const name = inp.name;
        node.removeInput(i);
        if(name) deleteInputFallbackEntry(node, name);
    }
    updateSlotLabels(node);
}
function getQueueGroupInputs(node){
    return (node.inputs || []).filter(inp => inp && !isActionType(inp.type));
}
function syncQueueGroupOutputs(node){
    if(!isQueueLogic(node)) return;
    node.outputs = node.outputs || [];
    let actionIdx = node.outputs.findIndex(o => o && isActionType(o.type));
    if(actionIdx === -1){
        node.addOutput("Done", LiteGraph.ACTION, { nameLocked:true, queueAction:true });
        actionIdx = node.outputs.length - 1;
    } else {
        node.outputs[actionIdx].name = "Done";
        node.outputs[actionIdx].type = LiteGraph.ACTION;
        node.outputs[actionIdx].queueAction = true;
    }
    const groupInputs = getQueueGroupInputs(node);
    const groupOutputIndices = node.outputs
        .map((o, idx) => ({ o, idx }))
        .filter(item => item.idx !== actionIdx && item.o && !isActionType(item.o.type))
        .map(item => item.idx);
    groupInputs.forEach((inp, idx) => {
        if (idx < groupOutputIndices.length) {
            const out = node.outputs[groupOutputIndices[idx]];
            out.name = inp.name;
            out.type = inp.type;
            out.queueGroup = true;
        } else {
            node.addOutput(inp.name || `Group ${idx + 1}`, inp.type, { queueGroup:true });
        }
    });
    for(let i = groupOutputIndices.length - 1; i >= groupInputs.length; i -= 1){
        node.removeOutput(groupOutputIndices[i]);
    }
    node.setDirtyCanvas(true, true);
}
function ensureQueueInputs(node){
    if(!isQueueLogic(node)) return;
    const links = node.graph ? node.graph.links : (graph && graph.links);
    node.inputs = node.inputs || [];
    const triggerInputs = node.inputs.filter(inp => inp && isActionType(inp.type));
    if(!triggerInputs.length){
        node.addInput("Trigger", LiteGraph.ACTION, { nameLocked:true, queueTrigger:true, multiple:true });
    }
    node.inputs.forEach(inp => {
        if(!inp) return;
        if(isActionType(inp.type)){
            inp.name = "Trigger";
            inp.type = LiteGraph.ACTION;
            inp.nameLocked = true;
            inp.multiple = true;
        } else {
            inp.multiple = true;
        }
    });
    const mainIndex = node.inputs.findIndex(s => s && isActionType(s.type));
    const mainInput = mainIndex >= 0 ? node.inputs[mainIndex] : null;
    const mainLinks = [];
    if (mainInput) {
        if (Array.isArray(mainInput.links)) mainLinks.push(...mainInput.links);
        else if (mainInput.link != null) mainLinks.push(mainInput.link);
    }
    for(let i = node.inputs.length - 1; i >= 0; i -= 1){
        const inp = node.inputs[i];
        if(inp && isActionType(inp.type) && i !== mainIndex){
            const extraLinks = [];
            if (Array.isArray(inp.links)) extraLinks.push(...inp.links);
            else if (inp.link != null) extraLinks.push(inp.link);
            inp.link = null;
            inp.links = null;
            extraLinks.forEach(id => {
                if (!links || !links[id]) return;
                links[id].target_slot = mainIndex;
                if (!mainLinks.includes(id)) mainLinks.push(id);
            });
            node.removeInput(i);
        }
    }
    if (mainInput) {
        mainInput.links = mainLinks.length ? mainLinks : null;
        mainInput.link = mainLinks.length ? mainLinks[0] : null;
    }
    syncQueueGroupOutputs(node);
    updateSlotLabels(node);
}
function normalizeLogicNodeInputs(node){
    if(!node || node.type!=="escape/Logic") return;
    const logicType = (node.properties?.logicType || "AND").toUpperCase();
    if(logicType === "QUEUE"){
        ensureQueueInputs(node);
        return;
    }
    node.inputs = (node.inputs || []).filter(inp => inp && isActionType(inp.type));
    node.outputs = (node.outputs || []).filter(out => out && isActionType(out.type));
    ensureLogicInputs(node);
}


// --- UI LOGIK ---

const puzzleList=document.getElementById("puzzle-list"), screenList=document.getElementById("screen-list"), propertiesSidebar=document.getElementById("properties-sidebar"), ioControlsContainer=document.getElementById('properties-form'), logWindow=document.getElementById("log-window"), logContent=document.getElementById("log-content");
const toggleLogBtn = document.getElementById("toggle-log-btn");
const clearLogBtn = document.getElementById("clear-log-btn");
const centerFlowBtn = document.getElementById("center-flow-btn");

function updateCenterFlowButtonPosition() {
    if (!centerFlowBtn || !logWindow) return;
    const logHeight = logWindow.classList.contains("expanded") ? 200 : 30;
    centerFlowBtn.style.bottom = `${logHeight + 10}px`;
    centerFlowBtn.style.right = logWindow.classList.contains("sidebar-open") ? "332px" : "12px";
}

toggleLogBtn?.addEventListener("click", e=>{
    if(logWindow.classList.contains("minimized")){
        logWindow.classList.remove("minimized");
        logWindow.classList.add("expanded");
        e.target.textContent="\u25BC";
    } else {
        logWindow.classList.add("minimized");
        logWindow.classList.remove("expanded");
        e.target.textContent="\u25B2";
    }
    updateCenterFlowButtonPosition();
});
if (toggleLogBtn) toggleLogBtn.textContent = logWindow?.classList.contains("minimized") ? "\u25B2" : "\u25BC";
updateCenterFlowButtonPosition();
window.addEventListener("resize", updateCenterFlowButtonPosition);
let editorLogs = [];
const logFiltersState = { heartbeat: true, mqtt: true, dmx: true, zigbee: true, error: true, system: true };

function categorizeLog(entry) {
    const msg = (entry?.msg || '').toLowerCase();
    const type = (entry?.type || '').toLowerCase();
    const topic = (entry?.meta?.topic || '').toLowerCase();
    if (type === 'error' || type === 'warn' || type === 'warning' || msg.includes('error') || msg.includes('warn')) return 'error';
    if (type === 'dmx' || msg.includes('dmx')) return 'dmx';
    if (type === 'zigbee') return 'zigbee';
    if (msg.includes('zigbee') || topic.startsWith('zigbee2mqtt/')) return 'zigbee';
    if (msg.includes('heartbeat')) return 'heartbeat';
    if (msg.includes('mqtt')) return 'mqtt';
    return 'system';
}

function renderEditorLogs() {
    if (!logContent) return;
    const filtered = editorLogs.filter(entry => {
        const cat = categorizeLog(entry);
        return logFiltersState[cat] !== false;
    });

    if (!filtered.length) {
        logContent.innerHTML = "<div style='color:#555; padding:5px; font-style:italic;'>No logs available (system idle...)</div>";
        return;
    }

    logContent.innerHTML = "";
    const frag = document.createDocumentFragment();
    filtered.forEach(log => {
        const div = document.createElement("div");
        div.className = `log-entry log-${log.type}`;
        let metaText = "";
        if (log?.meta && log.meta.payload) {
            try { metaText = " | " + JSON.stringify(log.meta.payload); } catch (e) {}
        }
        div.textContent = `[${log.timestamp}] ${log.msg}${metaText}`;
        frag.appendChild(div);
    });
    logContent.appendChild(frag);
}

function bindLogFilters() {
    document.querySelectorAll('#log-filters input[type="checkbox"]').forEach(cb => {
        const key = cb.value;
        if (key in logFiltersState) {
            logFiltersState[key] = cb.checked;
        }
        cb.addEventListener('change', () => {
            logFiltersState[key] = cb.checked;
            renderEditorLogs();
        });
    });
}
bindLogFilters();
clearLogBtn?.addEventListener("click", () => {
    fetch('/api/logs/clear', { method: 'POST' })
        .then(() => {
            editorLogs = [];
            renderEditorLogs();
        })
        .catch(() => {});
});

const lightingUI = {
    openBtn: document.getElementById("open-lighting-btn"),
    overlay: document.getElementById("lighting-modal-overlay"),
    closeBtn: document.getElementById("lighting-modal-close"),
    openPresetBtn: document.getElementById("lighting-open-preset-btn"),
    selectedFixtureTitle: document.getElementById("lighting-selected-fixture-title"),
    fixtureName: document.getElementById("lighting-fixture-name"),
    addFixtureBtn: document.getElementById("lighting-add-fixture-btn"),
    fixtureList: document.getElementById("lighting-fixture-list"),
    groupName: document.getElementById("lighting-group-name"),
    addGroupBtn: document.getElementById("lighting-add-group-btn"),
    groupList: document.getElementById("lighting-group-list"),
    sceneListNote: document.getElementById("lighting-scene-list-note"),
    cueName: document.getElementById("lighting-cue-name"),
    groupMemberSelect: document.getElementById("lighting-group-member-select"),
    addCueBtn: document.getElementById("lighting-add-cue-btn"),
    testCueBtn: document.getElementById("lighting-test-cue-btn"),
    cueList: document.getElementById("lighting-cue-list"),
    middleTopTitle: document.getElementById("lighting-middle-top-title"),
    middleBottomTitle: document.getElementById("lighting-middle-bottom-title"),
    middleTopPane: document.getElementById("lighting-middle-top-pane"),
    middleBottomPane: document.getElementById("lighting-middle-bottom-pane"),
    channelNumber: document.getElementById("lighting-channel-number"),
    groupCueName: document.getElementById("lighting-group-cue-name"),
    groupCueSourceSelect: document.getElementById("lighting-group-cue-source"),
    addChannelBtn: document.getElementById("lighting-add-channel-btn"),
    addDelayBtn: document.getElementById("lighting-add-delay-btn"),
    testSceneBtn: document.getElementById("lighting-test-scene-btn"),
    channelEditor: document.getElementById("lighting-channel-editor"),
    cueDetailsSection: document.getElementById("lighting-cue-details-section"),
    effectsSection: document.getElementById("lighting-effects-section"),
    sceneDelaySection: document.getElementById("lighting-scene-delay-section"),
    sceneDelayInput: document.getElementById("lighting-scene-delay-ms"),
    sceneDelayNote: document.getElementById("lighting-scene-delay-note"),
    groupAssignmentSection: document.getElementById("lighting-group-assignment-section"),
    groupAssignLamp: document.getElementById("lighting-group-assign-lamp"),
    groupAssignCue: document.getElementById("lighting-group-assign-cue"),
    groupAssignBtn: document.getElementById("lighting-group-assign-btn"),
    groupAssignmentList: document.getElementById("lighting-group-assignment-list"),
    cuePreview: document.getElementById("lighting-cue-preview"),
    effectDelay: document.getElementById("lighting-effect-delay"),
    effectFadeIn: document.getElementById("lighting-effect-fade-in"),
    effectFadeOut: document.getElementById("lighting-effect-fade-out"),
    effectDuration: document.getElementById("lighting-effect-duration"),
    effectsNote: document.getElementById("lighting-effects-note"),
    presetOverlay: document.getElementById("lighting-preset-overlay"),
    presetCloseBtn: document.getElementById("lighting-preset-close"),
    presetName: document.getElementById("lighting-preset-name"),
    addPresetBtn: document.getElementById("lighting-add-preset-btn"),
    presetList: document.getElementById("lighting-preset-list"),
    selectedPresetTitle: document.getElementById("lighting-selected-preset-title"),
    presetChannelName: document.getElementById("lighting-preset-channel-name"),
    presetChannelAddress: document.getElementById("lighting-preset-channel-address"),
    addPresetChannelBtn: document.getElementById("lighting-add-preset-channel-btn"),
    presetChannelList: document.getElementById("lighting-preset-channel-list")
};

const zigbeeUI = {
    openBtn: document.getElementById("open-zigbee-btn"),
    overlay: document.getElementById("zigbee-modal-overlay"),
    closeBtn: document.getElementById("zigbee-modal-close"),
    refreshBtn: document.getElementById("zigbee-refresh-btn"),
    discoveryToggleBtn: document.getElementById("zigbee-discovery-toggle-btn"),
    discoveryStatus: document.getElementById("zigbee-discovery-status"),
    bridgeBadge: document.getElementById("zigbee-bridge-badge"),
    list: document.getElementById("zigbee-device-list"),
    messageLog: document.getElementById("zigbee-message-log"),
    selectedDeviceName: document.getElementById("zigbee-selected-device-name"),
    deviceMessageList: document.getElementById("zigbee-device-message-list"),
    triggerNameInput: document.getElementById("zigbee-trigger-name-input"),
    triggerMessageSelect: document.getElementById("zigbee-trigger-message-select"),
    addTriggerBtn: document.getElementById("zigbee-add-trigger-btn"),
    deviceTriggerList: document.getElementById("zigbee-device-trigger-list")
};

const soundsUI = {
    openBtn: document.getElementById("open-sounds-btn"),
    overlay: document.getElementById("sounds-modal-overlay"),
    closeBtn: document.getElementById("sounds-modal-close"),
    addBtn: document.getElementById("sounds-add-btn"),
    fileInput: document.getElementById("sounds-file-input"),
    uploadStatus: document.getElementById("sounds-upload-status"),
    list: document.getElementById("sounds-file-list"),
    selectedName: document.getElementById("sounds-selected-name"),
    volumeSlider: document.getElementById("sounds-volume-slider"),
    volumeValue: document.getElementById("sounds-volume-value"),
    testBtn: document.getElementById("sounds-test-btn"),
    waveformWrap: document.getElementById("sounds-waveform-wrap"),
    waveformCanvas: document.getElementById("sounds-waveform-canvas"),
    waveformSelection: document.getElementById("sounds-waveform-selection"),
    trimStartHandle: document.getElementById("sounds-trim-start-handle"),
    trimEndHandle: document.getElementById("sounds-trim-end-handle"),
    trimRange: document.getElementById("sounds-trim-range"),
    waveformStatus: document.getElementById("sounds-waveform-status")
};

let selectedLightingFixtureId = null;
let selectedLightingCueId = null;
let selectedLightingGroupMemberId = null;
let selectedSceneTimelineIndex = null;
let selectedSceneEffectsCueRef = null;
let draggedLightingCueRef = null;
let draggedSceneMatrixCueRef = null;
let selectedLightingPresetId = null;
let lightingTestCueBusy = false;
let lightingTestActiveCueRef = null;
let lightingTestCueClearTimer = null;
let lightingSceneTestTimers = [];
let lightingSceneTestActiveSlotIndex = null;
let lightingSceneTestActiveCueKeys = new Set();
let lightingSceneTestActiveCueKeyCounts = new Map();
let soundsListCache = [];
let soundsUploadBusy = false;
let selectedSoundName = null;
const soundVolumeByName = new Map();
let soundsEditingName = null;
let soundsActiveAudio = null;
let soundsListLoadPromise = null;
let soundsPiTestActive = false;
let soundsLiveVolumeTimer = null;
let soundsAudioContext = null;
let soundsWaveformBuffer = null;
let soundsWaveformLoadToken = 0;
let soundsTrimSaveTimer = null;
let soundsTrimDragMode = null;

function formatSoundFileSize(size) {
    const num = Number(size);
    if (!Number.isFinite(num) || num < 0) return "-";
    if (num < 1024) return `${num} B`;
    if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
    return `${(num / (1024 * 1024)).toFixed(1)} MB`;
}

function clearLightingSceneTestPlayback() {
    (Array.isArray(lightingSceneTestTimers) ? lightingSceneTestTimers : []).forEach((id) => {
        try { clearTimeout(id); } catch (e) {}
    });
    lightingSceneTestTimers = [];
    lightingSceneTestActiveSlotIndex = null;
    lightingSceneTestActiveCueKeys = new Set();
    lightingSceneTestActiveCueKeyCounts = new Map();
}

function clearLightingCueTestHighlight() {
    if (lightingTestCueClearTimer) {
        try { clearTimeout(lightingTestCueClearTimer); } catch (e) {}
        lightingTestCueClearTimer = null;
    }
    lightingTestActiveCueRef = null;
}

function hasActiveLightingTestPlayback() {
    return !!(
        lightingTestCueBusy ||
        (Array.isArray(lightingSceneTestTimers) && lightingSceneTestTimers.length) ||
        (lightingSceneTestActiveCueKeys && lightingSceneTestActiveCueKeys.size) ||
        Number.isFinite(lightingSceneTestActiveSlotIndex) ||
        lightingTestActiveCueRef
    );
}

function stopLightingTestsImmediate() {
    if (!hasActiveLightingTestPlayback()) return;
    clearLightingSceneTestPlayback();
    clearLightingCueTestHighlight();
    lightingTestCueBusy = false;
    renderLightingTestCueButton();
    if (lightingUI.effectsNote) {
        lightingUI.effectsNote.textContent = "Test stopped.";
    }
    renderLightingModal();
    fetch('/api/runtime/dmx/cue/test/stop', { method: 'POST' }).catch(() => {});
}

function setLightingCueTestHighlight(fixtureId, cueId, durationMs, infinite = false) {
    clearLightingCueTestHighlight();
    const numericFixtureId = parseInt(fixtureId, 10);
    const numericCueId = parseInt(cueId, 10);
    if (!Number.isFinite(numericFixtureId) || !Number.isFinite(numericCueId)) return;
    lightingTestActiveCueRef = { fixtureId: numericFixtureId, cueId: numericCueId, infinite: !!infinite };
    if (!infinite) {
        const ms = Math.max(0, lightingClampInt(durationMs, 0, 600000, 0));
        lightingTestCueClearTimer = setTimeout(() => {
            lightingTestCueClearTimer = null;
            lightingTestActiveCueRef = null;
            renderLightingModal();
        }, ms + 120);
    }
}

function setLightingSceneTestCueActive(cueKey, active) {
    if (!cueKey) return;
    const next = new Map(lightingSceneTestActiveCueKeyCounts || []);
    const current = Number(next.get(cueKey) || 0);
    if (active) {
        next.set(cueKey, current + 1);
    } else if (current <= 1) {
        next.delete(cueKey);
    } else {
        next.set(cueKey, current - 1);
    }
    lightingSceneTestActiveCueKeyCounts = next;
    lightingSceneTestActiveCueKeys = new Set(Array.from(next.keys()));
}

function scheduleLightingSceneTestPlayback(fixture, sceneCue) {
    clearLightingSceneTestPlayback();
    if (!isLightingGroupFixture(fixture) || !sceneCue) return;
    const timeline = normalizeSceneTimeline(sceneCue);
    if (!Array.isArray(timeline) || !timeline.length) return;

    const estimateCueTiming = (fixtureId, cueId, visited = new Set()) => {
        const sourceFixture = getLightingFixtureById(parseInt(fixtureId, 10));
        const sourceCue = Array.isArray(sourceFixture?.cues)
            ? sourceFixture.cues.find((entry) => parseInt(entry?.id, 10) === parseInt(cueId, 10))
            : null;
        if (!sourceCue) return { startMs: 0, totalMs: 0, infinite: false };
        if (isLightingGroupFixture(sourceFixture)) {
            const key = `${parseInt(fixtureId, 10)}:${parseInt(cueId, 10)}`;
            if (visited.has(key)) return { startMs: 0, totalMs: 0, infinite: true };
            const nextVisited = new Set(visited);
            nextVisited.add(key);
            const nestedTimeline = normalizeSceneTimeline(sourceCue);
            let totalMs = 0;
            for (let slotIndex = 0; slotIndex < nestedTimeline.length; slotIndex += 1) {
                const slot = nestedTimeline[slotIndex];
                if (slot?.type === "delay") {
                    totalMs += lightingClampInt(slot?.ms, 0, 600000, 0);
                    continue;
                }
                const slotItems = Array.isArray(slot?.items) ? slot.items : [];
                let stepMs = 0;
                for (let itemIndex = 0; itemIndex < slotItems.length; itemIndex += 1) {
                    const nested = estimateCueTiming(slotItems[itemIndex]?.fixtureId, slotItems[itemIndex]?.cueId, nextVisited);
                    if (nested.infinite) return { startMs: 0, totalMs: 0, infinite: true };
                    stepMs = Math.max(stepMs, Math.max(0, nested.startMs + nested.totalMs));
                }
                totalMs += stepMs;
            }
            return { startMs: 0, totalMs, infinite: false };
        }
        ensureCueEffects(sourceCue);
        const de = lightingClampInt(sourceCue?.effects?.delayMs, 0, 600000, 0);
        const fi = lightingClampInt(sourceCue?.effects?.fadeInMs, 0, 600000, 0);
        const fo = lightingClampInt(sourceCue?.effects?.fadeOutMs, 0, 600000, 0);
        const du = lightingClampInt(sourceCue?.effects?.durationMs, 0, 600000, 0);
        if (du === 0) return { startMs: de, totalMs: 0, infinite: true }; // infinite
        return { startMs: de, totalMs: fi + du + fo, infinite: false };
    };

    let currentOffset = 0;
    let infiniteEncountered = false;
    timeline.forEach((slot, slotIndex) => {
        if (infiniteEncountered) return;
        if (slot?.type === "delay") {
            const ms = lightingClampInt(slot?.ms, 0, 600000, 0);
            const enterTimer = setTimeout(() => {
                lightingSceneTestActiveSlotIndex = slotIndex;
                lightingSceneTestActiveCueKeys = new Set();
                renderLightingModal();
            }, currentOffset);
            lightingSceneTestTimers.push(enterTimer);
            currentOffset += ms;
            return;
        }
        const items = Array.isArray(slot?.items) ? slot.items : [];
        const enterTimer = setTimeout(() => {
            lightingSceneTestActiveSlotIndex = slotIndex;
            renderLightingModal();
        }, currentOffset);
        lightingSceneTestTimers.push(enterTimer);
        let stepMs = 0;
        items.forEach((item, itemIndex) => {
            const cueKey = `${slotIndex}:${itemIndex}`;
            const timing = estimateCueTiming(item?.fixtureId, item?.cueId);
            const cueOnTimer = setTimeout(() => {
                setLightingSceneTestCueActive(cueKey, true);
                renderLightingModal();
            }, currentOffset + Math.max(0, timing.startMs));
            lightingSceneTestTimers.push(cueOnTimer);
            if (timing.infinite) {
                infiniteEncountered = true;
                return;
            }
            const cueOffTimer = setTimeout(() => {
                setLightingSceneTestCueActive(cueKey, false);
                renderLightingModal();
            }, currentOffset + Math.max(0, timing.startMs + timing.totalMs));
            lightingSceneTestTimers.push(cueOffTimer);
            stepMs = Math.max(stepMs, Math.max(0, timing.startMs + timing.totalMs));
        });
        if (!infiniteEncountered) currentOffset += stepMs;
    });

    if (!infiniteEncountered) {
        const clearAt = Math.max(0, currentOffset + 120);
        const clearTimer = setTimeout(() => {
            lightingSceneTestActiveSlotIndex = null;
            lightingSceneTestActiveCueKeys = new Set();
            lightingSceneTestActiveCueKeyCounts = new Map();
            renderLightingModal();
        }, clearAt);
        lightingSceneTestTimers.push(clearTimer);
    }
}

function formatSoundModifiedAt(value) {
    const ts = Number(value);
    if (!Number.isFinite(ts) || ts <= 0) return "";
    try {
        return new Date(ts).toLocaleString();
    } catch (err) {
        return "";
    }
}

function showSceneCycleBlockedNotice() {
    updateStatus("Cannot nest scene: cyclic reference detected.", "#ff9f43");
    if (lightingUI.sceneListNote) {
        lightingUI.sceneListNote.textContent = "Cannot nest scene: cyclic reference detected.";
        lightingUI.sceneListNote.style.color = "#ff9f43";
    }
    setTimeout(() => {
        if (lightingUI.sceneListNote && lightingUI.sceneListNote.textContent.includes("cyclic reference")) {
            lightingUI.sceneListNote.textContent = "";
            lightingUI.sceneListNote.style.color = "";
        }
    }, 2400);
    setTimeout(() => updateStatus("Ready", "#fff"), 2400);
}

function getSelectedSoundEntry() {
    if (!selectedSoundName) return null;
    return soundsListCache.find((entry) => entry.name === selectedSoundName) || null;
}

function getSoundVolumePercent(name) {
    const key = String(name || "");
    const existing = Number(soundVolumeByName.get(key));
    if (Number.isFinite(existing)) return Math.max(0, Math.min(100, existing));
    return 50;
}

function getSoundVolumeNormalized(name) {
    return getSoundVolumePercent(name) / 100;
}

function normalizeSoundTrim(trim, durationMs = 0) {
    const duration = Math.max(0, Math.floor(Number(durationMs || trim?.durationMs) || 0));
    let startMs = Math.max(0, Math.floor(Number(trim?.startMs) || 0));
    let endMs = Math.max(0, Math.floor(Number(trim?.endMs) || 0));
    if (duration > 0) {
        startMs = Math.min(startMs, duration);
        endMs = endMs > 0 ? Math.min(endMs, duration) : duration;
    }
    if (endMs > 0 && endMs < startMs) endMs = startMs;
    return { startMs, endMs, durationMs: duration };
}

function getSelectedSoundTrim() {
    const selected = getSelectedSoundEntry();
    if (!selected) return { startMs: 0, endMs: 0, durationMs: 0 };
    return normalizeSoundTrim(selected.trim || {}, selected.trim?.durationMs || 0);
}

function setSelectedSoundTrim(trim) {
    const selected = getSelectedSoundEntry();
    if (!selected) return null;
    selected.trim = normalizeSoundTrim(trim, trim?.durationMs || selected.trim?.durationMs || 0);
    return selected.trim;
}

function formatSoundTime(ms) {
    const seconds = Math.max(0, Number(ms) || 0) / 1000;
    return `${seconds.toFixed(3)}s`;
}

function getSoundsAudioContext() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    if (!soundsAudioContext) soundsAudioContext = new AudioCtx();
    return soundsAudioContext;
}

function updateSoundTrimOverlay() {
    const trim = getSelectedSoundTrim();
    const duration = Math.max(0, Number(trim.durationMs) || 0);
    const startPct = duration > 0 ? Math.max(0, Math.min(100, (trim.startMs / duration) * 100)) : 0;
    const endPct = duration > 0 ? Math.max(startPct, Math.min(100, ((trim.endMs || duration) / duration) * 100)) : 100;
    if (soundsUI.waveformSelection) {
        soundsUI.waveformSelection.style.left = `${startPct}%`;
        soundsUI.waveformSelection.style.width = `${Math.max(0, endPct - startPct)}%`;
    }
    if (soundsUI.trimStartHandle) soundsUI.trimStartHandle.style.left = `${startPct}%`;
    if (soundsUI.trimEndHandle) soundsUI.trimEndHandle.style.left = `${endPct}%`;
    if (soundsUI.trimRange) {
        soundsUI.trimRange.textContent = duration > 0
            ? `${formatSoundTime(trim.startMs)} - ${formatSoundTime(trim.endMs || duration)}`
            : "0.000s - 0.000s";
    }
    if (soundsUI.waveformWrap) soundsUI.waveformWrap.classList.toggle("disabled", duration <= 0);
}

function drawSoundWaveform(buffer) {
    const canvas = soundsUI.waveformCanvas;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width || canvas.width || 640));
    const height = Math.max(1, Math.floor(rect.height || canvas.height || 128));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, width, height);
    if (!buffer) {
        ctx.strokeStyle = "#2c2c2c";
        ctx.beginPath();
        ctx.moveTo(0, height / 2);
        ctx.lineTo(width, height / 2);
        ctx.stroke();
        updateSoundTrimOverlay();
        return;
    }
    const channels = Math.max(1, buffer.numberOfChannels || 1);
    const samples = buffer.getChannelData(0);
    const step = Math.max(1, Math.floor(samples.length / width));
    const amp = height / 2;
    ctx.strokeStyle = "#6ea0ff";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x < width; x += 1) {
        let min = 1;
        let max = -1;
        const start = x * step;
        const end = Math.min(samples.length, start + step);
        for (let i = start; i < end; i += 1) {
            let value = 0;
            for (let c = 0; c < channels; c += 1) {
                value += buffer.getChannelData(c)[i] || 0;
            }
            value /= channels;
            if (value < min) min = value;
            if (value > max) max = value;
        }
        ctx.moveTo(x + 0.5, (1 + min) * amp);
        ctx.lineTo(x + 0.5, (1 + max) * amp);
    }
    ctx.stroke();
    updateSoundTrimOverlay();
}

async function loadSelectedSoundWaveform() {
    const selected = getSelectedSoundEntry();
    const token = ++soundsWaveformLoadToken;
    soundsWaveformBuffer = null;
    drawSoundWaveform(null);
    if (!selected?.path) {
        if (soundsUI.waveformStatus) soundsUI.waveformStatus.textContent = "Select a sound to edit its active range.";
        return;
    }
    const ctx = getSoundsAudioContext();
    if (!ctx) {
        if (soundsUI.waveformStatus) soundsUI.waveformStatus.textContent = "Waveform is not supported in this browser.";
        return;
    }
    if (soundsUI.waveformStatus) soundsUI.waveformStatus.textContent = "Loading waveform...";
    try {
        const res = await fetch(selected.path, { cache: "no-store" });
        const data = await res.arrayBuffer();
        const buffer = await ctx.decodeAudioData(data.slice(0));
        if (token !== soundsWaveformLoadToken) return;
        soundsWaveformBuffer = buffer;
        const durationMs = Math.max(1, Math.round((buffer.duration || 0) * 1000));
        selected.trim = normalizeSoundTrim(selected.trim || {}, durationMs);
        drawSoundWaveform(buffer);
        if (soundsUI.waveformStatus) soundsUI.waveformStatus.textContent = "Drag start or end to define the active sound range.";
        scheduleSoundTrimSave();
    } catch (err) {
        if (token !== soundsWaveformLoadToken) return;
        drawSoundWaveform(null);
        if (soundsUI.waveformStatus) soundsUI.waveformStatus.textContent = "Could not load waveform for this file.";
    }
}

function setSoundTrimFromPointer(event, mode) {
    const selected = getSelectedSoundEntry();
    const wrap = soundsUI.waveformWrap;
    if (!selected || !wrap) return;
    const duration = Math.max(0, Number(selected.trim?.durationMs) || 0);
    if (duration <= 0) return;
    const rect = wrap.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, ((event.clientX || 0) - rect.left) / Math.max(1, rect.width)));
    const value = Math.round(ratio * duration);
    const current = normalizeSoundTrim(selected.trim || {}, duration);
    if (mode === "start") {
        current.startMs = Math.min(value, current.endMs || duration);
    } else {
        current.endMs = Math.max(value, current.startMs);
    }
    selected.trim = normalizeSoundTrim(current, duration);
    updateSoundTrimOverlay();
    scheduleSoundTrimSave();
}

function scheduleSoundTrimSave() {
    if (soundsTrimSaveTimer) clearTimeout(soundsTrimSaveTimer);
    soundsTrimSaveTimer = setTimeout(async () => {
        soundsTrimSaveTimer = null;
        const selected = getSelectedSoundEntry();
        if (!selected?.name) return;
        const trim = normalizeSoundTrim(selected.trim || {}, selected.trim?.durationMs || 0);
        try {
            const res = await fetch(`/api/sounds/trim?name=${encodeURIComponent(selected.name)}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(trim)
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.success === false) throw new Error(data.error || "Could not save trim");
            selected.trim = normalizeSoundTrim(data.trim || trim, trim.durationMs);
        } catch (err) {
            setSoundsUploadStatus(err?.message || "Could not save sound trim.", true);
        }
    }, 250);
}

function stopSoundPreview() {
    if (!soundsActiveAudio) return;
    try {
        soundsActiveAudio.pause();
        soundsActiveAudio.currentTime = 0;
    } catch (err) {}
    soundsActiveAudio = null;
}

function setSelectedSound(name, options = {}) {
    const rerenderList = options.rerenderList !== false;
    const loadWaveform = options.loadWaveform !== false;
    selectedSoundName = name ? String(name) : null;
    if (rerenderList) {
        renderSoundsList();
    } else if (soundsUI.list) {
        const items = soundsUI.list.querySelectorAll(".sounds-file-item");
        items.forEach((item) => {
            const itemName = String(item.dataset?.soundName || "");
            item.classList.toggle("selected", !!selectedSoundName && itemName === selectedSoundName);
        });
    }
    renderSoundDetails();
    if (loadWaveform) loadSelectedSoundWaveform();
}

function renderSoundDetails() {
    const selected = getSelectedSoundEntry();
    if (soundsUI.selectedName) soundsUI.selectedName.textContent = selected ? selected.name : "No sound selected";
    if (soundsUI.volumeSlider) {
        const volume = selected ? getSoundVolumePercent(selected.name) : 100;
        soundsUI.volumeSlider.value = String(volume);
        soundsUI.volumeSlider.disabled = !selected;
    }
    if (soundsUI.volumeValue) {
        const volume = selected ? getSoundVolumePercent(selected.name) : 100;
        soundsUI.volumeValue.textContent = `${volume}%`;
    }
    if (soundsUI.testBtn) soundsUI.testBtn.disabled = !selected;
    updateSoundTrimOverlay();
}

function setSoundsUploadStatus(message, isError = false) {
    if (!soundsUI.uploadStatus) return;
    soundsUI.uploadStatus.textContent = message || "";
    soundsUI.uploadStatus.style.color = isError ? "#ff6b6b" : "#9aa6b5";
}

async function deleteSoundByName(name) {
    const rawName = String(name || "").trim();
    if (!rawName) return false;
    const query = encodeURIComponent(rawName);
    const res = await fetch(`/api/sounds/delete?name=${query}`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) throw new Error(data.error || `Could not delete ${rawName}`);
    return true;
}

async function renameSound(oldName, newName) {
    const from = String(oldName || "").trim();
    const to = String(newName || "").trim();
    if (!from || !to) throw new Error("Invalid sound name");
    if (from === to) return from;
    const queryOld = encodeURIComponent(from);
    const queryNew = encodeURIComponent(to);
    const res = await fetch(`/api/sounds/rename?oldName=${queryOld}&newName=${queryNew}`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) throw new Error(data.error || `Could not rename ${from}`);
    return String(data.name || to);
}

async function testSelectedSound() {
    const selected = getSelectedSoundEntry();
    if (!selected?.name) return;
    const queryName = encodeURIComponent(selected.name);
    const volume = getSoundVolumePercent(selected.name);
    const trim = normalizeSoundTrim(selected.trim || {}, selected.trim?.durationMs || 0);
    const url = `/api/sounds/test?name=${queryName}&volume=${volume}&startMs=${trim.startMs}&endMs=${trim.endMs}&durationMs=${trim.durationMs}`;
    try {
        const res = await fetch(url, { method: "POST" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.success === false) {
            throw new Error(data.error || "Could not play sound");
        }
        soundsPiTestActive = true;
        setSoundsUploadStatus(`Playing ${selected.name} on Pi`);
    } catch (err) {
        soundsPiTestActive = false;
        setSoundsUploadStatus(err?.message || "Could not play sound", true);
    }
}

function scheduleLiveSoundVolumeUpdate() {
    if (!soundsPiTestActive) return;
    if (soundsLiveVolumeTimer) clearTimeout(soundsLiveVolumeTimer);
    soundsLiveVolumeTimer = setTimeout(() => {
        soundsLiveVolumeTimer = null;
        testSelectedSound();
    }, 120);
}

async function deleteSelectedSound() {
    const selected = getSelectedSoundEntry();
    if (!selected) return false;
    await deleteSoundByName(selected.name);
    soundVolumeByName.delete(selected.name);
    if (selectedSoundName === selected.name) selectedSoundName = null;
    stopSoundPreview();
    await loadSoundsList({ silent: true });
    setSoundsUploadStatus(`Deleted ${selected.name}`);
    return true;
}

function renderSoundsList() {
    if (!soundsUI.list) return;
    const files = Array.isArray(soundsListCache) ? soundsListCache : [];
    soundsUI.list.innerHTML = "";

    if (!files.length) {
        const empty = document.createElement("li");
        empty.className = "sounds-empty";
        empty.textContent = "No sounds uploaded yet.";
        soundsUI.list.appendChild(empty);
        return;
    }

    const fragment = document.createDocumentFragment();
    files.forEach((sound) => {
        const item = document.createElement("li");
        item.className = "sounds-file-item";
        item.tabIndex = 0;
        item.dataset.soundName = String(sound?.name || "");
        if (selectedSoundName === sound.name) item.classList.add("selected");

        const main = document.createElement("div");
        main.className = "sounds-file-main";

        const name = document.createElement("div");
        name.className = "sounds-file-name";
        name.textContent = String(sound?.name || "Unnamed");
        name.title = name.textContent;
        main.appendChild(name);

        const meta = document.createElement("div");
        meta.className = "sounds-file-meta";
        const sizeText = formatSoundFileSize(sound?.size);
        const dateText = formatSoundModifiedAt(sound?.modifiedAt);
        meta.textContent = dateText ? `${sizeText} • ${dateText}` : sizeText;
        main.appendChild(meta);

        const actions = document.createElement("div");
        actions.className = "sounds-file-actions";
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "sounds-delete-btn";
        delBtn.title = "Delete sound";
        delBtn.textContent = "X";
        delBtn.addEventListener("click", async (event) => {
            event.preventDefault();
            event.stopPropagation();
            try {
                await deleteSoundByName(sound.name);
                soundVolumeByName.delete(sound.name);
                if (selectedSoundName === sound.name) selectedSoundName = null;
                stopSoundPreview();
                await loadSoundsList({ silent: true });
                setSoundsUploadStatus(`Deleted ${sound.name}`);
            } catch (err) {
                setSoundsUploadStatus(err?.message || "Could not delete sound.", true);
            }
        });
        actions.appendChild(delBtn);

        item.addEventListener("click", () => {
            if (soundsEditingName) return;
            setSelectedSound(sound.name, { rerenderList: false });
        });
        item.addEventListener("keydown", async (event) => {
            if (event.key !== "Delete") return;
            event.preventDefault();
            event.stopPropagation();
            try {
                await deleteSoundByName(sound.name);
                soundVolumeByName.delete(sound.name);
                if (selectedSoundName === sound.name) selectedSoundName = null;
                stopSoundPreview();
                await loadSoundsList({ silent: true });
                setSoundsUploadStatus(`Deleted ${sound.name}`);
            } catch (err) {
                setSoundsUploadStatus(err?.message || "Could not delete sound.", true);
            }
        });
        const startRenameSound = () => {
            if (soundsEditingName) return;
            soundsEditingName = sound.name;
            const currentName = sound.name;
            name.setAttribute("contenteditable", "true");
            name.spellcheck = false;
            name.focus();
            const range = document.createRange();
            range.selectNodeContents(name);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);

            const finishRename = async () => {
                name.removeAttribute("contenteditable");
                soundsEditingName = null;
                const nextName = String(name.textContent || "").trim();
                if (!nextName || nextName === currentName) {
                    name.textContent = currentName;
                    return;
                }
                try {
                    const renamed = await renameSound(currentName, nextName);
                    if (selectedSoundName === currentName) selectedSoundName = renamed;
                    const oldVolume = getSoundVolumePercent(currentName);
                    const oldTrim = normalizeSoundTrim(sound.trim || {}, sound.trim?.durationMs || 0);
                    soundVolumeByName.delete(currentName);
                    soundVolumeByName.set(renamed, oldVolume);
                    await loadSoundsList({ silent: true });
                    const renamedEntry = soundsListCache.find((entry) => entry.name === renamed);
                    if (renamedEntry && oldTrim.durationMs) renamedEntry.trim = oldTrim;
                    setSoundsUploadStatus(`Renamed to ${renamed}`);
                } catch (err) {
                    name.textContent = currentName;
                    setSoundsUploadStatus(err?.message || "Could not rename sound.", true);
                }
            };

            const keyHandler = (event) => {
                if (event.key === "Enter") {
                    event.preventDefault();
                    name.blur();
                } else if (event.key === "Escape") {
                    event.preventDefault();
                    name.textContent = currentName;
                    name.blur();
                }
            };
            name.addEventListener("keydown", keyHandler);
            name.addEventListener("blur", () => {
                name.removeEventListener("keydown", keyHandler);
                finishRename();
            }, { once: true });
        };
        const onDoubleClickRename = (event) => {
            if (event && event.button !== undefined && event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            setSelectedSound(sound.name, { rerenderList: false });
            startRenameSound();
        };
        name.addEventListener("dblclick", onDoubleClickRename);

        item.appendChild(main);
        item.appendChild(actions);
        fragment.appendChild(item);
    });
    soundsUI.list.appendChild(fragment);
}

async function loadSoundsList(options = {}) {
    if (soundsListLoadPromise) return soundsListLoadPromise;
    soundsListLoadPromise = (async () => {
    const silent = !!options.silent;
    try {
        const res = await fetch("/api/sounds/list", { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.success === false) {
            throw new Error(data.error || "Could not load sounds");
        }
        const sounds = Array.isArray(data.sounds) ? data.sounds : [];
        soundsListCache = sounds
            .map((entry) => ({
                name: String(entry?.name || "").trim(),
                size: Number(entry?.size || 0),
                modifiedAt: Number(entry?.modifiedAt || 0),
                path: String(entry?.path || ""),
                trim: normalizeSoundTrim(entry?.trim || {}, entry?.trim?.durationMs || 0)
            }))
            .filter((entry) => entry.name)
            .sort((a, b) => {
                const ta = Number(a.modifiedAt || 0);
                const tb = Number(b.modifiedAt || 0);
                if (tb !== ta) return tb - ta;
                return a.name.localeCompare(b.name);
            });

        if (selectedSoundName && !soundsListCache.some((entry) => entry.name === selectedSoundName)) {
            selectedSoundName = soundsListCache[0]?.name || null;
        }
        if (!selectedSoundName && soundsListCache.length) {
            selectedSoundName = soundsListCache[0].name;
        }

        renderSoundsList();
        renderSoundDetails();
        loadSelectedSoundWaveform();
        if (!silent) {
            const count = soundsListCache.length;
            setSoundsUploadStatus(count ? `${count} sound${count === 1 ? "" : "s"} loaded.` : "No sounds uploaded yet.");
        }
    } catch (err) {
        if (!silent) setSoundsUploadStatus(err?.message || "Could not load sounds.", true);
        renderSoundsList();
        renderSoundDetails();
    } finally {
        soundsListLoadPromise = null;
    }
    })();
    return soundsListLoadPromise;
}

async function ensureSoundsCacheReady() {
    if (Array.isArray(soundsListCache) && soundsListCache.length > 0) return;
    await loadSoundsList({ silent: true });
}

async function uploadSoundFile(file) {
    if (!file) return false;
    const rawName = String(file.name || "").trim() || "sound.bin";
    const query = encodeURIComponent(rawName);
    const res = await fetch(`/api/sounds/upload?name=${query}`, {
        method: "POST",
        headers: {
            "Content-Type": file.type || "application/octet-stream",
            "X-Sound-Name": rawName
        },
        body: file
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
        throw new Error(data.error || `Upload failed for ${rawName}`);
    }
    return true;
}

async function handleSoundsFileSelection(fileList) {
    const files = Array.from(fileList || []).filter(Boolean);
    if (!files.length || soundsUploadBusy) return;
    soundsUploadBusy = true;
    if (soundsUI.addBtn) soundsUI.addBtn.disabled = true;
    try {
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            setSoundsUploadStatus(`Uploading ${file.name} (${i + 1}/${files.length})...`);
            await uploadSoundFile(file);
        }
        await loadSoundsList({ silent: true });
        setSoundsUploadStatus(`${files.length} sound${files.length === 1 ? "" : "s"} uploaded.`);
    } catch (err) {
        setSoundsUploadStatus(err?.message || "Sound upload failed.", true);
    } finally {
        soundsUploadBusy = false;
        if (soundsUI.addBtn) soundsUI.addBtn.disabled = false;
        if (soundsUI.fileInput) soundsUI.fileInput.value = "";
    }
}

function openSoundsModal() {
    if (soundsUI.overlay) soundsUI.overlay.style.display = "flex";
    renderSoundDetails();
    loadSoundsList();
}

function closeSoundsModal() {
    if (soundsUI.overlay) soundsUI.overlay.style.display = "none";
    soundsPiTestActive = false;
    if (soundsLiveVolumeTimer) {
        clearTimeout(soundsLiveVolumeTimer);
        soundsLiveVolumeTimer = null;
    }
    stopSoundPreview();
    fetch('/api/sounds/stop', { method: 'POST' }).catch(() => {});
}

soundsUI.openBtn?.addEventListener("click", openSoundsModal);
soundsUI.closeBtn?.addEventListener("click", closeSoundsModal);
soundsUI.overlay?.addEventListener("click", (event) => {
    if (event.target === soundsUI.overlay) closeSoundsModal();
});
soundsUI.addBtn?.addEventListener("click", () => {
    if (!soundsUI.fileInput) return;
    soundsUI.fileInput.value = "";
    soundsUI.fileInput.click();
});
soundsUI.fileInput?.addEventListener("change", async (event) => {
    await handleSoundsFileSelection(event?.target?.files);
});
soundsUI.volumeSlider?.addEventListener("input", () => {
    const selected = getSelectedSoundEntry();
    const volume = Math.max(0, Math.min(100, parseInt(soundsUI.volumeSlider.value, 10) || 0));
    if (soundsUI.volumeValue) soundsUI.volumeValue.textContent = `${volume}%`;
    if (!selected) return;
    soundVolumeByName.set(selected.name, volume);
    if (soundsActiveAudio) soundsActiveAudio.volume = volume / 100;
    scheduleLiveSoundVolumeUpdate();
});
soundsUI.testBtn?.addEventListener("click", () => {
    testSelectedSound();
});
soundsUI.trimStartHandle?.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    soundsTrimDragMode = "start";
    soundsUI.trimStartHandle.setPointerCapture?.(event.pointerId);
});
soundsUI.trimEndHandle?.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    soundsTrimDragMode = "end";
    soundsUI.trimEndHandle.setPointerCapture?.(event.pointerId);
});
soundsUI.waveformWrap?.addEventListener("pointerdown", (event) => {
    if (event.target === soundsUI.trimStartHandle || event.target === soundsUI.trimEndHandle) return;
    const selected = getSelectedSoundEntry();
    if (!selected?.trim?.durationMs) return;
    const trim = getSelectedSoundTrim();
    const rect = soundsUI.waveformWrap.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, ((event.clientX || 0) - rect.left) / Math.max(1, rect.width)));
    const value = Math.round(ratio * trim.durationMs);
    const distStart = Math.abs(value - trim.startMs);
    const distEnd = Math.abs(value - (trim.endMs || trim.durationMs));
    soundsTrimDragMode = distStart <= distEnd ? "start" : "end";
    setSoundTrimFromPointer(event, soundsTrimDragMode);
});
window.addEventListener("pointermove", (event) => {
    if (!soundsTrimDragMode) return;
    setSoundTrimFromPointer(event, soundsTrimDragMode);
});
window.addEventListener("pointerup", () => {
    soundsTrimDragMode = null;
});
window.addEventListener("resize", () => {
    if (soundsUI.overlay?.style.display === "flex") drawSoundWaveform(soundsWaveformBuffer);
});


function getLightingFixtureById(id) {
    return lightingFixtures.find((fixture) => fixture.id === id) || null;
}

function getLightingGroupFixtures() {
    return (lightingFixtures || []).filter((fixture) => isLightingGroupFixture(fixture));
}

function getLightingPresetById(id) {
    return lightingPresets.find((preset) => preset.id === id) || null;
}

function getSelectedLightingPreset() {
    return getLightingPresetById(selectedLightingPresetId);
}

function ensureFixturePresetFields(fixture) {
    if (!fixture) return;
    if (fixture.presetId !== "custom" && fixture.presetId !== "group" && !Number.isFinite(parseInt(fixture.presetId, 10))) {
        fixture.presetId = "custom";
    }
    fixture.startAddress = lightingClampInt(fixture.startAddress, 1, 512, 1);
    if (!Array.isArray(fixture.groupMembers)) fixture.groupMembers = [];
    fixture.groupMembers = fixture.groupMembers
        .map((memberId) => parseInt(memberId, 10))
        .filter((memberId, idx, arr) => Number.isFinite(memberId) && arr.indexOf(memberId) === idx && memberId !== fixture.id);
    fixture.cues = Array.isArray(fixture.cues) ? fixture.cues : [];
    fixture.cues.forEach((cue) => ensureGroupCueAssignments(cue));
    if (fixture.presetId === "group") {
        fixture.cues = fixture.cues.slice(0, 1);
        if (!fixture.cues.length) {
            fixture.cues.push({
                id: 1,
                name: (fixture.name || `Scene ${fixture.id}`).toString(),
                channels: [],
                effects: normalizeLightingEffectsData(null),
                groupAssignments: []
            });
        } else {
            fixture.cues[0].name = (fixture.cues[0].name || fixture.name || `Scene ${fixture.id}`).toString();
            ensureGroupCueAssignments(fixture.cues[0]);
        }
    }
}

function getFixturePreset(fixture) {
    if (!fixture) return null;
    ensureFixturePresetFields(fixture);
    if (fixture.presetId === "custom" || fixture.presetId === "group") return null;
    return getLightingPresetById(parseInt(fixture.presetId, 10));
}

function snapshotPresetAddressMap(preset) {
    const map = new Map();
    if (!preset || !Array.isArray(preset.channels)) return map;
    preset.channels.forEach((channel, idx) => {
        const id = Number.isFinite(parseInt(channel?.id, 10)) ? parseInt(channel.id, 10) : null;
        if (id == null) return;
        const address = lightingClampInt(channel?.address, 1, 512, idx + 1);
        map.set(id, address);
    });
    return map;
}

function syncFixtureCuesWithPreset(fixture, options = {}) {
    const preset = getFixturePreset(fixture);
    if (!fixture || !preset || !Array.isArray(fixture.cues)) return;
    const start = lightingClampInt(fixture.startAddress, 1, 512, 1);
    const oldStart = lightingClampInt(options.oldStartAddress, 1, 512, start);
    const oldPresetAddressById = options.oldPresetAddressById instanceof Map ? options.oldPresetAddressById : null;

    fixture.cues = fixture.cues.map((cue) => {
        const existingChannels = normalizeLightingChannelsData(cue?.channels);
        const existingByPresetId = new Map();
        const existingByName = new Map();
        const existingByChannel = new Map();

        existingChannels.forEach((entry) => {
            existingByChannel.set(entry.channel, entry.value);
            const existingPresetId = Number.isFinite(parseInt(entry?.presetChannelId, 10)) ? parseInt(entry.presetChannelId, 10) : null;
            if (existingPresetId != null && !existingByPresetId.has(existingPresetId)) {
                existingByPresetId.set(existingPresetId, entry.value);
            }
            const keyName = (entry?.name || "").toString().trim();
            if (keyName && !existingByName.has(keyName)) {
                existingByName.set(keyName, entry.value);
            }
        });

        const nextChannels = [];
        preset.channels.forEach((presetChannel, idx) => {
            const presetChannelId = Number.isFinite(parseInt(presetChannel?.id, 10)) ? parseInt(presetChannel.id, 10) : idx + 1;
            const relativeAddress = lightingClampInt(presetChannel?.address, 1, 512, idx + 1);
            const absoluteChannel = (start - 1) + relativeAddress;
            if (absoluteChannel < 1 || absoluteChannel > 512) return;

            const presetName = (presetChannel?.name || `Channel ${idx + 1}`).toString();
            let value = 0;
            if (existingByPresetId.has(presetChannelId)) {
                value = existingByPresetId.get(presetChannelId);
            } else if (existingByName.has(presetName.trim())) {
                value = existingByName.get(presetName.trim());
            } else if (oldPresetAddressById && oldPresetAddressById.has(presetChannelId)) {
                const oldRelative = lightingClampInt(oldPresetAddressById.get(presetChannelId), 1, 512, relativeAddress);
                const oldAbsolute = (oldStart - 1) + oldRelative;
                value = existingByChannel.has(oldAbsolute) ? existingByChannel.get(oldAbsolute) : 0;
            } else if (existingByChannel.has(absoluteChannel)) {
                value = existingByChannel.get(absoluteChannel);
            }

            nextChannels.push({
                channel: absoluteChannel,
                value: lightingClampInt(value, 0, 255, 0),
                name: presetName,
                presetChannelId
            });
        });

        return {
            ...cue,
            channels: normalizeLightingChannelsData(nextChannels)
        };
    });
}

function syncAllFixturesUsingPreset(presetId, options = {}) {
    const targetId = parseInt(presetId, 10);
    if (!Number.isFinite(targetId)) return;
    lightingFixtures.forEach((fixture) => {
        if (fixture.presetId === "custom" || fixture.presetId === "group") return;
        if (parseInt(fixture.presetId, 10) !== targetId) return;
        syncFixtureCuesWithPreset(fixture, options);
    });
}

function getFixturePresetLabel(fixture, entry) {
    const entryName = (entry?.name || "").toString().trim();
    const preset = getFixturePreset(fixture);
    if (!preset || !Array.isArray(preset.channels)) {
        return entryName ? `${entryName} (CH ${entry.channel})` : `CH ${entry.channel}`;
    }
    const start = lightingClampInt(fixture.startAddress, 1, 512, 1);
    const relativeAddress = (entry.channel - start) + 1;
    if (relativeAddress < 1 || relativeAddress > 512) {
        return entryName ? `${entryName} (CH ${entry.channel})` : `CH ${entry.channel}`;
    }
    const channelPreset = preset.channels.find((candidate) => lightingClampInt(candidate?.address, 1, 512, -1) === relativeAddress);
    if (!channelPreset) {
        return entryName ? `${entryName} (CH ${entry.channel})` : `CH ${entry.channel}`;
    }
    const channelName = (channelPreset?.name || "").toString().trim();
    return channelName ? `${channelName} (CH ${entry.channel})` : `CH ${entry.channel}`;
}

function createChannelsFromFixturePreset(fixture) {
    const preset = getFixturePreset(fixture);
    if (!preset || !Array.isArray(preset.channels) || !preset.channels.length) return [];
    const start = lightingClampInt(fixture.startAddress, 1, 512, 1);
    const channels = [];
    preset.channels.forEach((presetChannel, idx) => {
        const presetChannelId = Number.isFinite(parseInt(presetChannel?.id, 10)) ? parseInt(presetChannel.id, 10) : idx + 1;
        const relativeAddress = lightingClampInt(presetChannel?.address, 1, 512, idx + 1);
        const channelNumber = (start - 1) + relativeAddress;
        if (channelNumber < 1 || channelNumber > 512) return;
        channels.push({
            channel: channelNumber,
            value: 0,
            name: (presetChannel?.name || `Channel ${idx + 1}`).toString(),
            presetChannelId
        });
    });
    return normalizeLightingChannelsData(channels);
}

function getSelectedLightingFixture() {
    return getLightingFixtureById(selectedLightingFixtureId);
}

function isLightingGroupFixture(fixture) {
    return !!fixture && fixture.presetId === "group";
}

function getLightingGroupMemberFixtures(groupFixture) {
    if (!isLightingGroupFixture(groupFixture)) return [];
    const memberIds = Array.isArray(groupFixture.groupMembers) ? groupFixture.groupMembers : [];
    return memberIds
        .map((id) => getLightingFixtureById(id))
        .filter((fixture) => fixture && fixture.id !== groupFixture.id && !isLightingGroupFixture(fixture));
}

function getSelectedLightingGroupMemberFixture() {
    const fixture = getSelectedLightingFixture();
    if (!isLightingGroupFixture(fixture)) return null;
    return getLightingFixtureById(selectedLightingGroupMemberId);
}

function getSelectedLightingCue() {
    const fixture = getSelectedLightingFixture();
    if (!fixture || !Array.isArray(fixture.cues)) return null;
    return fixture.cues.find((cue) => cue.id === selectedLightingCueId) || null;
}

function getSelectedSceneEffectsCue() {
    const fixture = getSelectedLightingFixture();
    if (!isLightingGroupFixture(fixture)) return null;
    const ref = selectedSceneEffectsCueRef;
    if (!ref || typeof ref !== "object") return null;
    const sourceFixture = getLightingFixtureById(parseInt(ref.fixtureId, 10));
    if (!sourceFixture || !Array.isArray(sourceFixture.cues)) return null;
    const sourceCue = sourceFixture.cues.find((entry) => parseInt(entry?.id, 10) === parseInt(ref.cueId, 10));
    if (!sourceCue) return null;
    return { fixture: sourceFixture, cue: sourceCue };
}

function ensureGroupCueAssignments(cue) {
    if (!cue) return;
    cue.groupAssignments = Array.isArray(cue.groupAssignments) ? cue.groupAssignments : [];
    const seen = new Set();
    cue.groupAssignments = cue.groupAssignments.filter((entry) => {
        const fixtureId = parseInt(entry?.fixtureId, 10);
        const cueId = parseInt(entry?.cueId, 10);
        if (!Number.isFinite(fixtureId) || !Number.isFinite(cueId)) return false;
        const key = `${fixtureId}:${cueId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        entry.fixtureId = fixtureId;
        entry.cueId = cueId;
        return true;
    });
}

function normalizeSceneTimeline(cue) {
    const toCueItem = (entry) => {
        const fixtureId = parseInt(entry?.fixtureId, 10);
        const cueId = parseInt(entry?.cueId, 10);
        if (!Number.isFinite(fixtureId) || !Number.isFinite(cueId)) return null;
        return { fixtureId, cueId };
    };
    const cueItems = (items) => {
        const out = [];
        (Array.isArray(items) ? items : []).forEach((entry) => {
            const parsed = toCueItem(entry);
            if (!parsed) return;
            out.push(parsed);
        });
        return out;
    };

    let timeline = Array.isArray(cue?.sceneTimeline) ? cue.sceneTimeline : [];
    if (!timeline.length) {
        const assignments = Array.isArray(cue?.groupAssignments) ? cue.groupAssignments : [];
        timeline = assignments
            .map((entry) => toCueItem(entry))
            .filter(Boolean)
            .map((item) => ({ type: "cues", items: [item] }));
    }

    const normalized = [];
    timeline.forEach((slot) => {
        const type = String(slot?.type || "").trim().toLowerCase();
        if (type === "delay") {
            const ms = lightingClampInt(slot?.ms, 0, 600000, 0);
            if (ms > 0) normalized.push({ type: "delay", ms });
            return;
        }
        const items = cueItems(slot?.items || slot?.cues || slot?.assignments || []);
        if (items.length) normalized.push({ type: "cues", items });
    });
    cue.sceneTimeline = normalized;
    return cue.sceneTimeline;
}

function sceneCueContainsTargetRef(sceneFixtureId, sceneCueId, targetFixtureId, targetCueId, visited = new Set()) {
    const sceneFixture = getLightingFixtureById(parseInt(sceneFixtureId, 10));
    if (!sceneFixture || !isLightingGroupFixture(sceneFixture)) return false;
    const cue = Array.isArray(sceneFixture.cues)
        ? sceneFixture.cues.find((entry) => parseInt(entry?.id, 10) === parseInt(sceneCueId, 10))
        : null;
    if (!cue) return false;
    const sceneKey = `${parseInt(sceneFixtureId, 10)}:${parseInt(sceneCueId, 10)}`;
    if (visited.has(sceneKey)) return false;
    visited.add(sceneKey);
    const timeline = normalizeSceneTimeline(cue);
    for (let i = 0; i < timeline.length; i += 1) {
        const slot = timeline[i];
        if (slot?.type !== "cues") continue;
        const items = Array.isArray(slot.items) ? slot.items : [];
        for (let j = 0; j < items.length; j += 1) {
            const item = items[j];
            const fixtureId = parseInt(item?.fixtureId, 10);
            const cueId = parseInt(item?.cueId, 10);
            if (!Number.isFinite(fixtureId) || !Number.isFinite(cueId)) continue;
            if (fixtureId === parseInt(targetFixtureId, 10) && cueId === parseInt(targetCueId, 10)) return true;
            const nestedFixture = getLightingFixtureById(fixtureId);
            if (isLightingGroupFixture(nestedFixture)) {
                if (sceneCueContainsTargetRef(fixtureId, cueId, targetFixtureId, targetCueId, visited)) return true;
            }
        }
    }
    return false;
}

function sceneFixtureContainsFixture(sceneFixtureId, targetFixtureId, visited = new Set()) {
    const sourceFixture = getLightingFixtureById(parseInt(sceneFixtureId, 10));
    const targetFid = parseInt(targetFixtureId, 10);
    if (!sourceFixture || !isLightingGroupFixture(sourceFixture) || !Number.isFinite(targetFid)) return false;
    const sourceFid = parseInt(sceneFixtureId, 10);
    if (sourceFid === targetFid) return true;
    const visitKey = `f:${sourceFid}`;
    if (visited.has(visitKey)) return false;
    visited.add(visitKey);
    const cues = Array.isArray(sourceFixture.cues) ? sourceFixture.cues : [];
    for (let c = 0; c < cues.length; c += 1) {
        const timeline = normalizeSceneTimeline(cues[c]);
        for (let i = 0; i < timeline.length; i += 1) {
            const slot = timeline[i];
            if (slot?.type !== "cues") continue;
            const items = Array.isArray(slot.items) ? slot.items : [];
            for (let j = 0; j < items.length; j += 1) {
                const refFixtureId = parseInt(items[j]?.fixtureId, 10);
                if (!Number.isFinite(refFixtureId)) continue;
                if (refFixtureId === targetFid) return true;
                const refFixture = getLightingFixtureById(refFixtureId);
                if (isLightingGroupFixture(refFixture)) {
                    if (sceneFixtureContainsFixture(refFixtureId, targetFid, visited)) return true;
                }
            }
        }
    }
    return false;
}

function canInsertSceneReference(targetSceneFixture, sourceFixtureId, sourceCueId) {
    if (!targetSceneFixture || !isLightingGroupFixture(targetSceneFixture)) return true;
    const targetCue = getSelectedLightingCue() || ensureSceneCue(targetSceneFixture);
    if (!targetCue) return false;
    const targetFixtureId = parseInt(targetSceneFixture?.id, 10);
    const targetCueId = parseInt(targetCue?.id, 10);
    const sourceFixture = getLightingFixtureById(parseInt(sourceFixtureId, 10));
    if (!sourceFixture) return false;
    if (!isLightingGroupFixture(sourceFixture)) return true;
    const sourceFid = parseInt(sourceFixtureId, 10);
    const sourceCid = parseInt(sourceCueId, 10);
    if (sourceFid === targetFixtureId && sourceCid === targetCueId) return false;
    if (sourceFid === targetFixtureId) return false;
    // Robust cycle prevention on fixture level (covers multiple cue IDs per scene fixture).
    if (sceneFixtureContainsFixture(sourceFid, targetFixtureId)) return false;
    return !sceneCueContainsTargetRef(sourceFid, sourceCid, targetFixtureId, targetCueId);
}

function isSceneCueRef(refValue) {
    const [fixtureRaw, cueRaw] = String(refValue || "").split(":");
    const fixtureId = parseInt(fixtureRaw, 10);
    const cueId = parseInt(cueRaw, 10);
    if (!Number.isFinite(fixtureId) || !Number.isFinite(cueId)) return false;
    const fixture = getLightingFixtureById(fixtureId);
    if (!fixture || !isLightingGroupFixture(fixture)) return false;
    return Array.isArray(fixture.cues) && fixture.cues.some((cue) => parseInt(cue?.id, 10) === cueId);
}

function updateLightingAddCueButtonLabel() {
    if (!lightingUI.addChannelBtn) return;
    const fixture = getSelectedLightingFixture();
    if (!isLightingGroupFixture(fixture)) {
        lightingUI.addChannelBtn.textContent = "Add Channel";
        return;
    }
    const selectedRef = String(lightingUI.groupCueSourceSelect?.value || "");
    lightingUI.addChannelBtn.textContent = isSceneCueRef(selectedRef) ? "Add Scene" : "Add Cue";
}

function syncSceneCueDerivedAssignments(cue, fixture = null) {
    const timeline = normalizeSceneTimeline(cue);
    const assignments = [];
    const seen = new Set();
    timeline.forEach((slot) => {
        if (slot.type !== "cues") return;
        (slot.items || []).forEach((item) => {
            const key = `${item.fixtureId}:${item.cueId}`;
            if (seen.has(key)) return;
            seen.add(key);
            assignments.push({ fixtureId: item.fixtureId, cueId: item.cueId });
        });
    });
    cue.groupAssignments = assignments;
    if (fixture && isLightingGroupFixture(fixture)) {
        fixture.groupMembers = Array.from(new Set(
            assignments
                .map((entry) => parseInt(entry?.fixtureId, 10))
                .filter((fixtureId) => {
                    const memberFixture = getLightingFixtureById(fixtureId);
                    return Number.isFinite(fixtureId) && memberFixture && !isLightingGroupFixture(memberFixture);
                })
        ));
    }
}

function ensureCueEffects(cue) {
    if (!cue) return;
    cue.effects = normalizeLightingEffectsData(cue.effects);
}

function getAllLightingCues() {
    const cues = [];
    lightingFixtures.forEach((fixture) => {
        if (Array.isArray(fixture.cues)) cues.push(...fixture.cues);
    });
    return cues;
}

function getLightingCueByIds(fixtureId, cueId) {
    const fixture = getLightingFixtureById(fixtureId);
    if (!fixture || !Array.isArray(fixture.cues)) return null;
    return fixture.cues.find((cue) => cue.id === cueId) || null;
}

function remapCueChannelsForFixtureCopy(channels, sourceFixture, targetFixture) {
    const normalized = normalizeLightingChannelsData(channels);
    if (!sourceFixture || !targetFixture) return normalized;
    if (isLightingGroupFixture(sourceFixture) || isLightingGroupFixture(targetFixture)) return normalized;
    const sourceStart = lightingClampInt(sourceFixture?.startAddress, 1, 512, 1);
    const targetStart = lightingClampInt(targetFixture?.startAddress, 1, 512, 1);
    const delta = targetStart - sourceStart;
    if (delta === 0) return normalized;
    return normalized
        .map((entry) => {
            const nextChannel = lightingClampInt((entry?.channel || 0) + delta, 1, 512, -1);
            if (nextChannel < 1) return null;
            return {
                channel: nextChannel,
                value: lightingClampInt(entry?.value, 0, 255, 0),
                name: entry?.name || "",
                presetChannelId: Number.isFinite(parseInt(entry?.presetChannelId, 10)) ? parseInt(entry.presetChannelId, 10) : null
            };
        })
        .filter(Boolean);
}

function ensureSceneCue(groupFixture) {
    if (!groupFixture || !isLightingGroupFixture(groupFixture)) return null;
    groupFixture.cues = Array.isArray(groupFixture.cues) ? groupFixture.cues : [];
    if (!groupFixture.cues[0]) {
        groupFixture.cues[0] = {
            id: nextLightingCueId++,
            name: (groupFixture.name || `Scene ${groupFixture.id}`).toString(),
            channels: [],
            effects: normalizeLightingEffectsData(null),
            groupAssignments: []
        };
    }
    ensureGroupCueAssignments(groupFixture.cues[0]);
    normalizeSceneTimeline(groupFixture.cues[0]);
    syncSceneCueDerivedAssignments(groupFixture.cues[0], groupFixture);
    return groupFixture.cues[0];
}

function addCueToScene(groupFixture, sourceFixtureId, sourceCueId) {
    const sourceFixture = getLightingFixtureById(sourceFixtureId);
    if (!groupFixture || !sourceFixture) return false;
    const sceneCue = ensureSceneCue(groupFixture);
    if (!sceneCue) return false;
    if (!canInsertSceneReference(groupFixture, sourceFixtureId, sourceCueId)) {
        showSceneCycleBlockedNotice();
        return false;
    }
    normalizeSceneTimeline(sceneCue).push({
        type: "cues",
        items: [{ fixtureId: sourceFixtureId, cueId: sourceCueId }]
    });
    syncSceneCueDerivedAssignments(sceneCue, groupFixture);
    selectedLightingFixtureId = groupFixture.id;
    selectedLightingCueId = sceneCue.id;
    return true;
}

function makeCueCopyName(targetFixture, baseName) {
    const existing = new Set((targetFixture?.cues || []).map((cue) => cue.name));
    const cleanBase = (baseName || "Cue").toString().trim() || "Cue";
    let candidate = `${cleanBase} Copy`;
    if (!existing.has(candidate)) return candidate;
    let suffix = 2;
    while (existing.has(`${cleanBase} Copy ${suffix}`)) {
        suffix += 1;
    }
    return `${cleanBase} Copy ${suffix}`;
}

function getCueNameForCopy(sourceCue, targetFixture, sourceFixture = null) {
    const baseName = (sourceCue?.name || "Cue").toString().trim() || "Cue";
    const sameFixture = Number.isFinite(parseInt(sourceFixture?.id, 10))
        && Number.isFinite(parseInt(targetFixture?.id, 10))
        && parseInt(sourceFixture.id, 10) === parseInt(targetFixture.id, 10);
    if (sameFixture) {
        return makeCueCopyName(targetFixture, baseName);
    }
    return baseName;
}

function cloneCueDataForCopy(sourceCue, targetFixture, sourceFixture = null) {
    ensureCueEffects(sourceCue);
    return {
        id: nextLightingCueId++,
        name: getCueNameForCopy(sourceCue, targetFixture, sourceFixture),
        channels: remapCueChannelsForFixtureCopy(sourceCue?.channels, sourceFixture, targetFixture).map((entry) => ({
            channel: entry.channel,
            value: entry.value,
            name: entry.name || "",
            presetChannelId: Number.isFinite(parseInt(entry?.presetChannelId, 10)) ? parseInt(entry.presetChannelId, 10) : null
        })),
        effects: {
            delayMs: 0,
            fadeInMs: sourceCue.effects.fadeInMs,
            fadeOutMs: sourceCue.effects.fadeOutMs,
            durationMs: sourceCue.effects.durationMs
        }
    };
}

function copyCueToFixture(sourceCue, targetFixture, options = {}) {
    if (!sourceCue || !targetFixture) return null;
    targetFixture.cues = Array.isArray(targetFixture.cues) ? targetFixture.cues : [];
    const clonedCue = cloneCueDataForCopy(sourceCue, targetFixture, options.sourceFixture || null);
    targetFixture.cues.push(clonedCue);
    if (options.selectTarget) {
        selectedLightingFixtureId = targetFixture.id;
        selectedLightingCueId = clonedCue.id;
    }
    return clonedCue;
}

function getDraggedCueFromRef() {
    if (!draggedLightingCueRef) return null;
    return getLightingCueByIds(draggedLightingCueRef.sourceFixtureId, draggedLightingCueRef.cueId);
}

function ensureLightingSelectionValidity() {
    if (!lightingFixtures.some((fixture) => fixture.id === selectedLightingFixtureId)) {
        selectedLightingFixtureId = lightingFixtures.length ? lightingFixtures[0].id : null;
    }
    const validPresetIds = new Set(lightingPresets.map((preset) => preset.id));
    lightingFixtures.forEach((fixture) => {
        ensureFixturePresetFields(fixture);
        if (fixture.presetId !== "custom" && fixture.presetId !== "group" && !validPresetIds.has(parseInt(fixture.presetId, 10))) {
            fixture.presetId = "custom";
        }
    });
    const fixture = getSelectedLightingFixture();
    const cues = fixture && Array.isArray(fixture.cues) ? fixture.cues : [];
    if (!cues.some((cue) => cue.id === selectedLightingCueId)) {
        selectedLightingCueId = cues.length ? cues[0].id : null;
    }
    if (isLightingGroupFixture(fixture)) {
        const sceneCue = cues[0] || null;
        const timeline = sceneCue ? normalizeSceneTimeline(sceneCue) : [];
        if (!Number.isFinite(selectedSceneTimelineIndex) || selectedSceneTimelineIndex < 0 || selectedSceneTimelineIndex >= timeline.length) {
            selectedSceneTimelineIndex = null;
        }
        const memberIds = getLightingGroupMemberFixtures(fixture).map((entry) => entry.id);
        if (!memberIds.includes(selectedLightingGroupMemberId)) {
            selectedLightingGroupMemberId = memberIds.length ? memberIds[0] : null;
        }
    } else {
        selectedLightingGroupMemberId = null;
        selectedSceneTimelineIndex = null;
        selectedSceneEffectsCueRef = null;
    }
}

function ensureLightingPresetSelectionValidity() {
    if (!lightingPresets.some((preset) => preset.id === selectedLightingPresetId)) {
        selectedLightingPresetId = lightingPresets.length ? lightingPresets[0].id : null;
    }
}

function buildLightingCuePayload(cue) {
    const payload = {};
    if (!cue || !Array.isArray(cue.channels)) return payload;
    cue.channels.forEach((entry) => {
        const channel = lightingClampInt(entry?.channel, 1, 512, -1);
        if (channel < 1) return;
        payload[channel] = lightingClampInt(entry?.value, 0, 255, 0);
    });
    const ordered = {};
    Object.keys(payload).sort((a, b) => Number(a) - Number(b)).forEach((channel) => {
        ordered[channel] = payload[channel];
    });
    return ordered;
}

function buildLightingGroupCuePreviewPayload(groupFixture, groupCue) {
    const payload = {};
    if (!groupFixture || !groupCue) return payload;
    ensureGroupCueAssignments(groupCue);
    (groupCue.groupAssignments || []).forEach((assignment) => {
        const sourceFixture = getLightingFixtureById(assignment.fixtureId);
        if (!sourceFixture || !Array.isArray(sourceFixture.cues)) return;
        const sourceCue = sourceFixture.cues.find((entry) => parseInt(entry?.id, 10) === assignment.cueId);
        if (!sourceCue) return;
        (sourceCue.channels || []).forEach((entry) => {
            const channel = lightingClampInt(entry?.channel, 1, 512, -1);
            if (channel < 1) return;
            payload[channel] = lightingClampInt(entry?.value, 0, 255, 0);
        });
    });
    const ordered = {};
    Object.keys(payload).sort((a, b) => Number(a) - Number(b)).forEach((channel) => {
        ordered[channel] = payload[channel];
    });
    ordered._assignments = (groupCue.groupAssignments || []).map((entry) => {
        const sourceFixture = getLightingFixtureById(entry.fixtureId);
        const sourceCue = sourceFixture?.cues?.find((candidate) => parseInt(candidate?.id, 10) === entry.cueId);
        return {
            fixtureId: entry.fixtureId,
            fixtureName: sourceFixture?.name || `Lamp ${entry.fixtureId}`,
            cueId: entry.cueId,
            cueName: sourceCue?.name || `Cue ${entry.cueId}`
        };
    });
    return ordered;
}

function getAllSceneSourceCueOptions(targetSceneFixture = null, targetSceneCue = null) {
    const options = [];
    (lightingFixtures || []).forEach((fixture) => {
        const fixtureId = parseInt(fixture?.id, 10);
        if (!Number.isFinite(fixtureId)) return;
        (Array.isArray(fixture?.cues) ? fixture.cues : []).forEach((cue) => {
            const cueId = parseInt(cue?.id, 10);
            if (!Number.isFinite(cueId)) return;
            if (targetSceneFixture && targetSceneCue) {
                const targetFixtureId = parseInt(targetSceneFixture?.id, 10);
                const targetCueId = parseInt(targetSceneCue?.id, 10);
                if (fixtureId === targetFixtureId && cueId === targetCueId) return;
                if (isLightingGroupFixture(fixture)) {
                    if (!canInsertSceneReference(targetSceneFixture, fixtureId, cueId)) return;
                }
            }
            const kind = isLightingGroupFixture(fixture) ? "Scene" : "Lamp";
            options.push({
                value: `${fixtureId}:${cueId}`,
                label: `${kind}: ${fixture?.name || `${kind} ${fixtureId}`} / ${cue?.name || `Cue ${cueId}`}`
            });
        });
    });
    return options;
}

function getLightingGroupAvailableLamps(groupFixture) {
    if (!isLightingGroupFixture(groupFixture)) return [];
    const blocked = new Set([groupFixture.id, ...(Array.isArray(groupFixture.groupMembers) ? groupFixture.groupMembers : [])]);
    return lightingFixtures.filter((fixture) => !blocked.has(fixture.id) && !isLightingGroupFixture(fixture));
}

function getGroupCueAssignmentsForMember(groupFixture, memberFixtureId) {
    if (!groupFixture || !Number.isFinite(parseInt(memberFixtureId, 10))) return [];
    const memberId = parseInt(memberFixtureId, 10);
    const assignments = [];
    (groupFixture.cues || []).forEach((groupCue) => {
        ensureGroupCueAssignments(groupCue);
        (groupCue.groupAssignments || []).forEach((entry) => {
            if (entry.fixtureId === memberId) {
                assignments.push({ groupCue, fixtureId: memberId, cueId: entry.cueId });
            }
        });
    });
    return assignments;
}

function addGroupAssignment(groupFixture, memberFixture, sourceCue) {
    if (!groupFixture || !memberFixture || !sourceCue) return false;
    groupFixture.cues = Array.isArray(groupFixture.cues) ? groupFixture.cues : [];
    let groupCue = groupFixture.cues.find((cue) => (cue?.name || "").trim() === (sourceCue?.name || "").trim());
    if (!groupCue) {
        groupCue = {
            id: nextLightingCueId++,
            name: (sourceCue?.name || `Cue ${nextLightingCueId}`).toString(),
            channels: [],
            effects: normalizeLightingEffectsData(null),
            groupAssignments: []
        };
        groupFixture.cues.push(groupCue);
    }
    ensureGroupCueAssignments(groupCue);
    const exists = groupCue.groupAssignments.some((entry) => entry.fixtureId === memberFixture.id && entry.cueId === sourceCue.id);
    if (exists) {
        selectedLightingCueId = groupCue.id;
        return false;
    }
    groupCue.groupAssignments.push({ fixtureId: memberFixture.id, cueId: sourceCue.id });
    selectedLightingCueId = groupCue.id;
    return true;
}

function removeGroupAssignment(groupFixture, memberFixtureId, sourceCueId) {
    if (!groupFixture) return false;
    const memberId = parseInt(memberFixtureId, 10);
    const cueId = parseInt(sourceCueId, 10);
    if (!Number.isFinite(memberId) || !Number.isFinite(cueId)) return false;
    if (isLightingGroupFixture(groupFixture)) {
        groupFixture.cues = Array.isArray(groupFixture.cues) ? groupFixture.cues : [];
        const sceneCue = groupFixture.cues[0];
        if (!sceneCue) return false;
        normalizeSceneTimeline(sceneCue);
        const before = JSON.stringify(sceneCue.sceneTimeline);
        sceneCue.sceneTimeline = sceneCue.sceneTimeline
            .map((slot) => {
                if (slot.type !== "cues") return slot;
                return {
                    ...slot,
                    items: (slot.items || []).filter((entry) => !(entry.fixtureId === memberId && entry.cueId === cueId))
                };
            })
            .filter((slot) => !(slot.type === "cues" && !(slot.items || []).length));
        syncSceneCueDerivedAssignments(sceneCue, groupFixture);
        return JSON.stringify(sceneCue.sceneTimeline) !== before;
    }
    let changed = false;
    groupFixture.cues = (groupFixture.cues || []).filter((groupCue) => {
        ensureGroupCueAssignments(groupCue);
        const before = groupCue.groupAssignments.length;
        groupCue.groupAssignments = groupCue.groupAssignments.filter((entry) => !(entry.fixtureId === memberId && entry.cueId === cueId));
        if (groupCue.groupAssignments.length !== before) changed = true;
        return groupCue.groupAssignments.length > 0;
    });
    return changed;
}

function updateLightingMiddleModeUI() {
    const fixture = getSelectedLightingFixture();
    const isGroup = isLightingGroupFixture(fixture);
    if (lightingUI.middleTopPane) {
        lightingUI.middleTopPane.style.display = isGroup ? "none" : "";
    }
    if (lightingUI.middleBottomPane) {
        lightingUI.middleBottomPane.style.display = "";
    }
    if (lightingUI.middleTopTitle) {
        lightingUI.middleTopTitle.textContent = "Cues";
    }
    if (lightingUI.middleBottomTitle) {
        lightingUI.middleBottomTitle.textContent = isGroup ? "Cue Matrix" : "Channels";
    }
    if (lightingUI.cueName) {
        lightingUI.cueName.style.display = isGroup ? "none" : "";
        lightingUI.cueName.placeholder = "Cue Name";
    }
    if (lightingUI.groupMemberSelect) {
        lightingUI.groupMemberSelect.style.display = "none";
    }
    if (lightingUI.channelNumber) {
        lightingUI.channelNumber.style.display = isGroup ? "none" : "";
    }
    if (lightingUI.groupCueName) {
        lightingUI.groupCueName.style.display = "none";
    }
    if (lightingUI.groupCueSourceSelect) {
        lightingUI.groupCueSourceSelect.style.display = isGroup ? "" : "none";
    }
    if (lightingUI.addCueBtn) {
        lightingUI.addCueBtn.textContent = "Add Cue";
        lightingUI.addCueBtn.style.display = isGroup ? "none" : "";
    }
    if (lightingUI.addChannelBtn) {
        lightingUI.addChannelBtn.textContent = isGroup ? "Add Cue" : "Add Channel";
    }
    if (lightingUI.addDelayBtn) {
        lightingUI.addDelayBtn.style.display = isGroup ? "" : "none";
    }
    if (lightingUI.testSceneBtn) {
        lightingUI.testSceneBtn.style.display = isGroup ? "" : "none";
        lightingUI.testSceneBtn.disabled = !isGroup || lightingTestCueBusy;
    }
    if (lightingUI.testCueBtn) {
        lightingUI.testCueBtn.style.display = isGroup ? "none" : "";
    }
    if (lightingUI.cueDetailsSection) {
        lightingUI.cueDetailsSection.style.display = "";
    }
    if (lightingUI.effectsSection) {
        lightingUI.effectsSection.style.display = "";
    }
    if (lightingUI.groupAssignmentSection) {
        lightingUI.groupAssignmentSection.style.display = "none";
    }
    if (lightingUI.channelNumber) {
        lightingUI.channelNumber.placeholder = "Channel number";
    }
}

function renderLightingHeader() {
    if (!lightingUI.selectedFixtureTitle) return;
    const fixture = getSelectedLightingFixture();
    if (!fixture) {
        lightingUI.selectedFixtureTitle.textContent = "Cues";
        return;
    }
    lightingUI.selectedFixtureTitle.textContent = isLightingGroupFixture(fixture) ? `Scene - ${fixture.name}` : `Lamp - ${fixture.name}`;
}

function renderLightingFixtureList() {
    if (!lightingUI.fixtureList) return;
    lightingUI.fixtureList.innerHTML = "";
    const lamps = lightingFixtures.filter((fixture) => !isLightingGroupFixture(fixture));
    if (!lamps.length) {
        const empty = document.createElement("li");
        empty.className = "lighting-empty";
        empty.textContent = "No lamps available.";
        lightingUI.fixtureList.appendChild(empty);
        return;
    }

    lamps.forEach((fixture) => {
        ensureFixturePresetFields(fixture);
        const item = document.createElement("li");
        item.className = `lighting-list-item${fixture.id === selectedLightingFixtureId ? " selected" : ""}`;
        item.title = "Select lamp";
        const main = document.createElement("div");
        main.className = "lighting-list-item-main lighting-fixture-main";
        const nameLabel = document.createElement("div");
        nameLabel.className = "lighting-fixture-name";
        nameLabel.textContent = fixture.name;
        nameLabel.title = "Double click to rename";
        main.appendChild(nameLabel);

        const controls = document.createElement("div");
        controls.className = "lighting-fixture-controls";
        controls.addEventListener("dblclick", (event) => event.stopPropagation());

        const presetWrap = document.createElement("div");
        presetWrap.className = "lighting-fixture-field";
        const presetLabel = document.createElement("span");
        presetLabel.className = "lighting-fixture-field-label";
        presetLabel.textContent = "Preset";
        const presetSelect = document.createElement("select");
        const customOption = document.createElement("option");
        customOption.value = "custom";
        customOption.textContent = "Custom";
        presetSelect.appendChild(customOption);
        lightingPresets.forEach((preset) => {
            const option = document.createElement("option");
            option.value = String(preset.id);
            option.textContent = preset.name;
            presetSelect.appendChild(option);
        });
        presetSelect.value = fixture.presetId === "custom"
            ? fixture.presetId
            : String(parseInt(fixture.presetId, 10));
        presetSelect.addEventListener("click", (event) => event.stopPropagation());
        presetSelect.addEventListener("change", () => {
            const previousPresetId = fixture.presetId;
            const nextValue = presetSelect.value;
            fixture.presetId = nextValue === "custom" ? nextValue : parseInt(nextValue, 10);
            if (fixture.presetId !== "custom") {
                fixture.startAddress = lightingClampInt(fixture.startAddress, 1, 512, 1);
                syncFixtureCuesWithPreset(fixture);
            } else if (previousPresetId !== "custom") {
                fixture.cues = (fixture.cues || []).map((cue) => ({
                    ...cue,
                    channels: normalizeLightingChannelsData(cue.channels).map((entry) => ({
                        channel: entry.channel,
                        value: entry.value,
                        name: entry.name || "",
                        presetChannelId: null
                    }))
                }));
            }
            renderLightingModal();
            autoSave();
        });
        presetWrap.appendChild(presetLabel);
        presetWrap.appendChild(presetSelect);
        controls.appendChild(presetWrap);

        const addressWrap = document.createElement("div");
        addressWrap.className = "lighting-fixture-field lighting-fixture-address-wrap";
        const addressLabel = document.createElement("span");
        addressLabel.className = "lighting-fixture-field-label";
        addressLabel.textContent = "DMX Start";
        const startAddressInput = document.createElement("input");
        startAddressInput.type = "number";
        startAddressInput.className = "lighting-fixture-address";
        startAddressInput.min = "1";
        startAddressInput.max = "512";
        startAddressInput.placeholder = "1-512";
        startAddressInput.value = String(lightingClampInt(fixture.startAddress, 1, 512, 1));
        startAddressInput.addEventListener("click", (event) => event.stopPropagation());
        startAddressInput.addEventListener("change", () => {
            const oldStart = lightingClampInt(fixture.startAddress, 1, 512, 1);
            fixture.startAddress = lightingClampInt(startAddressInput.value, 1, 512, 1);
            startAddressInput.value = String(fixture.startAddress);
            syncFixtureCuesWithPreset(fixture, { oldStartAddress: oldStart });
            renderLightingModal();
            autoSave();
        });
        addressWrap.appendChild(addressLabel);
        addressWrap.appendChild(startAddressInput);
        controls.appendChild(addressWrap);

        main.appendChild(controls);
        item.appendChild(main);

        item.addEventListener("click", () => {
            if (selectedLightingFixtureId === fixture.id) return;
            selectedLightingFixtureId = fixture.id;
            ensureLightingSelectionValidity();
            renderLightingModal();
        });

        const startRenameFixture = (event) => {
            event.stopPropagation();
            const input = document.createElement("input");
            input.type = "text";
            input.className = "lighting-name-input";
            input.value = fixture.name;
            let finished = false;

            const commit = (apply) => {
                if (finished) return;
                finished = true;
                if (apply) {
                    const nextName = (input.value || "").trim();
                    if (nextName) fixture.name = nextName;
                    autoSave();
                }
                renderLightingModal();
            };

            input.addEventListener("keydown", (keyEvent) => {
                if (keyEvent.key === "Enter") commit(true);
                if (keyEvent.key === "Escape") commit(false);
            });
            input.addEventListener("blur", () => commit(true));

            main.replaceChild(input, nameLabel);
            input.focus();
            input.select();
        };
        nameLabel.addEventListener("dblclick", startRenameFixture);
        main.addEventListener("dblclick", startRenameFixture);

        item.addEventListener("dragover", (event) => {
            const sourceCue = getDraggedCueFromRef();
            if (!sourceCue || isLightingGroupFixture(fixture)) return;
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
            item.classList.add("drop-target");
        });
        item.addEventListener("dragleave", () => {
            item.classList.remove("drop-target");
        });
        item.addEventListener("drop", (event) => {
            const sourceCue = getDraggedCueFromRef();
            item.classList.remove("drop-target");
            if (!sourceCue || isLightingGroupFixture(fixture)) return;
            event.preventDefault();
            const sourceFixture = getLightingFixtureById(draggedLightingCueRef?.sourceFixtureId);
            const copied = copyCueToFixture(sourceCue, fixture, { selectTarget: true, sourceFixture });
            if (!copied) return;
            renderLightingModal();
            autoSave();
        });

        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "lighting-delete-btn";
        deleteBtn.textContent = "X";
        deleteBtn.addEventListener("click", (event) => {
            event.stopPropagation();
            lightingFixtures.forEach((candidate) => {
                if (candidate.id === fixture.id) return;
                candidate.groupMembers = (candidate.groupMembers || []).filter((memberId) => memberId !== fixture.id);
                candidate.cues = (candidate.cues || []).map((cue) => {
                    ensureGroupCueAssignments(cue);
                    cue.groupAssignments = cue.groupAssignments.filter((entry) => entry.fixtureId !== fixture.id);
                    return cue;
                }).filter((cue) => (cue.groupAssignments || []).length > 0 || !isLightingGroupFixture(candidate));
            });
            lightingFixtures = lightingFixtures.filter((entry) => entry.id !== fixture.id);
            ensureLightingSelectionValidity();
            renderLightingModal();
            autoSave();
        });

        item.appendChild(deleteBtn);
        lightingUI.fixtureList.appendChild(item);
    });
}

function renderLightingGroupList() {
    if (!lightingUI.groupList) return;
    lightingUI.groupList.innerHTML = "";
    const groups = getLightingGroupFixtures();
    if (!groups.length) {
        const empty = document.createElement("li");
        empty.className = "lighting-empty";
        empty.textContent = "No scenes available.";
        lightingUI.groupList.appendChild(empty);
        return;
    }
    groups.forEach((groupFixture) => {
        ensureFixturePresetFields(groupFixture);
        const item = document.createElement("li");
        item.className = `lighting-list-item lighting-scene-item${groupFixture.id === selectedLightingFixtureId ? " selected" : ""}`;
        const main = document.createElement("div");
        main.className = "lighting-list-item-main";
        const nameLabel = document.createElement("div");
        nameLabel.className = "lighting-fixture-name";
        nameLabel.textContent = groupFixture.name || `Scene ${groupFixture.id}`;
        nameLabel.title = "Double click to rename";
        const meta = document.createElement("div");
        meta.className = "lighting-item-meta";
        meta.textContent = `${(groupFixture.cues || []).length} scene cues`;
        main.appendChild(nameLabel);
        main.appendChild(meta);
        item.appendChild(main);
        item.addEventListener("click", () => {
            if (selectedLightingFixtureId === groupFixture.id) return;
            selectedLightingFixtureId = groupFixture.id;
            selectedSceneTimelineIndex = null;
            selectedSceneEffectsCueRef = null;
            ensureLightingSelectionValidity();
            renderLightingModal();
        });
        item.addEventListener("dragover", (event) => {
            const sourceCue = getDraggedCueFromRef();
            if (!sourceCue) return;
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
            item.classList.add("drop-target");
        });
        item.addEventListener("dragleave", () => {
            item.classList.remove("drop-target");
        });
        item.addEventListener("drop", (event) => {
            const sourceCue = getDraggedCueFromRef();
            item.classList.remove("drop-target");
            if (!sourceCue) return;
            event.preventDefault();
            const sourceFixtureId = parseInt(draggedLightingCueRef?.sourceFixtureId, 10);
            const sourceCueId = parseInt(draggedLightingCueRef?.cueId, 10);
            if (!Number.isFinite(sourceFixtureId) || !Number.isFinite(sourceCueId)) return;
            if (!addCueToScene(groupFixture, sourceFixtureId, sourceCueId)) {
                if (isLightingGroupFixture(getLightingFixtureById(sourceFixtureId))) {
                    showSceneCycleBlockedNotice();
                }
                return;
            }
            ensureLightingSelectionValidity();
            renderLightingModal();
            autoSave();
        });
        item.draggable = true;
        item.addEventListener("dragstart", (event) => {
            const sceneCue = ensureSceneCue(groupFixture);
            if (!sceneCue) return;
            draggedLightingCueRef = { sourceFixtureId: groupFixture.id, cueId: sceneCue.id };
            if (event.dataTransfer) {
                event.dataTransfer.effectAllowed = "copy";
                event.dataTransfer.setData("text/plain", `${groupFixture.id}:${sceneCue.id}`);
            }
        });
        item.addEventListener("dragend", () => {
            draggedLightingCueRef = null;
        });
        const startRenameGroup = (event) => {
            event.stopPropagation();
            const input = document.createElement("input");
            input.type = "text";
            input.className = "lighting-name-input";
            input.value = groupFixture.name || `Scene ${groupFixture.id}`;
            let finished = false;
            const commit = (apply) => {
                if (finished) return;
                finished = true;
                if (apply) {
                    const nextName = (input.value || "").trim();
                    if (nextName) {
                        groupFixture.name = nextName;
                        if (Array.isArray(groupFixture.cues) && groupFixture.cues[0]) {
                            groupFixture.cues[0].name = nextName;
                        }
                    }
                    autoSave();
                }
                renderLightingModal();
            };
            input.addEventListener("keydown", (keyEvent) => {
                if (keyEvent.key === "Enter") commit(true);
                if (keyEvent.key === "Escape") commit(false);
            });
            input.addEventListener("blur", () => commit(true));
            main.replaceChild(input, nameLabel);
            input.focus();
            input.select();
        };
        nameLabel.addEventListener("dblclick", startRenameGroup);
        main.addEventListener("dblclick", startRenameGroup);
        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "lighting-delete-btn";
        deleteBtn.textContent = "X";
        deleteBtn.addEventListener("click", (event) => {
            event.stopPropagation();
            lightingFixtures = lightingFixtures.filter((entry) => entry.id !== groupFixture.id);
            ensureLightingSelectionValidity();
            renderLightingModal();
            autoSave();
        });
        item.appendChild(deleteBtn);
        lightingUI.groupList.appendChild(item);
    });
}

function renderLightingCueList() {
    if (!lightingUI.cueList) return;
    lightingUI.cueList.innerHTML = "";
    const fixture = getSelectedLightingFixture();

    if (!fixture) {
        const empty = document.createElement("li");
        empty.className = "lighting-empty";
        empty.textContent = "Select a lamp or scene first.";
        lightingUI.cueList.appendChild(empty);
        return;
    }

    if (isLightingGroupFixture(fixture)) {
        fixture.cues = Array.isArray(fixture.cues) ? fixture.cues : [];
        const sceneCue = fixture.cues[0] || null;
        if (!sceneCue) {
            const empty = document.createElement("li");
            empty.className = "lighting-empty";
            empty.textContent = "No cues assigned to this scene yet.";
            lightingUI.cueList.appendChild(empty);
            return;
        }
        ensureGroupCueAssignments(sceneCue);
        const assignments = sceneCue.groupAssignments || [];
        if (!assignments.length) {
            const empty = document.createElement("li");
            empty.className = "lighting-empty";
            empty.textContent = "No cues assigned to this scene yet.";
            lightingUI.cueList.appendChild(empty);
            return;
        }
        assignments.forEach((assignment) => {
            const sourceFixture = getLightingFixtureById(assignment.fixtureId);
            const sourceCue = sourceFixture?.cues?.find((entry) => parseInt(entry?.id, 10) === assignment.cueId);
            if (!sourceFixture || !sourceCue) return;
            const item = document.createElement("li");
            item.className = "lighting-list-item";
            item.addEventListener("click", () => {
                selectedLightingFixtureId = sourceFixture.id;
                selectedLightingCueId = sourceCue.id;
                ensureLightingSelectionValidity();
                renderLightingModal();
            });
            const main = document.createElement("div");
            main.className = "lighting-list-item-main";
            const nameLabel = document.createElement("div");
            const lampName = sourceFixture.name || `Lamp ${sourceFixture.id}`;
            const cueName = sourceCue.name || `Cue ${sourceCue.id}`;
            nameLabel.textContent = `${lampName} - ${cueName}`;
            const meta = document.createElement("div");
            meta.className = "lighting-item-meta";
            meta.textContent = `${(sourceCue.channels || []).length} channels`;
            main.appendChild(nameLabel);
            main.appendChild(meta);
            item.appendChild(main);
            const deleteBtn = document.createElement("button");
            deleteBtn.type = "button";
            deleteBtn.className = "lighting-delete-btn";
            deleteBtn.textContent = "X";
            deleteBtn.addEventListener("click", (event) => {
                event.stopPropagation();
                if (removeGroupAssignment(fixture, sourceFixture.id, sourceCue.id)) {
                    ensureLightingSelectionValidity();
                    renderLightingModal();
                    autoSave();
                }
            });
            item.appendChild(deleteBtn);
            lightingUI.cueList.appendChild(item);
        });
        return;
    }

    fixture.cues = Array.isArray(fixture.cues) ? fixture.cues : [];
    if (!fixture.cues.length) {
        const empty = document.createElement("li");
        empty.className = "lighting-empty";
        empty.textContent = "No cues for this lamp yet.";
        lightingUI.cueList.appendChild(empty);
        return;
    }

    fixture.cues.forEach((cue) => {
        const item = document.createElement("li");
        item.className = `lighting-list-item${cue.id === selectedLightingCueId ? " selected" : ""}`;
        if (
            parseInt(lightingTestActiveCueRef?.fixtureId, 10) === parseInt(fixture?.id, 10) &&
            parseInt(lightingTestActiveCueRef?.cueId, 10) === parseInt(cue?.id, 10)
        ) {
            item.classList.add("scene-test-active");
        }
        item.draggable = true;

        const main = document.createElement("div");
        main.className = "lighting-list-item-main";

        const nameLabel = document.createElement("div");
        nameLabel.textContent = cue.name;
        nameLabel.title = "Double click to rename";

        const meta = document.createElement("div");
        meta.className = "lighting-item-meta";
        meta.textContent = `${(cue.channels || []).length} channels`;

        main.appendChild(nameLabel);
        main.appendChild(meta);
        item.appendChild(main);

        item.addEventListener("click", () => {
            if (selectedLightingCueId === cue.id) return;
            selectedLightingCueId = cue.id;
            renderLightingModal();
        });
        item.addEventListener("dragstart", (event) => {
            draggedLightingCueRef = { sourceFixtureId: fixture.id, cueId: cue.id };
            if (event.dataTransfer) {
                event.dataTransfer.effectAllowed = "copy";
                event.dataTransfer.setData("text/plain", `${fixture.id}:${cue.id}`);
            }
        });
        item.addEventListener("dragend", () => {
            draggedLightingCueRef = null;
            lightingUI.cueList?.classList.remove("lighting-drop-active");
            document.querySelectorAll(".lighting-list-item.drop-target").forEach((entry) => entry.classList.remove("drop-target"));
        });

        const startRenameCue = (event) => {
            event.stopPropagation();
            const input = document.createElement("input");
            input.type = "text";
            input.className = "lighting-name-input";
            input.value = cue.name;
            let finished = false;

            const commit = (apply) => {
                if (finished) return;
                finished = true;
                if (apply) {
                    const nextName = (input.value || "").trim();
                    if (nextName) cue.name = nextName;
                    autoSave();
                }
                renderLightingModal();
            };

            input.addEventListener("keydown", (keyEvent) => {
                if (keyEvent.key === "Enter") commit(true);
                if (keyEvent.key === "Escape") commit(false);
            });
            input.addEventListener("blur", () => commit(true));

            main.replaceChild(input, nameLabel);
            input.focus();
            input.select();
        };
        nameLabel.addEventListener("dblclick", startRenameCue);
        main.addEventListener("dblclick", startRenameCue);

        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "lighting-delete-btn";
        deleteBtn.textContent = "X";
        deleteBtn.addEventListener("click", (event) => {
            event.stopPropagation();
            fixture.cues = fixture.cues.filter((entry) => entry.id !== cue.id);
            ensureLightingSelectionValidity();
            renderLightingModal();
            autoSave();
        });

        item.appendChild(deleteBtn);
        lightingUI.cueList.appendChild(item);
    });
}

function renderLightingCuePreview() {
    if (!lightingUI.cuePreview) return;
    const fixture = getSelectedLightingFixture();
    const cue = getSelectedLightingCue();
    if (!cue) {
        lightingUI.cuePreview.textContent = "{}";
        return;
    }
    ensureCueEffects(cue);
    const payload = isLightingGroupFixture(fixture)
        ? buildLightingGroupCuePreviewPayload(fixture, cue)
        : buildLightingCuePayload(cue);
    payload._effects = {
        fadeInMs: cue.effects.fadeInMs,
        fadeOutMs: cue.effects.fadeOutMs,
        durationMs: cue.effects.durationMs
    };
    lightingUI.cuePreview.textContent = JSON.stringify(payload, null, 2);
}

function renderLightingChannelAdder() {
    const fixture = getSelectedLightingFixture();
    const isGroup = isLightingGroupFixture(fixture);
    const cue = getSelectedLightingCue();
    const hasCue = !!cue;
    if (!isGroup) {
        if (lightingUI.channelNumber) {
            lightingUI.channelNumber.disabled = !hasCue;
            if (!lightingUI.channelNumber.value) lightingUI.channelNumber.value = "1";
        }
        if (lightingUI.groupCueSourceSelect) {
            lightingUI.groupCueSourceSelect.disabled = true;
            lightingUI.groupCueSourceSelect.innerHTML = "";
        }
        if (lightingUI.addChannelBtn) {
            lightingUI.addChannelBtn.disabled = !hasCue;
        }
        if (lightingUI.addDelayBtn) {
            lightingUI.addDelayBtn.disabled = true;
        }
        return;
    }
    if (lightingUI.channelNumber) {
        lightingUI.channelNumber.disabled = true;
    }
    if (lightingUI.groupCueName) {
        lightingUI.groupCueName.disabled = !fixture;
    }
    if (lightingUI.groupCueSourceSelect) {
        const sourceOptions = (isGroup && cue)
            ? getAllSceneSourceCueOptions(fixture, cue)
            : getAllSceneSourceCueOptions();
        lightingUI.groupCueSourceSelect.innerHTML = "";
        sourceOptions.forEach((entry) => {
            const option = document.createElement("option");
            option.value = entry.value;
            option.textContent = entry.label;
            lightingUI.groupCueSourceSelect.appendChild(option);
        });
        lightingUI.groupCueSourceSelect.disabled = !hasCue || sourceOptions.length === 0;
        lightingUI.groupCueSourceSelect.onchange = () => updateLightingAddCueButtonLabel();
    }
    if (lightingUI.addChannelBtn) {
        lightingUI.addChannelBtn.disabled = !hasCue || !lightingUI.groupCueSourceSelect || lightingUI.groupCueSourceSelect.disabled;
    }
    updateLightingAddCueButtonLabel();
    if (lightingUI.addDelayBtn) {
        lightingUI.addDelayBtn.disabled = !hasCue;
    }
}

function renderLightingChannelEditor() {
    if (!lightingUI.channelEditor) return;
    const fixture = getSelectedLightingFixture();
    if (isLightingGroupFixture(fixture)) {
        const selectedSceneCue = getSelectedLightingCue();
        if (!selectedSceneCue) {
            lightingUI.channelEditor.innerHTML = `<div class="lighting-empty">No scene configured.</div>`;
            return;
        }
        const timeline = normalizeSceneTimeline(selectedSceneCue);
        syncSceneCueDerivedAssignments(selectedSceneCue, fixture);
        if (!timeline.length) {
            lightingUI.channelEditor.innerHTML = `<div class="lighting-empty">No scene timeline yet. Add cues or delay blocks.</div>`;
            return;
        }
        const list = document.createElement("ul");
        list.className = "lighting-list";
        list.style.flex = "1 1 auto";
        list.style.maxHeight = "none";
        list.style.minHeight = "0";
        let draggedIndex = null;
        const rowDropPosition = new Map();
        let hoveredRowIndex = null;
        let hoveredInsertPos = "before";
        const clearSceneRowDropIndicators = () => {
            list.querySelectorAll(".lighting-list-item.drop-target,.lighting-list-item.drop-insert-before,.lighting-list-item.drop-insert-after")
                .forEach((entry) => {
                    entry.classList.remove("drop-target", "drop-insert-before", "drop-insert-after");
                    entry.style.removeProperty("--scene-row-shift");
                });
            list.querySelectorAll(".lighting-scene-dropzone.active").forEach((entry) => entry.classList.remove("active"));
            hoveredRowIndex = null;
            hoveredInsertPos = "before";
        };
        const setRowInsertIndicator = (rowEl, rowIndex, clientY) => {
            if (!rowEl) return;
            clearSceneRowDropIndicators();
            const rect = rowEl.getBoundingClientRect();
            const insertAfter = (clientY - rect.top) >= (rect.height / 2);
            const draggingEl = list.querySelector(".lighting-list-item.dragging");
            const shiftPx = Math.max(44, draggingEl?.offsetHeight || rowEl.offsetHeight || 44);
            rowEl.style.setProperty("--scene-row-shift", `${shiftPx}px`);
            const nextPos = insertAfter ? "after" : "before";
            rowDropPosition.set(rowIndex, nextPos);
            hoveredRowIndex = rowIndex;
            hoveredInsertPos = nextPos;
            rowEl.classList.add(insertAfter ? "drop-insert-after" : "drop-insert-before");
        };
        const updateRowDropFromPointer = (clientY) => {
            if (!Number.isFinite(draggedIndex) || draggedSceneMatrixCueRef) return;
            const rows = Array.from(list.querySelectorAll(".lighting-list-item"))
                .filter((entry) => parseInt(entry.dataset.slotIndex, 10) !== draggedIndex);
            if (!rows.length) return;
            let nearest = null;
            let bestDist = Number.POSITIVE_INFINITY;
            rows.forEach((rowEl) => {
                const rect = rowEl.getBoundingClientRect();
                const center = rect.top + (rect.height / 2);
                const dist = Math.abs(clientY - center);
                if (dist < bestDist) {
                    bestDist = dist;
                    nearest = { rowEl, rect, slotIndex: parseInt(rowEl.dataset.slotIndex, 10) };
                }
            });
            if (!nearest || !Number.isFinite(nearest.slotIndex)) return;
            const mid = nearest.rect.top + (nearest.rect.height / 2);
            let nextPos = clientY >= mid ? "after" : "before";
            // Hysteresis around center to avoid flicker while hovering.
            if (hoveredRowIndex === nearest.slotIndex && Math.abs(clientY - mid) < 14) {
                nextPos = hoveredInsertPos || nextPos;
            }
            clearSceneRowDropIndicators();
            const draggingEl = list.querySelector(".lighting-list-item.dragging");
            const shiftPx = Math.max(44, draggingEl?.offsetHeight || nearest.rowEl.offsetHeight || 44);
            nearest.rowEl.style.setProperty("--scene-row-shift", `${shiftPx}px`);
            nearest.rowEl.classList.add(nextPos === "after" ? "drop-insert-after" : "drop-insert-before");
            rowDropPosition.set(nearest.slotIndex, nextPos);
            hoveredRowIndex = nearest.slotIndex;
            hoveredInsertPos = nextPos;
        };
        const removeSlotBtn = (slotIndex) => {
            selectedSceneCue.sceneTimeline = (selectedSceneCue.sceneTimeline || []).filter((_, idx) => idx !== slotIndex);
            syncSceneCueDerivedAssignments(selectedSceneCue, fixture);
            if (selectedSceneTimelineIndex === slotIndex) selectedSceneTimelineIndex = null;
            renderLightingModal();
            autoSave();
        };
        const removeCueItemFromSlot = (slotIndex, itemIndex) => {
            const next = Array.isArray(selectedSceneCue.sceneTimeline) ? [...selectedSceneCue.sceneTimeline] : [];
            const slot = next[slotIndex];
            if (!slot || slot.type !== "cues") return { next, moved: null };
            const items = Array.isArray(slot.items) ? [...slot.items] : [];
            if (itemIndex < 0 || itemIndex >= items.length) return { next, moved: null };
            const [moved] = items.splice(itemIndex, 1);
            if (items.length) {
                next[slotIndex] = { ...slot, items };
            } else {
                next.splice(slotIndex, 1);
            }
            return { next, moved };
        };
        const moveCueToOwnSlot = (fromSlotIndex, fromItemIndex, insertIndexRaw) => {
            if (!Number.isFinite(fromSlotIndex) || !Number.isFinite(fromItemIndex)) return false;
            const pulled = removeCueItemFromSlot(fromSlotIndex, fromItemIndex);
            if (!pulled.moved) return false;
            let insertIndex = Number.isFinite(insertIndexRaw) ? insertIndexRaw : pulled.next.length;
            if (fromSlotIndex < insertIndex) insertIndex -= 1;
            insertIndex = Math.max(0, Math.min(insertIndex, pulled.next.length));
            pulled.next.splice(insertIndex, 0, { type: "cues", items: [pulled.moved] });
            selectedSceneCue.sceneTimeline = pulled.next;
            syncSceneCueDerivedAssignments(selectedSceneCue, fixture);
            draggedSceneMatrixCueRef = null;
            selectedSceneTimelineIndex = insertIndex;
            clearSceneRowDropIndicators();
            renderLightingModal();
            autoSave();
            return true;
        };
        const createCueInsertZone = (insertIndex) => {
            const zone = document.createElement("li");
            zone.className = "lighting-scene-dropzone";
            zone.dataset.insertIndex = String(insertIndex);
            zone.addEventListener("dragover", (event) => {
                if (!draggedSceneMatrixCueRef) return;
                event.preventDefault();
                event.stopPropagation();
                if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
                clearSceneRowDropIndicators();
                zone.classList.add("active");
            });
            zone.addEventListener("dragleave", () => {
                zone.classList.remove("active");
            });
            zone.addEventListener("drop", (event) => {
                if (!draggedSceneMatrixCueRef) return;
                event.preventDefault();
                event.stopPropagation();
                zone.classList.remove("active");
                const fromSlotIndex = parseInt(draggedSceneMatrixCueRef?.slotIndex, 10);
                const fromItemIndex = parseInt(draggedSceneMatrixCueRef?.itemIndex, 10);
                moveCueToOwnSlot(fromSlotIndex, fromItemIndex, insertIndex);
            });
            return zone;
        };
        list.appendChild(createCueInsertZone(0));
        timeline.forEach((slot, slotIndex) => {
            const item = document.createElement("li");
            item.className = "lighting-list-item";
            if (Number.isFinite(selectedSceneTimelineIndex) && selectedSceneTimelineIndex === slotIndex) {
                item.classList.add("selected");
            }
            if (Number.isFinite(lightingSceneTestActiveSlotIndex) && lightingSceneTestActiveSlotIndex === slotIndex) {
                item.classList.add("scene-test-active");
            }
            item.draggable = true;
            item.dataset.slotIndex = String(slotIndex);
            item.addEventListener("click", () => {
                selectedSceneTimelineIndex = slotIndex;
                if (slot?.type === "delay") selectedSceneEffectsCueRef = null;
                renderLightingModal();
            });
            item.addEventListener("dragstart", () => {
                draggedIndex = slotIndex;
                item.classList.add("dragging");
            });
            item.addEventListener("dragend", () => {
                draggedIndex = null;
                item.classList.remove("dragging");
                clearSceneRowDropIndicators();
                rowDropPosition.clear();
            });
            item.addEventListener("dragover", (event) => {
                event.preventDefault();
                if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
                if (draggedSceneMatrixCueRef) {
                    const timelineSlot = timeline[slotIndex];
                    clearSceneRowDropIndicators();
                    if (timelineSlot?.type === "cues") item.classList.add("drop-target");
                    return;
                }
                if (!Number.isFinite(draggedIndex) || draggedIndex === slotIndex) return;
                updateRowDropFromPointer(event.clientY);
            });
            item.addEventListener("dragleave", (event) => {
                const nextTarget = event.relatedTarget;
                if (nextTarget && item.contains(nextTarget)) return;
                item.classList.remove("drop-target");
            });
            item.addEventListener("drop", (event) => {
                item.classList.remove("drop-target", "drop-insert-before", "drop-insert-after");
                // Dragging one cue-box out of a parallel row => create own row below target.
                if (draggedSceneMatrixCueRef) {
                    event.preventDefault();
                    const fromSlotIndex = parseInt(draggedSceneMatrixCueRef?.slotIndex, 10);
                    const fromItemIndex = parseInt(draggedSceneMatrixCueRef?.itemIndex, 10);
                    if (Number.isFinite(fromSlotIndex) && Number.isFinite(fromItemIndex) && timeline[slotIndex]?.type === "cues") {
                        const pulled = removeCueItemFromSlot(fromSlotIndex, fromItemIndex);
                        if (pulled.moved) {
                            let targetSlotIndex = slotIndex;
                            if (fromSlotIndex < targetSlotIndex) targetSlotIndex -= 1;
                            const targetSlot = pulled.next[targetSlotIndex];
                            if (targetSlot?.type === "cues") {
                                const nextItems = Array.isArray(targetSlot.items) ? [...targetSlot.items, pulled.moved] : [pulled.moved];
                                pulled.next[targetSlotIndex] = { ...targetSlot, items: nextItems };
                            } else {
                                pulled.next.splice(Math.max(0, targetSlotIndex + 1), 0, { type: "cues", items: [pulled.moved] });
                                targetSlotIndex = Math.max(0, targetSlotIndex + 1);
                            }
                            selectedSceneCue.sceneTimeline = pulled.next;
                            syncSceneCueDerivedAssignments(selectedSceneCue, fixture);
                            draggedSceneMatrixCueRef = null;
                            selectedSceneTimelineIndex = Math.max(0, targetSlotIndex);
                            renderLightingModal();
                            autoSave();
                            return;
                        }
                    }
                }
                if (!Number.isFinite(draggedIndex) || draggedIndex === slotIndex) return;
                // Row reordering is handled by list-level drop for stable hit-testing.
                event.preventDefault();
            });
            const main = document.createElement("div");
            main.className = "lighting-list-item-main";
            const nameLabel = document.createElement("div");
            const meta = document.createElement("div");
            meta.className = "lighting-item-meta";
            if (slot.type === "delay") {
                nameLabel.textContent = `Delay`;
                meta.textContent = `${lightingClampInt(slot.ms, 0, 600000, 0)} ms`;
            } else {
                const items = Array.isArray(slot.items) ? slot.items : [];
                const cueEntries = items.map((entry) => {
                    const sourceFixture = getLightingFixtureById(entry.fixtureId);
                    const sourceCue = sourceFixture?.cues?.find((candidate) => parseInt(candidate?.id, 10) === entry.cueId);
                    return {
                        fixtureId: entry.fixtureId,
                        cueId: entry.cueId,
                        label: `${sourceFixture?.name || `Lamp ${entry.fixtureId}`} - ${sourceCue?.name || `Cue ${entry.cueId}`}`
                    };
                });
                const boxes = document.createElement("div");
                boxes.className = "lighting-parallel-cue-grid";
                cueEntries.forEach((cueEntry, boxIndex) => {
                    const cueBox = document.createElement("button");
                    cueBox.type = "button";
                    cueBox.className = "lighting-parallel-cue-box";
                    const cueFixture = getLightingFixtureById(cueEntry.fixtureId);
                    if (isLightingGroupFixture(cueFixture)) cueBox.classList.add("scene-ref");
                    const cueKey = `${slotIndex}:${boxIndex}`;
                    if (
                        parseInt(selectedSceneEffectsCueRef?.fixtureId, 10) === parseInt(cueEntry.fixtureId, 10) &&
                        parseInt(selectedSceneEffectsCueRef?.cueId, 10) === parseInt(cueEntry.cueId, 10)
                    ) {
                        cueBox.classList.add("selected");
                    }
                    if (lightingSceneTestActiveCueKeys?.has(cueKey)) {
                        cueBox.classList.add("scene-test-active");
                    }
                    cueBox.textContent = cueEntry.label;
                    cueBox.title = cueEntry.label;
                    cueBox.draggable = true;
                    cueBox.addEventListener("dragstart", (dragEvent) => {
                        dragEvent.stopPropagation();
                        draggedSceneMatrixCueRef = { slotIndex, itemIndex: boxIndex };
                    });
                    cueBox.addEventListener("dragend", () => {
                        draggedSceneMatrixCueRef = null;
                        clearSceneRowDropIndicators();
                    });
                    cueBox.addEventListener("dragover", (dragEvent) => {
                        if (draggedLightingCueRef) {
                            dragEvent.preventDefault();
                            dragEvent.stopPropagation();
                            if (dragEvent.dataTransfer) dragEvent.dataTransfer.dropEffect = "copy";
                            clearSceneRowDropIndicators();
                            item.classList.add("drop-target");
                            return;
                        }
                        if (draggedSceneMatrixCueRef) {
                            dragEvent.preventDefault();
                            dragEvent.stopPropagation();
                            if (dragEvent.dataTransfer) dragEvent.dataTransfer.dropEffect = "move";
                            clearSceneRowDropIndicators();
                            item.classList.add("drop-target");
                            return;
                        }
                        if (!Number.isFinite(draggedIndex) || draggedIndex === slotIndex) return;
                        dragEvent.preventDefault();
                        dragEvent.stopPropagation();
                        if (dragEvent.dataTransfer) dragEvent.dataTransfer.dropEffect = "move";
                        setRowInsertIndicator(item, slotIndex, dragEvent.clientY);
                    });
                    cueBox.addEventListener("drop", (dropEvent) => {
                        if (draggedLightingCueRef) {
                            dropEvent.preventDefault();
                            dropEvent.stopPropagation();
                            const sourceFixtureId = parseInt(draggedLightingCueRef?.sourceFixtureId, 10);
                            const sourceCueId = parseInt(draggedLightingCueRef?.cueId, 10);
                            if (!Number.isFinite(sourceFixtureId) || !Number.isFinite(sourceCueId)) return;
                            if (!canInsertSceneReference(fixture, sourceFixtureId, sourceCueId)) {
                                showSceneCycleBlockedNotice();
                                return;
                            }
                            const next = Array.isArray(selectedSceneCue.sceneTimeline) ? [...selectedSceneCue.sceneTimeline] : [];
                            const targetSlot = next[slotIndex];
                            if (!targetSlot || targetSlot.type !== "cues") return;
                            targetSlot.items = [...(Array.isArray(targetSlot.items) ? targetSlot.items : []), { fixtureId: sourceFixtureId, cueId: sourceCueId }];
                            selectedSceneCue.sceneTimeline = next;
                            syncSceneCueDerivedAssignments(selectedSceneCue, fixture);
                            draggedLightingCueRef = null;
                            clearSceneRowDropIndicators();
                            renderLightingModal();
                            autoSave();
                            return;
                        }
                        if (!draggedSceneMatrixCueRef) return;
                        dropEvent.preventDefault();
                        dropEvent.stopPropagation();
                        const fromSlotIndex = parseInt(draggedSceneMatrixCueRef?.slotIndex, 10);
                        const fromItemIndex = parseInt(draggedSceneMatrixCueRef?.itemIndex, 10);
                        if (!Number.isFinite(fromSlotIndex) || !Number.isFinite(fromItemIndex)) return;
                        const pulled = removeCueItemFromSlot(fromSlotIndex, fromItemIndex);
                        if (!pulled.moved) return;
                        let targetSlotIndex = slotIndex;
                        if (fromSlotIndex < targetSlotIndex) targetSlotIndex -= 1;
                        const targetSlot = pulled.next[targetSlotIndex];
                        if (!targetSlot || targetSlot.type !== "cues") return;
                        pulled.next[targetSlotIndex] = {
                            ...targetSlot,
                            items: [...(Array.isArray(targetSlot.items) ? targetSlot.items : []), pulled.moved]
                        };
                        selectedSceneCue.sceneTimeline = pulled.next;
                        syncSceneCueDerivedAssignments(selectedSceneCue, fixture);
                        draggedSceneMatrixCueRef = null;
                        selectedSceneTimelineIndex = Math.max(0, targetSlotIndex);
                        clearSceneRowDropIndicators();
                        renderLightingModal();
                        autoSave();
                    });
                    cueBox.addEventListener("click", (clickEvent) => {
                        clickEvent.stopPropagation();
                        selectedSceneTimelineIndex = slotIndex;
                        const selectedFixture = getLightingFixtureById(cueEntry.fixtureId);
                        if (isLightingGroupFixture(selectedFixture)) {
                            selectedSceneEffectsCueRef = null;
                        } else {
                            selectedSceneEffectsCueRef = { fixtureId: cueEntry.fixtureId, cueId: cueEntry.cueId };
                        }
                        renderLightingModal();
                    });
                    boxes.appendChild(cueBox);
                });
                nameLabel.appendChild(boxes);
                meta.textContent = `${items.length} cue${items.length === 1 ? "" : "s"} (parallel)`;
                item.addEventListener("click", () => {
                    selectedSceneTimelineIndex = slotIndex;
                    selectedSceneEffectsCueRef = null;
                    renderLightingModal();
                });
            }
            main.appendChild(nameLabel);
            main.appendChild(meta);
            item.appendChild(main);

            const deleteBtn = document.createElement("button");
            deleteBtn.type = "button";
            deleteBtn.className = "lighting-delete-btn";
            deleteBtn.textContent = "X";
            deleteBtn.addEventListener("click", (event) => {
                event.stopPropagation();
                removeSlotBtn(slotIndex);
            });
            item.appendChild(deleteBtn);
            list.appendChild(item);
            list.appendChild(createCueInsertZone(slotIndex + 1));
        });
        lightingUI.channelEditor.innerHTML = "";
        const hint = document.createElement("div");
        hint.className = "lighting-item-meta";
        hint.style.marginBottom = "8px";
        hint.textContent = "Drag a whole row to reorder. Drag a blue cue box onto another cue row/box to add it to that parallel group.";
        lightingUI.channelEditor.appendChild(hint);
        lightingUI.channelEditor.appendChild(list);
        list.addEventListener("dragover", (event) => {
            if (draggedLightingCueRef) {
                event.preventDefault();
                if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
                updateRowDropFromPointer(event.clientY);
                return;
            }
            if (draggedSceneMatrixCueRef) {
                event.preventDefault();
                if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
                updateRowDropFromPointer(event.clientY);
                return;
            }
            if (!Number.isFinite(draggedIndex)) return;
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
            updateRowDropFromPointer(event.clientY);
        });
        list.addEventListener("drop", (event) => {
            if (draggedLightingCueRef) {
                event.preventDefault();
                const sourceFixtureId = parseInt(draggedLightingCueRef?.sourceFixtureId, 10);
                const sourceCueId = parseInt(draggedLightingCueRef?.cueId, 10);
                if (!Number.isFinite(sourceFixtureId) || !Number.isFinite(sourceCueId)) return;
                if (!canInsertSceneReference(fixture, sourceFixtureId, sourceCueId)) {
                    showSceneCycleBlockedNotice();
                    return;
                }
                const next = Array.isArray(selectedSceneCue.sceneTimeline) ? [...selectedSceneCue.sceneTimeline] : [];
                let insertIndex = next.length;
                if (Number.isFinite(hoveredRowIndex)) {
                    insertIndex = hoveredInsertPos === "before" ? hoveredRowIndex : hoveredRowIndex + 1;
                }
                insertIndex = Math.max(0, Math.min(insertIndex, next.length));
                next.splice(insertIndex, 0, { type: "cues", items: [{ fixtureId: sourceFixtureId, cueId: sourceCueId }] });
                selectedSceneCue.sceneTimeline = next;
                syncSceneCueDerivedAssignments(selectedSceneCue, fixture);
                draggedLightingCueRef = null;
                selectedSceneTimelineIndex = insertIndex;
                clearSceneRowDropIndicators();
                renderLightingModal();
                autoSave();
                return;
            }
            if (draggedSceneMatrixCueRef) {
                event.preventDefault();
                const fromSlotIndex = parseInt(draggedSceneMatrixCueRef?.slotIndex, 10);
                const fromItemIndex = parseInt(draggedSceneMatrixCueRef?.itemIndex, 10);
                moveCueToOwnSlot(fromSlotIndex, fromItemIndex, Number.isFinite(hoveredRowIndex) ? (hoveredInsertPos === "before" ? hoveredRowIndex : hoveredRowIndex + 1) : timeline.length);
                return;
            }
            if (!Number.isFinite(draggedIndex)) return;
            event.preventDefault();
            const targetIndex = Number.isFinite(hoveredRowIndex) ? hoveredRowIndex : null;
            if (!Number.isFinite(targetIndex) || draggedIndex === targetIndex) {
                clearSceneRowDropIndicators();
                return;
            }
            const next = Array.isArray(selectedSceneCue.sceneTimeline) ? [...selectedSceneCue.sceneTimeline] : [];
            const [moved] = next.splice(draggedIndex, 1);
            const preferred = hoveredInsertPos || rowDropPosition.get(targetIndex) || "before";
            let insertAt = targetIndex;
            if (draggedIndex < targetIndex) insertAt -= 1;
            if (preferred === "after") insertAt += 1;
            insertAt = Math.max(0, Math.min(next.length, insertAt));
            next.splice(insertAt, 0, moved);
            selectedSceneCue.sceneTimeline = next;
            syncSceneCueDerivedAssignments(selectedSceneCue, fixture);
            clearSceneRowDropIndicators();
            renderLightingModal();
            autoSave();
        });
        lightingUI.channelEditor.ondragover = null;
        lightingUI.channelEditor.ondrop = null;
        return;
    }
    const cue = getSelectedLightingCue();
    if (!cue) {
        lightingUI.channelEditor.ondragover = null;
        lightingUI.channelEditor.ondrop = null;
        lightingUI.channelEditor.innerHTML = `<div class="lighting-empty">Select a cue to edit channels.</div>`;
        return;
    }

    cue.channels = normalizeLightingChannelsData(cue.channels);
    lightingUI.channelEditor.ondragover = null;
    lightingUI.channelEditor.ondrop = null;
    lightingUI.channelEditor.innerHTML = "";

    if (!cue.channels.length) {
        lightingUI.channelEditor.innerHTML = `<div class="lighting-empty">No channels in this cue yet.</div>`;
        return;
    }

    cue.channels.forEach((entry, idx) => {
        const row = document.createElement("div");
        row.className = "lighting-channel-row";

        const label = document.createElement("span");
        label.textContent = getFixturePresetLabel(fixture, entry);

        const slider = document.createElement("input");
        slider.type = "range";
        slider.min = "0";
        slider.max = "255";
        slider.value = String(entry.value ?? 0);

        const number = document.createElement("input");
        number.type = "number";
        number.min = "0";
        number.max = "255";
        number.value = String(entry.value ?? 0);

        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "lighting-channel-delete";
        deleteBtn.textContent = "X";

        const setValue = (raw) => {
            const value = lightingClampInt(raw, 0, 255, 0);
            entry.value = value;
            slider.value = String(value);
            number.value = String(value);
            renderLightingCuePreview();
            autoSave();
        };

        slider.addEventListener("input", () => setValue(slider.value));
        number.addEventListener("change", () => setValue(number.value));
        deleteBtn.addEventListener("click", () => {
            cue.channels.splice(idx, 1);
            renderLightingChannelEditor();
            renderLightingCuePreview();
            autoSave();
        });

        row.appendChild(label);
        row.appendChild(slider);
        row.appendChild(number);
        row.appendChild(deleteBtn);
        lightingUI.channelEditor.appendChild(row);
    });
}

function renderLightingEffects() {
    const fixture = getSelectedLightingFixture();
    const isScene = isLightingGroupFixture(fixture);
    const inspectedSceneCue = isScene ? getSelectedSceneEffectsCue() : null;
    const cue = (isScene && inspectedSceneCue?.cue) ? inspectedSceneCue.cue : getSelectedLightingCue();
    const hasCue = !!cue;
    const showEffects = isScene ? !!inspectedSceneCue?.cue : hasCue;

    if (cue) ensureCueEffects(cue);
    if (lightingUI.effectsSection) {
        lightingUI.effectsSection.style.display = showEffects ? "" : "none";
    }

    if (lightingUI.effectDelay) {
        lightingUI.effectDelay.disabled = !hasCue;
        lightingUI.effectDelay.value = hasCue ? String(cue.effects.delayMs) : "0";
    }
    if (lightingUI.effectFadeIn) {
        lightingUI.effectFadeIn.disabled = !hasCue;
        lightingUI.effectFadeIn.value = hasCue ? String(cue.effects.fadeInMs) : "0";
    }
    if (lightingUI.effectFadeOut) {
        lightingUI.effectFadeOut.disabled = !hasCue;
        lightingUI.effectFadeOut.value = hasCue ? String(cue.effects.fadeOutMs) : "0";
    }
    if (lightingUI.effectDuration) {
        lightingUI.effectDuration.disabled = !hasCue;
        lightingUI.effectDuration.value = hasCue ? String(cue.effects.durationMs) : "0";
    }
    if (lightingUI.effectsNote) {
        if (isScene) {
            lightingUI.effectsNote.textContent = hasCue
                ? `Editing effects for \"${inspectedSceneCue?.fixture?.name || "Lamp"} / ${cue.name}\".`
                : "Click a cue box in the scene matrix to edit that cue's effects.";
        } else {
            lightingUI.effectsNote.textContent = hasCue ? `Editing effects for \"${cue.name}\".` : "Select a cue to edit effects.";
        }
    }
    const timeline = (isScene && cue) ? normalizeSceneTimeline(cue) : [];
    const idx = Number.isFinite(selectedSceneTimelineIndex) ? selectedSceneTimelineIndex : -1;
    const slot = idx >= 0 ? timeline[idx] : null;
    const isDelay = slot?.type === "delay";
    if (lightingUI.sceneDelaySection) {
        lightingUI.sceneDelaySection.style.display = isDelay ? "" : "none";
    }
    if (lightingUI.sceneDelayInput) {
        lightingUI.sceneDelayInput.disabled = !isDelay;
        lightingUI.sceneDelayInput.value = isDelay ? String(lightingClampInt(slot.ms, 0, 600000, 0)) : "1000";
    }
    if (lightingUI.sceneDelayNote) {
        lightingUI.sceneDelayNote.textContent = slot?.type === "delay"
            ? `Editing delay block #${idx + 1}.`
            : "Select a delay block in the cue matrix.";
    }
}

function renderLightingGroupAssignmentPanel() {
    if (!lightingUI.groupAssignmentList || !lightingUI.groupAssignLamp || !lightingUI.groupAssignCue) return;
    const fixture = getSelectedLightingFixture();
    if (!isLightingGroupFixture(fixture)) {
        lightingUI.groupAssignmentList.innerHTML = "";
        lightingUI.groupAssignLamp.innerHTML = "";
        lightingUI.groupAssignCue.innerHTML = "";
        if (lightingUI.groupAssignBtn) lightingUI.groupAssignBtn.disabled = true;
        return;
    }
    const members = getLightingGroupMemberFixtures(fixture);
    lightingUI.groupAssignLamp.innerHTML = "";
    members.forEach((memberFixture) => {
        const option = document.createElement("option");
        option.value = String(memberFixture.id);
        option.textContent = memberFixture.name || `Lamp ${memberFixture.id}`;
        lightingUI.groupAssignLamp.appendChild(option);
    });
    const lampId = parseInt(lightingUI.groupAssignLamp.value, 10);
    const activeLamp = Number.isFinite(lampId) ? getLightingFixtureById(lampId) : members[0];
    if (activeLamp && String(lightingUI.groupAssignLamp.value || "") !== String(activeLamp.id)) {
        lightingUI.groupAssignLamp.value = String(activeLamp.id);
    }
    lightingUI.groupAssignCue.innerHTML = "";
    const lampCues = Array.isArray(activeLamp?.cues) ? activeLamp.cues : [];
    lampCues.forEach((sourceCue) => {
        const option = document.createElement("option");
        option.value = String(sourceCue.id);
        option.textContent = sourceCue.name || `Cue ${sourceCue.id}`;
        lightingUI.groupAssignCue.appendChild(option);
    });
    if (lightingUI.groupAssignBtn) {
        lightingUI.groupAssignBtn.disabled = !activeLamp || !lampCues.length || !selectedLightingCueId;
    }
    const selectedGroupCue = getSelectedLightingCue();
    if (!selectedGroupCue) {
        lightingUI.groupAssignmentList.innerHTML = `<div class="lighting-empty">Select a Scene Cue first.</div>`;
        return;
    }
    ensureGroupCueAssignments(selectedGroupCue);
    const assignments = selectedGroupCue.groupAssignments || [];
    if (!assignments.length) {
        lightingUI.groupAssignmentList.innerHTML = `<div class="lighting-empty">No cue assignments yet.</div>`;
        return;
    }
    lightingUI.groupAssignmentList.innerHTML = "";
    assignments.forEach((assignment) => {
        const sourceFixture = getLightingFixtureById(assignment.fixtureId);
        const sourceCue = sourceFixture?.cues?.find((entry) => parseInt(entry?.id, 10) === assignment.cueId);
        if (!sourceFixture || !sourceCue) return;
        const row = document.createElement("div");
        row.className = "lighting-channel-row";
        const label = document.createElement("span");
        label.textContent = sourceFixture.name || `Lamp ${sourceFixture.id}`;
        row.appendChild(label);
        const cueLabel = document.createElement("span");
        cueLabel.textContent = sourceCue.name || `Cue ${sourceCue.id}`;
        cueLabel.style.opacity = "0.85";
        row.appendChild(cueLabel);
        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "lighting-channel-delete";
        deleteBtn.textContent = "X";
        deleteBtn.addEventListener("click", () => {
            if (removeGroupAssignment(fixture, sourceFixture.id, sourceCue.id)) {
                ensureLightingSelectionValidity();
                renderLightingModal();
                autoSave();
            }
        });
        row.appendChild(deleteBtn);
        lightingUI.groupAssignmentList.appendChild(row);
    });
}

function renderLightingTestCueButton() {
    if (!lightingUI.testCueBtn) return;
    const fixture = getSelectedLightingFixture();
    const cue = getSelectedLightingCue();
    const hasCue = !!fixture && !!cue && !isLightingGroupFixture(fixture);
    lightingUI.testCueBtn.disabled = !hasCue || lightingTestCueBusy;
    lightingUI.testCueBtn.textContent = lightingTestCueBusy ? "Testing..." : "Test Cue";
}

function renderLightingPresetHeader() {
    if (!lightingUI.selectedPresetTitle) return;
    const preset = getSelectedLightingPreset();
    lightingUI.selectedPresetTitle.textContent = preset ? `Preset Channels - ${preset.name}` : "Preset Channels";
}

function renderLightingPresetList() {
    if (!lightingUI.presetList) return;
    lightingUI.presetList.innerHTML = "";

    if (!lightingPresets.length) {
        const empty = document.createElement("li");
        empty.className = "lighting-empty";
        empty.textContent = "No presets available.";
        lightingUI.presetList.appendChild(empty);
        return;
    }

    lightingPresets.forEach((preset) => {
        const item = document.createElement("li");
        item.className = `lighting-list-item${preset.id === selectedLightingPresetId ? " selected" : ""}`;

        const main = document.createElement("div");
        main.className = "lighting-list-item-main";
        const nameLabel = document.createElement("div");
        nameLabel.textContent = preset.name;
        nameLabel.title = "Double click to rename";
        const meta = document.createElement("div");
        meta.className = "lighting-item-meta";
        meta.textContent = `${(preset.channels || []).length} channels`;
        main.appendChild(nameLabel);
        main.appendChild(meta);
        item.appendChild(main);

        item.addEventListener("click", () => {
            if (selectedLightingPresetId === preset.id) return;
            selectedLightingPresetId = preset.id;
            renderLightingPresetModal();
        });

        const startRenamePreset = (event) => {
            event.stopPropagation();
            const input = document.createElement("input");
            input.type = "text";
            input.className = "lighting-name-input";
            input.value = preset.name;
            let finished = false;

            const commit = (apply) => {
                if (finished) return;
                finished = true;
                if (apply) {
                    const nextName = (input.value || "").trim();
                    if (nextName) preset.name = nextName;
                    autoSave();
                }
                renderLightingPresetModal();
                renderLightingModal();
            };

            input.addEventListener("keydown", (keyEvent) => {
                if (keyEvent.key === "Enter") commit(true);
                if (keyEvent.key === "Escape") commit(false);
            });
            input.addEventListener("blur", () => commit(true));

            main.replaceChild(input, nameLabel);
            input.focus();
            input.select();
        };
        nameLabel.addEventListener("dblclick", startRenamePreset);
        main.addEventListener("dblclick", startRenamePreset);

        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "lighting-delete-btn";
        deleteBtn.textContent = "X";
        deleteBtn.addEventListener("click", (event) => {
            event.stopPropagation();
            lightingPresets = lightingPresets.filter((entry) => entry.id !== preset.id);
            lightingFixtures.forEach((fixture) => {
                if (fixture.presetId !== "custom" && parseInt(fixture.presetId, 10) === preset.id) {
                    fixture.presetId = "custom";
                    fixture.cues = (fixture.cues || []).map((cue) => ({
                        ...cue,
                        channels: normalizeLightingChannelsData(cue.channels).map((entry) => ({
                            channel: entry.channel,
                            value: entry.value,
                            name: entry.name || "",
                            presetChannelId: null
                        }))
                    }));
                }
            });
            ensureLightingPresetSelectionValidity();
            renderLightingPresetModal();
            renderLightingModal();
            autoSave();
        });
        item.appendChild(deleteBtn);
        lightingUI.presetList.appendChild(item);
    });
}

function renderLightingPresetChannelList() {
    if (!lightingUI.presetChannelList) return;
    lightingUI.presetChannelList.innerHTML = "";
    const preset = getSelectedLightingPreset();

    if (!preset) {
        const empty = document.createElement("li");
        empty.className = "lighting-empty";
        empty.textContent = "Select a preset first.";
        lightingUI.presetChannelList.appendChild(empty);
        return;
    }

    preset.channels = normalizeLightingPresetChannelsData(preset.channels);
    if (!preset.channels.length) {
        const empty = document.createElement("li");
        empty.className = "lighting-empty";
        empty.textContent = "No channels in this preset yet.";
        lightingUI.presetChannelList.appendChild(empty);
        return;
    }

    preset.channels.forEach((channel) => {
        const item = document.createElement("li");
        item.className = "lighting-list-item";

        const main = document.createElement("div");
        main.className = "lighting-list-item-main";
        const nameLabel = document.createElement("div");
        nameLabel.textContent = channel.name;
        nameLabel.title = "Double click to rename";
        const meta = document.createElement("div");
        meta.className = "lighting-item-meta";
        meta.textContent = `DMX ${lightingClampInt(channel?.address, 1, 512, 1)}`;
        main.appendChild(nameLabel);
        main.appendChild(meta);
        item.appendChild(main);

        const startRenameChannel = (event) => {
            event.stopPropagation();
            const input = document.createElement("input");
            input.type = "text";
            input.className = "lighting-name-input";
            input.value = channel.name;
            let finished = false;

            const commit = (apply) => {
                if (finished) return;
                finished = true;
                if (apply) {
                    const oldPresetAddressById = snapshotPresetAddressMap(preset);
                    const nextName = (input.value || "").trim();
                    if (nextName) channel.name = nextName;
                    syncAllFixturesUsingPreset(preset.id, { oldPresetAddressById });
                    autoSave();
                }
                renderLightingPresetModal();
                renderLightingModal();
            };

            input.addEventListener("keydown", (keyEvent) => {
                if (keyEvent.key === "Enter") commit(true);
                if (keyEvent.key === "Escape") commit(false);
            });
            input.addEventListener("blur", () => commit(true));

            main.replaceChild(input, nameLabel);
            input.focus();
            input.select();
        };
        nameLabel.addEventListener("dblclick", startRenameChannel);
        main.addEventListener("dblclick", startRenameChannel);

        const addressInput = document.createElement("input");
        addressInput.type = "number";
        addressInput.className = "lighting-name-input";
        addressInput.min = "1";
        addressInput.max = "512";
        addressInput.value = String(lightingClampInt(channel?.address, 1, 512, 1));
        addressInput.style.width = "88px";
        addressInput.addEventListener("click", (event) => event.stopPropagation());
        addressInput.addEventListener("change", () => {
            const oldPresetAddressById = snapshotPresetAddressMap(preset);
            channel.address = lightingClampInt(addressInput.value, 1, 512, 1);
            addressInput.value = String(channel.address);
            syncAllFixturesUsingPreset(preset.id, { oldPresetAddressById });
            renderLightingPresetModal();
            renderLightingModal();
            autoSave();
        });
        item.appendChild(addressInput);

        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "lighting-delete-btn";
        deleteBtn.textContent = "X";
        deleteBtn.addEventListener("click", () => {
            const oldPresetAddressById = snapshotPresetAddressMap(preset);
            preset.channels = preset.channels.filter((entry) => entry.id !== channel.id);
            syncAllFixturesUsingPreset(preset.id, { oldPresetAddressById });
            renderLightingPresetModal();
            renderLightingModal();
            autoSave();
        });

        item.appendChild(deleteBtn);
        lightingUI.presetChannelList.appendChild(item);
    });
}

function renderLightingPresetModal() {
    ensureLightingPresetSelectionValidity();
    renderLightingPresetHeader();
    renderLightingPresetList();
    renderLightingPresetChannelList();
}

function renderLightingModal() {
    ensureLightingSelectionValidity();
    updateLightingMiddleModeUI();
    renderLightingHeader();
    renderLightingFixtureList();
    renderLightingGroupList();
    renderLightingCueList();
    renderLightingChannelAdder();
    renderLightingChannelEditor();
    renderLightingGroupAssignmentPanel();
    renderLightingCuePreview();
    renderLightingEffects();
    renderLightingTestCueButton();
    if (selectedNode && selectedNode.type === "escape/Puzzle" && scriptingUI.overlay?.style.display === "flex") {
        renderScriptingRules(selectedNode);
    }
    if (roomScriptingUI.overlay?.style.display === "flex") {
        renderRoomScriptingRules();
    }
}

function resetLightingState(rawLightingConfig) {
    const normalized = normalizeLightingConfigData(rawLightingConfig || {});
    lightingFixtures = normalized.fixtures;
    lightingPresets = normalized.presets;
    nextLightingFixtureId = lightingFixtures.reduce((max, fixture) => Math.max(max, fixture.id || 0), 0) + 1;
    nextLightingCueId = getAllLightingCues().reduce((max, cue) => Math.max(max, cue.id || 0), 0) + 1;
    nextLightingPresetId = lightingPresets.reduce((max, preset) => Math.max(max, preset.id || 0), 0) + 1;
    ensureLightingSelectionValidity();
    ensureLightingPresetSelectionValidity();
    renderLightingModal();
    renderLightingPresetModal();
}

lightingUI.openBtn?.addEventListener("click", () => {
    renderLightingModal();
    if (lightingUI.overlay) lightingUI.overlay.style.display = "flex";
});

function closeLightingModal() {
    stopLightingTestsImmediate();
    if (lightingUI.overlay) lightingUI.overlay.style.display = "none";
    closeLightingPresetModal();
}

function closeLightingPresetModal() {
    if (lightingUI.presetOverlay) lightingUI.presetOverlay.style.display = "none";
}

lightingUI.closeBtn?.addEventListener("click", closeLightingModal);
lightingUI.overlay?.addEventListener("click", (event) => {
    if (event.target === lightingUI.overlay) closeLightingModal();
});
lightingUI.overlay?.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const actionable = target.closest("button, .lighting-list-item, .lighting-parallel-cue-box");
    if (!actionable) return;
    if (actionable === lightingUI.testCueBtn || actionable === lightingUI.testSceneBtn) return;
    stopLightingTestsImmediate();
});
lightingUI.openPresetBtn?.addEventListener("click", () => {
    renderLightingPresetModal();
    if (lightingUI.presetOverlay) lightingUI.presetOverlay.style.display = "flex";
});
lightingUI.presetCloseBtn?.addEventListener("click", closeLightingPresetModal);
lightingUI.presetOverlay?.addEventListener("click", (event) => {
    if (event.target === lightingUI.presetOverlay) closeLightingPresetModal();
});

lightingUI.cueList?.addEventListener("dragover", (event) => {
    const sourceCue = getDraggedCueFromRef();
    const targetFixture = getSelectedLightingFixture();
    if (!sourceCue || !targetFixture || isLightingGroupFixture(targetFixture)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    lightingUI.cueList.classList.add("lighting-drop-active");
});
lightingUI.cueList?.addEventListener("dragleave", () => {
    lightingUI.cueList.classList.remove("lighting-drop-active");
});
lightingUI.cueList?.addEventListener("drop", (event) => {
    const sourceCue = getDraggedCueFromRef();
    const targetFixture = getSelectedLightingFixture();
    lightingUI.cueList.classList.remove("lighting-drop-active");
    if (!sourceCue || !targetFixture || isLightingGroupFixture(targetFixture)) return;
    event.preventDefault();
    const sourceFixture = getLightingFixtureById(draggedLightingCueRef?.sourceFixtureId);
    const copied = copyCueToFixture(sourceCue, targetFixture, { selectTarget: true, sourceFixture });
    if (!copied) return;
    renderLightingModal();
    autoSave();
});

lightingUI.addFixtureBtn?.addEventListener("click", () => {
    const name = (lightingUI.fixtureName?.value || "").trim() || `Lamp ${nextLightingFixtureId}`;
    const fixture = {
        id: nextLightingFixtureId++,
        name,
        presetId: "custom",
        startAddress: 1,
        cues: []
    };
    lightingFixtures.push(fixture);
    selectedLightingFixtureId = fixture.id;
    selectedLightingCueId = null;
    if (lightingUI.fixtureName) lightingUI.fixtureName.value = "";
    renderLightingModal();
    autoSave();
});

lightingUI.addGroupBtn?.addEventListener("click", () => {
    const name = (lightingUI.groupName?.value || "").trim() || `Scene ${nextLightingFixtureId}`;
    const fixture = {
        id: nextLightingFixtureId++,
        name,
        presetId: "group",
        startAddress: 1,
        groupMembers: [],
        cues: [{
            id: nextLightingCueId++,
            name,
            channels: [],
            effects: normalizeLightingEffectsData(null),
            groupAssignments: []
        }]
    };
    lightingFixtures.push(fixture);
    selectedLightingFixtureId = fixture.id;
    selectedLightingCueId = fixture.cues[0].id;
    selectedLightingGroupMemberId = null;
    if (lightingUI.groupName) lightingUI.groupName.value = "";
    renderLightingModal();
    autoSave();
});

lightingUI.addCueBtn?.addEventListener("click", () => {
    const fixture = getSelectedLightingFixture();
    if (!fixture) return;
    if (isLightingGroupFixture(fixture)) {
        selectedLightingCueId = (fixture.cues && fixture.cues[0]) ? fixture.cues[0].id : null;
        renderLightingModal();
        return;
    }
    fixture.cues = Array.isArray(fixture.cues) ? fixture.cues : [];

    const name = (lightingUI.cueName?.value || "").trim() || `Cue ${nextLightingCueId}`;
    const cue = {
        id: nextLightingCueId++,
        name,
        channels: createChannelsFromFixturePreset(fixture),
        effects: normalizeLightingEffectsData(null)
    };

    fixture.cues.push(cue);
    selectedLightingCueId = cue.id;
    if (lightingUI.cueName) lightingUI.cueName.value = "";
    renderLightingModal();
    autoSave();
});

lightingUI.testCueBtn?.addEventListener("click", async () => {
    const fixture = getSelectedLightingFixture();
    const cue = getSelectedLightingCue();
    if (!fixture || !cue || lightingTestCueBusy || isLightingGroupFixture(fixture)) return;

    clearLightingSceneTestPlayback();
    clearLightingCueTestHighlight();
    lightingTestCueBusy = true;
    renderLightingTestCueButton();
    if (lightingUI.effectsNote) {
        lightingUI.effectsNote.textContent = `Testing cue \"${cue.name}\"...`;
    }

    try {
        const res = await fetch('/api/runtime/dmx/cue/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fixtureId: fixture.id, cueId: cue.id })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data?.success) {
            throw new Error(data?.error || `HTTP ${res.status}`);
        }
        if (lightingUI.effectsNote) {
            if (data?.infinite === true) {
                lightingUI.effectsNote.textContent = "Cue test running (infinite duration).";
                setLightingCueTestHighlight(fixture.id, cue.id, null, true);
            } else {
                const durationMs = Number.isFinite(parseInt(data.durationMs, 10)) ? parseInt(data.durationMs, 10) : 0;
                const durationSec = Math.max(0, durationMs / 1000);
                lightingUI.effectsNote.textContent = `Cue test running (${durationSec.toFixed(1)}s).`;
                setLightingCueTestHighlight(fixture.id, cue.id, durationMs, false);
            }
            renderLightingModal();
        }
    } catch (err) {
        clearLightingCueTestHighlight();
        if (lightingUI.effectsNote) {
            lightingUI.effectsNote.textContent = `Cue test failed: ${err?.message || 'unknown error'}`;
        }
    } finally {
        lightingTestCueBusy = false;
        renderLightingTestCueButton();
        setTimeout(() => renderLightingEffects(), 2000);
    }
});

lightingUI.testSceneBtn?.addEventListener("click", async () => {
    const fixture = getSelectedLightingFixture();
    const cue = getSelectedLightingCue();
    if (!fixture || !cue || lightingTestCueBusy || !isLightingGroupFixture(fixture)) return;

    selectedSceneTimelineIndex = null;
    selectedSceneEffectsCueRef = null;
    clearLightingCueTestHighlight();
    renderLightingModal();
    clearLightingSceneTestPlayback();
    scheduleLightingSceneTestPlayback(fixture, cue);
    lightingTestCueBusy = true;
    if (lightingUI.testSceneBtn) {
        lightingUI.testSceneBtn.disabled = true;
        lightingUI.testSceneBtn.textContent = "Testing...";
    }

    try {
        const res = await fetch('/api/runtime/dmx/cue/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fixtureId: fixture.id, cueId: cue.id })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data?.success) {
            throw new Error(data?.error || `HTTP ${res.status}`);
        }
    } catch (err) {
        clearLightingSceneTestPlayback();
    } finally {
        lightingTestCueBusy = false;
        if (lightingUI.testSceneBtn) {
            lightingUI.testSceneBtn.disabled = false;
            lightingUI.testSceneBtn.textContent = "Test Scene";
        }
        renderLightingModal();
    }
});

lightingUI.addChannelBtn?.addEventListener("click", () => {
    const fixture = getSelectedLightingFixture();
    if (!fixture) return;
    if (isLightingGroupFixture(fixture)) {
        const sceneCue = getSelectedLightingCue();
        if (!sceneCue) return;
        const selectedRef = String(lightingUI.groupCueSourceSelect?.value || "");
        const [fixtureRaw, cueRaw] = selectedRef.split(":");
        const sourceFixtureId = parseInt(fixtureRaw, 10);
        const sourceCueId = parseInt(cueRaw, 10);
        if (!Number.isFinite(sourceFixtureId) || !Number.isFinite(sourceCueId)) return;
        const sourceFixture = getLightingFixtureById(sourceFixtureId);
        if (!sourceFixture) return;
        if (!canInsertSceneReference(fixture, sourceFixtureId, sourceCueId)) {
            showSceneCycleBlockedNotice();
            return;
        }
        const sourceCue = sourceFixture?.cues?.find((entry) => parseInt(entry?.id, 10) === sourceCueId);
        if (!sourceCue) return;
        const timeline = normalizeSceneTimeline(sceneCue);
        timeline.push({
            type: "cues",
            items: [{ fixtureId: sourceFixtureId, cueId: sourceCueId }]
        });
        syncSceneCueDerivedAssignments(sceneCue, fixture);
        selectedSceneTimelineIndex = timeline.length - 1;
        renderLightingModal();
        autoSave();
        return;
    }
    const cue = getSelectedLightingCue();
    if (!cue) return;

    const channelNumber = lightingClampInt(lightingUI.channelNumber?.value, 1, 512, -1);
    if (channelNumber < 1) return;

    cue.channels = normalizeLightingChannelsData(cue.channels);
    if (!cue.channels.some((entry) => entry.channel === channelNumber)) {
        cue.channels.push({ channel: channelNumber, value: 0, name: "", presetChannelId: null });
    }
    cue.channels = normalizeLightingChannelsData(cue.channels);

    renderLightingChannelEditor();
    renderLightingCuePreview();
    autoSave();
});

lightingUI.addDelayBtn?.addEventListener("click", () => {
    const fixture = getSelectedLightingFixture();
    if (!isLightingGroupFixture(fixture)) return;
    const sceneCue = getSelectedLightingCue() || ensureSceneCue(fixture);
    if (!sceneCue) return;
    const timeline = normalizeSceneTimeline(sceneCue);
    timeline.push({ type: "delay", ms: 1000 });
    syncSceneCueDerivedAssignments(sceneCue, fixture);
    selectedSceneTimelineIndex = timeline.length - 1;
    selectedLightingCueId = sceneCue.id;
    renderLightingModal();
    autoSave();
});

function bindLightingEffectInput(inputEl, key) {
    inputEl?.addEventListener("change", () => {
        const fixture = getSelectedLightingFixture();
        const isScene = isLightingGroupFixture(fixture);
        const inspectedSceneCue = isScene ? getSelectedSceneEffectsCue() : null;
        const cue = (isScene && inspectedSceneCue?.cue) ? inspectedSceneCue.cue : getSelectedLightingCue();
        if (!cue) return;
        ensureCueEffects(cue);
        cue.effects[key] = lightingClampInt(inputEl.value, 0, 600000, 0);
        inputEl.value = String(cue.effects[key]);
        renderLightingCuePreview();
        renderLightingEffects();
        autoSave();
    });
}

bindLightingEffectInput(lightingUI.effectDelay, "delayMs");
bindLightingEffectInput(lightingUI.effectFadeIn, "fadeInMs");
bindLightingEffectInput(lightingUI.effectFadeOut, "fadeOutMs");
bindLightingEffectInput(lightingUI.effectDuration, "durationMs");

lightingUI.sceneDelayInput?.addEventListener("change", () => {
    const fixture = getSelectedLightingFixture();
    const cue = getSelectedLightingCue();
    if (!isLightingGroupFixture(fixture) || !cue) return;
    const timeline = normalizeSceneTimeline(cue);
    const idx = Number.isFinite(selectedSceneTimelineIndex) ? selectedSceneTimelineIndex : -1;
    if (idx < 0 || idx >= timeline.length) return;
    if (timeline[idx]?.type !== "delay") return;
    timeline[idx].ms = lightingClampInt(lightingUI.sceneDelayInput.value, 0, 600000, 0);
    if (timeline[idx].ms <= 0) timeline[idx].ms = 50;
    syncSceneCueDerivedAssignments(cue, fixture);
    renderLightingModal();
    autoSave();
});

lightingUI.addPresetBtn?.addEventListener("click", () => {
    const name = (lightingUI.presetName?.value || "").trim() || `Preset ${nextLightingPresetId}`;
    const preset = {
        id: nextLightingPresetId++,
        name,
        channels: []
    };
    lightingPresets.push(preset);
    selectedLightingPresetId = preset.id;
    if (lightingUI.presetName) lightingUI.presetName.value = "";
    renderLightingPresetModal();
    renderLightingModal();
    autoSave();
});

lightingUI.addPresetChannelBtn?.addEventListener("click", () => {
    const preset = getSelectedLightingPreset();
    if (!preset) return;
    const name = (lightingUI.presetChannelName?.value || "").trim() || `Channel ${(preset.channels || []).length + 1}`;
    const address = lightingClampInt(lightingUI.presetChannelAddress?.value, 1, 512, (preset.channels || []).length + 1);
    const oldPresetAddressById = snapshotPresetAddressMap(preset);
    preset.channels = normalizeLightingPresetChannelsData(preset.channels);
    const nextId = preset.channels.reduce((max, channel) => Math.max(max, channel.id || 0), 0) + 1;
    preset.channels.push({ id: nextId, name, address });
    syncAllFixturesUsingPreset(preset.id, { oldPresetAddressById });
    if (lightingUI.presetChannelName) lightingUI.presetChannelName.value = "";
    if (lightingUI.presetChannelAddress) lightingUI.presetChannelAddress.value = "";
    renderLightingPresetModal();
    renderLightingModal();
    autoSave();
});

lightingUI.channelNumber?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
        event.preventDefault();
        lightingUI.addChannelBtn?.click();
    }
});

lightingUI.groupMemberSelect?.addEventListener("change", () => {
    renderLightingModal();
});

lightingUI.groupCueName?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
        event.preventDefault();
        lightingUI.addChannelBtn?.click();
    }
});

lightingUI.groupAssignLamp?.addEventListener("change", () => {
    renderLightingGroupAssignmentPanel();
});

lightingUI.groupAssignBtn?.addEventListener("click", () => {
    const groupFixture = getSelectedLightingFixture();
    const groupCue = getSelectedLightingCue();
    if (!isLightingGroupFixture(groupFixture) || !groupCue) return;
    const lampId = parseInt(lightingUI.groupAssignLamp?.value, 10);
    const cueId = parseInt(lightingUI.groupAssignCue?.value, 10);
    if (!Number.isFinite(lampId) || !Number.isFinite(cueId)) return;
    const memberFixture = getLightingFixtureById(lampId);
    const sourceCue = memberFixture?.cues?.find((entry) => parseInt(entry?.id, 10) === cueId);
    if (!memberFixture || !sourceCue) return;
    ensureGroupCueAssignments(groupCue);
    const exists = (groupCue.groupAssignments || []).some((entry) => entry.fixtureId === lampId && entry.cueId === cueId);
    if (exists) return;
    groupCue.groupAssignments.push({ fixtureId: lampId, cueId });
    renderLightingModal();
    autoSave();
});

lightingUI.groupAssignCue?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
        event.preventDefault();
        lightingUI.groupAssignBtn?.click();
    }
});

lightingUI.cueName?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
        event.preventDefault();
        lightingUI.addCueBtn?.click();
    }
});

lightingUI.fixtureName?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
        event.preventDefault();
        lightingUI.addFixtureBtn?.click();
    }
});

lightingUI.groupName?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
        event.preventDefault();
        lightingUI.addGroupBtn?.click();
    }
});

lightingUI.presetName?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
        event.preventDefault();
        lightingUI.addPresetBtn?.click();
    }
});

lightingUI.presetChannelName?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
        event.preventDefault();
        lightingUI.addPresetChannelBtn?.click();
    }
});
lightingUI.presetChannelAddress?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
        event.preventDefault();
        lightingUI.addPresetChannelBtn?.click();
    }
});

function formatZigbeeAge(ageMs) {
    if (!Number.isFinite(ageMs) || ageMs < 0) return "just now";
    if (ageMs < 1000) return "just now";
    const sec = Math.floor(ageMs / 1000);
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hrs = Math.floor(min / 60);
    return `${hrs}h ago`;
}

function renderZigbeeBridgeBadge() {
    if (!zigbeeUI.bridgeBadge) return;
    const enabled = zigbeeSnapshot?.bridgeEnabled === true;
    zigbeeUI.bridgeBadge.textContent = enabled ? "Bridge: online" : "Bridge: offline";
    zigbeeUI.bridgeBadge.classList.toggle("connected", enabled);
    zigbeeUI.bridgeBadge.classList.toggle("disconnected", !enabled);
}

function renderZigbeeDiscoveryStatus() {
    if (!zigbeeUI.discoveryStatus) return;
    const btn = zigbeeUI.discoveryToggleBtn;
    if (btn) {
        if (zigbeeDiscoveryBusy) {
            btn.textContent = "Working...";
            btn.disabled = true;
            btn.classList.toggle("active", !!zigbeeSnapshot?.discoveryActive);
        } else if (zigbeeSnapshot?.discoveryActive) {
            btn.textContent = "Stop Discover";
            btn.disabled = false;
            btn.classList.add("active");
        } else {
            btn.textContent = "Start Discover";
            btn.disabled = false;
            btn.classList.remove("active");
        }
    }
    if (zigbeeSnapshot?.discoveryActive) {
        const sec = Math.max(0, parseInt(zigbeeSnapshot.discoveryRemainingSec, 10) || 0);
        zigbeeUI.discoveryStatus.textContent = `Discovery active (${sec}s)`;
    } else {
        zigbeeUI.discoveryStatus.textContent = "Discovery inactive";
    }
}

function getZigbeeSnapshotTriggers() {
    return Array.isArray(zigbeeSnapshot?.triggers) ? zigbeeSnapshot.triggers : [];
}

function getSelectedZigbeeDevice() {
    const devices = Array.isArray(zigbeeSnapshot?.devices) ? zigbeeSnapshot.devices : [];
    if (!devices.length) return null;
    if (!selectedZigbeeDeviceId) return devices[0];
    return devices.find((entry) => String(entry?.id || "") === String(selectedZigbeeDeviceId)) || devices[0];
}

function buildZigbeeMessageEntriesFromPayload(payload) {
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
        const normalized = valueText.trim();
        entries.push({
            key,
            label: key,
            value: normalized
        });
    });
    entries.sort((a, b) => a.label.localeCompare(b.label));
    return entries;
}

function getZigbeeDeviceMessages(deviceId) {
    const arr = zigbeeDeviceMessagesById.get(String(deviceId || ""));
    return Array.isArray(arr) ? arr : [];
}

function renderZigbeeDeviceDetail() {
    if (!zigbeeUI.selectedDeviceName || !zigbeeUI.deviceMessageList) return;
    const selected = getSelectedZigbeeDevice();
    if (!selected) {
        zigbeeUI.selectedDeviceName.textContent = "No sensor selected";
        zigbeeUI.deviceMessageList.innerHTML = '<div class="zigbee-empty">No sensor selected.</div>';
        return;
    }
    const selectedName = selected.friendlyName || selected.id || "Unknown Device";
    zigbeeUI.selectedDeviceName.textContent = selectedName;
    const messages = getZigbeeDeviceMessages(selected.id);
    if (!messages.length) {
        zigbeeUI.deviceMessageList.innerHTML = '<div class="zigbee-empty">No message received yet.</div>';
        return;
    }

    zigbeeUI.deviceMessageList.innerHTML = "";
    const now = Date.now();
    const flashMap = zigbeeSignalFlashUntilByDevice.get(String(selected.id || "")) || new Map();
    messages.forEach((entry) => {
        const item = document.createElement("div");
        item.className = "zigbee-device-message-item";
        const flashUntil = Number(flashMap.get(entry.key) || 0);
        if (flashUntil > now) item.classList.add("flash");

        const left = document.createElement("div");
        left.className = "zigbee-device-message-main";
        const nameEl = document.createElement("div");
        nameEl.className = "zigbee-device-message-name";
        nameEl.textContent = `${entry.label}`;
        const metaEl = document.createElement("div");
        metaEl.className = "zigbee-device-message-meta";
        metaEl.dataset.baseValue = String(entry.value ?? "");
        metaEl.dataset.lastSeen = String(Number(entry.lastSeen) || now);
        metaEl.textContent = `${entry.value} | seen ${formatZigbeeAge(Math.max(0, now - (Number(entry.lastSeen) || now)))}`;
        left.appendChild(nameEl);
        left.appendChild(metaEl);

        const badge = document.createElement("span");
        badge.className = `zigbee-status-badge ${flashUntil > now ? "message" : "idle"}`;
        badge.textContent = flashUntil > now ? "Message" : "No Message";

        item.appendChild(left);
        item.appendChild(badge);
        zigbeeUI.deviceMessageList.appendChild(item);
    });
}

async function upsertZigbeeTrigger(payload = {}) {
    const res = await fetch("/api/zigbee/triggers/upsert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload || {})
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
        throw new Error(data.error || "Trigger save failed");
    }
    return data;
}

async function deleteZigbeeTrigger(triggerId) {
    const res = await fetch("/api/zigbee/triggers/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ triggerId })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
        throw new Error(data.error || "Trigger delete failed");
    }
    return data;
}

async function renameZigbeeDevice(deviceId, newName) {
    const payload = { deviceId, newName };
    const res = await fetch("/api/zigbee/devices/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
        throw new Error(data.error || "Rename failed");
    }
    return data;
}

async function hideZigbeeDevice(deviceId) {
    const payload = { deviceId };
    const res = await fetch("/api/zigbee/devices/hide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
        throw new Error(data.error || "Hide failed");
    }
    return data;
}

async function setZigbeeResetOnPuzzleReset(deviceId, enabled) {
    const payload = { deviceId, enabled: !!enabled };
    const res = await fetch("/api/zigbee/devices/reset-on-puzzle-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
        throw new Error(data.error || "Toggle update failed");
    }
    return data;
}

function makeZigbeeNameEditable(nameEl, device) {
    if (!nameEl || !device) return;
    let original = String(device.friendlyName || device.id || "").trim();
    let finished = false;
    const startEdit = () => {
        zigbeeEditingDeviceId = device.id;
        nameEl.setAttribute("contenteditable", "true");
        nameEl.focus();
        const range = document.createRange();
        range.selectNodeContents(nameEl);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    };
    const finishEdit = async (commit) => {
        if (finished) return;
        finished = true;
        nameEl.removeAttribute("contenteditable");
        const edited = String(nameEl.textContent || "").trim();
        if (!commit || !edited || edited === original) {
            nameEl.textContent = original;
            zigbeeEditingDeviceId = null;
            return;
        }
        nameEl.textContent = `${edited} ...`;
        try {
            await renameZigbeeDevice(device.id, edited);
            zigbeeEditingDeviceId = null;
            await loadZigbeeDevices({ forceRenderList: true });
        } catch (err) {
            nameEl.textContent = original;
            zigbeeEditingDeviceId = null;
        }
    };

    nameEl.addEventListener("mousedown", (event) => {
        event.stopPropagation();
    });
    nameEl.addEventListener("click", (event) => {
        event.stopPropagation();
    });
    nameEl.addEventListener("dblclick", (event) => {
        event.stopPropagation();
        startEdit();
    });
    nameEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            finishEdit(true);
        } else if (event.key === "Escape") {
            event.preventDefault();
            finishEdit(false);
        }
    });
    nameEl.addEventListener("blur", () => finishEdit(true));
}

function renderZigbeeDeviceList() {
    if (!zigbeeUI.list) return;
    zigbeeUI.list.innerHTML = "";
    const devices = Array.isArray(zigbeeSnapshot?.devices) ? zigbeeSnapshot.devices : [];
    if (!devices.length) {
        const empty = document.createElement("li");
        empty.className = "zigbee-empty";
        empty.textContent = "No Zigbee devices discovered yet.";
        zigbeeUI.list.appendChild(empty);
        return;
    }

    const selectedDevice = getSelectedZigbeeDevice();
    if (selectedDevice) selectedZigbeeDeviceId = selectedDevice.id;

    devices.forEach((device) => {
        const item = document.createElement("li");
        item.className = "zigbee-device-item";
        if (String(device?.id || "") === String(selectedZigbeeDeviceId || "")) {
            item.classList.add("selected");
        }

        const main = document.createElement("div");
        main.className = "zigbee-device-main";

        const nameEl = document.createElement("div");
        nameEl.className = "zigbee-device-name";
        nameEl.textContent = device.friendlyName || device.id || "Unknown Device";
        makeZigbeeNameEditable(nameEl, device);
        main.appendChild(nameEl);

        const meta = document.createElement("div");
        meta.className = "zigbee-device-meta";
        meta.dataset.deviceId = String(device.id || "");
        const vendorModel = [device.vendor, device.model].filter(Boolean).join(" / ");
        const lastSeenForAge = Number(device?.lastSeen || zigbeeLastSeenById.get(String(device?.id || "")) || 0);
        const ageMs = lastSeenForAge > 0 ? Math.max(0, Date.now() - lastSeenForAge) : Number(device?.ageMs || 0);
        const tail = `ID: ${device.id || "--"} | seen ${formatZigbeeAge(ageMs)}`;
        const rawBattery = Number.isFinite(Number(device?.battery)) ? Number(device.battery) : null;
        const battery = rawBattery === null ? null : Math.max(0, Math.min(100, Math.round(rawBattery)));
        const batteryText = battery === null ? "Battery: --" : `Battery: ${battery}%`;
        meta.dataset.vendorModel = vendorModel || "";
        meta.dataset.batteryText = batteryText;
        const details = vendorModel ? `${vendorModel} | ${tail}` : tail;
        meta.textContent = `${details} | ${batteryText}`;
        main.appendChild(meta);

        const resetToggle = document.createElement("label");
        resetToggle.className = "switch zigbee-reset-switch";
        const resetInput = document.createElement("input");
        resetInput.type = "checkbox";
        resetInput.checked = device?.resetOnPuzzleReset === true;
        const resetSlider = document.createElement("span");
        resetSlider.className = "slider";
        const resetLabel = document.createElement("span");
        resetLabel.className = "switch-label";
        resetLabel.textContent = "Status reset when Puzzle resets";
        resetToggle.appendChild(resetInput);
        resetToggle.appendChild(resetSlider);
        resetToggle.appendChild(resetLabel);
        const stopSelect = (event) => event.stopPropagation();
        resetToggle.addEventListener("mousedown", stopSelect);
        resetToggle.addEventListener("click", stopSelect);
        resetInput.addEventListener("change", async (event) => {
            event.stopPropagation();
            const nextEnabled = !!resetInput.checked;
            resetInput.disabled = true;
            try {
                await setZigbeeResetOnPuzzleReset(device.id, nextEnabled);
                await loadZigbeeDevices({ forceRenderList: true, silent: true });
            } catch (err) {
                resetInput.checked = !nextEnabled;
            } finally {
                resetInput.disabled = false;
            }
        });
        main.appendChild(resetToggle);

        const right = document.createElement("div");
        right.className = "zigbee-device-right";
        const now = Date.now();
        const flashUntil = Number(zigbeeMessageFlashUntil.get(device.id) || 0);
        const showMessage = flashUntil > now;
        const state = document.createElement("span");
        state.className = `zigbee-status-badge ${showMessage ? "message" : "idle"}`;
        state.textContent = showMessage ? "Message" : "No Message";
        right.appendChild(state);
        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "zigbee-delete-btn";
        deleteBtn.textContent = "x";
        deleteBtn.title = "Hide sensor from list";
        deleteBtn.addEventListener("click", async (event) => {
            event.stopPropagation();
            try {
                await hideZigbeeDevice(device.id);
                await loadZigbeeDevices({ forceRenderList: true });
            } catch (err) {}
        });
        right.appendChild(deleteBtn);

        item.addEventListener("click", (event) => {
            if (zigbeeEditingDeviceId && String(zigbeeEditingDeviceId) === String(device.id || "")) return;
            const target = event?.target;
            if (target && typeof target.closest === "function" && target.closest(".zigbee-device-name")) return;
            selectedZigbeeDeviceId = device.id;
            renderZigbeeModal({ skipList: false });
        });

        item.appendChild(main);
        item.appendChild(right);
        zigbeeUI.list.appendChild(item);
    });
}

function refreshZigbeeAgeLabels() {
    if (zigbeeUI.overlay?.style.display !== "flex") return;
    const now = Date.now();

    if (zigbeeUI.deviceMessageList) {
        const nodes = zigbeeUI.deviceMessageList.querySelectorAll(".zigbee-device-message-meta[data-last-seen]");
        nodes.forEach((node) => {
            const lastSeen = Number(node.dataset.lastSeen || 0);
            const value = String(node.dataset.baseValue || "").trim();
            if (!lastSeen) return;
            node.textContent = `${value} | seen ${formatZigbeeAge(Math.max(0, now - lastSeen))}`;
        });
    }

    if (zigbeeUI.list) {
        const nodes = zigbeeUI.list.querySelectorAll(".zigbee-device-meta[data-device-id]");
        nodes.forEach((node) => {
            const deviceId = String(node.dataset.deviceId || "").trim();
            if (!deviceId) return;
            const vendorModel = String(node.dataset.vendorModel || "").trim();
            const batteryText = String(node.dataset.batteryText || "Battery: --");
            const lastSeen = Number(zigbeeLastSeenById.get(deviceId) || 0);
            const tail = `ID: ${deviceId || "--"} | seen ${formatZigbeeAge(lastSeen > 0 ? Math.max(0, now - lastSeen) : 0)}`;
            const details = vendorModel ? `${vendorModel} | ${tail}` : tail;
            node.textContent = `${details} | ${batteryText}`;
        });
    }
}

function renderZigbeeMessageLog() {
    if (!zigbeeUI.messageLog) return;
    const logs = Array.isArray(zigbeeSnapshot?.logs) ? zigbeeSnapshot.logs : [];
    if (!logs.length) {
        zigbeeUI.messageLog.textContent = "--";
        return;
    }
    const lines = logs.map((entry) => {
        const at = Number.isFinite(Number(entry?.at)) ? new Date(Number(entry.at)) : new Date();
        const hh = String(at.getHours()).padStart(2, "0");
        const mm = String(at.getMinutes()).padStart(2, "0");
        const ss = String(at.getSeconds()).padStart(2, "0");
        const topic = String(entry?.topic || "");
        const text = String(entry?.text || "");
        return `[${hh}:${mm}:${ss}] ${topic} ${text}`;
    });
    zigbeeUI.messageLog.textContent = lines.join("\n");
    zigbeeUI.messageLog.scrollTop = 0;
}

function renderZigbeeTriggerEditor() {
    if (!zigbeeUI.triggerMessageSelect || !zigbeeUI.deviceTriggerList) return;
    const selected = getSelectedZigbeeDevice();
    const messages = selected ? getZigbeeDeviceMessages(selected.id) : [];
    const select = zigbeeUI.triggerMessageSelect;
    const prevValue = String(select.value || "");
    select.innerHTML = "";
    if (!messages.length) {
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "- No Message -";
        select.appendChild(opt);
    } else {
        messages.forEach((entry) => {
            const opt = document.createElement("option");
            opt.value = entry.key;
            opt.textContent = `${entry.label} = ${entry.value}`;
            select.appendChild(opt);
        });
        if (messages.some((entry) => entry.key === prevValue)) {
            select.value = prevValue;
        }
    }

    const triggers = getZigbeeSnapshotTriggers().filter((entry) => {
        if (!selected) return false;
        return String(entry?.deviceId || "") === String(selected.id || "");
    });
    zigbeeUI.deviceTriggerList.innerHTML = "";
    if (!selected) {
        zigbeeUI.deviceTriggerList.innerHTML = '<div class="zigbee-empty">Select a sensor to manage triggers.</div>';
        return;
    }
    if (!triggers.length) {
        zigbeeUI.deviceTriggerList.innerHTML = '<div class="zigbee-empty">No trigger configured.</div>';
        return;
    }
    const messageMap = new Map(messages.map((entry) => [entry.key, `${entry.label} = ${entry.value}`]));
    triggers.forEach((trigger) => {
        const row = document.createElement("div");
        row.className = "zigbee-trigger-item";
        const main = document.createElement("div");
        main.className = "zigbee-trigger-item-main";
        const nameEl = document.createElement("div");
        nameEl.className = "zigbee-trigger-name";
        nameEl.textContent = trigger?.name || "Trigger";
        const meta = document.createElement("div");
        meta.className = "zigbee-trigger-meta";
        meta.textContent = messageMap.get(String(trigger?.messageKey || "")) || String(trigger?.messageKey || "--");
        main.appendChild(nameEl);
        main.appendChild(meta);
        const del = document.createElement("button");
        del.type = "button";
        del.className = "zigbee-trigger-delete-btn";
        del.textContent = "x";
        del.title = "Delete trigger";
        del.addEventListener("click", async () => {
            try {
                await deleteZigbeeTrigger(trigger.id);
                await loadZigbeeDevices({ forceRenderList: false });
            } catch (err) {}
        });
        row.appendChild(main);
        row.appendChild(del);
        zigbeeUI.deviceTriggerList.appendChild(row);
    });
}

function renderZigbeeModal(options = {}) {
    renderZigbeeBridgeBadge();
    renderZigbeeDiscoveryStatus();
    if (options.skipList !== true) {
        renderZigbeeDeviceList();
    }
    renderZigbeeDeviceDetail();
    renderZigbeeTriggerEditor();
    renderZigbeeMessageLog();
}

async function loadZigbeeDevices(options = {}) {
    const forceRenderList = options.forceRenderList === true;
    const silent = options.silent === true;
    try {
        const res = await fetch("/api/zigbee/devices", { cache: "no-store" });
        const data = await res.json();
        if (!res.ok || data.success === false) throw new Error(data.error || "Could not load Zigbee devices");

        const now = Date.now();
        const incomingDevices = Array.isArray(data?.devices) ? data.devices : [];
        const currentIds = new Set();
        incomingDevices.forEach((device) => {
            const id = String(device?.id || "").trim();
            if (!id) return;
            currentIds.add(id);
            const lastSeen = Number(device?.lastSeen || 0);
            const prevSeen = Number(zigbeeLastSeenById.get(id) || 0);
            const lastTopic = String(device?.lastTopic || "");
            const isBridgeTopic = lastTopic.startsWith("zigbee2mqtt/bridge/");
            const isAvailabilityTopic = /\/availability$/i.test(lastTopic);
            const shouldCountAsSensorMessage = !isBridgeTopic && !isAvailabilityTopic;
            if (shouldCountAsSensorMessage && lastSeen > 0 && prevSeen > 0 && lastSeen > prevSeen) {
                zigbeeMessageFlashUntil.set(id, now + 1000);
            }
            if (lastSeen > 0) {
                zigbeeLastSeenById.set(id, lastSeen);
            }

            const payloadEntries = Array.isArray(device?.messageEntries)
                ? device.messageEntries.map((entry) => ({
                    key: String(entry?.key || entry?.label || "").trim(),
                    label: String(entry?.label || entry?.key || "").trim(),
                    value: String(entry?.value ?? "").trim(),
                    lastSeen: Number(entry?.lastSeen) || lastSeen || now
                })).filter((entry) => entry.key && entry.label)
                : buildZigbeeMessageEntriesFromPayload(device?.lastPayload).map((entry) => ({
                    ...entry,
                    lastSeen: lastSeen || now
                }));
            const existingMessages = getZigbeeDeviceMessages(id);
            const existingByKey = new Map(existingMessages.map((entry) => [entry.key, entry]));
            const nextMessages = [];
            const hasFreshSensorMessage = shouldCountAsSensorMessage && lastSeen > 0 && lastSeen > prevSeen;
            payloadEntries.forEach((entry) => {
                const prev = existingByKey.get(entry.key);
                const entrySeenRaw = Number(entry?.lastSeen || 0);
                const entrySeen = entrySeenRaw > 0 ? entrySeenRaw : 0;
                const previousSeen = Number(prev?.lastSeen || 0);
                // "seen ..." should reflect last incoming message for this device signal key,
                // not only value changes. If a fresh sensor message arrived, advance timestamp
                // to at least device.lastSeen even when value stayed identical.
                const effectiveLastSeen = hasFreshSensorMessage
                    ? Math.max(entrySeen || 0, lastSeen, previousSeen || 0, now)
                    : (entrySeen || (prev?.value === entry.value ? (previousSeen || now) : now));
                const nextEntry = {
                    key: entry.key,
                    label: entry.label,
                    value: entry.value,
                    lastSeen: effectiveLastSeen
                };
                nextMessages.push(nextEntry);
            });
            if (!zigbeeSignalFlashUntilByDevice.has(id)) {
                zigbeeSignalFlashUntilByDevice.set(id, new Map());
            }
            const flashBySignal = zigbeeSignalFlashUntilByDevice.get(id);
            nextMessages.forEach((entry) => {
                const prev = existingByKey.get(entry.key);
                if (!prev || prev.value !== entry.value || (shouldCountAsSensorMessage && lastSeen > 0 && lastSeen > prevSeen)) {
                    flashBySignal.set(entry.key, now + 1000);
                }
            });
            zigbeeDeviceMessagesById.set(id, nextMessages);
        });
        for (const existingId of Array.from(zigbeeLastSeenById.keys())) {
            if (!currentIds.has(existingId)) zigbeeLastSeenById.delete(existingId);
        }
        for (const existingId of Array.from(zigbeeMessageFlashUntil.keys())) {
            if (!currentIds.has(existingId)) zigbeeMessageFlashUntil.delete(existingId);
        }
        for (const existingId of Array.from(zigbeeSignalFlashUntilByDevice.keys())) {
            if (!currentIds.has(existingId)) zigbeeSignalFlashUntilByDevice.delete(existingId);
        }
        for (const existingId of Array.from(zigbeeDeviceMessagesById.keys())) {
            if (!currentIds.has(existingId)) zigbeeDeviceMessagesById.delete(existingId);
        }

        if (selectedZigbeeDeviceId) {
            const stillExists = incomingDevices.some((entry) => String(entry?.id || "") === String(selectedZigbeeDeviceId));
            if (!stillExists) selectedZigbeeDeviceId = incomingDevices[0]?.id || null;
        } else if (incomingDevices.length) {
            selectedZigbeeDeviceId = incomingDevices[0]?.id || null;
        }

        zigbeeSnapshot = { ...zigbeeSnapshot, ...data };
        if (silent) return;
        const skipList = !forceRenderList && !!zigbeeEditingDeviceId;
        renderZigbeeModal({ skipList });
    } catch (err) {
        if (silent) return;
        const skipList = !forceRenderList && !!zigbeeEditingDeviceId;
        renderZigbeeModal({ skipList });
    }
}

async function callZigbeeAction(url, body = {}) {
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {})
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) throw new Error(data.error || "Zigbee action failed");
    return data;
}

function startZigbeePolling() {
    if (zigbeePollTimer) clearInterval(zigbeePollTimer);
    zigbeePollTimer = setInterval(() => {
        if (zigbeeUI.overlay?.style.display !== "flex") return;
        loadZigbeeDevices();
    }, 500);
    if (zigbeeAgeRefreshTimer) clearInterval(zigbeeAgeRefreshTimer);
    zigbeeAgeRefreshTimer = setInterval(() => {
        refreshZigbeeAgeLabels();
    }, 1000);
}

function stopZigbeePolling() {
    if (zigbeePollTimer) {
        clearInterval(zigbeePollTimer);
        zigbeePollTimer = null;
    }
    if (zigbeeAgeRefreshTimer) {
        clearInterval(zigbeeAgeRefreshTimer);
        zigbeeAgeRefreshTimer = null;
    }
}

function startZigbeeBackgroundPolling() {
    if (zigbeeBackgroundPollTimer) clearInterval(zigbeeBackgroundPollTimer);
    zigbeeBackgroundPollTimer = setInterval(() => {
        loadZigbeeDevices({ silent: true }).catch(() => {});
    }, 1000);
}

function openZigbeeModal() {
    if (zigbeeUI.overlay) zigbeeUI.overlay.style.display = "flex";
    loadZigbeeDevices();
    callZigbeeAction("/api/zigbee/discovery/refresh", {}).then(() => loadZigbeeDevices()).catch(() => {});
    startZigbeePolling();
}

function closeZigbeeModal() {
    if (zigbeeUI.overlay) zigbeeUI.overlay.style.display = "none";
    stopZigbeePolling();
}

zigbeeUI.openBtn?.addEventListener("click", openZigbeeModal);
zigbeeUI.closeBtn?.addEventListener("click", closeZigbeeModal);
zigbeeUI.overlay?.addEventListener("click", (event) => {
    if (event.target === zigbeeUI.overlay) closeZigbeeModal();
});
zigbeeUI.refreshBtn?.addEventListener("click", async () => {
    try {
        await callZigbeeAction("/api/zigbee/discovery/refresh", {});
        await loadZigbeeDevices();
    } catch (err) {}
});
zigbeeUI.discoveryToggleBtn?.addEventListener("click", async () => {
    if (zigbeeDiscoveryBusy) return;
    zigbeeDiscoveryBusy = true;
    renderZigbeeDiscoveryStatus();
    try {
        if (zigbeeSnapshot?.discoveryActive) {
            await callZigbeeAction("/api/zigbee/discovery/stop", {});
        } else {
            await callZigbeeAction("/api/zigbee/discovery/start", { durationSec: 60 });
        }
        await loadZigbeeDevices();
    } catch (err) {
    } finally {
        zigbeeDiscoveryBusy = false;
        renderZigbeeDiscoveryStatus();
    }
});
zigbeeUI.addTriggerBtn?.addEventListener("click", async () => {
    const selected = getSelectedZigbeeDevice();
    if (!selected) return;
    const name = String(zigbeeUI.triggerNameInput?.value || "").trim();
    const messageKey = String(zigbeeUI.triggerMessageSelect?.value || "").trim();
    if (!name || !messageKey) return;
    try {
        await upsertZigbeeTrigger({
            name,
            deviceId: selected.id,
            messageKey
        });
        if (zigbeeUI.triggerNameInput) zigbeeUI.triggerNameInput.value = "";
        await loadZigbeeDevices({ forceRenderList: false });
    } catch (err) {}
});
zigbeeUI.triggerNameInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
        event.preventDefault();
        zigbeeUI.addTriggerBtn?.click();
    }
});

document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (lightingUI.presetOverlay?.style.display === "flex") {
        closeLightingPresetModal();
        return;
    }
    if (zigbeeUI.overlay?.style.display === "flex") {
        closeZigbeeModal();
        return;
    }
    if (soundsUI.overlay?.style.display === "flex") {
        closeSoundsModal();
        return;
    }
    if (roomScriptingUI.overlay?.style.display === "flex") {
        closeRoomScriptingOverlay();
        return;
    }
    if (scriptingUI.overlay?.style.display === "flex") {
        closeScriptingOverlay();
        return;
    }
    if (lightingUI.overlay?.style.display === "flex") {
        closeLightingModal();
    }
});
function updateSidebarHighlight(node){ document.querySelectorAll(".puzzle-item:not(.screen-item)").forEach(el=>el.classList.remove("selected")); if(node&&node.type==="escape/Puzzle"){ const item=document.querySelector(`.puzzle-item[data-node-id="${node.id}"]`); if(item){item.classList.add("selected");item.scrollIntoView({behavior:"smooth",block:"nearest"});} updateScreenHighlight(null); } }
function updateScreenHighlight(screenId){ document.querySelectorAll(".screen-item").forEach(el=>el.classList.remove("selected")); if(screenId!==null&&screenId!==undefined){ const item=document.querySelector(`.screen-item[data-screen-id="${screenId}"]`); if(item){item.classList.add("selected"); item.scrollIntoView({behavior:"smooth",block:"nearest"});} } }
function renderPuzzleListItemContent(node, text) {
    const displayName = getPuzzleDisplayName(node, text);
    const hasScript = puzzleHasScripting(node);
    const scriptIcon = hasScript
        ? `<span class="puzzle-script-list-indicator" title="Puzzle Skripting aktiv">{}</span>`
        : "";
    return `<span class="puzzle-item-main"><span class="puzzle-item-text">${displayName}</span>${scriptIcon}</span><span class="puzzle-status status-offline" id="status-${node.id}">offline</span>`;
}
function refreshPuzzleListItem(node) {
    if (!node || node.type !== "escape/Puzzle") return;
    const item = document.querySelector(`.puzzle-item[data-node-id="${node.id}"]`);
    if (!item) return;
    const prevStatus = item.querySelector(".puzzle-status");
    const prevStatusClass = prevStatus?.className || "";
    const prevStatusText = prevStatus?.textContent || "";
    item.innerHTML = renderPuzzleListItemContent(node, node.title);
    const nextStatus = item.querySelector(".puzzle-status");
    if (nextStatus && prevStatusClass) nextStatus.className = prevStatusClass;
    if (nextStatus && prevStatusText) nextStatus.textContent = prevStatusText;
}
function createSidebarListItem(node,text){
    const newItem=document.createElement("li");
    newItem.className="puzzle-item";
    newItem.dataset.nodeId=node.id;
    newItem.innerHTML = renderPuzzleListItemContent(node, text);
    newItem.addEventListener("click",e=>{ e.preventDefault(); if(document.activeElement)document.activeElement.blur(); const nodeInGraph=graph.getNodeById(newItem.dataset.nodeId); if(nodeInGraph){ canvas.deselectAllNodes(); canvas.selectNode(nodeInGraph,false); canvas.centerOnNode(nodeInGraph); canvas.canvas.focus(); updateSidebarHighlight(nodeInGraph); updatePropertiesPanel(nodeInGraph); } });
    puzzleList.appendChild(newItem);
}
function createScreenListItem(screen){ const newItem=document.createElement("li"); newItem.className="puzzle-item screen-item"; newItem.dataset.screenId=screen.id; newItem.innerHTML=`<span class="puzzle-item-text">${screen.name}</span>`; newItem.addEventListener("click",e=>{ e.preventDefault(); if(document.activeElement)document.activeElement.blur(); selectScreen(screen.id); }); newItem.addEventListener("keydown",e=>{ if(e.key==='Delete'){ deleteScreen(screen.id); } }); newItem.tabIndex=0; screenList.appendChild(newItem); }
function getCenterPosition(){ const rect=canvas.canvas.getBoundingClientRect(); const centerX=rect.width/2; const centerY=rect.height/2; const ds=canvas.ds; const x=(centerX/ds.scale)-ds.offset[0]; const y=(centerY/ds.scale)-ds.offset[1]; const jitter=()=>(Math.random()*40-20); return[x+jitter(),y+jitter()]; }
function centerMainFlowView() {
    const nodes = Array.isArray(graph?._nodes) ? graph._nodes.filter((node) => node && Array.isArray(node.pos)) : [];
    if (!nodes.length) return;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    nodes.forEach((node) => {
        const w = Array.isArray(node.size) ? Number(node.size[0]) || 140 : 140;
        const h = Array.isArray(node.size) ? Number(node.size[1]) || 80 : 80;
        const x = Number(node.pos[0]) || 0;
        const y = Number(node.pos[1]) || 0;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + w);
        maxY = Math.max(maxY, y + h);
    });

    const centerX = minX + ((maxX - minX) / 2);
    const centerY = minY + ((maxY - minY) / 2);
    const rect = canvas.canvas.getBoundingClientRect();
    const viewCenterX = rect.width / 2;
    const viewCenterY = rect.height / 2;
    const scale = canvas.ds?.scale || 1;

    canvas.ds.offset[0] = (viewCenterX / scale) - centerX;
    canvas.ds.offset[1] = (viewCenterY / scale) - centerY;
    canvas.setDirty(true, true);
}
function getNextBranchPairId() {
    const starts = graph.findNodesByType("escape/Start") || [];
    const used = new Set();
    starts.forEach(node => {
        const id = Number(node?.properties?.pairId);
        if (Number.isFinite(id) && id > 0) {
            used.add(id);
        }
    });
    let next = 1;
    while (used.has(next)) next += 1;
    return next;
}
function assignMissingBranchIds() {
    const starts = graph.findNodesByType("escape/Start") || [];
    const used = new Set();
    starts.forEach(node => {
        const id = Number(node?.properties?.pairId);
        if (Number.isFinite(id) && id > 0) {
            used.add(id);
        }
    });
    let next = 1;
    const assign = (node) => {
        const existing = Number(node?.properties?.pairId);
        if (Number.isFinite(existing) && existing > 0) return;
        while (used.has(next)) next += 1;
        if (!node.properties) node.properties = {};
        node.properties.pairId = next;
        used.add(next);
        next += 1;
    };
    starts.forEach(assign);
}

let activeBranchPairId = null;
let activeBranchSelectedNodeId = null;
function getBranchCount() {
    const starts = graph.findNodesByType("escape/Start") || [];
    return starts.length;
}
function getAllBranchNodes() {
    const starts = graph.findNodesByType("escape/Start") || [];
    const ends = graph.findNodesByType("escape/End") || [];
    return starts.concat(ends);
}
function getBranchPairNodes(pairId) {
    if (!Number.isFinite(Number(pairId))) return [];
    const starts = graph.findNodesByType("escape/Start") || [];
    const ends = graph.findNodesByType("escape/End") || [];
    const nodes = [];
    starts.forEach(node => {
        if (Number(node?.properties?.pairId) === Number(pairId)) nodes.push(node);
    });
    ends.forEach(node => {
        if (Number(node?.properties?.pairId) === Number(pairId)) nodes.push(node);
    });
    return nodes;
}
function selectBranchPairForNode(node) {
    if (!node) return;
    const pairId = Number(node?.properties?.pairId);
    if (!(pairId > 0)) return;
    setBranchPairHighlight(pairId, node.id);
    activeBranchPairId = pairId;
    activeBranchSelectedNodeId = node.id;
    graph.setDirtyCanvas(true, true);
}
function deleteBranchPair(pairId) {
    const nodes = getBranchPairNodes(pairId);
    if (!nodes.length) return false;
    nodes.forEach(node => graph.remove(node));
    if (Number(activeBranchPairId) === Number(pairId)) {
        clearBranchPairSelection();
    }
    reindexBranchPairs();
    refreshProgressBranchesForSelectedScreen();
    applyBranchDeleteRules();
    autoSave();
    return true;
}
function setBranchPairHighlight(pairId, selectedNodeId) {
    const branchCount = getBranchCount();
    const allNodes = getAllBranchNodes();
    allNodes.forEach(node => { node._pairHighlight = false; });
    if (branchCount <= 1) return;
    const nodes = getBranchPairNodes(pairId);
    nodes.forEach(node => {
        node._pairHighlight = node.id !== selectedNodeId;
    });
}
function clearBranchPairSelection() {
    const allNodes = getAllBranchNodes();
    allNodes.forEach(node => { node._pairHighlight = false; });
    if (activeBranchPairId !== null || activeBranchSelectedNodeId !== null) {
        activeBranchPairId = null;
        activeBranchSelectedNodeId = null;
    }
    graph.setDirtyCanvas(true, true);
}
function reindexBranchPairs() {
    const starts = graph.findNodesByType("escape/Start") || [];
    const ends = graph.findNodesByType("escape/End") || [];
    const sortedStarts = starts.slice().sort((a, b) => (a.id || 0) - (b.id || 0));
    const sortedEnds = ends.slice().sort((a, b) => (a.id || 0) - (b.id || 0));
    const count = Math.min(sortedStarts.length, sortedEnds.length);
    let nextId = 1;
    for (let i = 0; i < count; i += 1) {
        const start = sortedStarts[i];
        const end = sortedEnds[i];
        if (!start.properties) start.properties = {};
        if (!end.properties) end.properties = {};
        start.properties.pairId = nextId;
        end.properties.pairId = nextId;
        nextId += 1;
    }
    for (let i = count; i < sortedStarts.length; i += 1) {
        const node = sortedStarts[i];
        if (!node.properties) node.properties = {};
        node.properties.pairId = nextId;
        nextId += 1;
    }
    for (let i = count; i < sortedEnds.length; i += 1) {
        const node = sortedEnds[i];
        if (!node.properties) node.properties = {};
        node.properties.pairId = nextId;
        nextId += 1;
    }
}
function applyBranchDeleteRules() {
    const branchCount = getBranchCount();
    const allowDelete = branchCount > 1;
    const nodes = getAllBranchNodes();
    nodes.forEach(node => {
        const hasPair = Number(node?.properties?.pairId) > 0;
        const canDelete = allowDelete && hasPair;
        node.removable = !!canDelete;
        node.clonable = !!canDelete;
        node.block_delete = !canDelete;
    });
}

document.getElementById("add-puzzle-btn").addEventListener("click",()=>{ const node=LiteGraph.createNode("escape/Puzzle"); node.properties.Name="Puzzle "+(graph.findNodesByType("escape/Puzzle").length+1); node.title=node.properties.Name; node.pos=getCenterPosition(); graph.add(node); createSidebarListItem(node,node.title); canvas.deselectAllNodes(); canvas.selectNode(node); canvas.canvas.focus(); updateSidebarHighlight(node); autoSave(); });
document.getElementById("add-screen-btn").addEventListener("click",()=>{ const screenName="Screen "+(screens.length+1); const newId = nextScreenId++; const rawPath = screenName.replace(/\\s+/g,'-'); const newScreen={id:newId,name:screenName,role:"player",path:ensureUniqueScreenPath(rawPath, newId)}; screens.push(newScreen); renderScreenList(); selectScreen(newScreen.id); refreshExternalSelectionForSelectedPuzzle(); refreshHintSelectionForSelectedPuzzle(); autoSave(); });
document.getElementById("add-logic-btn").addEventListener("click",()=>{ const node=LiteGraph.createNode("escape/Logic"); node.pos=getCenterPosition(); graph.add(node); canvas.deselectAllNodes(); canvas.selectNode(node); canvas.canvas.focus(); autoSave(); });
document.getElementById("add-branch-btn").addEventListener("click",()=>{
    const start = LiteGraph.createNode("escape/Start");
    const end = LiteGraph.createNode("escape/End");
    if(!start || !end){ return; }
    const pairId = getNextBranchPairId();
    start.properties = start.properties || {};
    end.properties = end.properties || {};
    start.properties.pairId = pairId;
    end.properties.pairId = pairId;
    start.block_delete = false;
    end.block_delete = false;
    start.removable = true;
    end.removable = true;
    const center = getCenterPosition();
    start.pos = [center[0] - 180, center[1]];
    end.pos = [center[0] + 180, center[1]];
    graph.add(start);
    graph.add(end);
    canvas.deselectAllNodes();
    canvas.selectNode(start);
    canvas.canvas.focus();
    reindexBranchPairs();
    refreshProgressBranchesForSelectedScreen();
    applyBranchDeleteRules();
    autoSave();
});
document.getElementById("center-flow-btn")?.addEventListener("click", (event) => {
    event.preventDefault();
    centerMainFlowView();
});

function rebuildSidebarList(){
    puzzleList.innerHTML="";
    const puzzleNodes=graph.findNodesByType("escape/Puzzle");
    if(puzzleNodes)puzzleNodes.forEach(node=>createSidebarListItem(node,node.title));
    const selected=Object.values(canvas.selected_nodes||{})[0];
    updateSidebarHighlight(selected);
}
function renderScreenList(){ if(!screenList)return; screenList.innerHTML=""; screens.forEach(scr=>createScreenListItem(scr)); updateScreenHighlight(selectedScreenId); }
function selectScreen(id){ const screen=screens.find(s=>s.id===id); if(!screen)return; selectedNode=null; suppressSelectionChange=true; canvas.deselectAllNodes(); showScreenProperties(screen); }
function getInputCapableScreens(){ return screens.filter(s => (s.role || "player") === "player"); }
function getHintCapableScreens(){ return screens.filter(s => (s.role || "player") === "hint"); }
function deleteScreen(id){ const idx = screens.findIndex(s=>s.id===id); if(idx!==-1){ screens.splice(idx,1); if(selectedScreenId===id){ selectedScreenId=null; hidePropertiesPanel(); } renderScreenList(); refreshExternalSelectionForSelectedPuzzle(); refreshHintSelectionForSelectedPuzzle(); autoSave(); } }

// Global delete key for screens (when no input has focus)
document.addEventListener("keydown", (e)=>{
    if(e.key !== "Delete") return;
    const active = document.activeElement;
    if(active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)) return;
    if (soundsUI.overlay?.style.display === "flex") {
        deleteSelectedSound().catch((err) => {
            setSoundsUploadStatus(err?.message || "Could not delete sound.", true);
        });
        e.preventDefault();
        e.stopPropagation();
        return;
    }
    if (lightingUI.overlay?.style.display === "flex" || scriptingUI.overlay?.style.display === "flex" || zigbeeUI.overlay?.style.display === "flex") return;
    if(selectedScreenId !== null){
        deleteScreen(selectedScreenId);
        return;
    }
    const selected = Object.values(canvas.selected_nodes || {});
    if (selected.length > 0) {
        canvas.deleteSelectedNodes();
        e.preventDefault();
        e.stopPropagation();
        return;
    }
    if (activeBranchPairId > 0) {
        deleteBranchPair(activeBranchPairId);
        e.preventDefault();
        e.stopPropagation();
    }
});
const originalDeleteSelectedNodes = canvas.deleteSelectedNodes.bind(canvas);
canvas.deleteSelectedNodes = function() {
    const selected = Object.values(this.selected_nodes || {});
    const branchNode = selected.find(n => n && (n.type === "escape/Start" || n.type === "escape/End"));
    if (branchNode) {
        const pairId = Number(branchNode?.properties?.pairId);
        if (pairId > 0) {
            deleteBranchPair(pairId);
            return;
        }
    }
    if (!selected.length && activeBranchPairId > 0) {
        deleteBranchPair(activeBranchPairId);
        return;
    }
    originalDeleteSelectedNodes();
};

let selectedNode=null; let selectedScreenId=null; let suppressSelectionChange=false; let lastKnownDevicesStr="";
let hintModalNode=null;
const ui={ 
    name:document.getElementById("prop-name"), 
    dropdown:document.getElementById("custom-device-dropdown"), 
    dropdownTrigger:document.getElementById("dropdown-trigger-text"), 
    dropdownMenu:document.getElementById("dropdown-menu-list"), 
    deviceContainer:document.getElementById("device-select-container"),
    
    isStart:document.getElementById("prop-is-start"), 
    isAnalog:document.getElementById("prop-is-analog"),
    extScreen:document.getElementById("prop-external-screen"), // NEU
    extCheckDropdown:document.getElementById("prop-external-check-variable"),
    extCheckTrigger:document.getElementById("external-check-trigger"),
    extCheckMenu:document.getElementById("external-check-menu"),
    extShowAssignment:document.getElementById("prop-external-show-assignment"),
    hintScreen:document.getElementById("prop-hint-screen"),
    hintConfigureBtn:document.getElementById("configure-hints-btn"),
    hintCountBadge:document.getElementById("hint-count-badge"),
    hintModal:document.getElementById("hint-modal"),
    hintModalTitle:document.getElementById("hint-modal-title"),
    hintModalClose:document.getElementById("hint-modal-close"),
    hintAddBtn:document.getElementById("hint-add-btn"),
    hintManualToggle:document.getElementById("hint-manual-toggle"),
    hintShowAssignmentToggle:document.getElementById("hint-show-assignment-toggle"),
    hintList:document.getElementById("hint-list"),

    fallbackModal:document.getElementById("fallback-modal"),
    fallbackModalTitle:document.getElementById("fallback-modal-title"),
    fallbackModalClose:document.getElementById("fallback-modal-close"),
    fallbackInputName:document.getElementById("fallback-input-name"),
    fallbackInputType:document.getElementById("fallback-input-type"),
    fallbackInputValue:document.getElementById("fallback-input-value"),
    fallbackInputError:document.getElementById("fallback-input-error"),
    fallbackSaveBtn:document.getElementById("fallback-save-btn"),
    fallbackClearBtn:document.getElementById("fallback-clear-btn"),
    
    tabletCode:document.getElementById("prop-tablet-code"), // NEU
    tabletMsg:document.getElementById("prop-tablet-msg"), // NEU
    screenRole:document.getElementById("prop-screen-role"),
    screenPath:document.getElementById("prop-screen-path"),
    screenOpenPageBtn:document.getElementById("prop-screen-open-page"),
    progressStyle:document.getElementById("prop-progress-style"),
    progressBranches:document.getElementById("progress-branches-list"),
    progressRunningTime:document.getElementById("prop-progress-running-time"),
    progressStyleRow:document.getElementById("progress-style-row"),
    progressBranchesRow:document.getElementById("progress-branches-row"),
    progressRunningTimeRow:document.getElementById("progress-running-time-row"),

    logicType:document.getElementById("prop-logic-type"), 
    queueDelay:document.getElementById("prop-queue-delay"),
    queueDelayRow:document.getElementById("queue-delay-row"),
    queueActivateAll:document.getElementById("prop-queue-activate-all"),
    queueActivateAllRow:document.getElementById("queue-activate-all-row"),
    autoRestart:document.getElementById("prop-auto-restart"), 
    restartDelay:document.getElementById("prop-restart-delay"), 
    inputs:document.getElementById("inputs-list"), 
    outputs:document.getElementById("outputs-list"), 
    addInBtn:document.getElementById("add-input-btn"), 
    addOutBtn:document.getElementById("add-output-btn"), 
    inType:document.getElementById("add-input-type"), 
    outType:document.getElementById("add-output-type"),
    internalList:document.getElementById("internal-list"),
    addInternalBtn:document.getElementById("add-internal-btn"),
    internalType:document.getElementById("add-internal-type"),
    openScriptingBtn:document.getElementById("open-scripting-btn"),
    openRoomScriptingBtn:document.getElementById("open-room-scripting-btn")
};

const scriptingUI = {
    overlay: document.getElementById("scripting-modal-overlay"),
    closeBtn: document.getElementById("scripting-modal-close"),
    ruleList: document.getElementById("scripting-rule-list"),
    status: document.getElementById("scripting-status"),
    centerBtn: document.getElementById("scripting-center-btn"),
    title: document.getElementById("scripting-modal-title")
};

const roomScriptingUI = {
    overlay: document.getElementById("room-scripting-modal-overlay"),
    closeBtn: document.getElementById("room-scripting-modal-close"),
    ruleList: document.getElementById("room-scripting-rule-list"),
    status: document.getElementById("room-scripting-status"),
    centerBtn: document.getElementById("room-scripting-center-btn"),
    title: document.getElementById("room-scripting-modal-title")
};

function ensureScriptingCenterButton() {
    if (!scriptingUI.ruleList) return;
    let btn = scriptingUI.ruleList.querySelector("#scripting-center-btn");
    if (!btn) {
        btn = document.createElement("button");
        btn.id = "scripting-center-btn";
        btn.className = "scripting-center-btn";
        btn.type = "button";
        btn.title = "Center Canvas";
        btn.setAttribute("aria-label", "Center Canvas");
        scriptingUI.ruleList.appendChild(btn);
    }
    if (!btn.dataset.boundCenter) {
        btn.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            centerScriptingWorkspaceView();
        });
        btn.dataset.boundCenter = "1";
    }
    scriptingUI.centerBtn = btn;
}

function ensureRoomScriptingCenterButton() {
    if (!roomScriptingUI.ruleList) return;
    let btn = roomScriptingUI.ruleList.querySelector("#room-scripting-center-btn");
    if (!btn) {
        btn = document.createElement("button");
        btn.id = "room-scripting-center-btn";
        btn.className = "scripting-center-btn";
        btn.type = "button";
        btn.title = "Center Canvas";
        btn.setAttribute("aria-label", "Center Canvas");
        roomScriptingUI.ruleList.appendChild(btn);
    }
    if (!btn.dataset.boundCenter) {
        btn.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            centerRoomScriptingWorkspaceView();
        });
        btn.dataset.boundCenter = "1";
    }
    roomScriptingUI.centerBtn = btn;
}

ui.openScriptingBtn?.addEventListener("click", (event) => {
    event.preventDefault();
    openScriptingOverlay();
});
ui.openRoomScriptingBtn?.addEventListener("click", (event) => {
    event.preventDefault();
    openRoomScriptingOverlay();
});
scriptingUI.closeBtn?.addEventListener("click", closeScriptingOverlay);
scriptingUI.overlay?.addEventListener("click", (event) => {
    if (event.target === scriptingUI.overlay) closeScriptingOverlay();
});
roomScriptingUI.closeBtn?.addEventListener("click", closeRoomScriptingOverlay);
roomScriptingUI.overlay?.addEventListener("click", (event) => {
    if (event.target === roomScriptingUI.overlay) closeRoomScriptingOverlay();
});
ensureScriptingCenterButton();
ensureRoomScriptingCenterButton();

ui.dropdownTrigger.addEventListener("click",e=>{ if(ui.dropdown.classList.contains("dropdown-disabled")) return; ui.dropdownMenu.classList.toggle("open"); e.stopPropagation(); });
ui.extCheckTrigger?.addEventListener("click", e=>{ if(ui.extCheckDropdown?.classList.contains("dropdown-disabled")) return; ui.extCheckMenu?.classList.toggle("open"); e.stopPropagation(); });
document.addEventListener("click",e=>{
    if(ui.dropdown && !ui.dropdown.contains(e.target)) ui.dropdownMenu.classList.remove("open");
    if(ui.extCheckDropdown && !ui.extCheckDropdown.contains(e.target)) ui.extCheckMenu?.classList.remove("open");
});

function initCategories(){
    document.querySelectorAll('.category').forEach(cat=>{
        const header = cat.querySelector('.category-header');
        if(!header) return;
        const targetId = header.getAttribute('data-target');
        const body = targetId ? document.getElementById(targetId) : cat.querySelector('.category-body');
        if(!body) return;
        cat.classList.remove('open');
        body.classList.add('collapsed');
        header.addEventListener('click',()=>{
            const isOpen = cat.classList.toggle('open');
            body.classList.toggle('collapsed', !isOpen);
        });
    });
}
initCategories();

function ensureHints(node){
    if(!node.properties.hints || !Array.isArray(node.properties.hints)){
        node.properties.hints = [];
    }
    node.properties.hints = node.properties.hints.map(h=>{
        if(typeof h === "string"){
            return { text: h, delayFromStart: 60, delayAfterPrev: 0 };
        }
        return {
            text: h.text || "",
            delayFromStart: Number.isFinite(h.delayFromStart) ? h.delayFromStart : 60,
            delayAfterPrev: Number.isFinite(h.delayAfterPrev) ? h.delayAfterPrev : 0
        };
    });
}

function ensureHintTriggerDefaults(node){
    if(!node || !node.properties) return;
    // Legacy: manualHintTrigger stored inverse meaning
    if(node.properties.automaticHintTrigger === undefined){
        node.properties.automaticHintTrigger = !node.properties.manualHintTrigger;
    }
    if(node.properties.showHintAssignment === undefined){
        node.properties.showHintAssignment = true;
    }
}

const SCRIPTING_TRIGGER_TYPES = [
    "on_running",
    "on_activate",
    "on_solved",
    "on_room_started",
    "on_reset",
    "on_hint",
    "on_custom",
    "on_sensor_data",
    "on_sensor_match",
    "on_external_input_activated",
    "on_external_input_false",
    "on_external_input_right"
];
const SCRIPTING_CONDITION_TYPES = ["none", "custom_equals", "custom_contains", "var_compare", "sensor_compare", "expr"];
const SCRIPTING_ACTION_TYPES = ["play_cue", "play_sound", "send_custom", "print_system", "give_hint", "send_custom_var", "set_var_from_sensor", "get_state", "set_state", "wait", "break", "break_all_loops"];
const SCRIPTING_BLOCKLY_TOOLBOX = {
    kind: "categoryToolbox",
    contents: [
        {
            kind: "category",
            name: "Trigger",
            categorystyle: "trigger_category",
            contents: [
                { kind: "block", type: "hub_when_state" },
                { kind: "block", type: "hub_when_event" },
                { kind: "block", type: "hub_when_external_input" },
                { kind: "block", type: "hub_when_hint" },
                { kind: "block", type: "hub_when_sensor_data" },
                { kind: "block", type: "hub_when_room_started" }
            ]
        },
        {
            kind: "category",
            name: "Data",
            categorystyle: "data_category",
            contents: [
                { kind: "block", type: "data_topic" },
                { kind: "block", type: "data_math" },
                { kind: "block", type: "data_text" }
            ]
        },
        {
            kind: "category",
            name: "Conditions",
            categorystyle: "condition_category",
            contents: [
                { kind: "block", type: "data_compare" },
                { kind: "block", type: "data_logic" },
                { kind: "block", type: "data_not" },
                { kind: "block", type: "hub_condition_expr" },
                { kind: "block", type: "hub_condition_else_if_expr" },
                { kind: "block", type: "hub_condition_else_expr" }
            ]
        },
        {
            kind: "category",
            name: "Actions",
            categorystyle: "action_category",
            contents: [
                { kind: "block", type: "hub_action_play_cue" },
                { kind: "block", type: "hub_action_play_sound" },
                { kind: "block", type: "hub_action_send_custom" },
                { kind: "block", type: "hub_action_print_system" },
                { kind: "block", type: "hub_action_give_hint" },
                { kind: "block", type: "hub_action_set_state" },
                { kind: "block", type: "hub_action_wait" },
                { kind: "block", type: "hub_action_break" },
                { kind: "block", type: "hub_action_break_all_loops" },
                { kind: "block", type: "script_repeat_times" },
                { kind: "block", type: "script_forever" }
            ]
        }
    ]
};
let scriptingBlocklyWorkspace = null;
let scriptingBlocklyDefinitionsReady = false;
let scriptingBlocklySyncGuard = false;
let scriptingBlocklyLoadedNodeId = null;
let scriptingBlocklyLoadedStateHash = "";
let scriptingBlocklyTheme = null;

const ROOM_SCRIPTING_TRIGGER_TYPES = ["room_reset", "room_started", "room_state_change", "branch_reset", "branch_state_change", "any_puzzle_state", "sensor_data", "sensor_match", "hint_triggered"];
const ROOM_SCRIPTING_ACTION_TYPES = ["play_cue", "play_sound", "print_system", "set_var_from_sensor", "set_branch_state", "wait", "break", "break_all_loops"];
const ROOM_SCRIPTING_PUZZLE_STATES = [
    ["Locked", "locked"],
    ["Activate", "active"],
    ["Starting", "starting"],
    ["Running", "running"],
    ["Solved", "solved"],
    ["Error", "error"],
    ["Queuing", "queueing"]
];
const ROOM_SCRIPTING_BLOCKLY_TOOLBOX = {
    kind: "categoryToolbox",
    contents: [
        {
            kind: "category",
            name: "Trigger",
            categorystyle: "trigger_category",
            contents: [
                { kind: "block", type: "room_when_room_reset" },
                { kind: "block", type: "room_when_room_state" },
                { kind: "block", type: "room_when_branch_reset" },
                { kind: "block", type: "room_when_branch_state" },
                { kind: "block", type: "room_when_any_puzzle_state" },
                { kind: "block", type: "room_when_sensor_data" },
                { kind: "block", type: "room_when_hint" },
                { kind: "block", type: "room_when_room_started" }
            ]
        },
        {
            kind: "category",
            name: "Data",
            categorystyle: "data_category",
            contents: [
                { kind: "block", type: "data_topic" },
                { kind: "block", type: "data_math" },
                { kind: "block", type: "data_text" }
            ]
        },
        {
            kind: "category",
            name: "Conditions",
            categorystyle: "condition_category",
            contents: [
                { kind: "block", type: "data_compare" },
                { kind: "block", type: "data_logic" },
                { kind: "block", type: "data_not" },
                { kind: "block", type: "room_condition_expr" },
                { kind: "block", type: "room_condition_else_if_expr" },
                { kind: "block", type: "room_condition_else_expr" }
            ]
        },
        {
            kind: "category",
            name: "Actions",
            categorystyle: "action_category",
            contents: [
                { kind: "block", type: "room_action_play_cue" },
                { kind: "block", type: "room_action_play_sound" },
                { kind: "block", type: "room_action_print_system" },
                { kind: "block", type: "room_action_set_branch_state" },
                { kind: "block", type: "room_action_wait" },
                { kind: "block", type: "room_action_break" },
                { kind: "block", type: "room_action_break_all_loops" },
                { kind: "block", type: "script_repeat_times" },
                { kind: "block", type: "script_forever" }
            ]
        }
    ]
};
let roomScriptingBlocklyWorkspace = null;
let roomScriptingBlocklyDefinitionsReady = false;
let roomScriptingBlocklySyncGuard = false;
let roomScriptingBlocklyLoadedStateHash = "";

function getLightingCueActionOptions() {
    const options = [];
    (lightingFixtures || []).forEach((fixture) => {
        const cues = Array.isArray(fixture?.cues) ? fixture.cues : [];
        cues.forEach((cue) => {
            const fixtureId = parseInt(fixture?.id, 10);
            const cueId = parseInt(cue?.id, 10);
            if (!Number.isFinite(fixtureId) || !Number.isFinite(cueId)) return;
            const fixtureKind = isLightingGroupFixture(fixture) ? "Scene" : "Lamp";
            options.push({
                value: `${fixtureId}:${cueId}`,
                label: isLightingGroupFixture(fixture)
                    ? `Scene: ${fixture?.name || `Scene ${fixtureId}`}`
                    : `${fixtureKind}: ${fixture?.name || `Lamp ${fixtureId}`} / ${cue?.name || `Cue ${cueId}`}`
            });
        });
    });
    return options;
}

function getBlocklySoundDropdownOptions() {
    const sounds = Array.isArray(soundsListCache) ? soundsListCache : [];
    const options = sounds
        .map((entry) => String(entry?.name || "").trim())
        .filter((name) => name)
        .map((name) => [name, name]);
    if (!options.length) return [["No sounds available", ""]];
    return options;
}

function ensureScriptingRules(node) {
    if (!node || !node.properties) return;

    if (!Array.isArray(node.properties.scriptingRules) && Array.isArray(node.properties.automationRules)) {
        node.properties.scriptingRules = node.properties.automationRules;
    }
    if (!Array.isArray(node.properties.scriptingRules)) {
        node.properties.scriptingRules = [];
    }

    let maxId = 0;
    let fallbackId = 1;
    node.properties.scriptingRules = node.properties.scriptingRules.map((rawRule) => {
        const idParsed = parseInt(rawRule?.id, 10);
        const id = Number.isFinite(idParsed) && idParsed > 0 ? idParsed : fallbackId++;
        if (id > maxId) maxId = id;

        const rawTriggerType = String(rawRule?.triggerType || "").trim().toLowerCase();
        const normalizedTriggerType = rawTriggerType === "on_activate" ? "on_running" : rawTriggerType;
        const triggerType = SCRIPTING_TRIGGER_TYPES.includes(normalizedTriggerType) ? normalizedTriggerType : "on_running";
        const conditionType = SCRIPTING_CONDITION_TYPES.includes(rawRule?.conditionType) ? rawRule.conditionType : "none";
        const actionType = SCRIPTING_ACTION_TYPES.includes(rawRule?.actionType) ? rawRule.actionType : "send_custom";
        const triggerValue = String(rawRule?.triggerValue || "");
        const triggerField = String(rawRule?.triggerField || "");
        const triggerExpected = String(rawRule?.triggerExpected || "");
        const conditionValue = String(rawRule?.conditionValue || "");
        const conditionVar = String(rawRule?.conditionVar || "");
        const conditionField = String(rawRule?.conditionField || "");
        const conditionOp = String(rawRule?.conditionOp || "eq");
        const conditionExpr = (rawRule?.conditionExpr && typeof rawRule.conditionExpr === "object") ? rawRule.conditionExpr : null;
        const actionExpr = (rawRule?.actionExpr && typeof rawRule.actionExpr === "object") ? rawRule.actionExpr : null;
        const actionValueRaw = String(rawRule?.actionValue || "");
        const allowedStateValues = new Set(BLOCKLY_PUZZLE_STATE_OPTIONS.map((entry) => String(entry?.[1] || "")));
        const normalizedActionValue = actionType === "set_state"
            ? (allowedStateValues.has(actionValueRaw) ? actionValueRaw : "locked")
            : (actionType === "get_state" ? (actionValueRaw || "puzzleState") : actionValueRaw);
        const rawLoopStack = Array.isArray(rawRule?.loopStack) ? rawRule.loopStack : [];
        const loopStack = rawLoopStack.map((entry) => ({
            type: String(entry?.type || ""),
            key: String(entry?.key || ""),
            iter: Number.isFinite(Number(entry?.iter)) ? Number(entry.iter) : null
        }));

        return {
            id,
            triggerType,
            triggerValue: (triggerType === "on_custom" || triggerType === "on_sensor_data" || triggerType === "on_sensor_match") ? triggerValue : "",
            triggerField: triggerType === "on_sensor_match" ? triggerField : "",
            triggerExpected: triggerType === "on_sensor_match" ? triggerExpected : "",
            conditionType,
            conditionValue: conditionType === "none" ? "" : conditionValue,
            conditionVar: conditionType === "var_compare" ? conditionVar : "",
            conditionField: conditionType === "sensor_compare" ? conditionField : "",
            conditionOp: (conditionType === "var_compare" || conditionType === "sensor_compare") ? conditionOp : "eq",
            conditionExpr: conditionType === "expr" ? conditionExpr : null,
            actionType,
            actionValue: normalizedActionValue,
            actionExpr: (actionType === "send_custom" || actionType === "print_system") ? actionExpr : null,
            actionSourceDevice: String(rawRule?.actionSourceDevice || ""),
            actionSourceField: String(rawRule?.actionSourceField || ""),
            loopMode: String(rawRule?.loopMode || "").trim().toLowerCase() === "forever" ? "forever" : "",
            loopIntervalSec: Number.isFinite(Number(rawRule?.loopIntervalSec)) ? Math.max(0.2, Number(rawRule.loopIntervalSec)) : 1,
            loopStack,
            loopBreakKey: String(rawRule?.loopBreakKey || ""),
            loopBreakType: String(rawRule?.loopBreakType || "")
        };
    });

    const nextRuleId = parseInt(node.properties.scriptingNextRuleId, 10);
    if (!Number.isFinite(nextRuleId) || nextRuleId <= maxId) {
        node.properties.scriptingNextRuleId = maxId + 1;
    }
}

function getScriptingStateHash(state) {
    try {
        return JSON.stringify(state || null);
    } catch (e) {
        return "";
    }
}

function setScriptingStatus(message, isError = false) {
    if (!scriptingUI.status) return;
    scriptingUI.status.textContent = message || "";
    scriptingUI.status.classList.toggle("error", !!isError);
}

function getBlocklyCueDropdownOptions() {
    const options = getLightingCueActionOptions().map((entry) => [entry.label, entry.value]);
    return options.length ? options : [["- No Cues -", ""]];
}

function getBlocklyHintDropdownOptions() {
    const node = (selectedNode && selectedNode.type === "escape/Puzzle") ? selectedNode : null;
    const hints = Array.isArray(node?.properties?.hints) ? node.properties.hints : [];
    const options = hints.map((entry, idx) => {
        const text = String(entry?.text || "").trim();
        const label = text ? `Hint ${idx + 1}: ${text.slice(0, 40)}` : `Hint ${idx + 1}`;
        return [label, String(idx)];
    });
    return options.length ? options : [["- No Hints -", "-1"]];
}

function getBlocklySensorDeviceDropdownOptions() {
    const devices = Array.isArray(zigbeeSnapshot?.devices) ? zigbeeSnapshot.devices : [];
    const options = devices.map((entry) => {
        const id = String(entry?.id || "").trim();
        if (!id) return null;
        const name = String(entry?.friendlyName || entry?.id || "Sensor").trim() || id;
        return [`${name}`, id];
    }).filter(Boolean);
    return options.length ? options : [["- No Sensor -", ""]];
}

const BLOCKLY_DATA_SOURCE_CUSTOM = "__custom__";
const BLOCKLY_DATA_SOURCE_STATE = "__state__";
const BLOCKLY_DATA_SOURCE_PLAYER_INPUT = "__player_input__";
const BLOCKLY_PUZZLE_STATE_OPTIONS = [
    ["Locked", "locked"],
    ["Activate", "active"],
    ["Running", "running"],
    ["Solved", "solved"],
    ["Error", "error"]
];

function getBlocklySensorFieldDropdownOptions(deviceId) {
    const safeId = String(deviceId || "").trim();
    if (!safeId) return [["- No Field -", ""]];
    const messages = getZigbeeDeviceMessages(safeId);
    const options = messages.map((entry) => {
        const field = String(entry?.label || "").trim();
        if (!field) return null;
        return [field, field];
    }).filter(Boolean);
    return options.length ? options : [["- No Field -", ""]];
}

function getBlocklyPuzzleDropdownOptions() {
    const nodes = (graph?.findNodesByType?.("escape/Puzzle") || [])
        .slice()
        .sort((a, b) => (a?.id || 0) - (b?.id || 0));
    const options = nodes.map((node) => {
        const id = parseInt(node?.id, 10);
        if (!Number.isFinite(id)) return null;
        const name = getPuzzleDisplayName(node, node?.properties?.Name || node?.title || `Puzzle ${id}`);
        return [name, String(id)];
    }).filter(Boolean);
    return options.length ? options : [["- No Puzzle -", ""]];
}

function getBlocklyRoomStateTargetDropdownOptions() {
    const options = [["Room", "room"], ...getRoomBranchDropdownOptions().map(([label, value]) => [label, `branch:${value}`])];
    const puzzleOptions = getBlocklyPuzzleDropdownOptions().map(([label, value]) => [`Puzzle: ${label}`, value]);
    return [...options, ...puzzleOptions];
}

function getBlocklyAllSensorFieldDropdownOptions() {
    const seen = new Set();
    const options = [];
    const devices = Array.isArray(zigbeeSnapshot?.devices) ? zigbeeSnapshot.devices : [];
    devices.forEach((device) => {
        const messages = getZigbeeDeviceMessages(device?.id);
        messages.forEach((entry) => {
            const field = String(entry?.label || "").trim();
            if (!field || seen.has(field)) return;
            seen.add(field);
            options.push([field, field]);
        });
    });
    options.sort((a, b) => a[0].localeCompare(b[0]));
    return options.length ? options : [["- No Field -", ""]];
}

function getBlocklyPlayerInputFieldDropdownOptions() {
    return [
        ["Submitted Value", "submitted"],
        ["Expected Value", "expected"],
        ["Active", "active"]
    ];
}

function cloneDataExpression(expr) {
    if (!expr || typeof expr !== "object") return null;
    try {
        return JSON.parse(JSON.stringify(expr));
    } catch (e) {
        return null;
    }
}

function composeExprNot(expr) {
    const safe = cloneDataExpression(expr);
    if (!safe) return null;
    return { type: "not", value: safe };
}

function composeExprOr(left, right) {
    const a = cloneDataExpression(left);
    const b = cloneDataExpression(right);
    if (!a && !b) return null;
    if (!a) return b;
    if (!b) return a;
    return { type: "logic", op: "or", left: a, right: b };
}

function composeExprAnd(left, right) {
    const a = cloneDataExpression(left);
    const b = cloneDataExpression(right);
    if (!a && !b) return null;
    if (!a) return b;
    if (!b) return a;
    return { type: "logic", op: "and", left: a, right: b };
}

function composeElseGuardExpr(previousExprs = []) {
    const list = Array.isArray(previousExprs) ? previousExprs : [];
    let anyPrevious = null;
    list.forEach((expr) => {
        anyPrevious = composeExprOr(anyPrevious, expr);
    });
    return anyPrevious ? composeExprNot(anyPrevious) : null;
}

function buildDataExprFromBlocklyBlock(block) {
    if (!block) return null;
    const type = String(block.type || "");
    const getChild = (inputName) => buildDataExprFromBlocklyBlock(block.getInputTargetBlock(inputName));

    if (type === "data_topic") {
        const workspaceMode = String(block.workspace?.__md2ScriptingMode || "").trim().toLowerCase();
        const fallbackSource = workspaceMode === "puzzle" ? BLOCKLY_DATA_SOURCE_CUSTOM : BLOCKLY_DATA_SOURCE_STATE;
        const sourceRaw = String(block.getFieldValue("SOURCE") || fallbackSource).trim();
        if (sourceRaw === BLOCKLY_DATA_SOURCE_CUSTOM) {
            return { type: "field", source: "custom" };
        }
        if (sourceRaw === BLOCKLY_DATA_SOURCE_PLAYER_INPUT) {
            return { type: "field", source: "player_input", field: String(block.getFieldValue("FIELD") || "submitted") };
        }
        if (sourceRaw === BLOCKLY_DATA_SOURCE_STATE) {
            const stateTarget = String(block.getFieldValue("FIELD") || "").trim();
            return (workspaceMode === "room" && stateTarget)
                ? { type: "field", source: "state", puzzle: stateTarget }
                : { type: "field", source: "state" };
        }
        return {
            type: "field",
            source: "sensor",
            device: sourceRaw,
            field: String(block.getFieldValue("FIELD") || "")
        };
    }
    if (type === "data_number") {
        return { type: "number", value: String(block.getFieldValue("NUM") || "0") };
    }
    if (type === "data_text") {
        return { type: "text", value: String(block.getFieldValue("TEXT") || "") };
    }
    if (type === "data_compare") {
        return {
            type: "compare",
            op: String(block.getFieldValue("OP") || "eq"),
            left: getChild("A"),
            right: getChild("B")
        };
    }
    if (type === "data_logic") {
        return {
            type: "logic",
            op: String(block.getFieldValue("OP") || "and"),
            left: getChild("A"),
            right: getChild("B")
        };
    }
    if (type === "data_not") {
        return { type: "not", value: getChild("A") };
    }
    if (type === "data_math") {
        return {
            type: "math",
            op: String(block.getFieldValue("OP") || "add"),
            left: getChild("A"),
            right: getChild("B")
        };
    }
    return null;
}

function createBlocklyDataExprBlock(workspace, expr) {
    if (!workspace || !expr || typeof expr !== "object") return null;
    const type = String(expr.type || "");
    let block = null;
    if (type === "field") {
        block = workspace.newBlock("data_topic");
        const source = String(expr.source || "").toLowerCase();
        const workspaceMode = String(workspace?.__md2ScriptingMode || "").trim().toLowerCase();
        if (source === "custom") {
            block.setFieldValue(workspaceMode === "puzzle" ? BLOCKLY_DATA_SOURCE_CUSTOM : BLOCKLY_DATA_SOURCE_STATE, "SOURCE");
        } else if (source === "player_input") {
            block.setFieldValue(BLOCKLY_DATA_SOURCE_PLAYER_INPUT, "SOURCE");
            block.setFieldValue(String(expr.field || "submitted"), "FIELD");
        } else if (source === "state") {
            block.setFieldValue(BLOCKLY_DATA_SOURCE_STATE, "SOURCE");
            if (workspaceMode === "room") {
                block.setFieldValue(String(expr.puzzle || expr.field || ""), "FIELD");
            }
        } else if (source === "sensor") {
            block.setFieldValue(String(expr.device || ""), "SOURCE");
            block.setFieldValue(String(expr.field || ""), "FIELD");
        } else {
            // Legacy fallback for unknown sources.
            block.setFieldValue(workspaceMode === "puzzle" ? BLOCKLY_DATA_SOURCE_CUSTOM : BLOCKLY_DATA_SOURCE_STATE, "SOURCE");
        }
    } else if (type === "number") {
        block = workspace.newBlock("data_number");
        block.setFieldValue(String(expr.value || "0"), "NUM");
    } else if (type === "text") {
        block = workspace.newBlock("data_text");
        block.setFieldValue(String(expr.value || ""), "TEXT");
    } else if (type === "compare") {
        block = workspace.newBlock("data_compare");
        block.setFieldValue(String(expr.op || "eq"), "OP");
    } else if (type === "logic") {
        block = workspace.newBlock("data_logic");
        block.setFieldValue(String(expr.op || "and"), "OP");
    } else if (type === "not") {
        block = workspace.newBlock("data_not");
    } else if (type === "math") {
        block = workspace.newBlock("data_math");
        block.setFieldValue(String(expr.op || "add"), "OP");
    }
    if (!block) return null;
    block.initSvg();
    block.render();

    const connectChild = (inputName, childExpr) => {
        if (!childExpr) return;
        const input = block.getInput(inputName);
        if (!input || !input.connection) return;
        const child = createBlocklyDataExprBlock(workspace, childExpr);
        if (child && child.outputConnection) {
            input.connection.connect(child.outputConnection);
        }
    };
    if (type === "compare" || type === "logic" || type === "math") {
        connectChild("A", expr.left);
        connectChild("B", expr.right);
    } else if (type === "not") {
        connectChild("A", expr.value);
    }
    return block;
}

function ensureRoomScriptingConfig() {
    roomScriptingConfig = normalizeRoomScriptingConfigData(roomScriptingConfig || {});
    roomScriptingConfig.rules = roomScriptingConfig.rules.map((rawRule, idx) => {
        const idParsed = parseInt(rawRule?.id, 10);
        const id = Number.isFinite(idParsed) && idParsed > 0 ? idParsed : (idx + 1);
        const triggerType = ROOM_SCRIPTING_TRIGGER_TYPES.includes(rawRule?.triggerType)
            ? rawRule.triggerType
            : "room_reset";
        const actionType = ROOM_SCRIPTING_ACTION_TYPES.includes(rawRule?.actionType)
            ? rawRule.actionType
            : "play_cue";
        let triggerValue = String(rawRule?.triggerValue || "");
        if (triggerType === "room_reset" || triggerType === "room_started" || triggerType === "hint_triggered") {
            triggerValue = "";
        } else if (triggerType === "room_state_change") {
            const allowedRoomStates = new Set(["running", "solved"]);
            const current = String(triggerValue || "").toLowerCase();
            triggerValue = allowedRoomStates.has(current) ? current : "running";
        } else if (triggerType === "branch_reset") {
            const validBranchIds = getAvailableBranchIds();
            if (validBranchIds.length) {
                const current = parseInt(triggerValue, 10);
                triggerValue = String(validBranchIds.includes(current) ? current : validBranchIds[0]);
            } else {
                triggerValue = "1";
            }
        } else if (triggerType === "branch_state_change") {
            const validBranchIds = getAvailableBranchIds();
            if (validBranchIds.length) {
                const current = parseInt(triggerValue, 10);
                triggerValue = String(validBranchIds.includes(current) ? current : validBranchIds[0]);
            } else {
                triggerValue = "1";
            }
        } else if (triggerType === "any_puzzle_state") {
            const knownStates = ROOM_SCRIPTING_PUZZLE_STATES.map(([_, value]) => value);
            if (!knownStates.includes(triggerValue)) triggerValue = "running";
        } else if (triggerType === "sensor_data") {
            triggerValue = String(rawRule?.triggerValue || "");
        } else if (triggerType === "sensor_match") {
            triggerValue = String(rawRule?.triggerValue || "");
        }
        const triggerField = String(rawRule?.triggerField || "");
        const triggerExpected = String(rawRule?.triggerExpected || "");
        const conditionType = String(rawRule?.conditionType || "none");
        const conditionOpRaw = String(rawRule?.conditionOp || "eq");
        const normalizedConditionOp = (conditionType === "var_compare" || conditionType === "sensor_compare")
            ? conditionOpRaw
            : "eq";
        const conditionExpr = (rawRule?.conditionExpr && typeof rawRule.conditionExpr === "object") ? rawRule.conditionExpr : null;
        const actionTargetPuzzle = String(rawRule?.actionTargetPuzzle || "");
        const branchTargetOptions = getRoomBranchAndRoomDropdownOptions();
        const validBranchTargets = new Set(branchTargetOptions.map((entry) => String(entry?.[1] || "").trim()));
        const fallbackBranchTarget = String(branchTargetOptions?.[0]?.[1] || "room");
        const allowedBranchStateValues = new Set(["running", "solved"]);
        const actionValueRaw = String(rawRule?.actionValue || "");
        const normalizedActionValue = actionType === "set_branch_state"
            ? (allowedBranchStateValues.has(actionValueRaw) ? actionValueRaw : "running")
            : actionValueRaw;
        const rawLoopStack = Array.isArray(rawRule?.loopStack) ? rawRule.loopStack : [];
        const loopStack = rawLoopStack.map((entry) => ({
            type: String(entry?.type || ""),
            key: String(entry?.key || ""),
            iter: Number.isFinite(Number(entry?.iter)) ? Number(entry.iter) : null
        }));
        return {
            id,
            triggerType,
            triggerValue,
            triggerField: triggerType === "sensor_match"
                ? triggerField
                : (triggerType === "branch_state_change"
                    ? (["running", "solved"].includes(String(triggerField || "").toLowerCase()) ? String(triggerField || "").toLowerCase() : "running")
                    : ""),
            triggerExpected: triggerType === "sensor_match" ? triggerExpected : "",
            actionType,
            actionValue: normalizedActionValue,
            actionTargetPuzzle: actionType === "set_branch_state"
                ? (validBranchTargets.has(actionTargetPuzzle) ? actionTargetPuzzle : fallbackBranchTarget)
                : "",
            conditionType,
            conditionVar: String(rawRule?.conditionVar || ""),
            conditionField: String(rawRule?.conditionField || ""),
            conditionOp: normalizedConditionOp,
            conditionValue: String(rawRule?.conditionValue || ""),
            conditionExpr: conditionType === "expr" ? conditionExpr : null,
            actionSourceDevice: String(rawRule?.actionSourceDevice || ""),
            actionSourceField: String(rawRule?.actionSourceField || ""),
            actionExpr: actionType === "print_system" && rawRule?.actionExpr && typeof rawRule.actionExpr === "object"
                ? rawRule.actionExpr
                : null,
            loopMode: String(rawRule?.loopMode || "").trim().toLowerCase() === "forever" ? "forever" : "",
            loopIntervalSec: Number.isFinite(Number(rawRule?.loopIntervalSec)) ? Math.max(0.2, Number(rawRule.loopIntervalSec)) : 1,
            loopStack,
            loopBreakKey: String(rawRule?.loopBreakKey || ""),
            loopBreakType: String(rawRule?.loopBreakType || "")
        };
    });
    const maxId = roomScriptingConfig.rules.reduce((max, rule) => Math.max(max, parseInt(rule?.id, 10) || 0), 0);
    const nextRuleId = parseInt(roomScriptingConfig.nextRuleId, 10);
    roomScriptingConfig.nextRuleId = Number.isFinite(nextRuleId) && nextRuleId > maxId ? nextRuleId : (maxId + 1);
}

function setRoomScriptingStatus(message, isError = false) {
    if (!roomScriptingUI.status) return;
    roomScriptingUI.status.textContent = message || "";
    roomScriptingUI.status.classList.toggle("error", !!isError);
}

function formatRuleCountStatus(count) {
    const n = Number.isFinite(Number(count)) ? Math.max(0, Number(count)) : 0;
    return `${n} ${n === 1 ? 'rule' : 'rules'} recognized from blocks.`;
}

function getRoomBranchDropdownOptions() {
    const branchIds = getAvailableBranchIds();
    if (!branchIds.length) return [["Branch 1", "1"]];
    return branchIds.map((id) => [`Branch ${id}`, String(id)]);
}

function getRoomBranchAndRoomDropdownOptions() {
    return [["Room", "room"], ...getRoomBranchDropdownOptions()];
}

function ensureBlocklyDataExpressionBlocks(BlocklyRef) {
    if (!BlocklyRef || BlocklyRef.Blocks["data_topic"]) return;
    const red = "#ef4444";
    const green = "#22c55e";
    const ensureCurrentOption = (options, currentValue, fallbackLabel) => {
        return Array.isArray(options) ? options : [];
    };
    const getDataSourceOptions = (workspaceMode = "") => {
        const sensorOptions = getBlocklySensorDeviceDropdownOptions().filter((entry) => String(entry?.[1] || "").trim());
        const mode = String(workspaceMode || "").trim().toLowerCase();
        return mode === "puzzle"
            ? [["Custom", BLOCKLY_DATA_SOURCE_CUSTOM], ["State", BLOCKLY_DATA_SOURCE_STATE], ["Player Input", BLOCKLY_DATA_SOURCE_PLAYER_INPUT], ...sensorOptions]
            : [["State", BLOCKLY_DATA_SOURCE_STATE], ...sensorOptions];
    };
    const ensureDataTopicFieldControl = (block, sourceOverride = null, forceSourceChanged = false) => {
        if (!block) return;
        const sourceInput = block.getInput("SOURCE_ROW");
        if (!sourceInput) return;
        const workspaceMode = String(block.workspace?.__md2ScriptingMode || "").trim().toLowerCase();
        const fallbackSource = workspaceMode === "puzzle" ? BLOCKLY_DATA_SOURCE_CUSTOM : BLOCKLY_DATA_SOURCE_STATE;
        const source = String(sourceOverride != null ? sourceOverride : (block.getFieldValue("SOURCE") || fallbackSource)).trim();
        const sourceChanged = !!forceSourceChanged || (String(block.__md2LastResolvedSource || "") !== source);
        block.__md2FieldSourceOverride = source;
        const stateNeedsPuzzlePicker = source === BLOCKLY_DATA_SOURCE_STATE && workspaceMode === "room";
        const playerInputNeedsField = source === BLOCKLY_DATA_SOURCE_PLAYER_INPUT && workspaceMode === "puzzle";
        const sensorNeedsField = source !== BLOCKLY_DATA_SOURCE_STATE && source !== BLOCKLY_DATA_SOURCE_CUSTOM;
        const shouldShowField = stateNeedsPuzzlePicker || playerInputNeedsField || sensorNeedsField;
        let hasField = !!block.getField("FIELD");

        if (!shouldShowField && hasField) {
            try {
                sourceInput.removeField("FIELD", true);
            } catch (e) {
                try { sourceInput.removeField("FIELD"); } catch (e2) {}
            }
        }

        if (shouldShowField && hasField && sourceChanged) {
            try {
                sourceInput.removeField("FIELD", true);
            } catch (e) {
                try { sourceInput.removeField("FIELD"); } catch (e2) {}
            }
            hasField = !!block.getField("FIELD");
        }

        if (shouldShowField && !hasField) {
            sourceInput.appendField(new BlocklyRef.FieldDropdown(() => {
                const currentMode = String(block.workspace?.__md2ScriptingMode || "").trim().toLowerCase();
                const currentFallback = currentMode === "puzzle" ? BLOCKLY_DATA_SOURCE_CUSTOM : BLOCKLY_DATA_SOURCE_STATE;
                const currentSource = String(block.__md2FieldSourceOverride || block.getFieldValue("SOURCE") || currentFallback).trim();
                const currentField = String(block.getFieldValue("FIELD") || block.__md2PreferredField || "").trim();
                return (currentSource === BLOCKLY_DATA_SOURCE_STATE && currentMode === "room")
                    ? ensureCurrentOption(getBlocklyRoomStateTargetDropdownOptions(), currentField, `Unknown State (${currentField})`)
                    : (currentSource === BLOCKLY_DATA_SOURCE_PLAYER_INPUT && currentMode === "puzzle")
                        ? ensureCurrentOption(getBlocklyPlayerInputFieldDropdownOptions(), currentField, `Unknown Field (${currentField})`)
                    : ensureCurrentOption(getBlocklySensorFieldDropdownOptions(currentSource), currentField, `Unknown Field (${currentField})`);
            }), "FIELD");
            hasField = !!block.getField("FIELD");
        }

        if (shouldShowField) {
            const currentField = String(block.getFieldValue("FIELD") || block.__md2PreferredField || "").trim();
            const options = stateNeedsPuzzlePicker
                ? getBlocklyRoomStateTargetDropdownOptions()
                : playerInputNeedsField
                    ? getBlocklyPlayerInputFieldDropdownOptions()
                    : getBlocklySensorFieldDropdownOptions(source);
            const hasCurrentField = options.some((entry) => String(entry?.[1] || "") === currentField);
            const nextField = (!sourceChanged && hasCurrentField)
                ? currentField
                : String(options?.[0]?.[1] || "");
            if (nextField && block.getField("FIELD")) {
                block.setFieldValue(nextField, "FIELD");
            }
            const selectedField = String(block.getFieldValue("FIELD") || "").trim();
            if (selectedField) {
                block.__md2PreferredField = selectedField;
            }
        }
        delete block.__md2FieldSourceOverride;
        block.__md2LastResolvedSource = source;
        if (typeof block.render === "function") block.render();
    };
    BlocklyRef.Blocks["data_topic"] = {
        init: function() {
            this.appendDummyInput("SOURCE_ROW")
                .appendField("Data")
                .appendField(new BlocklyRef.FieldDropdown(() => {
                    const mode = String(this.workspace?.__md2ScriptingMode || "").trim().toLowerCase();
                    const currentSource = String(this.getFieldValue("SOURCE") || "").trim();
                    return ensureCurrentOption(getDataSourceOptions(mode), currentSource, `Unknown Source (${currentSource})`);
                }, function(newSource) {
                    try {
                        const sourceField = this;
                        const block = sourceField?.getSourceBlock ? sourceField.getSourceBlock() : null;
                        if (!block) return newSource;
                        const chosenSource = String(newSource || "").trim();
                        setTimeout(() => {
                            try { ensureDataTopicFieldControl(block, chosenSource, true); } catch (e) {}
                        }, 0);
                    } catch (e) {}
                    return newSource;
                }), "SOURCE");
            this.setOutput(true, null);
            this.setColour(red);
            this.setOnChange(() => {
                if (!this.workspace || this.isInFlyout) return;
                const currentSource = String(this.getFieldValue("SOURCE") || "").trim();
                const currentField = String(this.getFieldValue("FIELD") || "").trim();
                if (currentSource) this.__md2PreferredSource = currentSource;
                if (currentField) this.__md2PreferredField = currentField;
                ensureDataTopicFieldControl(this);
            });
            ensureDataTopicFieldControl(this);
        },
        saveExtraState: function() {
            return {
                source: String(this.getFieldValue("SOURCE") || this.__md2PreferredSource || ""),
                field: String(this.getFieldValue("FIELD") || this.__md2PreferredField || "")
            };
        },
        loadExtraState: function(state) {
            const source = String(state?.source || "").trim();
            const field = String(state?.field || "").trim();
            if (source) {
                this.__md2PreferredSource = source;
                try { this.setFieldValue(source, "SOURCE"); } catch (e) {}
            }
            if (field) this.__md2PreferredField = field;
            ensureDataTopicFieldControl(this);
            if (field && this.getField("FIELD")) {
                try { this.setFieldValue(field, "FIELD"); } catch (e) {}
            }
        }
    };
    BlocklyRef.Blocks["data_number"] = {
        init: function() {
            this.appendDummyInput()
                .appendField(new BlocklyRef.FieldNumber(0), "NUM");
            this.setOutput(true, null);
            this.setColour(red);
        }
    };
    BlocklyRef.Blocks["data_text"] = {
        init: function() {
            this.appendDummyInput()
                .appendField("\"")
                .appendField(new BlocklyRef.FieldTextInput(""), "TEXT")
                .appendField("\"");
            this.setOutput(true, null);
            this.setColour(red);
        }
    };
    BlocklyRef.Blocks["data_compare"] = {
        init: function() {
            this.appendValueInput("A").setCheck(null);
            this.appendDummyInput()
                .appendField(new BlocklyRef.FieldDropdown([
                    [">", "gt"],
                    ["<", "lt"],
                    ["=", "eq"],
                    [">=", "gte"],
                    ["<=", "lte"],
                    ["!=", "neq"]
                ]), "OP");
            this.appendValueInput("B").setCheck(null);
            this.setInputsInline(true);
            this.setOutput(true, "Boolean");
            this.setColour(green);
        }
    };
    BlocklyRef.Blocks["data_logic"] = {
        init: function() {
            this.appendValueInput("A").setCheck("Boolean");
            this.appendDummyInput()
                .appendField(new BlocklyRef.FieldDropdown([["and", "and"], ["or", "or"]]), "OP");
            this.appendValueInput("B").setCheck("Boolean");
            this.setInputsInline(true);
            this.setOutput(true, "Boolean");
            this.setColour(green);
        }
    };
    BlocklyRef.Blocks["data_not"] = {
        init: function() {
            this.appendDummyInput().appendField("not");
            this.appendValueInput("A").setCheck("Boolean");
            this.setInputsInline(true);
            this.setOutput(true, "Boolean");
            this.setColour(green);
        }
    };
    BlocklyRef.Blocks["data_math"] = {
        init: function() {
            this.appendValueInput("A").setCheck(null);
            this.appendDummyInput()
                .appendField(new BlocklyRef.FieldDropdown([
                    ["+", "add"],
                    ["-", "sub"],
                    ["*", "mul"],
                    ["/", "div"]
                ]), "OP");
            this.appendValueInput("B").setCheck(null);
            this.setInputsInline(true);
            this.setOutput(true, null);
            this.setColour(red);
        }
    };

    BlocklyRef.Blocks["script_repeat_times"] = {
        init: function() {
            this.appendDummyInput()
                .appendField("Repeat")
                .appendField(new BlocklyRef.FieldNumber(2, 0, 1000, 1), "COUNT")
                .appendField("times");
            this.appendStatementInput("DO").appendField("do");
            this.setPreviousStatement(true, null);
            this.setNextStatement(true, null);
            this.setColour("#3b82f6");
        }
    };

    BlocklyRef.Blocks["script_forever"] = {
        init: function() {
            this.appendDummyInput().appendField("Forever");
            this.appendStatementInput("DO").appendField("do");
            this.setPreviousStatement(true, null);
            this.setNextStatement(true, null);
            this.setColour("#3b82f6");
        }
    };
}

function ensureRoomScriptingBlocklyDefinitions() {
    if (roomScriptingBlocklyDefinitionsReady) return true;
    const BlocklyRef = window.Blockly;
    if (!BlocklyRef) return false;
    ensureBlocklyDataExpressionBlocks(BlocklyRef);

    if (!BlocklyRef.Blocks["room_when_room_reset"]) {
        BlocklyRef.Blocks["room_when_room_reset"] = {
            init: function() {
                this.appendDummyInput()
                    .appendField("When Room gets Reset");
                this.setNextStatement(true, null);
                this.setColour("#f59e0b");
            }
        };

        BlocklyRef.Blocks["room_when_room_started"] = {
            init: function() {
                this.appendDummyInput()
                    .appendField("When Room gets Started");
                this.setNextStatement(true, null);
                this.setColour("#f59e0b");
            }
        };

        BlocklyRef.Blocks["room_when_branch_reset"] = {
            init: function() {
                this.appendDummyInput()
                    .appendField("When Branch")
                    .appendField(new BlocklyRef.FieldDropdown(() => getRoomBranchDropdownOptions()), "BRANCH")
                    .appendField("gets Reset");
                this.setNextStatement(true, null);
                this.setColour("#f59e0b");
            }
        };

        BlocklyRef.Blocks["room_when_room_state"] = {
            init: function() {
                this.appendDummyInput()
                    .appendField("When Room State changes to")
                    .appendField(new BlocklyRef.FieldDropdown([
                        ["Running", "running"],
                        ["Solved", "solved"]
                    ]), "STATE");
                this.setNextStatement(true, null);
                this.setColour("#f59e0b");
            }
        };

        BlocklyRef.Blocks["room_when_branch_state"] = {
            init: function() {
                this.appendDummyInput()
                    .appendField("When Branch")
                    .appendField(new BlocklyRef.FieldDropdown(() => getRoomBranchDropdownOptions()), "BRANCH")
                    .appendField("State changes to")
                    .appendField(new BlocklyRef.FieldDropdown([
                        ["Running", "running"],
                        ["Solved", "solved"]
                    ]), "STATE");
                this.setNextStatement(true, null);
                this.setColour("#f59e0b");
            }
        };

        BlocklyRef.Blocks["room_when_any_puzzle_state"] = {
            init: function() {
                this.appendDummyInput()
                    .appendField("When Any Puzzle State Changes to")
                    .appendField(new BlocklyRef.FieldDropdown(ROOM_SCRIPTING_PUZZLE_STATES), "STATE");
                this.setNextStatement(true, null);
                this.setColour("#f59e0b");
            }
        };

        BlocklyRef.Blocks["room_when_sensor_data"] = {
            init: function() {
                this.appendDummyInput()
                    .appendField("When Sensor")
                    .appendField(new BlocklyRef.FieldDropdown(() => getBlocklySensorDeviceDropdownOptions()), "DEVICE")
                    .appendField("sends Data");
                this.setNextStatement(true, null);
                this.setColour("#f59e0b");
            }
        };

        BlocklyRef.Blocks["room_when_hint"] = {
            init: function() {
                this.appendDummyInput()
                    .appendField("When Hint gets triggert");
                this.setNextStatement(true, null);
                this.setColour("#f59e0b");
            }
        };

        BlocklyRef.Blocks["room_when_sensor_match"] = {
            init: function() {
                this.appendDummyInput()
                    .appendField("When Sensor")
                    .appendField(new BlocklyRef.FieldDropdown(() => getBlocklySensorDeviceDropdownOptions()), "DEVICE")
                    .appendField("sends")
                    .appendField(new BlocklyRef.FieldDropdown(() => {
                        const device = this.getFieldValue("DEVICE");
                        return getBlocklySensorFieldDropdownOptions(device);
                    }), "FIELD")
                    .appendField("=")
                    .appendField(new BlocklyRef.FieldTextInput("single"), "VALUE");
                this.setNextStatement(true, null);
                this.setColour("#f59e0b");
            }
        };

        BlocklyRef.Blocks["room_var_set_sensor"] = {
            init: function() {
                this.appendDummyInput()
                    .appendField("Set variable")
                    .appendField(new BlocklyRef.FieldTextInput("sensorValue"), "VAR")
                    .appendField("=")
                    .appendField(new BlocklyRef.FieldDropdown(() => {
                        const device = this.getFieldValue("DEVICE");
                        return getBlocklySensorFieldDropdownOptions(device);
                    }), "FIELD")
                    .appendField("from Sensor")
                    .appendField(new BlocklyRef.FieldDropdown(() => getBlocklySensorDeviceDropdownOptions()), "DEVICE");
                this.setPreviousStatement(true, null);
                this.setNextStatement(true, null);
                this.setColour("#ef4444");
            }
        };

        BlocklyRef.Blocks["room_condition_var"] = {
            init: function() {
                this.appendDummyInput()
                    .appendField("If variable")
                    .appendField(new BlocklyRef.FieldTextInput("sensorValue"), "VAR")
                    .appendField(new BlocklyRef.FieldDropdown([
                        ["=", "eq"],
                        ["!=", "neq"],
                        [">", "gt"],
                        [">=", "gte"],
                        ["<", "lt"],
                        ["<=", "lte"]
                    ]), "OP")
                    .appendField("value")
                    .appendField(new BlocklyRef.FieldTextInput(""), "VALUE");
                this.setPreviousStatement(true, null);
                this.setNextStatement(true, null);
                this.setColour("#22c55e");
            }
        };

        BlocklyRef.Blocks["room_condition_sensor"] = {
            init: function() {
                this.appendDummyInput()
                    .appendField("If Data")
                    .appendField(new BlocklyRef.FieldDropdown(() => getBlocklyAllSensorFieldDropdownOptions()), "FIELD")
                    .appendField(new BlocklyRef.FieldDropdown([
                        ["=", "eq"],
                        ["!=", "neq"],
                        [">", "gt"],
                        [">=", "gte"],
                        ["<", "lt"],
                        ["<=", "lte"]
                    ]), "OP")
                    .appendField("value")
                    .appendField(new BlocklyRef.FieldTextInput(""), "VALUE");
                this.setPreviousStatement(true, null);
                this.setNextStatement(true, null);
                this.setColour("#22c55e");
            }
        };

        BlocklyRef.Blocks["room_condition_expr"] = {
            init: function() {
                this.appendDummyInput().appendField("If");
                this.appendValueInput("COND").setCheck("Boolean");
                this.setPreviousStatement(true, null);
                this.setNextStatement(true, null);
                this.setColour("#22c55e");
            }
        };

        BlocklyRef.Blocks["room_condition_else_if_expr"] = {
            init: function() {
                this.appendDummyInput().appendField("Else If");
                this.appendValueInput("COND").setCheck("Boolean");
                this.setPreviousStatement(true, null);
                this.setNextStatement(true, null);
                this.setColour("#22c55e");
            }
        };

        BlocklyRef.Blocks["room_condition_else_expr"] = {
            init: function() {
                this.appendDummyInput().appendField("Else");
                this.setPreviousStatement(true, null);
                this.setNextStatement(true, null);
                this.setColour("#22c55e");
            }
        };

        BlocklyRef.Blocks["room_action_play_cue"] = {
            init: function() {
                this.appendDummyInput()
                    .appendField("Play Lighting Cue")
                    .appendField(new BlocklyRef.FieldDropdown(() => getBlocklyCueDropdownOptions()), "CUE");
                this.setPreviousStatement(true, null);
                this.setNextStatement(true, null);
                this.setColour("#3b82f6");
            }
        };

        BlocklyRef.Blocks["room_action_play_sound"] = {
            init: function() {
                this.appendDummyInput()
                    .appendField("Play Sound Cue")
                    .appendField(new BlocklyRef.FieldDropdown(() => getBlocklySoundDropdownOptions()), "SOUND");
                this.setPreviousStatement(true, null);
                this.setNextStatement(true, null);
                this.setColour("#3b82f6");
            }
        };

        BlocklyRef.Blocks["room_action_print_system"] = {
            init: function() {
                this.appendDummyInput().appendField("Print");
                this.appendValueInput("DATA").setCheck(null);
                this.appendDummyInput().appendField("to System Messages");
                this.setInputsInline(true);
                this.setPreviousStatement(true, null);
                this.setNextStatement(true, null);
                this.setColour("#3b82f6");
            }
        };

        BlocklyRef.Blocks["room_action_set_branch_state"] = {
            init: function() {
                this.appendDummyInput()
                    .appendField("Set Branch")
                    .appendField(new BlocklyRef.FieldDropdown(() => getRoomBranchAndRoomDropdownOptions()), "TARGET")
                    .appendField("to")
                    .appendField(new BlocklyRef.FieldDropdown([
                        ["Running", "running"],
                        ["Solved", "solved"]
                    ]), "STATE");
                this.setPreviousStatement(true, null);
                this.setNextStatement(true, null);
                this.setColour("#3b82f6");
            }
        };

        BlocklyRef.Blocks["room_action_wait"] = {
            init: function() {
                this.appendDummyInput()
                    .appendField("Wait")
                    .appendField(new BlocklyRef.FieldNumber(1, 0, 600, 0.1), "SECONDS")
                    .appendField("sec");
                this.setPreviousStatement(true, null);
                this.setNextStatement(true, null);
                this.setColour("#3b82f6");
            }
        };

        BlocklyRef.Blocks["room_action_break"] = {
            init: function() {
                this.appendDummyInput().appendField("Break");
                this.setPreviousStatement(true, null);
                this.setNextStatement(true, null);
                this.setColour("#3b82f6");
            }
        };
        BlocklyRef.Blocks["room_action_break_all_loops"] = {
            init: function() {
                this.appendDummyInput().appendField("Break All Loops");
                this.setPreviousStatement(true, null);
                this.setNextStatement(true, null);
                this.setColour("#3b82f6");
            }
        };
    }

    roomScriptingBlocklyDefinitionsReady = true;
    return true;
}

function ensureRoomScriptingBlocklyWorkspace() {
    const BlocklyRef = window.Blockly;
    if (!BlocklyRef) {
        setRoomScriptingStatus("Blockly konnte nicht geladen werden.", true);
        return false;
    }
    if (!roomScriptingUI.ruleList) return false;
    if (roomScriptingBlocklyWorkspace) return true;
    if (!ensureRoomScriptingBlocklyDefinitions()) {
        setRoomScriptingStatus("Blockly BlÃ¶cke konnten nicht initialisiert werden.", true);
        return false;
    }

    roomScriptingBlocklyWorkspace = BlocklyRef.inject(roomScriptingUI.ruleList, {
        toolbox: ROOM_SCRIPTING_BLOCKLY_TOOLBOX,
        renderer: "geras",
        media: "vendor/blockly/media/",
        trashcan: false,
        theme: ensureScriptingBlocklyTheme(BlocklyRef),
        grid: {
            spacing: 24,
            length: 2,
            colour: "#2a2a2a",
            snap: true
        },
        move: {
            scrollbars: true,
            drag: true,
            wheel: false
        },
        zoom: {
            controls: false,
            wheel: true,
            startScale: 1,
            maxScale: 2,
            minScale: 0.5,
            scaleSpeed: 1.15
        }
    });
    roomScriptingBlocklyWorkspace.__md2ScriptingMode = "room";
    ensureRoomScriptingCenterButton();

    roomScriptingBlocklyWorkspace.addChangeListener((event) => {
        if (roomScriptingBlocklySyncGuard) return;
        if (event?.type === BlocklyRef.Events.UI || event?.type === BlocklyRef.Events.VIEWPORT_CHANGE) {
            return;
        }
        saveRoomScriptingWorkspace(true);
    });

    return true;
}

function populateWorkspaceFromRoomScriptingRules(workspace) {
    const BlocklyRef = window.Blockly;
    if (!BlocklyRef || !workspace) return;
    ensureRoomScriptingConfig();
    const rules = roomScriptingConfig.rules || [];
    rules.forEach((rule, index) => {
        let triggerBlock = null;
        if (rule.triggerType === "room_started") {
            triggerBlock = workspace.newBlock("room_when_room_started");
        } else if (rule.triggerType === "room_state_change") {
            triggerBlock = workspace.newBlock("room_when_room_state");
            triggerBlock.setFieldValue(String(rule.triggerValue || "running"), "STATE");
        } else if (rule.triggerType === "branch_reset") {
            triggerBlock = workspace.newBlock("room_when_branch_reset");
            triggerBlock.setFieldValue(String(rule.triggerValue || "1"), "BRANCH");
        } else if (rule.triggerType === "branch_state_change") {
            triggerBlock = workspace.newBlock("room_when_branch_state");
            triggerBlock.setFieldValue(String(rule.triggerValue || "1"), "BRANCH");
            triggerBlock.setFieldValue(String(rule.triggerField || "running"), "STATE");
        } else if (rule.triggerType === "any_puzzle_state") {
            triggerBlock = workspace.newBlock("room_when_any_puzzle_state");
            triggerBlock.setFieldValue(String(rule.triggerValue || "running"), "STATE");
        } else if (rule.triggerType === "sensor_data") {
            triggerBlock = workspace.newBlock("room_when_sensor_data");
            triggerBlock.setFieldValue(String(rule.triggerValue || ""), "DEVICE");
        } else if (rule.triggerType === "hint_triggered") {
            triggerBlock = workspace.newBlock("room_when_hint");
        } else if (rule.triggerType === "sensor_match") {
            triggerBlock = workspace.newBlock("room_when_sensor_match");
            triggerBlock.setFieldValue(String(rule.triggerValue || ""), "DEVICE");
            triggerBlock.setFieldValue(String(rule.triggerField || ""), "FIELD");
            triggerBlock.setFieldValue(String(rule.triggerExpected || ""), "VALUE");
        } else {
            triggerBlock = workspace.newBlock("room_when_room_reset");
        }
        triggerBlock.initSvg();
        triggerBlock.render();
        triggerBlock.moveBy(80 + ((index % 3) * 260), 60 + (Math.floor(index / 3) * 120));

        let previous = triggerBlock;
        const conditionType = String(rule.conditionType || "none");
        if (conditionType === "expr") {
            const cond = workspace.newBlock("room_condition_expr");
            cond.initSvg();
            cond.render();
            const exprBlock = createBlocklyDataExprBlock(workspace, rule.conditionExpr || null);
            if (exprBlock?.outputConnection) {
                const input = cond.getInput("COND");
                if (input?.connection) input.connection.connect(exprBlock.outputConnection);
            }
            previous.nextConnection?.connect(cond.previousConnection);
            previous = cond;
        } else if (conditionType === "var_compare" || conditionType === "sensor_compare") {
            const cond = workspace.newBlock(conditionType === "sensor_compare" ? "room_condition_sensor" : "room_condition_var");
            if (conditionType === "sensor_compare") {
                cond.setFieldValue(String(rule.conditionField || ""), "FIELD");
            } else {
                cond.setFieldValue(String(rule.conditionVar || ""), "VAR");
            }
            cond.setFieldValue(String(rule.conditionOp || "eq"), "OP");
            cond.setFieldValue(String(rule.conditionValue || ""), "VALUE");
            cond.initSvg();
            cond.render();
            previous.nextConnection?.connect(cond.previousConnection);
            previous = cond;
        }

        let actionBlock = null;
        if (rule.actionType === "set_var_from_sensor") {
            actionBlock = workspace.newBlock("room_var_set_sensor");
            actionBlock.setFieldValue(String(rule.actionValue || "sensorValue"), "VAR");
            actionBlock.setFieldValue(String(rule.actionSourceDevice || rule.triggerValue || ""), "DEVICE");
            actionBlock.setFieldValue(String(rule.actionSourceField || ""), "FIELD");
        } else if (rule.actionType === "print_system") {
            actionBlock = workspace.newBlock("room_action_print_system");
            const actionExpr = (rule.actionExpr && typeof rule.actionExpr === "object")
                ? rule.actionExpr
                : (rule.actionValue ? { type: "text", value: String(rule.actionValue || "") } : null);
            const exprBlock = createBlocklyDataExprBlock(workspace, actionExpr);
            if (exprBlock?.outputConnection) {
                const input = actionBlock.getInput("DATA");
                if (input?.connection) input.connection.connect(exprBlock.outputConnection);
            }
        } else if (rule.actionType === "set_branch_state") {
            actionBlock = workspace.newBlock("room_action_set_branch_state");
            actionBlock.setFieldValue(String(rule.actionTargetPuzzle || "room"), "TARGET");
            actionBlock.setFieldValue(String(rule.actionValue || "running"), "STATE");
        } else if (rule.actionType === "wait") {
            actionBlock = workspace.newBlock("room_action_wait");
            actionBlock.setFieldValue(Number.isFinite(Number(rule.actionValue)) ? Number(rule.actionValue) : 1, "SECONDS");
        } else if (rule.actionType === "break") {
            actionBlock = workspace.newBlock("room_action_break");
        } else if (rule.actionType === "break_all_loops") {
            actionBlock = workspace.newBlock("room_action_break_all_loops");
        } else if (rule.actionType === "play_sound") {
            actionBlock = workspace.newBlock("room_action_play_sound");
            actionBlock.setFieldValue(String(rule.actionValue || ""), "SOUND");
        } else {
            actionBlock = workspace.newBlock("room_action_play_cue");
            actionBlock.setFieldValue(String(rule.actionValue || ""), "CUE");
        }
        actionBlock.initSvg();
        actionBlock.render();
        previous.nextConnection?.connect(actionBlock.previousConnection);
    });
}

function extractRoomScriptingRulesFromWorkspace(workspace) {
    const rules = [];
    if (!workspace) return rules;

    const topBlocks = (workspace.getTopBlocks(false) || [])
        .filter((block) => block.type === "room_when_room_reset"
            || block.type === "room_when_room_started"
            || block.type === "room_when_room_state"
            || block.type === "room_when_branch_reset"
            || block.type === "room_when_branch_state"
            || block.type === "room_when_any_puzzle_state"
            || block.type === "room_when_sensor_data"
            || block.type === "room_when_hint"
            || block.type === "room_when_sensor_match")
        .sort((a, b) => {
            const aPos = a.getRelativeToSurfaceXY();
            const bPos = b.getRelativeToSurfaceXY();
            return aPos.y === bPos.y ? aPos.x - bPos.x : aPos.y - bPos.y;
        });

    let nextId = 1;
    const cloneState = (state) => ({
        triggerType: String(state?.triggerType || "room_reset"),
        triggerValue: String(state?.triggerValue || ""),
        triggerField: String(state?.triggerField || ""),
        triggerExpected: String(state?.triggerExpected || ""),
        conditionType: String(state?.conditionType || "none"),
        conditionVar: String(state?.conditionVar || ""),
        conditionField: String(state?.conditionField || ""),
        conditionExpr: cloneDataExpression(state?.conditionExpr),
        conditionOp: String(state?.conditionOp || "eq"),
        conditionValue: String(state?.conditionValue || ""),
        exprBranchRawList: Array.isArray(state?.exprBranchRawList) ? state.exprBranchRawList.map(cloneDataExpression).filter(Boolean) : []
    });
    const getLoopSignature = (stack = []) => stack
        .map((entry) => {
            const type = String(entry?.type || "");
            const key = String(entry?.key || "");
            if (type === "repeat") return `${type}:${key}@${Number.isFinite(Number(entry?.iter)) ? Number(entry.iter) : 0}`;
            return `${type}:${key}`;
        })
        .join(">");
    const normalizeLoopStack = (stack = []) => stack.map((entry) => ({
        type: String(entry?.type || ""),
        key: String(entry?.key || ""),
        iter: Number.isFinite(Number(entry?.iter)) ? Number(entry.iter) : null
    }));
    const emitActionRule = (current, state, loopCtx = { mode: "", stack: [] }) => {
        const isVarSet = current.type === "room_var_set_sensor";
        const isPrintSystem = current.type === "room_action_print_system";
        const isSetBranchState = current.type === "room_action_set_branch_state";
        const isWait = current.type === "room_action_wait";
        const isBreak = current.type === "room_action_break";
        const isBreakAllLoops = current.type === "room_action_break_all_loops";
        const isPlaySound = current.type === "room_action_play_sound";
        const loopStack = normalizeLoopStack(loopCtx?.stack || []);
        const currentLoop = loopStack.length ? loopStack[loopStack.length - 1] : null;
        const actionExpr = isPrintSystem
            ? buildDataExprFromBlocklyBlock(current.getInputTargetBlock("DATA"))
            : null;
        rules.push({
            id: nextId++,
            triggerType: state.triggerType,
            triggerValue: state.triggerValue,
            triggerField: state.triggerField,
            triggerExpected: state.triggerExpected,
            conditionType: state.conditionType,
            conditionVar: state.conditionVar,
            conditionField: state.conditionType === "sensor_compare" ? state.conditionField : "",
            conditionExpr: state.conditionType === "expr" ? state.conditionExpr : null,
            conditionOp: state.conditionOp,
            conditionValue: state.conditionValue,
            actionType: isVarSet
                ? "set_var_from_sensor"
                : (isSetBranchState
                    ? "set_branch_state"
                    : (isWait
                        ? "wait"
                        : (isBreak
                            ? "break"
                            : (isBreakAllLoops
                                ? "break_all_loops"
                                : (isPlaySound ? "play_sound" : (isPrintSystem ? "print_system" : "play_cue")))))),
            actionValue: isVarSet
                ? String(current.getFieldValue("VAR") || "sensorValue")
                : (isSetBranchState
                    ? String(current.getFieldValue("STATE") || "running")
                    : (isWait
                        ? String(current.getFieldValue("SECONDS") || "1")
                        : ((isBreak || isBreakAllLoops)
                            ? ""
                            : (isPlaySound ? String(current.getFieldValue("SOUND") || "") : (isPrintSystem ? "" : String(current.getFieldValue("CUE") || "")))))),
            actionTargetPuzzle: isSetBranchState ? String(current.getFieldValue("TARGET") || "room") : "",
            actionSourceDevice: isVarSet ? String(current.getFieldValue("DEVICE") || "") : "",
            actionSourceField: isVarSet ? String(current.getFieldValue("FIELD") || "") : "",
            actionExpr,
            loopMode: loopCtx?.mode === "forever" ? "forever" : "",
            loopIntervalSec: 1,
            loopStack,
            loopBreakKey: currentLoop ? String(currentLoop.key || "") : "",
            loopBreakType: currentLoop ? String(currentLoop.type || "") : ""
        });
    };
    const walkChain = (startBlock, inheritedState, loopCtx = { mode: "", stack: [] }) => {
        let state = cloneState(inheritedState);
        let current = startBlock;
        while (current) {
            if (current.type === "room_condition_expr") {
                state.conditionType = "expr";
                state.conditionVar = "";
                state.conditionField = "";
                state.conditionOp = "eq";
                state.conditionValue = "";
                const exprRoot = current.getInputTargetBlock("COND");
                state.conditionExpr = buildDataExprFromBlocklyBlock(exprRoot);
                state.exprBranchRawList = state.conditionExpr ? [cloneDataExpression(state.conditionExpr)] : [];
            } else if (current.type === "room_condition_else_if_expr") {
                const exprRoot = current.getInputTargetBlock("COND");
                const rawExpr = buildDataExprFromBlocklyBlock(exprRoot);
                const elseGuard = composeElseGuardExpr(state.exprBranchRawList);
                const combinedExpr = composeExprAnd(elseGuard, rawExpr);
                state.conditionType = "expr";
                state.conditionVar = "";
                state.conditionField = "";
                state.conditionOp = "eq";
                state.conditionValue = "";
                state.conditionExpr = combinedExpr;
                if (rawExpr) state.exprBranchRawList.push(cloneDataExpression(rawExpr));
            } else if (current.type === "room_condition_else_expr") {
                const elseGuard = composeElseGuardExpr(state.exprBranchRawList);
                state.conditionType = elseGuard ? "expr" : "none";
                state.conditionVar = "";
                state.conditionField = "";
                state.conditionOp = "eq";
                state.conditionValue = "";
                state.conditionExpr = elseGuard;
            } else if (current.type === "room_condition_var" || current.type === "room_condition_sensor") {
                state.conditionType = current.type === "room_condition_sensor" ? "sensor_compare" : "var_compare";
                state.conditionVar = current.type === "room_condition_sensor" ? "" : String(current.getFieldValue("VAR") || "");
                state.conditionField = current.type === "room_condition_sensor" ? String(current.getFieldValue("FIELD") || "") : "";
                state.conditionOp = String(current.getFieldValue("OP") || "eq");
                state.conditionValue = String(current.getFieldValue("VALUE") || "");
                state.conditionExpr = null;
                state.exprBranchRawList = [];
            } else if (current.type === "script_repeat_times") {
                const countRaw = Number(current.getFieldValue("COUNT"));
                const count = Number.isFinite(countRaw) ? Math.max(0, Math.min(1000, Math.floor(countRaw))) : 0;
                const bodyStart = current.getInputTargetBlock("DO");
                const repeatFamilyKey = `${getLoopSignature(loopCtx?.stack || [])}>repeat:${String(current.id || "")}`;
                for (let i = 0; i < count; i += 1) {
                    walkChain(bodyStart, state, {
                        mode: loopCtx?.mode || "",
                        stack: [...(loopCtx?.stack || []), { type: "repeat", key: repeatFamilyKey, iter: i }]
                    });
                }
            } else if (current.type === "script_forever") {
                const bodyStart = current.getInputTargetBlock("DO");
                const foreverKey = `${getLoopSignature(loopCtx?.stack || [])}>forever:${String(current.id || "")}`;
                walkChain(bodyStart, state, {
                    mode: "forever",
                    stack: [...(loopCtx?.stack || []), { type: "forever", key: foreverKey, iter: null }]
                });
            } else if (current.type === "room_action_play_cue"
                || current.type === "room_action_play_sound"
                || current.type === "room_action_print_system"
                || current.type === "room_var_set_sensor"
                || current.type === "room_action_set_branch_state"
                || current.type === "room_action_wait"
                || current.type === "room_action_break"
                || current.type === "room_action_break_all_loops") {
                emitActionRule(current, state, loopCtx);
            }
            current = current.getNextBlock();
        }
    };
    topBlocks.forEach((topBlock) => {
        const state = {
            triggerType: "room_reset",
            triggerValue: "",
            triggerField: "",
            triggerExpected: "",
            conditionType: "none",
            conditionVar: "",
            conditionField: "",
            conditionExpr: null,
            conditionOp: "eq",
            conditionValue: "",
            exprBranchRawList: []
        };
        if (topBlock.type === "room_when_room_started") {
            state.triggerType = "room_started";
        } else if (topBlock.type === "room_when_room_state") {
            state.triggerType = "room_state_change";
            state.triggerValue = String(topBlock.getFieldValue("STATE") || "running");
        } else if (topBlock.type === "room_when_branch_reset") {
            state.triggerType = "branch_reset";
            state.triggerValue = String(topBlock.getFieldValue("BRANCH") || "1");
        } else if (topBlock.type === "room_when_branch_state") {
            state.triggerType = "branch_state_change";
            state.triggerValue = String(topBlock.getFieldValue("BRANCH") || "1");
            state.triggerField = String(topBlock.getFieldValue("STATE") || "running");
        } else if (topBlock.type === "room_when_any_puzzle_state") {
            state.triggerType = "any_puzzle_state";
            state.triggerValue = String(topBlock.getFieldValue("STATE") || "running");
        } else if (topBlock.type === "room_when_sensor_data") {
            state.triggerType = "sensor_data";
            state.triggerValue = String(topBlock.getFieldValue("DEVICE") || "");
        } else if (topBlock.type === "room_when_hint") {
            state.triggerType = "hint_triggered";
        } else if (topBlock.type === "room_when_sensor_match") {
            state.triggerType = "sensor_match";
            state.triggerValue = String(topBlock.getFieldValue("DEVICE") || "");
            state.triggerField = String(topBlock.getFieldValue("FIELD") || "");
            state.triggerExpected = String(topBlock.getFieldValue("VALUE") || "");
        }
        walkChain(topBlock.getNextBlock(), state, { mode: "", stack: [] });
    });

    return rules;
}

function saveRoomScriptingWorkspace(persist = true) {
    const BlocklyRef = window.Blockly;
    if (!BlocklyRef || !roomScriptingBlocklyWorkspace) return;
    ensureRoomScriptingConfig();

    const state = BlocklyRef.serialization.workspaces.save(roomScriptingBlocklyWorkspace);
    roomScriptingConfig.blocklyState = state;
    roomScriptingConfig.rules = extractRoomScriptingRulesFromWorkspace(roomScriptingBlocklyWorkspace);
    const maxId = roomScriptingConfig.rules.reduce((max, rule) => Math.max(max, parseInt(rule?.id, 10) || 0), 0);
    roomScriptingConfig.nextRuleId = maxId + 1;
    roomScriptingBlocklyLoadedStateHash = getScriptingStateHash(state);
    setRoomScriptingStatus(formatRuleCountStatus(roomScriptingConfig.rules.length));
    if (persist) autoSave();
}

function renderRoomScriptingRules() {
    if (!roomScriptingUI.ruleList) return;
    ensureRoomScriptingConfig();
    if (!ensureRoomScriptingBlocklyWorkspace()) {
        return;
    }

    const workspaceState = (roomScriptingConfig?.blocklyState && typeof roomScriptingConfig.blocklyState === "object")
        ? roomScriptingConfig.blocklyState
        : null;
    const incomingHash = getScriptingStateHash(workspaceState);
    const shouldSkipReload = incomingHash && incomingHash === roomScriptingBlocklyLoadedStateHash;

    if (!shouldSkipReload) {
        roomScriptingBlocklySyncGuard = true;
        roomScriptingBlocklyWorkspace.clear();
        let loadedFromState = false;
        if (workspaceState?.blocks) {
            try {
                window.Blockly.serialization.workspaces.load(workspaceState, roomScriptingBlocklyWorkspace);
                loadedFromState = true;
            } catch (err) {
                setRoomScriptingStatus("Gespeicherter Blockly-Stand ist ungÃ¼ltig. Fallback wird geladen.", true);
            }
        }
        if (!loadedFromState) {
            populateWorkspaceFromRoomScriptingRules(roomScriptingBlocklyWorkspace);
        }
        roomScriptingBlocklySyncGuard = false;
        saveRoomScriptingWorkspace(false);
    } else {
        setRoomScriptingStatus(formatRuleCountStatus((roomScriptingConfig.rules || []).length));
    }

    window.Blockly.svgResize(roomScriptingBlocklyWorkspace);
}

function ensureScriptingBlocklyTheme(BlocklyRef) {
    if (scriptingBlocklyTheme) return scriptingBlocklyTheme;
    const baseTheme = BlocklyRef.Themes?.Dark || BlocklyRef.Themes?.Classic;
    scriptingBlocklyTheme = BlocklyRef.Theme.defineTheme("scripting_dark_theme_v1", {
        base: baseTheme,
        componentStyles: {
            workspaceBackgroundColour: "#171717",
            toolboxBackgroundColour: "#242a33",
            toolboxForegroundColour: "#d9e2ef",
            flyoutBackgroundColour: "#252c36",
            flyoutForegroundColour: "#d9e2ef",
            flyoutOpacity: 1,
            scrollbarColour: "#2c6aa3",
            scrollbarOpacity: 0.9,
            insertionMarkerColour: "#3b82f6",
            insertionMarkerOpacity: 0.35,
            cursorColour: "#d9e2ef"
        },
        categoryStyles: {
            trigger_category: { colour: "#f59e0b" },
            data_category: { colour: "#ef4444" },
            condition_category: { colour: "#22c55e" },
            action_category: { colour: "#3b82f6" }
        }
    });
    return scriptingBlocklyTheme;
}

function ensureScriptingBlocklyDefinitions() {
    if (scriptingBlocklyDefinitionsReady) return true;
    const BlocklyRef = window.Blockly;
    if (!BlocklyRef) return false;
    ensureBlocklyDataExpressionBlocks(BlocklyRef);

    if (!BlocklyRef.Blocks["hub_when_state"]) {
        BlocklyRef.Blocks["hub_when_state"] = {
            init: function() {
                this.appendDummyInput()
                    .appendField("When State changes to")
                    .appendField(new BlocklyRef.FieldDropdown([
                        ["Running", "on_running"],
                        ["Solved", "on_solved"]
                    ]), "STATE");
                this.setNextStatement(true, null);
                this.setColour("#f59e0b");
            }
        };

        BlocklyRef.Blocks["hub_when_event"] = {
            init: function() {
                this.appendDummyInput()
                    .appendField("When event")
                    .appendField(new BlocklyRef.FieldDropdown([
                        ["Reset", "on_reset"],
                        ["Custom", "on_custom"]
                    ]), "EVENT")
                    .appendField("triggers");
                this.setNextStatement(true, null);
                this.setColour("#f59e0b");
            }
        };

        BlocklyRef.Blocks["hub_when_external_input"] = {
            init: function() {
                this.appendDummyInput()
                    .appendField("When External Input")
                    .appendField(new BlocklyRef.FieldDropdown([
                        ["gets activated", "on_external_input_activated"],
                        ["returns false Input", "on_external_input_false"],
                        ["returns right Input", "on_external_input_right"]
                    ]), "EXT_EVENT");
                this.setNextStatement(true, null);
                this.setColour("#f59e0b");
            }
        };

        BlocklyRef.Blocks["hub_when_hint"] = {
            init: function() {
                this.appendDummyInput()
                    .appendField("When Hint gets Triggered");
                this.setNextStatement(true, null);
                this.setColour("#f59e0b");
            }
        };

        BlocklyRef.Blocks["hub_when_room_started"] = {
            init: function() {
                this.appendDummyInput()
                    .appendField("When Room gets Started");
                this.setNextStatement(true, null);
                this.setColour("#f59e0b");
            }
        };

        BlocklyRef.Blocks["hub_when_sensor_data"] = {
            init: function() {
                this.appendDummyInput()
                    .appendField("When Sensor")
                    .appendField(new BlocklyRef.FieldDropdown(() => getBlocklySensorDeviceDropdownOptions()), "DEVICE")
                    .appendField("sends Data");
                this.setNextStatement(true, null);
                this.setColour("#f59e0b");
            }
        };

        BlocklyRef.Blocks["hub_when_sensor_match"] = {
            init: function() {
                this.appendDummyInput()
                    .appendField("When Sensor")
                    .appendField(new BlocklyRef.FieldDropdown(() => getBlocklySensorDeviceDropdownOptions()), "DEVICE")
                    .appendField("sends")
                    .appendField(new BlocklyRef.FieldDropdown(() => {
                        const device = this.getFieldValue("DEVICE");
                        return getBlocklySensorFieldDropdownOptions(device);
                    }), "FIELD")
                    .appendField("=")
                    .appendField(new BlocklyRef.FieldTextInput("single"), "VALUE");
                this.setNextStatement(true, null);
                this.setColour("#f59e0b");
            }
        };

        BlocklyRef.Blocks["hub_var_set_sensor"] = {
            init: function() {
                this.appendDummyInput()
                    .appendField("Set variable")
                    .appendField(new BlocklyRef.FieldTextInput("sensorValue"), "VAR")
                    .appendField("=")
                    .appendField(new BlocklyRef.FieldDropdown(() => {
                        const device = this.getFieldValue("DEVICE");
                        return getBlocklySensorFieldDropdownOptions(device);
                    }), "FIELD")
                    .appendField("from Sensor")
                    .appendField(new BlocklyRef.FieldDropdown(() => getBlocklySensorDeviceDropdownOptions()), "DEVICE");
                this.setPreviousStatement(true, null);
                this.setNextStatement(true, null);
                this.setColour("#ef4444");
            }
        };

        BlocklyRef.Blocks["hub_condition"] = {
            init: function() {
                this.appendDummyInput()
                    .appendField("If custom")
                    .appendField(new BlocklyRef.FieldDropdown([
                        ["Equals", "custom_equals"],
                        ["Contains", "custom_contains"]
                    ]), "CONDITION")
                    .appendField("value")
                    .appendField(new BlocklyRef.FieldTextInput(""), "COND_VALUE");
                this.setPreviousStatement(true, null);
                this.setNextStatement(true, null);
                this.setColour("#22c55e");
            }
        };

        BlocklyRef.Blocks["hub_condition_var"] = {
            init: function() {
                this.appendDummyInput()
                    .appendField("If variable")
                    .appendField(new BlocklyRef.FieldTextInput("sensorValue"), "VAR")
                    .appendField(new BlocklyRef.FieldDropdown([
                        ["=", "eq"],
                        ["!=", "neq"],
                        [">", "gt"],
                        [">=", "gte"],
                        ["<", "lt"],
                        ["<=", "lte"]
                    ]), "OP")
                    .appendField("value")
                    .appendField(new BlocklyRef.FieldTextInput(""), "VALUE");
                this.setPreviousStatement(true, null);
                this.setNextStatement(true, null);
                this.setColour("#22c55e");
            }
        };

        BlocklyRef.Blocks["hub_condition_sensor"] = {
            init: function() {
                this.appendDummyInput()
                    .appendField("If Data")
                    .appendField(new BlocklyRef.FieldDropdown(() => getBlocklyAllSensorFieldDropdownOptions()), "FIELD")
                    .appendField(new BlocklyRef.FieldDropdown([
                        ["=", "eq"],
                        ["!=", "neq"],
                        [">", "gt"],
                        [">=", "gte"],
                        ["<", "lt"],
                        ["<=", "lte"]
                    ]), "OP")
                    .appendField("value")
                    .appendField(new BlocklyRef.FieldTextInput(""), "VALUE");
                this.setPreviousStatement(true, null);
                this.setNextStatement(true, null);
                this.setColour("#22c55e");
            }
        };

        BlocklyRef.Blocks["hub_condition_expr"] = {
            init: function() {
                this.appendDummyInput().appendField("If");
                this.appendValueInput("COND").setCheck("Boolean");
                this.setPreviousStatement(true, null);
                this.setNextStatement(true, null);
                this.setColour("#22c55e");
            }
        };

        BlocklyRef.Blocks["hub_condition_else_if_expr"] = {
            init: function() {
                this.appendDummyInput().appendField("Else If");
                this.appendValueInput("COND").setCheck("Boolean");
                this.setPreviousStatement(true, null);
                this.setNextStatement(true, null);
                this.setColour("#22c55e");
            }
        };

        BlocklyRef.Blocks["hub_condition_else_expr"] = {
            init: function() {
                this.appendDummyInput().appendField("Else");
                this.setPreviousStatement(true, null);
                this.setNextStatement(true, null);
                this.setColour("#22c55e");
            }
        };

        BlocklyRef.Blocks["hub_action_play_cue"] = {
            init: function() {
                this.appendDummyInput()
                    .appendField("Play Lighting Cue")
                    .appendField(new BlocklyRef.FieldDropdown(() => getBlocklyCueDropdownOptions()), "CUE");
                this.setPreviousStatement(true, null);
                this.setNextStatement(true, null);
                this.setColour("#3b82f6");
            }
        };

        BlocklyRef.Blocks["hub_action_play_sound"] = {
            init: function() {
                this.appendDummyInput()
                    .appendField("Play Sound Cue")
                    .appendField(new BlocklyRef.FieldDropdown(() => getBlocklySoundDropdownOptions()), "SOUND");
                this.setPreviousStatement(true, null);
                this.setNextStatement(true, null);
                this.setColour("#3b82f6");
            }
        };

        BlocklyRef.Blocks["hub_action_send_custom"] = {
            init: function() {
                this.appendDummyInput().appendField("Send Custom");
                this.appendValueInput("DATA").setCheck(null);
                this.setInputsInline(true);
                this.setPreviousStatement(true, null);
                this.setNextStatement(true, null);
                this.setColour("#3b82f6");
            }
        };

        BlocklyRef.Blocks["hub_action_print_system"] = {
            init: function() {
                this.appendDummyInput().appendField("Print");
                this.appendValueInput("DATA").setCheck(null);
                this.appendDummyInput().appendField("to System Messages");
                this.setInputsInline(true);
                this.setPreviousStatement(true, null);
                this.setNextStatement(true, null);
                this.setColour("#3b82f6");
            }
        };

        BlocklyRef.Blocks["hub_action_give_hint"] = {
            init: function() {
                this.appendDummyInput("HEAD")
                    .appendField("Give Hint")
                    .appendField(new BlocklyRef.FieldDropdown([
                        ["Hint List", "list"],
                        ["Custom", "custom"]
                    ], (newValue) => {
                        setTimeout(() => {
                            if (typeof this.updateShape_ === "function") this.updateShape_();
                        }, 0);
                        return newValue;
                    }), "MODE");
                this.setPreviousStatement(true, null);
                this.setNextStatement(true, null);
                this.setInputsInline(true);
                this.setColour("#3b82f6");
                this.updateShape_();
            },
            updateShape_: function() {
                if (this.getInput("HINTROW")) this.removeInput("HINTROW");
                if (this.getInput("DATA")) this.removeInput("DATA");
                const mode = String(this.getFieldValue("MODE") || "list");
                if (mode === "custom") {
                    this.appendValueInput("DATA")
                        .setCheck(null)
                        .appendField("Text");
                } else {
                    this.appendDummyInput("HINTROW")
                        .appendField("Hint")
                        .appendField(new BlocklyRef.FieldDropdown(() => getBlocklyHintDropdownOptions()), "HINT");
                }
                this.setInputsInline(true);
            }
        };

        BlocklyRef.Blocks["hub_action_get_state"] = {
            init: function() {
                this.appendDummyInput()
                    .appendField("Get State in variable")
                    .appendField(new BlocklyRef.FieldTextInput("puzzleState"), "VAR");
                this.setPreviousStatement(true, null);
                this.setNextStatement(true, null);
                this.setColour("#3b82f6");
            }
        };

        BlocklyRef.Blocks["hub_action_set_state"] = {
            init: function() {
                this.appendDummyInput()
                    .appendField("Set State to")
                    .appendField(new BlocklyRef.FieldDropdown(BLOCKLY_PUZZLE_STATE_OPTIONS), "STATE");
                this.setPreviousStatement(true, null);
                this.setNextStatement(true, null);
                this.setColour("#3b82f6");
            }
        };

        BlocklyRef.Blocks["hub_action_send_custom_var"] = {
            init: function() {
                this.appendDummyInput()
                    .appendField("Send Custom Variable")
                    .appendField(new BlocklyRef.FieldTextInput("sensorValue"), "VAR_NAME");
                this.setPreviousStatement(true, null);
                this.setNextStatement(true, null);
                this.setColour("#3b82f6");
            }
        };

        BlocklyRef.Blocks["hub_action_wait"] = {
            init: function() {
                this.appendDummyInput()
                    .appendField("Wait")
                    .appendField(new BlocklyRef.FieldNumber(1, 0, 600, 0.1), "SECONDS")
                    .appendField("sec");
                this.setPreviousStatement(true, null);
                this.setNextStatement(true, null);
                this.setColour("#3b82f6");
            }
        };

        BlocklyRef.Blocks["hub_action_break"] = {
            init: function() {
                this.appendDummyInput().appendField("Break");
                this.setPreviousStatement(true, null);
                this.setNextStatement(true, null);
                this.setColour("#3b82f6");
            }
        };
        BlocklyRef.Blocks["hub_action_break_all_loops"] = {
            init: function() {
                this.appendDummyInput().appendField("Break All Loops");
                this.setPreviousStatement(true, null);
                this.setNextStatement(true, null);
                this.setColour("#3b82f6");
            }
        };
    }

    scriptingBlocklyDefinitionsReady = true;
    return true;
}

function ensureScriptingBlocklyWorkspace() {
    const BlocklyRef = window.Blockly;
    if (!BlocklyRef) {
        setScriptingStatus("Blockly konnte nicht geladen werden.", true);
        return false;
    }
    if (!scriptingUI.ruleList) return false;
    if (scriptingBlocklyWorkspace) return true;
    if (!ensureScriptingBlocklyDefinitions()) {
        setScriptingStatus("Blockly BlÃ¶cke konnten nicht initialisiert werden.", true);
        return false;
    }

    scriptingBlocklyWorkspace = BlocklyRef.inject(scriptingUI.ruleList, {
        toolbox: SCRIPTING_BLOCKLY_TOOLBOX,
        renderer: "geras",
        media: "vendor/blockly/media/",
        trashcan: false,
        theme: ensureScriptingBlocklyTheme(BlocklyRef),
        grid: {
            spacing: 24,
            length: 2,
            colour: "#2a2a2a",
            snap: true
        },
        move: {
            scrollbars: true,
            drag: true,
            wheel: false
        },
        zoom: {
            controls: false,
            wheel: true,
            startScale: 1,
            maxScale: 2,
            minScale: 0.5,
            scaleSpeed: 1.15
        }
    });
    scriptingBlocklyWorkspace.__md2ScriptingMode = "puzzle";
    ensureScriptingCenterButton();

    scriptingBlocklyWorkspace.addChangeListener((event) => {
        if (scriptingBlocklySyncGuard) return;
        if (!selectedNode || selectedNode.type !== "escape/Puzzle") return;
        if (event?.type === BlocklyRef.Events.UI || event?.type === BlocklyRef.Events.VIEWPORT_CHANGE) {
            return;
        }
        saveScriptingWorkspaceToNode(selectedNode, true);
    });

    return true;
}

function populateWorkspaceFromLegacyScriptingRules(workspace, node) {
    const BlocklyRef = window.Blockly;
    if (!BlocklyRef || !workspace || !node) return;
    ensureScriptingRules(node);
    const rules = node.properties.scriptingRules || [];
    rules.forEach((rule, index) => {
        const isStateTrigger = rule.triggerType === "on_running" || rule.triggerType === "on_activate" || rule.triggerType === "on_solved";
        const isRoomStartedTrigger = rule.triggerType === "on_room_started";
        const isSensorTrigger = rule.triggerType === "on_sensor_data";
        const isSensorMatchTrigger = rule.triggerType === "on_sensor_match";
        const isHintTrigger = rule.triggerType === "on_hint";
        const isExternalInputTrigger = rule.triggerType === "on_external_input_activated"
            || rule.triggerType === "on_external_input_false"
            || rule.triggerType === "on_external_input_right";
        const whenBlock = workspace.newBlock(
            isRoomStartedTrigger
                ? "hub_when_room_started"
                : (isStateTrigger
                ? "hub_when_state"
                : (isSensorTrigger
                    ? "hub_when_sensor_data"
                    : (isSensorMatchTrigger
                        ? "hub_when_sensor_match"
                        : (isExternalInputTrigger
                            ? "hub_when_external_input"
                            : (isHintTrigger ? "hub_when_hint" : "hub_when_event")))))
        );
        if (isRoomStartedTrigger) {
            // no fields
        } else if (isStateTrigger) {
            whenBlock.setFieldValue(rule.triggerType === "on_solved" ? "on_solved" : "on_running", "STATE");
        } else if (isSensorTrigger) {
            whenBlock.setFieldValue(String(rule.triggerValue || ""), "DEVICE");
        } else if (isSensorMatchTrigger) {
            whenBlock.setFieldValue(String(rule.triggerValue || ""), "DEVICE");
            whenBlock.setFieldValue(String(rule.triggerField || ""), "FIELD");
            whenBlock.setFieldValue(String(rule.triggerExpected || ""), "VALUE");
        } else if (isExternalInputTrigger) {
            whenBlock.setFieldValue(String(rule.triggerType || "on_external_input_activated"), "EXT_EVENT");
        } else if (isHintTrigger) {
            // no fields
        } else {
            const eventType = rule.triggerType === "on_hint" ? "on_reset" : (SCRIPTING_TRIGGER_TYPES.includes(rule.triggerType) ? rule.triggerType : "on_reset");
            whenBlock.setFieldValue(eventType, "EVENT");
        }
        whenBlock.initSvg();
        whenBlock.render();
        whenBlock.moveBy(80 + ((index % 3) * 260), 60 + (Math.floor(index / 3) * 120));

        let previous = whenBlock;
        if (rule.conditionType && rule.conditionType !== "none") {
            const isVarCondition = rule.conditionType === "var_compare";
            const isSensorCondition = rule.conditionType === "sensor_compare";
            const isExprCondition = rule.conditionType === "expr";
            const conditionBlock = workspace.newBlock(isExprCondition
                ? "hub_condition_expr"
                : (isVarCondition ? "hub_condition_var" : (isSensorCondition ? "hub_condition_sensor" : "hub_condition")));
            if (isExprCondition) {
                const exprBlock = createBlocklyDataExprBlock(workspace, rule.conditionExpr || null);
                if (exprBlock?.outputConnection) {
                    const input = conditionBlock.getInput("COND");
                    if (input?.connection) input.connection.connect(exprBlock.outputConnection);
                }
            } else if (isVarCondition) {
                conditionBlock.setFieldValue(String(rule.conditionVar || "sensorValue"), "VAR");
                conditionBlock.setFieldValue(String(rule.conditionOp || "eq"), "OP");
                conditionBlock.setFieldValue(String(rule.conditionValue || ""), "VALUE");
            } else if (isSensorCondition) {
                conditionBlock.setFieldValue(String(rule.conditionField || ""), "FIELD");
                conditionBlock.setFieldValue(String(rule.conditionOp || "eq"), "OP");
                conditionBlock.setFieldValue(String(rule.conditionValue || ""), "VALUE");
            } else {
                const conditionType = rule.conditionType === "custom_contains" ? "custom_contains" : "custom_equals";
                conditionBlock.setFieldValue(conditionType, "CONDITION");
                conditionBlock.setFieldValue(String(rule.conditionValue || ""), "COND_VALUE");
            }
            conditionBlock.initSvg();
            conditionBlock.render();
            previous.nextConnection?.connect(conditionBlock.previousConnection);
            previous = conditionBlock;
        }

        let actionBlock = null;
        if (rule.actionType === "play_cue") {
            actionBlock = workspace.newBlock("hub_action_play_cue");
            actionBlock.setFieldValue(String(rule.actionValue || ""), "CUE");
        } else if (rule.actionType === "play_sound") {
            actionBlock = workspace.newBlock("hub_action_play_sound");
            actionBlock.setFieldValue(String(rule.actionValue || ""), "SOUND");
        } else if (rule.actionType === "set_var_from_sensor") {
            actionBlock = workspace.newBlock("hub_var_set_sensor");
            actionBlock.setFieldValue(String(rule.actionValue || "sensorValue"), "VAR");
            actionBlock.setFieldValue(String(rule.actionSourceDevice || rule.triggerValue || ""), "DEVICE");
            actionBlock.setFieldValue(String(rule.actionSourceField || ""), "FIELD");
        } else if (rule.actionType === "get_state") {
            actionBlock = workspace.newBlock("hub_action_get_state");
            actionBlock.setFieldValue(String(rule.actionValue || "puzzleState"), "VAR");
        } else if (rule.actionType === "set_state") {
            actionBlock = workspace.newBlock("hub_action_set_state");
            actionBlock.setFieldValue(String(rule.actionValue || "locked"), "STATE");
        } else if (rule.actionType === "print_system") {
            actionBlock = workspace.newBlock("hub_action_print_system");
        } else if (rule.actionType === "give_hint") {
            actionBlock = workspace.newBlock("hub_action_give_hint");
            const raw = String(rule.actionValue || "");
            const isListMode = raw.startsWith("hint:");
            actionBlock.setFieldValue(isListMode ? "list" : "custom", "MODE");
            if (isListMode) actionBlock.setFieldValue(raw.slice(5) || "-1", "HINT");
        } else if (rule.actionType === "wait") {
            actionBlock = workspace.newBlock("hub_action_wait");
            actionBlock.setFieldValue(Number.isFinite(Number(rule.actionValue)) ? Number(rule.actionValue) : 1, "SECONDS");
        } else if (rule.actionType === "break") {
            actionBlock = workspace.newBlock("hub_action_break");
        } else if (rule.actionType === "break_all_loops") {
            actionBlock = workspace.newBlock("hub_action_break_all_loops");
        } else {
            actionBlock = workspace.newBlock("hub_action_send_custom");
        }
        if (actionBlock.type === "hub_action_send_custom"
            || actionBlock.type === "hub_action_print_system"
            || (actionBlock.type === "hub_action_give_hint" && String(actionBlock.getFieldValue("MODE") || "") === "custom")) {
            const actionExpr = (rule.actionExpr && typeof rule.actionExpr === "object")
                ? rule.actionExpr
                : (rule.actionValue ? { type: "text", value: String(rule.actionValue || "") } : null);
            const exprBlock = createBlocklyDataExprBlock(workspace, actionExpr);
            if (exprBlock?.outputConnection) {
                const input = actionBlock.getInput("DATA");
                if (input?.connection) input.connection.connect(exprBlock.outputConnection);
            }
        }
        actionBlock.initSvg();
        actionBlock.render();
        previous.nextConnection?.connect(actionBlock.previousConnection);
    });
}

function extractScriptingRulesFromWorkspace(workspace) {
    const rules = [];
    if (!workspace) return rules;

    const topBlocks = (workspace.getTopBlocks(false) || [])
        .filter((block) => block.type === "hub_when_state"
            || block.type === "hub_when_event"
            || block.type === "hub_when_external_input"
            || block.type === "hub_when_hint"
            || block.type === "hub_when_sensor_data"
            || block.type === "hub_when_sensor_match"
            || block.type === "hub_when_room_started")
        .sort((a, b) => {
            const aPos = a.getRelativeToSurfaceXY();
            const bPos = b.getRelativeToSurfaceXY();
            return aPos.y === bPos.y ? aPos.x - bPos.x : aPos.y - bPos.y;
        });

    let nextId = 1;
    const cloneState = (state) => ({
        triggerType: String(state?.triggerType || "on_running"),
        triggerValue: String(state?.triggerValue || ""),
        triggerField: String(state?.triggerField || ""),
        triggerExpected: String(state?.triggerExpected || ""),
        conditionType: String(state?.conditionType || "none"),
        conditionValue: String(state?.conditionValue || ""),
        conditionVar: String(state?.conditionVar || ""),
        conditionField: String(state?.conditionField || ""),
        conditionExpr: cloneDataExpression(state?.conditionExpr),
        conditionOp: String(state?.conditionOp || "eq"),
        exprBranchRawList: Array.isArray(state?.exprBranchRawList) ? state.exprBranchRawList.map(cloneDataExpression).filter(Boolean) : []
    });
    const getLoopSignature = (stack = []) => stack
        .map((entry) => {
            const type = String(entry?.type || "");
            const key = String(entry?.key || "");
            if (type === "repeat") return `${type}:${key}@${Number.isFinite(Number(entry?.iter)) ? Number(entry.iter) : 0}`;
            return `${type}:${key}`;
        })
        .join(">");
    const normalizeLoopStack = (stack = []) => stack.map((entry) => ({
        type: String(entry?.type || ""),
        key: String(entry?.key || ""),
        iter: Number.isFinite(Number(entry?.iter)) ? Number(entry.iter) : null
    }));
    const emitActionRule = (current, state, loopCtx = { mode: "", stack: [] }) => {
        const actionType = current.type === "hub_action_play_cue"
            ? "play_cue"
            : (current.type === "hub_action_play_sound"
                ? "play_sound"
            : (current.type === "hub_action_send_custom"
                ? "send_custom"
                    : (current.type === "hub_action_print_system"
                        ? "print_system"
                        : (current.type === "hub_action_give_hint"
                            ? "give_hint"
                    : (current.type === "hub_action_send_custom_var"
                    ? "send_custom_var"
                    : (current.type === "hub_var_set_sensor"
                        ? "set_var_from_sensor"
                        : (current.type === "hub_action_get_state"
                            ? "get_state"
                            : (current.type === "hub_action_set_state"
                                ? "set_state"
                                : (current.type === "hub_action_break"
                                    ? "break"
                                    : (current.type === "hub_action_break_all_loops" ? "break_all_loops" : "wait"))))))))));
        const hintMode = actionType === "give_hint" ? String(current.getFieldValue("MODE") || "list") : "";
        const loopStack = normalizeLoopStack(loopCtx?.stack || []);
        const currentLoop = loopStack.length ? loopStack[loopStack.length - 1] : null;
        const actionExpr = (actionType === "send_custom"
            || actionType === "print_system"
            || (actionType === "give_hint" && hintMode === "custom"))
            ? buildDataExprFromBlocklyBlock(current.getInputTargetBlock("DATA"))
            : null;
        const actionValue = actionType === "play_cue"
            ? String(current.getFieldValue("CUE") || "")
            : (actionType === "play_sound"
                ? String(current.getFieldValue("SOUND") || "")
            : (actionType === "give_hint"
                ? (hintMode === "custom" ? "" : `hint:${String(current.getFieldValue("HINT") || "-1")}`)
            : ((actionType === "send_custom" || actionType === "print_system")
                ? ""
                : (actionType === "send_custom_var"
                    ? String(current.getFieldValue("VAR_NAME") || "")
                    : (actionType === "set_var_from_sensor"
                        ? String(current.getFieldValue("VAR") || "")
                        : (actionType === "get_state"
                            ? String(current.getFieldValue("VAR") || "puzzleState")
                            : (actionType === "set_state"
                                ? String(current.getFieldValue("STATE") || "locked")
                                : ((actionType === "break" || actionType === "break_all_loops")
                                    ? ""
                                    : String(current.getFieldValue("SECONDS") || "1")))))))));
        rules.push({
            id: nextId++,
            triggerType: state.triggerType,
            triggerValue: state.triggerValue,
            triggerField: state.triggerField,
            triggerExpected: state.triggerExpected,
            conditionType: state.conditionType,
            conditionVar: state.conditionVar,
            conditionField: state.conditionType === "sensor_compare" ? state.conditionField : "",
            conditionExpr: state.conditionType === "expr" ? state.conditionExpr : null,
            conditionOp: (state.conditionType === "var_compare" || state.conditionType === "sensor_compare") ? state.conditionOp : "eq",
            conditionValue: state.conditionType === "none" ? "" : state.conditionValue,
            actionType,
            actionValue,
            actionExpr,
            actionSourceDevice: actionType === "set_var_from_sensor" ? String(current.getFieldValue("DEVICE") || "") : "",
            actionSourceField: actionType === "set_var_from_sensor" ? String(current.getFieldValue("FIELD") || "") : "",
            loopMode: loopCtx?.mode === "forever" ? "forever" : "",
            loopIntervalSec: 1,
            loopStack,
            loopBreakKey: currentLoop ? String(currentLoop.key || "") : "",
            loopBreakType: currentLoop ? String(currentLoop.type || "") : ""
        });
    };
    const walkChain = (startBlock, inheritedState, loopCtx = { mode: "", stack: [] }) => {
        let state = cloneState(inheritedState);
        let current = startBlock;
        while (current) {
            if (current.type === "hub_condition") {
                const ctRaw = current.getFieldValue("CONDITION");
                state.conditionType = ctRaw === "custom_contains" ? "custom_contains" : "custom_equals";
                state.conditionValue = String(current.getFieldValue("COND_VALUE") || "");
                state.conditionVar = "";
                state.conditionField = "";
                state.conditionOp = "eq";
                state.conditionExpr = null;
                state.exprBranchRawList = [];
            } else if (current.type === "hub_condition_var") {
                state.conditionType = "var_compare";
                state.conditionVar = String(current.getFieldValue("VAR") || "");
                state.conditionField = "";
                state.conditionOp = String(current.getFieldValue("OP") || "eq");
                state.conditionValue = String(current.getFieldValue("VALUE") || "");
                state.conditionExpr = null;
                state.exprBranchRawList = [];
            } else if (current.type === "hub_condition_sensor") {
                state.conditionType = "sensor_compare";
                state.conditionVar = "";
                state.conditionField = String(current.getFieldValue("FIELD") || "");
                state.conditionOp = String(current.getFieldValue("OP") || "eq");
                state.conditionValue = String(current.getFieldValue("VALUE") || "");
                state.conditionExpr = null;
                state.exprBranchRawList = [];
            } else if (current.type === "hub_condition_expr") {
                state.conditionType = "expr";
                state.conditionVar = "";
                state.conditionField = "";
                state.conditionOp = "eq";
                state.conditionValue = "";
                const exprRoot = current.getInputTargetBlock("COND");
                state.conditionExpr = buildDataExprFromBlocklyBlock(exprRoot);
                state.exprBranchRawList = state.conditionExpr ? [cloneDataExpression(state.conditionExpr)] : [];
            } else if (current.type === "hub_condition_else_if_expr") {
                const exprRoot = current.getInputTargetBlock("COND");
                const rawExpr = buildDataExprFromBlocklyBlock(exprRoot);
                const elseGuard = composeElseGuardExpr(state.exprBranchRawList);
                const combinedExpr = composeExprAnd(elseGuard, rawExpr);
                state.conditionType = "expr";
                state.conditionVar = "";
                state.conditionField = "";
                state.conditionOp = "eq";
                state.conditionValue = "";
                state.conditionExpr = combinedExpr;
                if (rawExpr) state.exprBranchRawList.push(cloneDataExpression(rawExpr));
            } else if (current.type === "hub_condition_else_expr") {
                const elseGuard = composeElseGuardExpr(state.exprBranchRawList);
                state.conditionType = elseGuard ? "expr" : "none";
                state.conditionVar = "";
                state.conditionField = "";
                state.conditionOp = "eq";
                state.conditionValue = "";
                state.conditionExpr = elseGuard;
            } else if (current.type === "script_repeat_times") {
                const countRaw = Number(current.getFieldValue("COUNT"));
                const count = Number.isFinite(countRaw) ? Math.max(0, Math.min(1000, Math.floor(countRaw))) : 0;
                const bodyStart = current.getInputTargetBlock("DO");
                const repeatFamilyKey = `${getLoopSignature(loopCtx?.stack || [])}>repeat:${String(current.id || "")}`;
                for (let i = 0; i < count; i += 1) {
                    walkChain(bodyStart, state, {
                        mode: loopCtx?.mode || "",
                        stack: [...(loopCtx?.stack || []), { type: "repeat", key: repeatFamilyKey, iter: i }]
                    });
                }
            } else if (current.type === "script_forever") {
                const bodyStart = current.getInputTargetBlock("DO");
                const foreverKey = `${getLoopSignature(loopCtx?.stack || [])}>forever:${String(current.id || "")}`;
                walkChain(bodyStart, state, {
                    mode: "forever",
                    stack: [...(loopCtx?.stack || []), { type: "forever", key: foreverKey, iter: null }]
                });
            } else if (current.type === "hub_action_play_cue"
                || current.type === "hub_action_play_sound"
                || current.type === "hub_action_send_custom"
                || current.type === "hub_action_print_system"
                || current.type === "hub_action_give_hint"
                || current.type === "hub_action_send_custom_var"
                || current.type === "hub_var_set_sensor"
                || current.type === "hub_action_get_state"
                || current.type === "hub_action_set_state"
                || current.type === "hub_action_wait"
                || current.type === "hub_action_break"
                || current.type === "hub_action_break_all_loops") {
                emitActionRule(current, state, loopCtx);
            }
            current = current.getNextBlock();
        }
    };
    topBlocks.forEach((topBlock) => {
        const topState = {
            triggerType: "on_running",
            triggerValue: "",
            triggerField: "",
            triggerExpected: "",
            conditionType: "none",
            conditionValue: "",
            conditionVar: "",
            conditionField: "",
            conditionExpr: null,
            conditionOp: "eq",
            exprBranchRawList: []
        };
        if (topBlock.type === "hub_when_room_started") {
            topState.triggerType = "on_room_started";
        } else if (topBlock.type === "hub_when_state") {
            const stateRaw = topBlock.getFieldValue("STATE");
            topState.triggerType = stateRaw === "on_solved" ? "on_solved" : "on_running";
        } else if (topBlock.type === "hub_when_external_input") {
            const raw = String(topBlock.getFieldValue("EXT_EVENT") || "").trim();
            topState.triggerType = SCRIPTING_TRIGGER_TYPES.includes(raw) ? raw : "on_external_input_activated";
        } else if (topBlock.type === "hub_when_hint") {
            topState.triggerType = "on_hint";
        } else if (topBlock.type === "hub_when_sensor_data") {
            topState.triggerType = "on_sensor_data";
            topState.triggerValue = String(topBlock.getFieldValue("DEVICE") || "");
        } else if (topBlock.type === "hub_when_sensor_match") {
            topState.triggerType = "on_sensor_match";
            topState.triggerValue = String(topBlock.getFieldValue("DEVICE") || "");
            topState.triggerField = String(topBlock.getFieldValue("FIELD") || "");
            topState.triggerExpected = String(topBlock.getFieldValue("VALUE") || "");
        } else {
            const eventRaw = topBlock.getFieldValue("EVENT");
            topState.triggerType = SCRIPTING_TRIGGER_TYPES.includes(eventRaw) ? eventRaw : "on_reset";
        }
        walkChain(topBlock.getNextBlock(), topState, { mode: "", stack: [] });
    });

    return rules;
}

function saveScriptingWorkspaceToNode(node, persist = true) {
    const BlocklyRef = window.Blockly;
    if (!BlocklyRef || !scriptingBlocklyWorkspace || !node || node.type !== "escape/Puzzle") return;

    const state = BlocklyRef.serialization.workspaces.save(scriptingBlocklyWorkspace);
    node.properties.scriptingBlocklyState = state;
    node.properties.scriptingRules = extractScriptingRulesFromWorkspace(scriptingBlocklyWorkspace);
    const maxId = node.properties.scriptingRules.reduce((max, rule) => Math.max(max, parseInt(rule?.id, 10) || 0), 0);
    node.properties.scriptingNextRuleId = maxId + 1;

    scriptingBlocklyLoadedNodeId = node.id;
    scriptingBlocklyLoadedStateHash = getScriptingStateHash(state);
    setScriptingStatus(formatRuleCountStatus(node.properties.scriptingRules.length));
    refreshPuzzleListItem(node);
    if (persist) autoSave();
}

function renderScriptingRules(node) {
    if (!node || node.type !== "escape/Puzzle" || !scriptingUI.ruleList) return;
    ensureScriptingRules(node);
    if (!ensureScriptingBlocklyWorkspace()) {
        return;
    }

    const workspaceState = (node.properties?.scriptingBlocklyState && typeof node.properties.scriptingBlocklyState === "object")
        ? node.properties.scriptingBlocklyState
        : null;
    const incomingHash = getScriptingStateHash(workspaceState);
    const shouldSkipReload = scriptingBlocklyLoadedNodeId === node.id && incomingHash && incomingHash === scriptingBlocklyLoadedStateHash;

    if (!shouldSkipReload) {
        scriptingBlocklySyncGuard = true;
        scriptingBlocklyWorkspace.clear();
        let loadedFromState = false;
        let usedLegacyRules = false;
        if (workspaceState?.blocks) {
            try {
                window.Blockly.serialization.workspaces.load(workspaceState, scriptingBlocklyWorkspace);
                loadedFromState = true;
            } catch (err) {
                setScriptingStatus("Gespeicherter Blockly-Stand ist ungÃƒÂ¼ltig. Fallback wird geladen.", true);
            }
        }
        if (!loadedFromState) {
            usedLegacyRules = (node.properties.scriptingRules || []).length > 0;
            populateWorkspaceFromLegacyScriptingRules(scriptingBlocklyWorkspace, node);
        }
        scriptingBlocklySyncGuard = false;
        saveScriptingWorkspaceToNode(node, usedLegacyRules);
    } else {
        setScriptingStatus(formatRuleCountStatus((node.properties.scriptingRules || []).length));
    }

    window.Blockly.svgResize(scriptingBlocklyWorkspace);
}

async function openScriptingOverlay() {
    if(!selectedNode || selectedNode.type !== "escape/Puzzle") return;
    await ensureSoundsCacheReady();
    if (scriptingUI.title) {
        const puzzleName = selectedNode.properties?.Name || selectedNode.title || `Puzzle ${selectedNode.id}`;
        scriptingUI.title.textContent = `${puzzleName} Skripting`;
    }
    if (scriptingUI.overlay) scriptingUI.overlay.style.display = "flex";
    renderScriptingRules(selectedNode);
    if (window.Blockly && scriptingBlocklyWorkspace) {
        setTimeout(() => {
            window.Blockly.svgResize(scriptingBlocklyWorkspace);
        }, 0);
    }
}

function closeScriptingOverlay() {
    try {
        if (document.activeElement && typeof document.activeElement.blur === "function") {
            document.activeElement.blur();
        }
    } catch (error) {
        // no-op
    }
    try {
        const BlocklyRef = window.Blockly;
        if (BlocklyRef && typeof BlocklyRef.hideChaff === "function") {
            BlocklyRef.hideChaff(true);
        }
    } catch (error) {
        // no-op
    }
    if (scriptingUI.overlay) scriptingUI.overlay.style.display = "none";
}

function centerScriptingWorkspaceView() {
    if (!scriptingBlocklyWorkspace) return;
    try {
        if (typeof scriptingBlocklyWorkspace.setScale === "function") {
            scriptingBlocklyWorkspace.setScale(1);
        }
        if (typeof scriptingBlocklyWorkspace.scrollCenter === "function") {
            scriptingBlocklyWorkspace.scrollCenter();
        }
    } catch (error) {
        console.warn("Could not center scripting workspace:", error);
    }
}

async function openRoomScriptingOverlay() {
    await ensureSoundsCacheReady();
    ensureRoomScriptingConfig();
    if (roomScriptingUI.title) {
        roomScriptingUI.title.textContent = "Room Skripting";
    }
    if (roomScriptingUI.overlay) roomScriptingUI.overlay.style.display = "flex";
    renderRoomScriptingRules();
    if (window.Blockly && roomScriptingBlocklyWorkspace) {
        setTimeout(() => {
            window.Blockly.svgResize(roomScriptingBlocklyWorkspace);
        }, 0);
    }
}

function closeRoomScriptingOverlay() {
    try {
        if (document.activeElement && typeof document.activeElement.blur === "function") {
            document.activeElement.blur();
        }
    } catch (error) {
        // no-op
    }
    try {
        const BlocklyRef = window.Blockly;
        if (BlocklyRef && typeof BlocklyRef.hideChaff === "function") {
            BlocklyRef.hideChaff(true);
        }
    } catch (error) {
        // no-op
    }
    if (roomScriptingUI.overlay) roomScriptingUI.overlay.style.display = "none";
}

function centerRoomScriptingWorkspaceView() {
    if (!roomScriptingBlocklyWorkspace) return;
    try {
        if (typeof roomScriptingBlocklyWorkspace.setScale === "function") {
            roomScriptingBlocklyWorkspace.setScale(1);
        }
        if (typeof roomScriptingBlocklyWorkspace.scrollCenter === "function") {
            roomScriptingBlocklyWorkspace.scrollCenter();
        }
    } catch (error) {
        console.warn("Could not center room scripting workspace:", error);
    }
}

function ensureInputFallbacks(node){
    if(!node || !node.properties) return;
    if(!node.properties.inputFallbacks || typeof node.properties.inputFallbacks !== "object" || Array.isArray(node.properties.inputFallbacks)){
        node.properties.inputFallbacks = {};
    }
}

function ensureInternalVariables(node){
    if(!node || !node.properties) return;
    if(!node.properties.internalVariables || typeof node.properties.internalVariables !== "object" || Array.isArray(node.properties.internalVariables)){
        node.properties.internalVariables = {};
    }
}

function normalizeFallbackType(type){
    const t = (type ?? "").toString().toLowerCase();
    if(t === "string" || t === "number" || t === "boolean" || t === "media") return t;
    return "";
}

function isFallbackCapableType(type){
    return !!normalizeFallbackType(type);
}

function parseInternalValue(raw, type){
    const t = normalizeFallbackType(type);
    const val = (raw ?? "").toString().trim();
    if(!val) return null;
    if(t === "number"){
        if(!/^-?\d+(?:\.\d+)?$/.test(val)) return null;
        const num = parseFloat(val);
        return Number.isFinite(num) ? num : null;
    }
    if(t === "boolean"){
        const lowered = val.toLowerCase();
        if(["true","1","yes","on"].includes(lowered)) return true;
        if(["false","0","no","off"].includes(lowered)) return false;
        return null;
    }
    return val;
}

function getInternalValueEntry(node, name){
    ensureInternalVariables(node);
    if(!node || !node.properties || !node.properties.internalVariables) return null;
    if(!Object.prototype.hasOwnProperty.call(node.properties.internalVariables, name)) return null;
    return node.properties.internalVariables[name];
}

function setInternalValueEntry(node, name, entry){
    ensureInternalVariables(node);
    node.properties.internalVariables[name] = entry;
}

function deleteInternalValueEntry(node, name){
    ensureInternalVariables(node);
    delete node.properties.internalVariables[name];
}

function getInputFallbackEntry(node, name){
    ensureInputFallbacks(node);
    if(!node || !node.properties || !node.properties.inputFallbacks) return null;
    if(!Object.prototype.hasOwnProperty.call(node.properties.inputFallbacks, name)) return null;
    return node.properties.inputFallbacks[name];
}

function setInputFallbackEntry(node, name, entry){
    ensureInputFallbacks(node);
    node.properties.inputFallbacks[name] = entry;
}

function deleteInputFallbackEntry(node, name){
    ensureInputFallbacks(node);
    delete node.properties.inputFallbacks[name];
}

function renameInputFallbackEntry(node, oldName, newName){
    if(!node || !oldName || !newName || oldName === newName) return;
    const entry = getInputFallbackEntry(node, oldName);
    if(entry){
        deleteInputFallbackEntry(node, oldName);
        setInputFallbackEntry(node, newName, entry);
    }
}

function ensureOutputValues(node){
    if(!node || !node.properties) return;
    if(!node.properties.outputValues || typeof node.properties.outputValues !== "object" || Array.isArray(node.properties.outputValues)){
        node.properties.outputValues = {};
    }
}

function getOutputValueEntry(node, name){
    ensureOutputValues(node);
    if(!node || !node.properties || !node.properties.outputValues) return null;
    if(!Object.prototype.hasOwnProperty.call(node.properties.outputValues, name)) return null;
    return node.properties.outputValues[name];
}

function setOutputValueEntry(node, name, entry){
    ensureOutputValues(node);
    node.properties.outputValues[name] = entry;
}

function deleteOutputValueEntry(node, name){
    ensureOutputValues(node);
    delete node.properties.outputValues[name];
}

function renameOutputValueEntry(node, oldName, newName){
    if(!node || !oldName || !newName || oldName === newName) return;
    const entry = getOutputValueEntry(node, oldName);
    if(entry){
        deleteOutputValueEntry(node, oldName);
        setOutputValueEntry(node, newName, entry);
    }
}

function getFallbackValueString(entry){
    if(entry && typeof entry === "object" && Object.prototype.hasOwnProperty.call(entry, "value")){
        return entry.value === undefined || entry.value === null ? "" : String(entry.value);
    }
    if(entry === undefined || entry === null) return "";
    return String(entry);
}

function parseFallbackValue(raw, type){
    const t = normalizeFallbackType(type);
    const val = (raw ?? "").toString().trim();
    if(!val){
        return { ok: false, error: "Bitte einen Wert eingeben oder Clear nutzen." };
    }
    if(t === "string" || t === "media"){
        return { ok: true, value: val };
    }
    if(t === "number"){
        if(!/^-?\d+(?:\.\d+)?$/.test(val)){
            return { ok: false, error: "UngÃƒÂ¼ltige Zahl." };
        }
        return { ok: true, value: val };
    }
    if(t === "boolean"){
        const lowered = val.toLowerCase();
        if(["true","1","yes","on"].includes(lowered)) return { ok: true, value: "true" };
        if(["false","0","no","off"].includes(lowered)) return { ok: true, value: "false" };
        return { ok: false, error: "Nur true/false (oder 1/0)." };
    }
    return { ok: false, error: "Unbekannter Datentyp." };
}

let fallbackModalState = null;

function openFallbackModal(node, name, inputType, direction){
    if(!ui.fallbackModal) return;
    if(!node || !name) return;
    const typeLabel = normalizeFallbackType(inputType) || "string";
    const isOutput = direction === "out";
    const isInternal = direction === "internal";
    fallbackModalState = { node, name, inputType: typeLabel, direction };
    const entry = isInternal
        ? getInternalValueEntry(node, name)
        : isOutput
            ? getOutputValueEntry(node, name)
            : getInputFallbackEntry(node, name);
    const titlePrefix = node?.properties?.isAnalog ? "Value" : "Fallback";
    if(ui.fallbackModalTitle) ui.fallbackModalTitle.textContent = `${titlePrefix} - ${name}`;
    if(ui.fallbackInputName) ui.fallbackInputName.textContent = name;
    if(ui.fallbackInputType) ui.fallbackInputType.textContent = typeLabel;
    if(ui.fallbackInputValue) ui.fallbackInputValue.value = getFallbackValueString(entry);
    if(ui.fallbackInputError) ui.fallbackInputError.textContent = "";
    ui.fallbackModal.style.display = "flex";
    ui.fallbackInputValue?.focus();
}

function closeFallbackModal(){
    if(ui.fallbackModal) ui.fallbackModal.style.display = "none";
    fallbackModalState = null;
}

function ensureLogicInputs(node){
    if(!node || node.type!=="escape/Logic") return;
    const links = node.graph ? node.graph.links : (graph && graph.links);
    node.inputs = (node.inputs || []).filter(inp => inp && isActionType(inp.type));
    const mainInput = node.inputs[0];
    const mainLinks = [];
    if (mainInput) {
        if (Array.isArray(mainInput.links)) mainLinks.push(...mainInput.links);
        else if (mainInput.link != null) mainLinks.push(mainInput.link);
    }
    if(!node.inputs.length){
        node.addInput("Trigger", LiteGraph.ACTION, { nameLocked:true, multiple:true, logicTrigger:true });
    }
    if(node.inputs[0]){
        node.inputs[0].name = "Trigger";
        node.inputs[0].type = LiteGraph.ACTION;
        node.inputs[0].nameLocked = true;
        node.inputs[0].multiple = true;
        node.inputs[0].logicTrigger = true;
    }
    for(let i = node.inputs.length - 1; i >= 1; i -= 1){
        const extra = node.inputs[i];
        const extraLinks = [];
        if (extra) {
            if (Array.isArray(extra.links)) extraLinks.push(...extra.links);
            else if (extra.link != null) extraLinks.push(extra.link);
            extra.link = null;
            extra.links = null;
        }
        extraLinks.forEach(id => {
            if (!links || !links[id]) return;
            links[id].target_slot = 0;
            if (!mainLinks.includes(id)) mainLinks.push(id);
        });
        node.removeInput(i);
    }
    if (node.inputs[0]) {
        node.inputs[0].links = mainLinks.length ? mainLinks : null;
        node.inputs[0].link = mainLinks.length ? mainLinks[0] : null;
    }
    updateSlotLabels(node);
}

function updateHintBadge(){
    if(!ui.hintCountBadge) return;
    let count = 0;
    if(selectedNode && selectedNode.type==="escape/Puzzle"){
        ensureHints(selectedNode);
        count = selectedNode.properties.hints.length || 0;
    }
    ui.hintCountBadge.textContent = `Hints: ${count}`;
}

function fillExternalScreenDropdown(selectedId){
    if(!ui.extScreen) return;
    ui.extScreen.innerHTML = "";
    const optNone=document.createElement("option");
    optNone.value=""; optNone.textContent="- None -";
    ui.extScreen.appendChild(optNone);
    getInputCapableScreens().forEach(scr=>{
        const opt=document.createElement("option");
        opt.value=String(scr.id);
        opt.textContent=scr.name;
        if(String(scr.id)===String(selectedId)) opt.selected=true;
        ui.extScreen.appendChild(opt);
    });
}

const EXTERNAL_CHECK_SOLUTION = "__PUZZLE_SOLUTION__";

function isCheckVariableType(type) {
    const t = (type ?? "").toString().toLowerCase();
    return t === "string" || t === "number";
}

function applyTypeStyleToTypedElement(el, type) {
    if (!el) return;
    const t = (type ?? "").toString().toLowerCase();
    if (!t) return;

    el.dataset.type = t;

    if (t === "string") {
        el.style.backgroundImage = "linear-gradient(0deg, var(--type-string-bg), var(--type-string-bg))";
        el.style.borderLeftColor = "var(--type-string-border)";
    } else if (t === "number") {
        el.style.backgroundImage = "linear-gradient(0deg, var(--type-number-bg), var(--type-number-bg))";
        el.style.borderLeftColor = "var(--type-number-border)";
    } else if (t === "boolean") {
        el.style.backgroundImage = "linear-gradient(0deg, var(--type-boolean-bg), var(--type-boolean-bg))";
        el.style.borderLeftColor = "var(--type-boolean-border)";
    } else if (t === "action" || t === "-1") {
        el.style.backgroundImage = "linear-gradient(0deg, var(--type-action-bg), var(--type-action-bg))";
        el.style.borderLeftColor = "var(--type-action-border)";
    }

    el.style.color = "#fff";
}

function buildExternalVariableOptionsForPuzzle(node) {
    const options = [];
    if (!node || node.type !== "escape/Puzzle") return options;

    const inputs = Array.isArray(node.inputs) ? node.inputs : [];
    const outputs = Array.isArray(node.outputs) ? node.outputs : [];
    const internalVars = node.properties?.internalVariables || {};

    inputs.forEach(inp => {
        if (!inp) return;
        if (inp.name === "Trigger") return;
        if (!isCheckVariableType(inp.type)) return;
        options.push({ value: `in:${inp.name}`, label: `${inp.name}`, type: inp.type });
    });

    outputs.forEach(out => {
        if (!out) return;
        if (out.name === "Done") return;
        if (!isCheckVariableType(out.type)) return;
        options.push({ value: `out:${out.name}`, label: `${out.name} (Output)`, type: out.type });
    });

    Object.entries(internalVars).forEach(([name, entry]) => {
        if (!name) return;
        const t = entry?.type || "string";
        if (!isCheckVariableType(t)) return;
        options.push({ value: `internal:${name}`, label: `${name} (Internal)`, type: t });
    });

    return options;
}

function getExternalCheckVariableType(node, value) {
    if (!value) return "";
    if (value === EXTERNAL_CHECK_SOLUTION) return "";
    if (!node || node.type !== "escape/Puzzle") return "";

    const [direction, name] = value.split(":", 2);
    if (!direction || !name) return "";

    const list = direction === "in" ? (node.inputs || []) : direction === "out" ? (node.outputs || []) : [];
    const found = list.find(s => s && s.name === name);
    return found?.type ?? "";
}

function setExternalCheckTrigger(label, type) {
    if (!ui.extCheckTrigger) return;
    ui.extCheckTrigger.innerHTML = `<span>${label}</span><span class="dropdown-arrow">>></span>`;
    ui.extCheckTrigger.style.backgroundImage = "";
    ui.extCheckTrigger.style.borderLeftColor = "";
    ui.extCheckTrigger.style.color = "";
    delete ui.extCheckTrigger.dataset.type;
    if (type) applyTypeStyleToTypedElement(ui.extCheckTrigger, type);
}

function createExternalCheckDropdownItem(value, label, type, isSelected) {
    const item = document.createElement("div");
    item.className = "dropdown-item" + (isSelected ? " selected" : "");
    item.dataset.value = value;
    item.style.borderLeft = "4px solid #666";
    item.style.backgroundColor = "rgba(255,255,255,0.05)";

    if (type) applyTypeStyleToTypedElement(item, type);

    const spanText = document.createElement("span");
    spanText.textContent = label;
    spanText.style.flexGrow = "1";
    item.appendChild(spanText);

    item.addEventListener("click", () => {
        if (!selectedNode || selectedNode.type !== "escape/Puzzle") return;
        selectedNode.properties.externalCheckVariable = value;
        setExternalCheckTrigger(label, type || getExternalCheckVariableType(selectedNode, value));
        ui.extCheckMenu?.classList.remove("open");
        autoSave();
    });

    return item;
}

function fillExternalCheckVariableDropdown(node) {
    if (!ui.extCheckDropdown || !ui.extCheckMenu) return;

    const extId = node?.properties?.externalScreenId || "";
    const enabled = !!extId;
    ui.extCheckDropdown.classList.toggle("dropdown-disabled", !enabled);
    if (ui.extShowAssignment) ui.extShowAssignment.disabled = !enabled;

    ui.extCheckMenu.innerHTML = "";
    if (!node || node.type !== "escape/Puzzle") {
        setExternalCheckTrigger("- None -", "");
        return;
    }

    if (!enabled) {
        node.properties.externalCheckVariable = "";
        setExternalCheckTrigger("- None -", "");
        return;
    }

    if (ui.extShowAssignment) {
        ui.extShowAssignment.checked = node.properties.externalShowAssignment !== false;
    }

    const selected = node.properties.externalCheckVariable || "";
    const vars = buildExternalVariableOptionsForPuzzle(node);
    const optionMap = new Map(vars.map(v => [v.value, v]));

    const noneSelected = !selected;
    ui.extCheckMenu.appendChild(createExternalCheckDropdownItem("", "- None -", "", noneSelected));

    if (!node.properties?.isAnalog) {
        ui.extCheckMenu.appendChild(
            createExternalCheckDropdownItem(
                EXTERNAL_CHECK_SOLUTION,
                "Get Solution from Puzzle",
                "",
                selected === EXTERNAL_CHECK_SOLUTION
            )
        );
    }

    vars.forEach(v => {
        ui.extCheckMenu.appendChild(
            createExternalCheckDropdownItem(v.value, v.label, v.type, selected === v.value)
        );
    });

    const resolved = selected === EXTERNAL_CHECK_SOLUTION
        ? { label: "Get Solution from Puzzle", type: "" }
        : optionMap.get(selected);
    if (node.properties?.isAnalog && selected === EXTERNAL_CHECK_SOLUTION) {
        node.properties.externalCheckVariable = "";
    }

    if (selected && !resolved) {
        node.properties.externalCheckVariable = "";
        setExternalCheckTrigger("- None -", "");
    } else if (resolved) {
        setExternalCheckTrigger(resolved.label, resolved.type);
    } else {
        setExternalCheckTrigger("- None -", "");
    }
}
function fillHintScreenDropdown(selectedId){
    if(!ui.hintScreen) return;
    ui.hintScreen.innerHTML = "";
    const optNone=document.createElement("option");
    optNone.value=""; optNone.textContent="- None -";
    ui.hintScreen.appendChild(optNone);
    getHintCapableScreens().forEach(scr=>{
        const opt=document.createElement("option");
        opt.value=String(scr.id);
        opt.textContent=scr.name;
        if(String(scr.id)===String(selectedId)) opt.selected=true;
        ui.hintScreen.appendChild(opt);
    });
}
function refreshExternalSelectionForSelectedPuzzle(){
    if(!selectedNode || selectedNode.type!=="escape/Puzzle") return;
    const currentId = selectedNode.properties.externalScreenId || "";
    fillExternalScreenDropdown(currentId);
    const exists = getInputCapableScreens().some(s=>String(s.id)===String(currentId));
    if(!exists){
        selectedNode.properties.externalScreenId = "";
        selectedNode.properties.externalCheckVariable = "";
        if(ui.extScreen) ui.extScreen.value = "";
    }
}
function refreshHintSelectionForSelectedPuzzle(){
    if(!selectedNode || selectedNode.type!=="escape/Puzzle") return;
    const currentId = selectedNode.properties.hintScreenId || "";
    fillHintScreenDropdown(currentId);
    const exists = getHintCapableScreens().some(s=>String(s.id)===String(currentId));
    if(!exists){
        selectedNode.properties.hintScreenId = "";
        if(ui.hintScreen) ui.hintScreen.value = "";
    }
}

// Hint modal wiring
if(ui.hintConfigureBtn){
    ui.hintConfigureBtn.addEventListener("click", ()=>{
        if(selectedScreenId!==null) return;
        if(selectedNode && selectedNode.type==="escape/Puzzle"){
            ensureHints(selectedNode);
            openHintModal(selectedNode);
        }
    });
}
if(ui.hintModalClose){
    ui.hintModalClose.addEventListener("click", ()=>{ closeHintModal(); });
}
if(ui.hintAddBtn){
    ui.hintAddBtn.addEventListener("click", ()=>{
        if(!hintModalNode) return;
        ensureHints(hintModalNode);
        hintModalNode.properties.hints.push({ text:"", delayFromStart:60, delayAfterPrev:0 });
        renderHintList();
        autoSave();
    });
}
if(ui.hintManualToggle){
    ui.hintManualToggle.addEventListener("change", ()=>{
        if(!hintModalNode) return;
        hintModalNode.properties.automaticHintTrigger = ui.hintManualToggle.checked;
        hintModalNode.properties.manualHintTrigger = !ui.hintManualToggle.checked; // legacy inverse
        renderHintList();
        autoSave();
    });
}
if(ui.hintShowAssignmentToggle){
    ui.hintShowAssignmentToggle.addEventListener("change", ()=>{
        if(!hintModalNode) return;
        hintModalNode.properties.showHintAssignment = !!ui.hintShowAssignmentToggle.checked;
        renderHintList();
        autoSave();
    });
}

if(ui.fallbackModalClose){
    ui.fallbackModalClose.addEventListener("click", ()=>{ closeFallbackModal(); });
}
if(ui.fallbackClearBtn){
    ui.fallbackClearBtn.addEventListener("click", ()=>{
        if(!fallbackModalState) return;
        const { node, name, direction } = fallbackModalState;
        if(direction === "internal"){
            deleteInternalValueEntry(node, name);
        } else if(direction === "out"){
            deleteOutputValueEntry(node, name);
        } else {
            deleteInputFallbackEntry(node, name);
        }
        autoSave();
        if(node && node.type === "escape/Puzzle"){
            renderIOLists(node);
            renderInternalVariables(node);
        }
        closeFallbackModal();
    });
}
if(ui.fallbackSaveBtn){
    ui.fallbackSaveBtn.addEventListener("click", ()=>{
        if(!fallbackModalState) return;
        const { node, name, inputType, direction } = fallbackModalState;
        const raw = ui.fallbackInputValue ? ui.fallbackInputValue.value : "";
        const parsed = parseFallbackValue(raw, inputType);
        if(!parsed.ok){
            if(ui.fallbackInputError) ui.fallbackInputError.textContent = parsed.error || "UngÃƒÂ¼ltiger Wert.";
            return;
        }
        if(direction === "internal"){
            setInternalValueEntry(node, name, { value: parsed.value, type: inputType });
        } else if(direction === "out"){
            setOutputValueEntry(node, name, { value: parsed.value, type: inputType });
        } else {
            setInputFallbackEntry(node, name, { value: parsed.value, type: inputType });
        }
        autoSave();
        if(node && node.type === "escape/Puzzle"){
            renderIOLists(node);
            renderInternalVariables(node);
        }
        closeFallbackModal();
    });
}
if(ui.fallbackInputValue){
    ui.fallbackInputValue.addEventListener("keydown", (e)=>{
        if(e.key === "Enter"){
            e.preventDefault();
            ui.fallbackSaveBtn?.click();
        }
    });
}

function updatePropertiesPanel(node){ 
    selectedScreenId=null;
    updateScreenHighlight(null);
    updateSidebarHighlight(node); 
    closeFallbackModal();
    if(!node){
        closeScriptingOverlay();
        hidePropertiesPanel();
        return;
    } 
    if(node.type !== "escape/Start" && node.type !== "escape/End"){
        clearBranchPairSelection();
    }
    selectedNode=node; 
    if(node.type !== "escape/Puzzle"){
        closeScriptingOverlay();
    }
    propertiesSidebar.style.display="block"; 
    logWindow.classList.add("sidebar-open"); 
    updateCenterFlowButtonPosition();
    const sections=ioControlsContainer.querySelectorAll('.form-item, .io-section, hr, .category, .toggle-row'); 
    sections.forEach(el=>el.style.display='none'); 
    if (ui.addInBtn) { ui.addInBtn.style.display = ""; ui.addInBtn.disabled = false; }
    const actionOptDefault = ui.inType?.querySelector?.('option[value="action"]');
    if (actionOptDefault) { actionOptDefault.style.display = ""; actionOptDefault.disabled = false; }
    
    // PUZZLE
    if(node.type==="escape/Puzzle"){ 
        sections.forEach(el=>{if(el.classList.contains('puzzle-prop')||el.classList.contains('io-section'))el.style.display='';}); 
        
        ui.name.value=node.properties.Name||""; 
        ui.isStart.checked=node.properties.isStartNode||false;
        syncPuzzleTriggerInput(node);
        ui.isAnalog.checked=node.properties.isAnalog||false;
        ensureHints(node);
        ensureHintTriggerDefaults(node);
        ensureScriptingRules(node);
        updateHintBadge();
        updateSlotLabels(node);
        renderInternalVariables(node);
        if (scriptingUI.overlay?.style.display === "flex") {
            renderScriptingRules(node);
        }
        
        const extId = node.properties.externalScreenId || "";
        fillExternalScreenDropdown(extId);
        if(ui.extScreen) ui.extScreen.value = extId;
        node.properties.externalCheck = !!extId;

        const hintId = node.properties.hintScreenId || "";
        fillHintScreenDropdown(hintId);
        if(ui.hintScreen) ui.hintScreen.value = hintId;
        node.properties.hintEnabled = !!hintId;

        ui.deviceContainer.style.display = "block"; 
        const isAnalog = !!node.properties.isAnalog;
        const currentDev = isAnalog ? "" : (node.properties.selectedDeviceID || "");
        fillDeviceDropdown(currentDev, isAnalog); 
        if(ui.dropdown){
            if(isAnalog){
                ui.dropdown.classList.add("dropdown-disabled");
            } else {
                ui.dropdown.classList.remove("dropdown-disabled");
            }
        }

        ui.inType.style.display=""; 
        const actionOpt = ui.inType.querySelector('option[value="action"]');
        if (actionOpt) {
            actionOpt.style.display = "";
            actionOpt.disabled = true;
        }
        const inputsHeaderLabel = ioControlsContainer.querySelector('.category-header[data-target="inputs-section"] span:last-child');
        if (inputsHeaderLabel) inputsHeaderLabel.textContent = "Inputs";
        if (ui.inType.value === "action") ui.inType.value = "boolean";
        ui.outType.style.display="";
        ui.addOutBtn.disabled = false;
        renderIOLists(node); 
        const inputsHeaderEl = ioControlsContainer.querySelector('.category-header[data-target="inputs-section"]');
        const inputsCategory = inputsHeaderEl ? inputsHeaderEl.closest(".category") : null;
        if (inputsCategory) inputsCategory.style.display = isAnalog ? "none" : "";
        fillExternalCheckVariableDropdown(node);
        if(ui.hintManualToggle) ui.hintManualToggle.checked = !!node.properties.automaticHintTrigger;
    } 
    // TABLET
    else if(node.type==="escape/Tablet") {
        sections.forEach(el=>{if(el.classList.contains('tablet-prop'))el.style.display='';}); 
        ui.name.value = node.title || "Tablet Input"; // Nutzung des Name-Felds fÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¼r den Titel
        ui.tabletCode.value = node.properties.code || "";
        ui.tabletMsg.value = node.properties.message || "";
        updateHintBadge();
    }
    // LOGIC
    else if(node.type==="escape/Logic"){ 
        const logicType = (node.properties.logicType || "AND").toUpperCase();
        ui.logicType.value = logicType;
        const inputsHeader = ioControlsContainer.querySelector('.category-header[data-target="inputs-section"] span:last-child');
        const inputsHeaderEl = ioControlsContainer.querySelector('.category-header[data-target="inputs-section"]');
        const inputsCategory = inputsHeaderEl ? inputsHeaderEl.closest(".category") : null;
        if(logicType === "QUEUE"){
            sections.forEach(el=>{if(el.classList.contains('io-section')||el.classList.contains('logic-prop'))el.style.display='';}); 
            ensureQueueInputs(node);
            if (inputsHeader) inputsHeader.textContent = "Group Inputs";
            ui.inType.style.display="";
            const actionOpt = ui.inType.querySelector('option[value="action"]');
            if (actionOpt) actionOpt.style.display = "none";
            if (ui.inType.value === "action") ui.inType.value = "boolean";
            ui.addInBtn.style.display = "";
            ui.addInBtn.disabled = false;
            ui.outType.style.display="none";
            ui.addOutBtn.disabled = true;
            if (inputsCategory) inputsCategory.style.display = "";
            if (ui.queueDelayRow) ui.queueDelayRow.style.display = "";
            if (ui.queueDelay) {
                const delay = Number(node.properties?.queueDelaySec);
                ui.queueDelay.value = Number.isFinite(delay) && delay >= 0 ? delay : 0;
            }
            if (ui.queueActivateAllRow) ui.queueActivateAllRow.style.display = "";
            if (ui.queueActivateAll) {
                ui.queueActivateAll.checked = !!node.properties?.queueActivateAllFree;
            }
            renderIOLists(node);
        } else {
            sections.forEach(el=>{if(el.classList.contains('logic-prop')||el.classList.contains('input-section'))el.style.display='';}); 
            ensureLogicInputs(node);
            if (inputsHeader) inputsHeader.textContent = "Inputs";
            const actionOpt = ui.inType.querySelector('option[value="action"]');
            if (actionOpt) actionOpt.style.display = "";
            ui.inType.style.display="none"; 
            ui.addInBtn.style.display = "none";
            ui.addInBtn.disabled = true;
            if (inputsCategory) inputsCategory.style.display = "none";
            if (ui.queueDelayRow) ui.queueDelayRow.style.display = "none";
            if (ui.queueActivateAllRow) ui.queueActivateAllRow.style.display = "none";
            renderIOLists(node,true); 
        }
        updateHintBadge();
    } 
    // END
    else if(node.type==="escape/End" || node.type==="escape/Start"){ 
        hidePropertiesPanel();
        return;
    } 
}

function showScreenProperties(screen){
    if(!screen){ hidePropertiesPanel(); return; }
    selectedNode = null;
    selectedScreenId = screen.id;
    clearBranchPairSelection();
    updateSidebarHighlight(null);
    updateScreenHighlight(screen.id);
    propertiesSidebar.style.display = "block";
    logWindow.classList.add("sidebar-open");
    updateCenterFlowButtonPosition();
    const sections=ioControlsContainer.querySelectorAll('.form-item, .io-section, hr, .category, .toggle-row');
    sections.forEach(el=>el.style.display='none');
    sections.forEach(el=>{ if(el.classList.contains('screen-prop')) el.style.display=''; });
    ui.name.value = screen.name || "";
    applyScreenRoleUI(screen);
    if(ui.screenPath) ui.screenPath.value = screen.path || "";
    if (ui.screenOpenPageBtn) ui.screenOpenPageBtn.disabled = !String(screen.path || "").trim();
    updateHintBadge();
}

function openScreenPageInNewTab(screen) {
    if (!screen) return;
    const slug = String(screen.path || "").trim();
    if (!slug) return;
    const targetUrl = `${window.location.origin}/${slug}`;
    window.open(targetUrl, "_blank", "noopener,noreferrer");
}

function normalizeScreenRole(role) {
    if (role === "hint") return "hint";
    if (role === "progress") return "progress";
    return "player";
}

function applyScreenRoleUI(screen) {
    if (!screen) return;
    const role = normalizeScreenRole(screen.role);
    if (ui.screenRole) ui.screenRole.value = role;
    const showProgress = role === "progress";
    if (ui.progressStyleRow) ui.progressStyleRow.style.display = showProgress ? "" : "none";
    if (ui.progressBranchesRow) ui.progressBranchesRow.style.display = showProgress ? "" : "none";
    if (ui.progressRunningTimeRow) ui.progressRunningTimeRow.style.display = showProgress ? "" : "none";
    if (ui.progressStyle) ui.progressStyle.value = screen.progressStyle || "simple";
    if (ui.progressRunningTime) ui.progressRunningTime.checked = !!screen.showRunningTime;
    if (showProgress) renderProgressBranchList(screen);
}

function getAvailableBranchIds() {
    const starts = graph.findNodesByType("escape/Start") || [];
    if (!starts.length) return [];
    let ids = starts.map(node => Number(node?.properties?.pairId))
        .filter(id => Number.isFinite(id) && id > 0);
    if (ids.length !== starts.length) {
        assignMissingBranchIds();
        ids = starts.map(node => Number(node?.properties?.pairId))
            .filter(id => Number.isFinite(id) && id > 0);
    }
    return Array.from(new Set(ids)).sort((a, b) => a - b);
}

function renderProgressBranchList(screen) {
    if (!ui.progressBranches || !screen) return;
    const branchIds = getAvailableBranchIds();
    ui.progressBranches.innerHTML = "";

    if (!branchIds.length) {
        const empty = document.createElement("div");
        empty.className = "branch-select-item";
        empty.style.color = "#888";
        empty.textContent = "No branches available.";
        ui.progressBranches.appendChild(empty);
        return;
    }

    const selected = Array.isArray(screen.branchIds)
        ? screen.branchIds.map(id => parseInt(id, 10)).filter(id => Number.isFinite(id))
        : [];
    const filteredSelected = selected.filter(id => branchIds.includes(id));
    if (filteredSelected.length !== selected.length) {
        screen.branchIds = filteredSelected;
        autoSave();
    }
    const selectedSet = new Set(filteredSelected);
    const showAll = selectedSet.size === 0;

    branchIds.forEach(id => {
        const row = document.createElement("div");
        row.className = "branch-select-item";

        const label = document.createElement("span");
        label.className = "branch-label";
        label.textContent = `Branch ${id}`;

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = showAll || selectedSet.has(id);
        checkbox.dataset.branchId = String(id);
        checkbox.addEventListener("change", () => {
            const checkedIds = Array.from(ui.progressBranches.querySelectorAll("input[type='checkbox']"))
                .filter(el => el.checked)
                .map(el => parseInt(el.dataset.branchId, 10))
                .filter(val => Number.isFinite(val));
            screen.branchIds = checkedIds.length === branchIds.length ? [] : checkedIds;
            autoSave();
        });

        row.appendChild(label);
        row.appendChild(checkbox);
        ui.progressBranches.appendChild(row);
    });
}

function refreshProgressBranchesForSelectedScreen() {
    if (selectedScreenId === null) return;
    const screen = screens.find(s => s.id === selectedScreenId);
    if (!screen) return;
    if (normalizeScreenRole(screen.role) !== "progress") return;
    renderProgressBranchList(screen);
}

function hidePropertiesPanel(){ propertiesSidebar.style.display="none"; selectedNode=null; selectedScreenId=null; updateSidebarHighlight(null); updateScreenHighlight(null); logWindow.classList.remove("sidebar-open"); updateCenterFlowButtonPosition(); closeFallbackModal(); }
function fillDeviceDropdown(currentSelection,isAnalog=false){ 
    const updateLabel=(text)=>{ ui.dropdownTrigger.innerHTML=`<span>${text}</span><span class="dropdown-arrow">>></span>`; };
    if(isAnalog){
        ui.dropdownMenu.innerHTML="";
        updateLabel("Analog - Select Device -");
        return;
    }
    fetch('/api/devices').then(r=>r.json()).then(devices=>{
        ui.dropdownMenu.innerHTML="";
        updateLabel("-- Select Device --");
        const deviceList=Object.values(devices).sort((a,b)=>a.name.localeCompare(b.name));
        ui.dropdownMenu.appendChild(createDropdownItem("","-- No Device --",currentSelection==="",false));
        deviceList.forEach(dev=>{
            const isSelected=dev.id===currentSelection;
            if(isSelected) updateLabel(`${dev.name} (${dev.ip})`);
            ui.dropdownMenu.appendChild(createDropdownItem(dev.id,`${dev.name} (${dev.ip})`,isSelected,true));
        });
        if(currentSelection && !devices[currentSelection] && currentSelection!==""){
            updateLabel(`Unknown (${currentSelection})`);
            ui.dropdownMenu.appendChild(createDropdownItem(currentSelection,`Unknown (${currentSelection})`,true,false));
        }
    }).catch(err=>{});
}
function createDropdownItem(id,text,isSelected,isDeletable){ 
    const div=document.createElement("div");
    div.className="dropdown-item "+(isSelected?"selected":"");
    const spanText=document.createElement("span");
    spanText.textContent=text;
    spanText.style.flexGrow="1";
    div.appendChild(spanText);
    spanText.addEventListener("click",()=>{
        if(selectedNode){
            selectedNode.properties.isAnalog=false;
            selectedNode.properties.selectedDeviceID=id;
            ui.dropdownMenu.classList.remove("open");
            fillDeviceDropdown(id, false);
            autoSave();
        }
    });
    if(isDeletable && id!==""){
        const delBtn=document.createElement("button");
        delBtn.type="button";
        delBtn.className="item-delete-btn";
        delBtn.innerHTML="X";
        delBtn.title="Remove";
        delBtn.addEventListener("click",e=>{
            e.stopPropagation(); e.preventDefault();
            fetch('/api/devices/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id})})
                .then(r=>r.json()).then(data=>{
                    let graphModified=false;
                    const puzzleNodes=graph.findNodesByType("escape/Puzzle");
                    if(puzzleNodes){
                        puzzleNodes.forEach(node=>{
                            if(node.properties.selectedDeviceID===id){
                                node.properties.selectedDeviceID="";
                                node.setDirtyCanvas(true,true);
                                graphModified=true;
                            }
                        });
                    }
                    if(selectedNode){ fillDeviceDropdown(selectedNode.properties.selectedDeviceID, !!selectedNode.properties.isAnalog); }
                    if(graphModified){ autoSave(); }
                });
        });
        div.appendChild(delBtn);
    }
    return div; 
}

function renderIOLists(node, inputsOnly = false){
    const renderList = (elem, items, type) => {
        elem.innerHTML = "";
        if(!items) return;
        items.forEach((item, idx) => {
            if(item.name === "Done") return;
            if(type === 'in' && node.type === "escape/Puzzle" && item.name === "Trigger") return;

            const div = document.createElement("div");
            div.className = "io-item";
            div.dataset.type = item.type;

            const isLogicNode = (node.type === "escape/Logic");
            const isQueueNode = isQueueLogic(node);
            const isInput = (type === 'in');
            if (isQueueNode && isInput && isActionType(item.type)) return;
            let showRemove = true;
            if(isInput){
                if(isLogicNode && !isQueueNode){
                    showRemove = false;
                } else if(isQueueNode && isActionType(item.type)){
                    showRemove = false;
                } else if(node.type === "escape/Puzzle"){
                    showRemove = (items.length > 1);
                }
            } else if(isQueueNode){
                showRemove = false;
            }

            let fallbackBtn = null;
            let fallbackPreview = null;
            const fallbackCapable = node.type === "escape/Puzzle" && isFallbackCapableType(item.type);
            if(fallbackCapable && (isInput || type === "out")){
                fallbackBtn = document.createElement("button");
                fallbackBtn.type = "button";
                fallbackBtn.className = "io-fallback-btn";
                fallbackBtn.title = node.properties?.isAnalog ? "Value" : "Fallback";
                fallbackBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.65 1.65 0 0 0 15 19.4a1.65 1.65 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82-.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.65 1.65 0 0 0 1 1.5 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.57 0 1.08.23 1.46.6.38.38.6.9.6 1.46s-.23 1.08-.6 1.46A1.65 1.65 0 0 0 19.4 15z"></path></svg>`;
            }

            const input = document.createElement("input");
            input.type = "text";
            input.className = "io-name-input";
            input.value = item.name;
            if(item.nameLocked) input.disabled = true;
            if(isQueueLogic(node) && type === "out") input.disabled = true;

            const nameWrap = document.createElement("div");
            nameWrap.className = "io-name-wrap";
            nameWrap.appendChild(input);
            if(fallbackCapable){
                const entry = isInput
                    ? getInputFallbackEntry(node, input.value || item.name)
                    : getOutputValueEntry(node, input.value || item.name);
                if(entry || (node.properties?.isAnalog && type === "out")){
                    fallbackPreview = document.createElement("span");
                    fallbackPreview.className = `io-fallback-preview${node.properties?.isAnalog ? " io-value-preview" : ""}`;
                    const preview = entry ? getFallbackValueString(entry) : "--";
                    fallbackPreview.textContent = `(${preview})`;
                    nameWrap.appendChild(fallbackPreview);
                }
            }
            div.appendChild(nameWrap);

            let removeBtn = null;
                if(showRemove){
                    removeBtn = document.createElement("button");
                    removeBtn.type = "button";
                    removeBtn.className = "io-remove";
                    removeBtn.textContent = "X";
                    removeBtn.addEventListener("click", e => {
                        e.preventDefault();
                        if(isLogicNode && !isQueueNode && isInput) return;
                        if(isQueueNode && isInput && isActionType(item.type)){
                            return;
                        }
                        if(node.type === "escape/Puzzle"){
                            if(isInput){
                                deleteInputFallbackEntry(node, input.value || item.name);
                            } else if(type === "out"){
                                deleteOutputValueEntry(node, input.value || item.name);
                            }
                        }
                        if(type === 'in') node.removeInput(idx);
                        else node.removeOutput(idx);
                if(isQueueNode && type === 'in'){
                    syncQueueGroupOutputs(node);
                }
                        updatePropertiesPanel(node);
                        autoSave();
                    });
                }
            if(fallbackBtn){
                fallbackBtn.addEventListener("click", e => {
                    e.preventDefault();
                    const inputName = input.value || item.name;
                    openFallbackModal(node, inputName, item.type, type);
                });
                div.appendChild(fallbackBtn);
            }
            if(showRemove && removeBtn){
                div.appendChild(removeBtn);
            }

            input.addEventListener("keydown", e => { if(e.key === "Enter"){ e.preventDefault(); input.blur(); } });
            let prevName = item.name;
            input.addEventListener("change", e => {
                const newName = e.target.value;
                if(type === 'in') node.inputs[idx].name = newName;
                else node.outputs[idx].name = newName;
                if(node.type === "escape/Puzzle"){
                    if(type === 'in'){
                        renameInputFallbackEntry(node, prevName, newName);
                    } else if(type === 'out'){
                        renameOutputValueEntry(node, prevName, newName);
                    }
                }
                if(isQueueLogic(node) && type === 'in'){
                    syncQueueGroupOutputs(node);
                }
                prevName = newName;
                updateSlotLabels(node);
                fillExternalCheckVariableDropdown(node);
                node.setDirtyCanvas(true, true);
                autoSave();
            });

            elem.appendChild(div);
        });
    };
    renderList(ui.inputs, node.inputs, 'in');
    if(!inputsOnly) renderList(ui.outputs, node.outputs, 'out');
}

function renderInternalVariables(node){
    if(!ui.internalList) return;
    ui.internalList.innerHTML = "";
    if(!node || node.type !== "escape/Puzzle") return;
    ensureInternalVariables(node);
    const entries = node.properties.internalVariables || {};
    const names = Object.keys(entries).sort((a,b)=>a.localeCompare(b));
    names.forEach((name) => {
        const entry = entries[name] || { type: "string", value: null };
        const div = document.createElement("div");
        div.className = "io-item";
        div.dataset.type = entry.type || "string";

        const nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.className = "io-name-input";
        nameInput.value = name;

        const fallbackPreview = document.createElement("span");
        fallbackPreview.className = `io-fallback-preview${node.properties?.isAnalog ? " io-value-preview" : ""}`;
        fallbackPreview.textContent = `(${getFallbackValueString(entry) || "--"})`;

        const fallbackBtn = document.createElement("button");
        fallbackBtn.type = "button";
        fallbackBtn.className = "io-fallback-btn";
        fallbackBtn.title = node.properties?.isAnalog ? "Value" : "Fallback";
        fallbackBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.65 1.65 0 0 0 15 19.4a1.65 1.65 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82-.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.65 1.65 0 0 0 1 1.5 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.57 0 1.08.23 1.46.6.38.38.6.9.6 1.46s-.23 1.08-.6 1.46A1.65 1.65 0 0 0 19.4 15z"></path></svg>`;

        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "io-remove";
        removeBtn.textContent = "X";

        nameInput.addEventListener("keydown", e => { if(e.key === "Enter"){ e.preventDefault(); nameInput.blur(); } });
        nameInput.addEventListener("change", e => {
            const newName = e.target.value.trim();
            if(!newName || newName === name) return;
            if(entries[newName]) return;
            entries[newName] = entry;
            delete entries[name];
            if(node.properties.externalCheckVariable === `internal:${name}`){
                node.properties.externalCheckVariable = `internal:${newName}`;
            }
            fillExternalCheckVariableDropdown(node);
            renderInternalVariables(node);
            autoSave();
        });

        fallbackBtn.addEventListener("click", e => {
            e.preventDefault();
            openFallbackModal(node, name, entry.type || "string", "internal");
        });

        removeBtn.addEventListener("click", e => {
            e.preventDefault();
            delete entries[name];
            if(node.properties.externalCheckVariable === `internal:${name}`){
                node.properties.externalCheckVariable = "";
            }
            fillExternalCheckVariableDropdown(node);
            renderInternalVariables(node);
            autoSave();
        });

        div.appendChild(nameInput);
        div.appendChild(fallbackPreview);
        div.appendChild(fallbackBtn);
        div.appendChild(removeBtn);
        ui.internalList.appendChild(div);
    });
}


ioControlsContainer.addEventListener('change',e=>{ 
    const t=e.target; 
    if(selectedScreenId!==null){
        if(t===ui.name){
            const screen=screens.find(s=>s.id===selectedScreenId);
            if(screen){
                screen.name = t.value;
                const item=document.querySelector(`.screen-item[data-screen-id="${screen.id}"] .puzzle-item-text`);
                if(item)item.textContent = screen.name;
                updateScreenHighlight(screen.id);
                autoSave();
            }
        } else if (t===ui.screenRole){
            const screen=screens.find(s=>s.id===selectedScreenId);
            if(screen){
                screen.role = normalizeScreenRole(t.value);
                applyScreenRoleUI(screen);
                renderScreenList();
                refreshExternalSelectionForSelectedPuzzle();
                refreshHintSelectionForSelectedPuzzle();
                autoSave();
            }
        } else if (t===ui.progressStyle) {
            const screen=screens.find(s=>s.id===selectedScreenId);
            if (screen) {
                screen.progressStyle = t.value || "simple";
                autoSave();
            }
        } else if (t===ui.progressRunningTime) {
            const screen=screens.find(s=>s.id===selectedScreenId);
            if (screen) {
                screen.showRunningTime = !!t.checked;
                autoSave();
            }
        } else if (t===ui.screenPath){
            const screen=screens.find(s=>s.id===selectedScreenId);
            if(screen){
                const slug = ensureUniqueScreenPath(t.value || screen.path || `screen-${screen.id}`, screen.id);
                screen.path = slug;
                t.value = slug;
                if (ui.screenOpenPageBtn) ui.screenOpenPageBtn.disabled = !String(slug || "").trim();
                autoSave();
            }
        }
        return;
    }
    if(!selectedNode)return; 
    
        if(t===ui.name) {
            if(selectedNode.type==="escape/Puzzle"){ 
                selectedNode.properties.Name=t.value; 
                selectedNode.title=t.value; 
                refreshPuzzleListItem(selectedNode);
            } else if (selectedNode.type==="escape/Tablet") {
                selectedNode.title = t.value;
            }
    } else if(t===ui.isStart) {
        selectedNode.properties.isStartNode=t.checked;
        syncPuzzleTriggerInput(selectedNode);
    } else if(t===ui.isAnalog) { 
        selectedNode.properties.isAnalog=t.checked;
        if(t.checked){
            selectedNode.properties.selectedDeviceID="";
            if (selectedNode.properties.externalCheckVariable === EXTERNAL_CHECK_SOLUTION) {
                selectedNode.properties.externalCheckVariable = "";
            }
            removeNonActionInputsForAnalog(selectedNode);
            if(ui.dropdown){
                ui.dropdown.classList.add("dropdown-disabled");
                ui.dropdownTrigger.innerHTML = `<span>Analog - Select Device -</span><span class="dropdown-arrow">>></span>`;
            }
        } else {
            if(ui.dropdown) ui.dropdown.classList.remove("dropdown-disabled");
        }
        const devId = selectedNode.properties.isAnalog ? "" : (selectedNode.properties.selectedDeviceID || "");
        fillDeviceDropdown(devId, t.checked);
        fillExternalCheckVariableDropdown(selectedNode);
        if(selectedNode.type === "escape/Puzzle"){
            renderIOLists(selectedNode);
            const inputsHeaderEl = ioControlsContainer.querySelector('.category-header[data-target="inputs-section"]');
            const inputsCategory = inputsHeaderEl ? inputsHeaderEl.closest(".category") : null;
            if (inputsCategory) inputsCategory.style.display = t.checked ? "none" : "";
        }
    } else if(t===ui.extScreen){
        selectedNode.properties.externalScreenId = t.value || "";
        selectedNode.properties.externalCheck = !!selectedNode.properties.externalScreenId;
        if (!selectedNode.properties.externalScreenId) {
            selectedNode.properties.externalCheckVariable = "";
        }
        refreshExternalSelectionForSelectedPuzzle();
        if(selectedNode.updateSlots) selectedNode.updateSlots();
        fillExternalCheckVariableDropdown(selectedNode);
    } else if (t===ui.extShowAssignment) {
        selectedNode.properties.externalShowAssignment = !!t.checked;
    } else if(t===ui.hintScreen){
        selectedNode.properties.hintScreenId = t.value || "";
        selectedNode.properties.hintEnabled = !!selectedNode.properties.hintScreenId;
        refreshHintSelectionForSelectedPuzzle();
    } else if(t===ui.tabletCode) { 
        selectedNode.properties.code=t.value;
    } else if(t===ui.tabletMsg) { 
        selectedNode.properties.message=t.value;
  } else if(t===ui.logicType){ 
      selectedNode.properties.logicType=t.value; 
      selectedNode.title=t.value; 
      normalizeLogicNodeInputs(selectedNode);
      updatePropertiesPanel(selectedNode);
  } else if(t===ui.queueDelay) {
      const rawDelay = parseFloat(t.value);
      selectedNode.properties.queueDelaySec = Number.isFinite(rawDelay) && rawDelay >= 0 ? rawDelay : 0;
  } else if(t===ui.queueActivateAll) {
      selectedNode.properties.queueActivateAllFree = !!t.checked;
  } else if(t===ui.autoRestart) {
      selectedNode.properties.autoRestart=t.checked; 
  } else if(t===ui.restartDelay) {
        selectedNode.properties.restartDelay=parseInt(t.value); 
    }
    selectedNode.setDirtyCanvas(true,true); 
    autoSave(); 
});


const allInputs=ioControlsContainer.querySelectorAll('input'); allInputs.forEach(inp=>{inp.addEventListener('keydown',e=>{if(e.key==="Enter"){e.preventDefault();inp.blur();}});});
ui.addInBtn.addEventListener("click",e=>{ e.preventDefault(); if(!selectedNode)return; let type; if(selectedNode.type==="escape/Logic"){ const logicType = (selectedNode.properties?.logicType || "AND").toUpperCase(); if(logicType !== "QUEUE") return; type=ui.inType.value; }else{ if(ui.inType.value==='action') return; type=ui.inType.value; } if(isQueueLogic(selectedNode)){ const groupCount = getQueueGroupInputs(selectedNode).length; selectedNode.addInput("In "+(groupCount+1),type,{queueGroup:true,multiple:true}); syncQueueGroupOutputs(selectedNode); }else{ selectedNode.addInput("In "+(selectedNode.inputs.length+1),type); } updatePropertiesPanel(selectedNode); autoSave(); });
ui.addOutBtn.addEventListener("click",e=>{ e.preventDefault(); if(!selectedNode || isQueueLogic(selectedNode))return; selectedNode.addOutput("Out "+(selectedNode.outputs.length+1),ui.outType.value==='action'?LiteGraph.EVENT:ui.outType.value); updatePropertiesPanel(selectedNode); autoSave(); });
ui.addInternalBtn?.addEventListener("click", e=>{ 
    e.preventDefault();
    if(!selectedNode || selectedNode.type !== "escape/Puzzle") return;
    ensureInternalVariables(selectedNode);
    const entries = selectedNode.properties.internalVariables;
    const base = "Internal";
    let idx = 1;
    let name = `${base}${idx}`;
    while(entries[name]){ idx += 1; name = `${base}${idx}`; }
    const type = ui.internalType?.value || "string";
    entries[name] = { type, value: null };
    fillExternalCheckVariableDropdown(selectedNode);
    renderInternalVariables(selectedNode);
    autoSave();
});

if (ui.screenOpenPageBtn) {
    ui.screenOpenPageBtn.addEventListener("click", (e) => {
        e.preventDefault();
        if (selectedScreenId === null) return;
        const screen = screens.find((s) => s.id === selectedScreenId);
        openScreenPageInNewTab(screen);
    });
}
graph.onNodeAdded=autoSave; graph.onNodeRemoved=n=>{ rebuildSidebarList(); if(selectedNode&&selectedNode.id===n.id)updatePropertiesPanel(null); autoSave(); }; graph.onNodeConnectionChange=autoSave; canvas.onNodeMoved=autoSave; canvas.onSelectionChange=nodes=>{ if(suppressSelectionChange){ suppressSelectionChange=false; return; } const list=nodes?Object.values(nodes):[]; const branchNode=list.find(n=>n && (n.type==="escape/Start" || n.type==="escape/End")); if(branchNode){ selectBranchPairForNode(branchNode); } else { clearBranchPairSelection(); } updatePropertiesPanel(list[0]||null); };
const origProp=LGraphNode.prototype.onPropertyChanged; LGraphNode.prototype.onPropertyChanged=function(n,v){ if(origProp)origProp.call(this,n,v); autoSave(); };
function checkForDeviceUpdates(){ if(!selectedNode||selectedNode.type!=="escape/Puzzle")return; fetch('/api/devices').then(r=>r.json()).then(devices=>{ const currentJson=JSON.stringify(devices); if(currentJson!==lastKnownDevicesStr){ lastKnownDevicesStr=currentJson; const devSel = selectedNode.properties.isAnalog ? "" : (selectedNode.properties.selectedDeviceID || ""); fillDeviceDropdown(devSel, !!selectedNode.properties.isAnalog); } }).catch(()=>{}); }

function pollData(){ 
    fetch('/api/runtime/status').then(r=>r.json()).then(statusMap=>{ 
        const puzzleNodes = graph.findNodesByType("escape/Puzzle");
        let needsRedraw = false;
        if(puzzleNodes) {
            puzzleNodes.forEach(node => {
                const el = document.getElementById("status-" + node.id);
                let stateKey = "analog";

                if(node.properties.isAnalog) {
                    if(el && el.dataset.state !== "analog") {
                        el.dataset.state = "analog";
                        el.textContent = "ANALOG";
                        el.className = "puzzle-status status-analog";
                    }
                    if(puzzleStatusCache[node.id] !== "analog") {
                        node.borderColor = undefined; 
                        node.boxcolor = "#aaaaaa"; 
                        puzzleStatusCache[node.id] = "analog";
                        needsRedraw = true;
                    }
                    return;
                }

                const data = statusMap[node.id];
                const isOnline = data && data.online;
                stateKey = isOnline ? "online" : "offline";

                if(el && el.dataset.state !== stateKey) {
                    el.dataset.state = stateKey;
                    el.textContent = isOnline ? "online" : "offline";
                    el.className = "puzzle-status " + (isOnline ? "status-online" : "status-offline");
                }
                if(puzzleStatusCache[node.id] !== stateKey) {
                    node.borderColor = undefined; 
                    node.boxcolor = isOnline ? "#88ff88" : "#ff8888"; 
                    puzzleStatusCache[node.id] = stateKey;
                    needsRedraw = true;
                }
            });
        }
        if(needsRedraw) {
            graph.setDirtyCanvas(true, true); 
        }
    }).catch(()=>{}); 
    
    fetch('/api/logs').then(r=>r.json()).then(logs=>{ if(!Array.isArray(logs)) return; editorLogs = logs; renderEditorLogs(); }).catch(()=>{}); 
    checkForDeviceUpdates(); 
}
setInterval(pollData, 1000);

function checkAndRestoreSystemNodes(){ 
    let start = graph.findNodesByType("escape/Start")[0];
    let end = graph.findNodesByType("escape/End")[0];

    if(!start) {
        start = new StartNode();
        start.pos = [50, 200];
        graph.add(start);
    }
    if(!end) {
        end = new EndNode();
        end.pos = [800, 200];
        graph.add(end);
    }

    [start, end].forEach(n => {
        n.removable = false;
        n.clonable = false;
        n.block_delete = true;
        if(!n.flags) n.flags = {};
        n.flags.removable = false;
    });
}

// INIT
window.addEventListener("load", () => {
    console.log("App loaded.");
    loadZigbeeDevices({ silent: true }).catch(() => {});
    startZigbeeBackgroundPolling();
    
    fetch('/api/room')
        .then(r => r.json())
        .then(data => {
            if(data.empty || !data.nodes || Object.keys(data).length === 0) {
                currentRoomName = null;
                screens = [];
                nextScreenId = 1;
                resetLightingState(null);
                roomScriptingConfig = normalizeRoomScriptingConfigData(null);
                if(currentRoomDisplay) currentRoomDisplay.textContent = "No Room Loaded";
                updateStatus("No Room", "#aaa");
                renderScreenList();
                showModal(); 
            } else {
                updateStatus("Ready", "#fff");
                fetch('/api/rooms/list').then(r=>r.json()).then(listData => {
                    currentRoomName = listData.current;
                    if(currentRoomDisplay) currentRoomDisplay.textContent = currentRoomName ? currentRoomName : "Loaded";
                });
                screens = normalizeScreensData(data.config && data.config.screens);
                nextScreenId = screens.reduce((max,s)=>Math.max(max, s.id||0), 0) + 1;
                resetLightingState(data.config && data.config.lighting);
                roomScriptingConfig = normalizeRoomScriptingConfigData(data.config && data.config.roomScripting);
                graph.configure(data); 
                checkAndRestoreSystemNodes(); 
                reindexBranchPairs();
                applyBranchDeleteRules();
                rebuildSidebarList();
                renderScreenList();
            }
            pollData();
        })
        .catch(e => {
            console.error("Error loading room:", e);
            updateStatus("Offline", "#ff0000");
            showModal(); 
        });
});


// Hint modal helpers
function openHintModal(node){
    if(!ui.hintModal) return;
    hintModalNode = node;
        ensureHints(node);
        ensureHintTriggerDefaults(node);
        ui.hintModalTitle.textContent = `Hint System - ${node.properties.Name || node.title || 'Puzzle'}`;
        if(ui.hintManualToggle) ui.hintManualToggle.checked = !!node.properties.automaticHintTrigger;
        if(ui.hintShowAssignmentToggle) ui.hintShowAssignmentToggle.checked = node.properties.showHintAssignment !== false;
        ui.hintModal.style.display = "flex";
        renderHintList();
        updateHintBadge();
    }

function closeHintModal(){
    if(ui.hintModal) ui.hintModal.style.display = "none";
    hintModalNode = null;
}

function renderHintList(){
    if(!hintModalNode || !ui.hintList) return;
    ensureHints(hintModalNode);
    ensureHintTriggerDefaults(hintModalNode);
    const allowTiming = !!hintModalNode.properties.automaticHintTrigger;
    const hints = hintModalNode.properties.hints || [];
    ui.hintList.innerHTML = "";
    hints.forEach((txt, idx)=>{
        const item=document.createElement("div");
        item.className="hint-item";
        item.draggable=true;
        item.dataset.index=idx;

        const textWrap=document.createElement("div");
        textWrap.className="hint-text";
        const textarea=document.createElement("textarea");
        textarea.value=txt.text || "";
        const autoHeight=()=>{ textarea.style.height="auto"; textarea.style.height=`${textarea.scrollHeight}px`; };
        autoHeight();
        textarea.addEventListener("input",()=>{ autoHeight(); hintModalNode.properties.hints[idx].text=textarea.value; autoSave(); updateHintBadge(); });
        textWrap.appendChild(textarea);
        item.appendChild(textWrap);

        const side=document.createElement("div");
        side.className="hint-side";
        const meta=document.createElement("div");
        meta.className="hint-meta";
        const row=document.createElement("div");
        row.className="hint-meta-row";
        const label=document.createElement("span");
        label.className="hint-label";
        label.textContent = idx===0 ? "Time after start (s)" : "Time after last hint (s)";
        const num=document.createElement("input");
        num.type="number";
        num.min="0";
        num.step="1";
        num.value = idx===0 ? (txt.delayFromStart||0) : (txt.delayAfterPrev||0);
        num.disabled = !allowTiming;
        if(!allowTiming) row.classList.add("time-disabled");
        num.addEventListener("change",()=>{
            const v=parseInt(num.value,10);
            if(idx===0){
                hintModalNode.properties.hints[idx].delayFromStart = Number.isFinite(v)?v:0;
            }else{
                hintModalNode.properties.hints[idx].delayAfterPrev = Number.isFinite(v)?v:0;
            }
            autoSave();
        });
        const del=document.createElement("button");
        del.type="button";
        del.className="hint-delete";
        del.textContent="X";
        del.addEventListener("click",(e)=>{
            e.preventDefault();
            hintModalNode.properties.hints.splice(idx,1);
            renderHintList();
            autoSave();
        });
        row.appendChild(label);
        row.appendChild(num);
        row.appendChild(del);
        meta.appendChild(row);
        side.appendChild(meta);
        item.appendChild(side);

        item.addEventListener("dragstart",(e)=>{ item.classList.add("dragging"); e.dataTransfer.setData("text/plain", idx); });
        item.addEventListener("dragend",()=> item.classList.remove("dragging"));
        item.addEventListener("dragover",(e)=>{ e.preventDefault(); });
        item.addEventListener("drop",(e)=>{
            e.preventDefault();
            const from=parseInt(e.dataTransfer.getData("text/plain"),10);
            const to=parseInt(item.dataset.index,10);
            if(!Number.isInteger(from) || !Number.isInteger(to) || from===to) return;
            const arr=hintModalNode.properties.hints;
            const [moved]=arr.splice(from,1);
            arr.splice(to,0,moved);
            renderHintList();
            autoSave();
        });
        ui.hintList.appendChild(item);
    });
    updateHintBadge();
}

