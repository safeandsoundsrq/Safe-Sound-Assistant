// /api/calendar.js
//
// Receives a `booking` JSON object from the front-end after the assistant
// emits a BOOKING_DATA tag. Creates a tentative event on the configured
// Google Calendar so the owner can review/approve.
//
// Required environment variables (set in Vercel → Settings → Environment Variables):
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET
//   GOOGLE_REFRESH_TOKEN
//   GOOGLE_CALENDAR_ID         (e.g. safeandsound.sarasota@gmail.com)
//   GOOGLE_CALENDAR_TIMEZONE   (optional, defaults to America/New_York)

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
      GOOGLE_CALENDAR_ID,
      GOOGLE_CALENDAR_TIMEZONE,
    } = process.env;

    if (
      !GOOGLE_CLIENT_ID ||
      !GOOGLE_CLIENT_SECRET ||
      !GOOGLE_REFRESH_TOKEN ||
      !GOOGLE_CALENDAR_ID
    ) {
      console.error("Calendar env vars missing");
      return res
        .status(500)
        .json({ success: false, error: "Calendar not configured on server" });
    }

    const timeZone = GOOGLE_CALENDAR_TIMEZONE || "America/New_York";

    const oauth2Client = new google.auth.OAuth2(
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET
    );
    oauth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });

    const calendar = google.calendar({ version: "v3", auth: oauth2Client });

    const { start, end } = buildEventTimes(booking.date, booking.time, booking.service);

    const summary = `[Pending Review] ${booking.service || "Booking"} — ${booking.name || "Customer"}`;
    const description = formatDescription(booking);
    const location = booking.pickupAddress || "";

    const result = await calendar.events.insert({
      calendarId: GOOGLE_CALENDAR_ID,
      requestBody: {
        summary,
        description,
        location,
        start: { dateTime: toRFC3339Local(start), timeZone },
        end: { dateTime: toRFC3339Local(end), timeZone },
        // Tentative status so the owner can confirm before it's "real"
        status: "tentative",
      },
    });

    return res.status(200).json({
      success: true,
      eventId: result.data.id,
      htmlLink: result.data.htmlLink,
    });
  } catch (err) {
    console.error("Calendar insert failed:", err?.response?.data || err);
    return res
      .status(500)
      .json({ success: false, error: err?.message || "Unknown error" });
  }
}

// --- helpers ---

function buildEventTimes(dateStr, timeStr, service) {
  const baseDate = parseDate(dateStr);
  const { hours, minutes } = parseTimeString(timeStr);
  baseDate.setHours(hours, minutes, 0, 0);

  // Default duration based on service. Move minimum is 3hrs, delivery 1hr.
  const lower = (service || "").toLowerCase();
  const durationHours = lower.includes("delivery") || lower.includes("niche")
    ? 1
    : 3;

  const end = new Date(baseDate.getTime() + durationHours * 60 * 60 * 1000);
  return { start: baseDate, end };
}

function parseDate(s) {
  if (!s) return tomorrow();

  // Already ISO YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return new Date(`${s}T00:00:00`);
  }

  // Weekday name fallback ("Saturday", "next Saturday", etc.)
  const weekdays = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
  };
  const lower = String(s).toLowerCase();
  for (const [name, idx] of Object.entries(weekdays)) {
    if (lower.includes(name)) {
      const today = new Date();
      const d = new Date(today);
      d.setHours(0, 0, 0, 0);
      const diff = (idx - d.getDay() + 7) % 7 || 7; // always future
      d.setDate(d.getDate() + diff);
      return d;
    }
  }

  // Last resort: native Date parser
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) return parsed;
  return tomorrow();
}

function tomorrow() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d;
}

function parseTimeString(t) {
  if (!t) return { hours: 9, minutes: 0 };
  const m = String(t).trim().match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return { hours: 9, minutes: 0 };
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = (m[3] || "").toLowerCase();
  if (ampm === "pm" && h < 12) h += 12;
  if (ampm === "am" && h === 12) h = 0;
  return { hours: h, minutes: min };
}

// Returns "YYYY-MM-DDTHH:MM:SS" (no Z) — pairs with timeZone field so
// Google interprets it as local time in the specified zone.
function toRFC3339Local(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    "-" +
    pad(d.getMonth() + 1) +
    "-" +
    pad(d.getDate()) +
    "T" +
    pad(d.getHours()) +
    ":" +
    pad(d.getMinutes()) +
    ":" +
    pad(d.getSeconds())
  );
}

function formatDescription(b) {
  const lines = [
    "PENDING REVIEW — booking submitted via online assistant.",
    "",
    `Customer:   ${b.name || ""}`,
    `Phone:      ${b.phone || ""}`,
    `Email:      ${b.email || ""}`,
    `Service:    ${b.service || ""}`,
    `Pickup:     ${b.pickupAddress || ""}`,
    `Drop-off:   ${b.dropoffAddress || ""}`,
    `Items:      ${b.items || ""}`,
    `Stairs:     ${b.stairs || ""}`,
    `Est. Total: ${b.estimatedTotal || ""}`,
  ];
  if (b.notes) {
    lines.push("", `Notes: ${b.notes}`);
  }
  return lines.join("\n");
}
