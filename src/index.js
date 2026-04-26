import express from "express";
import axios from "axios";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT =
  "You are Sous, an AI food companion. You help users plan meals, order groceries, and book restaurants across Swiggy. Be conversational, helpful and concise. Never use markdown formatting like asterisks for bold/italics, hyphens for bullet points, or pound signs for headers. Use plain text only. For lists use simple numbered format like 1. 2. 3. You can use WhatsApp native formatting: *single asterisks for bold* and emojis are fine.";

// Per-user conversation history (in-memory; keyed by WhatsApp sender ID)
const conversations = new Map();
const MAX_HISTORY = 20; // keep last 20 messages per user

// ── WhatsApp Cloud API helpers ────────────────────────────────────────────────

async function sendWhatsAppMessage(to, text) {
  console.log("[sendWhatsApp] PHONE_NUMBER_ID:", process.env.PHONE_NUMBER_ID);
  await axios.post(
    `https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

// ── Claude helper ─────────────────────────────────────────────────────────────

async function getClaudeReply(userId, userMessage) {
  if (!conversations.has(userId)) {
    conversations.set(userId, []);
  }

  const history = conversations.get(userId);
  history.push({ role: "user", content: userMessage });

  // Trim to MAX_HISTORY (keep pairs so history stays alternating)
  while (history.length > MAX_HISTORY) {
    history.splice(0, 2);
  }

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    // Cache the system prompt — saves tokens on every subsequent turn
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: history,
  });

  const reply =
    response.content.find((b) => b.type === "text")?.text ??
    "Sorry, I couldn't generate a response. Please try again.";

  history.push({ role: "assistant", content: reply });

  return reply;
}

// ── Debug routes ─────────────────────────────────────────────────────────────

app.get("/test", (_req, res) => {
  res.json({ status: "ok", verify_token_set: !!process.env.VERIFY_TOKEN });
});

app.get("/webhook-test", (req, res) => {
  res.json(req.query);
});

// ── Webhook routes ────────────────────────────────────────────────────────────

// GET  /webhook — verification handshake required by Meta
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    console.log("Webhook verified ✓");
    return res.status(200).send(challenge);
  }

  res.sendStatus(403);
});

// POST /webhook — incoming messages from WhatsApp
app.post("/webhook", async (req, res) => {
  console.log("[webhook] POST received");
  console.log("[webhook] body:", JSON.stringify(req.body));

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    console.log("[webhook] value.messages:", value?.messages ? "present" : "absent");

    // Ignore status updates (delivered, read, etc.)
    if (!value?.messages) {
      console.log("[webhook] no messages field — ignoring");
      return res.sendStatus(200);
    }

    const message = value.messages[0];
    console.log("[webhook] message.type:", message.type);

    // Only handle text messages for now
    if (message.type !== "text") {
      console.log("[webhook] non-text message — ignoring");
      return res.sendStatus(200);
    }

    const from = message.from;
    const text = message.text.body;
    console.log(`[webhook] from=${from} text="${text}"`);

    console.log("[webhook] calling Claude...");
    const reply = await getClaudeReply(from, text);
    console.log(`[webhook] Claude reply="${reply}"`);

    console.log("[webhook] sending WhatsApp reply...");
    await sendWhatsAppMessage(from, reply);
    console.log(`[webhook] reply delivered to ${from}`);

    // ACK sent last — on Vercel serverless the function stops when the
    // response is flushed, so this must come after all async work.
    res.sendStatus(200);
  } catch (err) {
    console.error("[webhook] error:", err?.response?.data ?? err.message);
    res.sendStatus(500);
  }
});

// ── Export for Vercel (serverless); listen only when run directly ─────────────

export default app;

if (process.env.NODE_ENV === "development") {
  const PORT = process.env.PORT ?? 3000;
  app.listen(PORT, () => {
    console.log(`Sous bot listening on port ${PORT}`);
  });
}
