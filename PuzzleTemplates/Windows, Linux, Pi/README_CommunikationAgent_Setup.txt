Communication Agent Setup (Node.js)
===================================

This document applies to:
`PuzzleTemplates/Windows, Linux, Pi`

------------------------------------------------------------
Architecture: MQTT + HTTP
------------------------------------------------------------

The template uses MQTT internally for communication with the hub:
- Sub: `puzzle/<deviceId>/command`
- Pub: `puzzle/<deviceId>/heartbeat`, `.../data`, `.../custom`, `.../external-check`

Your puzzle logic controls the template locally through HTTP calls.
These HTTP calls are the API for your own puzzle script.
The agent translates them into MQTT messages for the hub.

Short version:
- Hub <-> Agent: MQTT
- Puzzle logic <-> Agent: HTTP

------------------------------------------------------------
1) Example Workflow: Puzzle Loop
------------------------------------------------------------

Goal of this workflow:
- Read state from the agent
- React to `reset`
- Read inputs and execute puzzle logic
- Set outputs
- Set state to `solved` when the puzzle is solved

Note:
- The template uses MQTT internally.
- Your puzzle logic talks to the agent locally via HTTP.

Python example with core functions:

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

def send_custom(value):
    body = {"value": str(value)}
    return requests.post(f"{BASE}/sendCustom", json=body, timeout=3).json()

set_state("running")

while True:
    state = get_state().get("state")

    if state == "reset":
        # Re-initialize your own variables, actuators, displays, etc.
        continue

    if state == "running":
        own_parameters = get_input("Code")
        # Execute your own puzzle logic here.

    if puzzle_state == "solved":
        set_state("solved")

    send_custom("myvariable")
    time.sleep(0.1)
```

------------------------------------------------------------
2) Quickstart
------------------------------------------------------------

Windows installer:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-agent.ps1
```

If Node.js is not installed, the installer can install Node.js LTS through `winget`:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-agent.ps1 -InstallNode
```

After Node.js was installed, close PowerShell, open a new PowerShell window, and run the installer again. This is required because Windows updates `PATH` only for new terminal sessions.

Non-interactive example:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-agent.ps1 -HubHost 192.168.101.96 -PuzzleName TestPuzzle
```

Install and start immediately:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-agent.ps1 -HubHost 192.168.101.96 -PuzzleName TestPuzzle -Start
```

Start the agent:

```bash
node CommunikationAgent.js --port 5001
```

Optional companion script for Custom -> board LED:

```bash
node CustomLedBridge.js
```

The script polls `GET /getCustom` from the agent and toggles the LED when the custom value is exactly `button pressed`.

Configuration:

```bash
AGENT_URL=http://127.0.0.1:5001 CUSTOM_TRIGGER="button pressed" LED_GPIO=17 node CustomLedBridge.js
```

Notes:
- The agent starts HTTP by default, not HTTPS.
- `CustomLedBridge.js` can use HTTPS if `AGENT_URL` starts with `https://`.
- On a Raspberry Pi it uses `/sys/class/gpio`.
- On Windows or without GPIO access, the LED state is only logged to the terminal.

------------------------------------------------------------
3) Basic Setup
------------------------------------------------------------

Recommended on Windows:

1. Open PowerShell in this folder:
   `PuzzleTemplates/Windows, Linux, Pi`
2. Run:
   `powershell -ExecutionPolicy Bypass -File .\install-agent.ps1`
   If Node.js is missing, either confirm the winget install prompt or run:
   `powershell -ExecutionPolicy Bypass -File .\install-agent.ps1 -InstallNode`
   Then reopen PowerShell and run the installer again.
3. Enter the hub IP/hostname and puzzle name.
   The installer requires a real hub IP/hostname. It will not silently keep the template placeholder.
4. Start the agent:
   `node CommunikationAgent.js --port 5001`
5. Select the detected agent as Linked Device in the hub.
6. Start the room.

Manual setup:

1. Change into the folder:
   `PuzzleTemplates/Windows, Linux, Pi`
2. Install dependency:
   `npm install mqtt`
3. Edit `CommunikationAgent.config.json` (at least `mqttBroker` and `puzzleName`).
4. Start the agent:
   `node CommunikationAgent.js --port 5001`
5. Select the detected agent as Linked Device in the hub.
6. Start the room.

------------------------------------------------------------
4) Minimal Configuration
------------------------------------------------------------

