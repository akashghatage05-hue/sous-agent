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
Step 1 — Ask occasion: {"body":"What's the occasion? 🍴","buttons":["👫 Date Night","👨‍👩‍👧 Family","😊 Casual"]}
Step 2 — Suggest ONE restaurant with vibe: {"body":"Fatty Bao, Indiranagar — great ambience, Asian fusion. Perfect for a date! 🥢","buttons":["📅 Book Table","🔄 Different Venue"]}
Step 3 — After book: plain text reservation confirmation with time slot.

SPECIAL RESPONSES — return these exact JSON objects and nothing else:
- User asks about anything NOT food/restaurants/groceries/dining (weather, sports, news, tech, etc.): {"outOfScope":true}
- You genuinely don't understand the user's food-related request: {"confused":true}

RULES:
- When offering 2–3 choices → respond ONLY with: {"body":"...","buttons":["A","B","C"]}
- Button titles max 20 chars
- All other responses → plain text only
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

const FALLBACK_MESSAGES = [
  "Hmm, didn't catch that 😅 What can I help you with?",
  "That's outside my food zone 🍽️ Let me help you order!",
  "I only speak food! Let me help you with that 🍱",
  "Not sure what you mean — let me show you what I can do!",
];

// Per-user session: Claude message history + error-tracking metadata
const conversations = new Map();
const MAX_HISTORY = 20;

// Deduplication: ignore duplicate webhook deliveries for the same message ID (60-second window)
const seenMessageIds = new Map();
function isDuplicateMessage(msgId) {
  const now = Date.now();
  for (const [id, ts] of seenMessageIds) {
    if (now - ts > 60_000) seenMessageIds.delete(id);
  }
  if (seenMessageIds.has(msgId)) return true;
  seenMessageIds.set(msgId, now);
  return false;
}

function getSession(userId) {
  if (!conversations.has(userId)) {
    conversations.set(userId, {
      history: [],
      errorCount: 0,
      lastMsgs: [],      // last 3 user texts for stuck detection
      usedErrorIdxs: [], // fallback message rotation state
    });
  }
  return conversations.get(userId);
}

function getNextErrorMessage(session) {
  if (session.usedErrorIdxs.length >= FALLBACK_MESSAGES.length) {
    session.usedErrorIdxs = [];
  }
  const available = FALLBACK_MESSAGES
    .map((_, i) => i)
    .filter((i) => !session.usedErrorIdxs.includes(i));
  const idx = available[Math.floor(Math.random() * available.length)];
  session.usedErrorIdxs.push(idx);
  return FALLBACK_MESSAGES[idx];
}

function trackMessage(session, userText) {
  session.lastMsgs.push(userText);
  if (session.lastMsgs.length > 3) session.lastMsgs.shift();
}

function isStuck(session) {
  const last = session.lastMsgs;
  return last.length >= 3 && last.slice(-3).every((m) => m === last.at(-1));
}

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

async function sendWhatsAppText(to, text) {
  await axios.post(
    whatsappUrl(),
    { messaging_product: "whatsapp", to, type: "text", text: { body: text } },
    { headers: whatsappHeaders() }
  );
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

function extractJson(str) {
  // Strip markdown code fences Claude sometimes adds
  const stripped = str.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    return JSON.parse(stripped);
  } catch {
    // Try pulling the first {...} block out of surrounding prose
    const match = stripped.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { /* not JSON */ }
    }
    return null;
  }
}

function parseClaudeResponse(raw) {
  const parsed = extractJson(raw);
  if (parsed) {
    if (parsed.outOfScope === true) return { outOfScope: true };
    if (parsed.confused === true) return { confused: true };
    if (typeof parsed.body === "string") {
      if (Array.isArray(parsed.buttons) && parsed.buttons.length) {
        return { body: parsed.body, buttons: parsed.buttons.slice(0, 3) };
      }
      // JSON with body but no buttons — treat as plain text response
      return { body: parsed.body, buttons: null };
    }
  }
  // Truly plain text
  return { body: raw, buttons: null };
}

async function getClaudeReply(session, userMessage) {
  const { history } = session;
  history.push({ role: "user", content: userMessage });
  while (history.length > MAX_HISTORY) history.splice(0, 2);

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: history,
    });

    const raw = response.content.find((b) => b.type === "text")?.text ?? '{"confused":true}';
    history.push({ role: "assistant", content: raw });
    return parseClaudeResponse(raw);
  } catch (err) {
    console.error("[claude] API error:", err.message);
    history.pop(); // allow retry — don't poison history with unanswered message
    return { apiError: true };
  }
}

