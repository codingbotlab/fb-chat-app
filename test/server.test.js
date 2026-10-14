const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { app, normalize, validUsername, validDisplayName, validEncryptedMessage, validPushSubscription, validFcmToken } = require('../server');

test('native FCM tokens are bounded and whitespace-free', () => {
  assert.equal(validFcmToken('f'.repeat(152)), true);
  assert.equal(validFcmToken('short'), false);
  assert.equal(validFcmToken('f'.repeat(4097)), false);
  assert.equal(validFcmToken('f'.repeat(90) + String.fromCharCode(10)), false);
  assert.equal(validFcmToken('f'.repeat(70) + ' ' + 'f'.repeat(20)), false);
  assert.equal(validFcmToken(null), false);
});

test('normalization trims whitespace and case-folds usernames', () => {
  assert.equal(normalize('  Mayank   Kumar '), 'mayank kumar');
  assert.equal(normalize(null), '');
});

test('username validation enforces the documented public format', () => {
  assert.equal(validUsername('mayank_23'), true);
  assert.equal(validUsername('mayank.k'), true);
  assert.equal(validUsername('ab'), false);
  assert.equal(validUsername('a'.repeat(25)), false);
  assert.equal(validUsername('two words'), false);
  assert.equal(validUsername('<admin>'), false);
  assert.equal(validUsername('UPPERCASE'), true);
});

test('display names are bounded and reject markup delimiters', () => {
  assert.equal(validDisplayName('Mayank Kumar'), true);
  assert.equal(validDisplayName('A'), false);
  assert.equal(validDisplayName('x'.repeat(41)), false);
  assert.equal(validDisplayName('<admin>'), false);
});

test('encrypted message validation accepts ciphertext and 96-bit IV encoding', () => {
  assert.equal(validEncryptedMessage({ ciphertext: 'AQIDBA', iv: 'abcdefghijklmnop' }), true);
  assert.equal(validEncryptedMessage({ ciphertext: '', iv: 'abcdefghijklmnop' }), false);
  assert.equal(validEncryptedMessage({ ciphertext: 'abc', iv: 'short' }), false);
  assert.equal(validEncryptedMessage({ ciphertext: 'a'.repeat(65537), iv: 'abcdefghijklmnop' }), false);
  assert.equal(validEncryptedMessage({ ciphertext: 'abc', iv: 'abcdefghijklmnop', text: 'extra plaintext' }), false);
  assert.equal(validEncryptedMessage({ ciphertext: 'abc', iv: 'abcdefghijklmnop', plaintext: 'extra plaintext' }), false);
});

test('health and config endpoints do not expose service-role credentials', async (t) => {
  const srv = http.createServer(app);
  await new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => srv.close(() => resolve())));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const healthResponse = await fetch(base + '/health');
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.ok, true);
  assert.equal(health.service, 'fb-chat-app');
  assert.equal(typeof health.authConfigured, 'boolean');
  assert.equal(typeof health.nativePushConfigured, 'boolean');
  const configResponse = await fetch(base + '/api/config');
  assert.equal(configResponse.status, 200);
  const config = await configResponse.json();
  assert.equal(typeof config.configured, 'boolean');
  const pushResponse = await fetch(base + '/api/push/public-key');
  assert.equal(pushResponse.status, 200);
  const push = await pushResponse.json();
  assert.equal(typeof push.enabled, 'boolean');
  assert.equal(push.enabled, false);
  assert.equal(Object.hasOwn(config, 'supabaseServiceRoleKey'), false);
  assert.equal(Object.hasOwn(config, 'serviceRoleKey'), false);
});

test('profile endpoint fails closed while database setup is absent', async (t) => {
  const srv = http.createServer(app);
  await new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => srv.close(() => resolve())));
  const response = await fetch('http://127.0.0.1:' + srv.address().port + '/api/me');
  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.equal(payload.error, 'SERVER_NOT_CONFIGURED');
});

test('WhatsApp-style screen includes all required UI targets and no canned sample chats', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  for (const id of [
    'app', 'chatList', 'chatSearch', 'newChat', 'mobileSettingsButton', 'emptyNewChat', 'welcomeNewChat',
    'authOverlay', 'authForm', 'loginTab', 'signupTab', 'displayName', 'username',
    'email', 'password', 'chatDetails', 'messages', 'composeForm', 'messageInput',
    'sendBtn', 'genericModal', 'genericForm', 'genericInput', 'connectionDot'
  ]) {
    assert.match(html, new RegExp('id="' + id + '"'), 'missing UI element: ' + id);
  }
  assert.match(js, /encryptText|async function encryptText/);
  assert.match(js, /decryptText|async function decryptText/);
  assert.doesNotMatch(html + js, /Aarav Sharma|Sana Khan|Creators Club/);
});

