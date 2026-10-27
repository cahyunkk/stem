/*
 * Smart Irrigation ESP32 + Firebase Realtime Database
 * Board : ESP32 Dev Module (esp32:esp32:esp32)
 * Core  : esp32 oleh Espressif 3.3.12
 *
 * Semua pekerjaan berkala memakai millis(). Operasi Firebase memakai API async;
 * tidak ada while untuk menunggu WiFi/Firebase di setup() maupun loop().
 *
 * Wiring ringkas (semua GND modul dan ESP32 harus common):
 * - Soil AO -> GPIO34; sensor dianjurkan 3,3V agar AO tidak melebihi ADC.
 * - DHT11 DATA -> GPIO4 + pull-up 4,7k-10k ke 3,3V.
 * - Relay IN -> GPIO26 (bukan GPIO2); relay memakai catu sesuai modulnya.
 * - LCD SDA/SCL -> GPIO21/22; gunakan level shifter bila backpack LCD 5V.
 * Pompa/motor WAJIB lewat kontak relay dan catu sendiri, bukan dari pin ESP32.
 */

#define ENABLE_USER_AUTH
#define ENABLE_DATABASE

#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WebServer.h>
#include <Wire.h>
#include <DHT.h>
#include <LiquidCrystal_I2C.h>
#include <ArduinoJson.h>
#include <FirebaseClient.h>
#include "secrets.h"

// ------------------------- Konfigurasi perangkat -------------------------
constexpr uint8_t SOIL_PIN = 34;       // ADC input-only, output analog sensor.
constexpr uint8_t DHT_PIN = 4;         // DATA DHT11, pull-up 4,7k-10k ke 3,3V.
constexpr uint8_t RELAY_PIN = 26;      // IN relay; JANGAN pindah kembali ke GPIO2.
constexpr uint8_t LCD_SDA_PIN = 21;
constexpr uint8_t LCD_SCL_PIN = 22;
constexpr uint8_t RELAY_ACTIVE_LEVEL = LOW; // Relay aktif-LOW: OFF saat pin HIGH.

constexpr int SOIL_DRY = 3200; // Ganti dengan rata-rata soilRaw saat tanah kering.
constexpr int SOIL_WET = 1500; // Ganti dengan rata-rata soilRaw saat tanah basah.
constexpr int SOIL_PUMP_ON = 45;
constexpr int SOIL_PUMP_OFF = 65;

constexpr uint32_t SENSOR_INTERVAL_MS = 2000;
constexpr uint32_t TELEMETRY_INTERVAL_MS = 4000;
constexpr uint32_t HISTORY_INTERVAL_MS = 60000;
constexpr uint32_t LCD_INTERVAL_MS = 1000;
constexpr uint32_t WIFI_RETRY_INTERVAL_MS = 15000;
constexpr uint32_t CLOUD_FAILSAFE_MS = 60000;
constexpr uint32_t MANUAL_MAX_ON_MS = 10UL * 60UL * 1000UL;
constexpr size_t HISTORY_MAX_ENTRIES = 200;

DHT dht(DHT_PIN, DHT11);
LiquidCrystal_I2C lcd(0x27, 16, 2);
WebServer localServer(80);

using AsyncClient = AsyncClientClass;
WiFiClientSecure sslClient;
WiFiClientSecure streamSslClient;
AsyncClient aClient(sslClient);
AsyncClient streamClient(streamSslClient);
UserAuth userAuth(FIREBASE_API_KEY, FIREBASE_USER_EMAIL, FIREBASE_USER_PASSWORD, 3000);
FirebaseApp app;
RealtimeDatabase database;

int soilRaw = 0;
int soilPercent = 0;
float temperature = NAN;
float humidity = NAN;
bool pumpOn = false;
String controlMode = "auto";
bool pumpCommandOn = false;
bool manualSafetyLock = false;
bool safetyOffPending = false;
bool safetyWriteInFlight = false;
bool hasReceivedControl = false;
uint64_t controlUpdatedAt = 0;
unsigned long manualPumpStartedMs = 0;
unsigned long lastCloudContactMs = 0;
unsigned long lastSensorMs = 0;
unsigned long lastTelemetryMs = 0;
unsigned long lastHistoryMs = 0;
unsigned long lastLcdMs = 0;
unsigned long lastWifiAttemptMs = 0;
unsigned long lastSafetyRetryMs = 0;
bool telemetryInFlight = false;
bool controlStreamStarted = false;
bool wifiWasConnected = false;

