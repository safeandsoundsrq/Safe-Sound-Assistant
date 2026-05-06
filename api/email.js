// /api/email.js
//
// Sends two emails after a successful booking:
//   1. Owner notification → safeandsound.sarasota@gmail.com (set via OWNER_EMAIL)
//   2. Customer confirmation → booking.email (if present)
//
// Reuses the same Google OAuth refresh token as /api/calendar. Requires the
// gmail.send scope on that refresh token (granted at consent time).
//
// Required environment variables:
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET
//   GOOGLE_REFRESH_TOKEN
//   OWNER_EMAIL          (e.g. safeandsound.sarasota@gmail.com)

import { google } from "googleapis";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  try {
    const { booking } = req.body || {};
    if (!booking || typeof booking !== "object") {
      return res.status(400).json({ success: false, error: "Missing booking data" });
    }

    const {
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET,
      GOOGLE_REFRESH_TOKEN,
      OWNER_EMAIL,
    } = process.env;

    if (
      !GOOGLE_CLIENT_ID ||
      !GOOGLE_CLIENT_SECRET ||
      !GOOGLE_REFRESH_TOKEN ||
      !OWNER_EMAIL
    ) {
      console.error("Email env vars missing");
      return res
        .status(500)
        .json({ success: false, error: "Email not configured on server" });
    }

    const oauth2Client = new google.auth.OAuth2(
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET
    );
    oauth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    const fromAddress = OWNER_EMAIL;
    const out = { success: true };

    // 1. Owner notification — always sent
    const ownerSubject = `New Job Booked — ${booking.service || "Booking"} for ${booking.name || "Customer"} on ${booking.date || "TBD"}`;
    out.owner = await sendMail(
      gmail,
      fromAddress,
      OWNER_EMAIL,
      ownerSubject,
      ownerEmailHtml(booking)
    );

    // 2. Customer confirmation — only if email looks valid
    const customerEmail = (booking.email || "").trim();
    if (/\S+@\S+\.\S+/.test(customerEmail)) {
      const customerSubject = `Your Safe & Sound Booking — ${booking.date || "scheduled"} at ${booking.time || ""}`.trim();
      out.customer = await sendMail(
        gmail,
        fromAddress,
        customerEmail,
        customerSubject,
        customerEmailHtml(booking)
      );
    } else {
      out.customer = { skipped: "no valid customer email" };
    }

    return res.status(200).json(out);
  } catch (err) {
    console.error("Email send failed:", err?.response?.data || err);
    return res
      .status(500)
      .json({ success: false, error: err?.message || "Unknown error" });
  }
}

// --- helpers ---

async function sendMail(gmail, from, to, subject, htmlBody) {
  const boundary = "S_S_" + Math.random().toString(36).slice(2);
  const lines = [
    `From: Safe & Sound Delivery & Moving <${from}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    htmlToPlain(htmlBody),
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    htmlBody,
    "",
    `--${boundary}--`,
  ];

  const raw = Buffer.from(lines.join("\r\n"))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const result = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });
  return { id: result.data.id };
}

function ownerEmailHtml(b) {
  return `<div style="font-family: Georgia, 'Times New Roman', serif; max-width:560px; color:#222;">
  <h2 style="color:#a07b1d; margin-bottom:4px;">New Job Booked</h2>
  <p style="margin-top:0; color:#555;">Submitted via the website assistant. Calendar event was created tentatively — please review and confirm.</p>
  <table style="border-collapse:collapse; width:100%; font-size:14px;">
    ${row("Customer", b.name)}
    ${row("Phone", b.phone)}
    ${row("Email", b.email)}
    ${row("Service", b.service)}
    ${row("Pickup", b.pickupAddress)}
    ${row("Drop-off", b.dropoffAddress)}
    ${row("Date", b.date)}
    ${row("Time", b.time)}
    ${row("Items", b.items)}
    ${row("Stairs", b.stairs)}
    ${row("Est. Total", b.estimatedTotal)}
    ${b.notes ? row("Notes", b.notes) : ""}
  </table>
</div>`;
}

function customerEmailHtml(b) {
  return `<div style="font-family: Georgia, 'Times New Roman', serif; max-width:560px; color:#222;">
  <h2 style="color:#a07b1d; margin-bottom:4px;">Your Safe & Sound Booking</h2>
  <p>Hi ${escapeHtml(b.name || "there")},</p>
  <p>Thank you for choosing Safe &amp; Sound Delivery &amp; Moving. Below is the summary of your tentative booking — our team will reach out shortly to confirm.</p>
  <table style="border-collapse:collapse; width:100%; font-size:14px;">
    ${row("Service", b.service)}
    ${row("Pickup", b.pickupAddress)}
    ${row("Drop-off", b.dropoffAddress)}
    ${row("Date", b.date)}
    ${row("Time", b.time)}
    ${row("Items", b.items)}
    ${row("Stairs", b.stairs)}
    ${row("Est. Total", b.estimatedTotal)}
  </table>
  <p style="margin-top:16px;"><strong>One quick favor:</strong> please email photos of each room (or the items being moved) to <a href="mailto:safeandsound.sarasota@gmail.com">safeandsound.sarasota@gmail.com</a> before your appointment. Photos help us bring the right truck size and crew so the day goes smoothly.</p>
  <p style="font-size:12px; color:#555; line-height:1.5;">Please note: this is an estimate, not a fixed quote. All services are billed hourly, and the final cost depends on the actual time required on the day of service. Conditions like access, item complexity, and traffic can affect total time.</p>
  <p style="margin-top:24px;">— Safe &amp; Sound Delivery &amp; Moving<br/>
  Sarasota, FL · Mon–Fri 8am–4pm · Sat by appointment</p>
</div>`;
}

function row(label, value) {
  if (value === undefined || value === null || value === "") return "";
  return `<tr><td style="padding:4px 8px; color:#666; vertical-align:top; white-space:nowrap;">${escapeHtml(label)}:</td><td style="padding:4px 8px;">${escapeHtml(value)}</td></tr>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function htmlToPlain(html) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
