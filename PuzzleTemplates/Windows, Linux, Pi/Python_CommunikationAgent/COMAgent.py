"""
Python Communication Agent template for EscapeHub.

This template is intended to be imported by Python puzzle projects such as
pygame games. The structure follows the MCU templates:

- configuration at the top of the file
- direct local API for imported use
- MQTT communication with the hub
- no external config file
- no debug HTTP API

Required packages:
    pip install paho-mqtt requests
"""

from __future__ import annotations

import json
import queue
import socket
import shutil
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import quote

import requests                               
import paho.mqtt.client as mqtt          # python -m pip install pygame paho-mqtt requests


# -------------------------
# Project-specific settings
# -------------------------
#/////////////////////////////////////////////////////////////////////////

HUB_HOST = "HUB_HOST_IP"                  # IP address or hostname of the hub
MQTT_BROKER = HUB_HOST
MQTT_PORT = 1883

DEVICE_ID = "puzzle-python-1"              # used to identify puzzle internally
PUZZLE_NAME = "Python Puzzle"              # used to identify puzzle in hub UI
NEED_RESTART = False
HEARTBEAT_INTERVAL_MS = 2000

MEDIA_SERVER = f"http://{HUB_HOST}"
MEDIA_LOCAL_DIR = "MediaStorage"
MQTT_TOPIC_PREFIX = "puzzle"

#/////////////////////////////////////////////////////////////////////////

# functions that can be called externally

# COMAgent.start()                                 # has to be called once to setup agent
# COMAgent.run()                                   # has to be called in main puzzle loop

# COMAgent.getState()                              # returns state of puzzle as String
# COMAgent.setState("solved")                      # sets ans send state to hub. Possible States: "locked", "running", "solved", "starting", "uploading", "downloading"
# COMAgent.stateChanged()                          # returns true if state has changed since last call, else false

# COMAgent.sendCustom("putStringHere")             # sends custom string to hub   
# COMAgent.getCustom()                             # returns the current custom value as string without deleting it
# COMAgent.customAvailable()                       # returns true if a custom value is currently available
# COMAgent.deleteCustom()                          # deletes the current custom value

# COMAgent.getInput("key")                         # returns the current input as string without deleting it
# COMAgent.inputAvailable("key")                   # returns true if the input currently exists
# COMAgent.deleteInput("key")                      # deletes the current input value for the given key

# COMAgent.setOutput("key", "value")               # sets a string output internally. "key" must fit to the name given to the output in the hub UI.
# COMAgent.sendOutput("key")                       # sends the output with the name "key" etc to the hub   
# COMAgent.sendAllOutput()                         # sends all settet outputs to the hub

# COMAgent.triggerExternalCheck("1234, true)       # triggers the hub external check. can be used to check if the player has solved the puzzle / has got the right password out of it. the last value (true = bool) triggers the check. with false it can be deactivated

# COMAgent.restartComplete()                       # signals to hub that restart is completed (only necassary when need restart is configured)

# COMAgent.setMedia("fileName", "filePath")        # copies file into MEDIA_LOCAL_DIR and assigns it to the media key
# COMAgent.sendMedia("fileName")                   # starts a background media upload to the hub. "fileName" has to fit to Input Media name in hub UI
# COMAgent.getMedia("fileName")                    # returns local path if media is ready, else False
# COMAgent.deleteMedia("fileName")                 # deletes media from local storage                    


#/// dont change anything from here up //////////////////////////////////

