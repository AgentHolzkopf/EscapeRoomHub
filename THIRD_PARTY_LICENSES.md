# Third-Party Licenses

This repository includes or references third-party components that are licensed separately from the EscapeHub project code.

EscapeHub project code is licensed under the PolyForm Noncommercial License 1.0.0.  
Third-party components keep their own original licenses.

## Scope

This file documents direct third-party components that are either:

- bundled in this repository,
- declared as direct runtime dependencies,
- or required directly by the shipped puzzle templates.

## Web UI / Frontend

### Blockly

- Component: `Blockly`
- Usage: bundled browser library in `public/vendor/blockly.min.js`
- Upstream: <https://github.com/google/blockly>
- License: Apache License 2.0

### LiteGraph.js

- Component: `litegraph.js`
- Version: `0.7.3`
- Usage: direct dependency in the server/editor runtime and bundled browser file
- Upstream: <https://github.com/jagenjo/litegraph.js>
- Package: <https://www.npmjs.com/package/litegraph.js>
- License: MIT License

## Node.js Server

### Express

- Component: `express`
- Version: `5.2.1`
- Usage: HTTP server
- Upstream: <https://github.com/expressjs/express>
- Package: <https://www.npmjs.com/package/express>
- License: MIT License

### MQTT.js

- Component: `mqtt`
- Version: `5.14.1`
- Usage: MQTT client connection from hub to broker
- Upstream: <https://github.com/mqttjs/MQTT.js>
- Package: <https://www.npmjs.com/package/mqtt>
- License: MIT License

### sqlite3

- Component: `sqlite3`
- Version: `5.1.7`
- Usage: SQLite database access
- Upstream: <https://github.com/TryGhost/node-sqlite3>
- Package: <https://www.npmjs.com/package/sqlite3>
- License: BSD-3-Clause

## Unity / C# Template

### MQTTnet

- Component: `MQTTnet`
- Version used in the Unity / C# template: `4.3.7.1207`
- Upstream: <https://github.com/dotnet/MQTTnet>
- Package: <https://www.nuget.org/packages/MQTTnet/4.3.7.1207>
- License: MIT License

MIT License

Copyright (c) The contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### Newtonsoft.Json

- Component: `Newtonsoft.Json`
- Version used in the Unity / C# template: `13.0.3`
- Upstream: <https://github.com/JamesNK/Newtonsoft.Json>
- Package: <https://www.nuget.org/packages/Newtonsoft.Json/13.0.3>
- License: MIT License

MIT License

Copyright (c) James Newton-King

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Python Template

### requests

- Component: `requests`
- Version used by the template environment: `2.34.2`
- Usage: HTTP communication and media transfer
- Upstream: <https://github.com/psf/requests>
- Package: <https://pypi.org/project/requests/>
- License: Apache License 2.0

### paho-mqtt

- Component: `paho-mqtt`
- Version used by the template environment: `2.1.0`
- Usage: MQTT client for the Python communication agent
- Upstream: <https://github.com/eclipse-paho/paho.mqtt.python>
- Package: <https://pypi.org/project/paho-mqtt/>
- License: EPL-2.0 OR BSD-3-Clause

## Mikrocontroller Templates

These templates depend on Arduino / board-platform libraries that are installed through the Arduino IDE or board package manager rather than bundled directly in this repository.

### ArduinoJson

- Component: `ArduinoJson`
- Usage: JSON serialization/deserialization in ESP32 and MEGA templates
- Upstream: <https://github.com/bblanchon/ArduinoJson>
- License: MIT License

### PubSubClient

- Component: `PubSubClient`
- Usage: MQTT client in ESP32 and MEGA templates
- Upstream: <https://github.com/knolleary/pubsubclient>
- License: MIT License

### Arduino Core / Board Libraries

- Components used directly by the templates include:
  - `WiFi.h`
  - `SPI.h`
  - `Ethernet.h`
  - `Arduino.h`
- These are provided by the corresponding Arduino / ESP32 platform packages.
- Their licenses follow the upstream board and core packages and are not redistributed here as standalone copies.

## Notes

- The non-commercial restriction of the EscapeHub project does not replace or rewrite the original licenses of bundled third-party components.
- If you redistribute this repository or parts of it, keep the project license and the third-party notices together.
- Direct server dependencies `i` and `npm` were removed from `Server/package.json` because no code usage exists in the repository and they only increased unnecessary dependency and licensing surface.
