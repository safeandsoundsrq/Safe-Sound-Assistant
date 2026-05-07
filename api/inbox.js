// /api/inbox.js
//
// Cron-triggered endpoint that monitors safeandsound.sarasota@gmail.com for
// inbound service inquiries and replies via the Safe & Sound assistant.
//
// Flow per run:
//   1. Fetch unread, inbox-only messages that aren't already labeled "ai-handled".
//   2. For each thread, build the conversation history visible to us.
//   3. Skip threads that don't look like service inquiries (auto-replies, vendors,
//      threads where someone human already replied from our side).
//   4. Hand the thread to Claude with the same system prompt as the chat assistant
//      (with email-specific tweaks).
//   5. Send the AI's reply on the thread.
//   6. If Claude emitted BOOKING_DATA AND the estimated total is under the
//      AUTOBOOK_LIMIT_USD threshold, also create a tentative calendar event
//      and fire the existing confirmation email.
//   7. Mark the source message as read and apply the "ai-handled" label so we
//      don't process the same email twice.
//
// Required env vars (in addition to the ones api/email.js + api/calendar.js use):
//   ANTHROPIC_API_KEY
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET
//   GOOGLE_REFRESH_TOKEN     <-- must now have gmail.modify scope (was gmail.send)
//   OWNER_EMAIL              e.g. safeandsound.sarasota@gmail.com
//   CRON_SECRET              random string; Vercel sends this in the Authorization header
//   AUTOBOOK_LIMIT_USD       e.g. 500   (estimates at or under this auto-book)
//   GOOGLE_CALENDAR_ID       (already used by api/calendar.js)

import { google } from "googleapis";

const MAX_PER_RUN = 10;          // safety cap so a flood doesn't blow our budget
const MAX_AI_REPLIES_PER_THREAD = 6;
const AI_LABEL_NAME = "ai-handled";

