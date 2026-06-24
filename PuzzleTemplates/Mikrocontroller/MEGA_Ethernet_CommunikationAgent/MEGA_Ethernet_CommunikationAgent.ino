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
///////////////////////////////////////////////////////////////////
byte MAC_ADDRESS[] = { 0xDE, 0xAD, 0xBE, 0xEF, 0xFE, 0x01 };

IPAddress MQTT_SERVER(192, 168, 1, 10);
const uint16_t MQTT_PORT = 1883;

/// this section is only relevant when no dhcp service is running

IPAddress STATIC_IP(192, 168, 1, 60);
IPAddress DNS_SERVER(192, 168, 1, 1);
IPAddress GATEWAY(192, 168, 1, 1);
IPAddress SUBNET(255, 255, 255, 0);

///////////////////////////////////////////////////////////////

static const char* DEVICE_ID = "puzzle-mega-1";                          // relevant for internal assignment
static const char* PUZZLE_NAME = "Mega Puzzle";                          // relevant for assignment in hub UI
static const bool NEED_RESTART = false;
static const uint32_t HEARTBEAT_INTERVAL_MS = 2000;


/// add your own variables here:




///////////////////////////////////////////////////////////////////

// dont change this section //////////////////////////////////////

EthernetClient netClient;
PubSubClient mqttClient(netClient);
CommunikationAgentMCUCore agent;

bool solvedSent = false;
bool customSent = false;
char lastCustomValue[CommunikationAgentMCUCore::MAX_VALUE_LEN + 1] = "";

const char* getLocalIpText() {
  static char ipText[24];
  IPAddress ip = Ethernet.localIP();
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

void setupConnection() {
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

/////////////////////////////////////////////////////////////////////////
/// you can change stuff from here on

void handlePuzzleLogic() {

  // You can inplement your own puzzle logic here
  // following agent functions can be used to communicate with the hub

  // agent.getState();                         // returns the current state of the puzzle
  // agent.setState("solved");                 // sets a new state ("running", "solved", "locked", "starting") => example: when puzzle is solve: setState("solved")
  // agent.stateChanged();                     // returs true if state has changed since last call and false if not

  // agent.sendCustom("putStringHere");        // sends custom string to hub
  // agent.getCustom();                        // returns the current custom value as string without deleting it
  // agent.customAvailable();                  // returns true if a custom value is currently available
  // agent.deleteCustom();                     // deletes the current custom value

  // agent.getInput("key");                    // returns the current input as string without deleting it. the name ("key") has to fit to the input name given in hub UI.
  // agent.inputAvailable("key");              // returns true if the input currently exists
  // agent.deleteInput("key");                 // deletes the current input value for the given key

  // agent.setOutput("key", "value");          // sets output internally. "key" must fit to the name given to the output in the hub UI. Example: agent.setOutput("password", "password123");
  // agent.sendOutput("key");                  // sends the output with the name "key" etc to the hub
  // agent.sendAllOutput();                    // sends all set outputs to the hub
  
  // agent.triggerExternalCheck("1234, true);  // triggers the hub external check. can be used to check if the player has solved the puzzle / has got the right password out of it. the last value (true = bool) triggers the check. with false it can be deactivated

}

void setup() {
  Serial.begin(115200);
  delay(200);
  setupConnection();

  //put your puzzle setup here:

}

void loop() {
  ensureMqttConnected();

  mqttClient.loop();
  agent.loop(millis());

  // Place your own non-blocking puzzle code here.
  // Keep this loop fast: avoid long delay() calls so MQTT and heartbeat stay responsive.
  // You can use this function if desired
  handlePuzzleLogicExample();

}

/////////////////////////////////////////////////////////////////////////
