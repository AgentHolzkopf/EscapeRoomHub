# Puzzle Templates

Diese Vorlagen helfen beim schnellen Anbinden eigener Rätsel an den Hub.

## Welche Vorlage für wen?

- Node.js-Prozess auf Windows/Linux/Pi:
  - Ordner: `PuzzleTemplates/Windows, Linux, Pi`
  - Einstieg: `README_CommunikationAgent_Setup.txt`
- Mikrocontroller (ESP32 / Arduino Mega):
  - Ordner: `PuzzleTemplates/Mikrocontroller`
  - Einstieg: `README_MCU_REFERENCE.md`

## TL;DR (Node.js)

1. In `PuzzleTemplates/Windows, Linux, Pi` wechseln.
2. `npm install mqtt` ausführen.
3. `CommunikationAgent.config.json` anpassen (`deviceId`, `mqttBroker`).
4. Agent starten: `node CommunikationAgent.js --port 5001`.
5. Im Hub dasselbe `deviceId` als Linked Device setzen und Room starten.

## TL;DR (MCU)

1. Sketch (`ESP32_...` oder `MEGA_...`) öffnen.
2. `MQTT_HOST` / `MQTT_SERVER`, `DEVICE_ID`, `PUZZLE_NAME` setzen.
3. Flashen, Gerät mit Netzwerk verbinden.
4. Im Hub dasselbe `deviceId` verknüpfen und Room starten.
5. Prüfen, dass `initKeys` ankommt und Heartbeats gesendet werden.

## Wichtige MQTT-Topics

- Hub -> Puzzle: `puzzle/<deviceId>/command`
- Puzzle -> Hub:
  - `puzzle/<deviceId>/heartbeat`
  - `puzzle/<deviceId>/data`
  - `puzzle/<deviceId>/custom`
  - `puzzle/<deviceId>/external-check`

## Typische Fehler

- Keine Reaktion im Hub:
  - `deviceId` stimmt nicht zwischen Hub und Agent.
  - MQTT-Broker nicht erreichbar.
- Output kommt nicht an:
  - Output-Key wurde nicht per `initKeys` vom Hub angelegt.
- Werte verzögert:
  - Prüfen, ob Heartbeats und `data` tatsächlich publiziert werden.