class EscapeHubPythonAgent:
    VALID_STATES = {"locked", "starting", "running", "solved", "uploading", "downloading", "active"}
    ALLOWED_TYPES = {"string", "number", "boolean", "media"}

    def __init__(
        self,
        hub_host: str,
        mqtt_broker: str,
        mqtt_port: int,
        device_id: str,
        puzzle_name: str,
        need_restart: bool,
        heartbeat_interval_ms: int,
        media_server: str,
        media_local_dir: str,
        topic_prefix: str = "puzzle",
    ) -> None:
        self.hub_host = hub_host
        self.mqtt_broker = mqtt_broker
        self.mqtt_port = mqtt_port
        self.device_id = device_id
        self.puzzle_name = puzzle_name
        self.need_restart = bool(need_restart)
        self.heartbeat_interval_ms = max(int(heartbeat_interval_ms), 0)
        self.media_server = media_server.rstrip("/")
        self.media_local_dir = Path(media_local_dir)
        self.topic_prefix = topic_prefix

        self.state = "locked"
        self.inputs: Dict[str, Dict[str, Any]] = {}
        self.outputs: Dict[str, Dict[str, Any]] = {}
        self.media_status: Dict[str, Dict[str, Any]] = {}
        self.external_check: Dict[str, Any] = {"active": False, "value": None}
        self._custom_value: Optional[str] = None
        self._state_changed = False
        self._last_heartbeat_at_ms = 0
        self._last_connect_attempt_at_ms = 0
        self._local_ip = self._detect_local_ip()
        self._async_events: "queue.Queue[Dict[str, Any]]" = queue.Queue()
        self._media_lock = threading.Lock()
        self._pending_downloads: set[str] = set()
        self._pending_uploads: set[str] = set()

        self.command_topic = f"{self.topic_prefix}/{self.device_id}/command"
        self.heartbeat_topic = f"{self.topic_prefix}/{self.device_id}/heartbeat"
        self.data_topic = f"{self.topic_prefix}/{self.device_id}/data"
        self.custom_topic = f"{self.topic_prefix}/{self.device_id}/custom"
        self.external_check_topic = f"{self.topic_prefix}/{self.device_id}/external-check"

        self._client = mqtt.Client(client_id=f"agent-{self.device_id}")
        self._client.on_connect = self._on_connect
        self._client.on_message = self._on_message
        self._client.on_disconnect = self._on_disconnect

    # -------------------------
    # Public puzzle API
    # -------------------------
    def begin(self) -> None:
        self.media_local_dir.mkdir(parents=True, exist_ok=True)
        self._connect_if_needed(force=True)
        self.publish_heartbeat_now()

    def run(self) -> None:
        self._connect_if_needed()
        self._client.loop(timeout=0.0)
        self._process_async_events()

        if self.heartbeat_interval_ms <= 0:
            return

        now_ms = self._now_ms()
        if now_ms - self._last_heartbeat_at_ms >= self.heartbeat_interval_ms:
            self.publish_heartbeat_now()
            self._last_heartbeat_at_ms = now_ms

    def getState(self) -> str:
        return self.state

    def setState(self, state: str) -> bool:
        if state not in self.VALID_STATES:
            return False
        self._transition_state(state)
        return True

    def stateChanged(self) -> bool:
        changed = self._state_changed
        self._state_changed = False
        return changed

    def getInput(self, key: str) -> Optional[str]:
        entry = self.inputs.get(key)
        if not entry:
            return None
        data = entry.get("data")
        return self._value_as_string(data)

    def inputAvailable(self, key: str) -> bool:
        entry = self.inputs.get(key)
        return bool(entry and entry.get("present"))

    def deleteInput(self, key: str) -> None:
        entry = self.inputs.get(key)
        if not entry:
            return
        entry["data"] = None
        entry["present"] = False

    def getInputType(self, key: str) -> Optional[str]:
        entry = self.inputs.get(key)
        return entry.get("type") if entry else None

    def setOutput(self, key: str, value: Any) -> bool:
        if key not in self.outputs:
            return False
        self.outputs[key] = {
            "type": "string",
            "data": self._value_as_string(value),
            "present": True,
        }
        return True

    def sendOutput(self, key: str) -> bool:
        return self._publish_output(key)

    def getMedia(self, key: str) -> Any:
        input_entry = self.inputs.get(key)
        if input_entry and self._normalize_type(input_entry.get("type")) == "media":
            status_entry = self.media_status.get(key) or {}
            path_text = status_entry.get("path")
            if path_text:
                local_path = Path(path_text)
                if local_path.exists():
                    self._set_media_status(key, "ready", path=local_path)
                    return str(local_path)
            return False

        output_path = self._find_local_media_by_key(key)
        if output_path is not None and output_path.exists():
            return str(output_path)
        return False

    def setMedia(self, key: str, source_path: str) -> bool:
        if key not in self.outputs:
            return False
        if self._normalize_type(self.outputs[key].get("type")) != "media":
            return False

        source = Path(source_path)
        if not source.is_file():
            return False

        self.media_local_dir.mkdir(parents=True, exist_ok=True)
        target = self.media_local_dir / source.name

        try:
            if source.resolve() != target.resolve():
                shutil.copy2(source, target)
            self.outputs[key] = {"type": "media", "data": key, "present": True}
            self._set_media_status(key, "ready", path=target, error=None)
            return True
        except Exception:
            return False

    def sendMedia(self, key: str) -> bool:
        if key not in self.outputs:
            return False
        if self._normalize_type(self.outputs[key].get("type")) != "media":
            return False

        local_path = self._find_local_media_by_key(key)
        if local_path is None or not local_path.exists():
            return False
        self.outputs[key] = {"type": "media", "data": key, "present": True}
        return self._schedule_media_upload(key, local_path, publish_output_after=True)

    def deleteMedia(self, key: str) -> bool:
        path = self._find_local_media_by_key(key)
        if path is None or not path.exists():
            return False
        path.unlink()
        if key in self.outputs and self._normalize_type(self.outputs[key].get("type")) == "media":
            self.outputs[key] = {"type": "media", "data": None, "present": False}
        self._set_media_status(key, "idle", path=None, error=None)
        return True

    def sendAllOutputs(self) -> None:
        for key in list(self.outputs.keys()):
            self._publish_output(key)

    def sendCustom(self, value: Any) -> bool:
        self._custom_value = self._value_as_string(value)
        payload = {"value": self._custom_value, "deviceId": self.device_id}
        return self._publish_json(self.custom_topic, payload)

    def getCustom(self) -> Optional[str]:
        return self._custom_value

    def customAvailable(self) -> bool:
        return self._custom_value is not None

    def deleteCustom(self) -> None:
        self._custom_value = None

    def triggerExternalCheck(self, value: Any, active: bool = True) -> bool:
        value_text = self._value_as_string(value)
        self.external_check = {"active": bool(active), "value": value_text}
        payload = {
            "active": bool(active),
            "variable": value_text,
            "deviceId": self.device_id,
        }
        return self._publish_json(self.external_check_topic, payload)

    def restartComplete(self) -> None:
        if self.state == "starting":
            self._set_state_internal("running")
            self.publish_heartbeat_now()

    def publish_heartbeat_now(self) -> bool:
        payload = {
            "name": self.puzzle_name,
            "state": self.state,
            "deviceId": self.device_id,
            "ip": self._local_ip,
        }
        return self._publish_json(self.heartbeat_topic, payload)

    # -------------------------
    # MQTT callbacks
    # -------------------------
    def _on_connect(self, client: mqtt.Client, userdata: Any, flags: Dict[str, Any], rc: int) -> None:
        if rc == 0:
            client.subscribe(self.command_topic)
            self.publish_heartbeat_now()

    def _on_disconnect(self, client: mqtt.Client, userdata: Any, rc: int) -> None:
        # Reconnect is handled in run() to keep flow explicit and MCU-like.
        pass

    def _on_message(self, client: mqtt.Client, userdata: Any, message: mqtt.MQTTMessage) -> None:
        try:
            payload = json.loads(message.payload.decode("utf-8"))
        except Exception:
            return
        self._handle_command(payload)

    # -------------------------
    # Internal command handling
    # -------------------------
    def _handle_command(self, payload: Dict[str, Any]) -> None:
        action = str(payload.get("action") or "")
        if not action:
            return

        publish_heartbeat_after = False

        if action == "initKeys":
            self._apply_init_keys(payload)
            publish_heartbeat_after = True

        elif action == "clearData":
            self._clear_data()
            publish_heartbeat_after = True

        elif action == "restart":
            self._handle_restart_command()
            return

        elif action == "setState":
            incoming = payload.get("state")
            if incoming:
                self._transition_state(str(incoming))
                return

        elif action == "sendParam":
            key = payload.get("key") or payload.get("type")
            if key:
                self._set_input_value(str(key), payload.get("type") or "string", payload.get("data"))
                publish_heartbeat_after = True

        elif action == "requestData":
            key = payload.get("key") or payload.get("type")
            if key:
                self._publish_output(str(key))
            else:
                self.sendAllOutputs()
            publish_heartbeat_after = True

        elif action == "sendOutput":
            key = payload.get("key") or payload.get("type")
            if key and self._set_output_value_from_command(str(key), payload.get("type") or "string", payload.get("data")):
                self._publish_output(str(key))
            publish_heartbeat_after = True

        elif action in {"sendCustom", "custom", "custom_event", "custom-event"}:
            custom_value = payload.get("value", payload.get("data", payload.get("text", payload.get("custom"))))
            self._custom_value = self._value_as_string(custom_value)
            self._set_input_value("custom", "string", self._custom_value)
            publish_heartbeat_after = True

        if publish_heartbeat_after:
            self.publish_heartbeat_now()

    # -------------------------
    # State / media transitions
    # -------------------------
    def _handle_restart_command(self) -> None:
        if self.need_restart:
            self._set_state_internal("starting")
            self.publish_heartbeat_now()
        else:
            self._set_state_internal("running")
            self.publish_heartbeat_now()

    def _transition_state(self, new_state: str) -> None:
        desired = "running" if new_state == "active" else new_state

        if desired == "starting":
            self._set_state_internal("starting")
            self.publish_heartbeat_now()
            return

        if desired == "running":
            self._set_state_internal("running")
            self.publish_heartbeat_now()
            return

        if desired == "solved":
            self._set_state_internal("solved")
            self.publish_heartbeat_now()
            self.sendAllOutputs()
            return

        if desired in {"locked", "uploading", "downloading"}:
            self._set_state_internal(desired)
            self.publish_heartbeat_now()
            return

    def _schedule_media_download(self, key: str, reference_name: str) -> bool:
        with self._media_lock:
            if key in self._pending_downloads:
                return True
            self._pending_downloads.add(key)
        self._set_media_status(key, "downloading", error=None)
        thread = threading.Thread(
            target=self._download_media_worker,
            args=(key, reference_name),
            daemon=True,
        )
        thread.start()
        return True

    def _schedule_media_upload(self, key: str, local_path: Path, publish_output_after: bool) -> bool:
        with self._media_lock:
            if key in self._pending_uploads:
                return True
            self._pending_uploads.add(key)
        self._set_media_status(key, "uploading", path=local_path, error=None)
        thread = threading.Thread(
            target=self._upload_media_worker,
            args=(key, Path(local_path), publish_output_after),
            daemon=True,
        )
        thread.start()
        return True

    def _download_media_worker(self, key: str, reference_name: str) -> None:
        try:
            resolved_name = self._resolve_remote_media_name(reference_name)
            local_path = self.media_local_dir / resolved_name
            if not local_path.exists():
                self._download_media_file(resolved_name, local_path)
            self._async_events.put({
                "kind": "media-download-complete",
                "key": key,
                "path": str(local_path),
            })
        except Exception as exc:
            self._async_events.put({
                "kind": "media-download-error",
                "key": key,
                "error": str(exc),
            })

    def _upload_media_worker(self, key: str, local_path: Path, publish_output_after: bool) -> None:
        try:
            self._upload_media_file(local_path, local_path.name)
            self._async_events.put({
                "kind": "media-upload-complete",
                "key": key,
                "path": str(local_path),
                "publish_output_after": bool(publish_output_after),
            })
        except Exception as exc:
            self._async_events.put({
                "kind": "media-upload-error",
                "key": key,
                "error": str(exc),
                "publish_output_after": bool(publish_output_after),
            })

    def _process_async_events(self) -> None:
        while True:
            try:
                event = self._async_events.get_nowait()
            except queue.Empty:
                break
            self._handle_async_event(event)

    def _handle_async_event(self, event: Dict[str, Any]) -> None:
        kind = str(event.get("kind") or "")
        key = str(event.get("key") or "")
        if not kind or not key:
            return

        if kind == "media-download-complete":
            with self._media_lock:
                self._pending_downloads.discard(key)
            self._set_media_status(key, "ready", path=event.get("path"), error=None)
            return

        if kind == "media-download-error":
            with self._media_lock:
                self._pending_downloads.discard(key)
            self._set_media_status(key, "error", error=event.get("error"))
            return

        if kind == "media-upload-complete":
            with self._media_lock:
                self._pending_uploads.discard(key)
            self._set_media_status(key, "ready", path=event.get("path"), error=None)
            if event.get("publish_output_after"):
                self._publish_output(key)
            return

        if kind == "media-upload-error":
            with self._media_lock:
                self._pending_uploads.discard(key)
            self._set_media_status(key, "error", error=event.get("error"))

    def _set_media_status(
        self,
        key: str,
        state: str,
        path: Optional[Any] = None,
        error: Optional[Any] = None,
    ) -> None:
        entry = self.media_status.get(key, {})
        entry["state"] = state
        if path is not None:
            entry["path"] = str(path)
        elif state == "idle":
            entry["path"] = None
        if error is not None or state != "error":
            entry["error"] = None if error is None else str(error)
        self.media_status[key] = entry

    # -------------------------
    # Media transport
    # -------------------------
    def _resolve_remote_media_name(self, base_name: str) -> str:
        url = f"{self.media_server}/api/media/resolve"
        response = requests.get(url, params={"name": base_name}, timeout=15)
        response.raise_for_status()
        payload = response.json()
        return payload["name"]

    def _upload_media_file(self, local_path: Path, remote_name: str) -> Dict[str, Any]:
        url = f"{self.media_server}/api/media/upload"
        with local_path.open("rb") as handle:
            response = requests.post(
                url,
                params={"name": remote_name},
                data=handle,
                headers={"Content-Type": "application/octet-stream"},
                timeout=60,
            )
        response.raise_for_status()
        return response.json()

    def _download_media_file(self, remote_name: str, local_path: Path) -> Path:
        url = f"{self.media_server}/media/{quote(remote_name)}"
        response = requests.get(url, timeout=60, stream=True)
        response.raise_for_status()

        local_path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = local_path.with_suffix(local_path.suffix + ".download")
        with temp_path.open("wb") as handle:
            for chunk in response.iter_content(chunk_size=65536):
                if chunk:
                    handle.write(chunk)
        temp_path.replace(local_path)
        return local_path

    def _find_local_media_by_key(self, base_name: str) -> Optional[Path]:
        if not self.media_local_dir.exists():
            return None
        for path in self.media_local_dir.iterdir():
            if path.is_file() and path.stem == base_name:
                return path
        return None

    # -------------------------
    # Data handling
    # -------------------------
    def _apply_init_keys(self, payload: Dict[str, Any]) -> None:
        old_outputs = dict(self.outputs)

        self.inputs = {}
        for item in payload.get("inputs", []) or []:
            key = str(item.get("key") or item.get("type") or "")
            if not key:
                continue
            entry_type = self._normalize_type(str(item.get("type") or "string"))
            self.inputs[key] = {"type": entry_type, "data": None, "present": False}

        self.outputs = {}
        for item in payload.get("outputs", []) or []:
            key = str(item.get("key") or item.get("type") or "")
            if not key:
                continue
            entry_type = self._normalize_type(str(item.get("type") or "string"))
            old_entry = old_outputs.get(key, {})
            self.outputs[key] = {
                "type": entry_type,
                "data": old_entry.get("data"),
                "present": bool(old_entry.get("present")),
            }

    def _clear_data(self) -> None:
        for entry in self.inputs.values():
            entry["data"] = None
            entry["present"] = False
        for entry in self.outputs.values():
            entry["data"] = None
            entry["present"] = False
        self.media_status = {}
        self._custom_value = None
        self.external_check = {"active": False, "value": None}

    def _set_input_value(self, key: str, value_type: str, data: Any) -> None:
        if key not in self.inputs:
            return
        normalized_type = self._normalize_type(value_type)
        self.inputs[key] = {
            "type": normalized_type,
            "data": self._coerce_type(normalized_type, data),
            "present": data is not None,
        }
        if normalized_type == "media" and data:
            self._schedule_media_download(key, self._value_as_string(data) or str(data))

    def _set_output_value_from_command(self, key: str, value_type: str, data: Any) -> bool:
        if key not in self.outputs:
            return False

        normalized_type = self._normalize_type(value_type or self.outputs[key].get("type"))
        if normalized_type == "media":
            self.outputs[key] = {"type": normalized_type, "data": key, "present": True}
            return True

        self.outputs[key] = {
            "type": normalized_type,
            "data": self._coerce_type(normalized_type, data),
            "present": data is not None,
        }
        return True

    def _publish_output(self, key: str) -> bool:
        entry = self.outputs.get(key)
        if not entry:
            return False

        payload_data = key if entry.get("type") == "media" else entry.get("data")
        payload = {
            "key": key,
            "type": entry.get("type", "string"),
            "data": payload_data,
            "deviceId": self.device_id,
        }
        return self._publish_json(self.data_topic, payload)

    # -------------------------
    # Utilities
    # -------------------------
    def _normalize_type(self, value_type: str) -> str:
        normalized = str(value_type or "string").lower()
        return normalized if normalized in self.ALLOWED_TYPES else "string"

    def _coerce_type(self, value_type: str, value: Any) -> Any:
        normalized = self._normalize_type(value_type)
        if value is None:
            return None
        if normalized == "number":
            try:
                if isinstance(value, (int, float)):
                    return value
                text = str(value)
                return float(text) if any(ch in text for ch in ".eE") else int(text)
            except Exception:
                return value
        if normalized == "boolean":
            if isinstance(value, bool):
                return value
            text = str(value).strip().lower()
            if text in {"true", "1", "yes"}:
                return True
            if text in {"false", "0", "no"}:
                return False
        return value

    def _set_state_internal(self, state: str) -> bool:
        if state not in self.VALID_STATES:
            return False
        normalized = "running" if state == "active" else state
        changed = self.state != normalized
        self.state = normalized
        if changed:
            self._state_changed = True
        return True

    def _publish_json(self, topic: str, payload: Dict[str, Any]) -> bool:
        self._connect_if_needed()
        if not self._client.is_connected():
            return False
        result = self._client.publish(topic, json.dumps(payload))
        return result.rc == mqtt.MQTT_ERR_SUCCESS

    def _connect_if_needed(self, force: bool = False) -> None:
        if self._client.is_connected():
            return

        now_ms = self._now_ms()
        if not force and now_ms - self._last_connect_attempt_at_ms < 1000:
            return

        self._last_connect_attempt_at_ms = now_ms
        try:
            self._client.connect(self.mqtt_broker, self.mqtt_port, keepalive=30)
        except Exception:
            pass

    def _detect_local_ip(self) -> str:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
                probe.connect((self.hub_host, 80))
                return probe.getsockname()[0]
        except Exception:
            return "0.0.0.0"

    @staticmethod
    def _value_as_string(value: Any) -> Optional[str]:
        if value is None:
            return None
        if isinstance(value, bool):
            return "true" if value else "false"
        return str(value)

    @staticmethod
    def _now_ms() -> int:
        return int(time.monotonic() * 1000)


