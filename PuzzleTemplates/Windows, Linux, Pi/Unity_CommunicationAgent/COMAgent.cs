using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using MQTTnet;
using MQTTnet.Client;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

public static class COMAgent
{
    
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
    // -------------------------
    // Project-specific settings
    // -------------------------
    // Configure these values for your puzzle.     

    public static string HUB_HOST = "HUB_HOST_IP";                        // example ip. change to hub ip
    public static string MQTT_BROKER = HUB_HOST;
    public static int MQTT_PORT = 1883;
    public static string DEVICE_ID = "unity-puzzle-1";                    // used for internal identification
    public static string PUZZLE_NAME = "Unity Puzzle";                    // used for identification in HUB UI
    public static bool NEED_RESTART = false;                   
    public static int HEARTBEAT_INTERVAL_MS = 2000;

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    // functions that can be called externally

    // COMAgent.start();                               // has to be called once to setup agent
    // COMAgent.run();                                 // has to be called in main puzzle loop

    // COMAgent.getState();                            // returns state of puzzle as String
    // COMAgent.setState("solved");                    // sets and sends state to hub. Possible States: "locked", "running", "solved", "starting"
    // COMAgent.stateChanged();                        // returns true if state has changed since last call, else false

    // COMAgent.sendCustom("putStringHere");           // sends custom string to hub
    // COMAgent.getCustom();                           // returns the current custom value as string without deleting it
    // COMAgent.customAvailable();                     // returns true if a custom value is currently available
    // COMAgent.deleteCustom();                        // deletes the current custom value

    // COMAgent.getInput("key");                       // returns the current input as string without deleting it
    // COMAgent.inputAvailable("key");                 // returns true if the input currently exists
    // COMAgent.deleteInput("key");                    // deletes the current input value for the given key

    // COMAgent.setOutput("key", "value");             // sets a string output internally. "key" must fit to the name given to the output in the hub UI.
    // COMAgent.sendOutput("key");                     // sends the output with the name "key" etc to the hub
    // COMAgent.sendAllOutputs();                      // sends all set outputs to the hub

    // COMAgent.triggerExternalCheck("1234", true);    // triggers the hub external check. can be used to check if the player has solved the puzzle / has got the right password out of it. the last value (true = bool) triggers the check. with false it can be deactivated

    // COMAgent.restartComplete();                     // signals to hub that restart is completed (only necassary when need restart is configured)

    // COMAgent.setMedia("fileName", "filePath");      // copies file into MEDIA_LOCAL_DIR and assigns it to the media key
    // COMAgent.sendMedia("fileName");                 // starts a background media upload to the hub. "fileName" has to fit to Input Media name in hub UI
    // COMAgent.getMedia("fileName");                  // returns local path if media is ready, else empty string
    // COMAgent.deleteMedia("fileName");               // deletes media from local storage

///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    // dont change anything from here up on ///////////////////////////////////////////////////////////////////////////////

    public static string MEDIA_SERVER = "";
    public static string MEDIA_LOCAL_DIR = "MediaStorage";
    public static string MQTT_TOPIC_PREFIX = "puzzle";

    private const string StateLocked = "locked";
    private const string StateStarting = "starting";
    private const string StateRunning = "running";
    private const string StateSolved = "solved";

    private static readonly object SyncRoot = new object();
    private static readonly HttpClient Http = new HttpClient();
    private static readonly Dictionary<string, DataEntry> Inputs = new Dictionary<string, DataEntry>();
    private static readonly Dictionary<string, DataEntry> Outputs = new Dictionary<string, DataEntry>();
    private static readonly Dictionary<string, string> MediaPaths = new Dictionary<string, string>();
    private static readonly HashSet<string> PendingMediaDownloads = new HashSet<string>();
    private static readonly Queue<MqttApplicationMessage> PendingMessages = new Queue<MqttApplicationMessage>();

    private static IMqttClient _mqttClient;
    private static MqttClientOptions _mqttOptions;
    private static long _lastHeartbeatMs;
    private static long _lastConnectAttemptMs;
    private static string _state = StateLocked;
    private static string _lastState = StateLocked;
    private static string _lastCustomValue = "";
    private static bool _started;
    private static bool _connecting;
    private static bool _publishing;

