#ifndef COMMUNIKATION_AGENT_MCU_CORE_H
#define COMMUNIKATION_AGENT_MCU_CORE_H

#include <ArduinoJson.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

class CommunikationAgentMCUCore {
public:
  static const uint8_t MAX_INPUT_KEYS = 16;
  static const uint8_t MAX_OUTPUT_KEYS = 16;
  static const uint8_t MAX_KEY_LEN = 32;
  static const uint8_t MAX_TYPE_LEN = 10;
  static const uint8_t MAX_VALUE_LEN = 96;
  static const uint16_t COMMAND_DOC_CAPACITY = 1024;

  typedef void (*PublishFn)(const char* topic, const char* payload);
  typedef const char* (*IpFn)();

  struct Config {
    const char* deviceId;
    const char* puzzleName;
    const char* topicPrefix;
    bool needRestart;
    uint32_t heartbeatIntervalMs;
  };

  CommunikationAgentMCUCore()
    : publishFn_(NULL),
      ipFn_(NULL),
      needRestart_(false),
      heartbeatIntervalMs_(2000),
      lastHeartbeatAt_(0),
      inputCount_(0),
      outputCount_(0),
      customPresent_(false) {
    safeCopy(deviceId_, sizeof(deviceId_), "puzzle-1");
    safeCopy(puzzleName_, sizeof(puzzleName_), "Puzzle");
    safeCopy(topicPrefix_, sizeof(topicPrefix_), "puzzle");
    safeCopy(state_, sizeof(state_), "locked");
    customValue_[0] = '\0';
    clearEntries(inputs_, MAX_INPUT_KEYS);
    clearEntries(outputs_, MAX_OUTPUT_KEYS);
  }

  void begin(const Config& cfg, PublishFn publishFn, IpFn ipFn) {
    publishFn_ = publishFn;
    ipFn_ = ipFn;

    if (cfg.deviceId && cfg.deviceId[0] != '\0') safeCopy(deviceId_, sizeof(deviceId_), cfg.deviceId);
    if (cfg.puzzleName && cfg.puzzleName[0] != '\0') safeCopy(puzzleName_, sizeof(puzzleName_), cfg.puzzleName);
    if (cfg.topicPrefix && cfg.topicPrefix[0] != '\0') safeCopy(topicPrefix_, sizeof(topicPrefix_), cfg.topicPrefix);

    needRestart_ = cfg.needRestart;
    heartbeatIntervalMs_ = cfg.heartbeatIntervalMs > 0 ? cfg.heartbeatIntervalMs : 2000;

    setStateInternal("locked");
    clearData();
    publishHeartbeatNow();
  }

  void loop(uint32_t nowMs) {
    if (heartbeatIntervalMs_ == 0) return;
    if (nowMs - lastHeartbeatAt_ >= heartbeatIntervalMs_) {
      publishHeartbeatNow();
      lastHeartbeatAt_ = nowMs;
    }
  }