agent = EscapeHubPythonAgent(
    hub_host=HUB_HOST,
    mqtt_broker=MQTT_BROKER,
    mqtt_port=MQTT_PORT,
    device_id=DEVICE_ID,
    puzzle_name=PUZZLE_NAME,
    need_restart=NEED_RESTART,
    heartbeat_interval_ms=HEARTBEAT_INTERVAL_MS,
    media_server=MEDIA_SERVER,
    media_local_dir=MEDIA_LOCAL_DIR,
    topic_prefix=MQTT_TOPIC_PREFIX,
)


def getState() -> str:
    return agent.getState()


def setState(state: str) -> bool:
    return agent.setState(state)


def stateChanged() -> bool:
    return agent.stateChanged()


def getInput(key: str) -> Optional[str]:
    return agent.getInput(key)


def inputAvailable(key: str) -> bool:
    return agent.inputAvailable(key)


def deleteInput(key: str) -> None:
    agent.deleteInput(key)


def getInputType(key: str) -> Optional[str]:
    return agent.getInputType(key)


def setOutput(key: str, value: Any) -> bool:
    return agent.setOutput(key, value)


def sendOutput(key: str) -> bool:
    return agent.sendOutput(key)


def getMedia(key: str) -> Any:
    return agent.getMedia(key)


