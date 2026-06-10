/**
 * Email Dispatch — backend relay (Resend + optional Firestore persistence)
 * Runs as a Render Web Service.
 *
 * PERSISTENCE
 * - If FIREBASE_SERVICE_ACCOUNT (a service-account JSON string) is set, schedules
 *   and the Resend API key are stored in Firestore and re-armed on boot, so they
 *   survive restarts / spin-downs / redeploys.
 * - If it's not set, the relay runs in-memory (schedules lost on restart).
 *
 * SECRETS
 * - The Resend API key and the Firebase service account never leave the server.
 *   They are never logged or returned to the browser (key is shown masked only).
 */

const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "256kb" }));

const allowed = process.env.ALLOWED_ORIGIN;
app.use(cors(allowed ? { origin: allowed.split(",").map((s) => s.trim()) } : {}));

// --- in-memory state --------------------------------------------------------
const jobs = new Map();
const logs = [];
const MAX_LOGS = 300;
const MIN_INTERVAL_MS = 1000; // floor so "every 0s" can't hammer Resend

let cfg = { resendApiKey: process.env.RESEND_API_KEY || null, from: "onboarding@resend.dev" };

function log(level, message, meta = {}) {
  const entry = { id: crypto.randomUUID(), ts: new Date().toISOString(), level, message, ...meta };
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.shift();
  console.log(`[${entry.ts}] ${level.toUpperCase()} ${message}`);
  return entry;
}

const maskKey = (k) => (k ? k.slice(0, 5) + "\u2026" + k.slice(-4) : null);

// --- Firestore persistence (optional) --------------------------------------
let db = null;

function initFirebase() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    log("warn", "FIREBASE_SERVICE_ACCOUNT not set \u2014 running in-memory; schedules will NOT survive restarts.");
    return;
  }
  try {
    const admin = require("firebase-admin");
    const creds = JSON.parse(raw);
    if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(creds) });
    db = admin.firestore();
    log("info", "Firestore persistence enabled.");
  } catch (e) {
    db = null;
    log("error", "Firebase init failed (" + e.message + ") \u2014 falling back to in-memory.");
  }
}

function serializeJob(j) {
  return {
    id: j.id, label: j.label, from: j.from, recipients: j.recipients,
    subject: j.subject, body: j.body, html: !!j.html, type: j.type,
    config: { everyMs: j.config.everyMs, human: j.config.human, time: j.config.time, expr: j.config.expr, at: j.config.at },
    createdAt: j.createdAt, lastRun: j.lastRun, nextRun: j.nextRun,
    runCount: j.runCount, errorCount: j.errorCount, status: j.status,
  };
}

async function persistJob(j) { if (db) try { await db.collection("schedules").doc(j.id).set(serializeJob(j)); } catch (e) { log("error", "Persist failed: " + e.message); } }
async function deleteJobDoc(id) { if (db) try { await db.collection("schedules").doc(id).delete(); } catch (e) { log("error", "Delete failed: " + e.message); } }

async function loadConfig() {
  if (!db) return;
  try {
    const snap = await db.collection("dispatch").doc("config").get();
    if (snap.exists) {
      const d = snap.data();
      if (d.resendApiKey) cfg.resendApiKey = d.resendApiKey;
      if (d.from) cfg.from = d.from;
      log("info", "Loaded saved config (key " + (cfg.resendApiKey ? "present" : "absent") + ").");
    }
  } catch (e) { log("error", "loadConfig failed: " + e.message); }
}
async function saveConfig() {
  if (!db) return;
  await db.collection("dispatch").doc("config").set(
    { resendApiKey: cfg.resendApiKey || null, from: cfg.from, updatedAt: new Date().toISOString() },
    { merge: true }
  );
}

