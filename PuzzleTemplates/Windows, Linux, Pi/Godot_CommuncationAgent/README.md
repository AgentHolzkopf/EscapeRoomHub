# Godot Communication Agent

This template provides a flat Godot 4 communication agent for EscapeHub.

Files included directly in this folder:

- `COMAgent.gd`
- `MQTTClient.gd`
- `README.md`

No addon folder and no extra scene file are required.

## Intended usage

Use `COMAgent.gd` as an Autoload singleton in your Godot project.  
That gives you direct global access through `COMAgent.*` from your scripts.

## Setup

1. Copy `COMAgent.gd` and `MQTTClient.gd` into your Godot project.
2. Open `COMAgent.gd` and set:
   - `HUB_HOST`
   - `MQTT_BROKER`
   - `MQTT_PORT`
   - `DEVICE_ID`
   - `PUZZLE_NAME`
   - `NEED_RESTART`
   - `HEARTBEAT_INTERVAL_MS`
3. In Godot, open `Project -> Project Settings -> Autoload`.
4. Add `COMAgent.gd` as Autoload with the name `COMAgent`.
5. In your game startup code call:

```gdscript
func _ready() -> void:
    COMAgent.start()
```

## Main API

```gdscript
COMAgent.start()
COMAgent.run()
COMAgent.stop()

COMAgent.getState()
COMAgent.setState("running")
COMAgent.stateChanged()

COMAgent.sendCustom("button pressed")
COMAgent.getCustom()
COMAgent.customAvailable()
COMAgent.deleteCustom()

COMAgent.getInput("key")
COMAgent.inputAvailable("key")
COMAgent.deleteInput("key")
COMAgent.getInputType("key")

COMAgent.setOutput("answer", "1234")
COMAgent.sendOutput("answer")
COMAgent.sendAllOutputs()

COMAgent.triggerExternalCheck("1234", true)
COMAgent.restartComplete()

COMAgent.setMedia("image", "res://art/picture.png")
COMAgent.sendMedia("image")
COMAgent.getMedia("image")
COMAgent.deleteMedia("image")
```

## Notes

- `run()` is optional when `COMAgent` is used as Autoload.  
  The singleton already processes MQTT and heartbeats internally.
- `start()` only initializes the agent locally.  
  If the hub or MQTT broker is currently offline, the agent keeps running and retries connecting in the background.
- `getInput()` returns an empty string when no input is available.
- `getMedia()` returns the local absolute path when the media file is ready.  
  Otherwise it returns an empty string.
- Incoming media is downloaded immediately after the hub sends it.
- Local media is uploaded asynchronously when `sendMedia()` is called.

## Example

```gdscript
func _process(_delta: float) -> void:
    if COMAgent.inputAvailable("seriell"):
        var value := COMAgent.getInput("seriell")
        print(value)
        COMAgent.deleteInput("seriell")

    if COMAgent.customAvailable():
        print(COMAgent.getCustom())
        COMAgent.deleteCustom()
```

## License note

`MQTTClient.gd` is adapted from the MIT-licensed `godot-mqtt` project:  
<https://github.com/goatchurchprime/godot-mqtt>
