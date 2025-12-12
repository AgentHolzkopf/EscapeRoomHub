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
    return arr.map((s,idx)=>{
        const id = typeof s.id === "number" ? s.id : parseInt(s.id || (idx+1),10) || (idx+1);
        return {
            id,
            name: s.name || `Screen ${(idx+1)}`,
            role: s.role === "hint" ? "hint" : "player",
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
                delBtn.innerHTML = "🗑️";
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
    this.removable = false; 
    this.clonable = false; 
    this.block_delete = true; 
}
StartNode.title = "Start"; 
StartNode.prototype.onConfigure = function() { 
    this.removable = false; 
    this.clonable = false; 
    this.block_delete = true; 
}; 
LiteGraph.registerNodeType("escape/Start", StartNode);

function EndNode() { 
    this.addInput("Finish", LiteGraph.ACTION); 
    this.title = "End"; 
    this.color = "#7f3030"; 
    this.bgcolor = "#a44141"; 
    this.properties = {autoRestart:false, restartDelay:5}; 
    this.removable = false; 
    this.clonable = false; 
    this.block_delete = true; 
}
EndNode.title = "End"; 
EndNode.prototype.onConfigure = function() { 
    this.removable = false; 
    this.clonable = false; 
    this.block_delete = true; 
}; 
LiteGraph.registerNodeType("escape/End", EndNode);

// --- PUZZLE NODE ---
function PuzzleNode() { 
    this.addInput("Trigger", LiteGraph.ACTION); 
    this.addOutput("Done", LiteGraph.ACTION); 
    this.properties={Name:"New Puzzle", selectedDeviceID:"", isStartNode:false, isAnalog: false, externalCheck: false, externalScreenId:"", hintEnabled:false, hintScreenId:"", hints: [], manualHintTrigger:false, automaticHintTrigger:true, showHintAssignment:true}; 
    this.title="Puzzle"; 
}
PuzzleNode.title="Puzzle"; 

// Manage optional external slot cleanup (keine neuen Outputs mehr anlegen)
PuzzleNode.prototype.updateSlots = function() {
    const slotName = "External Check";
    const slotIndex = this.findOutputSlot(slotName);

    if (!this.properties.externalCheck && slotIndex !== -1) {
        this.removeOutput(slotIndex);
    }
};

PuzzleNode.prototype.onConfigure = function() {
    this.updateSlots(); // Slots wiederherstellen beim Laden
};

// Custom Draw für Rahmen
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


function LogicNode() { this.properties={logicType:"AND"}; this.addOutput("Done",LiteGraph.ACTION); this.addInput("Input 1",LiteGraph.ACTION,{nameLocked:true}); this.addInput("Input 2",LiteGraph.ACTION,{nameLocked:true}); this.title="AND"; this.color="#4E342E"; this.bgcolor="#6D4C41"; }
LogicNode.title="Logic"; LogicNode.prototype.onPropertyChanged = function(n,v){ if(n==="logicType"){this.properties.logicType=v; this.title=v;} }; LiteGraph.registerNodeType("escape/Logic", LogicNode);


// --- UI LOGIK ---

const puzzleList=document.getElementById("puzzle-list"), screenList=document.getElementById("screen-list"), propertiesSidebar=document.getElementById("properties-sidebar"), ioControlsContainer=document.getElementById('properties-form'), logWindow=document.getElementById("log-window"), logContent=document.getElementById("log-content");
document.getElementById("toggle-log-btn").addEventListener("click", e=>{ if(logWindow.classList.contains("minimized")){ logWindow.classList.remove("minimized");logWindow.classList.add("expanded");e.target.textContent="▼";}else{logWindow.classList.add("minimized");logWindow.classList.remove("expanded");e.target.textContent="▲";} });
function updateSidebarHighlight(node){ document.querySelectorAll(".puzzle-item:not(.screen-item)").forEach(el=>el.classList.remove("selected")); if(node&&node.type==="escape/Puzzle"){ const item=document.querySelector(`.puzzle-item[data-node-id="${node.id}"]`); if(item){item.classList.add("selected");item.scrollIntoView({behavior:"smooth",block:"nearest"});} updateScreenHighlight(null); } }
function updateScreenHighlight(screenId){ document.querySelectorAll(".screen-item").forEach(el=>el.classList.remove("selected")); if(screenId!==null&&screenId!==undefined){ const item=document.querySelector(`.screen-item[data-screen-id="${screenId}"]`); if(item){item.classList.add("selected"); item.scrollIntoView({behavior:"smooth",block:"nearest"});} } }
function createSidebarListItem(node,text){ const newItem=document.createElement("li"); newItem.className="puzzle-item"; newItem.dataset.nodeId=node.id; newItem.innerHTML=`<span class="puzzle-item-text">${text}</span><span class="puzzle-status status-offline" id="status-${node.id}">offline</span>`; newItem.addEventListener("click",e=>{ e.preventDefault(); if(document.activeElement)document.activeElement.blur(); const nodeInGraph=graph.getNodeById(newItem.dataset.nodeId); if(nodeInGraph){ canvas.deselectAllNodes(); canvas.selectNode(nodeInGraph,false); canvas.centerOnNode(nodeInGraph); canvas.canvas.focus(); updateSidebarHighlight(nodeInGraph); updatePropertiesPanel(nodeInGraph); } }); puzzleList.appendChild(newItem); }
function createScreenListItem(screen){ const newItem=document.createElement("li"); newItem.className="puzzle-item screen-item"; newItem.dataset.screenId=screen.id; newItem.innerHTML=`<span class="puzzle-item-text">${screen.name}</span>`; newItem.addEventListener("click",e=>{ e.preventDefault(); if(document.activeElement)document.activeElement.blur(); selectScreen(screen.id); }); newItem.addEventListener("keydown",e=>{ if(e.key==='Delete'){ deleteScreen(screen.id); } }); newItem.tabIndex=0; screenList.appendChild(newItem); }
function getCenterPosition(){ const rect=canvas.canvas.getBoundingClientRect(); const centerX=rect.width/2; const centerY=rect.height/2; const ds=canvas.ds; const x=(centerX/ds.scale)-ds.offset[0]; const y=(centerY/ds.scale)-ds.offset[1]; const jitter=()=>(Math.random()*40-20); return[x+jitter(),y+jitter()]; }

document.getElementById("add-puzzle-btn").addEventListener("click",()=>{ const node=LiteGraph.createNode("escape/Puzzle"); node.properties.Name="Puzzle "+(graph.findNodesByType("escape/Puzzle").length+1); node.title=node.properties.Name; node.pos=getCenterPosition(); graph.add(node); createSidebarListItem(node,node.title); canvas.deselectAllNodes(); canvas.selectNode(node); canvas.canvas.focus(); updateSidebarHighlight(node); autoSave(); });
document.getElementById("add-screen-btn").addEventListener("click",()=>{ const screenName="Screen "+(screens.length+1); const newId = nextScreenId++; const rawPath = screenName.replace(/\\s+/g,'-'); const newScreen={id:newId,name:screenName,role:"player",path:ensureUniqueScreenPath(rawPath, newId)}; screens.push(newScreen); renderScreenList(); selectScreen(newScreen.id); refreshExternalSelectionForSelectedPuzzle(); refreshHintSelectionForSelectedPuzzle(); autoSave(); });
document.getElementById("add-logic-btn").addEventListener("click",()=>{ const node=LiteGraph.createNode("escape/Logic"); node.pos=getCenterPosition(); graph.add(node); canvas.deselectAllNodes(); canvas.selectNode(node); canvas.canvas.focus(); autoSave(); });

function rebuildSidebarList(){ puzzleList.innerHTML=""; const puzzleNodes=graph.findNodesByType("escape/Puzzle"); if(puzzleNodes)puzzleNodes.forEach(node=>createSidebarListItem(node,node.title)); const selected=Object.values(canvas.selected_nodes||{})[0]; updateSidebarHighlight(selected); }
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
    }
});

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
    
    tabletCode:document.getElementById("prop-tablet-code"), // NEU
    tabletMsg:document.getElementById("prop-tablet-msg"), // NEU
    screenRole:document.getElementById("prop-screen-role"),
    screenPath:document.getElementById("prop-screen-path"),

    logicType:document.getElementById("prop-logic-type"), 
    autoRestart:document.getElementById("prop-auto-restart"), 
    restartDelay:document.getElementById("prop-restart-delay"), 
    inputs:document.getElementById("inputs-list"), 
    outputs:document.getElementById("outputs-list"), 
    addInBtn:document.getElementById("add-input-btn"), 
    addOutBtn:document.getElementById("add-output-btn"), 
    inType:document.getElementById("add-input-type"), 
    outType:document.getElementById("add-output-type") 
};

