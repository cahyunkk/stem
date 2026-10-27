# 🌱 Smart Irrigation ESP32 + Firebase

Sistem irigasi yang membaca kelembapan tanah dan DHT11, menggerakkan pompa dengan histeresis, serta dapat dipantau dan dikontrol dari internet melalui **Firebase Realtime Database** dan **static website**.

Tidak perlu port forwarding, IP publik, atau membuka port router. ESP32 dan browser sama-sama membuat koneksi keluar ke Firebase.

## Fitur

- Data realtime setiap **4 detik**: soil, `soilRaw`, suhu, kelembapan udara, status pompa, mode, RSSI, uptime, dan timestamp server.
- Mode **Auto** dengan histeresis: pompa ON saat tanah `≤45%`, OFF saat tanah `≥65%`.
- Mode **Manual** dari website dengan konfirmasi sebelum perintah dikirim.
- Fail-safe manual di ESP32:
  - OFF setelah maksimal **10 menit**;
  - OFF bila kontak cloud terputus lebih dari **60 detik**;
  - perintah manual ON lama tidak dijalankan ulang setelah ESP32 restart.
- Riwayat setiap **1 menit**, dipangkas menjadi maksimal **200 entri** oleh firmware.
- LCD 16x2 menampilkan soil, pompa, mode, dan status cloud.
- Login Firebase Authentication; hanya UID pemilik yang dapat mengirim kontrol.
- Monitoring dapat dipilih **publik read-only** atau **wajib login**.
- Website mobile-first, berbahasa Indonesia, dark mode otomatis, dan memiliki **mode demo** tanpa Firebase.
- Endpoint lokal `http://IP_ESP32/data` tetap tersedia untuk debug; dashboard HTML lama sudah dihapus dari firmware.

---

## 1. Struktur folder

```text
stem/
├── firmware/
│   ├── smart_irrigation.ino     # Program ESP32
│   └── secrets.example.h        # Template; salin menjadi secrets.h
├── web/
│   ├── index.html               # Dashboard, login, dan dialog konfirmasi
│   ├── app.js                   # Firebase, realtime, grafik, kontrol, demo
│   ├── style.css                # Tampilan mobile-first dan dark mode
│   ├── config.js                # Firebase web config + opsi aplikasi
│   └── firebase.json            # Deploy Hosting + lokasi Database Rules
├── firebase/
│   ├── database.rules.json      # Default: monitoring publik read-only
│   └── database.rules.private.json # Alternatif: monitoring wajib login
├── .github/workflows/build.yml  # Compile firmware dan validasi file di CI
├── .gitignore                   # Termasuk firmware/secrets.h
└── README.md
```

> **Catatan rekonstruksi:** checkout awal hanya berisi `README.md`; file `.ino` lama tidak tersedia. Firmware dibuat ulang dari pin dan perilaku yang disebutkan dalam spesifikasi. Nilai kalibrasi awal `SOIL_DRY=3200` dan `SOIL_WET=1500` adalah asumsi—kalibrasi wajib dilakukan pada sensor Anda.

## 2. Diagram arsitektur

```text
┌──────────────────────┐
│ Sensor + relay + LCD │
└──────────┬───────────┘
           │
     ┌─────▼─────┐
     │  ESP32    │
     │ akun      │
     │ PERANGKAT │
     └─────┬─────┘
           │ HTTPS / WiFi
           │  • set /device tiap 4 detik
           │  • push + pangkas /history tiap 1 menit
           │  • stream/read /control
           ▼
┌──────────────────────────────┐
│ Firebase Realtime Database   │
│                              │
│ /device    data terbaru      │
│ /history   maksimal 200      │
│ /control   mode + perintah   │
└──────────────▲───────────────┘
               │ HTTPS / WebSocket SDK
               │
       ┌───────┴─────────┐
       │ Static website  │
       │ Firebase Auth   │
       │ akun PEMILIK    │
       └───────┬─────────┘
               │
        HP / laptop dari mana saja
```

Alur kontrol: website menulis `/control` → ESP32 menerima perubahan → ESP32 menjalankan fail-safe dan menggerakkan relay → ESP32 menulis status aktual ke `/device` → kartu website diperbarui. Pesan **“perintah terkirim”** berarti sudah tersimpan di Firebase; status aktual pompa tetap mengacu pada `/device/pump`.

## 3. Coba website sekarang (mode demo)

