extends Node
class_name MQTTClient

# MQTT client implementation in GDScript.
# Adapted from godot-mqtt: https://github.com/goatchurchprime/godot-mqtt (MIT)

@export var client_id = ""
@export var verbose_level = 1
@export var binarymessages = false
@export var pinginterval = 30

var socket = null
var sslsocket = null
var websocket = null

const BCM_NOCONNECTION = 0
const BCM_WAITING_WEBSOCKET_CONNECTION = 1
const BCM_WAITING_SOCKET_CONNECTION = 2
const BCM_WAITING_SSL_SOCKET_CONNECTION = 3
const BCM_FAILED_CONNECTION = 5
const BCM_WAITING_CONNMESSAGE = 10
const BCM_WAITING_CONNACK = 19
const BCM_CONNECTED = 20

var brokerconnectmode = BCM_NOCONNECTION
var regexbrokerurl = RegEx.new()

const DEFAULTBROKERPORT_TCP = 1883
const DEFAULTBROKERPORT_SSL = 8886
const DEFAULTBROKERPORT_WS = 8080
const DEFAULTBROKERPORT_WSS = 8081

const CP_PINGREQ = 0xc0
const CP_PINGRESP = 0xd0
const CP_CONNACK = 0x20
const CP_CONNECT = 0x10
const CP_PUBLISH = 0x30
const CP_SUBSCRIBE = 0x82
const CP_UNSUBSCRIBE = 0xa2
const CP_PUBREC = 0x40
const CP_SUBACK = 0x90
const CP_UNSUBACK = 0xb0

var pid = 0
var user = null
var pswd = null
var keepalive = 120
var lw_topic = null
var lw_msg = null
var lw_qos = 0
var lw_retain = false

signal received_message(topic, message)
signal broker_connected()
signal broker_disconnected()
signal broker_connection_failed()
signal publish_acknowledge(pid_value)

var receivedbuffer: PackedByteArray = PackedByteArray()
var common_name = null
var pingticksnext0 = 0

func _ready() -> void:
	regexbrokerurl.compile('^(tcp://|wss://|ws://|ssl://)?([^:\\s]+)(:\\d+)?(/\\S*)?$')
	if client_id == "":
		randomize()
		client_id = "rr%d" % randi()

func is_connected_to_broker() -> bool:
	return brokerconnectmode == BCM_CONNECTED

func senddata(data: PackedByteArray) -> void:
	var error_code: int = 0
	if sslsocket != null:
		error_code = sslsocket.put_data(data)
	elif socket != null:
		error_code = socket.put_data(data)
	elif websocket != null:
		error_code = websocket.put_packet(data)
	if error_code != 0 and verbose_level:
		printerr("MQTT send error: ", error_code)

func receiveintobuffer():
	if sslsocket != null:
		var ssl_status = sslsocket.get_status()
		if ssl_status == StreamPeerTLS.STATUS_CONNECTED or ssl_status == StreamPeerTLS.STATUS_HANDSHAKING:
			var ssl_poll_error = sslsocket.poll()
			if ssl_poll_error != 0:
				return ssl_poll_error
			var ssl_bytes = sslsocket.get_available_bytes()
			if ssl_bytes > 0:
				var ssl_data = sslsocket.get_data(ssl_bytes)
				if ssl_data[0] == 0:
					receivedbuffer.append_array(ssl_data[1])
	elif socket != null and socket.get_status() == StreamPeerTCP.STATUS_CONNECTED:
		var socket_poll_error = socket.poll()
		if socket_poll_error != 0:
			return socket_poll_error
		var socket_bytes = socket.get_available_bytes()
		if socket_bytes > 0:
			var socket_data = socket.get_data(socket_bytes)
			if socket_data[0] == 0:
				receivedbuffer.append_array(socket_data[1])
	elif websocket != null:
		websocket.poll()
		while websocket.get_available_packet_count() != 0:
			receivedbuffer.append_array(websocket.get_packet())
	return 0

