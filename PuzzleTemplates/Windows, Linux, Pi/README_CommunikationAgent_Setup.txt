CommunikationAgent Setup (Node.js)
==================================

Diese Doku gilt fuer:
`PuzzleTemplates/Windows, Linux, Pi`

------------------------------------------------------------
Architektur: MQTT + HTTP (wichtig)
------------------------------------------------------------

Das Template benutzt intern MQTT fuer die Hub-Kommunikation:
- Sub: `puzzle/<deviceId>/command`
- Pub: `puzzle/<deviceId>/heartbeat`, `.../data`, `.../custom`, `.../external-check`

Du steuerst das Template lokal per HTTP-Aufrufen.
Die HTTP-Calls sind die "API fuer dein Puzzle-Skript".
Der Agent uebersetzt diese Aufrufe in MQTT-Nachrichten zum Hub.

Kurz:
- Hub <-> Agent: MQTT
- Puzzle-Logik <-> Agent: HTTP

------------------------------------------------------------
1) Beispielablauf: Puzzle Loop (empfohlener Start)
------------------------------------------------------------

Ziel dieses Beispielablaufs:
- State vom Agent lesen
- auf `reset` reagieren
- Input lesen und Logik ausfuehren
- Output setzen
- bei Erfolg `solved` setzen

Hinweis:
- Das Template nutzt intern MQTT.
- Deine Puzzle-Logik spricht aber lokal per HTTP mit dem Agent.

Python-Beispiel (nur Grundfunktionen):

```python
import time
import requests

BASE = "http://127.0.0.1:5001"

def get_state():
    return requests.get(f"{BASE}/getState", timeout=3).json()

def set_state(state):
    return requests.post(f"{BASE}/setState", json={"state": state}, timeout=3).json()

def get_input(key):
    return requests.get(f"{BASE}/getParam", params={"type": key}, timeout=3).json()

def set_output(key, value):
    body = {"key": key, "type": "string", "data": str(value)}
    return requests.post(f"{BASE}/setOutput", json=body, timeout=3).json()

def send_custom(key, value):
    body = {"key": key, "type": "string", "data": str(value)}
    return requests.post(f"{BASE}/setOutput", json=body, timeout=3).json()

# Puzzle initial auf running setzen
set_state("running")

while True:
    s = get_state().get("state")

    # Auf Reset reagieren
    if s == "reset":
        # Hier eigene Re-Init (Variablen, Aktoren, Anzeigen etc.)
        continue

    # Beispiel: Puzzle auf solved setzen
    if puzzle_state == "solved":
        set_state("solved")
     
    # Beispiel: auf sate = running reagieren
    if get_state().get("state") == "running"
        set_state("running")
	own_parameters = getInput(key)
	# Hier eigene Puzzle Logik ausführen
   
    # Beispiel: custom variable an Hub senden
    send_custom("custom", "myvariable")
```

------------------------------------------------------------
2) Quickstart
------------------------------------------------------------

Agent starten:

```bash
node CommunikationAgent.js --port 5001
```

Optionales Parallel-Skript fuer Custom -> Board-LED:

```bash
node CustomLedBridge.js
```

Das Skript fragt lokal `GET /getCustom` beim Agent ab und toggelt die LED,
wenn der Custom-Wert exakt `button pressed` ist.

Konfiguration:

```bash
AGENT_URL=http://127.0.0.1:5001 CUSTOM_TRIGGER="button pressed" LED_GPIO=17 node CustomLedBridge.js
```

Hinweise:
- Der Agent startet standardmaessig HTTP, nicht HTTPS.
- `CustomLedBridge.js` kann auch HTTPS nutzen, wenn `AGENT_URL` mit `https://` beginnt.
- Auf einem Raspberry Pi wird `/sys/class/gpio` genutzt.
- Auf Windows oder ohne GPIO wird der LED-Zustand nur im Terminal geloggt.

------------------------------------------------------------
3) Original Quickstart
------------------------------------------------------------

1. In den Ordner wechseln:
   `PuzzleTemplates/Windows, Linux, Pi`
2. Abhaengigkeit installieren:
   `npm install mqtt`
3. `CommunikationAgent.config.json` anpassen (mindestens `deviceId`, `mqttBroker`).
4. Agent starten:
   `node CommunikationAgent.js --port 5001`
5. Im Hub dasselbe `deviceId` als Linked Device eintragen.
6. Room starten.

3) Minimale Konfiguration
------------------------------------------------------------

Beispiel `CommunikationAgent.config.json`:

{
  "hubHost": "escapehub.local",
  "mqttBroker": "escapehub.local",
  "mqttPort": 1883,
  "deviceId": "puzzle-1",
  "puzzleName": "Radio_Puzzle",
  "heartbeatIntervalMs": 2000,
  "needRestart": false
}

Wichtig:
- `deviceId` muss exakt dem Linked Device im Hub entsprechen.
- Inputs/Outputs kommen vom Hub ueber `initKeys`.
- Output-Keys muessen im Hub-I/O definiert sein.

4) HTTP API: Grundfunktionen (mit Beispielaufrufen)
------------------------------------------------------------

Basis:
- `BASE=http://127.0.0.1:5001`

Status:
- GET state:
  `curl "$BASE/getState"`
- POST set state:
  `curl -X POST "$BASE/setState" -H "Content-Type: application/json" -d "{\"state\":\"running\"}"`

Inputs:
- GET input lesen:
  `curl "$BASE/getParam?type=Code"`

Outputs:
- POST output setzen:
  `curl -X POST "$BASE/setOutput" -H "Content-Type: application/json" -d "{\"key\":\"Result\",\"type\":\"string\",\"data\":\"OK\"}"`

------------------------------------------------------------
5) MQTT-Fluss zum Hub
------------------------------------------------------------

