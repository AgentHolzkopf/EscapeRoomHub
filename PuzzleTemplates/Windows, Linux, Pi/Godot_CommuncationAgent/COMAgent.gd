extends Node

# -------------------------
# Project-specific settings
# -------------------------
# Configure these values for your puzzle.

var HUB_HOST := "HUB_HOST_IP"
var MQTT_BROKER := HUB_HOST
var MQTT_PORT := 1883
var DEVICE_ID := "godot-puzzle-1"
var PUZZLE_NAME := "Godot Puzzle"
var NEED_RESTART := false
var HEARTBEAT_INTERVAL_MS := 2000

var MEDIA_SERVER := ""
var MEDIA_LOCAL_DIR := "user://MediaStorage"
var MQTT_TOPIC_PREFIX := "puzzle"

# functions that can be called externally

# COMAgent.start()                             # has to be called once to setup agent
# COMAgent.run()                               # optional manual tick, not required when used as autoload
# COMAgent.stop()                              # disconnects MQTT client
#
# COMAgent.getState()                          # returns state of puzzle as String
# COMAgent.setState("solved")                  # sets and sends state to hub. Possible States: "locked", "running", "solved", "starting"
# COMAgent.stateChanged()                      # returns true if state has changed since last call, else false
#
# COMAgent.sendCustom("putStringHere")         # sends custom string to hub
# COMAgent.getCustom()                         # returns the current custom value as string without deleting it
# COMAgent.customAvailable()                   # returns true if a custom value is currently available
# COMAgent.deleteCustom()                      # deletes the current custom value
#
# COMAgent.getInput("key")                     # returns the current input as string without deleting it
# COMAgent.inputAvailable("key")               # returns true if the input currently exists
# COMAgent.deleteInput("key")                  # deletes the current input value for the given key
# COMAgent.getInputType("key")                 # returns "string" or "media"
#
# COMAgent.setOutput("key", "value")          # sets a string output internally. "key" must fit to the name given to the output in the hub UI.
# COMAgent.sendOutput("key")                   # sends the output with the name "key" to the hub
# COMAgent.sendAllOutputs()                    # sends all set outputs to the hub
#
# COMAgent.triggerExternalCheck("1234", true)  # triggers the hub external check. The last value activates/deactivates the check.
# COMAgent.restartComplete()                   # signals to hub that restart is completed (only necessary when need restart is configured)
#
# COMAgent.setMedia("fileName", "filePath")    # copies file into MEDIA_LOCAL_DIR and assigns it to the media key
# COMAgent.sendMedia("fileName")               # uploads the local media file and then sends the media output to the hub
# COMAgent.getMedia("fileName")                # returns local path if media is ready, else empty string
# COMAgent.deleteMedia("fileName")             # deletes media from local storage

const VALID_STATES := ["locked", "starting", "running", "solved"]
const TYPE_STRING := "string"
const TYPE_MEDIA := "media"

class DataEntry:
	var type := TYPE_STRING
	var data = ""
	var present := false

	func _init(entry_type := TYPE_STRING, entry_data = "", entry_present := false):
		type = entry_type
		data = entry_data
		present = entry_present

	static func empty(entry_type := TYPE_STRING) -> DataEntry:
		return DataEntry.new(entry_type, "", false)

var _mqtt_client = null
var _started := false
var _connected := false
var _pending_messages: Array = []
var _inputs := {}
var _outputs := {}
var _media_paths := {}
var _pending_media_downloads := {}
var _pending_media_uploads := {}
var _last_heartbeat_ms := 0
var _last_connect_attempt_ms := 0
var _state := "locked"
var _last_state := "locked"
var _last_custom_value := ""
var _http_requests := {}

func _ready() -> void:
	set_process(true)

func _process(_delta: float) -> void:
	if not _started:
		return
	_tick()

func start() -> void:
	if _started:
		return
	DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(MEDIA_LOCAL_DIR))
	_ensure_media_server()
	_ensure_mqtt_client()
	_connect_if_needed(true)
	publishHeartbeatNow()
	_started = true

func run() -> void:
	if not _started:
		start()
		return
	_tick()

func stop() -> void:
	if _mqtt_client != null:
		_mqtt_client.disconnect_from_server()
	_connected = false
	_started = false

func getState() -> String:
	return _state

