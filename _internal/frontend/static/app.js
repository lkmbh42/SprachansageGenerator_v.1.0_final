/* Sprachansage-Generator — Frontend-Logik (Vanilla JS, kein Build-Schritt).
   Steuert Zeichenzähler, Stimmauswahl, Erzeugung und die Zustände
   leer / lädt / fertig / Fehler. */
"use strict";

const $ = (id) => document.getElementById(id);

const el = {
  text: $("text"),
  zaehler: $("zaehler"),
  stimmen: $("stimmen"),
  beispiel: $("beispiel"),
  erzeugen: $("erzeugen"),
  fehler: $("fehler"),
  leer: $("zustand-leer"),
  laden: $("zustand-laden"),
  fertig: $("zustand-fertig"),
  dateiname: $("dateiname"),
  player: $("player"),
  wellenform: $("wellenform"),
  download: $("download"),
  specListe: $("spec-liste"),
  aussprache: $("aussprache"),
  ausspracheText: $("aussprache-text"),
  // mode switch + recorder
  modeBtnText: $("mode-btn-text"),
  modeBtnRecord: $("mode-btn-record"),
  modeText: $("mode-text"),
  modeRecord: $("mode-record"),
  recStart: $("rec-start"),
  recStop: $("rec-stop"),
  recDot: $("rec-dot"),
  recTime: $("rec-time"),
  recPreview: $("rec-preview"),
  recAudio: $("rec-audio"),
  recAgain: $("rec-again"),
  konvertieren: $("konvertieren"),
};

const DRAFT_KEY = "sprachansage_entwurf";  // localStorage draft key
const MAX_REC_SECONDS = 300;               // hard cap on recording length

let mediaRecorder = null, recChunks = [], recStream = null, recBlob = null;
let recTimer = null, recStartTime = 0, recPreviewUrl = null;

let MAX_LEN = 1000;
let selectedVoice = null;
let currentObjectUrl = null;   // laufende Blob-URL, zum Freigeben
let busy = false;

const BEISPIEL_TEXT =
  "Guten Tag, Sie haben die Sprachbox der Musterfirma GmbH erreicht. " +
  "Wir sind Mo.-Fr. von 8:00 bis 17:00 Uhr für Sie da. Bitte hinterlassen Sie " +
  "eine Nachricht nach dem Signalton. Wir rufen Sie schnellstmöglich zurück.";

const ICON_FEMALE = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="5"/><path d="M12 13v8M9 18h6"/></svg>`;
const ICON_MALE = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="14" r="5"/><path d="M15 9l5-5M20 9V4h-5"/></svg>`;

/* ----------------------------- Initialisierung --------------------------- */
async function init() {
  try {
    const res = await fetch("/api/config");
    if (!res.ok) throw new Error("Konfiguration konnte nicht geladen werden.");
    const cfg = await res.json();
    MAX_LEN = cfg.max_text_len || 1000;
    el.text.setAttribute("maxlength", String(MAX_LEN));
    renderVoices(cfg.voices || []);
    if (cfg.spec) renderSpec(cfg.spec);
    const ver = document.getElementById("app-version");
    if (ver && cfg.version) ver.textContent = "Version " + cfg.version;
  } catch (e) {
    // Auch ohne Config nutzbar: Standardstimmen anzeigen.
    renderVoices([
      { key: "female", label: "Weibliche Stimme" },
      { key: "male", label: "Männliche Stimme" },
    ]);
  }
  restoreDraft();
  updateCounter();
  updateButton();
  updatePreview();
}

function renderVoices(voices) {
  const subtitles = { female: "Klar & freundlich", male: "Ruhig & sachlich" };
  const icons = { female: ICON_FEMALE, male: ICON_MALE };
  el.stimmen.innerHTML = "";
  voices.forEach((v, idx) => {
    const label = document.createElement("label");
    label.className = "voice-card";
    label.innerHTML = `
      <input type="radio" name="stimme" value="${v.key}" ${idx === 0 ? "checked" : ""}>
      <span class="v-icon">${icons[v.key] || ICON_FEMALE}</span>
      <span>
        <span class="v-title">${v.label}</span><br>
        <span class="v-sub">${subtitles[v.key] || "Deutsche Stimme"}</span>
      </span>
      <span class="v-check" aria-hidden="true">✓</span>`;
    el.stimmen.appendChild(label);
    if (idx === 0) selectedVoice = v.key;
  });
  el.stimmen.querySelectorAll('input[name="stimme"]').forEach((r) => {
    r.addEventListener("change", () => {
      selectedVoice = r.value;
      updateButton();
    });
  });
}