ui.dropdownTrigger.addEventListener("click",e=>{ if(ui.dropdown.classList.contains("dropdown-disabled")) return; ui.dropdownMenu.classList.toggle("open"); e.stopPropagation(); });
document.addEventListener("click",e=>{ if(!ui.dropdown.contains(e.target))ui.dropdownMenu.classList.remove("open"); });

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
            return { text: h, delayFromStart: 0, delayAfterPrev: 0 };
        }
        return {
            text: h.text || "",
            delayFromStart: Number.isFinite(h.delayFromStart) ? h.delayFromStart : 0,
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

function ensureLogicInputs(node){
    if(!node || node.type!=="escape/Logic") return;
    node.inputs = node.inputs || [];
    // ensure at least two action inputs
    while(node.inputs.length < 2){
        node.addInput(`Input ${node.inputs.length+1}`, LiteGraph.ACTION);
    }
    node.inputs.forEach((inp, idx)=>{
        if(!inp) return;
        inp.type = LiteGraph.ACTION;
        if(!inp.name || inp.name.startsWith("Input ")){
            inp.name = `Input ${idx+1}`;
        }
    });
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
if(ui.hintModal){
    ui.hintModal.addEventListener("click", (e)=>{ if(e.target===ui.hintModal) closeHintModal(); });
}
if(ui.hintAddBtn){
    ui.hintAddBtn.addEventListener("click", ()=>{
        if(!hintModalNode) return;
        ensureHints(hintModalNode);
        hintModalNode.properties.hints.push({ text:"", delayFromStart:0, delayAfterPrev:0 });
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

function updatePropertiesPanel(node){ 
    selectedScreenId=null;
    updateScreenHighlight(null);
    updateSidebarHighlight(node); 
    if(!node){hidePropertiesPanel();return;} 
    selectedNode=node; 
    propertiesSidebar.style.display="block"; 
    logWindow.classList.add("sidebar-open"); 
    const sections=ioControlsContainer.querySelectorAll('.form-item, .io-section, hr, .category, .toggle-row'); 
    sections.forEach(el=>el.style.display='none'); 
    
    // PUZZLE
    if(node.type==="escape/Puzzle"){ 
        sections.forEach(el=>{if(el.classList.contains('puzzle-prop')||el.classList.contains('io-section'))el.style.display='';}); 
        
        ui.name.value=node.properties.Name||""; 
        ui.isStart.checked=node.properties.isStartNode||false;
        ui.isAnalog.checked=node.properties.isAnalog||false;
        ensureHints(node);
        ensureHintTriggerDefaults(node);
        updateHintBadge();
        
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
        renderIOLists(node); 
        if(ui.hintManualToggle) ui.hintManualToggle.checked = !!node.properties.automaticHintTrigger;
    } 
    // TABLET
    else if(node.type==="escape/Tablet") {
        sections.forEach(el=>{if(el.classList.contains('tablet-prop'))el.style.display='';}); 
        ui.name.value = node.title || "Tablet Input"; // Nutzung des Name-Felds für den Titel
        ui.tabletCode.value = node.properties.code || "";
        ui.tabletMsg.value = node.properties.message || "";
        updateHintBadge();
    }
    // LOGIC
    else if(node.type==="escape/Logic"){ 
        sections.forEach(el=>{if(el.classList.contains('logic-prop')||el.classList.contains('input-section'))el.style.display='';}); 
        ensureLogicInputs(node);
        ui.logicType.value=node.properties.logicType||"AND"; 
        ui.inType.style.display="none"; 
        renderIOLists(node,true); 
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
    updateSidebarHighlight(null);
    updateScreenHighlight(screen.id);
    propertiesSidebar.style.display = "block";
    logWindow.classList.add("sidebar-open");
    const sections=ioControlsContainer.querySelectorAll('.form-item, .io-section, hr, .category, .toggle-row');
    sections.forEach(el=>el.style.display='none');
    sections.forEach(el=>{ if(el.classList.contains('screen-prop')) el.style.display=''; });
    ui.name.value = screen.name || "";
    if(ui.screenRole) ui.screenRole.value = screen.role === "hint" ? "hint" : "player";
    if(ui.screenPath) ui.screenPath.value = screen.path || "";
    updateHintBadge();
}

function hidePropertiesPanel(){ propertiesSidebar.style.display="none"; selectedNode=null; selectedScreenId=null; updateSidebarHighlight(null); updateScreenHighlight(null); logWindow.classList.remove("sidebar-open"); }
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

function renderIOLists(node,inputsOnly=false){ const renderList=(elem,items,type)=>{ elem.innerHTML=""; if(!items)return; items.forEach((item,idx)=>{ if(item.name==="Done")return; if(type==='in'&&node.type==="escape/Puzzle"&&item.name==="Trigger")return; const div=document.createElement("div"); div.className="io-item"; div.dataset.type=item.type; let html=`<input type="text" class="io-name-input" value="${item.name}" ${item.nameLocked?'disabled':''}>`; const isLogicNode=(node.type==="escape/Logic"); const isInput=(type==='in'); let showRemove=true; if(isInput){ if(isLogicNode){ showRemove=(items.length>2); } else if(node.type==="escape/Puzzle"){ showRemove=(items.length>1); } } if(showRemove)html+=`<button type="button" class="io-remove">X</button>`; div.innerHTML=html; const input=div.querySelector("input"); input.addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();input.blur();}}); input.addEventListener("change",e=>{ if(type=='in')node.inputs[idx].name=e.target.value; else node.outputs[idx].name=e.target.value; node.setDirtyCanvas(true,true); autoSave(); }); if(showRemove){ div.querySelector(".io-remove").addEventListener("click",e=>{ e.preventDefault(); if(isLogicNode&&isInput&&node.inputs.length<=2)return; if(type=='in')node.removeInput(idx); else node.removeOutput(idx); updatePropertiesPanel(node); autoSave(); }); } elem.appendChild(div); }); }; renderList(ui.inputs,node.inputs,'in'); if(!inputsOnly)renderList(ui.outputs,node.outputs,'out'); }


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
                screen.role = t.value === "hint" ? "hint" : "player";
                renderScreenList();
                refreshExternalSelectionForSelectedPuzzle();
                refreshHintSelectionForSelectedPuzzle();
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
            if(item)item.textContent=t.value; 
        } else if (selectedNode.type==="escape/Tablet") {
            selectedNode.title = t.value;
        }
    } else if(t===ui.isStart) {
        selectedNode.properties.isStartNode=t.checked;
    } else if(t===ui.isAnalog) { 
        selectedNode.properties.isAnalog=t.checked;
        if(t.checked){
            selectedNode.properties.selectedDeviceID="";
            if(ui.dropdown){
                ui.dropdown.classList.add("dropdown-disabled");
                ui.dropdownTrigger.innerHTML = `<span>Analog - Select Device -</span><span class="dropdown-arrow">>></span>`;
            }
        } else {
            if(ui.dropdown) ui.dropdown.classList.remove("dropdown-disabled");
        }
        const devId = selectedNode.properties.isAnalog ? "" : (selectedNode.properties.selectedDeviceID || "");
        fillDeviceDropdown(devId, t.checked);
    } else if(t===ui.extScreen){
        selectedNode.properties.externalScreenId = t.value || "";
        selectedNode.properties.externalCheck = !!selectedNode.properties.externalScreenId;
        refreshExternalSelectionForSelectedPuzzle();
        if(selectedNode.updateSlots) selectedNode.updateSlots();
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
    } else if(t===ui.autoRestart) {
        selectedNode.properties.autoRestart=t.checked; 
    } else if(t===ui.restartDelay) {
        selectedNode.properties.restartDelay=parseInt(t.value); 
    }
    selectedNode.setDirtyCanvas(true,true); 
    autoSave(); 
});