    private static string CommandTopic => $"{MQTT_TOPIC_PREFIX}/{DEVICE_ID}/command";
    private static string MediaBaseUrl => string.IsNullOrWhiteSpace(MEDIA_SERVER)
        ? $"http://{HUB_HOST}"
        : MEDIA_SERVER.TrimEnd('/');

    private sealed class DataEntry
    {
        public string Type;
        public object Data;
        public bool Present;

        public DataEntry(string type, object data, bool present)
        {
            Type = string.IsNullOrWhiteSpace(type) ? "string" : type;
            Data = data;
            Present = present;
        }

        public static DataEntry empty(string type)
        {
            return new DataEntry(type, null, false);
        }
    }

    public static void start()
    {
        Directory.CreateDirectory(MEDIA_LOCAL_DIR);
        EnsureClient();
        ConnectIfNeeded();
        publishHeartbeatNow();
        _started = true;
    }

    public static void run()
    {
        if (!_started)
        {
            start();
            return;
        }

        ConnectIfNeeded();
        var now = NowMs();
        if (now - _lastHeartbeatMs >= HEARTBEAT_INTERVAL_MS)
        {
            publishHeartbeatNow();
        }
    }

    public static string getState()
    {
        lock (SyncRoot)
        {
            return _state;
        }
    }

    public static bool setState(string state)
    {
        if (!IsValidState(state))
        {
            return false;
        }

        lock (SyncRoot)
        {
            _lastState = _state;
            _state = state;
        }

        publishHeartbeatNow();
        return true;
    }

    public static bool stateChanged()
    {
        lock (SyncRoot)
        {
            if (_state == _lastState)
            {
                return false;
            }

            _lastState = _state;
            return true;
        }
    }

    public static string getInput(string key)
    {
        lock (SyncRoot)
        {
            return Inputs.TryGetValue(key, out var entry) && entry.Present ? ValueToString(entry.Data) : "";
        }
    }

    public static bool inputAvailable(string key)
    {
        lock (SyncRoot)
        {
            return Inputs.TryGetValue(key, out var entry) && entry.Present;
        }
    }

    public static void deleteInput(string key)
    {
        lock (SyncRoot)
        {
            if (!Inputs.TryGetValue(key, out var entry))
            {
                return;
            }

            entry.Data = null;
            entry.Present = false;
        }
    }

    public static string getInputType(string key)
    {
        lock (SyncRoot)
        {
            return Inputs.TryGetValue(key, out var entry) ? entry.Type : "string";
        }
    }

    public static bool setOutput(string key, object value)
    {
        lock (SyncRoot)
        {
            Outputs[key] = new DataEntry("string", ValueToString(value), true);
        }

        return true;
    }

    public static bool sendOutput(string key)
    {
        DataEntry entry;
        lock (SyncRoot)
        {
            if (!Outputs.TryGetValue(key, out entry) || !entry.Present)
            {
                return false;
            }
        }

        return Publish(BuildTopic("data"), new Dictionary<string, object>
        {
            ["key"] = key,
            ["type"] = entry.Type,
            ["data"] = entry.Data,
            ["deviceId"] = DEVICE_ID
        });
    }

    public static bool sendAllOutputs()
    {
        List<string> keys;
        lock (SyncRoot)
        {
            keys = Outputs.Where(pair => pair.Value.Present).Select(pair => pair.Key).ToList();
        }

        var ok = true;
        foreach (var key in keys)
        {
            ok = sendOutput(key) && ok;
        }

        return ok;
    }

    public static bool sendCustom(object value)
    {
        return Publish(BuildTopic("custom"), new Dictionary<string, object>
        {
            ["value"] = value,
            ["deviceId"] = DEVICE_ID
        });
    }

    public static string getCustom()
    {
        lock (SyncRoot)
        {
            return _lastCustomValue;
        }
    }

    public static bool customAvailable()
    {
        lock (SyncRoot)
        {
            return !string.IsNullOrEmpty(_lastCustomValue);
        }
    }

