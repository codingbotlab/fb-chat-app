'use strict';

const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { Server } = require('socket.io');
const webpush = require('web-push');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 100_000, pingTimeout: 20_000, pingInterval: 25_000 });
const PORT = Number(process.env.PORT) || 3000;
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_ANON_KEY = String(process.env.SUPABASE_ANON_KEY || '');
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const configured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY && SUPABASE_SERVICE_ROLE_KEY);
const VAPID_PUBLIC_KEY = String(process.env.VAPID_PUBLIC_KEY || '');
const VAPID_PRIVATE_KEY = String(process.env.VAPID_PRIVATE_KEY || '');
const VAPID_SUBJECT = String(process.env.VAPID_SUBJECT || 'mailto:admin@fashionbazz.in');
let pushConfigured = false;
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    pushConfigured = true;
  } catch {
    pushConfigured = false;
  }
}
const online = new Map();
const socketUsers = new Map();
const authCache = new Map();
const sentAt = new Map();
const pendingCallEvents = new Map();
const USERNAME_RE = /^[a-z0-9_.]{3,24}$/;
const MAX_CIPHERTEXT_BYTES = 65_536;
const FCM_PROJECT_ID = String(process.env.FCM_PROJECT_ID || '').trim();
const FCM_SERVICE_ACCOUNT_JSON = String(process.env.FCM_SERVICE_ACCOUNT_JSON || '');
let fcmMessaging = null;
if (FCM_SERVICE_ACCOUNT_JSON) {
  try {
    const serviceAccount = JSON.parse(FCM_SERVICE_ACCOUNT_JSON);
    const projectId = FCM_PROJECT_ID || serviceAccount.project_id;
    if (!projectId || serviceAccount.project_id !== projectId) {
      throw new Error('FCM service-account project ID mismatch');
    }
    const existingApp = getApps().find((item) => item.name === 'fb-chat-fcm');
    const fcmApp = existingApp || initializeApp({
      credential: cert(serviceAccount),
      projectId
    }, 'fb-chat-fcm');
    fcmMessaging = getMessaging(fcmApp);
    console.info('[FCM] Admin messaging initialized; project configured:', Boolean(projectId));
  } catch (error) {
    console.error('[FCM] Admin initialization failed:', error?.message || 'unknown configuration error');
    // Native push stays disabled on bad/missing configuration; chat still starts.
    fcmMessaging = null;
  }
}

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  res.setHeader('Cache-Control', req.path.startsWith('/api/') ? 'no-store' : 'public, max-age=0, must-revalidate');
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
  next();
});