Hub -> Agent (eingehend):
- Topic: `puzzle/<deviceId>/command`
- Typische actions:
  - `initKeys`
  - `clearData`
  - `restart`
  - `setState`
  - `sendParam`
  - `requestData`
  - `sendCustom`
  - `sendOutput`

Agent -> Hub (ausgehend):
- `puzzle/<deviceId>/heartbeat`
- `puzzle/<deviceId>/data`
- `puzzle/<deviceId>/custom`
- `puzzle/<deviceId>/external-check`

------------------------------------------------------------
6) Vollstaendige HTTP-Funktionsliste (mit Kurzbeschreibung)
------------------------------------------------------------

Status:
- `GET /getState`  
  Liest den aktuellen Puzzle-State (z. B. `locked`, `running`, `solved`, `reset`).
- `POST /setState`  
  Setzt den Puzzle-State und meldet ihn an den Hub.

Inputs:
- `GET /getParam?type=<Key>`  
  Liest den letzten bekannten Input-Wert eines Keys.
- `POST /sendParam`  
  Setzt lokal einen Input-Wert (hauptsaechlich fuer Tests/Simulation).

Outputs:
- `POST /setOutput`  
  Setzt einen Output-Wert (z. B. Relais, virtuelle Ausgabe) und publisht ihn.
- `GET /getOutput?key=<Key>`  
  Liest den zuletzt gesetzten Output-Wert.

Heartbeat:
- `POST /sendHeartbeat`  
  Erzwingt sofortigen Heartbeat-Upload (nuetzlich fuer sofortige UI-Aktualisierung).

Custom:
- `POST /sendCustom`  
  Sendet benutzerdefinierte Nachricht/Event an den Hub.
- `GET /getCustom`  
  Liest den zuletzt empfangenen/gesetzten Custom-Wert.

External Check:
- `POST /triggerExternalCheck`  
  Meldet externen Input-Check (z. B. User-Eingabe pruefen lassen).
- `GET /getExternalCheck`  
  Liest den letzten External-Check-Zustand.

Restart:
- `POST /restartComplete`  
  Meldet dem Hub, dass ein angeforderter Restart abgeschlossen ist.
- `POST /restartConfig`  
  Setzt zur Laufzeit, ob dieses Puzzle fuer Start/Reset `needRestart` verwendet.

Media:
- `POST /media/upload`  
  Upload einer Datei in den Hub-Mediaspeicher.
- `POST /media/download`  
  Download einer Datei vom Hub.

Debug:
- `GET /getAll`  
  Gibt kompletten internen Agent-Zustand als Snapshot zur Diagnose zurueck.

------------------------------------------------------------
7) Beispielaufrufe aller Funktionen (curl)
------------------------------------------------------------

Basis:
- `BASE=http://127.0.0.1:5001`

Status:
- `curl "$BASE/getState"`
- `curl -X POST "$BASE/setState" -H "Content-Type: application/json" -d "{\"state\":\"running\"}"`

Inputs:
- `curl "$BASE/getParam?type=Code"`
- `curl -X POST "$BASE/sendParam" -H "Content-Type: application/json" -d "{\"key\":\"Code\",\"type\":\"string\",\"data\":\"ABC123\"}"`

Outputs:
- `curl -X POST "$BASE/setOutput" -H "Content-Type: application/json" -d "{\"key\":\"Result\",\"type\":\"string\",\"data\":\"OK\"}"`
- `curl "$BASE/getOutput?key=Result"`

Heartbeat:
- `curl -X POST "$BASE/sendHeartbeat" -H "Content-Type: application/json" -d "{\"state\":\"running\"}"`

Custom:
- `curl -X POST "$BASE/sendCustom" -H "Content-Type: application/json" -d "{\"value\":\"door-opened\"}"`
- `curl "$BASE/getCustom"`

External Check:
- `curl -X POST "$BASE/triggerExternalCheck" -H "Content-Type: application/json" -d "{\"value\":\"1234\",\"active\":true}"`
- `curl "$BASE/getExternalCheck"`

Restart:
- `curl -X POST "$BASE/restartComplete" -H "Content-Type: application/json" -d "{}"`
- `curl -X POST "$BASE/restartConfig" -H "Content-Type: application/json" -d "{\"needRestart\":true}"`

Media:
- `curl -X POST "$BASE/media/upload" -H "Content-Type: application/json" -d "{\"localPath\":\"./MediaStorage/Lampe.png\",\"remoteName\":\"Lampe.png\"}"`
- `curl -X POST "$BASE/media/download" -H "Content-Type: application/json" -d "{\"remoteName\":\"Lampe.png\",\"localPath\":\"./MediaStorage/Lampe_copy.png\"}"`

Debug:
- `curl "$BASE/getAll"`

------------------------------------------------------------
8) Troubleshooting
------------------------------------------------------------

Problem: Hub sieht keine Daten.
- Pruefen, ob `deviceId` in Hub und Config identisch ist.
- Pruefen, ob `mqttBroker`/`mqttPort` korrekt sind.
- Pruefen, ob beim Start "MQTT connected ..." erscheint.

Problem: Output wird ignoriert.
- Output-Key ist nicht im Hub-I/O definiert (`initKeys`).
- Key muss exakt gleich geschrieben sein.

Problem: State-Wechsel kommt nicht im Hub an.
- Nach `setState` ggf. `sendHeartbeat` aufrufen (fuer sofortigen Push).

------------------------------------------------------------
9) Weitere Doku
------------------------------------------------------------

- Kurzfassung fuer Gruppen:
  `README_CommunikationAgent_Groups.txt`
- MCU-Referenz:
  `../Mikrocontroller/README_MCU_REFERENCE.md`