    public static void deleteCustom()
    {
        lock (SyncRoot)
        {
            _lastCustomValue = "";
        }
    }

    public static bool triggerExternalCheck(string value, bool active = true)
    {
        return Publish(BuildTopic("external-check"), new Dictionary<string, object>
        {
            ["active"] = active,
            ["variable"] = value,
            ["deviceId"] = DEVICE_ID
        });
    }

    public static bool restartComplete()
    {
        return setState(NEED_RESTART ? StateRunning : StateLocked);
    }

    public static string resolveMedia(string name)
    {
        if (string.IsNullOrWhiteSpace(name))
        {
            return "";
        }

        try
        {
            var url = $"{MediaBaseUrl}/api/media/resolve?name={Uri.EscapeDataString(name)}";
            var body = Http.GetStringAsync(url).GetAwaiter().GetResult();
            var json = JObject.Parse(body);
            return json.Value<string>("path") ??
                   json.Value<string>("url") ??
                   json.Value<string>("file") ??
                   json.Value<string>("name") ??
                   "";
        }
        catch
        {
            return name;
        }
    }

    public static string downloadMedia(string remoteName, string localPath = null)
    {
        if (string.IsNullOrWhiteSpace(remoteName))
        {
            return "";
        }

        Directory.CreateDirectory(MEDIA_LOCAL_DIR);
        var resolved = resolveMedia(remoteName);
        var fileName = Path.GetFileName(string.IsNullOrWhiteSpace(resolved) ? remoteName : resolved);
        if (string.IsNullOrWhiteSpace(fileName))
        {
            fileName = remoteName;
        }

        localPath = string.IsNullOrWhiteSpace(localPath)
            ? Path.Combine(MEDIA_LOCAL_DIR, fileName)
            : localPath;

        try
        {
            var url = resolved.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
                      resolved.StartsWith("https://", StringComparison.OrdinalIgnoreCase)
                ? resolved
                : $"{MediaBaseUrl}/{resolved.TrimStart('/')}";

            var bytes = Http.GetByteArrayAsync(url).GetAwaiter().GetResult();
            File.WriteAllBytes(localPath, bytes);
            return localPath;
        }
        catch
        {
            return "";
        }
    }

    public static string uploadMedia(string localPath, string remoteName = null)
    {
        if (string.IsNullOrWhiteSpace(localPath) || !File.Exists(localPath))
        {
            return "";
        }

        try
        {
            remoteName = string.IsNullOrWhiteSpace(remoteName) ? Path.GetFileName(localPath) : remoteName;
            using (var form = new MultipartFormDataContent())
            using (var stream = File.OpenRead(localPath))
            {
                form.Add(new StreamContent(stream), "file", remoteName);
                var response = Http.PostAsync($"{MediaBaseUrl}/api/media/upload", form).GetAwaiter().GetResult();
                var body = response.Content.ReadAsStringAsync().GetAwaiter().GetResult();
                if (!response.IsSuccessStatusCode)
                {
                    return "";
                }

                if (string.IsNullOrWhiteSpace(body))
                {
                    return remoteName;
                }

                try
                {
                    var json = JObject.Parse(body);
                    return json.Value<string>("name") ??
                           json.Value<string>("file") ??
                           json.Value<string>("path") ??
                           remoteName;
                }
                catch
                {
                    return remoteName;
                }
            }
        }
        catch
        {
            return "";
        }
    }

    public static string getMedia(string key)
    {
        if (string.IsNullOrWhiteSpace(key))
        {
            return "";
        }

        lock (SyncRoot)
        {
            if (MediaPaths.TryGetValue(key, out var readyPath) && File.Exists(readyPath))
            {
                return readyPath;
            }

            if (Outputs.TryGetValue(key, out var outputEntry) &&
                string.Equals(outputEntry.Type, "media", StringComparison.OrdinalIgnoreCase))
            {
                var localOutputPath = FindLocalMediaByKey(key);
                return File.Exists(localOutputPath) ? localOutputPath : "";
            }

            if (!Inputs.TryGetValue(key, out var entry) || !entry.Present)
            {
                return "";
            }
        }

        return "";
    }

