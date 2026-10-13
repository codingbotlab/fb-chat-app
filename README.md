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
4. Set server-only environment variables: \`SUPABASE_URL\`, \`SUPABASE_ANON_KEY\`, \`SUPABASE_SERVICE_ROLE_KEY\`, \`VAPID_PUBLIC_KEY\`, \`VAPID_PRIVATE_KEY\`, and \`VAPID_SUBJECT\`. Keep the service-role key and VAPID private key server-only; never commit them or put them in browser code.
5. Run \`npm ci\`, \`npm run check\`, \`npm test\`, then \`npm start\`.

## Free Render deployment

- Connect this repository to a Node.js **Web Service** in Render.
- Build command: \`npm ci\`; start command: \`npm start\`.
- Add \`SUPABASE_URL\`, \`SUPABASE_ANON_KEY\`, \`SUPABASE_SERVICE_ROLE_KEY\`, \`VAPID_PUBLIC_KEY\`, \`VAPID_PRIVATE_KEY\`, and \`VAPID_SUBJECT\` in Render's Environment page. Keep the service-role key and VAPID private key server-only; never commit them or put them in browser code.
- After deploying, \`/health\` should report \`authConfigured: true\` and \`/api/config\` should report \`configured: true\`. A missing key intentionally leaves sign-up disabled.
- Free web services may sleep when idle; cold starts may delay the first connection. Check provider usage and database backups before relying on the service.

Never put the service-role key in frontend code, Git, or public issues. \`GET /api/config\` returns only the public anon key and configured state.

## Android install and automatic web updates

- The site can be installed on Android as a standalone Progressive Web App (PWA): open `https://chat.fashionbazz.in` in Chrome and choose **Install app** (or Chrome menu → **Add to Home screen**).
- `public/sw.js` uses network-first requests for the app shell, so new website assets are fetched when online. The worker checks for updates when the app opens or becomes visible and activates new versions automatically.
- Auth/API responses and Socket.IO paths are not stored in Cache Storage. Offline mode is limited to the cached app shell; messaging itself needs connectivity.
- This is an installable web app, not a self-updating native APK. Android does not silently replace a sideloaded APK; native package updates normally go through Google Play or a user-confirmed updater. The installed PWA's web content updates from the live site without reinstalling an APK.

## Features in this iteration

- Supabase Auth sign up/sign in; server validates bearer tokens.
- Username lookup and private direct chat backed by Postgres.
- Messages are encrypted in the browser before transmission; the database stores ciphertext and IV.
- Online presence, typing signals, delivery/read metadata and chat history.
- Dark, responsive, WhatsApp-inspired chat layout with search and unread/online filters.
- First-seen peer key pinning and warning when a pinned public key changes.
- WhatsApp-inspired date dividers, reply previews, emoji picker, message copy/star/hide actions, foreground message sound, and read/delivery ticks.
- Web Push for the installable Chrome PWA once permission is granted and server VAPID keys are set; payloads include no decrypted message text.
- Native Android APK supports Firebase Cloud Messaging (FCM) token registration, a high-importance notification channel with system sound/vibration, and tapping a notification to open that sender's chat. The APK needs the matching `google-services.json`; the server needs the private `FCM_SERVICE_ACCOUNT_JSON` and `FCM_PROJECT_ID` environment variables, plus the `fcm_tokens` table created from `supabase/schema.sql`.

## Important security and feature limits

This is a prototype, not a production-certified WhatsApp replacement. The custom encryption protocol has not received an independent cryptographic audit. There is no multi-device synchronization, contact discovery, groups, media/voice/video calls, polished account recovery, blocking/reporting, moderation, or key backup/restore workflow. Web Push works on the installed Chrome PWA after permission and VAPID configuration. Native APK push requires the Firebase service-account secret and FCM token table to be configured on the server; this credential must never be committed to Git. First-contact key pinning does not independently verify a contact's identity; compare fingerprints out-of-band for sensitive conversations. The password-derived encrypted private-key backup means a password reset may make older messages unrecoverable. A compromised deployment can serve modified JavaScript, so the server remains inside the trust boundary. Do not use this for highly sensitive communications until independently reviewed.

Free hosting and database services have usage quotas and inactivity/retention limits. Verify provider limits before relying on them for permanent storage.

## Native Android FCM notifications

- Firebase project: `fbchat-native-push-20261014`; Android package: `com.codingbotlab.fbchat`. The public Android configuration is stored in `android/app/google-services.json`.
- The Android wrapper requests notification permission, fetches its FCM token, registers it with the signed-in account, and displays a generic encrypted-message alert using the Android Messages notification channel. Tapping an alert opens the sender chat.
- Run the additive FCM token-table SQL in `supabase/schema.sql` against the FB Chat Supabase project before using the new endpoints.
- To enable sending from Render, set `FCM_PROJECT_ID=fbchat-native-push-20261014` and the server-only `FCM_SERVICE_ACCOUNT_JSON` environment variable to the JSON credential for a service account with the Firebase Cloud Messaging send role. Keep that private credential out of Git and frontend code.
- `/health` reports `nativePushConfigured`. It remains false until the Render service has valid service-account credentials. Never treat a successful APK build as proof of end-to-end delivery; test on a device with Google Play services and notifications allowed.