async function rearmFromStore() {
  if (!db) return;
  try {
    const snap = await db.collection("schedules").get();
    snap.forEach((doc) => {
      const j = doc.data();
      j._timer = null; j._task = null;
      jobs.set(j.id, j);
      if (j.status === "completed") return;            // finished one-offs: keep as record
      if (j.type === "once" && j.runCount > 0) return; // already sent
      try { arm(j); } catch (e) { log("error", "Re-arm " + j.id + " failed: " + e.message); }
    });
    log("info", "Re-armed " + jobs.size + " schedule(s) from Firestore.");
  } catch (e) { log("error", "rearm failed: " + e.message); }
}

// --- mail core (Resend HTTP API) -------------------------------------------
async function deliver(job) {
  const key = cfg.resendApiKey;
  if (!key) throw new Error("No Resend API key configured on the relay. Save one in settings first.");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: job.from || cfg.from,
      to: job.recipients,
      subject: job.subject,
      [job.html ? "html" : "text"]: job.body,
    }),
  });

  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error(friendlyError(res.status, data));

  job.lastRun = new Date().toISOString();
  job.runCount += 1;
  log("sent", `Dispatched "${job.subject}" to ${job.recipients.length} recipient(s)`, { jobId: job.id, messageId: data.id });
  return data.id;
}

async function runJob(job) {
  try {
    await deliver(job);
    job.status = job.type === "once" ? "completed" : "active";
  } catch (err) {
    job.errorCount += 1;
    job.status = "error";
    log("error", `Send failed: ${err.message}`, { jobId: job.id });
  }
  await persistJob(job);
}

// --- scheduling -------------------------------------------------------------
function arm(job) {
  if (job.type === "once") {
    const delay = Math.max(0, new Date(job.config.at).getTime() - Date.now());
    job.nextRun = new Date(Date.now() + delay).toISOString();
    job._timer = setTimeout(async () => { await runJob(job); job.nextRun = null; }, delay);
    return;
  }
  if (job.type === "interval") {
    const ms = Math.max(MIN_INTERVAL_MS, job.config.everyMs || 60000);
    job.config.everyMs = ms;
    job.nextRun = new Date(Date.now() + ms).toISOString();
    job._timer = setInterval(async () => { await runJob(job); job.nextRun = new Date(Date.now() + ms).toISOString(); }, ms);
    return;
  }
  const expr = job.type === "daily" ? dailyToCron(job.config.time) : job.config.expr;
  if (!cron.validate(expr)) throw new Error(`Invalid cron expression: ${expr}`);
  job._task = cron.schedule(expr, () => runJob(job));
}

function disarm(job) {
  if (job._timer) { clearTimeout(job._timer); clearInterval(job._timer); }
  if (job._task) job._task.stop();
}

function dailyToCron(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) throw new Error("Bad time, expected HH:MM");
  return `${m} ${h} * * *`;
}

function publicJob(j) {
  return {
    id: j.id, label: j.label, recipients: j.recipients, subject: j.subject,
    type: j.type, config: j.config, from: j.from, createdAt: j.createdAt,
    lastRun: j.lastRun, nextRun: j.nextRun, runCount: j.runCount,
    errorCount: j.errorCount, status: j.status,
  };
}

// --- routes -----------------------------------------------------------------
app.get("/", (_q, res) => res.json({ service: "email-dispatch", provider: "resend", persistence: db ? "firestore" : "memory", ok: true, jobs: jobs.size }));
app.get("/health", (_q, res) => res.json({ ok: true, uptime: process.uptime(), jobs: jobs.size, persistence: db ? "firestore" : "memory" }));

app.get("/config", (_q, res) => res.json({
  hasKey: !!cfg.resendApiKey, keyMasked: maskKey(cfg.resendApiKey), from: cfg.from, persistence: db ? "firestore" : "memory",
}));

