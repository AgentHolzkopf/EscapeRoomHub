# Arduino Mega Ethernet Communication Agent Setup

This template connects an Arduino Mega with an Ethernet shield to EscapeHub via MQTT.
The Mega runs as a puzzle agent and processes commands from the hub.

## Files

- `MEGA_Ethernet_CommunikationAgent.ino`
  - Main Arduino Mega sketch
- `CommunikationAgentMCU_Core.h`
  - Protocol logic for heartbeat, state, inputs, outputs, custom values, and external checks

Both files must stay in the same folder.

## Requirements

Arduino IDE:
download following librarys:

- `SPI`
- `Ethernet`
- `PubSubClient`
- `ArduinoJson`

Hardware:

- Arduino Mega
- Ethernet shield (`W5100` or `W5500`)
- Network connection to the same network as the EscapeHub

## Open the Sketch

Do not copy the code into a new sketch.
Open this file directly:

```text
MEGA_Ethernet_CommunikationAgent/MEGA_Ethernet_CommunikationAgent.ino
```

The folder name must match the `.ino` file name.

## DHCP vs Static IP

if no dhcp service is running this values has to be filled in.
if a dhcp service is running they can be left untouched

```cpp
byte MAC_ADDRESS[] = { 0xDE, 0xAD, 0xBE, 0xEF, 0xFE, 0x01 };

IPAddress MQTT_SERVER(192, 168, 1, 10);
const uint16_t MQTT_PORT = 1883;

IPAddress STATIC_IP(192, 168, 1, 60);
IPAddress DNS_SERVER(192, 168, 1, 1);
IPAddress GATEWAY(192, 168, 1, 1);
IPAddress SUBNET(255, 255, 255, 0);

static const char* DEVICE_ID = "puzzle-mega-1";
static const char* PUZZLE_NAME = "Mega Puzzle";
static const bool NEED_RESTART = false;
```

Important (if no dhcp service is running):

- `MAC_ADDRESS` must be unique in your network.
- `MQTT_SERVER` is the IP address of the EscapeHub.
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
  ensureMqttConnected();

  mqttClient.loop();
  agent.loop(millis());

  // Place your own non-blocking puzzle code here.
  // Keep this loop fast: avoid long delay() calls so MQTT and heartbeat stay responsive.

  handlePuzzleLogic();
}
```

Important:

- Avoid long `delay()` calls.
- Use `millis()` instead if possible.
- `mqttClient.loop()` and `agent.loop(millis())` must run regularly.

## Usable functions for communication with the hub

- `agent.getState();`
  - returns the current state of the puzzle
- `agent.setState("solved");`
  - sets a new state (`"running"`, `"solved"`, `"locked"`, `"starting"`)
- `agent.stateChanged();`
  - returns `true` if the state has changed since the last call
- `agent.sendCustom("putStringHere");`
  - sends a custom string to the hub
- `agent.getCustom();`
  - returns the current custom value sent by the hub as a string without clearing it
- `agent.customAvailable();`
  - returns `true` if a custom value is currently available
- `agent.deleteCustom();`
  - deletes the current custom value
- `agent.getInput("key");`
  - returns the current input sent by the hub as a string without clearing it
- `agent.inputAvailable("key");`
  - returns `true` if the input currently exists
- `agent.deleteInput("key");`
  - deletes the current input value for the given key
- `agent.setOutput("key", "value");`
  - sets an output internally as string
- `agent.sendOutput("key");`
  - sends one output to the hub
- `agent.sendAllOutput();`
  - sends all configured outputs to the hub
- `agent.triggerExternalCheck("1234", true);`
  - activates an external check in the hub
- `agent.triggerExternalCheck("", false);`
  - deactivates the external check again

## Notes

- The Mega version uses Ethernet, not WiFi.
- The Mega has less RAM than an ESP32, so keep custom logic and payload sizes small.
- If MQTT connection fails permanently, first verify:
  - Hub IP
  - Network cable / switch connection
  - MQTT broker is running on the hub
