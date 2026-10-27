import { appConfig, firebaseConfig, isFirebaseConfigured } from "./config.js";

const FIREBASE_VERSION = "10.14.1";
const $ = (id) => document.getElementById(id);
const elements = {
  authDialog: $("auth-dialog"),
  authError: $("auth-error"),
  authGate: $("auth-gate"),
  authHeaderButton: $("auth-header-button"),
  chartMessage: $("chart-message"),
  confirmDialog: $("confirm-dialog"),
  confirmMessage: $("confirm-message"),
  confirmAccept: $("confirm-accept"),
  controlFeedback: $("control-feedback"),
  controlLock: $("control-lock"),
  dashboard: $("dashboard-content"),
  demoBadge: $("demo-badge"),
  deviceStatus: $("device-status"),
  deviceStatusText: $("device-status-text"),
  lastUpdate: $("last-update"),
  loginForm: $("login-form"),
  loginSubmit: $("login-submit"),
  modeAuto: $("mode-auto"),
  modeManual: $("mode-manual"),
  pumpOff: $("pump-off"),
  pumpOn: $("pump-on"),
};

const state = {
  auth: null,
  chart: null,
  control: { mode: "auto", pumpCommand: "off" },
  controlUnsubscribe: null,
  db: null,
  demo: false,
  demoControl: { mode: "auto", pumpCommand: "off" },
  demoHistoryTimer: 0,
  demoManualStartedAt: 0,
  device: null,
  firebase: null,
  history: [],
  monitoringStarted: false,
  monitoringUnsubscribers: [],
  pendingCommand: false,
  range: 60,
  user: null,
};

const relativeTime = new Intl.RelativeTimeFormat("id", { numeric: "auto" });
const shortTime = new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit" });
const fullDateTime = new Intl.DateTimeFormat("id-ID", {
  dateStyle: "medium",
  timeStyle: "medium",
});
let confirmResolver = null;

