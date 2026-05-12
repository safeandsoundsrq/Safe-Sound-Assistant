// /api/inbox.js
//
// Cron-triggered endpoint that monitors safeandsound.sarasota@gmail.com and:
//   - Replies to service inquiries via the Safe & Sound assistant.
//   - Sorts obvious junk (promotions / vendor pitches / newsletters / auto
//     notifications) into a separate "ai-cleanup" label and removes them from
//     the inbox view. Nothing is deleted - the user can still find anything
//     by searching the label.
//   - Leaves important/personal mail untouched in the inbox (only labels it
//     as "ai-handled" so we don't re-evaluate it).
//
// Required env vars (in addition to ANTHROPIC_API_KEY and Google OAuth):
//   CRON_SECRET, AUTOBOOK_LIMIT_USD, OWNER_EMAIL, GOOGLE_CALENDAR_ID
//   INBOX_LOOKBACK_DAYS  (optional, default 1 - only look at mail newer than N days)

import { google } from "googleapis";

const MAX_PER_RUN = 10;
const MAX_AI_REPLIES_PER_THREAD = 6;
const HANDLED_LABEL = "ai-handled";
const CLEANUP_LABEL = "ai-cleanup";

// Used only when Claude classifies an email as service_inquiry but fails to
// write a body. Better to send a polite acknowledgment than an empty email.
const SAFE_FALLBACK_REPLY = `Hi,

Thank you for reaching out to Safe & Sound Delivery & Moving. We received your message and our team will review the details shortly.

To help us put together an accurate quote, could you share a few details when you have a moment:
- The service you need (delivery, moving, packing, junk removal, assembly, or estate staging)
- Pickup address and drop-off address
- A brief list or photos of the items involved
- Your preferred date and time
- A good phone number to reach you

Feel free to email any photos to safeandsound.sarasota@gmail.com - they help us bring the right truck size and crew so the day goes smoothly.

- The Safe & Sound team`;