func setState(state: String) -> bool:
	if not _is_valid_state(state):
		return false
	_last_state = _state
	_state = state
	publishHeartbeatNow()
	if state == "solved":
		sendAllOutputs()
	return true

func stateChanged() -> bool:
	if _state == _last_state:
		return false
	_last_state = _state
	return true

func getInput(key: String) -> String:
	var entry: DataEntry = _inputs.get(key)
	if entry == null or not entry.present:
		return ""
	return _value_to_string(entry.data)

func inputAvailable(key: String) -> bool:
	var entry: DataEntry = _inputs.get(key)
	return entry != null and entry.present

func deleteInput(key: String) -> void:
	var entry: DataEntry = _inputs.get(key)
	if entry == null:
		return
	entry.data = ""
	entry.present = false

func getInputType(key: String) -> String:
	var entry: DataEntry = _inputs.get(key)
	return entry.type if entry != null else TYPE_STRING

func setOutput(key: String, value) -> bool:
	_outputs[key] = DataEntry.new(TYPE_STRING, _value_to_string(value), true)
	return true

func sendOutput(key: String) -> bool:
	var entry: DataEntry = _outputs.get(key)
	if entry == null or not entry.present:
		return false
	var payload_data = key if entry.type == TYPE_MEDIA else entry.data
	return _publish_json(_build_topic("data"), {
		"key": key,
		"type": entry.type,
		"data": payload_data,
		"deviceId": DEVICE_ID
	})

func sendAllOutputs() -> bool:
	var ok := true
	for key in _outputs.keys():
		var entry: DataEntry = _outputs[key]
		if entry.present:
			ok = sendOutput(key) and ok
	return ok

func sendCustom(value) -> bool:
	return _publish_json(_build_topic("custom"), {
		"value": _value_to_string(value),
		"deviceId": DEVICE_ID
	})

func getCustom() -> String:
	return _last_custom_value

func customAvailable() -> bool:
	return _last_custom_value != ""

func deleteCustom() -> void:
	_last_custom_value = ""

func triggerExternalCheck(value, active := true) -> bool:
	return _publish_json(_build_topic("external-check"), {
		"active": active,
		"variable": _value_to_string(value),
		"deviceId": DEVICE_ID
	})

func restartComplete() -> bool:
	return setState("running" if NEED_RESTART else "locked")

func setMedia(key: String, source_path: String) -> bool:
	if key.is_empty() or source_path.is_empty():
		return false
	var source_absolute := ProjectSettings.globalize_path(source_path)
	if not FileAccess.file_exists(source_absolute):
		return false
	DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(MEDIA_LOCAL_DIR))
	var file_name := source_absolute.get_file()
	var target_absolute := ProjectSettings.globalize_path(MEDIA_LOCAL_DIR.path_join(file_name))
	if source_absolute != target_absolute:
		var copy_error = DirAccess.copy_absolute(source_absolute, target_absolute)
		if copy_error != OK:
			return false
	_media_paths[key] = target_absolute
	_outputs[key] = DataEntry.new(TYPE_MEDIA, key, true)
	return true

func sendMedia(key: String) -> bool:
	var local_path := _find_local_media_by_key(key)
	if local_path.is_empty():
		return false
	if _pending_media_uploads.has(key):
		return true
	_outputs[key] = DataEntry.new(TYPE_MEDIA, key, true)
	_pending_media_uploads[key] = true
	_upload_media_async(key, local_path, true)
	return true

func getMedia(key: String) -> String:
	var ready_path = String(_media_paths.get(key, ""))
	if not ready_path.is_empty() and FileAccess.file_exists(ready_path):
		return ready_path
	var input_entry: DataEntry = _inputs.get(key)
	if input_entry != null and input_entry.type == TYPE_MEDIA and _pending_media_downloads.has(key):
		return ""
	var output_entry: DataEntry = _outputs.get(key)
	if output_entry != null and output_entry.type == TYPE_MEDIA:
		var local_output_path := _find_local_media_by_key(key)
		if not local_output_path.is_empty():
			return local_output_path
	return ""

func deleteMedia(key: String) -> bool:
	var path := _find_local_media_by_key(key)
	_media_paths.erase(key)
	_outputs[key] = DataEntry.new(TYPE_MEDIA, "", false)
	if not path.is_empty() and FileAccess.file_exists(path):
		return DirAccess.remove_absolute(path) == OK
	return true

