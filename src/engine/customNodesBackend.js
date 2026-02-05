const { LiteGraph } = require('litegraph.js');

// --- Start Node ---
function StartNode() {
    this.addOutput("Start Flow", LiteGraph.ACTION);
}
StartNode.prototype.onExecute = function() {
    // Wird manuell getriggert
};
LiteGraph.registerNodeType("escape/Start", StartNode);

// --- End Node ---
function EndNode() {
    this.addInput("Finish", LiteGraph.ACTION);
    this.properties = { autoRestart: false, restartDelay: 5 };
}
EndNode.prototype.onAction = function(action) {
    console.log("SERVER: Escape room finished!");
};
LiteGraph.registerNodeType("escape/End", EndNode);

// --- Puzzle Node ---
function PuzzleNode() {
    this.addInput("Trigger", LiteGraph.ACTION);
    this.addOutput("Done", LiteGraph.ACTION);
    // Props inkl. isAnalog und externalCheck
    this.properties = { Name: "Puzzle", IP: "", connectionType: "wlan", isAnalog: false, externalCheck: false };
}
PuzzleNode.prototype.onAction = function(action) {
    if (action === "Trigger") {
        console.log(`SERVER: Puzzle '${this.properties.Name}' activated (trigger).`);
        
        // Mark puzzle as active (for control page)
        if (this.graph && this.graph.onPuzzleActivated) {
            this.graph.onPuzzleActivated(this.id);
        }
        
        // Hier Logik für External Check einfügen
        if (this.properties.externalCheck) {
            // Trigger Slot "External Check"
            // Achtung: Den Slot Index finden wir hier nicht so leicht dynamisch ohne Suche, 
            // aber meistens ist es der letzte oder vorletzte.
            // Für den Moment triggern wir einfach mal Slot 1, falls er da ist.
             const extSlotIndex = this.findOutputSlot("External Check");
             if (extSlotIndex !== -1) {
                 this.triggerSlot(extSlotIndex);
             }
        }
    }
};
PuzzleNode.prototype.setSolved = function() {
    console.log(`SERVER: Puzzle '${this.properties.Name}' solved! Triggering 'Done'.`);
    this.triggerSlot(0); 
};
LiteGraph.registerNodeType("escape/Puzzle", PuzzleNode);

// --- Tablet Node (NEU) ---
function TabletNode() {
    this.addInput("Enable", LiteGraph.EVENT);
    this.addOutput("Success", LiteGraph.ACTION);
    this.addOutput("Fail", LiteGraph.ACTION);
    this.properties = { code: "1234", message: "Msg" };
}
TabletNode.prototype.onAction = function(action) {
    if (action === "Enable") {
        console.log("SERVER: Tablet node enabled. Waiting for code:", this.properties.code);
        // TODO: Logik für Tablet-Kommunikation hier später einbauen
    }
}
LiteGraph.registerNodeType("escape/Tablet", TabletNode);


// --- Logic Node ---
function LogicNode() {
    this.properties = { logicType: "AND" };
    this.addOutput("Done", LiteGraph.ACTION);
    this.addInput("Trigger", LiteGraph.ACTION);
    this.triggeredInputs = new Set();
}
LogicNode.prototype.onConfigure = function() {
    const logicType = (this.properties?.logicType || "AND").toUpperCase();
    const links = this.graph ? this.graph.links : null;
    this.inputs = this.inputs || [];
    const actionInputs = this.inputs.filter(inp => inp && (inp.type === LiteGraph.ACTION || inp.type === LiteGraph.EVENT || inp.type === "action" || inp.type === "event" || inp.type === -1));
    if (!actionInputs.length) {
        this.addInput("Trigger", LiteGraph.ACTION);
    }
    const mainIndex = this.inputs.findIndex(inp => inp && (inp.type === LiteGraph.ACTION || inp.type === LiteGraph.EVENT || inp.type === "action" || inp.type === "event" || inp.type === -1));
    const mainInput = mainIndex >= 0 ? this.inputs[mainIndex] : null;
    const mainLinks = [];
    if (mainInput) {
        if (Array.isArray(mainInput.links)) mainLinks.push(...mainInput.links);
        else if (mainInput.link != null) mainLinks.push(mainInput.link);
        mainInput.name = "Trigger";
        mainInput.type = LiteGraph.ACTION;
        mainInput.nameLocked = true;
        mainInput.multiple = true;
    }
    for (let i = this.inputs.length - 1; i >= 0; i -= 1) {
        const inp = this.inputs[i];
        if (!inp) continue;
        const isAction = (inp.type === LiteGraph.ACTION || inp.type === LiteGraph.EVENT || inp.type === "action" || inp.type === "event" || inp.type === -1);
        if (isAction && i !== mainIndex) {
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
            this.removeInput(i);
        } else if (!isAction && logicType !== "QUEUE") {
            this.removeInput(i);
        }
    }
    if (mainInput) {
        mainInput.links = mainLinks.length ? mainLinks : null;
        mainInput.link = mainLinks.length ? mainLinks[0] : null;
    }
};
LogicNode.prototype.onAction = function(action, param, options, slot_index) {
    console.log(`SERVER: LogicNode input ${slot_index} triggered.`);
    
    if (this.properties.logicType === "OR") {
        this.triggerSlot(0);
    } else {
        // AND Logik
        this.triggeredInputs.add(slot_index);
        let required = this.inputs ? this.inputs.length : 0;
        if (this.triggeredInputs.size >= required) {
            console.log("SERVER: LogicNode AND satisfied -> Done");
            this.triggerSlot(0);
            this.triggeredInputs.clear(); 
        }
    }
};
LiteGraph.registerNodeType("escape/Logic", LogicNode);

module.exports = { StartNode, EndNode, PuzzleNode, LogicNode, TabletNode };