export default async function handler(req, res) {
  // --- auth: only the Vercel cron (or you) can hit this ---
  const expected = `Bearer ${process.env.CRON_SECRET || ""}`;
  if (!process.env.CRON_SECRET || req.headers.authorization !== expected) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  try {
    const gmail = await gmailClient();
    const labelId = await ensureLabel(gmail, AI_LABEL_NAME);
    const candidates = await fetchUnhandled(gmail, labelId);

    const summary = [];
    for (const msg of candidates.slice(0, MAX_PER_RUN)) {
      try {
        const result = await processMessage(gmail, msg.id, labelId);
        summary.push({ id: msg.id, ...result });
      } catch (err) {
        console.error(`processMessage failed for ${msg.id}:`, err);
        summary.push({ id: msg.id, status: "error", error: err.message });
      }
    }

    return res.status(200).json({ ok: true, processed: summary.length, summary });
  } catch (err) {
    console.error("inbox handler failed:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

// =====================================================================
// Gmail helpers
// =====================================================================

async function gmailClient() {
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth2.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.gmail({ version: "v1", auth: oauth2 });
}

async function ensureLabel(gmail, name) {
  const list = await gmail.users.labels.list({ userId: "me" });
  const found = (list.data.labels || []).find((l) => l.name === name);
  if (found) return found.id;
  const created = await gmail.users.labels.create({
    userId: "me",
    requestBody: {
      name,
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    },
  });
  return created.data.id;
}

async function fetchUnhandled(gmail, labelId) {
  // Query: unread, in inbox, not already handled by us, ignore drafts/sent.
  const q = `is:unread in:inbox -label:${AI_LABEL_NAME} -from:me`;
  const list = await gmail.users.messages.list({ userId: "me", q, maxResults: MAX_PER_RUN });
  return list.data.messages || [];
}

// =====================================================================
// Per-message pipeline
// =====================================================================

async function processMessage(gmail, messageId, labelId) {
  const msg = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });

  const headers = headerMap(msg.data.payload?.headers || []);
  const threadId = msg.data.threadId;
  const fromAddr = parseAddress(headers.from || "");
  const subject = headers.subject || "(no subject)";

  // --- guardrails: skip auto-replies, mailer daemons, ourselves, threads we already replied to without a customer follow-up ---
  if (looksAutomated(headers, msg.data)) {
    await markHandled(gmail, messageId, labelId, "skipped: automated");
    return { status: "skipped", reason: "automated", subject };
  }

  if (sameAddress(fromAddr, process.env.OWNER_EMAIL)) {
    await markHandled(gmail, messageId, labelId, "skipped: from owner");
    return { status: "skipped", reason: "from owner", subject };
  }

  // Fetch the whole thread so we have conversation context
  const thread = await gmail.users.threads.get({ userId: "me", id: threadId, format: "full" });
  const conversation = thread.data.messages.map(messageToTurn).filter(Boolean);

  // If the most recent thing in the thread isn't this customer email, skip.
  // (A human at our end may have already replied, in which case we step out.)
  const lastTurn = conversation[conversation.length - 1];
  if (!lastTurn || lastTurn.role !== "user") {
    await markHandled(gmail, messageId, labelId, "skipped: not the latest turn");
    return { status: "skipped", reason: "not latest turn", subject };
  }

  const aiReplies = conversation.filter((t) => t.role === "assistant" && t.fromAi).length;
  if (aiReplies >= MAX_AI_REPLIES_PER_THREAD) {
    await markHandled(gmail, messageId, labelId, "skipped: reply cap reached");
    return { status: "skipped", reason: "reply cap", subject };
  }

  // --- ask Claude ---
  const claude = await callClaude(conversation, { fromAddr, subject });
  if (claude.classification === "not_inquiry") {
    await markHandled(gmail, messageId, labelId, "skipped: not service inquiry");
    return { status: "skipped", reason: "not inquiry", subject, classification: claude.classification };
  }

  // --- send the reply on this thread ---
  const replyResult = await sendReply(gmail, {
    to: fromAddr,
    subject: subject.startsWith("Re:") ? subject : `Re: ${subject}`,
    inReplyTo: headers["message-id"],
    references: headers.references
      ? `${headers.references} ${headers["message-id"] || ""}`.trim()
      : headers["message-id"] || "",
    threadId,
    htmlBody: textToEmailHtml(claude.replyText),
    plainBody: claude.replyText,
  });

  // --- conditional auto-book ---
  let bookingResult = null;
  if (claude.booking) {
    const limit = Number(process.env.AUTOBOOK_LIMIT_USD || 500);
    const totalLow = parseLowDollar(claude.booking.estimatedTotal);
    if (totalLow !== null && totalLow <= limit) {
      bookingResult = await internalCalendarAndConfirm(claude.booking);
    } else {
      bookingResult = { skipped: true, reason: `estimate above $${limit} threshold`, totalLow };
    }
  }

  await markHandled(gmail, messageId, labelId, "handled");

  return {
    status: "handled",
    subject,
    from: fromAddr,
    aiClassification: claude.classification,
    replyId: replyResult.id,
    booking: bookingResult,
  };
}

// =====================================================================
// Claude (email-mode system prompt)
// =====================================================================

const EMAIL_PROMPT = `You are the email assistant for Safe and Sound Delivery & Moving — a high-end delivery and moving service offering State-Wide Delivery, based in Sarasota, FL. You answer customer email inquiries with the same warm, professional, polished tone the chat assistant uses.

OPERATING CONTEXT:
- You are reading and replying to real customer email. The customer cannot see structured booking JSON; only the body of your message is sent to them.
- Keep replies tight: no markdown, no asterisks, no tables. Plain readable prose with simple labeled lines for any quote breakdown.
- Sign off as "— The Safe & Sound team" (no individual name).
- Always close estimates with the standard disclaimer that the figure is an estimate, not a fixed quote.

FIRST DECISION (do this silently before anything else):
Classify the email. Output one of:
- service_inquiry — customer asking about delivery, moving, packing, junk removal, assembly, estate staging, or a quote / scheduling.
- not_inquiry — vendor pitch, spam, personal correspondence, automated notification, or anything not asking for our service.
Put the classification on its own first line, exactly:  CLASSIFICATION: service_inquiry  OR  CLASSIFICATION: not_inquiry
After the classification line, leave a blank line, then write the customer-facing email body. If classification is not_inquiry, write nothing after that line.

SERVICES OFFERED:
- Local Delivery (5 items or fewer)
- Full Service Moving (more than 5 items)
- Packing
- Junk Removal
- Assembly
- Estate Staging
- Storage Services — we organize / move items related to storage; we do NOT rent storage units.

BASE PRICING:
- Base rate: $120/hr for a 2-person crew.
- Distance surcharge: free under 20 miles, +$25 for 20–39 miles, +$50 for 40–59 miles, +$25 per additional 20 miles.
- Stairs: +$20/hr per flight.
- Weekend/holiday surcharge: +20% on the hourly rate.
- Minimums: 1 hour for delivery, 3 hours for moves.
- Hours: Mon–Fri 8am–4pm, Sat by appointment (surcharge applies), Sun closed.

DRIVE TIME: Always include round-trip drive time from origin (2255 N. Washington Blvd, Sarasota, FL 34234) → pickup → drop-off → origin. Estimate using your knowledge of Sarasota / Manatee / Charlotte county geography.

CONVERSATION FLOW (you are mid-thread; the email history is provided):
1. If the customer hasn't given enough info, ask for what's missing in a friendly, concise way. Typical missing fields: name, service type, pickup address, drop-off address, item list, preferred date/time, stairs, contact phone.
2. Once you have enough info, give the itemized estimate inline in the email body. Always end the estimate with this exact line:
   "Please note: this is an estimate, not a fixed quote. All services are billed hourly, and the final cost depends on the actual time required on the day of service. Conditions like access, item complexity, and traffic can affect total time."
3. Then add: "Our team will review this and reach out shortly to confirm the details and finalize the quote."
4. If you have all booking info AND the customer has confirmed they want to proceed, you may emit a BOOKING_DATA tag (instructions below). Otherwise do not.

PHOTO POLICY: When photos would help (Packing, Full Service Moving, breakables, large jobs), warmly ask the customer to email photos to safeandsound.sarasota@gmail.com — explain it helps us bring the right truck size and crew. Note that the price reflects this photo-pending visibility.

FULL-SERVICE MOVE RULES (truck sizing):
- Up to ~2-bedroom move with standard furniture → 16' box truck (no rental fee).
- Larger / oversized / many heavy pieces → 26' truck. Quote MUST add 1.5 hours of billable time AND a flat $130 truck rental fee.

ESTATE STAGING — collect: number of rooms, number of large items.
PACKING — quote as a price RANGE on a separate line from the move itself. Always ask for photos of breakables.

DATE NORMALIZATION:
- The CURRENT DATE is provided below. If the customer says "Saturday" or "next Tuesday", resolve it against that date.
- In any BOOKING_DATA tag, "date" MUST be ISO YYYY-MM-DD and "time" MUST be 24-hour HH:MM.
- Friendly format is fine in the email body.

BOOKING_DATA TAG (only when customer confirmed they want to book AND you have all required fields):
At the very end of your reply (after the customer-facing prose), put this on its own line:
BOOKING_DATA:{"name":"...","phone":"...","email":"...","service":"...","pickupAddress":"...","dropoffAddress":"...","date":"YYYY-MM-DD","time":"HH:MM","items":"...","stairs":"...","estimatedTotal":"$X – $Y","notes":"..."}
The system will strip this line before the email is sent — the customer will never see it.`;

async function callClaude(conversation, ctx) {
  const now = new Date();
  const friendly = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  }).format(now);
  const iso = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);

  const dateContext = `CURRENT DATE CONTEXT (source of truth):
- Today is ${friendly}.
- ISO: ${iso}.
- Timezone: America/New_York (Sarasota, FL).
- Customer email address (for the BOOKING_DATA "email" field): ${ctx.fromAddr}
- Subject of the latest customer message: ${ctx.subject}

`;

  const messages = conversation.map((t) => ({
    role: t.role,
    content: t.content,
  }));

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-opus-4-5",
      max_tokens: 1500,
      system: dateContext + EMAIL_PROMPT,
      messages,
    }),
  });

  const data = await response.json();
  const raw = data.content?.[0]?.text || "";

  // Parse classification line
  const classMatch = raw.match(/^\s*CLASSIFICATION:\s*(\w+)/i);
  const classification = classMatch ? classMatch[1].toLowerCase() : "service_inquiry";

  // Parse booking tag
  const bookingMatch = raw.match(/BOOKING_DATA:(\{.*\})/);
  let booking = null;
  if (bookingMatch) {
    try { booking = JSON.parse(bookingMatch[1]); } catch { booking = null; }
  }

  // Strip both classification and booking tag from what gets emailed
  let replyText = raw
    .replace(/^\s*CLASSIFICATION:\s*\w+\s*\n?/i, "")
    .replace(/BOOKING_DATA:\{.*\}/, "")
    .trim();

  return { classification, booking, replyText };
}