function validPushSubscription(value) {
  try {
    const endpoint = new URL(String(value?.endpoint || ''));
    return endpoint.protocol === 'https:' &&
      typeof value?.keys?.p256dh === 'string' && value.keys.p256dh.length >= 20 &&
      value.keys.p256dh.length <= 256 &&
      typeof value?.keys?.auth === 'string' && value.keys.auth.length >= 8 &&
      value.keys.auth.length <= 128;
  } catch {
    return false;
  }
}
function validFcmToken(value) {
  return typeof value === 'string' &&
    value.length >= 20 && value.length <= 4096 &&
    value.trim() === value &&
    !value.includes(' ') && !value.includes('\n') &&
    !value.includes('\r') && !value.includes('\t');
}
function normalize(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}
function validUsername(value) {
  return typeof value === 'string' && USERNAME_RE.test(normalize(value));
}
function validDisplayName(value) {
  return typeof value === 'string' && value.trim().length >= 2 &&
    value.trim().length <= 40 && !/[<>]/.test(value);
}
function validEncryptedMessage(value) {
  return Boolean(value && typeof value.ciphertext === 'string' &&
    value.ciphertext.length > 0 &&
    Buffer.byteLength(value.ciphertext, 'utf8') <= MAX_CIPHERTEXT_BYTES &&
    typeof value.iv === 'string' && /^[A-Za-z0-9_-]{16}$/.test(value.iv) &&
    Object.keys(value).every((field) => ['to', 'ciphertext', 'iv'].includes(field)));
}
function validUuid(value) {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function publicProfile(row) {
  if (!row) return null;
  return {
    id: row.id, username: row.username, display_name: row.display_name,
    public_key: row.public_key || null, created_at: row.created_at
  };
}
function appError(status, code, message) {
  const error = new Error(message);
  error.status = status; error.code = code;
  return error;
}
function requireConfigured() {
  if (!configured) throw appError(503, 'SERVER_NOT_CONFIGURED',
    'Authentication and persistent storage are not configured yet. Ask the app owner to finish the free database setup.');
}
function supabaseAuthHeaders(token) {
  return { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token };
}
async function authUserFromToken(token) {
  if (!configured || !token || typeof token !== 'string') return null;
  const cached = authCache.get(token);
  if (cached && cached.until > Date.now()) return cached.user;
  try {
    const response = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: supabaseAuthHeaders(token), signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) return null;
    const user = await response.json();
    if (!user || !validUuid(user.id)) return null;
    authCache.set(token, { user, until: Date.now() + 20_000 });
    if (authCache.size > 2000) {
      for (const [key, item] of authCache) if (item.until <= Date.now()) authCache.delete(key);
      if (authCache.size > 2000) authCache.clear();
    }
    return user;
  } catch {
    return null;
  }
}
async function db(table, query = '', options = {}) {
  requireConfigured();
  const url = SUPABASE_URL + '/rest/v1/' + table + (query ? '?' + query : '');
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
    Accept: 'application/json'
  };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.prefer) headers.Prefer = options.prefer;
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(12_000)
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = { message: text }; }
  }
  if (!response.ok) {
    const message = data && (data.message || data.hint || data.details);
    throw appError(response.status >= 500 ? 503 : 400, 'DATABASE_ERROR',
      message || 'The database request could not be completed.');
  }
  return data;
}
async function sendPushToUser(userId, payload) {
  if (!pushConfigured || !configured || !validUuid(userId)) return;
  let rows;
  try {
    rows = await db('push_subscriptions',
      'select=id,endpoint,p256dh,auth&user_id=eq.' + encodeURIComponent(userId) + '&limit=20');
  } catch {
    return;
  }
  await Promise.all((rows || []).map(async (row) => {
    const subscription = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
    try {
      await webpush.sendNotification(subscription, JSON.stringify(payload), { TTL: 120, urgency: 'high' });
    } catch (error) {
      const status = error && Number(error.statusCode);
      if (status === 404 || status === 410) {
        db('push_subscriptions', 'id=eq.' + encodeURIComponent(row.id), {
          method: 'DELETE', prefer: 'return=minimal'
        }).catch(() => {});
      }
    }
  }));
}

async function sendNativePushToUser(userId, payload) {
  if (!fcmMessaging || !configured || !validUuid(userId)) return;
  try {
    const rows = await db('fcm_tokens',
      'select=id,token&user_id=eq.' + encodeURIComponent(userId) + '&limit=100');
    if (!rows?.length) return;
    const tokens = rows.map((row) => row.token).filter(validFcmToken);
    if (!tokens.length) return;
    const response = await fcmMessaging.sendEachForMulticast({
      tokens,
      data: {
        type: payload.type === 'incoming_call' ? 'incoming_call' : 'message',
        title: String(payload.title || 'New message').slice(0, 80),
        body: payload.type === 'incoming_call'
          ? String(payload.body || 'Incoming FB Chat call').slice(0, 140)
          : 'You have a new encrypted message',
        username: validUsername(payload.username) ? normalize(payload.username) : '',
        caller_username: validUsername(payload.caller_username) ? normalize(payload.caller_username) : '',
        caller_display_name: String(payload.caller_display_name || '').slice(0, 80),
        call_kind: payload.call_kind === 'video' ? 'video' : 'audio',
        url: '/'
      },
      android: { priority: 'high', ttl: 60 * 1000 }
    });
    console.info('[FCM] Send result:', JSON.stringify({ successCount: response.successCount, failureCount: response.failureCount, errors: response.responses.filter(item => item.error).map(item => item.error.code || 'unknown').slice(0, 10) }));
    const removals = [];
    response.responses.forEach((item, index) => {
      const code = item.error?.code || '';
      if (code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token') {
        const row = rows.find((entry) => entry.token === tokens[index]);
        if (row) removals.push(db('fcm_tokens', 'id=eq.' + encodeURIComponent(row.id), {
          method: 'DELETE', prefer: 'return=minimal'
        }).catch(() => {}));
      }
    });
    await Promise.all(removals);
  } catch (error) {
    console.error('[FCM] Push send failed:', error?.code || error?.message || 'unknown error');
    // Push delivery is best effort and must never fail message persistence.
  }
}

