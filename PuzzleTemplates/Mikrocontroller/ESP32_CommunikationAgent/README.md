# ESP32 Communication Agent Setup

This template connects an ESP32 puzzle to EscapeHub via WiFi and MQTT.
The ESP32 runs as a puzzle agent and processes commands from the hub.

## Files

- `ESP32_CommunikationAgent.ino`
  - Main ESP32 sketch
- `CommunikationAgentMCU_Core.h`
  - Protocol logic for heartbeat, state, inputs, outputs, custom values, and external checks

Both files must stay in the same folder.

## Requirements

Arduino IDE:

- ESP32 board support by `Espressif Systems`
- Library `PubSubClient`
- Library `ArduinoJson`

Install libraries:

1. Open Arduino IDE
2. Go to `Sketch` -> `Include Library` -> `Manage Libraries...`
3. Search for `PubSubClient` and install it
4. Search for `ArduinoJson` and install it

Install ESP32 board support:

1. Go to `File` -> `Preferences`
2. Add this URL under `Additional Boards Manager URLs`:

```text
https://espressif.github.io/arduino-esp32/package_esp32_index.json
```

3. Go to `Tools` -> `Board` -> `Boards Manager...`
4. Search for `esp32`
5. Install `esp32 by Espressif Systems`

## Open the Sketch

Do not copy the code into a new sketch.
Open this file directly:

```text
ESP32_CommunikationAgent/ESP32_CommunikationAgent.ino
```

The folder name must match the `.ino` file name.

## Configuration

Edit the configuration section at the top of the sketch:

```cpp
static const char* WIFI_SSID = "WIFI_SSID";
static const char* WIFI_PASS = "WIFI_PASS";

static const char* MQTT_HOST = "MQTT_HOST_IP";
static const uint16_t MQTT_PORT = 1883;

static const char* DEVICE_ID = "puzzle-esp32-1";
static const char* PUZZLE_NAME = "ESP32 Puzzle";
static const bool NEED_RESTART = false;
```

Important:

- `MQTT_HOST` is the IP address of the EscapeHub.
- `DEVICE_ID` must match the linked device ID configured for the puzzle in the hub.
- `PUZZLE_NAME` is only the display name.
- `NEED_RESTART = true` means the puzzle reports `starting` after restart and must later set itself to `running`.

## Upload

Arduino IDE:

1. Select board:

```text
Tools -> Board -> ESP32 Arduino -> ESP32 Dev Module
```

2. Select port:

```text
Tools -> Port -> COM...
```

3. Start upload.

If upload hangs at `Connecting...`:

- Hold the BOOT button on the ESP32
- Start upload
- Release BOOT once upload begins

## Serial Monitor

After upload:

1. Open Serial Monitor
2. Set baud rate to `115200`

The sketch prints received custom values:

```text
Custom received from Hub: button pressed
```

## Hub Linking

In the hub:

1. Select the puzzle
2. Set Linked Device to the same `DEVICE_ID`
3. Start the room
4. Verify that the puzzle sends heartbeats

MQTT topics:

- Hub -> ESP32:

```text
puzzle/<deviceId>/command
```

- ESP32 -> Hub:

```text
puzzle/<deviceId>/heartbeat
puzzle/<deviceId>/data
puzzle/<deviceId>/custom
puzzle/<deviceId>/external-check
```

## Custom Puzzle Logic

Add your own logic inside `loop()`:

```cpp
void loop() {
  ensureWifiConnected();
  ensureMqttConnected();

  mqttClient.loop();
  agent.loop(millis());

  // Place your own non-blocking puzzle code here.
  // Keep this loop fast: avoid long delay() calls so MQTT and heartbeat stay responsive.

  handlePuzzleLogicExample();
}
```

Important:

- Avoid long `delay()` calls.
- Use `millis()` instead.
- `mqttClient.loop()` and `agent.loop(millis())` must run regularly.

## Read Inputs from the Hub

When the hub sends an input to the puzzle:

```cpp
const char* value = agent.getInputValue("Solve");
if (value && strcmp(value, "true") == 0) {
  // Input is true.
}
```

## Send Output to the Hub

Set and send an output:

```cpp
if (agent.setOutputFromPuzzle("VerifyCorrect", "boolean", "true")) {
  agent.sendOutputFromPuzzle("VerifyCorrect");
}
```

The output key must be configured for this puzzle in the hub first.

## Set State

Report puzzle as running:

```cpp
agent.setState("running");
```

Report puzzle as solved:

```cpp
agent.setState("solved");
```

## Receive Custom Values from the Hub

Custom values are event-like messages from the hub.

```cpp
const char* custom = agent.getCustomValue();
if (custom) {
  Serial.print("Custom received from Hub: ");
  Serial.println(custom);

  if (strcmp(custom, "button pressed") == 0) {
    // Your own reaction here.
  }

  agent.clearCustomValue();
}
```

`clearCustomValue()` is important when the same value should trigger repeatedly.
Example: every button press sends `button pressed` again.

## Send Custom Values to the Hub

```cpp
agent.publishCustomFromPuzzle("my-custom-value");
```

The hub receives:

```json
{"value":"my-custom-value","deviceId":"puzzle-esp32-1"}
```

## Trigger External Check

```cpp
agent.triggerExternalCheck("1234", true);
```

This sends an external check value to the hub.

## Common Errors

`PubSubClient.h: No such file or directory`

- Library `PubSubClient` is missing.

`ArduinoJson.h: No such file or directory`

- Library `ArduinoJson` is missing.

`CommunikationAgentMCU_Core.h: No such file or directory`

- The `.ino` was compiled from a temporary Arduino sketch.
- Open the complete template folder directly.

No connection to the hub:

- Check `WIFI_SSID` / `WIFI_PASS`.
- Check `MQTT_HOST`.
- EscapeHub and ESP32 must be in the same network.
- Mosquitto/MQTT must be running on the hub.

Puzzle does not appear in the hub:

- `DEVICE_ID` in the sketch and Linked Device in the hub must match.
- The room must be started so `initKeys` and commands are sent.