test('PWA manifest and app icons satisfy install dimensions', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..', 'public');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.name, 'FB Chat — Private Messenger');
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.start_url.startsWith('/'));
  assert.ok(manifest.icons.some((item) => item.sizes === '192x192'));
  assert.ok(manifest.icons.some((item) => item.sizes === '512x512' && item.purpose === 'any'));
  assert.ok(manifest.icons.some((item) => item.sizes === '512x512' && item.purpose === 'maskable'));
  for (const icon of manifest.icons) {
    const bytes = fs.readFileSync(path.join(root, icon.src.replace(/^\//, '')));
    assert.equal(bytes.toString('hex', 0, 8), '89504e470d0a1a0a', icon.src + ' must be PNG');
    const size = Number(icon.sizes.split('x')[0]);
    assert.equal(bytes.readUInt32BE(16), size, icon.src + ' width');
    assert.equal(bytes.readUInt32BE(20), size, icon.src + ' height');
  }
});

test('PWA auto-update keeps API and Socket.IO responses out of Cache Storage', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..', 'public');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const pwa = fs.readFileSync(path.join(root, 'pwa.js'), 'utf8');
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.match(html, /id="installAppButton"/);
  assert.match(html, /src="\/pwa\.js"/);
  assert.match(pwa, /beforeinstallprompt/);
  assert.match(pwa, /registration\.update\(\)/);
  assert.match(sw, /self\.skipWaiting\(\)/);
  assert.match(sw, /await fetch\(request, \{ cache: 'no-store' \}\)/);
  assert.match(sw, /url\.pathname\.startsWith\('\/api\/'\)/);
  assert.match(sw, /url\.pathname\.startsWith\('\/socket\.io\/'\)/);
});


test('push subscription validation only accepts HTTPS endpoints and bounded key fields', () => {
  assert.equal(validPushSubscription({
    endpoint: 'https://push.example.test/subscription/abc',
    keys: { p256dh: 'p'.repeat(65), auth: 'a'.repeat(22) }
  }), true);
  assert.equal(validPushSubscription({
    endpoint: 'http://push.example.test/subscription/abc',
    keys: { p256dh: 'p'.repeat(65), auth: 'a'.repeat(22) }
  }), false);
  assert.equal(validPushSubscription({
    endpoint: 'https://push.example.test/subscription/abc',
    keys: { p256dh: 'short', auth: 'short' }
  }), false);
  assert.equal(validPushSubscription(null), false);
});

test('WhatsApp-style actions, sound settings and notification enrollment are present', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..', 'public');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.match(html, /id="emojiPicker"/);
  assert.match(html, /id="replyBar"/);
  assert.match(js, /function messageActionsDialog/);
  assert.match(js, /Star message/);
  assert.match(js, /Copy message/);
  assert.match(js, /function playMessageSound/);
  assert.match(js, /Notification\.requestPermission/);
  assert.match(js, /pushManager\.subscribe/);
  assert.match(sw, /self\.addEventListener\('push'/);
  assert.match(sw, /showNotification/);
  assert.match(sw, /notificationclick/);
  assert.match(sw, /fb-chat-shell-v9/);
  assert.match(js, /showCallPermissionPrompt/);
  assert.match(js, /Microphone for voice calls/);
  assert.match(js, /Camera for video calls/);
  assert.match(html, /id="callOverlay"/);
});

test('native FCM token validation accepts bounded device tokens only', () => {
  assert.equal(validFcmToken('token-' + 'a'.repeat(160)), true);
  assert.equal(validFcmToken('too-short'), false);
  assert.equal(validFcmToken('a'.repeat(4097)), false);
  assert.equal(validFcmToken('valid-looking-token '), false);
  assert.equal(validFcmToken(null), false);
});

