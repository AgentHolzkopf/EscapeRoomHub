/*
  Arduino Mega + Ethernet Shield CommunikationAgent MCU reference
  Implements the MCU minimal profile from COMMUNIKATIONAGENT_MCU_MINIMALPROFIL.md

  Required libraries:
  - SPI
  - Ethernet (W5100/W5500)
  - PubSubClient
  - ArduinoJson
*/

#define MQTT_MAX_PACKET_SIZE 768

#include <SPI.h>
#include <Ethernet.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include "CommunikationAgentMCU_Core.h"

// -------------------------
// Project-specific settings
// -------------------------
byte MAC_ADDRESS[] = { 0xDE, 0xAD, 0xBE, 0xEF, 0xFE, 0x01 };

IPAddress MQTT_SERVER(192, 168, 1, 10);
const uint16_t MQTT_PORT = 1883;

IPAddress STATIC_IP(192, 168, 1, 60);
IPAddress DNS_SERVER(192, 168, 1, 1);
IPAddress GATEWAY(192, 168, 1, 1);
IPAddress SUBNET(255, 255, 255, 0);

static const char* DEVICE_ID = "puzzle-mega-1";
static const char* PUZZLE_NAME = "Mega Puzzle";
static const bool NEED_RESTART = false;
static const uint32_t HEARTBEAT_INTERVAL_MS = 2500;

EthernetClient netClient;
PubSubClient mqttClient(netClient);
CommunikationAgentMCUCore agent;

bool solvedSent = false;

const char* getLocalIpText() {
  static char ipText[24];
  IPAddress ip = Ethernet.localIP();
  snprintf(ipText, sizeof(ipText), "%u.%u.%u.%u", ip[0], ip[1], ip[2], ip[3]);
  return ipText;
}

void mqttPublish(const char* topic, const char* payload) {
  mqttClient.publish(topic, payload);
}

void handlePuzzleLogicExample() {
  // Example: if Hub input Solve=true, set output VerifyCorrect=true and solved.
  const char* solve = agent.getInputValue("Solve");
  if (!solvedSent && solve && (strcmp(solve, "true") == 0 || strcmp(solve, "1") == 0)) {
    if (agent.setOutputFromPuzzle("VerifyCorrect", "boolean", "true")) {
      agent.sendOutputFromPuzzle("VerifyCorrect");
    }
    agent.setState("solved");
    solvedSent = true;
  }
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  (void)topic;
  if (length == 0 || length >= 768) return;

  static char message[768];
  memcpy(message, payload, length);
  message[length] = '\0';

  agent.handleCommandJson(message);
}

void ensureMqttConnected() {
  if (mqttClient.connected()) return;

  char clientId[48];
  snprintf(clientId, sizeof(clientId), "agent-%s", DEVICE_ID);

  while (!mqttClient.connected()) {
    if (mqttClient.connect(clientId)) {
      char commandTopic[96];
      agent.getCommandTopic(commandTopic, sizeof(commandTopic));
      mqttClient.subscribe(commandTopic);
      agent.publishHeartbeatNow();
      return;
    }
    delay(1000);
  }
}

void setupEthernet() {
  if (Ethernet.begin(MAC_ADDRESS) == 0) {
    Ethernet.begin(MAC_ADDRESS, STATIC_IP, DNS_SERVER, GATEWAY, SUBNET);
  }
  delay(1000);
}

void setup() {
  Serial.begin(115200);
  delay(200);

  setupEthernet();

  mqttClient.setServer(MQTT_SERVER, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);

  CommunikationAgentMCUCore::Config cfg;
  cfg.deviceId = DEVICE_ID;
  cfg.puzzleName = PUZZLE_NAME;
  cfg.topicPrefix = "puzzle";
  cfg.needRestart = NEED_RESTART;
  cfg.heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS;

  agent.begin(cfg, mqttPublish, getLocalIpText);

  ensureMqttConnected();
}

void loop() {
  ensureMqttConnected();

  mqttClient.loop();
  agent.loop(millis());

  handlePuzzleLogicExample();
}