func _process(_delta: float) -> void:
	if brokerconnectmode == BCM_NOCONNECTION:
		return
	elif brokerconnectmode == BCM_WAITING_WEBSOCKET_CONNECTION:
		websocket.poll()
		var websocket_state = websocket.get_ready_state()
		if websocket_state == WebSocketPeer.STATE_CLOSED:
			brokerconnectmode = BCM_FAILED_CONNECTION
			emit_signal("broker_connection_failed")
		elif websocket_state == WebSocketPeer.STATE_OPEN:
			brokerconnectmode = BCM_WAITING_CONNMESSAGE
	elif brokerconnectmode == BCM_WAITING_SOCKET_CONNECTION:
		socket.poll()
		var socket_status = socket.get_status()
		if socket_status == StreamPeerTCP.STATUS_ERROR:
			brokerconnectmode = BCM_FAILED_CONNECTION
			emit_signal("broker_connection_failed")
		elif socket_status == StreamPeerTCP.STATUS_CONNECTED:
			brokerconnectmode = BCM_WAITING_CONNMESSAGE
	elif brokerconnectmode == BCM_WAITING_SSL_SOCKET_CONNECTION:
		socket.poll()
		var tcp_status = socket.get_status()
		if tcp_status == StreamPeerTCP.STATUS_ERROR:
			brokerconnectmode = BCM_FAILED_CONNECTION
			emit_signal("broker_connection_failed")
		elif tcp_status == StreamPeerTCP.STATUS_CONNECTED:
			if sslsocket == null:
				sslsocket = StreamPeerTLS.new()
				var connect_error = sslsocket.connect_to_stream(socket, common_name)
				if connect_error != 0:
					sslsocket = null
					brokerconnectmode = BCM_FAILED_CONNECTION
					emit_signal("broker_connection_failed")
			if sslsocket != null:
				sslsocket.poll()
				var tls_status = sslsocket.get_status()
				if tls_status == StreamPeerTLS.STATUS_CONNECTED:
					brokerconnectmode = BCM_WAITING_CONNMESSAGE
				elif tls_status >= StreamPeerTLS.STATUS_ERROR:
					brokerconnectmode = BCM_FAILED_CONNECTION
					emit_signal("broker_connection_failed")
	elif brokerconnectmode == BCM_WAITING_CONNMESSAGE:
		senddata(firstmessagetoserver())
		brokerconnectmode = BCM_WAITING_CONNACK
	elif brokerconnectmode == BCM_WAITING_CONNACK or brokerconnectmode == BCM_CONNECTED:
		receiveintobuffer()
		while wait_msg():
			pass
		if brokerconnectmode == BCM_CONNECTED and pingticksnext0 < Time.get_ticks_msec():
			pingreq()
			pingticksnext0 = Time.get_ticks_msec() + pinginterval * 1000
	elif brokerconnectmode == BCM_FAILED_CONNECTION:
		cleanupsockets()

func set_last_will(stopic: String, smsg, retain := false, qos := 0) -> void:
	assert(qos >= 0 and qos <= 2)
	assert(stopic != "")
	lw_topic = stopic.to_ascii_buffer()
	if binarymessages:
		lw_msg = smsg
	else:
		lw_msg = String(smsg).to_ascii_buffer()
	lw_qos = qos
	lw_retain = retain

func set_user_pass(suser, spswd) -> void:
	if suser != null:
		user = String(suser).to_ascii_buffer()
		pswd = String(spswd).to_ascii_buffer()
	else:
		user = null
		pswd = null

static func encoderemaininglength(pkt: PackedByteArray, size: int) -> void:
	assert(size < 2097152)
	var index: int = 1
	while size > 0x7f:
		pkt[index] = (size & 0x7f) | 0x80
		size >>= 7
		index += 1
		if index + 1 > len(pkt):
			pkt.append(0x00)
	pkt[index] = size

static func encodeshortint(pkt: PackedByteArray, number: int) -> void:
	assert(number >= 0 and number < 65536)
	pkt.append((number >> 8) & 0xFF)
	pkt.append(number & 0xFF)

static func encodevarstr(pkt: PackedByteArray, bs: PackedByteArray) -> void:
	encodeshortint(pkt, len(bs))
	pkt.append_array(bs)

