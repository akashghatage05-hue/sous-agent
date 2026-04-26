import express from "express";
import axios from "axios";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are Sous, an AI food companion. You help users plan meals, order groceries, and book restaurants across Swiggy. Be conversational, helpful and concise. Never use markdown formatting like asterisks for bold/italics, hyphens for bullet points, or pound signs for headers. Use plain text only. For lists use simple numbered format like 1. 2. 3. You can use WhatsApp native formatting: *single asterisks for bold* and emojis are fine.

When you want to offer the user a choice between 2-3 options, respond with this exact JSON and nothing else:
{"body":"your message here","buttons":["Option 1","Option 2","Option 3"]}
Button titles must be 20 characters or less. For all other responses use plain text only.`;

const WELCOME = {
  body: "👋 Hey! I'm *Sous*, your AI food companion powered by Swiggy. What would you like to do?",
  buttons: ["🍔 Order Food", "🛒 Get Groceries", "🍽️ Book a Table"],
};

// Per-user conversation history (in-memory; keyed by WhatsApp sender ID)
const conversations = new Map();
const MAX_HISTORY = 20;

// ── WhatsApp Cloud API helpers ────────────────────────────────────────────────

function whatsappHeaders() {
  return {
    Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
    "Content-Type": "application/json",
  };
}

function whatsappUrl() {
  console.log("[whatsapp] PHONE_NUMBER_ID:", process.env.PHONE_NUMBER_ID);
  return `https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`;
}

async function sendWhatsAppMessage(to, text) {
  console.log(`[sendText] to=${to} text="${text}"`);
  await axios.post(
    whatsappUrl(),
    { messaging_product: "whatsapp", to, type: "text", text: { body: text } },
    { headers: whatsappHeaders() }
  );
}

async function sendWhatsAppButtons(to, bodyText, buttons) {
  console.log(`[sendButtons] to=${to} body="${bodyText}" buttons=${JSON.stringify(buttons)}`);
  const action = {
    buttons: buttons.slice(0, 3).map((label, i) => ({
      type: "reply",
      reply: {
        id: `btn_${i}_${label.toLowerCase().replace(/\W+/g, "_")}`.substring(0, 256),
        title: label.substring(0, 20),
      },
    })),
  };
  await axios.post(
    whatsappUrl(),
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: { type: "button", body: { text: bodyText }, action },
    },
    { headers: whatsappHeaders() }
  );
}

// ── Claude helpers ────────────────────────────────────────────────────────────

function parseClaudeResponse(raw) {
  try {
    const parsed = JSON.parse(raw.trim());
    if (typeof parsed.body === "string" && Array.isArray(parsed.buttons) && parsed.buttons.length) {
      return { body: parsed.body, buttons: parsed.buttons.slice(0, 3) };
    }
  } catch {
    // plain text — fall through
  }
  return { body: raw, buttons: null };
}

async function getClaudeReply(userId, userMessage) {
  if (!conversations.has(userId)) {
    conversations.set(userId, []);
  }

  const history = conversations.get(userId);
  history.push({ role: "user", content: userMessage });

  while (history.length > MAX_HISTORY) {
    history.splice(0, 2);
  }

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: history,
  });

  const raw =
    response.content.find((b) => b.type === "text")?.text ??
    "Sorry, I couldn't generate a response. Please try again.";

  history.push({ role: "assistant", content: raw });

  return parseClaudeResponse(raw);
}

// ── Debug routes ─────────────────────────────────────────────────────────────

app.get("/test", (_req, res) => {
  res.json({ status: "ok", verify_token_set: !!process.env.VERIFY_TOKEN });
});

app.get("/webhook-test", (req, res) => {
  res.json(req.query);
});

// ── Webhook routes ────────────────────────────────────────────────────────────

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

app.post("/webhook", async (req, res) => {
  console.log("[webhook] POST received");
  console.log("[webhook] body:", JSON.stringify(req.body));

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    console.log("[webhook] value.messages:", value?.messages ? "present" : "absent");

    if (!value?.messages) {
      console.log("[webhook] no messages field — ignoring");
      return res.sendStatus(200);
    }

    const message = value.messages[0];
    console.log("[webhook] message.type:", message.type);

    let from, userText;

    if (message.type === "text") {
      from = message.from;
      userText = message.text.body;
      console.log(`[webhook] text from=${from} text="${userText}"`);
    } else if (message.type === "interactive") {
      // User tapped a button
      const reply = message.interactive?.button_reply;
      if (!reply) {
        console.log("[webhook] interactive but no button_reply — ignoring");
        return res.sendStatus(200);
      }
      from = message.from;
      userText = reply.title;
      console.log(`[webhook] button reply from=${from} id="${reply.id}" title="${reply.title}"`);
    } else {
      console.log("[webhook] unhandled message type:", message.type, "— ignoring");
      return res.sendStatus(200);
    }

    // First contact: send welcome buttons and stop — their next message starts the conversation
    if (!conversations.has(from)) {
      console.log("[webhook] new user — sending welcome");
      await sendWhatsAppButtons(from, WELCOME.body, WELCOME.buttons);
      // Initialise an empty history so the next message routes to Claude
      conversations.set(from, []);
      return res.sendStatus(200);
    }

    console.log("[webhook] calling Claude...");
    const { body, buttons } = await getClaudeReply(from, userText);
    console.log(`[webhook] Claude body="${body}" buttons=${JSON.stringify(buttons)}`);

    if (buttons && buttons.length > 0) {
      console.log("[webhook] sending interactive button message...");
      await sendWhatsAppButtons(from, body, buttons);
    } else {
      console.log("[webhook] sending text message...");
      await sendWhatsAppMessage(from, body);
    }

    console.log(`[webhook] reply delivered to ${from}`);

    // ACK last — Vercel terminates the function the moment the response is sent
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
  app.listen(PORT, () => console.log(`Sous bot listening on port ${PORT}`));
}
