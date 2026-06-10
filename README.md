# DISPATCH — email relay

Two pieces:

- **`index.html`** → static UI, hosted on **GitHub Pages**.
- **`server.js` + `package.json`** → the relay, hosted as a **Render Web Service**. It does the actual SMTP sending and the scheduling, because a browser can't open SMTP connections.

The page talks to the relay over HTTP. You paste your Render URL into the page once and it's saved on your device.

---

## 1. Get a Gmail App Password

Your normal Gmail password won't work for SMTP. You need a 16-character App Password:

1. Turn on **2-Step Verification** on the Google account (required).
2. Go to **myaccount.google.com → Security → App passwords**.
3. Create one, name it anything ("dispatch"). Google gives you 16 characters shown in 4 groups.
4. Paste it into the app. Spaces are fine — the relay strips them.

> Free Gmail sends are rate-limited (roughly ~500 recipients/day). This is a personal-automation tool — don't point it at bulk/unsolicited lists.

---

## 2. Deploy the relay to Render

1. Put `server.js` and `package.json` in a GitHub repo (can be the same repo as the page or separate).
2. On **render.com → New → Web Service**, connect that repo.
3. Settings:
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** Free is fine for testing (see the warning below).
4. *(Optional, recommended)* add an env var **`ALLOWED_ORIGIN`** = your Pages URL, e.g. `https://cameroncodesstuff.github.io` — this stops anyone else from using your relay.
5. Deploy. Copy the URL it gives you, e.g. `https://dispatch-xxxx.onrender.com`.

### The free-tier catch (important for a scheduler)
Render's free web service **sleeps after 15 minutes of inactivity** and **loses all in-memory state on restart** — meaning your schedules disappear and won't fire while it's asleep. Options:

- **Keep it warm:** point a free uptime pinger (e.g. cron-job.org, UptimeRobot) at `https://your-service.onrender.com/health` every ~10 min. This prevents sleep but a redeploy/crash still wipes schedules.
- **Pay (~$7/mo):** an always-on instance fixes the sleeping, but schedules still reset on redeploy unless you add a database.
- **For real durability** you'd persist schedules to a DB and re-arm them on boot. The current build keeps them in memory by design (simple, no DB).

---

## 3. Deploy the page to GitHub Pages

1. Put `index.html` in a repo.
2. **Repo → Settings → Pages →** Source: deploy from branch, `main` / root.
3. Open the published URL, paste your Render URL into **Relay endpoint**, hit **Connect**.

The connection dot goes green when the relay answers. First connect after the relay's been idle can take ~60s while it wakes.

---

## Using it

- **Send test now** — verifies your credentials and fires one email immediately.
- **Schedule dispatch** — arms a recurring/one-off send:
  - **Once** — a specific date/time.
  - **Every** — interval (every N minutes/hours/days).
  - **Daily** — a time each day. *Times are the relay's clock, which is UTC on Render.*
  - **Cron** — full `min hour day month weekday` expression (UTC).
- **Dispatch log** streams every send/failure live. **Active schedules** shows what's armed; cancel any of them.

## Security notes

- Credentials are sent to *your* relay and held in memory only for active schedules — never logged, never returned to the page.
- "Remember app password on this device" stores it in your browser's localStorage. Convenient, but it's plaintext on that machine — leave it off on shared computers.
- Set `ALLOWED_ORIGIN` so your relay only answers your page. Without it, anyone who finds the URL could send through it using their own credentials.