func publishHeartbeatNow() -> bool:
	_last_heartbeat_ms = Time.get_ticks_msec()
	return _publish_json(_build_topic("heartbeat"), {
		"name": PUZZLE_NAME,
		"state": getState(),
		"deviceId": DEVICE_ID,
		"ip": _get_local_ip(),
		"needRestart": NEED_RESTART
	})

func _tick() -> void:
	_connect_if_needed(false)
	if HEARTBEAT_INTERVAL_MS > 0 and Time.get_ticks_msec() - _last_heartbeat_ms >= HEARTBEAT_INTERVAL_MS:
		publishHeartbeatNow()

func _ensure_media_server() -> void:
	if MEDIA_SERVER.is_empty():
		MEDIA_SERVER = "http://%s" % HUB_HOST
	else:
		MEDIA_SERVER = MEDIA_SERVER.rstrip("/")

func _ensure_mqtt_client() -> void:
	if _mqtt_client != null:
		return
	var script_dir: String = get_script().resource_path.get_base_dir()
	var mqtt_client_script = load(script_dir.path_join("MQTTClient.gd"))
	_mqtt_client = mqtt_client_script.new()
	_mqtt_client.name = "MQTTClient"
	_mqtt_client.client_id = "agent-%s" % DEVICE_ID
	_mqtt_client.verbose_level = 0
	add_child(_mqtt_client)
	_mqtt_client.received_message.connect(_on_mqtt_message)
	_mqtt_client.broker_connected.connect(_on_mqtt_connected)
	_mqtt_client.broker_disconnected.connect(_on_mqtt_disconnected)
	_mqtt_client.broker_connection_failed.connect(_on_mqtt_connection_failed)

func _connect_if_needed(force: bool) -> void:
	_ensure_mqtt_client()
	if _connected or _mqtt_client.is_connected_to_broker():
		_connected = true
		return
	var now := Time.get_ticks_msec()
	if not force and now - _last_connect_attempt_ms < 1000:
		return
	_last_connect_attempt_ms = now
	_mqtt_client.connect_to_broker("tcp://%s:%d" % [MQTT_BROKER, MQTT_PORT])

func _on_mqtt_connected() -> void:
	_connected = true
	_mqtt_client.subscribe(_build_topic("command"))
	publishHeartbeatNow()
	_drain_pending_messages()

func _on_mqtt_disconnected() -> void:
	_connected = false

func _on_mqtt_connection_failed() -> void:
	_connected = false

func _on_mqtt_message(topic: String, message) -> void:
	if topic != _build_topic("command"):
		return
	var text := ""
	if message is String:
		text = message
	elif message is PackedByteArray:
		text = message.get_string_from_utf8()
	else:
		text = str(message)
	var payload = JSON.parse_string(text)
	if typeof(payload) != TYPE_DICTIONARY:
		return
	_handle_command(payload)

func _handle_command(payload: Dictionary) -> void:
	var action := String(payload.get("action", ""))
	match action:
		"setState":
			setState(String(payload.get("state", getState())))
		"restart":
			_clear_data()
			_last_state = _state
			_state = "starting" if NEED_RESTART else "running"
			publishHeartbeatNow()
		"clearData":
			_clear_data()
		"initKeys":
			_apply_init_keys(payload)
		"sendParam", "requestData":
			_receive_param(payload)
		"sendOutput":
			sendOutput(String(payload.get("key", "")))
		"sendCustom", "custom", "custom_event", "custom-event":
			_last_custom_value = _value_to_string(payload.get("value", payload.get("data", payload.get("custom", ""))))
	if action in ["initKeys", "sendParam", "requestData", "sendCustom", "custom", "custom_event", "custom-event"]:
		publishHeartbeatNow()

func _apply_init_keys(payload: Dictionary) -> void:
	var old_outputs := _outputs.duplicate(true)
	_inputs.clear()
	for item in payload.get("inputs", []):
		if typeof(item) != TYPE_DICTIONARY:
			continue
		var key := String(item.get("key", item.get("name", "")))
		if key.is_empty():
			continue
		var entry_type := _normalize_type(String(item.get("type", TYPE_STRING)))
		_inputs[key] = DataEntry.empty(entry_type)
	_outputs.clear()
	for item in payload.get("outputs", []):
		if typeof(item) != TYPE_DICTIONARY:
			continue
		var key := String(item.get("key", item.get("name", "")))
		if key.is_empty():
			continue
		var entry_type := _normalize_type(String(item.get("type", TYPE_STRING)))
		var previous: DataEntry = old_outputs.get(key)
		if previous != null:
			_outputs[key] = DataEntry.new(entry_type, previous.data, previous.present)
		else:
			_outputs[key] = DataEntry.empty(entry_type)

