'use strict';

const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 100_000, pingTimeout: 20_000, pingInterval: 25_000 });
const PORT = Number(process.env.PORT) || 3000;
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_ANON_KEY = String(process.env.SUPABASE_ANON_KEY || '');
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const configured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY && SUPABASE_SERVICE_ROLE_KEY);
const online = new Map();
const socketUsers = new Map();
const authCache = new Map();
const sentAt = new Map();
const USERNAME_RE = /^[a-z0-9_.]{3,24}$/;
const MAX_CIPHERTEXT_BYTES = 65_536;

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cache-Control', req.path.startsWith('/api/') ? 'no-store' : 'public, max-age=0, must-revalidate');
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
  next();
});

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
    !Object.hasOwn(value, 'text'));
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
  connectedUsers: online.size, uptimeSeconds: Math.round(process.uptime())
}));
app.get('/api/config', (_req, res) => res.json({
  configured,
  supabaseUrl: configured ? SUPABASE_URL : null,
  supabaseAnonKey: configured ? SUPABASE_ANON_KEY : null
}));
app.use(express.static(path.join(__dirname, 'public'), { etag: true, maxAge: 0, index: 'index.html' }));

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
module.exports = { app, server, io, normalize, validUsername, validDisplayName, validEncryptedMessage, authUserFromToken };