    public static bool setMedia(string key, string sourcePath)
    {
        if (string.IsNullOrWhiteSpace(key) || string.IsNullOrWhiteSpace(sourcePath) || !File.Exists(sourcePath))
        {
            return false;
        }

        Directory.CreateDirectory(MEDIA_LOCAL_DIR);
        var targetPath = Path.Combine(MEDIA_LOCAL_DIR, Path.GetFileName(sourcePath));
        var sourceFull = Path.GetFullPath(sourcePath);
        var targetFull = Path.GetFullPath(targetPath);

        try
        {
            if (!string.Equals(sourceFull, targetFull, StringComparison.OrdinalIgnoreCase))
            {
                File.Copy(sourcePath, targetPath, true);
            }

            lock (SyncRoot)
            {
                MediaPaths[key] = targetPath;
                Outputs[key] = new DataEntry("media", key, true);
            }

            return true;
        }
        catch
        {
            return false;
        }
    }

    public static bool sendMedia(string key)
    {
        var localPath = FindLocalMediaByKey(key);
        if (string.IsNullOrWhiteSpace(localPath) || !File.Exists(localPath))
        {
            return false;
        }

        var remoteName = uploadMedia(localPath);
        if (string.IsNullOrWhiteSpace(remoteName))
        {
            return false;
        }

        lock (SyncRoot)
        {
            Outputs[key] = new DataEntry("media", key, true);
            MediaPaths[key] = localPath;
        }
        return sendOutput(key);
    }

    public static bool deleteMedia(string key)
    {
        var path = FindLocalMediaByKey(key);
        lock (SyncRoot)
        {
            MediaPaths.Remove(key);
            Outputs[key] = new DataEntry("media", "", false);
        }

        if (!string.IsNullOrWhiteSpace(path) && File.Exists(path))
        {
            try
            {
                File.Delete(path);
            }
            catch
            {
                return false;
            }
        }

        return true;
    }

    public static void stop()
    {
        if (_mqttClient == null)
        {
            return;
        }

        try
        {
            if (_mqttClient.IsConnected)
            {
                _ = _mqttClient.DisconnectAsync();
            }
        }
        catch
        {
            // Ignore shutdown errors.
        }
    }

    private static void EnsureClient()
    {
        if (_mqttClient != null)
        {
            return;
        }

        var factory = new MqttFactory();
        _mqttClient = factory.CreateMqttClient();
        _mqttOptions = new MqttClientOptionsBuilder()
            .WithClientId($"agent-{DEVICE_ID}")
            .WithTcpServer(MQTT_BROKER, MQTT_PORT)
            .WithCleanSession()
            .Build();

        _mqttClient.ConnectedAsync += async _ =>
        {
            await _mqttClient.SubscribeAsync(CommandTopic);
            publishHeartbeatNow();
            DrainPublishQueue();
        };

        _mqttClient.ApplicationMessageReceivedAsync += message =>
        {
            var payload = message.ApplicationMessage.Payload == null
                ? ""
                : Encoding.UTF8.GetString(message.ApplicationMessage.Payload);
            HandleCommand(payload);
            return Task.CompletedTask;
        };
    }

    private static void ConnectIfNeeded()
    {
        EnsureClient();
        if (_mqttClient.IsConnected || _connecting)
        {
            return;
        }

        var now = NowMs();
        if (now - _lastConnectAttemptMs < 1000)
        {
            return;
        }

        _lastConnectAttemptMs = now;
        _connecting = true;
        _ = ConnectAsyncNoBlock();
    }

    private static async Task ConnectAsyncNoBlock()
    {
        try
        {
            if (_mqttClient != null && !_mqttClient.IsConnected)
            {
                await _mqttClient.ConnectAsync(_mqttOptions, CancellationToken.None);
            }
        }
        catch
        {
            // Keep Unity running even when the hub is temporarily unavailable.
        }
        finally
        {
            _connecting = false;
        }
    }