func _receive_param(payload: Dictionary) -> void:
	var key := String(payload.get("key", payload.get("name", "")))
	if key.is_empty():
		return
	var entry_type := _normalize_type(String(payload.get("type", TYPE_STRING)))
	var value = payload.get("data", payload.get("value", ""))
	_inputs[key] = DataEntry.new(entry_type, _value_to_string(value), true)
	if entry_type == TYPE_MEDIA and not _value_to_string(value).is_empty():
		_schedule_media_download(key, _value_to_string(value))

func _clear_data() -> void:
	for key in _inputs.keys():
		var entry: DataEntry = _inputs[key]
		_inputs[key] = DataEntry.empty(entry.type)
	for key in _outputs.keys():
		var entry: DataEntry = _outputs[key]
		_outputs[key] = DataEntry.empty(entry.type)
	_media_paths.clear()
	_pending_media_downloads.clear()
	_pending_media_uploads.clear()
	_last_custom_value = ""

func _schedule_media_download(key: String, remote_name: String) -> void:
	if _pending_media_downloads.has(key):
		return
	_pending_media_downloads[key] = true
	_download_media_async(key, remote_name)

func _download_media_async(key: String, remote_name: String) -> void:
	var request := HTTPRequest.new()
	add_child(request)
	var request_id := request.get_instance_id()
	_http_requests[request_id] = {"mode": "download", "key": key, "remote_name": remote_name, "request": request}
	request.request_completed.connect(_on_download_resolve_completed.bind(request_id))
	var url := "%s/api/media/resolve?name=%s" % [MEDIA_SERVER, remote_name.uri_encode()]
	var err = request.request(url)
	if err != OK:
		_pending_media_downloads.erase(key)
		_http_requests.erase(request_id)
		request.queue_free()

func _on_download_resolve_completed(result: int, response_code: int, _headers: PackedStringArray, body: PackedByteArray, request_id: int) -> void:
	var meta: Dictionary = _http_requests.get(request_id, {})
	var request: HTTPRequest = meta.get("request")
	if request == null:
		return
	request.request_completed.disconnect(_on_download_resolve_completed.bind(request_id))
	if result != HTTPRequest.RESULT_SUCCESS or response_code < 200 or response_code >= 300:
		_pending_media_downloads.erase(String(meta.get("key", "")))
		_http_requests.erase(request_id)
		request.queue_free()
		return
	var payload = JSON.parse_string(body.get_string_from_utf8())
	var resolved_name := String(meta.get("remote_name", ""))
	if typeof(payload) == TYPE_DICTIONARY:
		resolved_name = String(payload.get("name", payload.get("path", payload.get("file", resolved_name))))
	var local_name := resolved_name.get_file()
	if local_name.is_empty():
		local_name = String(meta.get("remote_name", "")).get_file()
	DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(MEDIA_LOCAL_DIR))
	var target_absolute := ProjectSettings.globalize_path(MEDIA_LOCAL_DIR.path_join(local_name))
	_http_requests[request_id] = {"mode": "download-file", "key": meta.get("key", ""), "target_path": target_absolute, "request": request}
	request.request_completed.connect(_on_download_file_completed.bind(request_id))
	var media_url := "%s/media/%s" % [MEDIA_SERVER, resolved_name.uri_encode()]
	var download_err = request.request(media_url)
	if download_err != OK:
		_pending_media_downloads.erase(String(meta.get("key", "")))
		_http_requests.erase(request_id)
		request.queue_free()

func _on_download_file_completed(result: int, response_code: int, _headers: PackedStringArray, body: PackedByteArray, request_id: int) -> void:
	var meta: Dictionary = _http_requests.get(request_id, {})
	var key := String(meta.get("key", ""))
	var target_path := String(meta.get("target_path", ""))
	var request: HTTPRequest = meta.get("request")
	if result == HTTPRequest.RESULT_SUCCESS and response_code >= 200 and response_code < 300 and not target_path.is_empty():
		var file = FileAccess.open(target_path, FileAccess.WRITE)
		if file != null:
			file.store_buffer(body)
			file.close()
			_media_paths[key] = target_path
	_pending_media_downloads.erase(key)
	_http_requests.erase(request_id)
	if request != null:
		request.queue_free()