  void handleCommandJson(const char* jsonPayload) {
    if (!jsonPayload || !jsonPayload[0]) return;

    DynamicJsonDocument doc(COMMAND_DOC_CAPACITY);
    DeserializationError err = deserializeJson(doc, jsonPayload);
    if (err) return;

    const char* action = doc["action"] | "";
    if (!action[0]) return;

    bool publishHeartbeatAfter = false;

    if (strcmp(action, "initKeys") == 0) {
      applyInitKeys(doc.as<JsonObjectConst>());
      publishHeartbeatAfter = true;
    } else if (strcmp(action, "clearData") == 0) {
      clearData();
      publishHeartbeatAfter = true;
    } else if (strcmp(action, "restart") == 0) {
      if (needRestart_) {
        setStateInternal("starting");
      } else {
        setStateInternal("running");
      }
      publishHeartbeatAfter = true;
    } else if (strcmp(action, "setState") == 0) {
      const char* incoming = doc["state"] | "";
      if (incoming[0]) {
        setStateInternal(incoming);
        publishHeartbeatAfter = true;
      }
    } else if (strcmp(action, "sendParam") == 0) {
      const char* key = pickKey(doc.as<JsonObjectConst>());
      const char* type = normalizeType(doc["type"] | "string");
      if (key && key[0]) {
        setInputValue(key, type, doc["data"]);
        publishHeartbeatAfter = true;
      }
    } else if (strcmp(action, "sendCustom") == 0
      || strcmp(action, "custom") == 0
      || strcmp(action, "custom_event") == 0
      || strcmp(action, "custom-event") == 0) {
      JsonVariantConst customValue = doc["value"];
      if (customValue.isNull()) customValue = doc["data"];
      if (customValue.isNull()) customValue = doc["text"];
      if (customValue.isNull()) customValue = doc["custom"];
      setCustomFromVariant(customValue);
      setInputValue("custom", "string", customValue);
      publishHeartbeatAfter = true;
    } else if (strcmp(action, "requestData") == 0) {
      const char* key = pickKey(doc.as<JsonObjectConst>());
      if (key && key[0]) {
        publishOutputData(key);
      } else {
        publishAllOutputs();
      }
      publishHeartbeatAfter = true;
    } else if (strcmp(action, "sendOutput") == 0) {
      // Optional alias for compatibility.
      const char* key = pickKey(doc.as<JsonObjectConst>());
      const char* type = normalizeType(doc["type"] | "string");
      if (key && key[0]) {
        if (setOutputFromVariant(key, type, doc["data"])) {
          publishOutputData(key);
        }
      }
      publishHeartbeatAfter = true;
    }

    if (publishHeartbeatAfter) {
      publishHeartbeatNow();
    }
  }

  bool setState(const char* state) {
    bool ok = setStateInternal(state);
    if (ok) publishHeartbeatNow();
    return ok;
  }

  const char* getState() const {
    return state_;
  }

  void restartComplete() {
    if (strcmp(state_, "starting") == 0) {
      setStateInternal("running");
      publishHeartbeatNow();
    }
  }

  const char* getInputValue(const char* key) const {
    int8_t idx = findInput(key);
    if (idx < 0) return NULL;
    if (!inputs_[idx].present) return NULL;
    return inputs_[idx].value;
  }

  const char* getInputType(const char* key) const {
    int8_t idx = findInput(key);
    if (idx < 0) return NULL;
    return inputs_[idx].type;
  }

  bool setOutputFromPuzzle(const char* key, const char* type, const char* value) {
    return setOutputFromText(key, type, value);
  }

  bool sendOutputFromPuzzle(const char* key) {
    return publishOutputData(key);
  }

  void publishAllOutputsFromPuzzle() {
    publishAllOutputs();
  }

  void triggerExternalCheck(const char* value, bool active) {
    if (!publishFn_) return;

    StaticJsonDocument<192> doc;
    doc["active"] = active;
    if (value) {
      doc["variable"] = value;
    } else {
      doc["variable"] = nullptr;
    }
    doc["deviceId"] = deviceId_;

    char payload[192];
    serializeJson(doc, payload, sizeof(payload));

    char topic[96];
    buildTopic("external-check", topic, sizeof(topic));
    publishFn_(topic, payload);
  }

  void setCustomLocal(const char* value) {
    setCustomFromText(value, true);
  }

  const char* getCustomValue() const {
    return customPresent_ ? customValue_ : NULL;
  }

  bool publishCustomFromPuzzle() {
    return publishCustomNow();
  }

  bool publishCustomFromPuzzle(const char* value) {
    setCustomFromText(value, true);
    return publishCustomNow();
  }

  void publishHeartbeatNow() {
    if (!publishFn_) return;

    StaticJsonDocument<192> doc;
    doc["name"] = puzzleName_;
    doc["state"] = state_;
    doc["deviceId"] = deviceId_;

    const char* ip = ipFn_ ? ipFn_() : NULL;
    doc["ip"] = (ip && ip[0]) ? ip : "0.0.0.0";

    char payload[192];
    serializeJson(doc, payload, sizeof(payload));

    char topic[96];
    buildTopic("heartbeat", topic, sizeof(topic));
    publishFn_(topic, payload);
  }

