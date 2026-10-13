# FB Chat

WhatsApp-inspired real-time one-to-one chat prototype. This branch introduces account-backed sessions, encrypted direct-message storage, online presence, typing indicators, delivery/read metadata and a mobile-first interface.

## Stack

- Node.js + Express + Socket.IO
- Supabase Auth and Postgres
- Browser Web Crypto (ECDH P-256, HKDF-SHA-256 and AES-GCM)
- IndexedDB for the browser's non-extractable private key

## Local development

1. Create a separate Supabase project for FB Chat. Do not reuse or modify unrelated projects.
2. Run \`supabase/schema.sql\` in the project's SQL Editor.
3. In Supabase Auth settings, configure email confirmation and allowed redirect URLs.
4. Set server-only environment variables: \`SUPABASE_URL\`, \`SUPABASE_ANON_KEY\`, and \`SUPABASE_SERVICE_ROLE_KEY\`.
5. Run \`npm ci\`, \`npm run check\`, \`npm test\`, then \`npm start\`.

Never put the service-role key in frontend code, Git, or public issues. \`GET /api/config\` returns only the public anon key and configured state.

## Features in this iteration

- Supabase Auth sign up/sign in; server validates bearer tokens.
- Username lookup and private direct chat backed by Postgres.
- Messages are encrypted in the browser before transmission; the database stores ciphertext and IV.
- Online presence, typing signals, delivery/read metadata and chat history.
- Dark, responsive, WhatsApp-inspired chat layout with search and unread/online filters.
- First-seen peer key pinning and warning when a pinned public key changes.

## Important security and feature limits

This is a prototype, not a production-certified WhatsApp replacement. The custom encryption protocol has not received an independent cryptographic audit. There is no multi-device synchronization, contact discovery, groups, media/voice/video calls, push notifications, polished account recovery, blocking/reporting, moderation, or key backup/restore workflow. First-contact key pinning does not independently verify a contact's identity; compare fingerprints out-of-band for sensitive conversations. The password-derived encrypted private-key backup means a password reset may make older messages unrecoverable. A compromised deployment can serve modified JavaScript, so the server remains inside the trust boundary. Do not use this for highly sensitive communications until independently reviewed.

Free hosting and database services have usage quotas and inactivity/retention limits. Verify provider limits before relying on them for permanent storage.
