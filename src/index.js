import "dotenv/config";
import express from "express";
import axios from "axios";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT =
  "You are Sous, an AI food companion. You help users plan meals, order groceries, and book restaurants across Swiggy. Be conversational, helpful and concise.";

// Per-user conversation history (in-memory; keyed by WhatsApp sender ID)
const conversations = new Map();
const MAX_HISTORY = 20; // keep last 20 messages per user

// ── WhatsApp Cloud API helpers ────────────────────────────────────────────────

async function sendWhatsAppMessage(to, text) {
  await axios.post(
    `https://graph.facebook.com/v21.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
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

// ── Webhook routes ────────────────────────────────────────────────────────────

// GET  /webhook — verification handshake required by Meta
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log("Webhook verified ✓");
    return res.status(200).send(challenge);
  }

  res.sendStatus(403);
});

// POST /webhook — incoming messages from WhatsApp
app.post("/webhook", async (req, res) => {
  // Acknowledge immediately so Meta doesn't retry
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // Ignore status updates (delivered, read, etc.)
    if (!value?.messages) return;

    const message = value.messages[0];

    // Only handle text messages for now
    if (message.type !== "text") return;

    const from = message.from; // sender's WhatsApp number
    const text = message.text.body;

    console.log(`[${from}] ${text}`);

    const reply = await getClaudeReply(from, text);
    await sendWhatsAppMessage(from, reply);

    console.log(`[bot → ${from}] ${reply}`);
  } catch (err) {
    console.error("Error handling webhook:", err?.response?.data ?? err.message);
  }
});

// ── Start server ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => {
  console.log(`Sous bot listening on port ${PORT}`);
});
