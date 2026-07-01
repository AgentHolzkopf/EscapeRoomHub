# Unreal Communication Agent

This template provides a global EscapeHub communication agent for Unreal Engine without a plugin.

The integration is based on:

- `UEscapeHubAgentSubsystem`
- `COMAgent`

The subsystem runs globally through the `GameInstance`.  
`COMAgent` gives simple access from anywhere in the project.

## Included files

- `EscapeHubAgentSubsystem.h`
- `EscapeHubAgentSubsystem.cpp`
- `COMAgent.h`
- `COMAgent.cpp`
- `README.md`

## Intended usage

Copy the files into your Unreal project's `Source/<YourProjectName>/` folder and call the `COMAgent` functions from your game code.

No Actor has to be placed in the level.

## Setup

1. Copy the files into your Unreal project, for example:

```text
Source/<YourProjectName>/EscapeHubAgentSubsystem.h
Source/<YourProjectName>/EscapeHubAgentSubsystem.cpp
Source/<YourProjectName>/EscapeHubAgentLibrary.h
Source/<YourProjectName>/EscapeHubAgentLibrary.cpp
```

2. Open your `<YourProjectName>.Build.cs` and make sure these modules are included:

```csharp
PublicDependencyModuleNames.AddRange(new string[]
{
    "Core",
    "CoreUObject",
    "Engine",
    "Sockets",
    "Networking",
    "HTTP",
    "Json",
    "JsonUtilities"
});
```

3. Open `EscapeHubAgentSubsystem.cpp` and set the values in `EscapeHubAgentConfig`:

- `HubHost`
- `MqttBroker`
- `MqttPort`
- `DeviceId`
- `PuzzleName`
- `NeedRestart`
- `HeartbeatIntervalMs`

4. Rebuild the project.

5. Use the agent from C++ or Blueprints.

## Runtime behavior

- The subsystem starts automatically when the game instance is created.
- If the hub or broker is offline, the agent stays alive and retries connecting in the background.
- MQTT communication is done directly inside the project.
- Media uploads and downloads use Unreal's HTTP module asynchronously.

## Main API

All important functions are exposed through `UEscapeHubAgentLibrary`.

### State

```cpp
COMAgent::GetState(this);
COMAgent::SetState(this, TEXT("running"));
COMAgent::StateChanged(this);
```

### Custom values

```cpp
COMAgent::SendCustom(this, TEXT("button pressed"));
COMAgent::GetCustom(this);
COMAgent::CustomAvailable(this);
COMAgent::DeleteCustom(this);
```

### Inputs

```cpp
COMAgent::GetInput(this, TEXT("seriell"));
COMAgent::InputAvailable(this, TEXT("seriell"));
COMAgent::DeleteInput(this, TEXT("seriell"));
COMAgent::GetInputType(this, TEXT("seriell"));
```

### Outputs

```cpp
COMAgent::SetOutput(this, TEXT("answer"), TEXT("1234"));
COMAgent::SendOutput(this, TEXT("answer"));
COMAgent::SendAllOutputs(this);
```

### External check

```cpp
COMAgent::TriggerExternalCheck(this, TEXT("1234"), true);
```

### Restart complete

```cpp
COMAgent::RestartComplete(this);
```

### Media

```cpp
COMAgent::SetMedia(this, TEXT("image"), TEXT("C:/Temp/example.png"));
COMAgent::SendMedia(this, TEXT("image"));
COMAgent::GetMedia(this, TEXT("image"));
COMAgent::DeleteMedia(this, TEXT("image"));
```

## Example

```cpp
if (COMAgent::InputAvailable(this, TEXT("seriell")))
{
    const FString Value = COMAgent::GetInput(this, TEXT("seriell"));
    UE_LOG(LogTemp, Warning, TEXT("Input: %s"), *Value);
    COMAgent::DeleteInput(this, TEXT("seriell"));
}

if (COMAgent::CustomAvailable(this))
{
    const FString Value = COMAgent::GetCustom(this);
    UE_LOG(LogTemp, Warning, TEXT("Custom: %s"), *Value);
    COMAgent::DeleteCustom(this);
}
```

## Notes

- The current template supports the EscapeHub-facing data types `string` and `media`.
- MQTT is implemented minimally for the required EscapeHub agent workflow:
  - connect
  - subscribe
  - publish
  - receive command messages
- The template is designed for easy integration, not as a full standalone Unreal plugin.
