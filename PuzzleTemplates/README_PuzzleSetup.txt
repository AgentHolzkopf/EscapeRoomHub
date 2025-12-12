Setup Guide – MQTT Puzzle Template (Node.js)
============================================

0) Voraussetzungen installieren (frisches System)
- Node.js installieren: https://nodejs.org (LTS reicht).
- In eine CMD Window wechseln und ins Verzeichnis `PuzzleTemplates` gehen.
- MQTT-Client-Bibliothek installieren:
  npm install mqtt

2) Konfiguration erstellen/anpassen
- Datei `PuzzleTemplates/puzzle.config.json` prüfen/erstellen. Beispiel:
{
  "hubHost": "escapehub.local",
  "mqttBroker": "escapehub.local",
  "mqttPort": 1883,
  "deviceId": "puzzle-1",
  "puzzleName": "Radio_Puzzle",
  "heartbeatIntervalMs": 2000,
  "debug": true,
  "printData": false,
  "outputs": {
    "Result": { "type": "string", "data": null }
  }
}
- Wichtig: deviceId muss zum Linked Device im Hub passen.
- outputs können Platzhalter-Keys enthalten (type: string|number|boolean).
  inputs werden beim Room-Start vom Hub per initKeys gesetzt.

3) Puzzle starten
- Im Ordner PuzzleTemplates:
  DEBUG=1 PRINT_DATA=1 node WindowsPuzzleTemplate.js --port 5001
- Terminal sollte „MQTT connected …“ zeigen.

4) Hub einrichten
- Im Editor jedem Puzzle ein Linked Device geben, das zur deviceId passt (z. B. puzzle-1).
- Raum starten:
  - Hub sendet clearData, initKeys (Inputs/Outputs aus IO-Namen) und setState an das Puzzle.
  - Im Puzzle-Terminal erscheinen die MQTT-Commands.

5) Datenfluss testen
- Hub → Puzzle (Input): MQTT topic `puzzle/<deviceId>/command`
  Payload z. B.: {"action":"sendParam","key":"Code","type":"string","data":"ABC123"}
- Puzzle → Hub (Output):
  a) Im Code: STATE.outputs["Result"] = {type:"string", data:"OK"}; publishData("Result"); publishHeartbeat();
  b) Oder MQTT: {"action":"sendOutput","key":"Result","type":"string","data":"OK"}
- requestData vom Hub: {"action":"requestData","key":"Result"} -> Puzzle publisht `puzzle/<deviceId>/data` mit key/type/data.

6) Status/Heartbeat
- Heartbeat alle 2s automatisch, zusätzlich sofort nach jedem Command.
- Status-Commands: setState (locked/running/solved), reset, clearData, initKeys.
- Wenn das Puzzle „solved“ meldet (Heartbeat state solved oder Status-Topic solved), setzt der Hub intern solved und triggert nachfolgende Puzzles auf running.

7) Logs
- DEBUG=1 zeigt Debug-Logs; PRINT_DATA=1 zeigt Input/Output-Daten im Terminal.

8) Zusammenfassung der wichtigen Topics
- Command In:    puzzle/<deviceId>/command   (Hub -> Puzzle)
- Heartbeat Out: puzzle/<deviceId>/heartbeat (Puzzle -> Hub)
- Status Out:    puzzle/<deviceId>/status    (Puzzle -> Hub)
- Data Out:      puzzle/<deviceId>/data      (Puzzle -> Hub)

9) Manuelles Testen (MQTT)
- Beispiel mit mosquitto_pub:
  mosquitto_pub -t puzzle/puzzle-1/command -m '{"action":"sendOutput","key":"Result","type":"string","data":"OK"}'
