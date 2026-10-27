#ifndef SECRETS_H
#define SECRETS_H

// Salin berkas ini menjadi secrets.h, lalu isi semua nilai di bawah.
// secrets.h sudah masuk .gitignore dan TIDAK boleh dibagikan.

// WiFi 2,4 GHz (ESP32 tidak mendukung WiFi 5 GHz).
#define WIFI_SSID "NAMA_WIFI_ANDA"
#define WIFI_PASSWORD "PASSWORD_WIFI_ANDA"

// Firebase Project settings > Web app dan Realtime Database.
#define FIREBASE_API_KEY "API_KEY_WEB_FIREBASE"
#define FIREBASE_DATABASE_URL "https://PROJECT_ID-default-rtdb.asia-southeast1.firebasedatabase.app"

// Akun Firebase Authentication KHUSUS perangkat, bukan akun pemilik website.
#define FIREBASE_USER_EMAIL "esp32-device@example.com"
#define FIREBASE_USER_PASSWORD "PASSWORD_KHUSUS_ESP32"

#endif
