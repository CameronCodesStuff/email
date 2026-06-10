/**
 * Email Dispatch — backend relay (Resend edition)
 * Runs as a Render Web Service. Receives send/schedule requests from the
 * GitHub Pages frontend and dispatches mail via the Resend HTTP API (port 443,
 * so it works on hosts like Render that block outbound SMTP).
 *
 * NOTES
 * - Schedules + API key live in memory only. Wiped on restart/redeploy/spin-down
 *   (Render free tier sleeps after 15 min idle). Durable schedules need a paid
 *   instance + a database.
 * - The API key is never written to logs or returned in list responses.
 * - Resend free tier: 100 emails/day, 3000/month. Until you verify a domain you
 *   can only send FROM onboarding@resend.dev TO your own Resend account email.
 */

const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "256kb" }));

// --- CORS -------------------------------------------------------------------
// Set ALLOWED_ORIGIN to your Pages URL to lock the relay down, e.g.
// ALLOWED_ORIGIN=https://cameroncodesstuff.github.io
const allowed = process.env.ALLOWED_ORIGIN;
app.use(cors(allowed ? { origin: allowed.split(",").map((s) => s.trim()) } : {}));

// --- In-memory state --------------------------------------------------------
const jobs = new Map();
const logs = [];
const MAX_LOGS = 300;

function log(level, message, meta = {}) {
  const entry = { id: crypto.randomUUID(), ts: new Date().toISOString(), level, message, ...meta };
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.shift();
  console.log(`[${entry.ts}] ${level.toUpperCase()} ${message}`);
  return entry;
}

function publicJob(j) {
  return {
    id: j.id, label: j.label, recipients: j.recipients, subject: j.subject,
    type: j.type, config: j.config, from: j.from,
    createdAt: j.createdAt, lastRun: j.lastRun, nextRun: j.nextRun,
    runCount: j.runCount, errorCount: j.errorCount, status: j.status,
  };
}

// --- Mail core (Resend HTTP API) -------------------------------------------
async function deliver(job) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${job.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: job.from,
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
  log("sent", `Dispatched "${job.subject}" to ${job.recipients.length} recipient(s)`, {
    jobId: job.id, messageId: data.id,
  });
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
}

// --- Scheduling -------------------------------------------------------------
function arm(job) {
  if (job.type === "once") {
    const delay = Math.max(0, new Date(job.config.at).getTime() - Date.now());
    job.nextRun = new Date(Date.now() + delay).toISOString();
    job._timer = setTimeout(async () => { await runJob(job); job.nextRun = null; }, delay);
    return;
  }
  if (job.type === "interval") {
    const ms = job.config.everyMs;
    job.nextRun = new Date(Date.now() + ms).toISOString();
    job._timer = setInterval(async () => { await runJob(job); job.nextRun = new Date(Date.now() + ms).toISOString(); }, ms);
    return;
  }
  const expr = job.type === "daily" ? dailyToCron(job.config.time) : job.config.expr;
  if (!cron.validate(expr)) throw new Error(`Invalid cron expression: ${expr}`);
  job._task = cron.schedule(expr, () => runJob(job));
  job.config._cron = expr;
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

// --- Routes -----------------------------------------------------------------
app.get("/", (_req, res) => res.json({ service: "email-dispatch", provider: "resend", ok: true, jobs: jobs.size }));
app.get("/health", (_req, res) => res.json({ ok: true, uptime: process.uptime(), jobs: jobs.size }));

app.post("/test", async (req, res) => {
  const { apiKey, from, recipients, subject, body, html } = req.body || {};
  const to = normalizeRecipients(recipients);
  if (!apiKey) return res.status(400).json({ error: "Missing Resend API key." });
  if (!to.length) return res.status(400).json({ error: "Add at least one recipient." });

  const job = {
    apiKey, from: from || "onboarding@resend.dev",
    recipients: to, subject: subject || "(no subject)", body: body || "", html: !!html,
    id: "test", runCount: 0,
  };
  try {
    const id = await deliver(job);
    res.json({ ok: true, messageId: id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/schedules", (req, res) => {
  const { apiKey, from, recipients, subject, body, html, label, schedule } = req.body || {};
  const to = normalizeRecipients(recipients);
  if (!apiKey) return res.status(400).json({ error: "Missing Resend API key." });
  if (!to.length) return res.status(400).json({ error: "Add at least one recipient." });
  if (!schedule || !schedule.type) return res.status(400).json({ error: "Pick a schedule." });

  const job = {
    id: crypto.randomUUID(),
    label: label || subject || "Untitled dispatch",
    apiKey,
    from: from || "onboarding@resend.dev",
    recipients: to,
    subject: subject || "(no subject)",
    body: body || "",
    html: !!html,
    type: schedule.type,
    config: schedule.config || {},
    createdAt: new Date().toISOString(),
    lastRun: null, nextRun: null, runCount: 0, errorCount: 0, status: "active",
  };
  try { arm(job); } catch (err) { return res.status(400).json({ error: err.message }); }
  jobs.set(job.id, job);
  log("info", `Scheduled "${job.label}" (${job.type})`, { jobId: job.id });
  res.json({ ok: true, job: publicJob(job) });
});

app.get("/schedules", (_req, res) => res.json({ jobs: [...jobs.values()].map(publicJob) }));

app.delete("/schedules/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "No such schedule." });
  disarm(job);
  jobs.delete(job.id);
  log("warn", `Cancelled "${job.label}"`, { jobId: job.id });
  res.json({ ok: true });
});

app.get("/logs", (_req, res) => res.json({ logs: logs.slice(-150) }));

// --- helpers ----------------------------------------------------------------
function normalizeRecipients(input) {
  if (Array.isArray(input)) input = input.join(",");
  return String(input || "")
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));
}

function friendlyError(status, data) {
  const m = (data && (data.message || data.error || data.name)) || `Resend HTTP ${status}`;
  if (status === 401) return "Resend rejected the API key — check it starts with 're_' and is still active.";
  if (status === 429) return "Rate limited by Resend (free tier is 2 req/sec, 100/day). Try again shortly.";
  if (status === 403 || /verif|own email|testing emails|domain/i.test(m)) {
    return m + " — On the free tier without a verified domain you can only send from onboarding@resend.dev to your own Resend account email. Verify a domain in the Resend dashboard to send anywhere.";
  }
  return m;
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => log("info", `Relay (Resend) listening on :${PORT}`));
