// Firebase web config MEMANG aman dipublikasikan. Proteksi data dilakukan oleh
// Authentication dan Realtime Database Rules, bukan dengan menyembunyikan API key.
// Isi nilai berikut dari Firebase Console > Project settings > Your apps > Web app.
export const firebaseConfig = {
  apiKey: "MASUKKAN_API_KEY_WEB",
  authDomain: "PROJECT_ID.firebaseapp.com",
  databaseURL: "https://PROJECT_ID-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "PROJECT_ID",
  appId: "MASUKKAN_APP_ID",
};

export const appConfig = {
  // "auto": demo jika config belum diisi; "always": selalu demo; "never": wajib Firebase.
  demoMode: "auto",

  // false = monitoring publik read-only (default rules).
  // true  = dashboard baru dibuka setelah login. Gunakan juga database.rules.private.json.
  requireAuthForMonitoring: false,

  offlineAfterSeconds: 30,
  historyLimit: 200,
};

export function isFirebaseConfigured() {
  const required = ["apiKey", "authDomain", "databaseURL", "projectId", "appId"];
  return required.every((key) => {
    const value = firebaseConfig[key];
    return (
      typeof value === "string" &&
      value.length > 0 &&
      !value.includes("MASUKKAN") &&
      !value.includes("PROJECT_ID")
    );
  });
}