// =====================================================================
// Outbound mail (threaded reply)
// =====================================================================

async function sendReply(gmail, opts) {
  const boundary = "S_S_" + Math.random().toString(36).slice(2);
  const lines = [
    `From: Safe & Sound Delivery & Moving <${process.env.OWNER_EMAIL}>`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    opts.inReplyTo ? `In-Reply-To: ${opts.inReplyTo}` : null,
    opts.references ? `References: ${opts.references}` : null,
    "X-SS-Bot: 1",
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    opts.plainBody,
    "",
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    opts.htmlBody,
    "",
    `--${boundary}--`,
  ].filter(Boolean);

  const raw = Buffer.from(lines.join("\r\n"))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const result = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw, threadId: opts.threadId },
  });
  return { id: result.data.id };
}

async function markHandled(gmail, messageId, labelId, _note) {
  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: { removeLabelIds: ["UNREAD"], addLabelIds: [labelId] },
  });
}

// =====================================================================
// Calendar + confirmation email passthrough
// =====================================================================

async function internalCalendarAndConfirm(booking) {
  // Re-use the same fetch shape as the chat widget. We hit our own routes so
  // any future logic added to api/calendar or api/email applies uniformly.
  const base = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "";
  const result = { calendar: null, email: null };

  try {
    const r = await fetch(`${base}/api/calendar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ booking }),
    });
    result.calendar = await r.json();
  } catch (e) {
    result.calendar = { success: false, error: e.message };
  }

  try {
    const r = await fetch(`${base}/api/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ booking }),
    });
    result.email = await r.json();
  } catch (e) {
    result.email = { success: false, error: e.message };
  }

  return result;
}