function renderSpec(spec) {
  const parts = [
    spec.container,
    `PCM ${spec.bit_depth}-Bit`,
    `${spec.sample_rate_hz} Hz`,
    spec.channels === 1 ? "Mono" : `${spec.channels} Kanäle`,
    `${spec.bitrate_kbps} kbps`,
  ];
  el.specListe.innerHTML = parts.map((p) => `<li>${p}</li>`).join("");
}

/* ------------------------------- Zeichenzähler --------------------------- */
function updateCounter() {
  const len = el.text.value.length;
  el.zaehler.textContent = `${len} / ${MAX_LEN} Zeichen`;
  el.zaehler.classList.toggle("warn", len > MAX_LEN * 0.9 && len <= MAX_LEN);
  el.zaehler.classList.toggle("over", len > MAX_LEN);
}

function updateButton() { updateButtons(); }  // kept for existing callers

function updateButtons() {
  const len = el.text.value.trim().length;
  el.erzeugen.disabled = busy || len === 0 || el.text.value.length > MAX_LEN || !selectedVoice;
  if (el.konvertieren) el.konvertieren.disabled = busy || !recBlob;
}

/* ----------------------- Aussprache-Vorschau (live) ---------------------- */
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

async function updatePreview() {
  const text = el.text.value;
  if (!text.trim()) { el.aussprache.hidden = true; return; }
  try {
    const res = await fetch("/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) { el.aussprache.hidden = true; return; }
    const data = await res.json();
    if (!data.spoken) { el.aussprache.hidden = true; return; }
    el.ausspracheText.textContent = data.spoken;
    // highlight (amber) when normalization actually changed something
    el.aussprache.classList.toggle("is-changed", !!data.changed);
    el.aussprache.hidden = false;
  } catch (_) {
    el.aussprache.hidden = true;  // preview is a nicety; never block on it
  }
}
const updatePreviewDebounced = debounce(updatePreview, 300);

/* ------------------------------- Entwurf --------------------------------- */
function saveDraft() {
  try { localStorage.setItem(DRAFT_KEY, el.text.value); } catch (_) {}
}
function restoreDraft() {
  try {
    const saved = localStorage.getItem(DRAFT_KEY);
    if (saved && !el.text.value) el.text.value = saved;
  } catch (_) {}
}

/* --------------------------------- Zustände ------------------------------ */
function showState(name) {
  el.leer.hidden = name !== "leer";
  el.laden.hidden = name !== "laden";
  el.fertig.hidden = name !== "fertig";
}

function showError(message) {
  el.fehler.hidden = false;
  el.fehler.textContent = message;
}
function clearError() {
  el.fehler.hidden = true;
  el.fehler.textContent = "";
}

/* --------------------- Gemeinsamer Erzeugungs-Ablauf --------------------- */
// Shared by text generation and recording conversion: handle busy/loading state,
// show the resulting WAV, and surface errors — differing only in how the blob
// is produced.
async function produce(getBlob, button) {
  if (busy) return;
  clearError();
  busy = true;
  button.classList.add("is-busy");
  updateButtons();
  showState("laden");
  try {
    const blob = await getBlob();
    await zeigeErgebnis(blob);
    showState("fertig");
  } catch (e) {
    showState("leer");
    showError(e.message || "Unbekannter Fehler.");
  } finally {
    busy = false;
    button.classList.remove("is-busy");
    updateButtons();
  }
}

/* -------------------------------- Erzeugung (Text) ----------------------- */
function erzeugen() {
  clearError();
  const text = el.text.value;
  if (!text.trim()) { showError("Bitte geben Sie zuerst einen Text ein."); return; }
  if (text.length > MAX_LEN) { showError(`Text ist zu lang (max. ${MAX_LEN} Zeichen).`); return; }
  if (!selectedVoice) { showError("Bitte wählen Sie eine Stimme."); return; }

  produce(async () => {
    const res = await fetch("/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice: selectedVoice }),
    });
    if (!res.ok) {
      let detail = "Die Ansage konnte nicht erzeugt werden.";
      try { detail = (await res.json()).detail || detail; } catch (_) {}
      throw new Error(detail);
    }
    return res.blob();
  }, el.erzeugen);
}