def setMedia(key: str, source_path: str) -> bool:
    return agent.setMedia(key, source_path)


def sendMedia(key: str) -> bool:
    return agent.sendMedia(key)


def deleteMedia(key: str) -> bool:
    return agent.deleteMedia(key)


def sendAllOutputs() -> None:
    agent.sendAllOutputs()


def sendCustom(value: Any) -> bool:
    return agent.sendCustom(value)


def getCustom() -> Optional[str]:
    return agent.getCustom()


def customAvailable() -> bool:
    return agent.customAvailable()


def deleteCustom() -> None:
    agent.deleteCustom()


def triggerExternalCheck(value: Any, active: bool = True) -> bool:
    return agent.triggerExternalCheck(value, active)


def restartComplete() -> None:
    agent.restartComplete()


def publish_heartbeat_now() -> bool:
    return agent.publish_heartbeat_now()


def resolveMedia(name: str) -> str:
    return agent._resolve_remote_media_name(name)


def downloadMedia(remote_name: str, local_path: Optional[str] = None) -> str:
    resolved_name = agent._resolve_remote_media_name(remote_name)
    target_path = Path(local_path) if local_path else (agent.media_local_dir / resolved_name)
    return str(agent._download_media_file(resolved_name, target_path))


def uploadMedia(local_path: str, remote_name: Optional[str] = None) -> Dict[str, Any]:
    source_path = Path(local_path)
    final_remote_name = remote_name or source_path.name
    return agent._upload_media_file(source_path, final_remote_name)


def run() -> None:
    agent.run()


def start() -> None:
    agent.begin()


if __name__ == "__main__":
    print("This module is intended to be imported by your puzzle script.")
    print("Call start() once and run() repeatedly from your own program.")