func firstmessagetoserver() -> PackedByteArray:
	var clean_session: bool = true
	var pkt: PackedByteArray = PackedByteArray()
	pkt.append(CP_CONNECT)
	pkt.append(0x00)
	var payload_size: int = 10 + (2 + len(client_id))
	if user != null:
		payload_size += 2 + len(user) + 2 + len(pswd)
	if lw_topic:
		payload_size += 2 + len(lw_topic) + 2 + len(lw_msg)
	encoderemaininglength(pkt, payload_size)
	var remstartpos: int = len(pkt)
	encodevarstr(pkt, PackedByteArray([0x4D, 0x51, 0x54, 0x54]))
	var protocollevel: int = 0x04
	var connectflags: int = 0
	if user != null:
		connectflags |= 0xC0
	if lw_retain:
		connectflags |= 0x20
	connectflags |= (lw_qos << 3)
	if lw_topic:
		connectflags |= 0x04
	if clean_session:
		connectflags |= 0x02
	pkt.append(protocollevel)
	pkt.append(connectflags)
	encodeshortint(pkt, keepalive)
	encodevarstr(pkt, client_id.to_ascii_buffer())
	if lw_topic:
		encodevarstr(pkt, lw_topic)
		encodevarstr(pkt, lw_msg)
	if user != null:
		encodevarstr(pkt, user)
		encodevarstr(pkt, pswd)
	assert(len(pkt) - remstartpos == payload_size)
	return pkt

func cleanupsockets(retval := false):
	if socket:
		if sslsocket:
			sslsocket = null
		socket.disconnect_from_host()
		socket = null
	else:
		assert(sslsocket == null)
	if websocket:
		websocket.close()
		websocket = null
	brokerconnectmode = BCM_NOCONNECTION
	return retval

func connect_to_broker(brokerurl: String) -> bool:
	assert(brokerconnectmode == BCM_NOCONNECTION)
	var brokermatch = regexbrokerurl.search(brokerurl)
	if brokermatch == null:
		return cleanupsockets(false)
	var brokercomponents = brokermatch.strings
	var brokerprotocol: String = brokercomponents[1]
	var brokerserver: String = brokercomponents[2]
	var iswebsocket: bool = brokerprotocol == "ws://" or brokerprotocol == "wss://"
	var isssl: bool = brokerprotocol == "ssl://" or brokerprotocol == "wss://"
	var brokerport: int = DEFAULTBROKERPORT_TCP
	if iswebsocket:
		brokerport = DEFAULTBROKERPORT_WSS if isssl else DEFAULTBROKERPORT_WS
	else:
		brokerport = DEFAULTBROKERPORT_SSL if isssl else DEFAULTBROKERPORT_TCP
	if brokercomponents[3]:
		brokerport = int(String(brokercomponents[3]).substr(1))
	var brokerpath: String = ""
	if brokercomponents[4]:
		brokerpath = brokercomponents[4]
	common_name = null
	if iswebsocket:
		websocket = WebSocketPeer.new()
		websocket.supported_protocols = PackedStringArray(["mqttv3.1"])
		var websocket_protocol: String = "wss://" if isssl else "ws://"
		var websocketurl: String = websocket_protocol + brokerserver + ":" + str(brokerport) + brokerpath
		var ws_error = websocket.connect_to_url(websocketurl)
		if ws_error != 0:
			return cleanupsockets(false)
		brokerconnectmode = BCM_WAITING_WEBSOCKET_CONNECTION
	else:
		socket = StreamPeerTCP.new()
		var connect_error = socket.connect_to_host(brokerserver, brokerport)
		if connect_error != 0:
			return cleanupsockets(false)
		if isssl:
			brokerconnectmode = BCM_WAITING_SSL_SOCKET_CONNECTION
			common_name = brokerserver
		else:
			brokerconnectmode = BCM_WAITING_SOCKET_CONNECTION
	return true

func disconnect_from_server() -> void:
	if brokerconnectmode == BCM_CONNECTED:
		senddata(PackedByteArray([0xE0, 0x00]))
		emit_signal("broker_disconnected")
	cleanupsockets()

