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
  "needRestart": false,
  "externalCheck": {
    "active": false,
    "value": ""
  },
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
  - Hub sendet clearData, initKeys (Inputs/Outputs aus IO-Namen) und restart.
  - Puzzle setzt Status auf starting (wenn needRestart=true) oder running (wenn needRestart=false).
  - Im Puzzle-Terminal erscheinen die MQTT-Commands.

5) Datenfluss testen
- Hub → Puzzle (Input): MQTT topic `puzzle/<deviceId>/command`
  Payload z. B.: {"action":"sendParam","key":"Code","type":"string","data":"ABC123"}
- Puzzle → Hub (Output):
  a) Im Code: STATE.outputs["Result"] = {type:"string", data:"OK"}; publishData("Result"); publishHeartbeat();
  b) Oder MQTT: {"action":"sendOutput","key":"Result","type":"string","data":"OK"}
- requestData vom Hub: {"action":"requestData","key":"Result"} -> Puzzle publisht `puzzle/<deviceId>/data` mit key/type/data.

6) Status/Heartbeat
- Heartbeat alle 2s automatisch, zus??tzlich sofort nach jedem Command oder State-Change.
- Status-Commands: setState (locked/starting/running/solved), restart, clearData, initKeys.
- Wenn needRestart=true: Puzzle meldet nach dem Neustart "running" (z. B. per HTTP /restartComplete oder MQTT heartbeat).
- Wenn das Puzzle ??zsolved??o meldet (Heartbeat state solved), setzt der Hub intern solved und triggert nachfolgende Puzzles auf running.

7) Logs
- DEBUG=1 zeigt Debug-Logs; PRINT_DATA=1 zeigt Input/Output-Daten im Terminal.

8) Zusammenfassung der wichtigen Topics
- Command In:    puzzle/<deviceId>/command   (Hub -> Puzzle)
- Heartbeat Out: puzzle/<deviceId>/heartbeat (Puzzle -> Hub)
- Data Out:      puzzle/<deviceId>/data      (Puzzle -> Hub)
- External Check Out: puzzle/<deviceId>/external-check (Puzzle -> Hub)

9) Manuelles Testen (MQTT)
- Beispiel mit mosquitto_pub:
  mosquitto_pub -t puzzle/puzzle-1/command -m '{"action":"sendOutput","key":"Result","type":"string","data":"OK"}'
