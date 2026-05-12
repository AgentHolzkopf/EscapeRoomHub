# MCU Reference Implementation

This folder contains reference firmware implementations for
`CommunikationAgent` on microcontrollers.

## Included sketches

- `ESP32_CommunikationAgent/ESP32_CommunikationAgent.ino`
  - WiFi + MQTT
  - suitable for ESP32

- `MEGA_Ethernet_CommunikationAgent/MEGA_Ethernet_CommunikationAgent.ino`
  - Ethernet + MQTT
  - suitable for Arduino Mega + Ethernet Shield

Both sketches use the same agent core behavior via:
- `CommunikationAgentMCU_Core.h`

## What is implemented

- Required MQTT topics:
  - subscribe `puzzle/<deviceId>/command`
  - publish `puzzle/<deviceId>/heartbeat`
  - publish `puzzle/<deviceId>/data`
- Optional external check publish helper:
  - `puzzle/<deviceId>/external-check`
- Required command actions:
  - `initKeys`, `clearData`, `restart`, `setState`, `sendParam`, `requestData`
- Optional alias support:
  - `sendOutput`
- Output rule:
  - outputs are accepted only if key exists from `initKeys`

## Not included in MCU reference

- Media upload/download
- Large debug HTTP API
- TLS defaults for very small boards

## Required libraries

ESP32 sketch:
- `WiFi` (from ESP32 core)
- `PubSubClient`
- `ArduinoJson`

Mega sketch:
- `SPI`
- `Ethernet`
- `PubSubClient`
- `ArduinoJson`

## Setup checklist

1. Set broker and device constants in sketch (`MQTT_HOST`/`MQTT_SERVER`, `DEVICE_ID`, `PUZZLE_NAME`).
2. Flash firmware.
3. Link same `deviceId` in Hub puzzle node.
4. Start room, confirm `initKeys` arrives.
5. Verify heartbeat and output/data flow.

## Notes

- Both sketches include a tiny example puzzle logic in `handlePuzzleLogicExample()`.
- Remove or replace it with your actual puzzle logic.

## Related docs

- Node.js setup guide:
  `../Windows, Linux, Pi/README_CommunikationAgent_Setup.txt`
