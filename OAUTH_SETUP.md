# Re-authorizing Gmail OAuth for the inbox monitor

The new `api/inbox.js` route reads the inbox in addition to sending mail. The existing refresh token only has `gmail.send` scope — we need to swap it for one with `gmail.modify` (which covers reading, labeling, marking-as-read, and sending). The Calendar scope stays the same.

You can do this entirely in the browser — no command line required.

---

## Steps

### 1. Find your existing Google OAuth client

1. Open https://console.cloud.google.com/apis/credentials
2. Make sure the project at the top of the page is the same one used for the assistant (the one whose Client ID matches the `GOOGLE_CLIENT_ID` value in Vercel).
3. Click the OAuth 2.0 Client ID row, and on its detail page note the **Client ID** and **Client Secret** (they should match what's already in Vercel).
4. While you're here, scroll down to **Authorized redirect URIs** and confirm `https://developers.google.com/oauthplayground` is listed. If not, click **Add URI**, paste it in, and click **Save**. (You can remove it again at the end if you want.)

### 2. Get a new refresh token from Google's OAuth Playground

1. Open https://developers.google.com/oauthplayground in a new tab.
2. Click the **gear icon** (⚙️) in the top right.
3. Tick **"Use your own OAuth credentials"**.
4. Paste the **Client ID** and **Client Secret** from step 1. Click **Close**.
5. In the left panel under **Step 1**, in the "Input your own scopes" box at the bottom, paste these two scopes separated by a space:

   ```
   https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/gmail.modify
   ```

6. Click **Authorize APIs**.
7. A Google sign-in window opens. Sign in as **safeandsound.sarasota@gmail.com** (this is critical — you must consent as the inbox owner). Click **Continue / Allow** through the prompts.
8. You'll be redirected back to the playground at **Step 2**. Click **Exchange authorization code for tokens**.
9. The right-hand panel now shows a JSON response containing a **`refresh_token`**. Copy that value — it's a long string that starts with `1//`.

### 3. Update the refresh token in Vercel

1. Open https://vercel.com/dashboard
2. Click your **safe-and-sound-assistant** project.
3. Click **Settings** → **Environment Variables**.
4. Find **`GOOGLE_REFRESH_TOKEN`**, click the three-dot menu → **Edit**.
5. Paste the new refresh token, save.

### 4. Add the new environment variables

Still in **Settings → Environment Variables**, click **Add New** and create these two:

| Name | Value |
|------|-------|
| `CRON_SECRET` | A long random string. Copy and paste this for example: `ssrq-cron-` followed by any 30+ random characters. Vercel sends this in a header so only the scheduled job (not random callers) can trigger the inbox endpoint. |
| `AUTOBOOK_LIMIT_USD` | `500` |

When you save each one, leave the default of all three environments (Production / Preview / Development) ticked.

### 5. Redeploy

Vercel only picks up new env vars on a fresh deploy. Either:
- Push a tiny change to GitHub (any change), OR
- Go to **Deployments**, click the three dots on the most recent production deploy, and choose **Redeploy**.

---

## How to know it worked

After the next 15-minute mark, open https://vercel.com/dashboard → your project → **Logs**. You'll see a line every 15 minutes like:

```
GET /api/inbox 200 — processed: 0
```

That means the cron triggered, the OAuth worked, and there were just no unread emails to process at that moment.

When a real customer email comes in, the same log will show `processed: 1` and a summary of what happened (replied / skipped / booked).

If you see a `401` or `403`, that means either the OAuth token is wrong or the scope didn't include `gmail.modify` — repeat steps 2–3.

---

## Removing the playground redirect URI (optional cleanup)

If you'd rather not leave the OAuth Playground in your authorized redirect URIs, go back to https://console.cloud.google.com/apis/credentials, open your client, and remove `https://developers.google.com/oauthplayground` from the list. Removing it does **not** invalidate the refresh token you just generated — it only blocks future re-auths through the playground.