    private static void HandleCommand(string payload)
    {
        if (string.IsNullOrWhiteSpace(payload))
        {
            return;
        }

        JObject doc;
        try
        {
            doc = JObject.Parse(payload);
        }
        catch
        {
            return;
        }

        var action = doc.Value<string>("action") ?? "";
        switch (action)
        {
            case "setState":
                setState(doc.Value<string>("state") ?? getState());
                break;

            case "restart":
                lock (SyncRoot)
                {
                    ClearDataLocked();
                    _lastState = _state;
                    _state = NEED_RESTART ? StateStarting : StateRunning;
                }
                publishHeartbeatNow();
                break;

            case "clearData":
                lock (SyncRoot)
                {
                    ClearDataLocked();
                }
                break;

            case "initKeys":
                ApplyInitKeys(doc);
                break;

            case "sendParam":
            case "requestData":
                ReceiveParam(doc);
                break;

            case "sendOutput":
                sendOutput(doc.Value<string>("key") ?? "");
                break;

            case "sendCustom":
                lock (SyncRoot)
                {
                    _lastCustomValue = ValueToString(doc["value"] ?? doc["data"] ?? doc["custom"]);
                }
                break;
        }
    }

    private static void ApplyInitKeys(JObject doc)
    {
        lock (SyncRoot)
        {
            ApplyKeyArray(doc["inputs"] as JArray, Inputs);
            ApplyKeyArray(doc["outputs"] as JArray, Outputs);
        }
    }

    private static void ApplyKeyArray(JArray items, Dictionary<string, DataEntry> target)
    {
        if (items == null)
        {
            return;
        }

        var old = new Dictionary<string, DataEntry>(target);
        target.Clear();
        foreach (var item in items.OfType<JObject>())
        {
            var key = item.Value<string>("key") ?? item.Value<string>("name") ?? "";
            if (string.IsNullOrWhiteSpace(key))
            {
                continue;
            }

            var type = item.Value<string>("type") ?? "string";
            if (old.TryGetValue(key, out var previous))
            {
                target[key] = new DataEntry(type, previous.Data, previous.Present);
            }
            else
            {
                target[key] = DataEntry.empty(type);
            }
        }
    }

    private static void ReceiveParam(JObject doc)
    {
        var key = doc.Value<string>("key") ?? doc.Value<string>("name") ?? "";
        if (string.IsNullOrWhiteSpace(key))
        {
            return;
        }

        var type = doc.Value<string>("type") ?? "string";
        var dataToken = doc["data"] ?? doc["value"];

        var coerced = CoerceToken(type, dataToken);
        lock (SyncRoot)
        {
            Inputs[key] = new DataEntry(type, coerced, true);
        }

        if (string.Equals(type, "media", StringComparison.OrdinalIgnoreCase))
        {
            var mediaReference = ValueToString(coerced);
            if (!string.IsNullOrWhiteSpace(mediaReference))
            {
                ScheduleMediaDownload(key, mediaReference);
            }
        }
    }

    private static void ClearDataLocked()
    {
        foreach (var key in Inputs.Keys.ToList())
        {
            Inputs[key] = DataEntry.empty(Inputs[key].Type);
        }

        foreach (var key in Outputs.Keys.ToList())
        {
            Outputs[key] = DataEntry.empty(Outputs[key].Type);
        }

        MediaPaths.Clear();
        PendingMediaDownloads.Clear();
        _lastCustomValue = "";
    }

    private static bool publishHeartbeatNow()
    {
        _lastHeartbeatMs = NowMs();
        return Publish(BuildTopic("heartbeat"), new Dictionary<string, object>
        {
            ["name"] = PUZZLE_NAME,
            ["state"] = getState(),
            ["deviceId"] = DEVICE_ID,
            ["ip"] = GetLocalIp(),
            ["needRestart"] = NEED_RESTART
        });
    }

