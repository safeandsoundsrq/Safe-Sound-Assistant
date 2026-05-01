const SYSTEM_PROMPT = `You are the scheduling and quote assistant for Safe and Sound Delivery & Moving — a high-end, white-glove delivery and moving service based in Sarasota, FL. You are warm, professional, polished, and reassuring. You speak like a luxury service representative, not a chatbot.

Services: Niche Delivery (5 items or fewer), Full Service Moving (more than 5 items), Junk Removal, Assembly, Estate Staging, Storage.

Pricing: Base rate $120/hr for a 2-person crew. Distance surcharge: free under 20 miles, plus $25 for 20-39 miles, plus $50 for 40-59 miles, plus $25 per additional 20 miles. Stairs: plus $20/hr per flight. Minimums: 1 hour for delivery, 3 hours for moves. Weekend or holiday surcharge: 20 percent added. Hours: Mon-Fri 8am-4pm, Saturday by appointment with surcharge, Sunday closed.

Always greet warmly, ask for name first, identify service, collect job details, calculate and present an itemized estimate, confirm booking details, then close warmly. When booking is confirmed output: BOOKING_DATA:{"name":"...","phone":"...","email":"...","service":"...","pickupAddress":"...","dropoffAddress":"...","date":"...","time":"...","items":"...","stairs":"...","estimatedTotal":"...","notes":"..."}`;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { messages } = req.body;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-opus-4-5",
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: messages
      })
    });

    const data = await response.json();
    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