  void getCommandTopic(char* out, size_t outLen) const {
    buildTopic("command", out, outLen);
  }

private:
  struct Entry {
    char key[MAX_KEY_LEN + 1];
    char type[MAX_TYPE_LEN + 1];
    char value[MAX_VALUE_LEN + 1];
    bool present;
  };

  PublishFn publishFn_;
  IpFn ipFn_;

  char deviceId_[MAX_KEY_LEN + 1];
  char puzzleName_[MAX_KEY_LEN + 1];
  char topicPrefix_[MAX_KEY_LEN + 1];
  char state_[16];

  bool needRestart_;
  uint32_t heartbeatIntervalMs_;
  uint32_t lastHeartbeatAt_;

  Entry inputs_[MAX_INPUT_KEYS];
  Entry outputs_[MAX_OUTPUT_KEYS];
  uint8_t inputCount_;
  uint8_t outputCount_;
  char customValue_[MAX_VALUE_LEN + 1];
  bool customPresent_;

  static void safeCopy(char* dest, size_t destLen, const char* src) {
    if (!dest || destLen == 0) return;
    if (!src) {
      dest[0] = '\0';
      return;
    }
    strncpy(dest, src, destLen - 1);
    dest[destLen - 1] = '\0';
  }

  static const char* normalizeType(const char* type) {
    if (!type || !type[0]) return "string";
    if (strcmp(type, "string") == 0) return "string";
    if (strcmp(type, "number") == 0) return "number";
    if (strcmp(type, "boolean") == 0) return "boolean";
    if (strcmp(type, "media") == 0) return "media";
    return "string";
  }

  static bool isTruthyText(const char* value) {
    if (!value) return false;
    return strcmp(value, "1") == 0 || strcmp(value, "true") == 0 || strcmp(value, "TRUE") == 0 || strcmp(value, "yes") == 0;
  }

  static void clearEntries(Entry* entries, uint8_t maxLen) {
    for (uint8_t i = 0; i < maxLen; i++) {
      entries[i].key[0] = '\0';
      safeCopy(entries[i].type, sizeof(entries[i].type), "string");
      entries[i].value[0] = '\0';
      entries[i].present = false;
    }
  }

  void clearData() {
    for (uint8_t i = 0; i < inputCount_; i++) {
      inputs_[i].value[0] = '\0';
      inputs_[i].present = false;
    }
    for (uint8_t i = 0; i < outputCount_; i++) {
      outputs_[i].value[0] = '\0';
      outputs_[i].present = false;
    }
    customValue_[0] = '\0';
    customPresent_ = false;
  }

  int8_t findInput(const char* key) const {
    if (!key || !key[0]) return -1;
    for (uint8_t i = 0; i < inputCount_; i++) {
      if (strcmp(inputs_[i].key, key) == 0) return (int8_t)i;
    }
    return -1;
  }

  int8_t findOutput(const char* key) const {
    if (!key || !key[0]) return -1;
    for (uint8_t i = 0; i < outputCount_; i++) {
      if (strcmp(outputs_[i].key, key) == 0) return (int8_t)i;
    }
    return -1;
  }

  const char* pickKey(JsonObjectConst obj) const {
    const char* key = obj["key"] | "";
    if (key[0]) return key;
    key = obj["type"] | "";
    return key[0] ? key : NULL;
  }

  bool isValidState(const char* s) const {
    if (!s || !s[0]) return false;
    if (strcmp(s, "locked") == 0) return true;
    if (strcmp(s, "starting") == 0) return true;
    if (strcmp(s, "running") == 0) return true;
    if (strcmp(s, "solved") == 0) return true;
    if (strcmp(s, "uploading") == 0) return true;
    if (strcmp(s, "downloading") == 0) return true;
    if (strcmp(s, "active") == 0) return true;
    return false;
  }

  bool setStateInternal(const char* s) {
    if (!isValidState(s)) return false;
    if (strcmp(s, "active") == 0) {
      safeCopy(state_, sizeof(state_), "running");
    } else {
      safeCopy(state_, sizeof(state_), s);
    }
    return true;
  }

