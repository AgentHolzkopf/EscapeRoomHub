Generic Communication Agent Setup (Node.js)
==========================================

This template uses MQTT internally for communication with the hub.
Your own puzzle logic talks to the agent locally through HTTP.

Short version:
- Hub <-> Agent: MQTT
- Puzzle logic <-> Agent: HTTP

Public data model:
- inputs are strings or media
- outputs are strings or media
- custom values are strings
- no public number/boolean workflow

------------------------------------------------------------
1) Core idea
------------------------------------------------------------

The Generic Communication Agent is the fallback option for projects that do not fit one of the dedicated agents.
Instead of embedding agent logic directly, your application talks to a separately running local agent over HTTP.

Run `CommunikationAgent.js` next to your puzzle application.
Your application does not need to know anything about MQTT.
It only calls the local HTTP API.

Typical flow:
1. Read the current puzzle state with `GET /getState`
2. React to `locked`, `running`, `solved`, or `starting`
3. Read incoming string data with `GET /getInput?key=...`
4. Send outgoing string data with `POST /setOutput` and `POST /sendOutput`
5. Send outgoing media with `POST /setMedia` and `POST /sendMedia`
6. When the puzzle is solved, call `POST /setState` with `solved`

------------------------------------------------------------
2) Quickstart
------------------------------------------------------------

Windows installer:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-agent.ps1
```

If Node.js is missing:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-agent.ps1 -InstallNode
```

Then start the agent:

```bash
node CommunikationAgent.js --port 5001
```

Then optionally open the browser test client:

```text
CommunikationAgent_TestClient.html
```

------------------------------------------------------------
3) Minimal configuration
------------------------------------------------------------

Example `CommunikationAgent.config.json`:

```json
{
  "hubHost": "192.168.101.96",
  "mqttBroker": "192.168.101.96",
  "mqttPort": 1883,
  "puzzleName": "TestPuzzle",
  "heartbeatIntervalMs": 2000,
  "needRestart": false,
  "mediaLocalDir": "MediaStorage"
}
```

Notes:
- the installer creates a stable `.agent-device-id`
- `deviceId` in the JSON is optional
- if no persistent ID exists, the agent falls back to the local IP
- media files are stored locally in `mediaLocalDir`

------------------------------------------------------------
4) Example workflow
------------------------------------------------------------

Python example:

```python
import time
import requests

BASE = "http://127.0.0.1:5001"

while True:
    state = requests.get(f"{BASE}/getState", timeout=3).json()["state"]

    if state == "running":
        available = requests.get(
            f"{BASE}/inputAvailable",
            params={"key": "Code"},
            timeout=3,
        ).json()["available"]

        if available:
            data = requests.get(
                f"{BASE}/getInput",
                params={"key": "Code"},
                timeout=3,
            ).json()

            if data.get("data") == "1234":
                requests.post(
                    f"{BASE}/setOutput",
                    json={"key": "Result", "data": "OK"},
                    timeout=3,
                )
                requests.post(
                    f"{BASE}/sendOutput",
                    json={"key": "Result"},
                    timeout=3,
                )
                requests.post(
                    f"{BASE}/sendCustom",
                    json={"value": "correct code"},
                    timeout=3,
                )
                requests.post(
                    f"{BASE}/setState",
                    json={"state": "solved"},
                    timeout=3,
                )
                break

    time.sleep(0.1)
```

------------------------------------------------------------
5) HTTP API
------------------------------------------------------------

Base URL:
- `BASE=http://127.0.0.1:5001`

State:
- `GET /getState`
- `POST /setState` with `{ "state": "running" }`

Inputs:
- `GET /getInput?key=Code`
- `GET /inputAvailable?key=Code`
- `POST /deleteInput` with `{ "key": "Code" }`
- `POST /sendParam` with `{ "key": "Code", "data": "1234" }`
  This is mainly useful for local tests.

Input response example:

```json
{
  "key": "Code",
  "type": "string",
  "data": "1234",
  "present": true
}
```

Outputs:
- `POST /setOutput` with `{ "key": "Result", "data": "OK" }`
- `POST /sendOutput` with `{ "key": "Result" }`
- `POST /sendAllOutputs`
- `GET /getOutput?key=Result`

