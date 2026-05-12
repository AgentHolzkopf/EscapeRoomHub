const mqtt = require('mqtt');
const EventEmitter = require('events');

const emitter = new EventEmitter();
let client = null;
let currentPort = parseInt(process.env.MQTT_PORT || '1883', 10);

// Prevent unhandled error events from crashing the process
emitter.on('error', () => {});

function attachClientHandlers(nextClient) {
    if (!nextClient) return;
    nextClient.on('connect', () => {
        emitter.emit('connect');
        try {
            nextClient.subscribe('puzzle/+/heartbeat');
            nextClient.subscribe('puzzle/+/data');
            nextClient.subscribe('puzzle/+/custom');
            nextClient.subscribe('puzzle/+/external-check');
            nextClient.subscribe('zigbee2mqtt/#');
        } catch (err) {
            console.error('MQTT subscribe failed:', err);
        }
    });
    nextClient.on('message', (topic, message) => emitter.emit('message', topic, message));
    nextClient.on('error', (err) => {
        console.error('MQTT connection error:', err?.message || err);
        emitter.emit('mqtt-error', err);
    });
}

function connect(port = currentPort) {
    currentPort = port;
    if (client) {
        try { client.end(true); } catch (e) {}
    }
    client = mqtt.connect(`mqtt://localhost:${currentPort}`, {
        clientId: 'escape_hub_backend',
        reconnectPeriod: 1000
    });
    attachClientHandlers(client);
}

function restart(port) {
    const targetPort = Number.isFinite(parseInt(port, 10)) ? parseInt(port, 10) : currentPort;
    connect(targetPort);
}

function publish(topic, payload) {
    if (!client) return;
    try {
        client.publish(topic, payload);
    } catch (err) {
        console.error('MQTT publish failed:', err);
    }
}

function getCurrentPort() {
    return currentPort;
}

connect(currentPort);

module.exports = {
    on: (...args) => emitter.on(...args),
    publish,
    restart,
    getCurrentPort
};