export default async function handler(req, res) {
  const expected = `Bearer ${process.env.CRON_SECRET || ""}`;
  if (!process.env.CRON_SECRET || req.headers.authorization !== expected) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  try {
    const gmail = await gmailClient();
    const handledLabelId = await ensureLabel(gmail, HANDLED_LABEL);
    const cleanupLabelId = await ensureLabel(gmail, CLEANUP_LABEL);
    const candidates = await fetchUnhandled(gmail);

    const summary = [];
    for (const msg of candidates.slice(0, MAX_PER_RUN)) {
      try {
        const result = await processMessage(gmail, msg.id, {
          handledLabelId,
          cleanupLabelId,
        });
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

async function fetchUnhandled(gmail) {
  // Only consider RECENT mail. The cutoff prevents the assistant from ever
  // reaching back into old unread threads that may have been sitting around.
  // Default 1 day. Override with INBOX_LOOKBACK_DAYS in Vercel env vars.
  const days = Number(process.env.INBOX_LOOKBACK_DAYS || 1);
  const q = `is:unread in:inbox -label:${HANDLED_LABEL} -from:me newer_than:${days}d`;
  const list = await gmail.users.messages.list({ userId: "me", q, maxResults: MAX_PER_RUN });
  return list.data.messages || [];
}

// =====================================================================
// Per-message pipeline
// =====================================================================

async function processMessage(gmail, messageId, labels) {
  const msg = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });

  const headers = headerMap(msg.data.payload?.headers || []);
  const threadId = msg.data.threadId;
  const fromAddr = parseAddress(headers.from || "");
  const subject = headers.subject || "(no subject)";

  if (sameAddress(fromAddr, process.env.OWNER_EMAIL)) {
    await applyHandledLabel(gmail, messageId, labels.handledLabelId);
    return { status: "skipped", reason: "from owner", subject };
  }

  // Automated mail still gets moved out of inbox (that's literally cleanup).
  // We skip Claude to save tokens.
  if (looksAutomated(headers, msg.data)) {
    await moveToCleanup(gmail, messageId, labels);
    return { status: "cleanup", reason: "automated/promotional headers", subject };
  }

  const thread = await gmail.users.threads.get({ userId: "me", id: threadId, format: "full" });
  const conversation = thread.data.messages.map(messageToTurn).filter(Boolean);

  const lastTurn = conversation[conversation.length - 1];
  if (!lastTurn || lastTurn.role !== "user") {
    await applyHandledLabel(gmail, messageId, labels.handledLabelId);
    return { status: "skipped", reason: "not latest turn", subject };
  }

  const aiReplies = conversation.filter((t) => t.role === "assistant" && t.fromAi).length;
  if (aiReplies >= MAX_AI_REPLIES_PER_THREAD) {
    await applyHandledLabel(gmail, messageId, labels.handledLabelId);
    return { status: "skipped", reason: "reply cap", subject };
  }

  const claude = await callClaude(conversation, { fromAddr, subject });

  if (claude.classification === "cleanup") {
    await moveToCleanup(gmail, messageId, labels);
    return { status: "cleanup", reason: "ai classified as cleanup", subject };
  }

  if (claude.classification !== "service_inquiry") {
    // "important" or unrecognized -> stay in inbox, just mark handled
    await applyHandledLabel(gmail, messageId, labels.handledLabelId);
    return { status: "skipped", reason: "not a service inquiry", subject, classification: claude.classification };
  }

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

  await applyHandledLabel(gmail, messageId, labels.handledLabelId);

  return {
    status: "handled",
    subject,
    from: fromAddr,
    aiClassification: claude.classification,
    replyId: replyResult.id,
    booking: bookingResult,
    debug: claude.debug,
  };
}

// =====================================================================
// Claude (email-mode system prompt with 3-way classification)
// =====================================================================

const EMAIL_PROMPT = `You are the email assistant for Safe and Sound Delivery & Moving - a high-end delivery and moving service offering State-Wide Delivery, based in Sarasota, FL. You answer customer email inquiries with the same warm, professional, polished tone the chat assistant uses.

OPERATING CONTEXT:
- You are reading and replying to real customer email. The customer cannot see structured booking JSON; only the body of your message is sent to them.
- Keep replies tight: no markdown, no asterisks, no tables. Plain readable prose with simple labeled lines for any quote breakdown.
- Sign off as "- The Safe & Sound team" (no individual name).
- Always close estimates with the standard disclaimer that the figure is an estimate, not a fixed quote.

FIRST DECISION - CLASSIFY THE EMAIL (do this silently before anything else):
Output exactly one of three classifications on the very first line:

  CLASSIFICATION: service_inquiry
  CLASSIFICATION: important
  CLASSIFICATION: cleanup

Use this rubric:
- service_inquiry -> the sender is asking about delivery, moving, packing, junk removal, assembly, estate staging, a quote, a schedule, an availability, or otherwise needs our service. Includes both fresh leads and ongoing customer conversations.
- cleanup -> promotional / marketing email the sender wasn't invited to, unsolicited vendor pitches trying to sell US a service or product, recurring newsletters, generic mass mail, automated subscription notifications (receipts for services we don't need to act on, app notifications, social network updates, "your weekly digest"-style mail). The defining test: would the owner be comfortable not seeing this in the main inbox?
- important -> everything that isn't a service inquiry but is real correspondence we'd want visible: personal mail, mail from people the owner knows or works with, bills, banking, tax mail, government / school / .gov / .edu, mail referencing specific local addresses, real human-written mail even if borderline. WHEN IN DOUBT BETWEEN cleanup AND important, PICK important. We can always clean up later; we can't easily un-hide a mistakenly hidden important email.

WHAT TO WRITE AFTER THE CLASSIFICATION LINE:
- If classification is service_inquiry: leave a blank line, then write a COMPLETE customer-facing email body of at least one full paragraph. This is a hard requirement. NEVER leave the body empty. NEVER write only the classification line. Even if you cannot yet provide a quote because details are missing, write a warm acknowledgment that thanks the customer for reaching out and clearly asks for the specific information you still need (service type, addresses, item list, date/time, phone). The body is what gets sent to the customer - empty means the customer gets a blank email, which is unacceptable.
- If classification is important: output only the classification line and nothing else.
- If classification is cleanup: output only the classification line and nothing else.

SERVICES OFFERED:
- Local Delivery (5 items or fewer)
- Full Service Moving (more than 5 items)
- Packing
- Junk Removal
- Assembly
- Estate Staging
- Storage Services - we organize / move items related to storage; we do NOT rent storage units.

BASE PRICING:
- Base rate: $120/hr for a 2-person crew.
- Distance surcharge: free under 20 miles, +$25 for 20-39 miles, +$50 for 40-59 miles, +$25 per additional 20 miles.
- Stairs: +$20/hr per flight.
- Weekend/holiday surcharge: +20% on the hourly rate.
- Minimums: 1 hour for delivery, 3 hours for moves.
- Hours: Mon-Fri 8am-4pm, Sat by appointment (surcharge applies), Sun closed.

DRIVE TIME: Always include round-trip drive time from origin (2255 N. Washington Blvd, Sarasota, FL 34234) -> pickup -> drop-off -> origin. Estimate using your knowledge of Sarasota / Manatee / Charlotte county geography.

CONVERSATION FLOW (you are mid-thread; the email history is provided):
1. If the customer hasn't given enough info, ask for what's missing in a friendly, concise way. Typical missing fields: name, service type, pickup address, drop-off address, item list, preferred date/time, stairs, contact phone.
2. Once you have enough info, give the itemized estimate inline in the email body. Always end the estimate with this exact line:
   "Please note: this is an estimate, not a fixed quote. All services are billed hourly, and the final cost depends on the actual time required on the day of service. Conditions like access, item complexity, and traffic can affect total time."
3. Then add: "Our team will review this and reach out shortly to confirm the details and finalize the quote."
4. If you have all booking info AND the customer has confirmed they want to proceed, you may emit a BOOKING_DATA tag (instructions below). Otherwise do not.

PHOTO POLICY: When photos would help (Packing, Full Service Moving, breakables, large jobs), warmly ask the customer to email photos to safeandsound.sarasota@gmail.com - explain it helps us bring the right truck size and crew. Note that the price reflects this photo-pending visibility.

FULL-SERVICE MOVE RULES (truck sizing):
- Up to ~2-bedroom move with standard furniture -> 16' box truck (no rental fee).
- Larger / oversized / many heavy pieces -> 26' truck. Quote MUST add 1.5 hours of billable time AND a flat $130 truck rental fee.

ESTATE STAGING - collect: number of rooms, number of large items.
PACKING - quote as a price RANGE on a separate line from the move itself. Always ask for photos of breakables.

DATE NORMALIZATION:
- The CURRENT DATE is provided below. If the customer says "Saturday" or "next Tuesday", resolve it against that date.
- In any BOOKING_DATA tag, "date" MUST be ISO YYYY-MM-DD and "time" MUST be 24-hour HH:MM.
- Friendly format is fine in the email body.

BOOKING_DATA TAG (only when customer confirmed they want to book AND you have all required fields):
At the very end of your reply (after the customer-facing prose), put this on its own line:
BOOKING_DATA:{"name":"...","phone":"...","email":"...","service":"...","pickupAddress":"...","dropoffAddress":"...","date":"YYYY-MM-DD","time":"HH:MM","items":"...","stairs":"...","estimatedTotal":"$X - $Y","notes":"..."}
The system will strip this line before the email is sent - the customer will never see it.`;

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
- Sender of the latest customer message: ${ctx.fromAddr}
- Subject of the latest message: ${ctx.subject}

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

  const classMatch = raw.match(/^\s*CLASSIFICATION:\s*(service_inquiry|important|cleanup|not_inquiry)/i);
  let classification = classMatch ? classMatch[1].toLowerCase() : "important";
  if (classification === "not_inquiry") classification = "important";

  const bookingMatch = raw.match(/BOOKING_DATA:(\{.*\})/);
  let booking = null;
  if (bookingMatch) {
    try { booking = JSON.parse(bookingMatch[1]); } catch { booking = null; }
  }

  let replyText = raw
    .replace(/^\s*CLASSIFICATION:\s*\w+\s*\n?/i, "")
    .replace(/BOOKING_DATA:\{.*\}/, "")
    .trim();

  // Diagnostic snapshot - included in the cron response so we can see what
  // Claude actually produced when something looks off.
  const debug = {
    rawLen: raw.length,
    replyLenBeforeFallback: replyText.length,
    rawPreview: raw.slice(0, 200),
    fallbackUsed: false,
  };

  // Safety net: Claude occasionally outputs only the classification line and
  // forgets to write a body. If that happens on an inquiry, fall back to a
  // safe generic acknowledgment rather than mailing the customer an empty
  // message. The booking tag (if any) is still respected.
  if (classification === "service_inquiry" && replyText.length < 30) {
    console.warn("Empty reply body from Claude on service_inquiry. Using fallback. Raw length:", raw.length);
    replyText = SAFE_FALLBACK_REPLY;
    debug.fallbackUsed = true;
  }

  debug.replyLenFinal = replyText.length;

  return { classification, booking, replyText, debug };
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
  ].filter((line) => line !== null);

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

async function applyHandledLabel(gmail, messageId, handledLabelId) {
  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: {
      removeLabelIds: ["UNREAD"],
      addLabelIds: [handledLabelId],
    },
  });
}

async function moveToCleanup(gmail, messageId, labels) {
  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: {
      removeLabelIds: ["UNREAD", "INBOX"],
      addLabelIds: [labels.handledLabelId, labels.cleanupLabelId],
    },
  });
}

// =====================================================================
// Calendar + confirmation email passthrough
// =====================================================================

async function internalCalendarAndConfirm(booking) {
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
  if (headers["x-ss-bot"]) return true;
  if (headers["list-unsubscribe"]) return true;
  if (headers["list-id"]) return true;
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
    const plain = payload.parts.find((p) => p.mimeType === "text/plain");
    if (plain?.body?.data) return decodeBase64Url(plain.body.data);
    for (const p of payload.parts) {
      const inner = extractPlainBody(p);
      if (inner) return inner;
    }
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
