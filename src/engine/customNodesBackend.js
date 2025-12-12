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
    this.addInput("Trigger 1", LiteGraph.ACTION);
    this.addInput("Trigger 2", LiteGraph.ACTION);
    this.triggeredInputs = new Set();
}
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
