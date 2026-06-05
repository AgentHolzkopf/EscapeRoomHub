# EscapeHub / MD2-ProjektB

EscapeHub ist eine webbasierte Steuerzentrale fuer Escape-Room-Raeume und digitale/analoge Raetsel. Der Hub verwaltet Raeume, Branches, Puzzle-Status, Sensoren, Licht/DMX, Sounds, Screens, Hinweise und die Kommunikation mit externen Raetsel-Clients.

## Features

- Raumverwaltung mit mehreren gespeicherten Rooms
- Visueller Puzzle-Graph auf Basis von LiteGraph
- Blockly-Scripting fuer Room- und Puzzle-Logik
- Puzzle-Kommunikation ueber MQTT und HTTP-Template-API
- Zigbee2MQTT-Integration fuer Sensoren und Buttons
- DMX/OLA-Integration fuer Lampen, Cues und Scenes
- Sound-Verwaltung mit Upload, Test und Script-Triggern
- Screen-System fuer Player-, Hint- und Progress-Screens
- Medien-Upload fuer Puzzle-Dateien
- System-Settings fuer DMX, Zigbee, Audio, Screensaver, Autostart und Media Server

## Projektstruktur

```text
MD2-ProjektB/
├─ HubRemoteEditing/
│  ├─ Server/                 # Express-Server, Static Hosting, Uploads, Sound-API
│  ├─ src/
│  │  ├─ engine/              # Runtime-Logik, Game Loop, MQTT, SQLite
│  │  └─ routes/              # API-Routen
│  ├─ public/                 # Weboberflaeche, Editor, Screens, CSS, Vendor-Libs
│  ├─ PuzzleTemplates/        # Templates fuer externe Puzzle-Clients
│  ├─ MediaStorage/           # Hochgeladene Mediendateien
│  ├─ SoundStorage/           # Hochgeladene Sounds
│  ├─ rooms/                  # Raumbezogene Daten/Assets
│  └─ escape.db               # SQLite-Datenbank
├─ RadioRemoteEditing/        # separate/alte Radio-Puzzle-Codebasis
└─ README.md
Voraussetzungen
Auf dem Hub-System, typischerweise Raspberry Pi:

Node.js
npm oder pnpm
Mosquitto MQTT Broker
Zigbee2MQTT, falls Zigbee genutzt wird
OLA (olad), falls DMX genutzt wird
ALSA/Audio-Tools (amixer, optional ffplay, mpv, paplay, mpg123, aplay)
USB-Geraete mit stabilen udev-Symlinks, z. B. /dev/zigbee und /dev/dmx
Start
Im Hub-Verzeichnis:

cd HubRemoteEditing/Server
node server.js
Der Server laeuft standardmaessig auf Port 80.

Im Browser:

http://escapehub.local
oder direkt per IP:

http://<hub-ip>
Wichtige Dienste
Der Hub arbeitet mit externen Systemdiensten zusammen:

sudo systemctl status md2-hub
sudo systemctl status mosquitto
sudo systemctl status zigbee2mqtt
sudo systemctl status olad
Typische Neustarts:

sudo systemctl restart md2-hub
sudo systemctl restart zigbee2mqtt
sudo systemctl restart olad
USB-Zuordnung
Zigbee und DMX sollten nicht ueber wechselnde ttyUSB0/ttyUSB1-Pfade konfiguriert werden. Stattdessen werden stabile Symlinks verwendet:

/dev/zigbee -> jeweiliger Zigbee-Dongle
/dev/dmx    -> jeweiliger DMX-Adapter
Zigbee2MQTT nutzt:

serial:
  port: /dev/zigbee
  adapter: ember
OLA nutzt fuer DMX:

enabled = true
device = /dev/dmx
device_dir = /dev
device_prefix = dmx
ignore_device = /dev/zigbee
Dadurch wird verhindert, dass OLA versehentlich den Zigbee-Dongle blockiert.

Weboberflaeche
Die Hauptoberflaeche besteht aus mehreren Arbeitsbereichen:

Room Editor: Puzzle-Graph und Raumstruktur
Zigbee / Sensoren: Sensorliste, letzte Messages, Trigger-Konfiguration
Sounds: Sound-Upload, Umbenennen, Lautstaerke, Test
Room Scripting: Blockly-Regeln fuer Raumereignisse
Puzzle Scripting: Blockly-Regeln fuer einzelne Puzzles
Lighting / DMX: Lampen, Presets, Cues, Scenes und Effekte
Running Room Screen: Laufender Raumstatus, Logs, Puzzle-Zustaende
System Settings: Dienste, Screens, Autostart, Audio/DMX/Zigbee-Status
Puzzle-Kommunikation
Externe Raetsel kommunizieren ueber das bereitgestellte Communication-Agent-Template mit dem Hub.

Das Template nutzt intern MQTT fuer die laufende Kommunikation. Die Raetsel-Logik kann aber ueber einfache HTTP-Aufrufe mit dem lokalen Agent sprechen.

Typischer Ablauf eines digitalen Puzzles:

State vom Hub lesen
Auf reset, running, solved reagieren
Outputs oder Custom Values setzen
Bei geloestem Puzzle State auf solved setzen
Regelmaessig bzw. bei State Changes Heartbeat/Status senden
Templates liegen in:

HubRemoteEditing/PuzzleTemplates/
├─ Mikrocontroller/
└─ Windows, Linux, Pi/
DMX und Lighting
Das Lighting-System verwaltet:

Lampen mit Presets oder Custom-Kanaelen
Cues mit DMX-Werten und Effekten
Scenes als Matrix aus Cues, parallelen Cues, Delays und verschachtelten Scenes
Test Cue und Test Scene
Script-Action Play Lighting Cue
Cue-Effekte:

Delay
Fade In
Fade Out
Duration
Wichtig: duration = 0 bedeutet unendliche Dauer. Die Cue bleibt aktiv, bis sie durch eine andere Cue, einen Test-Stopp oder Room-Close beendet wird.

Sounds
Sounds werden im Sounds-Tab hochgeladen und koennen per Test-Button oder Script-Action Play Sound Cue abgespielt werden.

Systemlautstaerke wird beim Hub-Start auf 100 Prozent gesetzt
Pro-Sound-Lautstaerke wird ueber den Slider gesteuert
Neue Sounds starten standardmaessig mit 50 Prozent
Beim Schliessen des Sounds-Fensters oder beim Schliessen des Raums wird laufendes Audio gestoppt
Datenhaltung
Die wichtigsten Daten liegen in SQLite:

HubRemoteEditing/escape.db
Tabellen:

rooms
devices
config
puzzle_solutions
Uploads liegen dateibasiert in:

HubRemoteEditing/MediaStorage/
HubRemoteEditing/SoundStorage/
HubRemoteEditing/public/uploads/
Debugging
Systemlogs im Hub:

journalctl -u md2-hub -f
Zigbee2MQTT:

journalctl -u zigbee2mqtt -f
mosquitto_sub -h localhost -t 'zigbee2mqtt/#' -v
DMX/OLA:

journalctl -u olad -f
ola_dev_info
ola_set_dmx -u 0 -d 255,0,0,0
Audio:

cat /proc/asound/cards
aplay -L
amixer -c UC02 sget PCM
speaker-test -D plughw:CARD=UC02,DEV=0 -c 2 -t wav -l 1
USB-Zuordnung:

ls -l /dev/zigbee /dev/dmx
readlink -f /dev/zigbee
readlink -f /dev/dmx
sudo lsof /dev/zigbee /dev/dmx
Betriebshinweise
Zigbee-Dongle moeglichst direkt oder per kurzer USB-Verlaengerung am Pi betreiben
DMX und Zigbee immer ueber /dev/dmx und /dev/zigbee konfigurieren
OLA darf nur den DMX-Adapter scannen
Zigbee2MQTT darf exklusiv den Zigbee-Dongle nutzen
Systemlautstaerke bleibt auf 100 Prozent, Sound-Lautstaerke wird im Hub pro Sound geregelt
Nach USB-Aenderungen immer pruefen, ob Symlinks korrekt zeigen
Bekannte Stolperstellen
Wenn Zigbee2MQTT Device or resource busy meldet, blockiert meist ein anderer Dienst den Zigbee-Port.
Wenn OLA den falschen Port greift, ola-usbserial.conf und aktive Plugins pruefen.
Wenn DMX nicht sendet, zuerst ola_dev_info und Patch auf Universe 0 pruefen.
Wenn Audio beim ersten Abspielen anders laut ist, Systemmixer und verwendeten Player pruefen.
Wenn escapehub.local nicht funktioniert, direkt die IP-Adresse verwenden.
Kontext
Dieses Projekt wurde fuer das Media-Design-2-Escape-Room-Projekt entwickelt. Es ist eine projektspezifische Steuerzentrale und nicht als generisches Produktpaket strukturiert.