func publish(stopic: String, smsg, retain := false, qos := 0) -> int:
	var msg
	if binarymessages:
		msg = smsg
	else:
		msg = String(smsg).to_ascii_buffer()
	var topic = stopic.to_ascii_buffer()
	var pkt: PackedByteArray = PackedByteArray()
	var publish_flags: int = CP_PUBLISH
	if qos:
		publish_flags |= 2
	if retain:
		publish_flags |= 1
	pkt.append(publish_flags)
	pkt.append(0x00)
	var payload_size: int = 2 + len(topic) + len(msg)
	if qos > 0:
		payload_size += 2
	encoderemaininglength(pkt, payload_size)
	var remstartpos: int = len(pkt)
	encodevarstr(pkt, topic)
	if qos > 0:
		pid += 1
		encodeshortint(pkt, pid)
	pkt.append_array(msg)
	assert(len(pkt) - remstartpos == payload_size)
	senddata(pkt)
	return pid

func subscribe(stopic: String, qos := 0) -> void:
	pid += 1
	var topic = stopic.to_ascii_buffer()
	var payload_size: int = 2 + 2 + len(topic) + 1
	var pkt: PackedByteArray = PackedByteArray()
	pkt.append(CP_SUBSCRIBE)
	pkt.append(0x00)
	encoderemaininglength(pkt, payload_size)
	var remstartpos: int = len(pkt)
	encodeshortint(pkt, pid)
	encodevarstr(pkt, topic)
	pkt.append(qos)
	assert(len(pkt) - remstartpos == payload_size)
	senddata(pkt)

func pingreq() -> void:
	senddata(PackedByteArray([CP_PINGREQ, 0x00]))

func unsubscribe(stopic: String) -> void:
	pid += 1
	var topic = stopic.to_ascii_buffer()
	var payload_size: int = 2 + 2 + len(topic)
	var pkt: PackedByteArray = PackedByteArray()
	pkt.append(CP_UNSUBSCRIBE)
	pkt.append(0x00)
	encoderemaininglength(pkt, payload_size)
	var remstartpos: int = len(pkt)
	encodeshortint(pkt, pid)
	encodevarstr(pkt, topic)
	assert(len(pkt) - remstartpos == payload_size)
	senddata(pkt)

func wait_msg() -> bool:
	var n: int = receivedbuffer.size()
	if n < 2:
		return false
	var op: int = receivedbuffer[0]
	var index: int = 1
	var size: int = receivedbuffer[index] & 0x7f
	while receivedbuffer[index] & 0x80:
		index += 1
		if index == n:
			return false
		size += (receivedbuffer[index] & 0x7f) << ((index - 1) * 7)
	index += 1
	if n < index + size:
		return false
	if op == CP_PINGRESP:
		pass
	elif op & 0xf0 == 0x30:
		var topic_len = (receivedbuffer[index] << 8) + receivedbuffer[index + 1]
		var message_index = index + 2
		var topic = receivedbuffer.slice(message_index, message_index + topic_len).get_string_from_ascii()
		message_index += topic_len
		var pid_value: int = 0
		if op & 6:
			pid_value = (receivedbuffer[message_index] << 8) + receivedbuffer[message_index + 1]
			message_index += 2
		var data = receivedbuffer.slice(message_index, index + size)
		var msg
		if binarymessages:
			msg = data
		else:
			msg = data.get_string_from_ascii()
		emit_signal("received_message", topic, msg)
		if op & 6 == 2:
			senddata(PackedByteArray([0x40, 0x02, (pid_value >> 8), (pid_value & 0xFF)]))
	elif op == CP_CONNACK:
		var retcode = receivedbuffer[index + 1]
		if retcode == 0x00:
			brokerconnectmode = BCM_CONNECTED
			emit_signal("broker_connected")
		else:
			brokerconnectmode = BCM_FAILED_CONNECTION
			emit_signal("broker_connection_failed")
	elif op == CP_PUBREC:
		var ack_pid = (receivedbuffer[index] << 8) + receivedbuffer[index + 1]
		emit_signal("publish_acknowledge", ack_pid)
	elif op == CP_SUBACK:
		pass
	elif op == CP_UNSUBACK:
		pass
	trimreceivedbuffer(index + size)
	return true

func trimreceivedbuffer(n: int) -> void:
	if n == receivedbuffer.size():
		receivedbuffer = PackedByteArray()
	else:
		assert(n <= receivedbuffer.size())
		receivedbuffer = receivedbuffer.slice(n)