Output response example:

```json
{
  "key": "Result",
  "output": {
    "type": "string",
    "data": "OK",
    "present": true
  }
}
```

Custom:
- `POST /sendCustom` with `{ "value": "button pressed" }`
- `GET /getCustom`
- `GET /customAvailable`
- `POST /deleteCustom`

Custom response example:

```json
{
  "value": "button pressed",
  "available": true
}
```

External check:
- `POST /triggerExternalCheck` with `{ "value": "1234", "active": true }`
- `GET /getExternalCheck`

Restart:
- `POST /restartComplete`
- `POST /restartConfig` with `{ "needRestart": true }`

Media:
- `POST /setMedia` with `{ "key": "image", "sourcePath": "./MediaStorage/test.png" }`
- `POST /sendMedia` with `{ "key": "image" }`
- `GET /getMedia?key=image`
- `GET /media/file?key=image`
- `POST /deleteMedia` with `{ "key": "image" }`
- `POST /media/upload` with `{ "localPath": "./MediaStorage/test.png", "remoteName": "test.png" }`
- `POST /media/download` with `{ "remoteName": "test.png", "localPath": "./MediaStorage/test_copy.png" }`

Media behavior:
- `setMedia` copies a local file into the agent's local media folder and binds it to the given key
- `sendMedia` uploads that local file to the hub and then forwards the key as a media output
- when the hub sends a media input to the agent, the agent starts downloading it immediately in the background
- `getMedia(key)` only returns a local path after the file is fully available locally
- `GET /media/file?key=...` streams that local file directly from the agent for preview/debugging

Debug:
- `GET /getAll`

------------------------------------------------------------
6) Curl examples
------------------------------------------------------------

```bash
curl "http://127.0.0.1:5001/getState"
curl -X POST "http://127.0.0.1:5001/setState" -H "Content-Type: application/json" -d "{\"state\":\"running\"}"

curl "http://127.0.0.1:5001/inputAvailable?key=Code"
curl "http://127.0.0.1:5001/getInput?key=Code"
curl -X POST "http://127.0.0.1:5001/deleteInput" -H "Content-Type: application/json" -d "{\"key\":\"Code\"}"

curl -X POST "http://127.0.0.1:5001/setOutput" -H "Content-Type: application/json" -d "{\"key\":\"Result\",\"data\":\"OK\"}"
curl -X POST "http://127.0.0.1:5001/sendOutput" -H "Content-Type: application/json" -d "{\"key\":\"Result\"}"

curl -X POST "http://127.0.0.1:5001/sendCustom" -H "Content-Type: application/json" -d "{\"value\":\"button pressed\"}"
curl "http://127.0.0.1:5001/getCustom"

curl -X POST "http://127.0.0.1:5001/triggerExternalCheck" -H "Content-Type: application/json" -d "{\"value\":\"1234\",\"active\":true}"
curl "http://127.0.0.1:5001/getExternalCheck"

curl -X POST "http://127.0.0.1:5001/setMedia" -H "Content-Type: application/json" -d "{\"key\":\"image\",\"sourcePath\":\"./MediaStorage/test.png\"}"
curl -X POST "http://127.0.0.1:5001/sendMedia" -H "Content-Type: application/json" -d "{\"key\":\"image\"}"
curl "http://127.0.0.1:5001/getMedia?key=image"
curl "http://127.0.0.1:5001/media/file?key=image"
```

------------------------------------------------------------
7) Test client
------------------------------------------------------------

`CommunikationAgent_TestClient.html` covers these common checks:
- refresh current state/custom/external-check status
- set and send a string output
- set and send a media output
- preview incoming downloaded media
- trigger an external check
- send a custom value
- manually set puzzle state
- inspect and delete single inputs

------------------------------------------------------------
8) Notes
------------------------------------------------------------

- Incoming media is downloaded immediately when the hub sends a media input.
- `getMedia(key)` only returns a local path when the file is already available.
- `sendMedia(key)` uploads the matching local file and then forwards the media output to the hub.
- The agent itself still listens to hub MQTT commands like `initKeys`, `sendParam`, `setState`, `restart`, and `sendCustom`.
- The local HTTP API is the intended integration surface for your own application logic.
