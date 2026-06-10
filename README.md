# DISPATCH — email relay (Resend)

Two pieces:

- **`index.html`** → static UI, hosted on **GitHub Pages**.
- **`server.js` + `package.json`** → the relay, hosted as a **Render Web Service**. It sends mail through the **Resend HTTP API** and runs the schedules.

Resend is used instead of Gmail/SMTP because Render (like most cloud hosts) blocks outbound SMTP ports. Resend sends over HTTPS (port 443), which isn't blocked.

---

## 1. Get a Resend API key

1. Sign up at **resend.com** (free).
2. **API Keys → Create API Key.** Copy it — it starts with `re_`.
3. That's the only credential the app needs. You paste it into the page.

### The free-tier sending rule (read this)
- Free tier: **100 emails/day, 3,000/month**, rate-limited to 2 requests/sec.
- **Until you verify a domain**, you can only send **from `onboarding@resend.dev`**, and only **to your own Resend account email** (the address you signed up with). Great for testing; it won't reach other people yet.
- To send to anyone, go to **Resend → Domains → Add Domain**, add the DNS records it gives you (SPF/DKIM), and once verified set the **From address** on the page to something `@yourdomain.com`.

---

## 2. Deploy the relay to Render

1. Put `server.js` and `package.json` at the **root** of a GitHub repo.
2. **render.com → New + → Web Service**, connect that repo.
3. Settings:
   - **Runtime:** Node (auto-detected)
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
4. *(Recommended)* Environment Variables → add **`ALLOWED_ORIGIN`** = your Pages URL, e.g. `https://cameroncodesstuff.github.io` so only your page can use the relay.
5. Deploy. Copy the URL, e.g. `https://email-xxxx.onrender.com`.

### Free-tier scheduler caveat
Render's free web service **sleeps after 15 min idle** and **loses in-memory state on restart** — so armed schedules disappear and won't fire while asleep. Options:
- **Keep it warm:** point a free uptime pinger (cron-job.org, UptimeRobot) at `/health` every ~10 min.
- **Pay (~$7/mo):** always-on, but schedules still reset on redeploy unless you add a database.
- **For real durability:** persist schedules to a DB and re-arm on boot (this build keeps them in memory by design).

---

## 3. Deploy the page to GitHub Pages

1. Put `index.html` in a repo (can be the same one).
2. **Settings → Pages →** deploy from branch, `main` / root.
3. Open the published URL, paste your Render URL into **Relay endpoint**, hit **Connect** (first wake can take ~60s).

---

## Using it

- **From address** — `onboarding@resend.dev` until you verify a domain.
- **Resend API key** — your `re_...` key.
- **Send test now** — fires one email immediately so you can confirm it works.
- **Schedule dispatch** — Once / Every-N / Daily / Cron. Daily and Cron run on the relay's clock = **UTC** on Render.
- **Dispatch log** streams sends/failures live; **Active schedules** lists what's armed (cancel anytime).

## Security notes

- The API key is sent to *your* relay and held in memory for active schedules only — never logged, never returned to the page.
- "Remember API key on this device" stores it in your browser's localStorage (plaintext on that machine). Leave it off on shared computers.
- Set `ALLOWED_ORIGIN` so only your page can reach the relay.