test('Android app is wired for Firebase Cloud Messaging and safe generic push payloads', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const android = path.join(__dirname, '..', 'android');
  const appGradle = fs.readFileSync(path.join(android, 'app', 'build.gradle'), 'utf8');
  const rootGradle = fs.readFileSync(path.join(android, 'build.gradle'), 'utf8');
  const manifest = fs.readFileSync(path.join(android, 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
  const activity = fs.readFileSync(path.join(android, 'app', 'src', 'main', 'java', 'com', 'codingbotlab', 'fbchat', 'MainActivity.java'), 'utf8');
  const messaging = fs.readFileSync(path.join(android, 'app', 'src', 'main', 'java', 'com', 'codingbotlab', 'fbchat', 'FBChatMessagingService.java'), 'utf8');
  const web = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const firebase = JSON.parse(fs.readFileSync(path.join(android, 'app', 'google-services.json'), 'utf8'));
  assert.equal(firebase.project_info.project_id, 'fbchat-native-push-20261014');
  assert.equal(firebase.client[0].client_info.android_client_info.package_name, 'com.codingbotlab.fbchat');
  assert.match(rootGradle, /com\.google\.gms\.google-services/);
  assert.match(appGradle, /com\.google\.firebase:firebase-messaging/);
  assert.match(manifest, /POST_NOTIFICATIONS/);
  assert.match(manifest, /com\.google\.firebase\.MESSAGING_EVENT/);
  assert.match(activity, /addJavascriptInterface/);
  assert.match(activity, /FirebaseMessaging\.getInstance\(\)\.getToken\(\)/);
  assert.match(messaging, /onMessageReceived/);
  assert.match(messaging, /You have a new encrypted message/);
  assert.match(web, /\/api\/fcm\/register/);
  assert.match(web, /fbchatOnFcmToken/);
  assert.match(web, /fbchatOpenNativeChat/);
});


test('native FCM integration registers Android tokens and declares notification service', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const js = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const manifest = fs.readFileSync(path.join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
  const nativeService = fs.readFileSync(path.join(root, 'android', 'app', 'src', 'main', 'java', 'com', 'codingbotlab', 'fbchat', 'FBChatMessagingService.java'), 'utf8');
  const gradle = fs.readFileSync(path.join(root, 'android', 'app', 'build.gradle'), 'utf8');
  const firebaseConfig = JSON.parse(fs.readFileSync(path.join(root, 'android', 'app', 'google-services.json'), 'utf8'));
  assert.match(js, /window\.fbchatOnFcmToken/);
  assert.match(js, /\/api\/fcm\/register/);
  assert.match(server, /sendNativePushToUser/);
  assert.match(server, /sendEachForMulticast/);
  assert.match(manifest, /android\.permission\.POST_NOTIFICATIONS/);
  assert.match(manifest, /\.FBChatMessagingService/);
  assert.match(nativeService, /onMessageReceived/);
  assert.match(nativeService, /RingtoneManager\.TYPE_NOTIFICATION/);
  assert.match(gradle, /com\.google\.firebase:firebase-messaging/);
  assert.equal(firebaseConfig.project_info.project_id, 'fbchat-native-push-20261014');
  assert.equal(firebaseConfig.client[0].client_info.android_client_info.package_name, 'com.codingbotlab.fbchat');
});


test('single-chat layout and call-media recovery handle Android WebView', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const js = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');
  const sw = fs.readFileSync(path.join(root, 'public', 'sw.js'), 'utf8');
  assert.match(js, /let chatOpenRequest = 0/);
  assert.match(js, /requestId !== chatOpenRequest/);
  assert.match(js, /async function acquireCallMedia\(kind\)/);
  assert.match(js, /Request the camera separately/);
  assert.match(js, /audio source not found/i);
  assert.match(js, /callMediaErrorMessage\(error\)/);
  assert.match(css, /\.app\.chat-open \.mobile-bottom-nav\{display:none\}/);
  assert.match(css, /\.app\.chat-open \.conversation\{padding-bottom:0\}/);
  assert.match(sw, /fb-chat-shell-v9/);
});


test('Android WebRTC manifest includes audio routing permission and bumped release version', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const android = path.join(root, 'android');
  const manifest = fs.readFileSync(path.join(android, 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
  const gradle = fs.readFileSync(path.join(android, 'app', 'build.gradle'), 'utf8');
  assert.match(manifest, /android\.permission\.RECORD_AUDIO/);
  assert.match(manifest, /android\.permission\.MODIFY_AUDIO_SETTINGS/);
  assert.match(gradle, /versionCode 5/);
  assert.match(gradle, /versionName '1\.2\.2'/);
  const java = fs.readFileSync(path.join(android, 'app', 'src', 'main', 'java', 'com', 'codingbotlab', 'fbchat', 'MainActivity.java'), 'utf8');
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'android-apk.yml'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  assert.match(manifest, /android\.permission\.BLUETOOTH_CONNECT/);
  assert.match(manifest, /android\.permission\.REQUEST_INSTALL_PACKAGES/);
  assert.match(java, /checkForAppUpdateAsyncBridge/);
  assert.match(java, /ACTION_MANAGE_UNKNOWN_APP_SOURCES/);
  assert.match(java, /onShowFileChooser/);
  assert.match(workflow, /ANDROID_SIGNING_KEYSTORE_BASE64/);
  assert.match(workflow, /Publish versioned APK for in-app updates/);
  assert.match(app, /Check for app updates/);
  assert.match(app, /fbchatOnNativeUpdateCheck/);
});
