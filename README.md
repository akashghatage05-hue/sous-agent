# Sous — WhatsApp AI Food Companion

A WhatsApp webhook bot that uses Claude (`claude-sonnet-4-6`) to act as **Sous**, an AI food companion that helps users plan meals, order groceries, and book restaurants across Swiggy.

## How it works

```
User (WhatsApp) → Meta Cloud API → POST /webhook → Claude API → reply → User
```

- Each sender gets their own conversation history (last 20 messages, in-memory).
- The system prompt is cached with Anthropic's prompt-caching feature, reducing token costs on every turn.

---

## Prerequisites

- Node.js 18+
- A [Meta Developer account](https://developers.facebook.com/) with a WhatsApp Business app
- An [Anthropic API key](https://console.anthropic.com/)
- A public HTTPS URL for your server (use [ngrok](https://ngrok.com/) for local dev)

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env` and fill in:

| Variable | Where to find it |
|---|---|
| `ANTHROPIC_API_KEY` | [Anthropic Console](https://console.anthropic.com/) → API Keys |
| `WHATSAPP_TOKEN` | Meta App Dashboard → WhatsApp → API Setup → Temporary / Permanent token |
| `WHATSAPP_VERIFY_TOKEN` | Any secret string you choose (you'll enter the same value in Meta's webhook settings) |
| `WHATSAPP_PHONE_NUMBER_ID` | Meta App Dashboard → WhatsApp → API Setup → Phone Number ID |

### 3. Start the server

```bash
# Production
npm start

# Development (auto-restarts on file changes)
npm run dev
```

### 4. Expose your local server (development only)

```bash
ngrok http 3000
```

Copy the `https://` URL from ngrok.

### 5. Register the webhook with Meta

1. Go to **Meta App Dashboard** → your app → **WhatsApp** → **Configuration**.
2. Under **Webhook**, click **Edit**.
3. Set **Callback URL** to `https://<your-ngrok-url>/webhook`.
4. Set **Verify token** to the value of `WHATSAPP_VERIFY_TOKEN` in your `.env`.
5. Click **Verify and save**.
6. Subscribe to the **messages** field.

---

## Project structure

```
sous-agent/
├── src/
│   └── index.js        # Express server, webhook handlers, Claude integration
├── .env.example        # Environment variable template
├── package.json
└── README.md
```

---

## Customising the bot

- **System prompt** — edit `SYSTEM_PROMPT` in `src/index.js`.
- **Conversation memory** — adjust `MAX_HISTORY` (default: 20 messages per user).
- **Model** — change the `model` field in `anthropic.messages.create(...)`.
- **Persistent history** — replace the in-memory `Map` with a database (Redis, Postgres, etc.) to survive restarts.

---

## Deploying to production

Any platform that can run Node.js and receive inbound HTTPS requests works:

- **Railway / Render / Fly.io** — push the repo and set env vars in the dashboard.
- **AWS / GCP / Azure** — deploy as a container or serverless function behind an HTTPS endpoint.

Make sure to update your Meta webhook callback URL to the production domain after deploying.