async function getProfileById(id) {
  if (!validUuid(id)) return null;
  const rows = await db('profiles',
    'select=id,username,display_name,public_key,key_backup,created_at&id=eq.' +
    encodeURIComponent(id) + '&limit=1');
  return rows?.[0] || null;
}
async function getProfileByUsername(username) {
  username = normalize(username);
  if (!validUsername(username)) return null;
  const rows = await db('profiles',
    'select=id,username,display_name,public_key,created_at&username=eq.' +
    encodeURIComponent(username) + '&limit=1');
  return rows?.[0] || null;
}
async function getOrCreateProfile(user) {
  let row = await getProfileById(user.id);
  if (row) return row;
  const metadata = user.user_metadata || {};
  const username = normalize(metadata.username);
  const displayName = String(metadata.display_name || metadata.full_name || username).trim().slice(0, 40);
  if (!validUsername(username) || !validDisplayName(displayName)) {
    throw appError(409, 'PROFILE_REQUIRED', 'Finish your username setup before opening chats.');
  }
  const rows = await db('profiles', 'on_conflict=id', {
    method: 'POST', prefer: 'resolution=ignore-duplicates,return=representation',
    body: [{ id: user.id, username, display_name: displayName }]
  });
  row = rows?.[0] || await getProfileById(user.id);
  if (!row) throw appError(409, 'USERNAME_TAKEN', 'That username is already taken. Choose another one.');
  return row;
}
async function resolveRequest(req) {
  requireConfigured();
  const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  const user = await authUserFromToken(match?.[1] || '');
  if (!user) throw appError(401, 'UNAUTHORIZED', 'Your session has expired. Please sign in again.');
  return { user, profile: await getOrCreateProfile(user) };
}
async function requireAuth(req, res, next) {
  try {
    const auth = await resolveRequest(req);
    req.authUser = auth.user;
    req.profile = auth.profile;
    next();
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.code || 'INTERNAL_ERROR',
      message: error.message || 'Request failed.'
    });
  }
}

app.get('/health', (_req, res) => res.json({
  ok: true, service: 'fb-chat-app', authConfigured: configured,
  connectedUsers: online.size, uptimeSeconds: Math.round(process.uptime()),
  nativePushConfigured: Boolean(fcmMessaging)
}));
app.get('/api/push/public-key', (_req, res) => res.json({
  enabled: pushConfigured && configured,
  publicKey: pushConfigured && configured ? VAPID_PUBLIC_KEY : null
}));
app.get('/api/config', (_req, res) => res.json({
  configured,
  supabaseUrl: configured ? SUPABASE_URL : null,
  supabaseAnonKey: configured ? SUPABASE_ANON_KEY : null
}));
app.use(express.static(path.join(__dirname, 'public'), { etag: true, maxAge: 0, index: 'index.html' }));