const allInputs=ioControlsContainer.querySelectorAll('input'); allInputs.forEach(inp=>{inp.addEventListener('keydown',e=>{if(e.key==="Enter"){e.preventDefault();inp.blur();}});});
ui.addInBtn.addEventListener("click",e=>{ e.preventDefault(); if(!selectedNode)return; let type; if(selectedNode.type==="escape/Logic"){ type=LiteGraph.ACTION; }else{ type=ui.inType.value==='action'?LiteGraph.ACTION:ui.inType.value; } selectedNode.addInput("Input "+(selectedNode.inputs.length+1),type); updatePropertiesPanel(selectedNode); autoSave(); });
ui.addOutBtn.addEventListener("click",e=>{ e.preventDefault(); if(!selectedNode)return; selectedNode.addOutput("Output "+(selectedNode.outputs.length+1),ui.outType.value==='action'?LiteGraph.EVENT:ui.outType.value); updatePropertiesPanel(selectedNode); autoSave(); });
graph.onNodeAdded=autoSave; graph.onNodeRemoved=n=>{ rebuildSidebarList(); if(selectedNode&&selectedNode.id===n.id)updatePropertiesPanel(null); autoSave(); }; graph.onNodeConnectionChange=autoSave; canvas.onNodeMoved=autoSave; canvas.onSelectionChange=nodes=>{ if(suppressSelectionChange){ suppressSelectionChange=false; return; } updatePropertiesPanel(nodes?Object.values(nodes)[0]:null); };
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
    
    fetch('/api/logs').then(r=>r.json()).then(logs=>{ const logContent=document.getElementById("log-content"); if(!logContent)return; if(logs.length===0){ logContent.innerHTML="<div style='color:#555; padding:5px; font-style:italic;'>Keine Logs vorhanden (System wartet...)</div>"; return; } logContent.innerHTML=""; logs.forEach(log=>{ const div=document.createElement("div"); div.className=`log-entry log-${log.type}`; div.textContent=`[${log.timestamp}] ${log.msg}`; logContent.appendChild(div); }); }).catch(e=>{}); 
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