func _upload_media_async(key: String, local_path: String, publish_after: bool) -> void:
	var file = FileAccess.open(local_path, FileAccess.READ)
	if file == null:
		_pending_media_uploads.erase(key)
		return
	var body = file.get_buffer(file.get_length())
	file.close()
	var request := HTTPRequest.new()
	add_child(request)
	var request_id := request.get_instance_id()
	_http_requests[request_id] = {"mode": "upload", "key": key, "path": local_path, "publish_after": publish_after, "request": request}
	request.request_completed.connect(_on_upload_completed.bind(request_id))
	var headers = PackedStringArray(["Content-Type: application/octet-stream"])
	var upload_url := "%s/api/media/upload?name=%s" % [MEDIA_SERVER, local_path.get_file().uri_encode()]
	var err = request.request_raw(upload_url, headers, HTTPClient.METHOD_POST, body)
	if err != OK:
		_pending_media_uploads.erase(key)
		_http_requests.erase(request_id)
		request.queue_free()

func _on_upload_completed(result: int, response_code: int, _headers: PackedStringArray, _body: PackedByteArray, request_id: int) -> void:
	var meta: Dictionary = _http_requests.get(request_id, {})
	var key := String(meta.get("key", ""))
	var local_path := String(meta.get("path", ""))
	var publish_after := bool(meta.get("publish_after", false))
	_pending_media_uploads.erase(key)
	_http_requests.erase(request_id)
	var request: HTTPRequest = meta.get("request")
	if request != null:
		request.queue_free()
	if result != HTTPRequest.RESULT_SUCCESS or response_code < 200 or response_code >= 300:
		return
	_media_paths[key] = local_path
	if publish_after:
		sendOutput(key)

func _build_topic(suffix: String) -> String:
	return "%s/%s/%s" % [MQTT_TOPIC_PREFIX, DEVICE_ID, suffix]

func _publish_json(topic: String, payload: Dictionary) -> bool:
	_connect_if_needed(false)
	var json_text := JSON.stringify(payload)
	if not _connected or _mqtt_client == null or not _mqtt_client.is_connected_to_broker():
		_pending_messages.append({"topic": topic, "payload": json_text})
		while _pending_messages.size() > 50:
			_pending_messages.pop_front()
		return false
	_mqtt_client.publish(topic, json_text)
	return true

func _drain_pending_messages() -> void:
	if _mqtt_client == null or not _mqtt_client.is_connected_to_broker():
		return
	while not _pending_messages.is_empty():
		var item: Dictionary = _pending_messages.pop_front()
		_mqtt_client.publish(String(item.get("topic", "")), String(item.get("payload", "")))

func _is_valid_state(state: String) -> bool:
	return state in VALID_STATES

func _normalize_type(entry_type: String) -> String:
	var normalized := entry_type.to_lower()
	if normalized != TYPE_MEDIA:
		return TYPE_STRING
	return TYPE_MEDIA

func _value_to_string(value) -> String:
	if value == null:
		return ""
	if value is String:
		return value
	if value is bool:
		return "true" if value else "false"
	return str(value)

func _find_local_media_by_key(key: String) -> String:
	var ready_path := String(_media_paths.get(key, ""))
	if not ready_path.is_empty() and FileAccess.file_exists(ready_path):
		return ready_path
	var absolute_dir := ProjectSettings.globalize_path(MEDIA_LOCAL_DIR)
	var dir := DirAccess.open(absolute_dir)
	if dir == null:
		return ""
	dir.list_dir_begin()
	while true:
		var file_name := dir.get_next()
		if file_name.is_empty():
			break
		if dir.current_is_dir():
			continue
		if file_name.get_basename() == key:
			var found_path := absolute_dir.path_join(file_name)
			_media_paths[key] = found_path
			dir.list_dir_end()
			return found_path
	dir.list_dir_end()
	return ""

func _get_local_ip() -> String:
	for address in IP.get_local_addresses():
		if address.contains(":"):
			continue
		if address.begins_with("127."):
			continue
		return address
	return "0.0.0.0"