  void buildTopic(const char* suffix, char* out, size_t outLen) const {
    if (!out || outLen == 0) return;
    snprintf(out, outLen, "%s/%s/%s", topicPrefix_, deviceId_, suffix);
    out[outLen - 1] = '\0';
  }

  void variantToText(JsonVariantConst src, char* out, size_t outLen) {
    if (!out || outLen == 0) return;
    out[0] = '\0';

    if (src.isNull()) return;

    if (src.is<const char*>()) {
      safeCopy(out, outLen, src.as<const char*>());
      return;
    }
    if (src.is<bool>()) {
      safeCopy(out, outLen, src.as<bool>() ? "true" : "false");
      return;
    }
    if (src.is<long>()) {
      snprintf(out, outLen, "%ld", src.as<long>());
      return;
    }
    if (src.is<unsigned long>()) {
      snprintf(out, outLen, "%lu", src.as<unsigned long>());
      return;
    }
    if (src.is<double>()) {
      double d = src.as<double>();
      snprintf(out, outLen, "%.6f", d);
      trimFloatText(out);
      return;
    }

    serializeJson(src, out, outLen);
  }

  static void trimFloatText(char* text) {
    if (!text) return;
    int len = (int)strlen(text);
    while (len > 0 && text[len - 1] == '0') {
      text[len - 1] = '\0';
      len--;
    }
    if (len > 0 && text[len - 1] == '.') {
      text[len - 1] = '\0';
    }
  }

  void setCustomFromVariant(JsonVariantConst data) {
    variantToText(data, customValue_, sizeof(customValue_));
    customPresent_ = !data.isNull();
  }

  void setCustomFromText(const char* value, bool present) {
    safeCopy(customValue_, sizeof(customValue_), value ? value : "");
    customPresent_ = present;
  }

  void setInputValue(const char* key, const char* type, JsonVariantConst data) {
    int8_t idx = findInput(key);
    if (idx < 0) {
      // Strict mode: ignore unknown inputs.
      return;
    }

    safeCopy(inputs_[idx].type, sizeof(inputs_[idx].type), normalizeType(type));
    variantToText(data, inputs_[idx].value, sizeof(inputs_[idx].value));
    inputs_[idx].present = !data.isNull();
  }

  bool setOutputFromVariant(const char* key, const char* type, JsonVariantConst data) {
    int8_t idx = findOutput(key);
    if (idx < 0) {
      // Must be preconfigured by initKeys.
      return false;
    }

    const char* normalized = normalizeType(type);
    safeCopy(outputs_[idx].type, sizeof(outputs_[idx].type), normalized);

    if (strcmp(normalized, "media") == 0) {
      // Keep same behavior as Node agent: for media, store key as payload value.
      safeCopy(outputs_[idx].value, sizeof(outputs_[idx].value), key);
      outputs_[idx].present = true;
      return true;
    }

    variantToText(data, outputs_[idx].value, sizeof(outputs_[idx].value));
    outputs_[idx].present = !data.isNull();
    return true;
  }

  bool setOutputFromText(const char* key, const char* type, const char* value) {
    int8_t idx = findOutput(key);
    if (idx < 0) return false;

    const char* normalized = normalizeType(type && type[0] ? type : outputs_[idx].type);
    safeCopy(outputs_[idx].type, sizeof(outputs_[idx].type), normalized);

    if (strcmp(normalized, "media") == 0) {
      safeCopy(outputs_[idx].value, sizeof(outputs_[idx].value), key);
      outputs_[idx].present = true;
      return true;
    }

    safeCopy(outputs_[idx].value, sizeof(outputs_[idx].value), value ? value : "");
    outputs_[idx].present = true;
    return true;
  }