function isDeviceOnline(device = state.device) {
  if (!device || !Number.isFinite(device.lastUpdate)) return false;
  return Date.now() - device.lastUpdate <= appConfig.offlineAfterSeconds * 1000;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatRelativeTime(timestamp) {
  if (!Number.isFinite(timestamp)) return "belum pernah";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 5) return "baru saja";
  if (seconds < 60) return `${seconds} detik lalu`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return relativeTime.format(-minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return relativeTime.format(-hours, "hour");
  return relativeTime.format(-Math.floor(hours / 24), "day");
}

function formatUptime(value) {
  const seconds = finiteNumber(value);
  if (seconds === null) return "—";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}h ${hours}j`;
  if (hours > 0) return `${hours}j ${minutes}m`;
  return `${minutes}m ${Math.floor(seconds % 60)}d`;
}

function renderDevice() {
  const device = state.device;
  const soil = finiteNumber(device?.soil);
  const soilRaw = finiteNumber(device?.soilRaw);
  const temperature = finiteNumber(device?.temperature);
  const humidity = finiteNumber(device?.humidity);
  const rssi = finiteNumber(device?.wifiRssi);
  const pump = device?.pump === true;

  $("soil-value").textContent = soil === null ? "—" : Math.round(soil);
  $("soil-raw").textContent = soilRaw === null ? "—" : Math.round(soilRaw);
  $("temperature-value").textContent = temperature === null ? "—" : temperature.toFixed(1);
  $("humidity-value").textContent = humidity === null ? "—" : Math.round(humidity);
  $("wifi-rssi").textContent = rssi === null ? "—" : `${Math.round(rssi)} dBm`;
  $("uptime").textContent = formatUptime(device?.uptime);
  $("current-mode").textContent = device?.mode === "manual" ? "manual" : device?.mode === "auto" ? "otomatis" : "—";

  const safeSoil = Math.max(0, Math.min(100, soil ?? 0));
  $("soil-progress-bar").style.width = `${safeSoil}%`;
  $("soil-progress").setAttribute("aria-valuenow", String(Math.round(safeSoil)));
  $("soil-progress").setAttribute("aria-valuetext", soil === null ? "Data tidak tersedia" : `${Math.round(safeSoil)} persen`);
  $("soil-condition").textContent = soil === null ? "—" : soil <= 45 ? "Perlu air" : soil >= 65 ? "Cukup air" : "Stabil";

  $("pump-value").textContent = device ? (pump ? "ON" : "OFF") : "—";
  $("pump-indicator").textContent = device ? (pump ? "Menyala" : "Berhenti") : "Menunggu";
  $("pump-card").classList.toggle("is-on", Boolean(device && pump));

  renderOnlineStatus();
  renderControl();
}

function renderOnlineStatus() {
  const online = isDeviceOnline();
  const hasTimestamp = Number.isFinite(state.device?.lastUpdate);
  elements.deviceStatus.classList.toggle("is-online", online);
  elements.deviceStatus.classList.toggle("is-offline", !online);
  elements.deviceStatusText.textContent = online ? "ESP Online" : hasTimestamp ? "ESP Offline" : "Menghubungkan";
  elements.lastUpdate.textContent = hasTimestamp
    ? `Diperbarui ${formatRelativeTime(state.device.lastUpdate)}`
    : "Menunggu data pertama dari ESP32…";
  if (hasTimestamp) elements.lastUpdate.title = fullDateTime.format(new Date(state.device.lastUpdate));
}

function handleDeviceData(data) {
  state.device = data && typeof data === "object" ? data : null;
  renderDevice();
}

function handleHistoryData(data) {
  const entries = data && typeof data === "object" ? Object.values(data) : [];
  state.history = entries
    .filter((entry) => entry && Number.isFinite(entry.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-appConfig.historyLimit);
  renderChart();
}

function filteredHistory() {
  if (state.range === "all") return state.history;
  const cutoff = Date.now() - Number(state.range) * 60 * 1000;
  return state.history.filter((entry) => entry.timestamp >= cutoff);
}

function chartColors() {
  const styles = getComputedStyle(document.documentElement);
  return {
    text: styles.getPropertyValue("--muted").trim(),
    border: styles.getPropertyValue("--border").trim(),
    soil: styles.getPropertyValue("--primary").trim(),
    temperature: "#dc8b3d",
    humidity: "#4e9fc2",
  };
}

function renderChart() {
  const points = filteredHistory();
  if (!window.Chart) {
    elements.chartMessage.textContent = "Grafik belum termuat. Periksa koneksi ke CDN Chart.js.";
    elements.chartMessage.hidden = false;
    return;
  }

  if (state.chart) {
    state.chart.destroy();
    state.chart = null;
  }

  if (points.length === 0) {
    elements.chartMessage.textContent = state.history.length
      ? "Tidak ada data pada rentang waktu ini."
      : "Belum ada riwayat. ESP32 menambahkan data setiap menit.";
    elements.chartMessage.hidden = false;
    return;
  }
  elements.chartMessage.hidden = true;

  const colors = chartColors();
  const labels = points.map((entry) => shortTime.format(new Date(entry.timestamp)));
  const values = (key) => points.map((entry) => finiteNumber(entry[key]));
  const context = $("history-chart").getContext("2d");

  state.chart = new window.Chart(context, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Tanah",
          data: values("soil"),
          borderColor: colors.soil,
          backgroundColor: colors.soil,
          yAxisID: "percent",
          unit: "%",
          borderWidth: 2.5,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.3,
          spanGaps: false,
        },
        {
          label: "Suhu",
          data: values("temperature"),
          borderColor: colors.temperature,
          backgroundColor: colors.temperature,
          yAxisID: "temperature",
          unit: "°C",
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.3,
          spanGaps: false,
        },
        {
          label: "Udara",
          data: values("humidity"),
          borderColor: colors.humidity,
          backgroundColor: colors.humidity,
          yAxisID: "percent",
          unit: "%",
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.3,
          spanGaps: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          position: "bottom",
          labels: { color: colors.text, usePointStyle: true, pointStyle: "line", boxWidth: 24, padding: 18 },
        },
        tooltip: {
          callbacks: {
            title: (items) => points[items[0].dataIndex]
              ? fullDateTime.format(new Date(points[items[0].dataIndex].timestamp))
              : "",
            label: (item) => item.raw === null
              ? `${item.dataset.label}: tidak tersedia`
              : `${item.dataset.label}: ${Number(item.raw).toFixed(1)} ${item.dataset.unit}`,
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: colors.text, maxTicksLimit: 6, maxRotation: 0 },
          border: { color: colors.border },
        },
        percent: {
          min: 0,
          max: 100,
          position: "left",
          title: { display: true, text: "%", color: colors.text },
          grid: { color: colors.border },
          ticks: { color: colors.text, stepSize: 25 },
          border: { display: false },
        },
        temperature: {
          beginAtZero: true,
          suggestedMax: 40,
          position: "right",
          title: { display: true, text: "°C", color: colors.text },
          grid: { drawOnChartArea: false },
          ticks: { color: colors.text },
          border: { display: false },
        },
      },
    },
  });
}

function canControl() {
  return state.demo || Boolean(state.user);
}

function renderControl() {
  const allowed = canControl();
  const manual = state.control.mode === "manual";
  const online = isDeviceOnline();
  const pending = state.pendingCommand;

  elements.modeAuto.disabled = !allowed || pending;
  elements.modeManual.disabled = !allowed || pending;
  // ON sengaja ditolak saat ESP offline agar perintah basi tidak dijalankan nanti.
  elements.pumpOn.disabled = !allowed || pending || !manual || !online || state.control.pumpCommand === "on";
  elements.pumpOff.disabled = !allowed || pending || !manual || state.control.pumpCommand === "off";

  for (const [button, mode] of [[elements.modeAuto, "auto"], [elements.modeManual, "manual"]]) {
    const active = state.control.mode === mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }

  elements.controlLock.textContent = state.demo ? "Simulasi" : state.user ? "Akses pemilik" : "🔒 Perlu login";
}

function setControlFeedback(message, type = "") {
  elements.controlFeedback.textContent = message;
  elements.controlFeedback.classList.toggle("is-success", type === "success");
  elements.controlFeedback.classList.toggle("is-error", type === "error");
}

function updateAuthUi() {
  elements.authHeaderButton.textContent = state.user ? "Keluar" : "Masuk";
  const privateMode = appConfig.requireAuthForMonitoring && !state.demo;
  elements.authGate.hidden = !privateMode || Boolean(state.user);
  elements.dashboard.hidden = privateMode && !state.user;

  if (state.demo) setControlFeedback("Mode demo aktif — perintah hanya simulasi di browser dan tidak menggerakkan pompa.");
  else if (state.user) setControlFeedback(`Masuk sebagai ${state.user.email}. Perintah akan dikirim ke Firebase.`);
  else setControlFeedback("Masuk sebagai pemilik untuk membuka kontrol.");
  renderControl();
}

function showToast(message, type = "success") {
  const toast = document.createElement("div");
  toast.className = `toast${type === "error" ? " is-error" : ""}`;
  toast.textContent = message;
  $("toast-region").append(toast);
  window.setTimeout(() => toast.remove(), 4500);
}

function askConfirmation(message, acceptLabel = "Ya, kirim") {
  if (confirmResolver) settleConfirmation(false);
  elements.confirmMessage.textContent = message;
  elements.confirmAccept.textContent = acceptLabel;
  elements.confirmDialog.showModal();
  return new Promise((resolve) => {
    confirmResolver = resolve;
  });
}

function settleConfirmation(value) {
  if (!confirmResolver) return;
  const resolve = confirmResolver;
  confirmResolver = null;
  if (elements.confirmDialog.open) elements.confirmDialog.close();
  resolve(value);
}

async function requestMode(mode) {
  if (!canControl() || state.control.mode === mode) return;
  const label = mode === "auto" ? "Otomatis" : "Manual";
  const approved = await askConfirmation(
    `Ubah ke mode ${label}? Perintah pompa manual akan direset ke OFF untuk keamanan.`,
    `Ubah ke ${label}`,
  );
  if (approved) await sendCommand({ mode, pumpCommand: "off" }, `Mode ${label}`);
}

async function requestPump(command) {
  if (!canControl() || state.control.mode !== "manual") return;
  const approved = await askConfirmation(
    command === "on"
      ? "Nyalakan pompa sekarang? Fail-safe akan mematikannya setelah maksimal 10 menit."
      : "Matikan pompa sekarang?",
    command === "on" ? "Ya, nyalakan" : "Ya, matikan",
  );
  if (approved) await sendCommand({ mode: "manual", pumpCommand: command }, command === "on" ? "Pompa ON" : "Pompa OFF");
}

async function sendCommand(desired, label) {
  if (state.pendingCommand) return;
  state.pendingCommand = true;
  setControlFeedback(`Mengirim perintah ${label}…`);
  renderControl();

  try {
    if (state.demo) {
      await new Promise((resolve) => window.setTimeout(resolve, 350));
      state.demoControl = { ...desired };
      state.control = { ...desired };
      if (desired.mode === "manual" && desired.pumpCommand === "on") state.demoManualStartedAt = Date.now();
      if (desired.pumpCommand === "off" || desired.mode === "auto") state.demoManualStartedAt = 0;
      simulateDemoTick();
    } else {
      if (!state.db || !state.firebase) throw new Error("Firebase belum siap. Coba beberapa saat lagi.");
      const { ref, serverTimestamp, update } = state.firebase;
      await update(ref(state.db, "control"), {
        mode: desired.mode,
        pumpCommand: desired.pumpCommand,
        updatedAt: serverTimestamp(),
      });
    }
    setControlFeedback(`${label} berhasil dikirim. Menunggu status aktual dari ESP32.`, "success");
    showToast(`Perintah ${label} terkirim.`);
  } catch (error) {
    const message = friendlyError(error);
    setControlFeedback(message, "error");
    showToast(message, "error");
  } finally {
    state.pendingCommand = false;
    renderControl();
  }
}

function friendlyError(error) {
  const code = error?.code || "";
  const messages = {
    "auth/invalid-credential": "Email atau kata sandi salah.",
    "auth/invalid-email": "Format email tidak valid.",
    "auth/user-disabled": "Akun ini dinonaktifkan di Firebase Authentication.",
    "auth/too-many-requests": "Terlalu banyak percobaan. Tunggu beberapa menit lalu coba lagi.",
    "auth/network-request-failed": "Jaringan bermasalah. Periksa koneksi internet.",
    "PERMISSION_DENIED": "Izin ditolak. Periksa UID pemilik/perangkat dan Database Rules.",
  };
  return messages[code] || (code.includes("permission") ? messages.PERMISSION_DENIED : error?.message || "Terjadi kesalahan. Silakan coba lagi.");
}

async function loadFirebase() {
  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
  const [appModule, authModule, databaseModule] = await Promise.all([
    import(`${base}/firebase-app.js`),
    import(`${base}/firebase-auth.js`),
    import(`${base}/firebase-database.js`),
  ]);

  const app = appModule.initializeApp(firebaseConfig);
  state.auth = authModule.getAuth(app);
  state.db = databaseModule.getDatabase(app);
  state.firebase = { ...appModule, ...authModule, ...databaseModule };

  authModule.onAuthStateChanged(state.auth, (user) => {
    state.user = user;
    updateAuthUi();
    if (user) {
      startMonitoring();
      startControlListener();
    } else {
      stopControlListener();
      if (appConfig.requireAuthForMonitoring) stopMonitoring();
      startMonitoring();
    }
  });
}

function startMonitoring() {
  if (state.monitoringStarted || state.demo || !state.db || !state.firebase) return;
  if (appConfig.requireAuthForMonitoring && !state.user) return;
  state.monitoringStarted = true;
  const { ref, onValue, query, orderByKey, limitToLast } = state.firebase;

  const deviceUnsubscribe = onValue(
    ref(state.db, "device"),
    (snapshot) => handleDeviceData(snapshot.val()),
    (error) => {
      showToast(friendlyError(error), "error");
      elements.lastUpdate.textContent = "Data tidak dapat dibaca. Periksa konfigurasi dan rules.";
    },
  );

  const historyQuery = query(
    ref(state.db, "history"),
    orderByKey(),
    limitToLast(appConfig.historyLimit),
  );
  const historyUnsubscribe = onValue(
    historyQuery,
    (snapshot) => handleHistoryData(snapshot.val()),
    (error) => {
      showToast(friendlyError(error), "error");
      elements.chartMessage.textContent = "Riwayat tidak dapat dibaca. Periksa Database Rules.";
      elements.chartMessage.hidden = false;
    },
  );
  state.monitoringUnsubscribers = [deviceUnsubscribe, historyUnsubscribe];
}

function stopMonitoring() {
  for (const unsubscribe of state.monitoringUnsubscribers) unsubscribe();
  state.monitoringUnsubscribers = [];
  state.monitoringStarted = false;
  if (appConfig.requireAuthForMonitoring) {
    state.device = null;
    state.history = [];
    renderDevice();
    renderChart();
  }
}

function startControlListener() {
  if (state.controlUnsubscribe || !state.user || state.demo) return;
  const { ref, onValue } = state.firebase;
  state.controlUnsubscribe = onValue(
    ref(state.db, "control"),
    (snapshot) => {
      const value = snapshot.val();
      state.control = {
        mode: value?.mode === "manual" ? "manual" : "auto",
        pumpCommand: value?.pumpCommand === "on" ? "on" : "off",
      };
      renderControl();
    },
    (error) => setControlFeedback(friendlyError(error), "error"),
  );
}

function stopControlListener() {
  if (state.controlUnsubscribe) state.controlUnsubscribe();
  state.controlUnsubscribe = null;
  state.control = { mode: "auto", pumpCommand: "off" };
  renderControl();
}

function openLogin() {
  if (state.demo) return;
  if (!state.auth) {
    showToast("Firebase masih dimuat. Coba lagi sesaat.", "error");
    return;
  }
  elements.authError.hidden = true;
  if (!elements.authDialog.open) elements.authDialog.showModal();
  window.setTimeout(() => $("email").focus(), 50);
}

async function handleLogin(event) {
  event.preventDefault();
  if (!state.auth || !state.firebase) return;
  elements.loginSubmit.disabled = true;
  elements.loginSubmit.textContent = "Memeriksa…";
  elements.authError.hidden = true;

  try {
    await state.firebase.signInWithEmailAndPassword(state.auth, $("email").value.trim(), $("password").value);
    elements.loginForm.reset();
    elements.authDialog.close();
    showToast("Berhasil masuk. Kontrol pemilik telah dibuka.");
  } catch (error) {
    elements.authError.textContent = friendlyError(error);
    elements.authError.hidden = false;
  } finally {
    elements.loginSubmit.disabled = false;
    elements.loginSubmit.textContent = "Masuk";
  }
}

function generateDemoHistory() {
  const now = Date.now();
  const history = {};
  for (let index = 0; index < 180; index += 1) {
    const timestamp = now - (179 - index) * 60 * 1000;
    const soil = 52 + Math.sin(index / 15) * 14 + Math.cos(index / 7) * 2;
    history[`demo-${String(index).padStart(4, "0")}`] = {
      timestamp,
      soil: Math.round(soil * 10) / 10,
      soilRaw: Math.round(3200 - (soil / 100) * 1700),
      temperature: Math.round((27 + Math.sin(index / 25) * 3) * 10) / 10,
      humidity: Math.round((70 + Math.cos(index / 20) * 9) * 10) / 10,
      pump: soil <= 45,
      mode: "auto",
    };
  }
  handleHistoryData(history);
}

let demoSoil = 48;
let demoPump = false;
function simulateDemoTick() {
  if (state.demoControl.mode === "auto") {
    if (demoSoil <= 45) demoPump = true;
    else if (demoSoil >= 65) demoPump = false;
  } else {
    if (state.demoManualStartedAt && Date.now() - state.demoManualStartedAt >= 10 * 60 * 1000) {
      state.demoControl.pumpCommand = "off";
      state.control.pumpCommand = "off";
      state.demoManualStartedAt = 0;
      showToast("Fail-safe demo: pompa manual dimatikan setelah 10 menit.");
    }
    demoPump = state.demoControl.pumpCommand === "on";
  }

  demoSoil += (demoPump ? 0.7 : -0.22) + (Math.random() - 0.5) * 0.3;
  demoSoil = Math.max(35, Math.min(75, demoSoil));
  const now = Date.now();
  handleDeviceData({
    soil: Math.round(demoSoil * 10) / 10,
    soilRaw: Math.round(3200 - (demoSoil / 100) * 1700),
    temperature: Math.round((27.5 + Math.sin(now / 90000) * 2) * 10) / 10,
    humidity: Math.round(72 + Math.cos(now / 120000) * 5),
    pump: demoPump,
    mode: state.demoControl.mode,
    wifiRssi: -48 + Math.round(Math.random() * 5),
    uptime: Math.floor(now / 1000) % 86400,
    lastUpdate: now,
  });

  // Riwayat demo dipercepat agar grafik terlihat hidup; firmware asli tetap 1 menit.
  if (now - state.demoHistoryTimer >= 5000) {
    state.demoHistoryTimer = now;
    state.history.push({
      timestamp: now,
      soil: Math.round(demoSoil * 10) / 10,
      soilRaw: Math.round(3200 - (demoSoil / 100) * 1700),
      temperature: Math.round((27.5 + Math.sin(now / 90000) * 2) * 10) / 10,
      humidity: Math.round(72 + Math.cos(now / 120000) * 5),
      pump: demoPump,
      mode: state.demoControl.mode,
    });
    state.history = state.history.slice(-appConfig.historyLimit);
    renderChart();
  }
}

function startDemo() {
  state.demo = true;
  state.control = { ...state.demoControl };
  elements.demoBadge.hidden = false;
  elements.authHeaderButton.hidden = true;
  elements.authGate.hidden = true;
  elements.dashboard.hidden = false;
  generateDemoHistory();
  simulateDemoTick();
  updateAuthUi();
  window.setInterval(simulateDemoTick, 2000);
  showToast("Mode demo aktif: data dummy, tanpa menggerakkan perangkat.");
}

function bindEvents() {
  elements.authHeaderButton.addEventListener("click", async () => {
    if (state.user && state.firebase) {
      try {
        await state.firebase.signOut(state.auth);
        showToast(appConfig.requireAuthForMonitoring
          ? "Anda telah keluar. Masuk kembali untuk membuka monitoring."
          : "Anda telah keluar. Monitoring publik tetap tersedia.");
      } catch (error) {
        showToast(friendlyError(error), "error");
      }
    } else openLogin();
  });
  $("gate-login-button").addEventListener("click", openLogin);
  $("auth-close").addEventListener("click", () => elements.authDialog.close());
  elements.loginForm.addEventListener("submit", handleLogin);
  elements.modeAuto.addEventListener("click", () => requestMode("auto"));
  elements.modeManual.addEventListener("click", () => requestMode("manual"));
  elements.pumpOn.addEventListener("click", () => requestPump("on"));
  elements.pumpOff.addEventListener("click", () => requestPump("off"));
  $("confirm-cancel").addEventListener("click", () => settleConfirmation(false));
  elements.confirmAccept.addEventListener("click", () => settleConfirmation(true));
  elements.confirmDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    settleConfirmation(false);
  });
  elements.confirmDialog.addEventListener("close", () => {
    if (confirmResolver) settleConfirmation(false);
  });

  for (const button of document.querySelectorAll(".range-button")) {
    button.addEventListener("click", () => {
      state.range = button.dataset.range === "all" ? "all" : Number(button.dataset.range);
      for (const other of document.querySelectorAll(".range-button")) {
        const active = other === button;
        other.classList.toggle("is-active", active);
        other.setAttribute("aria-pressed", String(active));
      }
      renderChart();
    });
  }

  window.addEventListener("load", renderChart, { once: true });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", renderChart);
}

async function init() {
  bindEvents();
  renderDevice();
  renderChart();
  window.setInterval(renderOnlineStatus, 1000);

  const shouldDemo = appConfig.demoMode === "always" ||
    (appConfig.demoMode === "auto" && !isFirebaseConfigured());
  if (shouldDemo) {
    startDemo();
    return;
  }

  if (!isFirebaseConfigured()) {
    elements.lastUpdate.textContent = "Firebase belum dikonfigurasi. Isi web/config.js atau aktifkan mode demo.";
    elements.chartMessage.textContent = "Firebase belum dikonfigurasi.";
    elements.chartMessage.hidden = false;
    elements.authHeaderButton.disabled = true;
    return;
  }

  if (appConfig.requireAuthForMonitoring) {
    elements.dashboard.hidden = true;
    elements.authGate.hidden = false;
  }

  try {
    await loadFirebase();
  } catch (error) {
    elements.lastUpdate.textContent = "Firebase gagal dimuat. Periksa internet dan konfigurasi.";
    showToast(friendlyError(error), "error");
    console.error("Gagal menginisialisasi Firebase:", error);
  }
}

init();
