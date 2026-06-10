# DISPATCH — email relay (Resend + Firestore)

- **`index.html`** → static UI on **GitHub Pages**. Talks only to your relay.
- **`server.js` + `package.json`** → the relay, a **Render Web Service**. Sends via the **Resend HTTP API** and runs schedules.
- **`firestore.rules`** → lock-down rules for your Firebase project.

Only the relay touches Firebase, using a service account. The browser never sees Firebase or your Resend key.

---

## What gets stored where

| Thing | Where | Why |
|---|---|---|
| Relay endpoint URL | your browser (localStorage) | the browser needs it to find the relay — can't live server-side |
| Resend API key | Firestore, written/read by the relay only | secret; never sent back to the browser (shown masked) |
| Schedules | Firestore | survive Render restarts / spin-downs; re-armed on boot |

If you skip Firebase, the relay still runs — it just keeps everything in memory and loses it on restart.

---

## About "make Firebase a GitHub secret"

Two separate things get conflated here:

- **The Firebase *web* config** (the `apiKey`/`authDomain`/… block from the console) is **not a secret**. Google designs it to be public; security comes from Firestore rules, not from hiding it. And a GitHub Actions secret can't hide it on a static site anyway — whatever you inject ends up in the served HTML. In this build the **browser doesn't use Firebase at all**, so that config isn't needed in `index.html`.
- **The Firebase *service account*** (a private-key JSON) **is** the real secret. It belongs to the relay, which runs on **Render** — so it goes in a **Render environment variable**, not a GitHub secret. (GitHub secrets only apply to GitHub Actions builds; they wouldn't reach your Render service.)

So: nothing sensitive goes into the GitHub repo, and the one true secret lives in Render's env vars.

---

## 1. Resend

1. Sign up at resend.com, create an API key (`re_…`).
2. Free tier: **100/day, 3,000/month**, 2 req/sec. Until you verify a domain you can only send **from `onboarding@resend.dev`** **to your own Resend account email**. Add a domain (Resend → Domains, set the DNS records) to send anywhere.

You'll paste the key into the page once and hit **Save credentials to relay** — it's stored in Firestore from then on.

## 2. Firebase

1. In the Firebase console for your project (`email-71b87`), enable **Firestore Database**.
2. **Project settings → Service accounts → Generate new private key.** Downloads a JSON file.
3. Open `firestore.rules` from this repo and paste it into **Firestore → Rules → Publish** (denies all client access — the relay's service account bypasses rules).

## 3. Deploy the relay (Render)

1. Put `server.js` + `package.json` at a repo root; connect it as a **Web Service** on Render.
   - Build: `npm install` · Start: `npm start` · Instance: Free (or paid for always-on).
2. **Environment Variables:**
   - `FIREBASE_SERVICE_ACCOUNT` = the entire contents of the service-account JSON (paste the whole `{ … }` as one value).
   - *(optional)* `RESEND_API_KEY` = your `re_…` key, if you'd rather set it here than in the UI.
   - *(recommended)* `ALLOWED_ORIGIN` = your Pages URL, e.g. `https://cameroncodesstuff.github.io`.
3. Deploy. Logs should show `Firestore persistence enabled.` If you see `running in-memory`, the service-account var is missing or malformed.

## 4. Deploy the page (GitHub Pages)

Put `index.html` in a repo, enable Pages (deploy from branch, root), open it, paste the Render URL into **Relay endpoint**, **Connect**.

---

## Using it

- **Save credentials to relay** stores your Resend key + From address server-side. The status line shows `key on relay (re_ab…wxyz)` once set.
- **Schedule types:** Once / Every-N / Daily / Cron.
  - **Every-N** now supports **seconds**, minutes, hours, days. It shows an estimated **sends/day** and warns when you'd blow past Resend's 100/day cap. The relay floors intervals at 1 second.
  - **Daily / Cron** run on the relay's clock = **UTC** on Render.
- Schedules persist: redeploy or let Render sleep, and they reload from Firestore on the next boot.

## Security notes

- The Resend key and service account never leave the server and are never logged.
- The relay only returns a **masked** key (`re_ab…wxyz`).
- Keep `firestore.rules` set to deny-all; all legitimate access is via the relay's Admin SDK.
- Set `ALLOWED_ORIGIN` so only your page can reach the relay.