app.post("/config", async (req, res) => {
  const { resendApiKey, from } = req.body || {};
  if (typeof from === "string" && from.trim()) cfg.from = from.trim();
  if (typeof resendApiKey === "string" && resendApiKey.trim()) cfg.resendApiKey = resendApiKey.trim();
  try { await saveConfig(); } catch (e) { return res.status(500).json({ error: "Save failed: " + e.message }); }
  log("info", "Config updated (key " + (cfg.resendApiKey ? "set" : "cleared") + ").");
  res.json({ ok: true, hasKey: !!cfg.resendApiKey, keyMasked: maskKey(cfg.resendApiKey), from: cfg.from, persistence: db ? "firestore" : "memory" });
});

app.post("/test", async (req, res) => {
  const { from, recipients, subject, body, html, apiKey } = req.body || {};
  if (apiKey && apiKey.trim()) { cfg.resendApiKey = apiKey.trim(); saveConfig().catch(() => {}); }
  const to = normalizeRecipients(recipients);
  if (!to.length) return res.status(400).json({ error: "Add at least one recipient." });
  try {
    const id = await deliver({ id: "test", from: from || cfg.from, recipients: to, subject: subject || "(no subject)", body: body || "", html: !!html, runCount: 0 });
    res.json({ ok: true, messageId: id });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post("/schedules", async (req, res) => {
  const { from, recipients, subject, body, html, label, schedule, apiKey } = req.body || {};
  if (apiKey && apiKey.trim()) { cfg.resendApiKey = apiKey.trim(); await saveConfig().catch(() => {}); }
  const to = normalizeRecipients(recipients);
  if (!to.length) return res.status(400).json({ error: "Add at least one recipient." });
  if (!schedule || !schedule.type) return res.status(400).json({ error: "Pick a schedule." });
  if (!cfg.resendApiKey) return res.status(400).json({ error: "No Resend API key on the relay yet \u2014 enter your re_ key and Save to relay." });

  const job = {
    id: crypto.randomUUID(), label: label || subject || "Untitled dispatch",
    from: from || cfg.from, recipients: to, subject: subject || "(no subject)",
    body: body || "", html: !!html, type: schedule.type, config: schedule.config || {},
    createdAt: new Date().toISOString(), lastRun: null, nextRun: null,
    runCount: 0, errorCount: 0, status: "active",
  };
  try { arm(job); } catch (err) { return res.status(400).json({ error: err.message }); }
  jobs.set(job.id, job);
  await persistJob(job);
  log("info", `Scheduled "${job.label}" (${job.type})`, { jobId: job.id });
  res.json({ ok: true, job: publicJob(job) });
});

app.get("/schedules", (_q, res) => res.json({ jobs: [...jobs.values()].map(publicJob) }));

app.delete("/schedules/:id", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "No such schedule." });
  disarm(job);
  jobs.delete(job.id);
  await deleteJobDoc(job.id);
  log("warn", `Cancelled "${job.label}"`, { jobId: job.id });
  res.json({ ok: true });
});

app.get("/logs", (_q, res) => res.json({ logs: logs.slice(-150) }));

// --- helpers ----------------------------------------------------------------
function normalizeRecipients(input) {
  if (Array.isArray(input)) input = input.join(",");
  return String(input || "").split(/[\s,;]+/).map((s) => s.trim())
    .filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));
}

function friendlyError(status, data) {
  const m = (data && (data.message || data.error || data.name)) || `Resend HTTP ${status}`;
  if (status === 401) return "Resend rejected the API key \u2014 check it starts with 're_' and is still active.";
  if (status === 429) return "Rate limited by Resend (free tier: 2 req/sec, 100/day). Slow the schedule down.";
  if (status === 403 || /verif|own email|testing emails|domain/i.test(m))
    return m + " \u2014 On the free tier without a verified domain you can only send from onboarding@resend.dev to your own Resend account email. Verify a domain in Resend to send anywhere.";
  return m;
}

// --- boot -------------------------------------------------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
  log("info", `Relay (Resend) listening on :${PORT}`);
  initFirebase();
  await loadConfig();
  await rearmFromStore();
});