Example `CommunikationAgent.config.json`:

```json
{
  "hubHost": "192.168.101.96",
  "mqttBroker": "192.168.101.96",
  "mqttPort": 1883,
  "puzzleName": "Radio_Puzzle",
  "heartbeatIntervalMs": 2000,
  "needRestart": false
}
```

Important:
- The installer generates a stable local agent ID in `.agent-device-id` if none exists yet.
- `CommunikationAgent.config.json` does not need a `deviceId` entry.
- Without the installer or `.agent-device-id`, the agent falls back to the local IP address as device ID.
- Select the detected agent as Linked Device in the hub.
- Inputs and outputs are initialized by the hub through `initKeys`.
- Output keys must be defined in the hub I/O configuration.

------------------------------------------------------------
5) HTTP API: Core Functions
------------------------------------------------------------

Base URL:
- `BASE=http://127.0.0.1:5001`

State:
- GET state:
  `curl "$BASE/getState"`
- POST set state:
  `curl -X POST "$BASE/setState" -H "Content-Type: application/json" -d "{\"state\":\"running\"}"`

Inputs:
- GET input:
  `curl "$BASE/getParam?type=Code"`

Outputs:
- POST output:
  `curl -X POST "$BASE/setOutput" -H "Content-Type: application/json" -d "{\"key\":\"Result\",\"type\":\"string\",\"data\":\"OK\"}"`

------------------------------------------------------------
6) MQTT Flow to the Hub
------------------------------------------------------------

Hub -> Agent:
- Topic: `puzzle/<deviceId>/command`
- Common actions:
  - `initKeys`
  - `clearData`
  - `restart`
  - `setState`
  - `sendParam`
  - `requestData`
  - `sendCustom`
  - `sendOutput`

Agent -> Hub:
- `puzzle/<deviceId>/heartbeat`
- `puzzle/<deviceId>/data`
- `puzzle/<deviceId>/custom`
- `puzzle/<deviceId>/external-check`

------------------------------------------------------------
7) Full HTTP Function List
------------------------------------------------------------

State:
- `GET /getState`
  Reads the current puzzle state, for example `locked`, `running`, `solved`, `reset`.
- `POST /setState`
  Sets the puzzle state and publishes it to the hub.

Inputs:
- `GET /getParam?type=<Key>`
  Reads the last known input value for a key.
- `POST /sendParam`
  Sets a local input value, mainly for tests and simulations.

Outputs:
- `POST /setOutput`
  Sets an output value, for example a relay or virtual output, and publishes it.
- `GET /getOutput?key=<Key>`
  Reads the last set output value.

Heartbeat:
- `POST /sendHeartbeat`
  Forces an immediate heartbeat publish. Useful for immediate UI updates.

Custom:
- `POST /sendCustom`
  Sends a custom message/event to the hub.
- `GET /getCustom`
  Reads the latest received or locally set custom value.

External Check:
- `POST /triggerExternalCheck`
  Reports an external input check, for example a user input that should be verified by the hub.
- `GET /getExternalCheck`
  Reads the last external check state.

Restart:
- `POST /restartComplete`
  Tells the hub that a requested restart has completed.
- `POST /restartConfig`
  Sets at runtime whether this puzzle uses `needRestart` for start/reset handling.

Media:
- `POST /media/upload`
  Uploads a file to hub media storage.
- `POST /media/download`
  Downloads a file from the hub.

Debug:
- `GET /getAll`
  Returns the complete internal agent state snapshot for diagnostics.

------------------------------------------------------------
8) Example Calls for All Functions (curl)
------------------------------------------------------------

Base:
- `BASE=http://127.0.0.1:5001`

State:
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
9) Troubleshooting
------------------------------------------------------------

Problem: The hub sees no data.
- Check that the detected agent is selected as Linked Device in the hub.
- Check `mqttBroker` and `mqttPort`.
- Check whether startup logs show `MQTT connected ...`.

Problem: Output is ignored.
- The output key is not defined in the hub I/O configuration through `initKeys`.
- The key must match exactly.

Problem: State changes do not appear in the hub.
- After `setState`, call `sendHeartbeat` if an immediate push is required.

------------------------------------------------------------
10) Related Documentation
------------------------------------------------------------

- MCU reference:
  `../Mikrocontroller/README_MCU_REFERENCE.md`
