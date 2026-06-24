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
download following librarys:

#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

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


## Hub Linking

In the hub:

1. Select the puzzle
2. Set Linked Device to the same `DEVICE_ID`
3. Start the room
4. Verify that the puzzle sends heartbeats


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

  handlePuzzleLogic();        // You can use this function for your code
}
```

Important:

- Avoid long `delay()` calls.
- Use `millis()` instead.
- `mqttClient.loop()` and `agent.loop(millis())` must run regularly.

## Usable functions for communication with the hub

 - agent.getState();                         // returns the current state of the puzzle
 - agent.setState("solved");                 // sets a new state ("running", "solved", "locked", "starting") => example: when puzzle is solve: setState("solved")
 - agent.stateChanged();                     // returs true if state has changed since last call and false if not 
 - agent.sendCustom("putStringHere");        // sends custom string to hub 
 - agent.getCustom();                        // returns the current custom value as string without deleting it
 - agent.customAvailable();                  // returns true if a custom value is currently available
 - agent.deleteCustom();                     // deletes the current custom value
 - agent.getInput("key");                    // returns the current input as string without deleting it. the name ("key") has to fit to the input name given in hub UI.
 - agent.inputAvailable("key");              // returns true if the input currently exists
 - agent.deleteInput("key");                 // deletes the current input value for the given key
 - agent.setOutput("key", "value");         // sets output internally as string. "key" must fit to the name given to the output in the hub UI. Example: agent.setOutput("password", "password123");
 - agent.sendOutput("key");                 // sends the output with the name "key" to the hub
 - agent.sendAllOutput();                   // sends all set outputs to the hub
