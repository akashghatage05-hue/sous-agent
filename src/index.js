import express from "express";
import axios from "axios";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are Sous, an AI food companion on WhatsApp for Swiggy. Punchy, warm, WhatsApp-native tone. Keep every response under 3 lines. No markdown (no **, no -, no #). Plain text only. *bold* and emojis are fine.

FLOWS — Follow these strictly:

ORDER FOOD:
Step 1 — Ask cuisine: {"body":"What are you craving? 🍽️","buttons":["🍛 Indian","🍕 Italian","🍜 Asian"]}
Step 2 — After cuisine pick, suggest ONE restaurant with name + area: {"body":"How about Behrouz Biryani, Koramangala? Famous for their dum biryani. 🤤","buttons":["✅ Order Here","🔄 Different Place"]}
Step 3 — After confirm: plain text order confirmation with 30–45 min ETA.

GROCERIES:
Step 1 — Ask what they need (plain text, no buttons). Example: "What do you need from Instamart? Just list it out! 🛒"
Step 2 — Show a 3–5 item cart summary with prices, then: {"body":"Cart total: ₹486\n\n1. Amul Milk 1L – ₹68\n2. Onions 1kg – ₹42\n3. Bread – ₹45","buttons":["🛒 Place Order","✏️ Edit List"]}
Step 3 — After confirm: plain text confirmation with 10–20 min delivery.

DINE OUT:
Step 1 — Ask occasion: {"body":"What's the occasion? 🍴","buttons":["👫 Date Night","👨‍👩‍👧 Family","💼 Business","😊 Casual"]}
  Note: max 3 buttons — use Casual/Date/Family for first pass; offer Business if they ask.
Step 2 — Suggest ONE restaurant with vibe: {"body":"Fatty Bao, Indiranagar — great ambience, Asian fusion. Perfect for a date! 🥢","buttons":["📅 Book Table","🔄 Different Venue"]}
Step 3 — After book: plain text reservation confirmation with time slot.

RULES:
- When offering 2–3 choices → respond ONLY with: {"body":"...","buttons":["A","B","C"]}
- Button titles max 20 chars
- For all other responses (info, confirmations, questions without choices) → respond with plain text only
- If you don't understand or get off-topic → {"body":"Hmm, didn't catch that! What would you like to do? 😊","buttons":["🍽️ Order Food","🛒 Groceries","🍴 Dine Out"]}
- Never leave the user without a next step`;

const MAIN_MENU_BUTTONS = ["🍽️ Order Food", "🛒 Groceries", "🍴 Dine Out"];

const WELCOME = {
  body: "👋 Hey! I'm *Sous*, your AI food companion powered by Swiggy. What are you in the mood for?",
  buttons: MAIN_MENU_BUTTONS,
};

const NAV_ROWS = [
  { id: "nav_main_menu", title: "🏠 Main Menu" },
  { id: "nav_start_over", title: "🔄 Start Over" },
  { id: "nav_help", title: "❓ Help" },
];

const conversations = new Map();
const MAX_HISTORY = 20;

// ── WhatsApp helpers ──────────────────────────────────────────────────────────

function whatsappHeaders() {
  return {
    Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
    "Content-Type": "application/json",
  };
}

function whatsappUrl() {
  return `https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`;
}

async function sendWhatsAppButtons(to, bodyText, buttons) {
  console.log(`[sendButtons] to=${to} buttons=${JSON.stringify(buttons)}`);
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
      interactive: {
        type: "button",
        body: { text: bodyText },
        footer: { text: "Or type anything to chat" },
        action,
      },
    },
    { headers: whatsappHeaders() }
  );
}

// Sends a list message — used for all non-button responses so nav footer is always present
async function sendWithNavFooter(to, bodyText) {
  console.log(`[sendList] to=${to} body="${bodyText}"`);
  await axios.post(
    whatsappUrl(),
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: bodyText },
        footer: { text: "Quick navigation below" },
        action: {
          button: "Options ▾",
          sections: [{ title: "Navigation", rows: NAV_ROWS }],
        },
      },
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
    '{"body":"Something went wrong. Let\'s start fresh!","buttons":["🍽️ Order Food","🛒 Groceries","🍴 Dine Out"]}';

  history.push({ role: "assistant", content: raw });

  return parseClaudeResponse(raw);
}

// ── Nav command helpers ───────────────────────────────────────────────────────

function isNavId(id) {
  return id === "nav_main_menu" || id === "nav_start_over" || id === "nav_help";
}

async function handleNavCommand(from, id) {
  if (id === "nav_start_over") {
    conversations.delete(from);
    await sendWhatsAppButtons(from, "Fresh start! What can I help you with? 🍱", MAIN_MENU_BUTTONS);
  } else if (id === "nav_help") {
    await sendWithNavFooter(
      from,
      "I'm Sous 🍱 — your Swiggy food companion!\n\nI can help you order food, shop Instamart groceries, or book a restaurant table. Just pick an option or type what you need."
    );
  } else {
    await sendWhatsAppButtons(from, "What would you like to do? 🍽️", MAIN_MENU_BUTTONS);
  }
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

    if (!value?.messages) {
      return res.sendStatus(200);
    }

    const message = value.messages[0];
    console.log("[webhook] message.type:", message.type);

    let from, userText, isNavCommand = false;

    if (message.type === "text") {
      from = message.from;
      userText = message.text.body;
    } else if (message.type === "interactive") {
      const buttonReply = message.interactive?.button_reply;
      const listReply = message.interactive?.list_reply;

      if (listReply) {
        from = message.from;
        // List replies are always nav commands — use ID for clean matching
        userText = listReply.id;
        isNavCommand = isNavId(listReply.id);
        console.log(`[webhook] list_reply from=${from} id="${listReply.id}"`);
      } else if (buttonReply) {
        from = message.from;
        userText = buttonReply.title;
        console.log(`[webhook] button_reply from=${from} title="${buttonReply.title}"`);
      } else {
        return res.sendStatus(200);
      }
    } else {
      console.log("[webhook] unhandled type:", message.type);
      return res.sendStatus(200);
    }

    // Typing simulation — do before any async WhatsApp calls
    await new Promise((r) => setTimeout(r, 1000));

    // New user — send welcome, init empty history
    if (!conversations.has(from)) {
      console.log("[webhook] new user — sending welcome");
      await sendWhatsAppButtons(from, WELCOME.body, WELCOME.buttons);
      conversations.set(from, []);
      return res.sendStatus(200);
    }

    // Persistent nav command (tapped list footer item)
    if (isNavCommand) {
      console.log(`[webhook] nav command: ${userText}`);
      await handleNavCommand(from, userText);
      return res.sendStatus(200);
    }

    // Normal message — ask Claude
    console.log("[webhook] calling Claude...");
    const { body, buttons } = await getClaudeReply(from, userText);
    console.log(`[webhook] Claude body="${body}" buttons=${JSON.stringify(buttons)}`);

    if (buttons && buttons.length > 0) {
      await sendWhatsAppButtons(from, body, buttons);
    } else {
      await sendWithNavFooter(from, body);
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