// ── Error & fallback handlers ─────────────────────────────────────────────────

async function handleTieredError(from, session) {
  session.errorCount++;
  console.log(`[error] tier ${session.errorCount} for ${from}`);

  if (session.errorCount >= 3) {
    conversations.delete(from);
    await sendWhatsAppButtons(from, "Let me take you back to the start 🔄", MAIN_MENU_BUTTONS);
    return;
  }

  if (session.errorCount === 2) {
    await sendWhatsAppButtons(from, "Here's what Sous can help with:", MAIN_MENU_BUTTONS);
    return;
  }

  await sendWhatsAppButtons(from, getNextErrorMessage(session), MAIN_MENU_BUTTONS);
}

// ── Nav helpers ───────────────────────────────────────────────────────────────

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

const UNSUPPORTED_TYPES = new Set(["audio", "image", "video", "document", "sticker"]);

app.post("/webhook", async (req, res) => {
  console.log("[webhook] POST received");
  console.log("[webhook] body:", JSON.stringify(req.body));

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    if (!value?.messages) return res.sendStatus(200);

    const message = value.messages[0];

    // Deduplicate — WhatsApp Cloud API can fire the same event twice
    if (message.id && isDuplicateMessage(message.id)) {
      console.log(`[webhook] duplicate message id=${message.id} — skipping`);
      return res.sendStatus(200);
    }

    console.log("[webhook] message.type:", message.type);

    // Unsupported media — reply and bail
    if (UNSUPPORTED_TYPES.has(message.type)) {
      await new Promise((r) => setTimeout(r, 1000));
      await sendWhatsAppText(
        message.from,
        "I can only read text for now 😊 Type what you need and I'll sort it out!"
      );
      return res.sendStatus(200);
    }

    let from, userText, isNavCommand = false;

    if (message.type === "text") {
      from = message.from;
      userText = message.text.body;
    } else if (message.type === "interactive") {
      const listReply = message.interactive?.list_reply;
      const buttonReply = message.interactive?.button_reply;
      if (listReply) {
        from = message.from;
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

    // Typing simulation
    await new Promise((r) => setTimeout(r, 1000));

    // New user — welcome + init session
    if (!conversations.has(from)) {
      console.log("[webhook] new user — sending welcome");
      await sendWhatsAppButtons(from, WELCOME.body, WELCOME.buttons);
      getSession(from);
      return res.sendStatus(200);
    }

    // Nav footer tap
    if (isNavCommand) {
      console.log(`[webhook] nav command: ${userText}`);
      await handleNavCommand(from, userText);
      return res.sendStatus(200);
    }

    const session = getSession(from);

    // Track before checking — stuck fires on 3rd identical message
    trackMessage(session, userText);
    if (isStuck(session)) {
      console.log(`[webhook] stuck detected for ${from}`);
      conversations.delete(from);
      await sendWhatsAppButtons(
        from,
        "Looks like you're stuck! Let me reset and start fresh 🔄",
        MAIN_MENU_BUTTONS
      );
      return res.sendStatus(200);
    }

    console.log("[webhook] calling Claude...");
    const result = await getClaudeReply(session, userText);
    console.log(`[webhook] result:`, JSON.stringify(result));

    if (result.apiError || result.confused) {
      await handleTieredError(from, session);
    } else if (result.outOfScope) {
      session.errorCount = 0; // out-of-scope is handled, not an error
      await sendWhatsAppButtons(
        from,
        "I'm Sous — I only know food! 🍽️ Here's what I can help with:",
        MAIN_MENU_BUTTONS
      );
    } else {
      session.errorCount = 0;
      const { body, buttons } = result;
      if (buttons && buttons.length > 0) {
        await sendWhatsAppButtons(from, body, buttons);
      } else {
        await sendWithNavFooter(from, body);
      }
    }

    console.log(`[webhook] reply delivered to ${from}`);

    // ACK last — Vercel terminates the function the moment the response is sent
    res.sendStatus(200);
  } catch (err) {
    console.error("[webhook] error:", err?.response?.data ?? err.message);
    // Return 200 so Meta does not retry — the error is already logged
    res.sendStatus(200);
  }
});

// ── Export for Vercel (serverless); listen only when run directly ─────────────

export default app;

if (process.env.NODE_ENV === "development") {
  const PORT = process.env.PORT ?? 3000;
  app.listen(PORT, () => console.log(`Sous bot listening on port ${PORT}`));
}