/* -------------------------- Modus & Aufnahme ----------------------------- */
function setMode(mode) {
  if (busy) return;
  const isText = mode === "text";
  el.modeBtnText.classList.toggle("is-active", isText);
  el.modeBtnRecord.classList.toggle("is-active", !isText);
  el.modeBtnText.setAttribute("aria-selected", String(isText));
  el.modeBtnRecord.setAttribute("aria-selected", String(!isText));
  el.modeText.hidden = !isText;
  el.modeRecord.hidden = isText;
  if (isText) stopStream();          // release mic if leaving record mode
  clearError();
  showState("leer");                 // reset result panel on mode change
  updateButtons();
}

async function startRecording() {
  clearError();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showError("Ihr Browser unterstützt keine Audioaufnahme."); return;
  }
  try {
    recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (_) {
    showError("Kein Zugriff auf das Mikrofon. Bitte die Mikrofon-Erlaubnis im Browser zulassen und erneut versuchen.");
    return;
  }
  recChunks = [];
  recBlob = null;
  el.recPreview.hidden = true;
  try {
    mediaRecorder = new MediaRecorder(recStream);
  } catch (_) {
    showError("Aufnahme konnte nicht gestartet werden."); stopStream(); return;
  }
  mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
  mediaRecorder.onstop = onRecordingStopped;
  mediaRecorder.start();

  el.recStart.hidden = true;
  el.recStop.hidden = false;
  el.recDot.classList.add("is-live");
  recStartTime = Date.now();
  el.recTime.textContent = "00:00";
  recTimer = setInterval(tickRecTime, 200);
  updateButtons();
}

