// /api/_diag.js
//
// Temporary diagnostic endpoint. Hit it in your browser to see the actual
// reason Google is rejecting the refresh token. DELETE this file once the
// integration works — leaving it in production exposes which Google account
// the app is configured for.

import { google } from "googleapis";

export default async function handler(req, res) {
  const env = process.env;

  // Safely report which env vars are set, without leaking values.
  const fingerprint = (v) =>
    v ? { set: true, length: v.length, last4: v.slice(-4) } : { set: false };

  const envReport = {
    GOOGLE_CLIENT_ID: fingerprint(env.GOOGLE_CLIENT_ID),
    GOOGLE_CLIENT_SECRET: fingerprint(env.GOOGLE_CLIENT_SECRET),
    GOOGLE_REFRESH_TOKEN: fingerprint(env.GOOGLE_REFRESH_TOKEN),
    GOOGLE_CALENDAR_ID: { set: !!env.GOOGLE_CALENDAR_ID, value: env.GOOGLE_CALENDAR_ID || null },
    OWNER_EMAIL: { set: !!env.OWNER_EMAIL, value: env.OWNER_EMAIL || null },
    GOOGLE_CALENDAR_TIMEZONE: { set: !!env.GOOGLE_CALENDAR_TIMEZONE, value: env.GOOGLE_CALENDAR_TIMEZONE || null },
  };

  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REFRESH_TOKEN) {
    return res.status(200).json({ stage: "env-check", env: envReport, error: "Missing required env vars" });
  }

  // Sanity check: refresh tokens from Google start with "1//"
  const refreshTokenLooksRight = env.GOOGLE_REFRESH_TOKEN.startsWith("1//");

  // Try the token refresh and surface Google's verbose response.
  try {
    const oauth2Client = new google.auth.OAuth2(
      env.GOOGLE_CLIENT_ID,
      env.GOOGLE_CLIENT_SECRET
    );
    oauth2Client.setCredentials({ refresh_token: env.GOOGLE_REFRESH_TOKEN });

    const { credentials } = await oauth2Client.refreshAccessToken();

    // If we got here, the token works — try fetching the calendar list to confirm scopes.
    let identity = null;
    try {
      const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
      const me = await oauth2.userinfo.get();
      identity = { email: me.data.email, verified: me.data.verified_email };
    } catch (e) {
      identity = { error: e?.message };
    }

    return res.status(200).json({
      stage: "ok",
      env: envReport,
      refreshTokenLooksRight,
      tokenRefresh: {
        success: true,
        accessTokenExpiresIn: credentials.expiry_date
          ? Math.round((credentials.expiry_date - Date.now()) / 1000) + "s"
          : null,
        scope: credentials.scope || null,
      },
      authorizedAs: identity,
    });
  } catch (err) {
    return res.status(200).json({
      stage: "token-refresh-failed",
      env: envReport,
      refreshTokenLooksRight,
      googleError: err?.response?.data || null,
      message: err?.message || String(err),
    });
  }
}
