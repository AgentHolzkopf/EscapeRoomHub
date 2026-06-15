/*
  ESP32 CommunikationAgent MCU reference
  Implements the MCU minimal profile from COMMUNIKATIONAGENT_MCU_MINIMALPROFIL.md

  Required libraries:
  - WiFi (ESP32 core)
  - PubSubClient
  - ArduinoJson
*/

#define MQTT_MAX_PACKET_SIZE 1024

#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include "CommunikationAgentMCU_Core.h"

// -------------------------
// Project-specific settings
// -------------------------
static const char* WIFI_SSID = "WIFI_SSID";
static const char* WIFI_PASS = "WIFI_PASS";

static const char* MQTT_HOST = "MQTT_HOST_IP";
static const uint16_t MQTT_PORT = 1883;

static const char* DEVICE_ID = "puzzle-esp32-1";
static const char* PUZZLE_NAME = "ESP32 Puzzle";
static const bool NEED_RESTART = false;
static const uint32_t HEARTBEAT_INTERVAL_MS = 2000;

WiFiClient netClient;
PubSubClient mqttClient(netClient);
CommunikationAgentMCUCore agent;

// Example puzzle logic flag
bool solvedSent = false;
bool customSent = false;

const char* getLocalIpText() {
  static char ipText[24];
  IPAddress ip = WiFi.localIP();
  snprintf(ipText, sizeof(ipText), "%u.%u.%u.%u", ip[0], ip[1], ip[2], ip[3]);
  return ipText;
}

void mqttPublish(const char* topic, const char* payload) {
  mqttClient.publish(topic, payload);
}

bool isTrueText(const char* value) {
  return value && (
    strcmp(value, "true") == 0 ||
    strcmp(value, "1") == 0 ||
    strcmp(value, "TRUE") == 0 ||
    strcmp(value, "yes") == 0
  );
}

void sendCustomValueToHub(const char* value) {
  // Publishes to puzzle/<deviceId>/custom with payload {"value": "...", "deviceId": "..."}.
  agent.publishCustomFromPuzzle(value);
}

void handleCustomEvent(const char* value) {
  // Placeholder: react to Custom values sent by the Hub.
  // Example:
  // if (strcmp(value, "button pressed") == 0) {
  //   // Your own code here.
  // }
  (void)value;
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

  // Example: react to a Custom value sent by the Hub.
  const char* custom = agent.getCustomValue();
  if (custom) {
    Serial.print("Custom received from Hub: ");
    Serial.println(custom);

    handleCustomEvent(custom);
    // Treat Custom as an event: clear it after processing so the same value can trigger again.
    agent.clearCustomValue();
  }

  // Example: if Hub input SendCustom=true, send one Custom value back to the Hub.
  // Replace this with your own button/sensor condition in the real puzzle logic.
  const char* sendCustom = agent.getInputValue("SendCustom");
  if (isTrueText(sendCustom)) {
    if (!customSent) {
      sendCustomValueToHub("esp32-custom-value");
      customSent = true;
    }
  } else {
    customSent = false;
  }
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
  (void)topic;
  if (length == 0 || length >= 1024) return;

  static char message[1024];
  memcpy(message, payload, length);
  message[length] = '\0';

  agent.handleCommandJson(message);
}

void ensureWifiConnected() {
  if (WiFi.status() == WL_CONNECTED) return;

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
  }
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

void setup() {
  Serial.begin(115200);
  delay(200);

  ensureWifiConnected();

  mqttClient.setServer(MQTT_HOST, MQTT_PORT);
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
  ensureWifiConnected();
  ensureMqttConnected();

  mqttClient.loop();
  agent.loop(millis());

  // Place your own non-blocking puzzle code here.
  // Keep this loop fast: avoid long delay() calls so MQTT and heartbeat stay responsive.

  // Optional example logic in same firmware. Remove or replace for production.
  handlePuzzleLogicExample();
}
