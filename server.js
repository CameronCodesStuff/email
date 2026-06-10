/**
 * Email Dispatch — backend relay
 * Runs as a Render Web Service. Receives send/schedule requests from the
 * GitHub Pages frontend and dispatches mail over Gmail SMTP via nodemailer.
 *
 * IMPORTANT NOTES
 * - Schedules + credentials live in memory only. They are wiped whenever the
 *   service restarts, redeploys, or spins down (Render free tier sleeps after
 *   15 min idle). For durable schedules you need a paid instance + a database.
 * - Credentials are never written to logs or returned in list responses.
 */

const express = require("express");
const cors = require("cors");
const nodemailer = require("nodemailer");
const cron = require("node-cron");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "256kb" }));

// --- CORS -------------------------------------------------------------------
// Open by default so it works from any GitHub Pages origin out of the box.
// Lock this down by setting ALLOWED_ORIGIN to your Pages URL in Render env vars
// e.g. ALLOWED_ORIGIN=https://camerocodesstuff.github.io
const allowed = process.env.ALLOWED_ORIGIN;
app.use(
  cors(
    allowed
      ? { origin: allowed.split(",").map((s) => s.trim()) }
      : {} // reflect any origin
  )
);

// --- In-memory state --------------------------------------------------------
const jobs = new Map(); // id -> job
const logs = []; // newest last
const MAX_LOGS = 300;

function log(level, message, meta = {}) {
  const entry = {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    level, // info | sent | error | warn
    message,
    ...meta,
  };
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.shift();
  // Console copy WITHOUT credentials
  console.log(`[${entry.ts}] ${level.toUpperCase()} ${message}`);
  return entry;
}

// Shape a job for the client (strip secrets)
function publicJob(j) {
  return {
    id: j.id,
    label: j.label,
    recipients: j.recipients,
    subject: j.subject,
    type: j.type,
    config: j.config,
    fromMasked: maskEmail(j.user),
    createdAt: j.createdAt,
    lastRun: j.lastRun,
    nextRun: j.nextRun,
    runCount: j.runCount,
    errorCount: j.errorCount,
    status: j.status,
  };
}

function maskEmail(e = "") {
  const [name, domain] = e.split("@");
  if (!domain) return "***";
  const head = name.slice(0, 2);
  return `${head}${"*".repeat(Math.max(1, name.length - 2))}@${domain}`;
}

// --- Mail core --------------------------------------------------------------
function makeTransport(user, pass) {
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass: String(pass).replace(/\s+/g, "") }, // Google shows app pw with spaces
  });
}

async function deliver(job) {
  const transporter = makeTransport(job.user, job.pass);
  const info = await transporter.sendMail({
    from: job.user,
    to: job.recipients.join(", "),
    subject: job.subject,
    [job.html ? "html" : "text"]: job.body,
  });
  job.lastRun = new Date().toISOString();
  job.runCount += 1;
  log("sent", `Dispatched "${job.subject}" to ${job.recipients.length} recipient(s)`, {
    jobId: job.id,
    messageId: info.messageId,
  });
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
    const fireAt = new Date(job.config.at).getTime();
    const delay = Math.max(0, fireAt - Date.now());
    job.nextRun = new Date(Date.now() + delay).toISOString();
    job._timer = setTimeout(async () => {
      await runJob(job);
      job.nextRun = null;
      // keep completed jobs visible; they hold no active timer
    }, delay);
    return;
  }

  if (job.type === "interval") {
    const ms = job.config.everyMs;
    job.nextRun = new Date(Date.now() + ms).toISOString();
    job._timer = setInterval(async () => {
      await runJob(job);
      job.nextRun = new Date(Date.now() + ms).toISOString();
    }, ms);
    return;
  }

  // daily + cron both use node-cron expressions
  const expr =
    job.type === "daily"
      ? dailyToCron(job.config.time)
      : job.config.expr;

  if (!cron.validate(expr)) {
    throw new Error(`Invalid cron expression: ${expr}`);
  }
  job._task = cron.schedule(expr, () => runJob(job));
  job.config._cron = expr;
}