function tickRecTime() {
  const s = Math.floor((Date.now() - recStartTime) / 1000);
  el.recTime.textContent =
    `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  if (s >= MAX_REC_SECONDS) stopRecording();  // enforce the length cap
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
}

function onRecordingStopped() {
  clearInterval(recTimer); recTimer = null;
  el.recDot.classList.remove("is-live");
  el.recStart.hidden = false;
  el.recStop.hidden = true;
  const type = (recChunks[0] && recChunks[0].type) || "audio/webm";
  recBlob = new Blob(recChunks, { type });
  stopStream();
  if (recPreviewUrl) URL.revokeObjectURL(recPreviewUrl);
  recPreviewUrl = URL.createObjectURL(recBlob);
  el.recAudio.src = recPreviewUrl;
  el.recPreview.hidden = false;
  updateButtons();
}

function stopStream() {
  if (recStream) { recStream.getTracks().forEach((t) => t.stop()); recStream = null; }
}

function konvertieren() {
  if (!recBlob) { showError("Bitte nehmen Sie zuerst eine Ansage auf."); return; }
  produce(async () => {
    const wav = await recordingToWav(recBlob);          // decode + mono + PCM16 WAV
    const res = await fetch("/convert", {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: wav,
    });
    if (!res.ok) {
      let detail = "Die Aufnahme konnte nicht umgewandelt werden.";
      try { detail = (await res.json()).detail || detail; } catch (_) {}
      throw new Error(detail);
    }
    return res.blob();
  }, el.konvertieren);
}

/* Decode the browser recording (WebM/Opus) and re-encode as a mono 16-bit WAV
   so the backend (libsndfile) can read it — no server-side Opus/ffmpeg needed. */
async function recordingToWav(blob) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) throw new Error("Audio-Verarbeitung wird vom Browser nicht unterstützt.");
  const ctx = new AudioCtx();
  const audioBuf = await ctx.decodeAudioData(await blob.arrayBuffer());
  ctx.close();
  return encodeWavPCM16(downmixMono(audioBuf), audioBuf.sampleRate);
}

function downmixMono(buf) {
  if (buf.numberOfChannels === 1) return buf.getChannelData(0);
  const a = buf.getChannelData(0), b = buf.getChannelData(1);
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] + b[i]) / 2;
  return out;
}

function encodeWavPCM16(samples, sampleRate) {
  const n = samples.length;
  const view = new DataView(new ArrayBuffer(44 + n * 2));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); view.setUint32(4, 36 + n * 2, true); str(8, "WAVE"); str(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  str(36, "data"); view.setUint32(40, n * 2, true);
  let off = 44;
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([view], { type: "audio/wav" });
}

async function zeigeErgebnis(blob) {
  // vorherige Blob-URL freigeben (kein Speicherleck bei mehrfacher Erzeugung)
  if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
  currentObjectUrl = URL.createObjectURL(blob);

  const filename = dateinameBauen();
  el.player.src = currentObjectUrl;
  el.download.href = currentObjectUrl;
  el.download.setAttribute("download", filename);

  const duration = await zeichneWellenform(blob).catch(() => { clearWaveform(); return null; });
  const parts = [filename, `${(blob.size / 1024).toFixed(0)} KB`];
  if (duration) parts.push(`${duration.toFixed(1)} Sek.`);
  el.dateiname.textContent = parts.join("  ·  ");
}

function dateinameBauen() {
  const d = new Date();
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `ansage_${iso}.wav`;
}

/* ----------------------- Wellenform (statische Vorschau) ----------------- */
function clearWaveform() {
  const ctx = el.wellenform.getContext("2d");
  ctx && ctx.clearRect(0, 0, el.wellenform.width, el.wellenform.height);
}

async function zeichneWellenform(blob) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return;
  const arrayBuf = await blob.arrayBuffer();
  const audioCtx = new AudioCtx();
  const audioBuf = await audioCtx.decodeAudioData(arrayBuf);
  audioCtx.close();
  const duration = audioBuf.duration;  // returned so the result can show length

  const canvas = el.wellenform;
  // an Anzeigebreite anpassen (scharf auf HiDPI)
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth || 480;
  canvas.width = Math.floor(cssWidth * dpr);
  canvas.height = Math.floor(72 * dpr);
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  const data = audioBuf.getChannelData(0);
  const W = cssWidth, H = 72, mid = H / 2;
  const bars = Math.min(160, Math.floor(W / 4));
  const step = Math.floor(data.length / bars) || 1;
  const barW = W / bars;

  ctx.clearRect(0, 0, W, H);
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, "#4a6ef0");
  grad.addColorStop(1, "#2f57d8");
  ctx.fillStyle = grad;

  for (let i = 0; i < bars; i++) {
    let peak = 0;
    for (let j = 0; j < step; j++) {
      const v = Math.abs(data[i * step + j] || 0);
      if (v > peak) peak = v;
    }
    const h = Math.max(2, peak * (H - 8));
    const x = i * barW;
    // gerundete Balken, symmetrisch um die Mitte
    ctx.beginPath();
    const w = Math.max(1.5, barW - 1.5);
    const r = Math.min(w / 2, 2);
    roundRect(ctx, x, mid - h / 2, w, h, r);
    ctx.fill();
  }
  return duration;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* -------------------------------- Ereignisse ----------------------------- */
el.text.addEventListener("input", () => {
  updateCounter();
  updateButton();
  clearError();
  saveDraft();
  updatePreviewDebounced();
});
el.beispiel.addEventListener("click", () => {
  el.text.value = BEISPIEL_TEXT;
  el.text.focus();
  updateCounter();
  updateButton();
  clearError();
  saveDraft();
  updatePreview();
});
el.erzeugen.addEventListener("click", erzeugen);
// Strg+Enter zum schnellen Erzeugen
el.text.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !el.erzeugen.disabled) erzeugen();
});

// Modus-Umschalter + Aufnahme
el.modeBtnText.addEventListener("click", () => setMode("text"));
el.modeBtnRecord.addEventListener("click", () => setMode("record"));
el.recStart.addEventListener("click", startRecording);
el.recStop.addEventListener("click", stopRecording);
el.recAgain.addEventListener("click", startRecording);
el.konvertieren.addEventListener("click", konvertieren);

init();

/* Heartbeat: tells the local app the tab is still open. When these stop (tab
   closed), the app auto-quits so no invisible process is left running. Failure-
   tolerant and lightweight; a reload resumes pinging well within the grace time. */
(function heartbeat() {
  const ping = () => fetch("/heartbeat", { method: "POST" }).catch(() => {});
  ping();
  setInterval(ping, 5000);
})();
