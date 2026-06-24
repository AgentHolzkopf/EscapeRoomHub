# Python Communication Agent

This template is the direct Python variant of the EscapeHub communication agent.

It is intended for Python-based puzzles such as:

- `pygame`
- custom desktop applications
- small local tools
- Raspberry Pi Python projects

## Included Features

- heartbeat publishing
- state synchronization with the hub
- input reception
- output sending
- custom event sending and receiving
- external check triggering
- restart handling
- immediate media download on incoming media inputs
- manual/background media upload via `sendMedia()`

## Files

- [COMAgent.py](D:\Projekte\MD2-ProjektB\HubRemoteEditing\PuzzleTemplates\Windows, Linux, Pi\Python_CommunikationAgent\COMAgent.py): Python communication agent module

## Requirements

Install Python packages:

```bash
pip install paho-mqtt requests
```

At the top of `COMAgent.py`, set:

```python
HUB_HOST = "192.168.1.10"
MQTT_BROKER = HUB_HOST
MQTT_PORT = 1883

DEVICE_ID = "puzzle-python-1"
PUZZLE_NAME = "Python Puzzle"
NEED_RESTART = False
HEARTBEAT_INTERVAL_MS = 2000

MEDIA_SERVER = f"http://{HUB_HOST}"
MEDIA_LOCAL_DIR = "MediaStorage"
MQTT_TOPIC_PREFIX = "puzzle"
```

`MEDIA_LOCAL_DIR` is the folder used for both downloaded media inputs and media output files that should be uploaded.

## Runtime Model

Your own puzzle script should:

1. import the agent module
2. call `start()` once
3. call `run()` repeatedly from your own main loop
4. use the helper functions when needed

## Available Functions

These functions are available directly in the script:

- `start()`
- `run()`
- `getState()`
- `setState(state)`
- `stateChanged()`
- `getInput(key)`
- `inputAvailable(key)`
- `deleteInput(key)`
- `getInputType(key)`
- `setOutput(key, value)`
- `sendOutput(key)`
- `setMedia(key, source_path)`
- `getMedia(key)`
- `sendMedia(key)`
- `deleteMedia(key)`
- `sendAllOutputs()`
- `sendCustom(value)`
- `getCustom()`
- `customAvailable()`
- `deleteCustom()`
- `triggerExternalCheck(value, active=True)`
- `restartComplete()`
- `publish_heartbeat_now()`
- `resolveMedia(name)`
- `downloadMedia(remote_name, local_path=None)`
- `uploadMedia(local_path, remote_name=None)`


## Media Behavior

If the hub sends a media input to the puzzle:

- the agent starts downloading it into `MEDIA_LOCAL_DIR` immediately

If your puzzle wants to send media to the hub:

- call `setMedia(key, source_path)`
- the file is copied into `MEDIA_LOCAL_DIR`
- call `sendMedia(key)`

For media outputs, the local file name should match the output key by filename stem.

Example:

- output key: `introVideo`
- local file: `MediaStorage/introVideo.mp4`

Manual media usage is also possible:

```python
import COMAgent as hub

resolved_name = hub.resolveMedia("introVideo")
downloaded_file = hub.downloadMedia("introVideo")
upload_result = hub.uploadMedia("MediaStorage/result.png")
```

Media can also be used alongside the normal string input/output values:

```python
import COMAgent as hub

hub.start()

# read an incoming media input by key
intro_video_path = hub.getMedia("introVideo")
if intro_video_path is False:
    print("Media not downloaded yet")

# set a normal string output value
hub.setOutput("serial", "1234")

# copy a local file into MEDIA_LOCAL_DIR and assign it to the media key
hub.setMedia("resultImage", "C:/temp/resultImage.png")

# then upload it and notify the hub for this output
hub.sendMedia("resultImage")

# delete the local file from MEDIA_LOCAL_DIR
hub.deleteMedia("resultImage")
```

Behavior:

- `getInput(key)` returns the current input value without deleting it
- `inputAvailable(key)` returns `True` when the input currently exists
- `deleteInput(key)` deletes the current input value for the given key
- `setOutput(key, value)` sets a normal string output value
- `setMedia(key, source_path)` copies a file into `MEDIA_LOCAL_DIR` and assigns it to the media key
- `getMedia(key)` returns the local file path for a media key only when the file is already present locally, otherwise `False`
- `sendMedia(key)` starts a background upload and sends the media output to the hub after the upload completes
- `deleteMedia(key)` deletes the assigned file from `MEDIA_LOCAL_DIR`

## Blocking vs Non-Blocking

Normal puzzle-facing media functions are non-blocking:

- `getMedia(key)`
- `sendMedia(key)`

Low-level helper functions are still direct blocking helpers:

- `resolveMedia(name)`
- `downloadMedia(remote_name, local_path=None)`
- `uploadMedia(local_path, remote_name=None)`

Use the low-level helpers only when you explicitly want direct synchronous control.

## Restart Behavior

If `NEED_RESTART = False`:

- a hub restart command directly switches the puzzle to `running`

If `NEED_RESTART = True`:

- the hub restart command switches the puzzle to `starting`
- your puzzle code must call `restartComplete()` when it is ready

## Notes

- `getCustom()` does not delete the value automatically
- `customAvailable()` returns `True` when a custom value is currently present
- `deleteCustom()` deletes the current custom value explicitly
- there is no debug HTTP API in this template
- all setup is local and script-based, like the MCU templates
- the agent is not intended to contain your puzzle logic