Tidak perlu Firebase untuk melihat tampilan dan mencoba kontrol simulasi.

```bash
cd web
python3 -m http.server 8000 --bind 0.0.0.0
```

Buka **http://localhost:8000**. Karena `config.js` masih berisi placeholder dan `demoMode="auto"`, website otomatis memakai data dummy. Riwayat demo ditambah lebih cepat agar grafik terlihat hidup; firmware asli tetap menulis setiap 1 menit.

Jangan membuka `index.html` dengan double-click/`file://`, karena browser membatasi ES Module pada protokol tersebut. Selalu gunakan server static lokal atau hosting.

---

# A. Menyiapkan Firebase dari nol

## 4. Buat project Firebase

1. Buka [Firebase Console](https://console.firebase.google.com/).
2. Klik **Add project / Tambahkan project**.
3. Masukkan nama, misalnya `smart-irrigation`.
4. Google Analytics boleh dimatikan agar lebih sederhana.
5. Tunggu project selesai dibuat. Spark Plan/gratis cukup untuk skala satu perangkat dan penggunaan wajar.

## 5. Buat Realtime Database

1. Di menu **Build → Realtime Database**, klik **Create Database**.
2. Pilih lokasi terdekat, misalnya **asia-southeast1 (Singapura)**. Lokasi tidak dapat dipindahkan setelah database dibuat.
3. Pilih **Locked mode**. Rules dari repository akan dipasang kemudian.
4. Setelah jadi, salin **Database URL**. Bentuknya mirip:

   ```text
   https://PROJECT_ID-default-rtdb.asia-southeast1.firebasedatabase.app
   ```

   Jangan menambahkan `/` di akhir nilai pada `secrets.h`/`config.js`.

Struktur data akan dibuat otomatis oleh ESP32 dan website:

| Path | Isi | Penulis |
|---|---|---|
| `/device` | Data sensor terbaru dan `lastUpdate` timestamp server | Akun perangkat |
| `/history/{pushId}` | Snapshot sensor per menit, maksimal 200 | Akun perangkat |
| `/control` | `mode`, `pumpCommand`, `updatedAt` | Akun pemilik; perangkat hanya boleh menulis OFF untuk fail-safe |

## 6. Aktifkan Authentication dan buat dua akun

1. Buka **Build → Authentication → Sign-in method**.
2. Klik **Email/Password**, aktifkan opsi **Email/Password**, lalu simpan. Opsi **Email link** tidak perlu diaktifkan.
3. Buka tab **Users → Add user**, lalu buat:
   - **Akun pemilik**: email yang Anda pakai untuk login website. Gunakan password kuat.
   - **Akun perangkat**: email khusus, misalnya `esp32-device@example.com`. Gunakan password kuat yang **berbeda**.
4. Pada daftar Users, salin **User UID** kedua akun tersebut dan simpan sementara di tempat aman.

Jangan membagikan password akun perangkat. Akun perangkat hanya boleh menulis `/device` dan `/history`, membaca `/control`, serta mengubah `pumpCommand` dari `on` ke `off` untuk fail-safe.

## 7. Isi UID dan pasang Database Rules

Di kedua file rules, ganti seluruh placeholder berikut:

| Placeholder | Ganti dengan |
|---|---|
| `GANTI_UID_PEMILIK` | UID akun pemilik website |
| `GANTI_UID_PERANGKAT` | UID akun khusus ESP32 |

File yang dipakai secara default adalah `firebase/database.rules.json`. Jika memilih monitoring privat, ganti juga `firebase/database.rules.private.json`.

**Penting:** jangan deploy rules yang masih berisi placeholder. Sistem memang gagal-aman/tidak memberi akses, tetapi firmware dan kontrol tidak akan mendapat izin.

Rules memvalidasi tipe dan rentang data. `temperature`/`humidity` boleh tidak ada karena JSON `null` di Realtime Database direpresentasikan sebagai penghapusan field. Timestamp memakai waktu server Firebase, bukan jam ESP32.

### Opsi A — monitoring publik read-only (default)

- Gunakan `firebase/database.rules.json`.
- Pada `web/config.js`, biarkan:

  ```js
  requireAuthForMonitoring: false
  ```

- Siapa pun dengan URL website dapat membaca `/device` dan `/history`, tetapi **tidak dapat menulis**. Kontrol tetap memerlukan login UID pemilik.

### Opsi B — monitoring wajib login

1. Pada `web/config.js`, ubah:

   ```js
   requireAuthForMonitoring: true
   ```

2. Pada `web/firebase.json`, ubah path rules menjadi:

   ```json
   "rules": "../firebase/database.rules.private.json"
   ```

3. Isi UID di file private tersebut dan deploy rules. Mengubah opsi JavaScript saja hanya menyembunyikan tampilan; **rules privat tetap harus dipasang** agar data benar-benar tidak dapat dibaca publik.

### Deploy rules dari Firebase Console (cara pemula)

Buka **Realtime Database → Rules**, salin isi file rules yang dipilih setelah UID diganti, lalu klik **Publish**. Cara CLI tersedia pada bagian deploy.

### Inisialisasi `/control` (opsional)

Website akan membuat path ini saat perintah pertama. Anda juga dapat membuatnya manual lewat Console:

```json
{
  "mode": "auto",
  "pumpCommand": "off",
  "updatedAt": 0
}
```

## 8. Daftarkan Web App dan salin config

1. Buka **Project settings → General → Your apps**.
2. Klik ikon **Web `</>`**, beri nama `smart-irrigation-web`.
3. Firebase Hosting boleh didaftarkan sekarang atau disiapkan lewat CLI nanti.
4. Salin nilai `apiKey`, `authDomain`, `databaseURL`, `projectId`, dan `appId` ke `web/config.js`.

Contoh bentuk file setelah diisi (nilai berikut hanya ilustrasi):

```js
export const firebaseConfig = {
  apiKey: "AIza...",
  authDomain: "kebun-123.firebaseapp.com",
  databaseURL: "https://kebun-123-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "kebun-123",
  appId: "1:1234567890:web:abc123",
};
```

Anda cukup mengganti nilai di file yang tersedia, tidak perlu menyalin contoh ilustrasi ini.

### Mana yang boleh publik dan mana yang rahasia?

| Informasi | Boleh di repository/website? | Keterangan |
|---|---:|---|
| Firebase **web config**: API key web, auth domain, database URL, project ID, app ID | **Ya** | Memang dikirim ke browser. API key ini bukan kunci admin. |
| UID pemilik/perangkat | Umumnya ya | Bukan credential; tetap dibatasi oleh rules. |
| Password WiFi | **Tidak** | Hanya di `firmware/secrets.h`. |
| Email + password akun perangkat | **Tidak untuk passwordnya** | Hanya di `secrets.h` pada komputer/firmware Anda. |
| Password akun pemilik | **Tidak** | Jangan tulis di `config.js`, firmware, atau README. |
| Private key service account / database secret lama | **Tidak; tidak digunakan** | Jangan pernah ditaruh di static website. |

Keamanan diberikan oleh **Authentication + Database Rules**, bukan dengan merahasiakan Firebase web config. File `firmware/secrets.h` sudah dicantumkan di `.gitignore`.

---

# B. Firmware ESP32

## 9. Hardware dan wiring

| Modul | Pin modul | ESP32 / catu | Catatan |
|---|---|---|---|
| Soil moisture analog | AO | **GPIO34** | GPIO34 input-only/ADC |
| Soil moisture | VCC | **3,3V dianjurkan** | Pastikan AO tidak melebihi tegangan ADC |
| Soil moisture | GND | GND | Ground harus common |
| DHT11 | DATA | **GPIO4** | Pull-up 4,7kΩ–10kΩ ke 3,3V jika belum ada di modul |
| DHT11 | VCC | 3,3V | Ikuti spesifikasi modul; jangan beri level 5V pada DATA ESP32 |
| DHT11 | GND | GND | Ground common |
| Relay | IN | **GPIO26** | Sebelumnya GPIO2; GPIO2 adalah strapping pin |
| Relay | VCC | Sesuai modul, sering 5V | Jangan ambil arus pompa dari ESP32 |
| Relay | GND | GND | Ground common sesuai desain modul |
| LCD I2C | SDA | **GPIO21** | Alamat I2C `0x27` |
| LCD I2C | SCL | **GPIO22** | Gunakan level shifter bila backpack memakai pull-up 5V |
| LCD I2C | VCC/GND | Sesuai modul | Banyak backpack 5V memerlukan level shifter I2C |
| Pompa | Catu dan kontak COM/NO relay | Catu pompa terpisah | Pompa tidak pernah dihubungkan langsung ke GPIO |

**Keselamatan:** lepas catu saat merakit. Jika pompa memakai listrik AC/tegangan tinggi, gunakan kotak, kabel, fuse, dan instalasi yang memenuhi standar; minta bantuan teknisi bila belum berpengalaman. Perhatikan isolasi dan wiring optocoupler/JD-VCC pada modul relay Anda.

Relay default adalah **aktif-LOW**: output GPIO26 `LOW` berarti relay aktif. Firmware menulis level OFF sedini mungkin saat boot. GPIO26 dipilih agar tidak mengalami kedip strapping seperti GPIO2.

## 10. Instal Arduino IDE, core, dan library

Gunakan **Arduino IDE 2.x**. Versi berikut dipatok agar hasil build dapat direproduksi:

| Komponen | Nama di Boards/Library Manager | Versi |
|---|---|---:|
| ESP32 core | **esp32 by Espressif Systems** | **3.3.12** |
| Firebase async | **FirebaseClient** by Mobizt | **2.2.13** |
| Dependency TLS | **ESP_SSLClient** | **3.1.3** |
| JSON | **ArduinoJson** by Benoit Blanchon | **7.4.2** |
| DHT | **DHT sensor library** by Adafruit | **1.4.6** |
| Dependency DHT | **Adafruit Unified Sensor** | **1.1.14** |
| LCD | **LiquidCrystal_I2C** by Frank de Brabander | **1.1.2** |

Langkah:

1. Di **File → Preferences → Additional boards manager URLs**, tambahkan:

   ```text
   https://espressif.github.io/arduino-esp32/package_esp32_index.json
   ```

2. Di **Tools → Board → Boards Manager**, cari `esp32`, pilih versi `3.3.12`, lalu install.
3. Di **Sketch → Include Library → Manage Libraries**, install nama dan versi pada tabel. Jika IDE menawarkan dependency, izinkan.
4. Jika ada library LCD lain dengan nama mirip, pilih library Frank de Brabander yang menyediakan class `LiquidCrystal_I2C`.

> Core 3.3.12 digunakan karena firmware memverifikasi sertifikat HTTPS melalui `useBuiltinCACertBundle()`. Jangan memakai `setInsecure()` pada konfigurasi ini.

## 11. Siapkan sketch dan `secrets.h`

Arduino IDE mengharuskan nama folder sketch sama dengan file `.ino` utama. Agar struktur repository tetap rapi:

1. Buat folder sketch lokal bernama `smart_irrigation`, misalnya di `Documents/Arduino/smart_irrigation/`.
2. Salin `firmware/smart_irrigation.ino` ke folder tersebut.
3. Salin `firmware/secrets.example.h` ke folder yang sama, lalu **rename menjadi `secrets.h`**.
4. Buka `.ino` hasil salinan dengan Arduino IDE. Isi `secrets.h`:

   ```cpp
   #define WIFI_SSID "NAMA_WIFI_ANDA"
   #define WIFI_PASSWORD "PASSWORD_WIFI_ANDA"
   #define FIREBASE_API_KEY "API_KEY_WEB_FIREBASE"
   #define FIREBASE_DATABASE_URL "https://PROJECT_ID-default-rtdb.asia-southeast1.firebasedatabase.app"
   #define FIREBASE_USER_EMAIL "esp32-device@example.com"
   #define FIREBASE_USER_PASSWORD "PASSWORD_KHUSUS_ESP32"
   ```

- `FIREBASE_API_KEY` sama dengan API key web pada `config.js`.
- `FIREBASE_USER_EMAIL/PASSWORD` adalah **akun perangkat**, bukan akun pemilik website.
- WiFi harus **2,4 GHz** dan bukan jaringan captive portal yang meminta persetujuan lewat halaman web.
- Jangan commit hasil `secrets.h`. Jika Anda bekerja langsung di folder `firmware`, `.gitignore` sudah melindunginya.

## 12. Upload firmware

1. Hubungkan ESP32 melalui kabel USB data.
2. Pilih **Tools → Board → ESP32 Arduino → ESP32 Dev Module**.
3. Pilih **Port** yang sesuai.
4. Klik **Verify/Compile**, lalu **Upload**. Jika upload berhenti saat `Connecting...`, tahan tombol **BOOT** ketika diminta, lalu lepas setelah proses mulai.
5. Buka **Serial Monitor**, pilih **115200 baud**.
6. Setelah WiFi tersambung, Serial Monitor menampilkan IP ESP32 dan URL debug, misalnya `http://192.168.1.50/data`.
7. Buka URL tersebut dari HP/laptop pada WiFi yang sama untuk memeriksa JSON. Endpoint `/` sengaja tidak menyediakan dashboard.

Contoh potongan `/data` ketika DHT11 gagal dibaca:

```json
{
  "soil": 48,
  "soilRaw": 2384,
  "temperature": null,
  "humidity": null,
  "pump": false,
  "mode": "auto",
  "wifiRssi": -52,
  "uptime": 120,
  "cloudConnected": true
}
```

Data cloud tersimpan di `/device`; `/data` hanya untuk debug lokal dan tidak perlu dibuka ke internet.

## 13. Kalibrasi `SOIL_DRY` dan `SOIL_WET`

Setiap sensor dan tanah memiliki nilai analog berbeda. Kalibrasi mengubah ADC mentah menjadi persen yang bermakna.

1. Upload firmware dan buka `/data` pada browser atau Serial Monitor.
2. Letakkan probe pada **tanah kering** yang menjadi batas kondisi kering Anda. Tunggu pembacaan stabil.
3. Catat `soilRaw` beberapa kali, lalu ambil rata-ratanya sebagai `SOIL_DRY`.
4. Siram tanah sampai kondisi basah target, tanpa merendam bagian elektronik/konektor yang tidak tahan air. Tunggu air merata dan pembacaan stabil.
5. Catat rata-rata `soilRaw` sebagai `SOIL_WET`.
6. Ubah dua konstanta berikut di `.ino`, lalu compile/upload ulang:

   ```cpp
   constexpr int SOIL_DRY = 3200; // ganti hasil kalibrasi kering
   constexpr int SOIL_WET = 1500; // ganti hasil kalibrasi basah
   ```

Rumus firmware secara konseptual:

```text
soil (%) = constrain(map(soilRaw, SOIL_DRY, SOIL_WET, 0, 100), 0, 100)
```

Pada sensor umum, ADC kering lebih besar daripada basah. Pemetaan terbalik sudah didukung. Nilai di luar rentang dibatasi 0–100%. Setelah kalibrasi, uji ambang 45%/65% secara bertahap dan pastikan pompa berhenti pada kondisi yang diharapkan.

---

# C. Website dan deploy

## 14. Konfigurasi website

Edit `web/config.js`:

```js
export const appConfig = {
  demoMode: "auto",                 // auto / always / never
  requireAuthForMonitoring: false, // lihat bagian opsi rules
  offlineAfterSeconds: 30,
  historyLimit: 200,
};
```

Arti `demoMode`:

- `auto`: gunakan demo hanya jika Firebase config belum diisi; setelah config valid, gunakan Firebase.
- `always`: selalu demo meskipun config sudah diisi.
- `never`: jangan gunakan demo; tampilkan peringatan jika config belum diisi.

Website menganggap ESP **Offline** bila `lastUpdate` lebih dari 30 detik. Tombol ON juga dinonaktifkan saat ESP offline agar perintah basi tidak sengaja dijalankan nanti; OFF tetap dapat dikirim pada mode manual.

## 15. Jalankan website lokal dengan Firebase

Setelah `config.js` diisi, jalankan kembali:

```bash
cd web
python3 -m http.server 8000 --bind 0.0.0.0
```

Buka `http://localhost:8000`:

- Default publik: kartu/grafik langsung terlihat; klik **Masuk** untuk kontrol.
- Privat: masuk terlebih dahulu untuk membuka dashboard.
- Pilih **Manual**, konfirmasi, lalu tekan **Nyalakan** atau **Matikan**. Setiap pergantian mode mereset `pumpCommand` ke OFF untuk mencegah pompa menyala tak terduga.

Chart.js dan Firebase SDK dimuat dari CDN resmi. Koneksi internet diperlukan; website bukan aplikasi offline/PWA.

## 16. Deploy ke Firebase Hosting

Prasyarat: Node.js LTS dan npm.

```bash
npm install -g firebase-tools
firebase login
cd web
firebase use --add
```

Saat `firebase use --add`:

1. Pilih project Firebase yang tadi dibuat.
2. Beri alias, misalnya `default`.
3. Perintah membuat `.firebaserc` lokal; file ini diabaikan Git.

Deploy website dan rules yang dipilih:

```bash
firebase deploy
```

Atau deploy terpisah:

```bash
firebase deploy --only hosting
firebase deploy --only database
```

Setelah selesai, CLI menampilkan URL seperti:

```text
https://PROJECT_ID.web.app
```

Buka URL tersebut dari HP yang memakai koneksi berbeda. Login dengan **akun pemilik**, bukan akun perangkat. Domain `web.app` dan `firebaseapp.com` bawaan umumnya sudah menjadi authorized domain Firebase Auth.

## 17. Alternatif Netlify atau Vercel

Website tidak memerlukan build step. Deploy isi folder `web/` sebagai static site.

### Netlify

```bash
npx netlify-cli deploy --dir web --prod
```

Ikuti proses login dan pembuatan site. Anda juga dapat memilih folder `web` sebagai publish directory pada pengaturan Netlify.

### Vercel

```bash
npx vercel web --prod
```

Pilih deploy sebagai static site tanpa framework/build command.

Setelah deploy pada domain lain, buka **Firebase Authentication → Settings → Authorized domains**, lalu tambahkan domain Netlify/Vercel/custom domain tersebut. Jangan menambahkan path, cukup host/domain.

---

# D. Operasi dan keamanan

## 18. Perilaku fail-safe yang perlu diketahui

| Kondisi | Perilaku |
|---|---|
| Mode Auto, internet mati | Histeresis lokal tetap bekerja agar tanah terjaga. |
| Mode Manual ON selama 10 menit | Pompa OFF, command OFF dikirim bila cloud tersedia. |
| Kontak cloud putus >60 detik saat Manual ON | Pompa OFF dan perintah manual dikunci. |
| ESP32 restart dengan `/control` berisi Manual ON lama | ON lama diabaikan dan perangkat meminta OFF; kirim ON baru dari website bila memang diperlukan. |
| Ganti Auto ↔ Manual dari website | `pumpCommand` direset OFF terlebih dahulu. |
| DHT11 gagal dibaca | `temperature`/`humidity` dikirim `null`, website menampilkan `—`, bukan 0 palsu. |

Setelah fail-safe, kirim perintah baru dari website untuk membuka kunci manual. Mode Auto tidak bergantung pada website yang sedang dibuka.

Riwayat 200 entri dengan interval 1 menit mencakup sekitar **3 jam 20 menit**. Pilihan grafik 30 menit/1 jam/3 jam/Semua memfilter data lokal yang sudah diambil. Penyimpanan jangka panjang tidak termasuk proyek ini.

## 19. Troubleshooting

| Gejala | Pemeriksaan dan solusi |
|---|---|
| **WiFi gagal tersambung** | Pastikan SSID/password benar di `secrets.h`, gunakan WiFi 2,4 GHz, dekatkan ESP32 ke router, dan hindari captive portal. Firmware mencoba ulang tiap 15 detik tanpa menghentikan sensor. |
| **IP tidak muncul** | Buka Serial Monitor 115200. Periksa kabel USB data dan driver USB-UART. Tekan BOOT hanya saat upload jika diperlukan. |
| **WiFi OK tetapi data tidak masuk Firebase** | Cocokkan Database URL termasuk region, API key web, email/password akun perangkat, dan `GANTI_UID_PERANGKAT` pada rules. Lihat error `Permission denied`/Auth di Serial Monitor. |
| **Website selalu ESP Offline** | Cek `/device/lastUpdate` di Console dan apakah `/device` berubah tiap 4 detik. Periksa catu ESP32/WiFi. Samakan jam HP/PC ke otomatis karena selisih dihitung terhadap timestamp server. |
| **LCD: `Cloud:AUTH`** | Firebase Auth belum siap atau email/password perangkat salah. Periksa apakah Email/Password sign-in sudah diaktifkan. |
| **LCD: `Cloud:LOST`** | Tidak ada kontak cloud berhasil >60 detik. Periksa internet/rules. Pada Manual ON, fail-safe akan mematikan pompa. |
| **`Permission denied` pada website** | Pastikan login memakai akun pemilik dan `GANTI_UID_PEMILIK` sudah diganti dengan UID yang benar, lalu rules dipublish/dideploy. |
| **Login gagal di domain hosting** | Periksa email/password dan tambahkan host pada Authentication → Settings → Authorized domains. |
| **Pompa manual tidak mau ON** | Login, pilih Manual, pastikan ESP Online, lalu kirim ON baru. ON lama setelah restart sengaja dikunci. Periksa apakah fail-safe 10 menit/60 detik baru aktif. |
| **Relay terbalik (ON/OFF kebalik)** | Putus daya, lalu cek wiring. Default firmware aktif-LOW. Jika modul benar-benar aktif-HIGH, ubah `RELAY_ACTIVE_LEVEL` dari `LOW` menjadi `HIGH` dan uji tanpa pompa dahulu. |
| **Relay berkedip saat boot** | Pastikan IN relay pada **GPIO26**, bukan GPIO2, dan firmware memakai pin baru. Periksa juga pull-up/down bawaan modul relay. |
| **Suhu/kelembapan selalu `null`/`—`** | Cek DATA GPIO4, VCC/GND, pull-up DATA ke 3,3V, dan kualitas kabel DHT11. Pembacaan dilakukan tiap 2 detik; ganti sensor untuk membandingkan. |
| **Soil selalu 0% atau 100%** | Lakukan kalibrasi `SOIL_DRY`/`SOIL_WET`, cek AO pada GPIO34, gunakan tegangan sensor yang sesuai, dan pastikan ground common. |
| **Grafik kosong** | Riwayat pertama dibuat setelah sekitar 1 menit. Periksa `/history`, izin baca rules, koneksi CDN Chart.js, dan pilih rentang **Semua**. |
| **Website kosong saat dibuka sebagai file** | Jangan gunakan `file://`; jalankan server static atau deploy hosting. |
| **Compile error `useBuiltinCACertBundle` tidak ditemukan** | Update/pilih core **esp32 by Espressif 3.3.12**, bukan core lama atau board core pihak lain. |
| **Riwayat melebihi 200 sementara** | Setelah push, firmware mengambil daftar key dan menghapus kelebihan secara async. Jika pruning gagal, periksa izin akun perangkat/rules; siklus berikutnya mencoba lagi. |

## 20. Validasi proyek

Repository menyediakan GitHub Actions **Build dan validasi** yang:

- memasang core ESP32 `3.3.12` dan versi library pada tabel;
- membuat `secrets.h` sementara dari template hanya di runner CI;
- compile dengan FQBN `esp32:esp32:esp32` (**ESP32 Dev Module**);
- memeriksa sintaks JavaScript dan JSON serta memastikan `secrets.h` tidak ikut repository.

Untuk pemeriksaan website secara lokal:

```bash
node --check web/app.js
node --check web/config.js
python3 -m json.tool web/firebase.json
python3 -m json.tool firebase/database.rules.json
```

Pengujian pada perangkat fisik tetap diperlukan: polaritas relay, kalibrasi sensor, kualitas catu, serta fail-safe harus diuji tanpa beban berbahaya terlebih dahulu.

---

## Checklist nilai yang masih harus Anda isi

- [ ] `web/config.js`: Firebase web config dari Web App.
- [ ] `firmware/secrets.h`: SSID, password WiFi, API key web, Database URL, email/password akun perangkat.
- [ ] Rules: `GANTI_UID_PEMILIK` dan `GANTI_UID_PERANGKAT`.
- [ ] `SOIL_DRY` dan `SOIL_WET`: hasil kalibrasi sensor sendiri.
- [ ] Project pada `firebase use --add` saat deploy.

## Asumsi dan keputusan desain

1. Satu ESP32 memakai path tetap `/device`, `/history`, dan `/control`; multi-perangkat belum dipisahkan per ID.
2. Monitoring default publik read-only; opsi privat disediakan dengan rules terpisah.
3. Relay aktif-LOW, sensor membaca nilai ADC 12-bit, dan kalibrasi awal hanya contoh.
4. Fail-safe koneksi diterapkan pada **pompa manual**; mode Auto tetap berfungsi lokal saat internet mati.
5. Untuk keamanan tambahan, perintah Manual ON yang tersimpan tidak dilanjutkan setelah reboot.
6. Website vanilla tanpa build framework; Firebase SDK, Chart.js, dan font memakai CDN, dengan fallback system font.
7. Kredensial asli tidak pernah disimpan di repository. Firebase web config boleh publik, sedangkan password WiFi/akun perangkat tidak.