enum HistoryState { HISTORY_IDLE, HISTORY_PUSHING, HISTORY_LISTING, HISTORY_SELECTING, HISTORY_PRUNING };
HistoryState historyState = HISTORY_IDLE;

// ------------------------- Deklarasi fungsi -------------------------
void authCallback(AsyncResult &result);
void telemetryCallback(AsyncResult &result);
void historyCallback(AsyncResult &result);
void controlCallback(AsyncResult &result);
void safetyCallback(AsyncResult &result);
void readSensors();
void updatePump(unsigned long now);
void setPump(bool on);
void triggerManualSafety(const char *reason);
void applyControlPayload(const String &path, const char *payload);
void sendTelemetry();
void sendHistory();
void maintainWifi(unsigned long now);
void maintainCloud(unsigned long now);
void updateLcd(unsigned long now);
void serveLocalData();
void serveNotFound();
String makeSensorJson(bool withServerTimestamp, bool historyEntry);
void printAsyncError(const char *task, AsyncResult &result);

void setup() {
  Serial.begin(115200);

  // Matikan relay sedini mungkin. GPIO26 bukan strapping pin seperti GPIO2.
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, RELAY_ACTIVE_LEVEL == LOW ? HIGH : LOW);

  analogReadResolution(12);
  analogSetPinAttenuation(SOIL_PIN, ADC_11db);
  dht.begin();
  Wire.begin(LCD_SDA_PIN, LCD_SCL_PIN);
  lcd.init();
  lcd.backlight();
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("Smart Irrigation");
  lcd.setCursor(0, 1);
  lcd.print("Menghubungkan...");

  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  lastWifiAttemptMs = millis();

  // Sertifikat server diverifikasi memakai bundle CA bawaan ESP32 core 3.3.x.
  sslClient.useBuiltinCACertBundle();
  streamSslClient.useBuiltinCACertBundle();
  sslClient.setConnectionTimeout(3000);
  streamSslClient.setConnectionTimeout(3000);
  sslClient.setHandshakeTimeout(5);
  streamSslClient.setHandshakeTimeout(5);
  streamClient.setSSEFilters("get,put,patch,keep-alive,cancel,auth_revoked");

  initializeApp(aClient, app, getAuth(userAuth), authCallback, "authTask");
  app.getApp<RealtimeDatabase>(database);
  database.url(FIREBASE_DATABASE_URL);

  localServer.on("/data", HTTP_GET, serveLocalData);
  localServer.onNotFound(serveNotFound);
  localServer.begin();

  lastCloudContactMs = millis();
  readSensors();
  Serial.println(F("ESP32 siap. Debug lokal: http://IP_ESP32/data"));
}

void loop() {
  const unsigned long now = millis();

  // Selalu panggil loop async, termasuk saat WiFi sedang reconnect.
  app.loop();
  maintainWifi(now);
  maintainCloud(now);
  localServer.handleClient();

  if (now - lastSensorMs >= SENSOR_INTERVAL_MS) {
    lastSensorMs = now;
    readSensors();
  }

  updatePump(now);

  if (now - lastLcdMs >= LCD_INTERVAL_MS) {
    lastLcdMs = now;
    updateLcd(now);
  }

  if (now - lastTelemetryMs >= TELEMETRY_INTERVAL_MS) {
    lastTelemetryMs = now;
    sendTelemetry();
  }

  if (now - lastHistoryMs >= HISTORY_INTERVAL_MS) {
    lastHistoryMs = now;
    sendHistory();
  }

  // Tidak ada delay(); yield memberi kesempatan task RTOS ESP32 berjalan.
  yield();
}

void readSensors() {
  soilRaw = analogRead(SOIL_PIN);
  soilPercent = constrain(map(soilRaw, SOIL_DRY, SOIL_WET, 0, 100), 0, 100);

  const float newTemperature = dht.readTemperature();
  const float newHumidity = dht.readHumidity();
  // NaN disimpan apa adanya dan dikirim sebagai null, bukan angka 0 palsu.
  temperature = isnan(newTemperature) ? NAN : newTemperature;
  humidity = isnan(newHumidity) ? NAN : newHumidity;
}