// =====================================================================
// Parsing helpers
// =====================================================================

function headerMap(headers) {
  const out = {};
  for (const h of headers) out[h.name.toLowerCase()] = h.value;
  return out;
}

function parseAddress(raw) {
  const m = raw.match(/<([^>]+)>/);
  return (m ? m[1] : raw).trim().toLowerCase();
}

function sameAddress(a, b) {
  return (a || "").toLowerCase() === (b || "").toLowerCase();
}

function looksAutomated(headers, msg) {
  if (headers["auto-submitted"] && headers["auto-submitted"] !== "no") return true;
  if (headers["x-autoreply"]) return true;
  if (headers["x-autorespond"]) return true;
  if (headers["x-ss-bot"]) return true;                 // our own outgoing
  if (headers.precedence && /bulk|list|junk/i.test(headers.precedence)) return true;
  const from = (headers.from || "").toLowerCase();
  if (/mailer-daemon|no[-_]?reply|do[-_]?not[-_]?reply|notifications?@|postmaster/.test(from)) return true;
  const labelIds = msg.labelIds || [];
  if (labelIds.includes("SPAM") || labelIds.includes("CATEGORY_PROMOTIONS") || labelIds.includes("CATEGORY_SOCIAL")) return true;
  return false;
}

function messageToTurn(m) {
  const headers = headerMap(m.payload?.headers || []);
  const fromAddr = parseAddress(headers.from || "");
  const isFromUs = sameAddress(fromAddr, process.env.OWNER_EMAIL);
  const fromAi = !!headers["x-ss-bot"];
  const body = extractPlainBody(m.payload);
  if (!body) return null;
  return {
    role: isFromUs ? "assistant" : "user",
    content: stripQuotedReply(body).trim(),
    fromAi,
  };
}

function extractPlainBody(payload) {
  if (!payload) return "";
  if (payload.body?.data && payload.mimeType?.startsWith("text/plain")) {
    return decodeBase64Url(payload.body.data);
  }
  if (payload.parts && payload.parts.length) {
    // prefer text/plain
    const plain = payload.parts.find((p) => p.mimeType === "text/plain");
    if (plain?.body?.data) return decodeBase64Url(plain.body.data);
    // recurse into multipart
    for (const p of payload.parts) {
      const inner = extractPlainBody(p);
      if (inner) return inner;
    }
    // fallback: strip html
    const html = payload.parts.find((p) => p.mimeType === "text/html");
    if (html?.body?.data) {
      return decodeBase64Url(html.body.data)
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ");
    }
  }
  return "";
}

function decodeBase64Url(s) {
  try {
    return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
  } catch {
    return "";
  }
}

function stripQuotedReply(body) {
  // Cut everything below the first reply marker so Claude isn't re-reading
  // the entire history every turn. Common markers from Gmail / iOS / Outlook.
  const cuts = [
    /^On .+ wrote:$/m,
    /^From: .+$/m,
    /^-+\s*Original Message\s*-+$/im,
    /^>{1,}/m,
  ];
  let earliest = body.length;
  for (const re of cuts) {
    const m = body.match(re);
    if (m && m.index < earliest) earliest = m.index;
  }
  return body.slice(0, earliest);
}

function parseLowDollar(estimatedTotal) {
  if (!estimatedTotal) return null;
  // Pull the first dollar amount; supports "$300", "$300 – $450", "300-450", etc.
  const m = String(estimatedTotal).match(/\$?\s*(\d{2,5}(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

function textToEmailHtml(text) {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const paragraphs = escaped
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px;">${p.replace(/\n/g, "<br/>")}</p>`)
    .join("");
  return `<div style="font-family: Georgia, 'Times New Roman', serif; font-size:14px; line-height:1.6; color:#222; max-width:560px;">${paragraphs}</div>`;
}
