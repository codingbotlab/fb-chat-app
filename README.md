# FB Chat

A WhatsApp-inspired chat app starter with a dark, muted-green interface, conversation list, direct-message UI, online presence, typing state, and a small Node.js + Socket.IO server.

> **Status:** early development prototype. It is not a production messenger and is not end-to-end encrypted.

## Features in this starter

- Responsive desktop/mobile messaging interface
- Conversation list and quick search
- All, unread, and group chat filters
- Local display-name onboarding for testing
- Direct-message delivery between concurrently connected clients
- Basic online presence and typing indicator
- In-memory message history, limited to 500 messages per direct conversation
- Health endpoint at `/health`
- Input length and basic display-name validation

## Run locally

Requirements: Node.js 20 or newer and npm.

```bash
npm install
npm start
```

Open http://localhost:3000 in two browser sessions (for example, a regular window and an incognito window). Pick different display names. Start a chat using the other session's exact display name and send messages.

For auto-restart during development:

```bash
npm run dev
```

## Checks

```bash
npm run check
npm test
```

## Limitations before public deployment

This starter is for development only. It currently has **no real login, durable database, encrypted-at-rest storage, end-to-end encryption, file/media transfer, push notifications, voice/video calling, block/report tools, rate limiting, spam defenses, or moderation workflows**. Direct messages are stored only in server memory and are lost when the server restarts. The server currently uses display names as identities; this is not secure authentication.

Before opening this to the public:
1. Add real account authentication, secure sessions, email/phone verification and account recovery.
2. Add a durable database and private-message access controls.
3. Add per-user and per-IP rate limits, anti-spam protection, and abuse handling.
4. Design and implement real end-to-end encryption if that is a product requirement; do not advertise this starter as encrypted.
5. Add media storage/scanning, reporting/blocking, backups, monitoring and privacy/data deletion workflows.
6. Use HTTPS, a reverse proxy and a persistent hosting environment capable of WebSockets.

## Deployment

This is a Node.js + Socket.IO app; static-only hosting is not sufficient for real-time delivery. Verify the destination hosting plan supports a persistent Node process and WebSockets before deploying.

## Project isolation

This repo is separate from NEXUS and FB Social. Do not put NEXUS source code, access tokens, local `.env` files or other secrets in this repository.