app.post('/api/push/subscribe', requireAuth, async (req, res, next) => {
  try {
    if (!pushConfigured) return res.status(503).json({
      error: 'PUSH_NOT_CONFIGURED',
      message: 'Push notifications are not configured on the server yet.'
    });
    const subscription = req.body?.subscription;
    if (!validPushSubscription(subscription)) return res.status(400).json({
      error: 'INVALID_SUBSCRIPTION', message: 'The browser push subscription is invalid.'
    });
    const endpoint = new URL(subscription.endpoint).toString();
    await db('push_subscriptions', 'on_conflict=endpoint', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: [{
        user_id: req.authUser.id,
        endpoint,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        user_agent: String(req.headers['user-agent'] || '').slice(0, 500),
        updated_at: new Date().toISOString()
      }]
    });
    res.json({ ok: true });
  } catch (error) { next(error); }
});
app.delete('/api/push/subscribe', requireAuth, async (req, res, next) => {
  try {
    const endpoint = String(req.body?.endpoint || '');
    let parsed;
    try { parsed = new URL(endpoint); } catch { return res.status(400).json({ error: 'INVALID_ENDPOINT', message: 'The push endpoint is invalid.' }); }
    if (parsed.protocol !== 'https:') return res.status(400).json({ error: 'INVALID_ENDPOINT', message: 'The push endpoint must use HTTPS.' });
    await db('push_subscriptions',
      'user_id=eq.' + encodeURIComponent(req.authUser.id) + '&endpoint=eq.' + encodeURIComponent(parsed.toString()),
      { method: 'DELETE', prefer: 'return=minimal' });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.post('/api/fcm/register', requireAuth, async (req, res, next) => {
  try {
    const token = req.body?.token;
    if (!validFcmToken(token)) return res.status(400).json({
      error: 'INVALID_FCM_TOKEN', message: 'The Android push token is invalid.'
    });
    await db('fcm_tokens', 'on_conflict=token', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: [{
        user_id: req.authUser.id,
        token,
        platform: 'android',
        device_name: String(req.body?.device_name || 'Android device').slice(0, 80),
        user_agent: String(req.headers['user-agent'] || '').slice(0, 500),
        updated_at: new Date().toISOString()
      }]
    });
    console.info('[FCM] Device token registered for authenticated account');
    res.json({ ok: true, configured: Boolean(fcmMessaging) });
  } catch (error) {
    console.error('[FCM] Token registration failed:', error?.code || error?.message || 'unknown error');
    next(error);
  }
});
app.delete('/api/fcm/register', requireAuth, async (req, res, next) => {
  try {
    const token = req.body?.token;
    if (!validFcmToken(token)) return res.status(400).json({
      error: 'INVALID_FCM_TOKEN', message: 'The Android push token is invalid.'
    });
    await db('fcm_tokens',
      'user_id=eq.' + encodeURIComponent(req.authUser.id) + '&token=eq.' + encodeURIComponent(token),
      { method: 'DELETE', prefer: 'return=minimal' });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

app.get('/api/me', requireAuth, (req, res) => res.json({
  user: { id: req.authUser.id, email: req.authUser.email || null },
  profile: publicProfile(req.profile),
  key_backup: req.profile.key_backup || null
}));
app.post('/api/profile', requireAuth, async (req, res, next) => {
  try {
    const username = normalize(req.body?.username);
    const displayName = String(req.body?.display_name || '').trim();
    if (!validUsername(username)) return res.status(400).json({ error: 'INVALID_USERNAME', message: 'Username must be 3–24 letters, numbers, dots or underscores.' });
    if (!validDisplayName(displayName)) return res.status(400).json({ error: 'INVALID_DISPLAY_NAME', message: 'Display name must be 2–40 characters.' });
    if (req.profile.username !== username) {
      const existing = await getProfileByUsername(username);
      if (existing && existing.id !== req.authUser.id) return res.status(409).json({ error: 'USERNAME_TAKEN', message: 'That username is already taken.' });
    }
    const rows = await db('profiles', 'on_conflict=id', {
      method: 'POST', prefer: 'resolution=merge-duplicates,return=representation',
      body: [{ id: req.authUser.id, username, display_name: displayName }]
    });
    res.json({ profile: publicProfile(rows?.[0] || await getProfileById(req.authUser.id)) });
  } catch (error) { next(error); }
});
app.put('/api/me/crypto', requireAuth, async (req, res, next) => {
  try {
    const key = req.body?.public_key, backup = req.body?.key_backup;
    if (!key || key.kty !== 'EC' || key.crv !== 'P-256' ||
        typeof key.x !== 'string' || typeof key.y !== 'string' ||
        !backup || backup.version !== 1 ||
        !['salt', 'iv', 'ciphertext'].every(k => typeof backup[k] === 'string') ||
        backup.ciphertext.length > 16_384) {
      return res.status(400).json({ error: 'INVALID_KEY_BUNDLE', message: 'The encryption key bundle is invalid.' });
    }
    if (req.profile.public_key &&
        (req.profile.public_key.x !== key.x || req.profile.public_key.y !== key.y)) {
      return res.status(409).json({ error: 'KEY_MISMATCH', message: 'This account already has a different encryption key. Restore its encrypted key backup before changing it.' });
    }
    const rows = await db('profiles', 'id=eq.' + encodeURIComponent(req.authUser.id), {
      method: 'PATCH', prefer: 'return=representation',
      body: { public_key: key, key_backup: backup }
    });
    res.json({ profile: publicProfile(rows?.[0] || await getProfileById(req.authUser.id)) });
  } catch (error) { next(error); }
});
app.get('/api/users/:username', requireAuth, async (req, res, next) => {
  try {
    const person = await getProfileByUsername(req.params.username);
    if (!person) return res.status(404).json({ error: 'USER_NOT_FOUND', message: 'No account found with that username.' });
    if (person.id === req.authUser.id) return res.status(400).json({ error: 'SELF_CHAT', message: 'Choose a different username.' });
    if (!person.public_key) return res.status(409).json({ error: 'KEY_NOT_READY', message: 'This user has not finished encryption setup.' });
    res.json({ profile: publicProfile(person) });
  } catch (error) { next(error); }
});
app.get('/api/chats', requireAuth, async (req, res, next) => {
  try {
    const id = req.authUser.id;
    const rows = await db('chat_messages',
      'select=id,sender_id,recipient_id,created_at,delivered_at,read_at&or=(sender_id.eq.' +
      id + ',recipient_id.eq.' + id + ')&order=created_at.desc&limit=500');
    const ids = [...new Set((rows || []).map(m => m.sender_id === id ? m.recipient_id : m.sender_id))];
    const profiles = ids.length ? await db('profiles',
      'select=id,username,display_name,public_key,created_at&id=in.(' + ids.join(',') + ')') : [];
    const profileMap = new Map((profiles || []).map(p => [p.id, p]));
    const latest = new Map();
    for (const message of rows || []) {
      const peerId = message.sender_id === id ? message.recipient_id : message.sender_id;
      if (!latest.has(peerId)) latest.set(peerId, message);
    }
    const chats = [...latest.entries()].map(([peerId, message]) => {
      const peer = profileMap.get(peerId);
      if (!peer) return null;
      return { peer: publicProfile(peer), last_message: {
        id: message.id, sender_id: message.sender_id, recipient_id: message.recipient_id,
        created_at: message.created_at, delivered_at: message.delivered_at, read_at: message.read_at
      }};
    }).filter(Boolean).sort((a, b) => new Date(b.last_message.created_at) - new Date(a.last_message.created_at));
    res.json({ chats });
  } catch (error) { next(error); }
});
app.get('/api/chats/:username/messages', requireAuth, async (req, res, next) => {
  try {
    const peer = await getProfileByUsername(req.params.username);
    if (!peer) return res.status(404).json({ error: 'USER_NOT_FOUND', message: 'No account found with that username.' });
    if (peer.id === req.authUser.id) return res.status(400).json({ error: 'SELF_CHAT', message: 'Choose a different username.' });
    const mine = req.authUser.id;
    const rows = await db('chat_messages',
      'select=id,sender_id,recipient_id,ciphertext,iv,created_at,delivered_at,read_at&or=(and(sender_id.eq.' +
      mine + ',recipient_id.eq.' + peer.id + '),and(sender_id.eq.' + peer.id + ',recipient_id.eq.' + mine +
      '))&order=created_at.asc&limit=500');
    res.json({ peer: publicProfile(peer), messages: rows || [] });
  } catch (error) { next(error); }
});

function queueCallEvent(userId, event, data) {
  if (!validUuid(userId)) return;
  const now = Date.now();
  const queued = (pendingCallEvents.get(userId) || []).filter(item => item.expiresAt > now);
  queued.push({ event, data, expiresAt: now + 45_000 });
  pendingCallEvents.set(userId, queued.slice(-80));
}

function flushPendingCallEvents(userId, socket) {
  const now = Date.now();
  const queued = (pendingCallEvents.get(userId) || []).filter(item => item.expiresAt > now);
  pendingCallEvents.delete(userId);
  for (const item of queued) socket.emit(item.event, item.data);
}

function broadcastPresence() {
  io.emit('presence:list', [...socketUsers.values()]);
}
io.use(async (socket, next) => {
  try {
    requireConfigured();
    const user = await authUserFromToken(socket.handshake.auth?.token);
    if (!user) return next(new Error('AUTH_REQUIRED'));
    const row = await getOrCreateProfile(user);
    if (!row.public_key) return next(new Error('ENCRYPTION_SETUP_REQUIRED'));
    socket.data.user = { id: user.id, username: row.username, display_name: row.display_name };
    next();
  } catch (error) { next(new Error(error.code || 'SERVER_NOT_READY')); }
});
io.on('connection', (socket) => {
  const user = socket.data.user;
  const oldId = online.get(user.id);
  if (oldId && oldId !== socket.id) {
    const oldSocket = io.sockets.sockets.get(oldId);
    if (oldSocket) oldSocket.disconnect(true);
  }
  online.set(user.id, socket.id);
  socketUsers.set(socket.id, user);
  socket.emit('session:ready', { user, onlineUsers: [...socketUsers.values()] });
  broadcastPresence();
  flushPendingCallEvents(user.id, socket);

  socket.on('chat:open', async (data = {}) => {
    try {
      const username = normalize(data.peer);
      if (!validUsername(username) || username === user.username) return;
      const peer = await getProfileByUsername(username);
      if (!peer?.public_key) return socket.emit('chat:error', { message: 'Username not found or encryption is not ready.' });
      const query = 'select=id,sender_id,recipient_id,ciphertext,iv,created_at,delivered_at,read_at&or=(and(sender_id.eq.' +
        user.id + ',recipient_id.eq.' + peer.id + '),and(sender_id.eq.' + peer.id + ',recipient_id.eq.' + user.id +
        '))&order=created_at.asc&limit=500';
      const messages = await db('chat_messages', query);
      await db('chat_messages', 'recipient_id=eq.' + user.id + '&sender_id=eq.' + peer.id + '&delivered_at=is.null', {
        method: 'PATCH', prefer: 'return=minimal', body: { delivered_at: new Date().toISOString() }
      });
      socket.emit('chat:history', {
        peer: publicProfile(peer),
        messages: (messages || []).map(m => ({
          ...m,
          sender_username: m.sender_id === user.id ? user.username : peer.username,
          recipient_username: m.recipient_id === user.id ? user.username : peer.username
        }))
      });
      const peerSocket = online.get(peer.id);
      if (peerSocket) io.to(peerSocket).emit('chat:receipts', { peer_id: user.id, delivered: true });
    } catch {
      socket.emit('chat:error', { message: 'Could not load chat history. Please retry.' });
    }
  });

  socket.on('chat:send', async (data = {}, ack = () => {}) => {
    try {
      const now = Date.now(), previous = sentAt.get(user.id) || [];
      const recent = previous.filter(t => now - t < 10_000);
      if (recent.length >= 30) return ack({ error: 'You are sending messages too quickly. Please wait a moment.' });
      recent.push(now); sentAt.set(user.id, recent);
      const username = normalize(data.to);
      if (!validUsername(username) || username === user.username) return ack({ error: 'Choose a valid recipient username.' });
      if (!validEncryptedMessage(data)) return ack({ error: 'Message must be encrypted before it can be sent.' });
      const peer = await getProfileByUsername(username);
      if (!peer) return ack({ error: 'No account found with that username.' });
      if (!peer.public_key) return ack({ error: 'The recipient has not completed encryption setup.' });
      const rows = await db('chat_messages', '', {
        method: 'POST', prefer: 'return=representation',
        body: { sender_id: user.id, recipient_id: peer.id, ciphertext: data.ciphertext, iv: data.iv }
      });
      const saved = rows?.[0];
      if (!saved) return ack({ error: 'Message was not saved.' });
      const message = {
        id: saved.id, sender_id: user.id, recipient_id: peer.id,
        sender_username: user.username, recipient_username: peer.username,
        ciphertext: saved.ciphertext, iv: saved.iv, created_at: saved.created_at,
        delivered_at: null, read_at: null
      };

      const peerSocket = online.get(peer.id);
      // Push payload deliberately excludes message text; messages remain encrypted.
      void sendNativePushToUser(peer.id, {
        title: user.display_name || user.username || 'New message',
        username: user.username
      });
      void sendPushToUser(peer.id, {
        title: user.display_name || user.username || 'New message',
        body: 'You have a new encrypted message',
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        tag: 'fb-chat-' + user.id,
        username: user.username,
        url: '/'
      });
      if (peerSocket) {
        io.to(peerSocket).emit('chat:message', message);
        const update = await db('chat_messages', 'id=eq.' + saved.id, {
          method: 'PATCH', prefer: 'return=representation', body: { delivered_at: new Date().toISOString() }
        });
        if (update?.[0]) message.delivered_at = update[0].delivered_at;
      }
      ack({ message, delivered: Boolean(peerSocket) });
    } catch (error) {
      ack({ error: error.status === 503 ? error.message : 'Message could not be saved. Check the connection and retry.' });
    }
  });

  socket.on('chat:read', async (data = {}) => {
    try {
      const peer = await getProfileByUsername(normalize(data.peer));
      if (!peer) return;
      const stamp = new Date().toISOString();
      await db('chat_messages', 'recipient_id=eq.' + user.id + '&sender_id=eq.' + peer.id + '&read_at=is.null', {
        method: 'PATCH', prefer: 'return=minimal', body: { read_at: stamp, delivered_at: stamp }
      });
      const peerSocket = online.get(peer.id);
      if (peerSocket) io.to(peerSocket).emit('chat:receipts', { peer_id: user.id, read: true });
    } catch { /* Read receipt updates are best-effort. */ }
  });
  socket.on('chat:typing', (data = {}) => {
    const username = normalize(data.to);
    if (!validUsername(username)) return;
    getProfileByUsername(username).then(peer => {
      const peerSocket = peer && online.get(peer.id);
      if (peerSocket) io.to(peerSocket).emit('chat:typing', { from: user.username, active: Boolean(data.active) });
    }).catch(() => {});
  });

  // Authenticated one-to-one WebRTC signaling. Media travels peer-to-peer; the server only relays call setup.
  const callRate = new Map();
  function validSignalPayload(value) {
    try { return value && typeof value === 'object' && JSON.stringify(value).length <= 48_000; }
    catch { return false; }
  }
  socket.on('call:invite', async (data = {}) => {
    try {
      const now = Date.now(), prior = callRate.get(user.id) || 0;
      if (now - prior < 1500) return socket.emit('call:error', { message: 'Please wait before placing another call.' });
      callRate.set(user.id, now);
      const username = normalize(data.to), kind = data.kind === 'video' ? 'video' : 'audio';
      if (!validUsername(username) || username === user.username) return socket.emit('call:error', { message: 'Choose a valid contact.' });
      const peer = await getProfileByUsername(username);
      if (!peer?.public_key) return socket.emit('call:error', { message: 'Contact not found or not ready.' });
      const incoming = { from: user.username, displayName: user.display_name, kind };
      void sendNativePushToUser(peer.id, {
        type: 'incoming_call',
        title: (user.display_name || user.username) + ' is calling',
        body: 'Incoming ' + (kind === 'video' ? 'video' : 'voice') + ' call',
        caller_username: user.username,
        caller_display_name: user.display_name,
        call_kind: kind
      });
      const peerSocket = online.get(peer.id);
      if (peerSocket) io.to(peerSocket).emit('call:incoming', incoming);
      else queueCallEvent(peer.id, 'call:incoming', incoming);
      socket.emit('call:ringing', { to: username, kind });
    } catch { socket.emit('call:error', { message: 'Could not start the call.' }); }
  });
  socket.on('call:accept', async (data = {}) => {
    const username = normalize(data.to);
    if (!validUsername(username) || username === user.username) return;
    const peer = await getProfileByUsername(username).catch(() => null);
    const peerSocket = peer && online.get(peer.id);
    if (peerSocket) io.to(peerSocket).emit('call:accepted', { from: user.username });
    else if (peer) queueCallEvent(peer.id, 'call:accepted', { from: user.username });
  });
  socket.on('call:signal', async (data = {}) => {
    const username = normalize(data.to);
    if (!validUsername(username) || username === user.username || !validSignalPayload(data.signal)) return;
    const peer = await getProfileByUsername(username).catch(() => null);
    const signal = { from: user.username, signal: data.signal };
    const peerSocket = peer && online.get(peer.id);
    if (peerSocket) io.to(peerSocket).emit('call:signal', signal);
    else if (peer) queueCallEvent(peer.id, 'call:signal', signal);
  });
  socket.on('call:end', async (data = {}) => {
    const username = normalize(data.to);
    if (!validUsername(username) || username === user.username) return;
    const peer = await getProfileByUsername(username).catch(() => null);
    const ended = { from: user.username };
    const peerSocket = peer && online.get(peer.id);
    if (peerSocket) io.to(peerSocket).emit('call:ended', ended);
    else if (peer) queueCallEvent(peer.id, 'call:ended', ended);
  });

  socket.on('disconnect', () => {
    if (online.get(user.id) === socket.id) online.delete(user.id);
    socketUsers.delete(socket.id);
    broadcastPresence();
  });
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'NOT_FOUND', message: 'API route not found.' }));
app.use((error, _req, res, _next) => res.status(error.status || 500).json({
  error: error.code || 'INTERNAL_ERROR',
  message: error.status ? error.message : 'An unexpected server error occurred.'
}));

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log('FB Chat listening on port ' + PORT + '; database configured: ' + configured);
  });
}
module.exports = { app, server, io, normalize, validUsername, validDisplayName, validEncryptedMessage, validPushSubscription, validFcmToken, authUserFromToken };