void setPump(bool on) {
  if (pumpOn == on) return;
  pumpOn = on;
  const uint8_t inactiveLevel = RELAY_ACTIVE_LEVEL == LOW ? HIGH : LOW;
  digitalWrite(RELAY_PIN, on ? RELAY_ACTIVE_LEVEL : inactiveLevel);
  Serial.printf("Pompa fisik: %s\n", on ? "ON" : "OFF");
}

void updatePump(unsigned long now) {
  if (controlMode == "manual") {
    const bool cloudTimedOut = now - lastCloudContactMs > CLOUD_FAILSAFE_MS;
    const bool manualTimedOut = manualPumpStartedMs != 0 &&
                                now - manualPumpStartedMs >= MANUAL_MAX_ON_MS;

    if (pumpCommandOn && !manualSafetyLock && cloudTimedOut) {
      triggerManualSafety("Koneksi cloud terputus >60 detik");
    } else if (pumpCommandOn && !manualSafetyLock && manualTimedOut) {
      triggerManualSafety("Batas manual 10 menit tercapai");
    }

    if (pumpCommandOn && !manualSafetyLock && !pumpOn) {
      if (manualPumpStartedMs == 0) manualPumpStartedMs = now;
      setPump(true);
    } else if ((!pumpCommandOn || manualSafetyLock) && pumpOn) {
      setPump(false);
    }

    if (!pumpCommandOn || manualSafetyLock) manualPumpStartedMs = 0;
    return;
  }

  // Mode auto tetap menjaga tanah saat internet mati, dengan histeresis asli.
  manualPumpStartedMs = 0;
  if (soilPercent <= SOIL_PUMP_ON) setPump(true);
  else if (soilPercent >= SOIL_PUMP_OFF) setPump(false);
}

void triggerManualSafety(const char *reason) {
  manualSafetyLock = true;
  pumpCommandOn = false;
  manualPumpStartedMs = 0;
  safetyOffPending = true;
  setPump(false);
  Serial.printf("FAIL-SAFE: %s. Pompa manual dimatikan.\n", reason);
}