  void addTypedValue(JsonDocument& doc, const char* type, const char* value, bool present) {
    if (!present) {
      doc["data"] = nullptr;
      return;
    }

    const char* t = normalizeType(type);

    if (strcmp(t, "boolean") == 0) {
      doc["data"] = isTruthyText(value);
      return;
    }

    if (strcmp(t, "number") == 0) {
      if (!value || !value[0]) {
        doc["data"] = 0;
        return;
      }
      bool hasDot = false;
      for (const char* p = value; *p; p++) {
        if (*p == '.' || *p == 'e' || *p == 'E') {
          hasDot = true;
          break;
        }
      }
      if (hasDot) {
        doc["data"] = atof(value);
      } else {
        doc["data"] = atol(value);
      }
      return;
    }

    doc["data"] = value ? value : "";
  }

  bool publishOutputByIndex(uint8_t idx) {
    if (!publishFn_ || idx >= outputCount_) return false;

    StaticJsonDocument<224> doc;
    doc["key"] = outputs_[idx].key;
    doc["type"] = outputs_[idx].type;
    addTypedValue(doc, outputs_[idx].type, outputs_[idx].value, outputs_[idx].present);

    char payload[224];
    serializeJson(doc, payload, sizeof(payload));

    char topic[96];
    buildTopic("data", topic, sizeof(topic));
    publishFn_(topic, payload);
    return true;
  }

  bool publishCustomNow() {
    if (!publishFn_) return false;
    if (!customPresent_) return false;

    StaticJsonDocument<224> doc;
    doc["value"] = customValue_;
    doc["deviceId"] = deviceId_;

    char payload[224];
    serializeJson(doc, payload, sizeof(payload));

    char topic[96];
    buildTopic("custom", topic, sizeof(topic));
    publishFn_(topic, payload);
    return true;
  }

  bool publishOutputData(const char* key) {
    int8_t idx = findOutput(key);
    if (idx < 0) return false;
    return publishOutputByIndex((uint8_t)idx);
  }

  void publishAllOutputs() {
    for (uint8_t i = 0; i < outputCount_; i++) {
      publishOutputByIndex(i);
    }
  }

  void applyInitKeys(JsonObjectConst payload) {
    Entry oldOutputs[MAX_OUTPUT_KEYS];
    uint8_t oldCount = outputCount_;
    for (uint8_t i = 0; i < oldCount; i++) {
      oldOutputs[i] = outputs_[i];
    }

    inputCount_ = 0;
    outputCount_ = 0;
    clearEntries(inputs_, MAX_INPUT_KEYS);
    clearEntries(outputs_, MAX_OUTPUT_KEYS);

    JsonArrayConst inArr = payload["inputs"].as<JsonArrayConst>();
    if (!inArr.isNull()) {
      for (JsonObjectConst item : inArr) {
        if (inputCount_ >= MAX_INPUT_KEYS) break;
        const char* key = item["key"] | item["type"] | "";
        if (!key[0]) continue;

        safeCopy(inputs_[inputCount_].key, sizeof(inputs_[inputCount_].key), key);
        safeCopy(inputs_[inputCount_].type, sizeof(inputs_[inputCount_].type), normalizeType(item["type"] | "string"));
        inputs_[inputCount_].value[0] = '\0';
        inputs_[inputCount_].present = false;
        inputCount_++;
      }
    }

    JsonArrayConst outArr = payload["outputs"].as<JsonArrayConst>();
    if (!outArr.isNull()) {
      for (JsonObjectConst item : outArr) {
        if (outputCount_ >= MAX_OUTPUT_KEYS) break;
        const char* key = item["key"] | item["type"] | "";
        if (!key[0]) continue;

        safeCopy(outputs_[outputCount_].key, sizeof(outputs_[outputCount_].key), key);
        safeCopy(outputs_[outputCount_].type, sizeof(outputs_[outputCount_].type), normalizeType(item["type"] | "string"));
        outputs_[outputCount_].value[0] = '\0';
        outputs_[outputCount_].present = false;

        for (uint8_t j = 0; j < oldCount; j++) {
          if (strcmp(oldOutputs[j].key, key) == 0) {
            safeCopy(outputs_[outputCount_].value, sizeof(outputs_[outputCount_].value), oldOutputs[j].value);
            outputs_[outputCount_].present = oldOutputs[j].present;
            break;
          }
        }

        outputCount_++;
      }
    }
  }
};

#endif
