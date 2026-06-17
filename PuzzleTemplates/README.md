# Puzzle Templates

These templates help connect custom puzzles to EscapeHub quickly.

## Which Template Should I Use?

- Node.js process on Windows, Linux, or Raspberry Pi:
  - Folder: `PuzzleTemplates/Windows, Linux, Pi`
  - Entry point: `README_CommunikationAgent_Setup.txt`
- Microcontroller (ESP32 / Arduino Mega):
  - Folder: `PuzzleTemplates/Mikrocontroller`
  - Entry point: `README_MCU_REFERENCE.md`

## TL;DR (Node.js)

1. Open `PuzzleTemplates/Windows, Linux, Pi`.
2. Run `npm install mqtt`.
3. Edit `CommunikationAgent.config.json` (`deviceId`, `mqttBroker`).
4. Start the agent: `node CommunikationAgent.js --port 5001`.
5. Set the same `deviceId` as Linked Device in the hub and start the room.

## TL;DR (MCU)

1. Open the sketch (`ESP32_...` or `MEGA_...`).
2. Set `MQTT_HOST` / `MQTT_SERVER`, `DEVICE_ID`, and `PUZZLE_NAME`.
3. Flash the board and connect it to the network.
4. Set the same `deviceId` as Linked Device in the hub and start the room.
5. Verify that `initKeys` arrives and heartbeats are sent.

## Important MQTT Topics

- Hub -> Puzzle: `puzzle/<deviceId>/command`
- Puzzle -> Hub:
  - `puzzle/<deviceId>/heartbeat`
  - `puzzle/<deviceId>/data`
  - `puzzle/<deviceId>/custom`
  - `puzzle/<deviceId>/external-check`

## Common Issues

- No reaction in the hub:
  - `deviceId` does not match between hub and agent.
  - MQTT broker is not reachable.
- Output does not arrive:
  - Output key was not created by the hub through `initKeys`.
- Values are delayed:
  - Verify that heartbeats and `data` messages are actually published.