void maintainWifi(unsigned long now) {
  if (WiFi.status() == WL_CONNECTED) {
    if (!wifiWasConnected) {
      wifiWasConnected = true;
      Serial.printf("WiFi tersambung. IP: %s, RSSI: %d dBm\n",
                    WiFi.localIP().toString().c_str(), WiFi.RSSI());
      Serial.printf("Debug JSON lokal: http://%s/data\n",
                    WiFi.localIP().toString().c_str());
    }
    return;
  }
  wifiWasConnected = false;
  if (now - lastWifiAttemptMs < WIFI_RETRY_INTERVAL_MS) return;

  lastWifiAttemptMs = now;
  Serial.println(F("WiFi terputus; mencoba ulang tanpa memblokir loop..."));
  WiFi.disconnect(false, false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

void maintainCloud(unsigned long now) {
  if (WiFi.status() != WL_CONNECTED || !app.ready()) return;

  if (!controlStreamStarted) {
    controlStreamStarted = true;
    database.get(streamClient, "/control", controlCallback, true, "controlStream");
  }

  if (safetyOffPending && !safetyWriteInFlight && now - lastSafetyRetryMs >= 10000) {
    lastSafetyRetryMs = now;
    safetyWriteInFlight = true;
    // Rules hanya mengizinkan akun perangkat mengubah pumpCommand on -> off.
    database.set<String>(aClient, "/control/pumpCommand", "off", safetyCallback, "safetyOff");
  }
}

String makeSensorJson(bool withServerTimestamp, bool historyEntry) {
  JsonDocument doc;
  doc["soil"] = soilPercent;
  doc["soilRaw"] = soilRaw;
  if (isnan(temperature)) doc["temperature"] = nullptr;
  else doc["temperature"] = temperature;
  if (isnan(humidity)) doc["humidity"] = nullptr;
  else doc["humidity"] = humidity;
  doc["pump"] = pumpOn;
  doc["mode"] = controlMode;

  if (historyEntry) {
    if (withServerTimestamp) doc["timestamp"][".sv"] = "timestamp";
  } else {
    doc["wifiRssi"] = WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0;
    doc["uptime"] = millis() / 1000UL;
    if (withServerTimestamp) doc["lastUpdate"][".sv"] = "timestamp";
  }

  String json;
  serializeJson(doc, json);
  return json;
}

void sendTelemetry() {
  if (telemetryInFlight || WiFi.status() != WL_CONNECTED || !app.ready()) return;
  telemetryInFlight = true;
  const String json = makeSensorJson(true, false);
  database.set<object_t>(aClient, "/device", object_t(json), telemetryCallback, "telemetry");
}

void sendHistory() {
  if (historyState != HISTORY_IDLE || WiFi.status() != WL_CONNECTED || !app.ready()) return;
  historyState = HISTORY_PUSHING;
  const String json = makeSensorJson(true, true);
  database.push<object_t>(aClient, "/history", object_t(json), historyCallback, "historyPush");
}

void telemetryCallback(AsyncResult &result) {
  if (result.isError()) {
    telemetryInFlight = false;
    printAsyncError("Telemetry", result);
    return;
  }
  if (!result.available()) return;

  telemetryInFlight = false;
  lastCloudContactMs = millis();
}

void historyCallback(AsyncResult &result) {
  const String task = result.uid();
  if (result.isError()) {
    printAsyncError(task.c_str(), result);
    historyState = HISTORY_IDLE;
    return;
  }
  if (!result.available()) return;

  lastCloudContactMs = millis();

  if (task == "historyPush") {
    // shallow=true hanya mengambil daftar key, bukan seluruh isi 200 entri.
    DatabaseOptions options;
    options.shallow = true;
    historyState = HISTORY_LISTING;
    database.get(aClient, "/history", options, historyCallback, "historyList");
    return;
  }

  if (task == "historyList") {
    JsonDocument doc;
    if (deserializeJson(doc, result.c_str())) {
      historyState = HISTORY_IDLE;
      return;
    }
    const size_t count = doc.as<JsonObject>().size();
    if (count <= HISTORY_MAX_ENTRIES) {
      historyState = HISTORY_IDLE;
      return;
    }

    // Push ID berurutan secara waktu. Ambil hanya key paling lama yang berlebih.
    DatabaseOptions options;
    options.filter.orderBy("$key").limitToFirst(static_cast<int>(count - HISTORY_MAX_ENTRIES));
    historyState = HISTORY_SELECTING;
    database.get(aClient, "/history", options, historyCallback, "historyOldest");
    return;
  }

  if (task == "historyOldest") {
    JsonDocument doc;
    if (deserializeJson(doc, result.c_str())) {
      historyState = HISTORY_IDLE;
      return;
    }

    String patch = "{";
    bool first = true;
    for (JsonPair entry : doc.as<JsonObject>()) {
      if (!first) patch += ',';
      first = false;
      patch += '"';
      patch += entry.key().c_str();
      patch += "\":null";
    }
    patch += '}';

    if (patch.length() <= 2) {
      historyState = HISTORY_IDLE;
      return;
    }

    historyState = HISTORY_PRUNING;
    database.update<object_t>(aClient, "/history", object_t(patch), historyCallback, "historyPrune");
    return;
  }

  if (task == "historyPrune") historyState = HISTORY_IDLE;
}

void controlCallback(AsyncResult &result) {
  if (result.isError()) {
    printAsyncError("Control stream", result);
    return;
  }
  if (!result.available()) return;

  RealtimeDatabaseResult &stream = result.to<RealtimeDatabaseResult>();
  if (!stream.isStream()) return;

  const String event = stream.event();
  if (event != "put" && event != "patch") return;

  lastCloudContactMs = millis();
  applyControlPayload(stream.dataPath(), stream.to<const char *>());
}

void applyControlPayload(const String &path, const char *payload) {
  JsonDocument doc;
  if (deserializeJson(doc, payload)) return;

  const bool firstSnapshot = !hasReceivedControl;
  const uint64_t previousTimestamp = controlUpdatedAt;
  bool receivedOff = false;

  if (path == "/" || path.length() == 0) {
    JsonObject object = doc.as<JsonObject>();
    if (object.isNull()) return;

    if (object["mode"].is<const char *>()) {
      const String mode = object["mode"].as<const char *>();
      if (mode == "auto" || mode == "manual") controlMode = mode;
    }
    if (object["pumpCommand"].is<const char *>()) {
      const String command = object["pumpCommand"].as<const char *>();
      if (command == "on" || command == "off") {
        pumpCommandOn = command == "on";
        receivedOff = command == "off";
      }
    }
    if (object["updatedAt"].is<uint64_t>()) {
      controlUpdatedAt = object["updatedAt"].as<uint64_t>();
    }
  } else if (path == "/mode" && doc.is<const char *>()) {
    const String mode = doc.as<const char *>();
    if (mode == "auto" || mode == "manual") controlMode = mode;
  } else if (path == "/pumpCommand" && doc.is<const char *>()) {
    const String command = doc.as<const char *>();
    if (command == "on" || command == "off") {
      pumpCommandOn = command == "on";
      receivedOff = command == "off";
    }
  } else if (path == "/updatedAt" && doc.is<uint64_t>()) {
    controlUpdatedAt = doc.as<uint64_t>();
  } else {
    return;
  }

  hasReceivedControl = true;
  const bool newCommand = controlUpdatedAt != previousTimestamp && controlUpdatedAt > 0;

  // Perintah ON yang tersimpan sebelum boot tidak dijalankan ulang. Ini mencegah
  // siklus 10 menit baru setiap ESP32 restart. Kirim ulang ON dari website.
  if (firstSnapshot && controlMode == "manual" && pumpCommandOn) {
    manualSafetyLock = true;
    pumpCommandOn = false;
    safetyOffPending = true;
  } else if (newCommand) {
    manualSafetyLock = false;
    safetyOffPending = false;
    if (controlMode == "manual" && pumpCommandOn) manualPumpStartedMs = millis();
  }

  if (receivedOff) {
    manualPumpStartedMs = 0;
    if (!manualSafetyLock) safetyOffPending = false;
  }

  Serial.printf("Kontrol: mode=%s, pumpCommand=%s, lock=%s\n",
                controlMode.c_str(), pumpCommandOn ? "on" : "off",
                manualSafetyLock ? "ya" : "tidak");
}

void safetyCallback(AsyncResult &result) {
  if (result.isError()) {
    safetyWriteInFlight = false;
    printAsyncError("Safety OFF", result);
    return;
  }
  if (!result.available()) return;

  safetyWriteInFlight = false;
  safetyOffPending = false;
  lastCloudContactMs = millis();
}

void authCallback(AsyncResult &result) {
  if (result.isError()) printAsyncError("Firebase Auth", result);
}

void printAsyncError(const char *task, AsyncResult &result) {
  Serial.printf("[%s] error %d: %s\n", task, result.error().code(),
                result.error().message().c_str());
}

void updateLcd(unsigned long now) {
  String line1 = "Soil:" + String(soilPercent) + "% P:";
  line1 += pumpOn ? "ON" : "OFF";

  String line2;
  if (WiFi.status() != WL_CONNECTED) line2 = "WiFi:OFF ";
  else if (!app.ready()) line2 = "Cloud:AUTH ";
  else if (now - lastCloudContactMs > CLOUD_FAILSAFE_MS) line2 = "Cloud:LOST ";
  else line2 = "Cloud:OK ";
  line2 += controlMode == "manual" ? "MAN" : "AUTO";

  while (line1.length() < 16) line1 += ' ';
  while (line2.length() < 16) line2 += ' ';
  lcd.setCursor(0, 0);
  lcd.print(line1.substring(0, 16));
  lcd.setCursor(0, 1);
  lcd.print(line2.substring(0, 16));
}

void serveLocalData() {
  JsonDocument doc;
  deserializeJson(doc, makeSensorJson(false, false));
  doc["cloudConnected"] = WiFi.status() == WL_CONNECTED && app.ready() &&
                          millis() - lastCloudContactMs <= CLOUD_FAILSAFE_MS;
  doc["manualSafetyLock"] = manualSafetyLock;
  String json;
  serializeJson(doc, json);
  localServer.sendHeader("Access-Control-Allow-Origin", "*");
  localServer.send(200, "application/json", json);
}

void serveNotFound() {
  localServer.send(404, "application/json",
                   "{\"error\":\"Endpoint tidak ditemukan. Gunakan /data\"}");
}
