# EscapeHub - Escape Room Control System

EscapeHub ist eine **lokale Web-Anwendung** zur Steürung und Verwaltung von **Escape-Room-Räumen, Rätseln, Sensoren, Licht, Sounds und Screens**.

Das System läuft typischerweise auf einem **Raspberry Pi** und verbindet mehrere Komponenten: digitale Puzzle-Clients, Zigbee-Sensoren, DMX-Lampen, Sound-Ausgabe, Player-Screens und eine visülle Scripting-Oberfläche.

---

## Kurzüberblick

EscapeHub bietet eine zentrale Oberfläche, um einen Escape Room zu konfigurieren, zu starten und live zu überwachen.

Unterstützt werden unter anderem:

* Raum- und Branch-Verwaltung
* Visüller Puzzle-Graph
* Blockly-Scripting für Room- und Puzzle-Logik
* Zigbee2MQTT Sensorintegration
* DMX/OLA Lichtsteürung
* Sound-cues mit Upload und Lautstärkeregelung
* Hint-, Player- und Progress-Screens
* Kommunikation mit externen Puzzle-Clients über MQTT und HTTP
* System-Settings für Dienste, USB-Geräte und Screens

---

## Projektstruktur

```text
MD2-ProjektB/
|
|-- HubRemoteEditing/
|   |-- Server/                 # Express Server, Static Hosting, Uploads, Sound API
|   |-- src/
|   |   |-- engine/             # Runtime-Logik, Game Loop, MQTT, SQLite
|   |   |-- routes/             # API-Routen
|   |
|   |-- public/                 # Weboberfläche, Editor, Screens, CSS, Vendor-Libs
|   |-- PuzzleTemplates/        # Templates für externe Puzzle-Clients
|   |-- MediaStorage/           # Hochgeladene Mediendateien
|   |-- SoundStorage/           # Hochgeladene Sounds
|   |-- rooms/                  # Raumbezogene Daten
|   |-- escape.db               # SQLite-Datenbank
|
|-- RadioRemoteEditing/         # separate/alte Radio-Puzzle-Codebasis
|-- README.md
```

---

## Systemanforderungen

Der Hub ist für den Betrieb auf einem Raspberry Pi ausgelegt.

Benötigte Komponenten:

* Node.js
* Mosquitto MQTT Broker
* Zigbee2MQTT, falls Zigbee-Sensoren genutzt werden
* OLA / `olad`, falls DMX genutzt wird
* ALSA Audio Tools, z. B. `amixer` und `aplay`
* Optional: `ffplay`, `mpv`, `paplay` oder `mpg123` für Sound-Wiedergabe
* USB-DMX-Adapter, z. B. DMXking ultraDMX Micro
* Zigbee-Dongle, z. B. Sonoff Zigbee 3.0 USB Dongle Plus V2

---

## Anwendung starten

In das Server-Verzeichnis wechseln:

```bash
cd HubRemoteEditing/Server
```

Server starten:

```bash
node server.js
```

Die Weboberfläche ist danach erreichbar unter:

```text
http://escapehub.local
```

oder direkt über die IP-Adresse des Raspberry Pi:

```text
http://<hub-ip>
```

Der Server nutzt standardmässig Port `80`.

---

## Wichtige Systemdienste

EscapeHub arbeitet mit mehreren Linux-Diensten zusammen.

Status prüfen:

```bash
sudo systemctl status md2-hub
sudo systemctl status mosquitto
sudo systemctl status zigbee2mqtt
sudo systemctl status olad
```

Dienste neu starten:

```bash
sudo systemctl restart md2-hub
sudo systemctl restart zigbee2mqtt
sudo systemctl restart olad
```

---

## USB-Zuordnung

Zigbee und DMX sollten nicht direkt über wechselnde Pfade wie `ttyUSB0` oder `ttyUSB1` konfiguriert werden.

Stattdessen werden stabile Symlinks genutzt:

```text
/dev/zigbee
/dev/dmx
```

Beispiel für Zigbee2MQTT:

```yaml
serial:
  port: /dev/zigbee
  adapter: ember
```

Beispiel für OLA:

```ini
enabled = trü
device = /dev/dmx
device_dir = /dev
device_prefix = dmx
ignore_device = /dev/zigbee
```

Damit wird verhindert, dass OLA versehentlich den Zigbee-Dongle blockiert.

---

## Weboberfläche

Die Hauptoberfläche besteht aus mehreren Bereichen:

* **Room Editor**: Puzzle-Graph und Raumstruktur
* **Zigbee / Sensoren**: Sensorliste, letzte Messages und Trigger
* **Sounds**: Upload, Test und Lautstärke pro Sound
* **Room Scripting**: Blockly-Regeln für Raumlogik
* **Puzzle Scripting**: Blockly-Regeln für einzelne Puzzles
* **Lighting / DMX**: Lampen, Presets, cues und Scenes
* **Running Room Screen**: Live-Status, Logs und Puzzle-Zustände
* **System Settings**: Dienste, Screens, Audio, DMX, Zigbee und Autostart

