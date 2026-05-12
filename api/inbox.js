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
      bookingResult =
