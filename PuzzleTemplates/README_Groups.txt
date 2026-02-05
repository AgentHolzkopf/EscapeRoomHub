Kurzanleitung für Gruppen: Funktionen aus dem Template nutzen
============================================================

Ziel: Nur die paar Funktionen kennen, die ihr aus dem Template aufrufen müsst, um Werte zu setzen oder Status zu melden. Keine MQTT-Details nötig.

1) Ausgangslage
- Das Template hält einen internen STATE mit Inputs, Outputs und Status.
- Ihr schreibt eure Logik in das Skript und ruft die bereitgestellten Helfer.

2) Wichtigste Funktionen
- setOutput(key, type, data)
  - Legt/aktualisiert einen Output-Wert im STATE.
  - type: "string" | "number" | "boolean"
  - Beispiel: setOutput("Result", "string", "OK");

- publishData(key)
  - Sendet den zuletzt gesetzten Output für key an den Hub.
  - Beispiel: publishData("Result");
  - Tipp: Nach setOutput aufrufen, wenn ihr ein Ergebnis melden wollt.

- publishAllOutputs()
  - Sendet alle aktuell gesetzten Outputs.
  - Beispiel: publishAllOutputs();

- setInput(key, type, data)
  - Falls ihr lokal testet oder Eingaben simuliert. Im echten Betrieb setzt der Hub Inputs automatisch.
  - Beispiel: setInput("Code", "string", "ABC123");

- STATE.inputs / STATE.outputs lesen
  - Zugriff auf aktuelle Werte.
  - Beispiel: const code = STATE.inputs["Code"]?.data;

- STATE.state setzen und melden
  - STATE.state = "starting" | "running" | "solved" | "locked";
  - publishHeartbeat();   // meldet aktuellen Status

- Restart-Flow (falls euer Puzzle lange initialisiert)
  - Hub sendet action "restart" (setzt SystemCommand im Input).
  - Euer Puzzle startet neu und meldet nach dem Hochfahren "running" (HTTP: /restartComplete oder MQTT heartbeat).

3) Typische Mini-Workflows
- Ergebnis melden:
  setOutput("Result", "string", "OK");
  publishData("Result");

- Mehrere Outputs auf einmal senden:
  // vorher setOutput(...) für alle benötigten Keys
  publishAllOutputs();

- Statuswechsel (z. B. wenn fertig):
  STATE.state = "solved";
  publishHeartbeat();

4) Orientierung im Template
- Die Funktionen stehen in WindowsPuzzleTemplate.js im oberen Bereich (State- und Helper-Funktionen).
- Ihr könnt sie direkt in eurer Logik aufrufen; weitere Infrastruktur anpassen ist nicht nötig.

Das war’s: setOutput + publishData (oder publishAllOutputs) für Ergebnisse, STATE.state + publishHeartbeat für Status. Mehr braucht ihr nicht.
