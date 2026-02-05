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

function updateStatus(msg, color = "#fff") {
    if (statusDiv) { 
        statusDiv.textContent = msg; 
        statusDiv.style.color = color;
        statusDiv.style.borderColor = color;
    }
}

function saveGraphToBackend() {
    if(!currentRoomName) return; 
    graph.config = Object.assign({}, graph.config, { screens });
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
function PuzzleNode() { 
    this.addInput("Trigger", LiteGraph.ACTION); 
    this.addOutput("Done", LiteGraph.ACTION); 
    this.properties={Name:"New Puzzle", selectedDeviceID:"", isStartNode:false, isAnalog: false, externalCheck: false, externalScreenId:"", externalCheckVariable:"", externalShowAssignment:true, hintEnabled:false, hintScreenId:"", hints: [], manualHintTrigger:false, automaticHintTrigger:true, showHintAssignment:true}; 
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
    if(this.properties?.isAnalog){
        removeNonActionInputsForAnalog(this);
    }
    if (this.size && this.size.length) {
        this.size[0] = LiteGraph.NODE_WIDTH;
    }
};

// Custom Draw fÃƒÂ¼r Rahmen
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
toggleLogBtn?.addEventListener("click", e=>{ if(logWindow.classList.contains("minimized")){ logWindow.classList.remove("minimized");logWindow.classList.add("expanded");e.target.textContent="\u25BC";}else{logWindow.classList.add("minimized");logWindow.classList.remove("expanded");e.target.textContent="\u25B2";} });
if (toggleLogBtn) toggleLogBtn.textContent = logWindow?.classList.contains("minimized") ? "\u25B2" : "\u25BC";
let editorLogs = [];
const logFiltersState = { heartbeat: true, mqtt: true, error: true, system: true };

function categorizeLog(entry) {
    const msg = (entry?.msg || '').toLowerCase();
    const type = (entry?.type || '').toLowerCase();
    if (msg.includes('heartbeat')) return 'heartbeat';
    if (msg.includes('mqtt')) return 'mqtt';
    if (type === 'error' || msg.includes('error')) return 'error';
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
function updateSidebarHighlight(node){ document.querySelectorAll(".puzzle-item:not(.screen-item)").forEach(el=>el.classList.remove("selected")); if(node&&node.type==="escape/Puzzle"){ const item=document.querySelector(`.puzzle-item[data-node-id="${node.id}"]`); if(item){item.classList.add("selected");item.scrollIntoView({behavior:"smooth",block:"nearest"});} updateScreenHighlight(null); } }
function updateScreenHighlight(screenId){ document.querySelectorAll(".screen-item").forEach(el=>el.classList.remove("selected")); if(screenId!==null&&screenId!==undefined){ const item=document.querySelector(`.screen-item[data-screen-id="${screenId}"]`); if(item){item.classList.add("selected"); item.scrollIntoView({behavior:"smooth",block:"nearest"});} } }
function createSidebarListItem(node,text){
    const newItem=document.createElement("li");
    newItem.className="puzzle-item";
    newItem.dataset.nodeId=node.id;
    const displayName = getPuzzleDisplayName(node, text);
    newItem.innerHTML=`<span class="puzzle-item-text">${displayName}</span><span class="puzzle-status status-offline" id="status-${node.id}">offline</span>`;
    newItem.addEventListener("click",e=>{ e.preventDefault(); if(document.activeElement)document.activeElement.blur(); const nodeInGraph=graph.getNodeById(newItem.dataset.nodeId); if(nodeInGraph){ canvas.deselectAllNodes(); canvas.selectNode(nodeInGraph,false); canvas.centerOnNode(nodeInGraph); canvas.canvas.focus(); updateSidebarHighlight(nodeInGraph); updatePropertiesPanel(nodeInGraph); } });
    puzzleList.appendChild(newItem);
}
function createScreenListItem(screen){ const newItem=document.createElement("li"); newItem.className="puzzle-item screen-item"; newItem.dataset.screenId=screen.id; newItem.innerHTML=`<span class="puzzle-item-text">${screen.name}</span>`; newItem.addEventListener("click",e=>{ e.preventDefault(); if(document.activeElement)document.activeElement.blur(); selectScreen(screen.id); }); newItem.addEventListener("keydown",e=>{ if(e.key==='Delete'){ deleteScreen(screen.id); } }); newItem.tabIndex=0; screenList.appendChild(newItem); }
function getCenterPosition(){ const rect=canvas.canvas.getBoundingClientRect(); const centerX=rect.width/2; const centerY=rect.height/2; const ds=canvas.ds; const x=(centerX/ds.scale)-ds.offset[0]; const y=(centerY/ds.scale)-ds.offset[1]; const jitter=()=>(Math.random()*40-20); return[x+jitter(),y+jitter()]; }
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
    if(selectedScreenId !== null){
        deleteScreen(selectedScreenId);
        return;
    }
    const selected = Object.values(canvas.selected_nodes || {});
    const branchNode = selected.find(n => n && (n.type === "escape/Start" || n.type === "escape/End"));
    if (branchNode) {
        const pairId = Number(branchNode?.properties?.pairId);
        if (pairId > 0) {
            deleteBranchPair(pairId);
            e.preventDefault();
            e.stopPropagation();
        }
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
    if (activeBranchPairId > 0) {
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
    internalType:document.getElementById("add-internal-type")
};

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
            return { ok: false, error: "Ungültige Zahl." };
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
            if(ui.fallbackInputError) ui.fallbackInputError.textContent = parsed.error || "Ungültiger Wert.";
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
    if(!node){hidePropertiesPanel();return;} 
    if(node.type !== "escape/Start" && node.type !== "escape/End"){
        clearBranchPairSelection();
    }
    selectedNode=node; 
    propertiesSidebar.style.display="block"; 
    logWindow.classList.add("sidebar-open"); 
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
        updateHintBadge();
        updateSlotLabels(node);
        renderInternalVariables(node);
        
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
        ui.name.value = node.title || "Tablet Input"; // Nutzung des Name-Felds fÃƒÂ¼r den Titel
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
    const sections=ioControlsContainer.querySelectorAll('.form-item, .io-section, hr, .category, .toggle-row');
    sections.forEach(el=>el.style.display='none');
    sections.forEach(el=>{ if(el.classList.contains('screen-prop')) el.style.display=''; });
    ui.name.value = screen.name || "";
    applyScreenRoleUI(screen);
    if(ui.screenPath) ui.screenPath.value = screen.path || "";
    updateHintBadge();
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

function hidePropertiesPanel(){ propertiesSidebar.style.display="none"; selectedNode=null; selectedScreenId=null; updateSidebarHighlight(null); updateScreenHighlight(null); logWindow.classList.remove("sidebar-open"); closeFallbackModal(); }
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
                const item=document.querySelector(`.puzzle-item[data-node-id="${selectedNode.id}"] .puzzle-item-text`); 
                if(item)item.textContent=getPuzzleDisplayName(selectedNode, t.value); 
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
    
    fetch('/api/room')
        .then(r => r.json())
        .then(data => {
            if(data.empty || !data.nodes || Object.keys(data).length === 0) {
                currentRoomName = null;
                screens = [];
                nextScreenId = 1;
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