    private static bool Publish(string topic, object payload)
    {
        try
        {
            var json = JsonConvert.SerializeObject(payload);
            var message = new MqttApplicationMessageBuilder()
                .WithTopic(topic)
                .WithPayload(json)
                .Build();

            lock (SyncRoot)
            {
                PendingMessages.Enqueue(message);
                while (PendingMessages.Count > 50)
                {
                    PendingMessages.Dequeue();
                }
            }

            ConnectIfNeeded();
            DrainPublishQueue();
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static void DrainPublishQueue()
    {
        if (_publishing)
        {
            return;
        }

        _publishing = true;
        _ = PublishQueuedMessagesAsync();
    }

    private static async Task PublishQueuedMessagesAsync()
    {
        try
        {
            while (true)
            {
                MqttApplicationMessage message = null;
                lock (SyncRoot)
                {
                    if (PendingMessages.Count > 0 && _mqttClient != null && _mqttClient.IsConnected)
                    {
                        message = PendingMessages.Dequeue();
                    }
                }

                if (message == null)
                {
                    return;
                }

                await _mqttClient.PublishAsync(message, CancellationToken.None);
            }
        }
        catch
        {
            // A later heartbeat/run call will retry the connection.
        }
        finally
        {
            _publishing = false;
        }
    }

    private static string BuildTopic(string suffix)
    {
        return $"{MQTT_TOPIC_PREFIX}/{DEVICE_ID}/{suffix}";
    }

    private static object CoerceToken(string type, JToken token)
    {
        if (token == null || token.Type == JTokenType.Null)
        {
            return "";
        }

        return CoerceValue(type, token.Type == JTokenType.String ? token.Value<string>() : token.ToObject<object>());
    }

    private static object CoerceValue(string type, object value)
    {
        return ValueToString(value);
    }

    private static string ValueToString(object value)
    {
        if (value == null)
        {
            return "";
        }

        if (value is JToken token)
        {
            return token.Type == JTokenType.String ? token.Value<string>() : token.ToString(Formatting.None);
        }

        if (value is IFormattable formattable)
        {
            return formattable.ToString(null, CultureInfo.InvariantCulture);
        }

        return value.ToString();
    }

    private static bool IsValidState(string state)
    {
        return state == StateLocked ||
               state == StateStarting ||
               state == StateRunning ||
               state == StateSolved;
    }

    private static string FindLocalMedia(string name)
    {
        if (string.IsNullOrWhiteSpace(name) || !Directory.Exists(MEDIA_LOCAL_DIR))
        {
            return "";
        }

        var exact = Path.Combine(MEDIA_LOCAL_DIR, Path.GetFileName(name));
        if (File.Exists(exact))
        {
            return exact;
        }

        var baseName = Path.GetFileNameWithoutExtension(name);
        if (string.IsNullOrWhiteSpace(baseName))
        {
            return "";
        }

        return Directory.GetFiles(MEDIA_LOCAL_DIR)
            .FirstOrDefault(path => string.Equals(Path.GetFileNameWithoutExtension(path), baseName, StringComparison.OrdinalIgnoreCase)) ?? "";
    }

    private static string FindLocalMediaByKey(string key)
    {
        return FindLocalMedia(key);
    }

    private static void ScheduleMediaDownload(string key, string remoteName)
    {
        lock (SyncRoot)
        {
            if (PendingMediaDownloads.Contains(key))
            {
                return;
            }
            PendingMediaDownloads.Add(key);
        }

        Directory.CreateDirectory(MEDIA_LOCAL_DIR);
        Task.Run(() =>
        {
            try
            {
                var localPath = downloadMedia(remoteName);
                if (!string.IsNullOrWhiteSpace(localPath) && File.Exists(localPath))
                {
                    lock (SyncRoot)
                    {
                        MediaPaths[key] = localPath;
                    }
                }
            }
            finally
            {
                lock (SyncRoot)
                {
                    PendingMediaDownloads.Remove(key);
                }
            }
        });
    }

    private static string GetLocalIp()
    {
        try
        {
            using (var socket = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp))
            {
                socket.Connect(HUB_HOST, 80);
                return ((System.Net.IPEndPoint)socket.LocalEndPoint).Address.ToString();
            }
        }
        catch
        {
            return "0.0.0.0";
        }
    }

    private static long NowMs()
    {
        return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }
}

 //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////


