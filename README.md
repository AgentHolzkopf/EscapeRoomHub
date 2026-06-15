# EscapeHub - Escape Room Control System

EscapeHub ist eine **lokale Web-Anwendung** zur Steuerung und Verwaltung von **Escape-Room-Raeumen, Raetseln, Sensoren, Licht, Sounds und Screens**.

Das System laeuft typischerweise auf einem **Raspberry Pi** und verbindet mehrere Komponenten: digitale Puzzle-Clients, Zigbee-Sensoren, DMX-Lampen, Sound-Ausgabe, Player-Screens und eine visuelle Scripting-Oberflaeche.

---

## Kurzueberblick

EscapeHub bietet eine zentrale Oberflaeche, um einen Escape Room zu konfigurieren, zu starten und live zu ueberwachen.

Unterstuetzt werden unter anderem:

* Raum- und Branch-Verwaltung
* Visueller Puzzle-Graph
* Blockly-Scripting fuer Room- und Puzzle-Logik
* Zigbee2MQTT Sensorintegration
* DMX/OLA Lichtsteuerung
* Sound-Cues mit Upload und Lautstaerkeregelung
* Hint-, Player- und Progress-Screens
* Kommunikation mit externen Puzzle-Clients ueber MQTT und HTTP
* System-Settings fuer Dienste, USB-Geraete und Screens

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
|   |-- public/                 # Weboberflaeche, Editor, Screens, CSS, Vendor-Libs
|   |-- PuzzleTemplates/        # Templates fuer externe Puzzle-Clients
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

Der Hub ist fuer den Betrieb auf einem Raspberry Pi ausgelegt.

Benoetigte Komponenten:

* Node.js
* Mosquitto MQTT Broker
* Zigbee2MQTT, falls Zigbee-Sensoren genutzt werden
* OLA / `olad`, falls DMX genutzt wird
* ALSA Audio Tools, z. B. `amixer` und `aplay`
* Optional: `ffplay`, `mpv`, `paplay` oder `mpg123` fuer Sound-Wiedergabe
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

Die Weboberflaeche ist danach erreichbar unter:

```text
http://escapehub.local
```

oder direkt ueber die IP-Adresse des Raspberry Pi:

```text
http://<hub-ip>
```

Der Server nutzt standardmaessig Port `80`.

---

## Wichtige Systemdienste

EscapeHub arbeitet mit mehreren Linux-Diensten zusammen.

Status pruefen:

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

Zigbee und DMX sollten nicht direkt ueber wechselnde Pfade wie `ttyUSB0` oder `ttyUSB1` konfiguriert werden.

Stattdessen werden stabile Symlinks genutzt:

```text
/dev/zigbee
/dev/dmx
```

Beispiel fuer Zigbee2MQTT:

```yaml
serial:
  port: /dev/zigbee
  adapter: ember
```

Beispiel fuer OLA:

```ini
enabled = true
device = /dev/dmx
device_dir = /dev
device_prefix = dmx
ignore_device = /dev/zigbee
```

Damit wird verhindert, dass OLA versehentlich den Zigbee-Dongle blockiert.

---

## Weboberflaeche

Die Hauptoberflaeche besteht aus mehreren Bereichen:

* **Room Editor**: Puzzle-Graph und Raumstruktur
* **Zigbee / Sensoren**: Sensorliste, letzte Messages und Trigger
* **Sounds**: Upload, Test und Lautstaerke pro Sound
* **Room Scripting**: Blockly-Regeln fuer Raumlogik
* **Puzzle Scripting**: Blockly-Regeln fuer einzelne Puzzles
* **Lighting / DMX**: Lampen, Presets, Cues und Scenes
* **Running Room Screen**: Live-Status, Logs und Puzzle-Zustaende
* **System Settings**: Dienste, Screens, Audio, DMX, Zigbee und Autostart

---

## Puzzle-Kommunikation

Externe Raetsel kommunizieren ueber die mitgelieferten Communication-Agent-Templates mit dem Hub.

Die Templates nutzen intern MQTT. Fuer die eigentliche Puzzle-Logik stehen einfache HTTP-Aufrufe zur Verfuegung.

Typischer Ablauf eines digitalen Puzzles:

1. State vom Hub lesen
2. Auf `reset`, `running` oder `solved` reagieren
3. Outputs oder Custom Values setzen
4. Wenn geloest, State auf `solved` setzen
5. Heartbeat bzw. Status regelmaessig oder bei State Changes senden

Templates liegen hier:

```text
HubRemoteEditing/PuzzleTemplates/
|-- Mikrocontroller/
|-- Windows, Linux, Pi/
```

---

## DMX und Lichtsteuerung

Das Lighting-System verwaltet Lampen, Cues und Scenes.

Unterstuetzt werden:

* Lampen mit Presets oder Custom-Kanaelen
* Cues mit DMX-Werten
* Cue-Effekte wie Delay, Fade In, Fade Out und Duration
* Scenes mit mehreren Cues, parallelen Cues und Delays
* Verschachtelte Scenes
* Test Cue und Test Scene
* Script-Action `Play Lighting Cue`

Wichtig:

```text
duration = 0
```

bedeutet, dass eine Cue unendlich lange aktiv bleibt. Sie endet erst, wenn sie durch eine andere Cue ersetzt, durch einen Test-Stopp beendet oder beim Schliessen des Raums gestoppt wird.

---

## Sounds

Sounds koennen im Sounds-Tab hochgeladen und getestet werden.

Eigenschaften:

* Systemlautstaerke wird beim Hub-Start auf 100 Prozent gesetzt
* Jeder Sound hat eine eigene Lautstaerke im Hub
* Neue Sounds starten standardmaessig mit 50 Prozent
* Sounds koennen ueber Blockly-Skripte mit `Play Sound Cue` abgespielt werden
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

USB-Geraete:

```bash
ls -l /dev/zigbee /dev/dmx
readlink -f /dev/zigbee
readlink -f /dev/dmx
sudo lsof /dev/zigbee /dev/dmx
```

---

## Betriebshinweise

* Zigbee-Dongle moeglichst direkt oder per kurzer USB-Verlaengerung am Raspberry Pi betreiben.
* DMX und Zigbee immer ueber `/dev/dmx` und `/dev/zigbee` konfigurieren.
* OLA darf nur den DMX-Adapter scannen.
* Zigbee2MQTT darf exklusiv den Zigbee-Dongle nutzen.
* Systemlautstaerke bleibt auf 100 Prozent, Sound-Lautstaerke wird im Hub geregelt.
* Nach USB-Aenderungen immer pruefen, ob die Symlinks korrekt zeigen.

---

## Bekannte Stolperstellen

* Wenn Zigbee2MQTT `Device or resource busy` meldet, blockiert meist ein anderer Dienst den Zigbee-Port.
* Wenn OLA den falschen Port greift, `ola-usbserial.conf` und aktive OLA-Plugins pruefen.
* Wenn DMX nicht sendet, zuerst `ola_dev_info` und Universe `0` pruefen.
* Wenn Audio beim ersten Abspielen anders laut ist, Systemmixer und verwendeten Player pruefen.
* Wenn `escapehub.local` nicht funktioniert, direkt die IP-Adresse verwenden.

---

## Kontext

Dieses Projekt wurde fuer das Media-Design-2-Escape-Room-Projekt entwickelt.

Es ist eine projektspezifische Steuerzentrale fuer Escape-Room-Installationen und nicht als generisches Produktpaket strukturiert.
