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
/////////////////////////////////////////////////////////////////////////
static const char* WIFI_SSID = "theStudioWS26";
static const char* WIFI_PASS = "theStudioWS26";

static const char* MQTT_HOST = "192.168.100.23";
static const uint16_t MQTT_PORT = 1883;

static const char* DEVICE_ID = "puzzle-esp32-1";
static const char* PUZZLE_NAME = "ESP32 Puzzle";
static const bool NEED_RESTART = false;
static const uint32_t HEARTBEAT_INTERVAL_MS = 2000;
/////////////////////////////////////////////////////////////////////////

///dont change this block////////////////////////////////////////////////

WiFiClient netClient;
PubSubClient mqttClient(netClient);
CommunikationAgentMCUCore agent;

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

void connectionSetup() {
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

////////////////////////////////////////////////////////////////////////////

void handlePuzzleLogic() {
  //You can inplement your own puzzle logic here
  //following agent functions can be used to communicate with the hub

  //agent.getState();                         // returns the current state of the puzzle
  //agent.setState("solved");                 // sets a new state ("running", "solved", "locked", "starting") => example: when puzzle is solve: setState("solved")
  //agent.stateChanged();                     // returs true if state has changed since last call and false if not 
  //agent.sendCustom("putStringHere");        // sends custom string to hub 
  //agent.getCustom();                        // returns custom value, which got send by the hub, as string. Automaticly deletes custom value => only returns value if the hub has send one since last call.
  //agent.getInput("key");                    // returns input, which got send by the hub, as string. the name ("key") has to fit to the name of the input given in hub UI.
  //agent.setOutput("key", "type", "value");  // sets output internally. "key" must fit to the name given to the output in the hub UI. "type" descripes the type of value (String, int, bool). For example: agent.setOutput("password", "String", "password123");
  //agent.sendOutput("key");                  // sends the output with the name "key" etc to the hub
  //agent.sendAllOutput();                    // sends all settet outputs to the hub
}


void setup() {
  Serial.begin(115200);
  delay(200);
  connectionSetup();

  // You can place your setup code here
}

void loop() {
  ensureWifiConnected();
  ensureMqttConnected();

  mqttClient.loop();
  agent.loop(millis());

  // Place your own non-blocking puzzle code here.
  // Keep this loop fast: avoid long delay() calls so MQTT and heartbeat stay responsive.
  // You can use this function if desired
  handlePuzzleLogic();
}

///////////////////////////////////////////////////////////////////////////////