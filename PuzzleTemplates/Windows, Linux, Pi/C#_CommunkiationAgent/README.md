# C# / Unity Communication Agent

This agent is meant to be embedded directly into a Unity project. It talks to Escape Room Hub over MQTT and exposes simple C# functions for puzzle state, inputs, outputs, custom messages, and media files.

## Files

- `COMAgent.cs` contains the actual agent.
- `UnityAgentExample.cs` shows how to call the agent from a Unity `MonoBehaviour`.
- `UnityPlugins/MQTTnet.dll` is the MQTT dependency.
- `UnityPlugins/Newtonsoft.Json.dll` is the JSON dependency.
- `InstallUnityAgent.ps1` copies the agent and DLLs into a Unity project.

## Unity Setup

### Recommended: install by script

Run this from PowerShell:

```powershell
cd "C:\path\to\EscapeRoomHub\PuzzleTemplates\Windows, Linux, Pi\C#_CommunkiationAgent"
.\InstallUnityAgent.ps1 -UnityProjectPath "C:\path\to\YourUnityProject"
```

Optional: also copy the example script:

```powershell
.\InstallUnityAgent.ps1 -UnityProjectPath "C:\path\to\YourUnityProject" -IncludeExample
```

The script copies:

```text
Assets/Scripts/COMAgent.cs
Assets/Plugins/MQTTnet.dll
Assets/Plugins/Newtonsoft.Json.dll
```

### Manual install

1. Copy `COMAgent.cs` into your Unity project:

   ```text
   Assets/Scripts/COMAgent.cs
   ```

2. Copy the included DLLs into your Unity project:

   ```text
   Assets/Plugins/MQTTnet.dll
   Assets/Plugins/Newtonsoft.Json.dll
   ```

3. Configure the values at the top of `COMAgent.cs`:

   ```csharp
   public static string HUB_HOST = "192.168.1.10";
   public static string MQTT_BROKER = HUB_HOST;
   public static int MQTT_PORT = 1883;
   public static string DEVICE_ID = "unity-puzzle-1";
   public static string PUZZLE_NAME = "Unity Puzzle";
   public static bool NEED_RESTART = false;
   ```

4. Call the agent from a Unity script:

   ```csharp
   using UnityEngine;

   public class PuzzleMain : MonoBehaviour
   {
       private void Start()
       {
           COMAgent.start();
       }

       private void Update()
       {
           COMAgent.run();

           if (Input.GetKeyDown(KeyCode.Return))
           {
               COMAgent.setState("solved");
           }
       }

       private void OnApplicationQuit()
       {
           COMAgent.stop();
       }
   }
   ```

## Basic Workflow

Call `COMAgent.start()` once when your Unity scene starts.

Call `COMAgent.run()` once per frame in `Update()`. This keeps heartbeats and reconnects active.

React to Hub state:

```csharp
if (COMAgent.getState() == "running")
{
    // Your puzzle is active.
}
```

Send a solved state:

```csharp
COMAgent.setState("solved");
```

Send an output:

```csharp
COMAgent.setOutput("score", "42");
COMAgent.sendOutput("score");
```

Read an input:

```csharp
if (COMAgent.inputAvailable("pin"))
{
    string value = COMAgent.getInput("pin");
    Debug.Log("PIN input: " + value);
    COMAgent.deleteInput("pin");
}
```

Send a custom value:

```csharp
COMAgent.sendCustom("button pressed");
```

Read a custom value from the Hub:

```csharp
if (COMAgent.customAvailable())
{
    string custom = COMAgent.getCustom();
    Debug.Log("Custom value: " + custom);
    COMAgent.deleteCustom();
}
```

## Available Functions

### Lifecycle

```csharp
COMAgent.start();
COMAgent.run();
COMAgent.stop();
```

### State

```csharp
string state = COMAgent.getState();
bool changed = COMAgent.stateChanged();
COMAgent.setState("locked");
COMAgent.setState("starting");
COMAgent.setState("running");
COMAgent.setState("solved");
COMAgent.restartComplete();
```

### Inputs

```csharp
string value = COMAgent.getInput("key");
bool available = COMAgent.inputAvailable("key");
COMAgent.deleteInput("key");
string type = COMAgent.getInputType("key");
```

### Outputs

```csharp
COMAgent.setOutput("key", "hello");
COMAgent.sendOutput("key");
COMAgent.sendAllOutputs();
```

### Custom

```csharp
COMAgent.sendCustom("value");
string value = COMAgent.getCustom();
bool available = COMAgent.customAvailable();
COMAgent.deleteCustom();
```

`getCustom()` does not delete the current custom value automatically.

### External Check

```csharp
COMAgent.triggerExternalCheck("player input", true);
COMAgent.triggerExternalCheck("player input", false);
```

### Media

`MEDIA_LOCAL_DIR` is created automatically when `COMAgent.start()` runs.

Incoming media sent by the hub is downloaded immediately in the background when the MQTT message arrives.

`getMedia(key)` only returns a local file path when the file is already present locally. Otherwise it returns an empty string.

```csharp
string localPath = COMAgent.getMedia("image");
COMAgent.setMedia("image", "C:/path/to/image.png");
COMAgent.sendMedia("image");
COMAgent.deleteMedia("image");
```

For outgoing media:

- call `COMAgent.setMedia("key", "C:/path/to/file.png")`
- the file is copied into `MEDIA_LOCAL_DIR`
- call `COMAgent.sendMedia("key")`

Lower-level media helpers:

```csharp
string resolved = COMAgent.resolveMedia("image.png");
string downloaded = COMAgent.downloadMedia("image.png");
string uploadedName = COMAgent.uploadMedia("C:/path/to/image.png");
```

## Notes

- The agent is designed for Windows, Linux, and Unity desktop builds.
- It is not intended for Unity WebGL.
- If the Hub is offline, the agent keeps Unity running and reconnects when possible.
- The Hub must allow MQTT connections from other devices on port `1883`.
- Included dependency versions:
  - `MQTTnet` 4.3.7.1207
  - `Newtonsoft.Json` 13.0.3