function disarm(job) {
  if (job._timer) {
    clearTimeout(job._timer);
    clearInterval(job._timer);
  }
  if (job._task) job._task.stop();
}

function dailyToCron(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) throw new Error("Bad time, expected HH:MM");
  return `${m} ${h} * * *`;
}

// --- Routes -----------------------------------------------------------------
app.get("/", (_req, res) =>
  res.json({ service: "email-dispatch", ok: true, jobs: jobs.size })
);

// Keep-alive target for an uptime pinger (see README)
app.get("/health", (_req, res) =>
  res.json({ ok: true, uptime: process.uptime(), jobs: jobs.size })
);

// Verify credentials + send one email immediately
app.post("/test", async (req, res) => {
  const { user, pass, recipients, subject, body, html } = req.body || {};
  const to = normalizeRecipients(recipients);
  if (!user || !pass) return res.status(400).json({ error: "Missing sender email or app password." });
  if (!to.length) return res.status(400).json({ error: "Add at least one recipient." });

  try {
    const transporter = makeTransport(user, pass);
    await transporter.verify();
    const info = await transporter.sendMail({
      from: user,
      to: to.join(", "),
      subject: subject || "(no subject)",
      [html ? "html" : "text"]: body || "",
    });
    log("sent", `Test send to ${to.length} recipient(s)`, { messageId: info.messageId });
    res.json({ ok: true, messageId: info.messageId });
  } catch (err) {
    log("error", `Test failed: ${err.message}`);
    res.status(400).json({ error: friendlyError(err) });
  }
});

// Create a schedule
app.post("/schedules", (req, res) => {
  const { user, pass, recipients, subject, body, html, label, schedule } = req.body || {};
  const to = normalizeRecipients(recipients);

  if (!user || !pass) return res.status(400).json({ error: "Missing sender email or app password." });
  if (!to.length) return res.status(400).json({ error: "Add at least one recipient." });
  if (!schedule || !schedule.type) return res.status(400).json({ error: "Pick a schedule." });

  const job = {
    id: crypto.randomUUID(),
    label: label || subject || "Untitled dispatch",
    user,
    pass,
    recipients: to,
    subject: subject || "(no subject)",
    body: body || "",
    html: !!html,
    type: schedule.type, // once | interval | daily | cron
    config: schedule.config || {},
    createdAt: new Date().toISOString(),
    lastRun: null,
    nextRun: null,
    runCount: 0,
    errorCount: 0,
    status: "active",
  };

  try {
    arm(job);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  jobs.set(job.id, job);
  log("info", `Scheduled "${job.label}" (${job.type})`, { jobId: job.id });
  res.json({ ok: true, job: publicJob(job) });
});

app.get("/schedules", (_req, res) => {
  res.json({ jobs: [...jobs.values()].map(publicJob) });
});

app.delete("/schedules/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "No such schedule." });
  disarm(job);
  jobs.delete(job.id);
  log("warn", `Cancelled "${job.label}"`, { jobId: job.id });
  res.json({ ok: true });
});

app.get("/logs", (_req, res) => {
  res.json({ logs: logs.slice(-150) });
});

// --- helpers ----------------------------------------------------------------
function normalizeRecipients(input) {
  if (Array.isArray(input)) input = input.join(",");
  return String(input || "")
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));
}

function friendlyError(err) {
  const m = err.message || "Unknown error";
  if (/Invalid login|Username and Password not accepted|BadCredentials/i.test(m))
    return "Gmail rejected the login. Use a 16-character App Password (not your normal password), and make sure 2-Step Verification is on.";
  if (/self signed|certificate/i.test(m)) return "TLS/certificate problem reaching Gmail.";
  return m;
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => log("info", `Relay listening on :${PORT}`));