---

## Puzzle-Kommunikation

Externe Rätsel kommunizieren über die mitgelieferten Communication-Agent-Templates mit dem Hub.

Die Templates nutzen intern MQTT. Für die eigentliche Puzzle-Logik stehen einfache HTTP-Aufrufe zur Verfügung.

Typischer Ablauf eines digitalen Puzzles:

1. State vom Hub lesen
2. Auf `reset`, `running` oder `solved` reagieren
3. Outputs oder Custom Valüs setzen
4. Wenn gelöst, State auf `solved` setzen
5. Heartbeat bzw. Status regelmässig oder bei State Changes senden

Templates liegen hier:

```text
HubRemoteEditing/PuzzleTemplates/
|-- Mikrocontroller/
|-- Windows, Linux, Pi/
```

---

## DMX und Lichtsteürung

Das Lighting-System verwaltet Lampen, cues und Scenes.

Unterstützt werden:

* Lampen mit Presets oder Custom-Kanälen
* cues mit DMX-Werten
* cue-Effekte wie Delay, Fade In, Fade Out und Duration
* Scenes mit mehreren cues, parallelen cues und Delays
* Verschachtelte Scenes
* Test cue und Test Scene
* Script-Action `Play Lighting cue`

Wichtig:

```text
duration = 0
```

bedeutet, dass eine cue unendlich lange aktiv bleibt. Sie endet erst, wenn sie durch eine andere cue ersetzt, durch einen Test-Stopp beendet oder beim Schliessen des Raums gestoppt wird.

---

## Sounds

Sounds können im Sounds-Tab hochgeladen und getestet werden.

Eigenschaften:

* Systemlautstärke wird beim Hub-Start auf 100 Prozent gesetzt
* Jeder Sound hat eine eigene Lautstärke im Hub
* Neü Sounds starten standardmässig mit 50 Prozent
* Sounds können über Blockly-Skripte mit `Play Sound cue` abgespielt werden
* Laufende Sounds werden beim Schliessen des Sound-Fensters oder beim Schliessen des Raums beendet

---

## Datenhaltung

Die wichtigsten Projektdaten liegen in SQLite:

```text
HubRemoteEditing/escape.db
```

Wichtige Tabellen:

* `rooms`
* `devices`
* `config`
* `puzzle_solutions`

Uploads liegen dateibasiert in:

```text
HubRemoteEditing/MediaStorage/
HubRemoteEditing/SoundStorage/
HubRemoteEditing/public/uploads/
```

---

## Diagnose und Debugging

Hub-Logs:

```bash
journalctl -u md2-hub -f
```

Zigbee2MQTT:

```bash
journalctl -u zigbee2mqtt -f
mosquitto_sub -h localhost -t 'zigbee2mqtt/#' -v
```

DMX / OLA:

```bash
journalctl -u olad -f
ola_dev_info
ola_set_dmx -u 0 -d 255,0,0,0
```

Audio:

```bash
cat /proc/asound/cards
aplay -L
amixer -c UC02 sget PCM
speaker-test -D plughw:CARD=UC02,DEV=0 -c 2 -t wav -l 1
```

USB-Geräte:

```bash
ls -l /dev/zigbee /dev/dmx
readlink -f /dev/zigbee
readlink -f /dev/dmx
sudo lsof /dev/zigbee /dev/dmx
```

---

## Betriebshinweise

* Zigbee-Dongle möglichst direkt oder per kurzer USB-Verlängerung am Raspberry Pi betreiben.
* DMX und Zigbee immer über `/dev/dmx` und `/dev/zigbee` konfigurieren.
* OLA darf nur den DMX-Adapter scannen.
* Zigbee2MQTT darf exklusiv den Zigbee-Dongle nutzen.
* Systemlautstärke bleibt auf 100 Prozent, Sound-Lautstärke wird im Hub geregelt.
* Nach USB-änderungen immer prüfen, ob die Symlinks korrekt zeigen.

---

## Bekannte Stolperstellen

* Wenn Zigbee2MQTT `Device or resource busy` meldet, blockiert meist ein anderer Dienst den Zigbee-Port.
* Wenn OLA den falschen Port greift, `ola-usbserial.conf` und aktive OLA-Plugins prüfen.
* Wenn DMX nicht sendet, zürst `ola_dev_info` und Universe `0` prüfen.
* Wenn Audio beim ersten Abspielen anders laut ist, Systemmixer und verwendeten Player prüfen.
* Wenn `escapehub.local` nicht funktioniert, direkt die IP-Adresse verwenden.

---

## Kontext

Dieses Projekt wurde für das Media-Design-2-Escape-Room-Projekt entwickelt.

Es ist eine projektspezifische Steürzentrale für Escape-Room-Installationen und nicht als generisches Produktpaket strukturiert.
