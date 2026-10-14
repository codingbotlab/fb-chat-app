'use strict';

const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const sharp = require('sharp');
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
const ADMIN_EMAILS = new Set(String(process.env.ADMIN_EMAILS || '')
  .split(',').map((value) => normalize(value)).filter(Boolean));
// Sign compact, short-lived admin sessions with the service-role secret by default.
// This avoids placing potentially oversized Supabase user JWTs in browser request headers.
const ADMIN_SESSION_SECRET = String(process.env.ADMIN_SESSION_SECRET || SUPABASE_SERVICE_ROLE_KEY || '');
const ADMIN_SESSION_TTL_SECONDS = 8 * 60 * 60;
const adminLoginAttempts = new Map();
const userLoginAttempts = new Map();
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
function validAvatarDataUrl(value) {
  return typeof value === 'string' && value.length <= 40_000 &&
    /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
}
function validBio(value) {
  return typeof value === 'string' && value.trim().length <= 160 &&
    !/[<>]/.test(value);
}
function validStoredAvatarUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const base = new URL(SUPABASE_URL);
    return url.protocol === 'https:' && url.origin === base.origin &&
      /^\/storage\/v1\/object\/public\/fbchat-profiles\/[0-9a-f-]{36}\.(?:jpg|png|webp)$/i.test(url.pathname);
  } catch { return false; }
}
function safeProfileMetadata(metadata = {}) {
  return {
    // Keep image binaries out of auth user_metadata/JWTs: JWT headers must stay small.
    avatar_url: validStoredAvatarUrl(metadata.avatar_url) ? metadata.avatar_url : null,
    bio: typeof metadata.bio === 'string' && metadata.bio.length <= 160 ? metadata.bio : ''
  };
}
function publicProfile(row, metadata = {}) {
  if (!row) return null;
  const details = safeProfileMetadata(metadata);
  return {
    id: row.id, username: row.username, display_name: row.display_name,
    public_key: row.public_key || null, created_at: row.created_at,
    avatar_url: details.avatar_url, bio: details.bio
  };
}
async function fetchAuthUsers(page = 1, perPage = 1000) {
  const response = await fetch(SUPABASE_URL + '/auth/v1/admin/users?page=' + page + '&per_page=' + perPage, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
      Accept: 'application/json'
    },
    signal: AbortSignal.timeout(12_000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw appError(503, 'AUTH_ADMIN_UNAVAILABLE', 'Could not read account directory from authentication storage.');
  return Array.isArray(body.users) ? body.users : [];
}
function normalizeContactPhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('0091') && digits.length === 14) digits = digits.slice(4);
  else if (digits.startsWith('91') && digits.length === 12) digits = digits.slice(2);
  else if (digits.startsWith('0') && digits.length === 11) digits = digits.slice(1);
  return digits.length >= 7 && digits.length <= 15 ? digits : '';
}
function findContactAccountMatches(contacts, authUsers) {
  const byEmail = new Map();
  const byPhone = new Map();
  for (const account of authUsers || []) {
    if (!account?.id || !validUuid(account.id)) continue;
    const email = typeof account.email === 'string' ? account.email.trim().toLowerCase() : '';
    if (email) byEmail.set(email, account);
    const phone = normalizeContactPhone(account.phone);
    if (phone && !byPhone.has(phone)) byPhone.set(phone, account);
  }
  const matches = [];
  (Array.isArray(contacts) ? contacts : []).slice(0, 400).forEach((contact, index) => {
    if (!contact || typeof contact !== 'object') return;
    let account = null;
    const emails = Array.isArray(contact.emails) ? contact.emails.slice(0, 5) : [];
    for (const value of emails) {
      if (typeof value !== 'string' || value.length > 254) continue;
      account = byEmail.get(value.trim().toLowerCase()) || null;
      if (account) break;
    }
    if (!account) {
      const phones = Array.isArray(contact.phones) ? contact.phones.slice(0, 5) : [];
      for (const value of phones) {
        if (typeof value !== 'string' || value.length > 40) continue;
        const phone = normalizeContactPhone(value);
        account = phone ? byPhone.get(phone) || null : null;
        if (account) break;
      }
    }
    if (account) matches.push({ index, accountId: account.id });
  });
  return matches;
}
async function getAuthUserById(id) {
  if (!validUuid(id)) return null;
  const response = await fetch(SUPABASE_URL + '/auth/v1/admin/users/' + encodeURIComponent(id), {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
      Accept: 'application/json'
    },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) return null;
  return response.json().catch(() => null);
}
async function ensureProfileAvatarBucket(baseHeaders) {
  const bucket = 'fbchat-profiles';
  let bucketsResponse;
  try {
    // Listing buckets is more reliable than assuming a missing bucket returns HTTP 404.
    bucketsResponse = await fetch(SUPABASE_URL + '/storage/v1/bucket/', {
      headers: Object.assign({}, baseHeaders, { Accept: 'application/json' }),
      signal: AbortSignal.timeout(8000)
    });
  } catch {
    throw appError(503, 'AVATAR_STORAGE_UNAVAILABLE',
      'Profile photo storage could not be reached. Check the Supabase Storage service.');
  }
  if (!bucketsResponse.ok) {
    console.warn('[Profile avatar] Bucket list failed with HTTP', bucketsResponse.status);
    throw appError(503, 'AVATAR_STORAGE_UNAVAILABLE',
      'Profile photo storage is unavailable (HTTP ' + bucketsResponse.status + '). Check the Supabase service-role key and Storage service.');
  }

  const buckets = await bucketsResponse.json().catch(() => null);
  if (!Array.isArray(buckets)) {
    throw appError(503, 'AVATAR_STORAGE_UNAVAILABLE',
      'Supabase Storage returned an unexpected bucket-list response.');
  }

  const existing = buckets.find((item) => item?.id === bucket || item?.name === bucket);
  if (!existing) {
    const created = await fetch(SUPABASE_URL + '/storage/v1/bucket', {
      method: 'POST',
      headers: Object.assign({}, baseHeaders, { 'Content-Type': 'application/json', Accept: 'application/json' }),
      body: JSON.stringify({
        id: bucket, name: bucket, public: true, file_size_limit: 40000,
        allowed_mime_types: ['image/jpeg', 'image/png', 'image/webp']
      }),
      signal: AbortSignal.timeout(8000)
    });
    if (created.ok || created.status === 409) return;
    const detail = await created.text().catch(() => '');
    const alreadyExists = /already exists|duplicate bucket|bucket already exists/i.test(detail);
    if (alreadyExists) return;
    console.warn('[Profile avatar] Bucket creation failed with HTTP', created.status);
    throw appError(503, 'AVATAR_STORAGE_UNAVAILABLE',
      'Profile photo storage could not be created (HTTP ' + created.status + '). Check Storage permissions.');
  }

  // Profile avatars must be readable by other chat users, so enforce a public bucket
  // rather than silently returning public URLs for a private bucket.
  if (existing.public !== true) {
    const updated = await fetch(SUPABASE_URL + '/storage/v1/bucket/' + bucket, {
      method: 'PUT',
      headers: Object.assign({}, baseHeaders, { 'Content-Type': 'application/json', Accept: 'application/json' }),
      body: JSON.stringify({
        public: true, file_size_limit: 40000,
        allowed_mime_types: ['image/jpeg', 'image/png', 'image/webp']
      }),
      signal: AbortSignal.timeout(8000)
    });
    if (!updated.ok) {
      console.warn('[Profile avatar] Making avatar bucket public failed with HTTP', updated.status);
      throw appError(503, 'AVATAR_STORAGE_UNAVAILABLE',
        'Profile photo storage exists but cannot be configured for public profile pictures (HTTP ' + updated.status + ').');
    }
  }
}
async function storeProfileAvatar(userId, dataUrl) {
  if (!validUuid(userId) || !validAvatarDataUrl(dataUrl)) {
    throw appError(400, 'INVALID_AVATAR', 'The profile photo is invalid.');
  }
  const match = dataUrl.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) throw appError(400, 'INVALID_AVATAR', 'The profile photo encoding is invalid.');
  const contentType = match[1] === 'jpeg' ? 'image/jpeg' : 'image/' + match[1];
  const extension = match[1] === 'jpeg' ? 'jpg' : match[1];
  const bucket = 'fbchat-profiles';
  const baseHeaders = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY
  };
  await ensureProfileAvatarBucket(baseHeaders);

  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > 30_000) {
    throw appError(400, 'INVALID_AVATAR', 'The compressed profile photo must be under 30 KB.');
  }
  const upload = await fetch(SUPABASE_URL + '/storage/v1/object/' + bucket + '/' + userId + '.' + extension, {
    method: 'POST',
    headers: Object.assign({}, baseHeaders, {
      'Content-Type': contentType,
      'x-upsert': 'true',
      'Cache-Control': '3600'
    }),
    body: bytes,
    signal: AbortSignal.timeout(12000)
  });
  if (!upload.ok) {
    const detail = await upload.text().catch(() => '');
    console.warn('[Profile avatar] Upload failed with HTTP', upload.status);
    throw appError(503, 'AVATAR_UPLOAD_FAILED',
      'Profile photo upload failed (HTTP ' + upload.status + '). Check Supabase Storage permissions and quota.');
  }
  return SUPABASE_URL + '/storage/v1/object/public/' + bucket + '/' + userId + '.' + extension;
}
async function findStoredProfileAvatar(userId) {
  if (!validUuid(userId) || !SUPABASE_URL) return null;
  const extensions = ['jpg', 'png', 'webp'];
  const checked = await Promise.all(extensions.map(async (extension) => {
    const url = SUPABASE_URL + '/storage/v1/object/public/fbchat-profiles/' + userId + '.' + extension;
    try {
      const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(4000) });
      return response.ok ? { extension, url } : null;
    } catch { return null; }
  }));
  return checked.find(Boolean)?.url || null;
}
function metadataCleanupPatch(existing = {}, compact = {}) {
  const patch = {};
  for (const key of Object.keys(existing || {})) patch[key] = null;
  return Object.assign(patch, compact);
}
function compactAppMetadata(metadata = {}) {
  // Preserve standard Supabase provider/role claims, but never large arbitrary blobs.
  const compact = {};
  if (typeof metadata.provider === 'string' && /^[a-z0-9_-]{1,64}$/i.test(metadata.provider)) {
    compact.provider = metadata.provider;
  }
  if (Array.isArray(metadata.providers)) {
    const providers = [...new Set(metadata.providers.filter((value) =>
      typeof value === 'string' && /^[a-z0-9_-]{1,64}$/i.test(value)))].slice(0, 10);
    if (providers.length) compact.providers = providers;
  }
  if (typeof metadata.role === 'string' && /^[a-z0-9:_-]{1,64}$/i.test(metadata.role)) compact.role = metadata.role;
  if (typeof metadata.is_sso_user === 'boolean') compact.is_sso_user = metadata.is_sso_user;
  return compact;
}
async function updateAuthUserMetadata(user, metadata, replace = false, appMetadata = null) {
  const existingUserMetadata = user?.user_metadata || {};
  const nextMetadata = replace
    ? metadataCleanupPatch(existingUserMetadata, metadata)
    : Object.assign({}, existingUserMetadata, metadata);
  const updatePayload = { user_metadata: nextMetadata };
  if (appMetadata !== null) {
    updatePayload.app_metadata = metadataCleanupPatch(user?.app_metadata || {}, appMetadata);
  }
  const response = await fetch(SUPABASE_URL + '/auth/v1/admin/users/' + encodeURIComponent(user.id), {
    method: 'PUT',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(updatePayload),
    signal: AbortSignal.timeout(10_000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw appError(503, 'PROFILE_METADATA_SAVE_FAILED',
    'The profile name was saved, but its photo/about details could not be saved. Please retry.');
  return result;
}
function compactUserMetadata(metadata = {}) {
  // User metadata is embedded in Supabase access-token claims. Keep only bounded
  // fields used by FB Chat, never Base64 photos or large provider metadata.
  const compact = {};
  const username = typeof metadata.username === 'string' ? normalize(metadata.username) : '';
  if (validUsername(username)) compact.username = username;
  const displayName = typeof metadata.display_name === 'string' ? metadata.display_name.trim() : '';
  if (validDisplayName(displayName)) compact.display_name = displayName;
  const fullName = typeof metadata.full_name === 'string' ? metadata.full_name.trim() : '';
  if (validDisplayName(fullName)) compact.full_name = fullName;
  const name = typeof metadata.name === 'string' ? metadata.name.trim() : '';
  if (validDisplayName(name)) compact.name = name;
  if (validBio(metadata.bio)) compact.bio = metadata.bio.trim();
  if (validStoredAvatarUrl(metadata.avatar_url)) compact.avatar_url = metadata.avatar_url;
  return compact;
}
function findLegacyAvatarDataUrl(metadata = {}) {
  for (const key of ['avatar_url', 'picture', 'profile_photo', 'profile_picture', 'avatar']) {
    const value = metadata[key];
    if (typeof value === 'string' &&
      /^data:image\/(?:jpeg|png|webp|svg\+xml);base64,/i.test(value) &&
      value.length <= 600_000) return value;
  }
  return null;
}
async function rasterizeLegacyAvatar(dataUrl) {
  if (typeof dataUrl !== 'string' || dataUrl.length > 600_000) return null;
  const match = dataUrl.match(/^data:image\/(jpeg|png|webp|svg\+xml);base64,([A-Za-z0-9+/=\r\n]+)$/i);
  if (!match) return null;
  let source;
  try { source = Buffer.from(match[2].replace(/\s+/g, ''), 'base64'); } catch { return null; }
  if (!source.length || source.length > 450_000) return null;

  if (match[1].toLowerCase() === 'svg+xml') {
    const svg = source.toString('utf8');
    // SVG is rasterized server-side; reject active markup and external references.
    if (!/<svg\b/i.test(svg) || /<!DOCTYPE|<!ENTITY|<script\b|<foreignObject\b|\son[a-z]+\s*=|(?:href|xlink:href)\s*=\s*['"]\s*(?:https?:|\/\/|file:|javascript:)|url\(\s*['"]?(?:https?:|\/\/|file:|javascript:)/i.test(svg)) {
      return null;
    }
  }

  for (const size of [320, 256, 200]) {
    for (const quality of [76, 64, 52, 40]) {
      try {
        const bytes = await sharp(source, { limitInputPixels: 16_000_000, failOn: 'error' })
          .rotate()
          .resize(size, size, { fit: 'cover', withoutEnlargement: true, background: '#ffffff' })
          .flatten({ background: '#ffffff' })
          .jpeg({ quality, mozjpeg: true })
          .toBuffer();
        if (bytes.length <= 28_000) return 'data:image/jpeg;base64,' + bytes.toString('base64');
      } catch {
        return null;
      }
    }
  }
  return null;
}
async function ensureStoredAvatarMetadata(authUser) {
  if (!authUser?.id || !validUuid(authUser.id)) return authUser?.user_metadata || {};
  const metadata = authUser.user_metadata || {};
  if (validStoredAvatarUrl(metadata.avatar_url)) return metadata;

  // Migrate legacy Base64 photos (including SVG avatars) into compact public raster files.
  let avatarUrl = await findStoredProfileAvatar(authUser.id);
  if (!avatarUrl) {
    const legacyAvatar = findLegacyAvatarDataUrl(metadata);
    if (legacyAvatar) {
      const raster = await rasterizeLegacyAvatar(legacyAvatar);
      if (raster) avatarUrl = await storeProfileAvatar(authUser.id, raster);
      else console.warn('[Profile avatar] A legacy photo could not be rasterized safely.');
    }
  }
  if (!avatarUrl) return metadata;

  const compact = Object.assign(compactUserMetadata(metadata), { avatar_url: avatarUrl });
  const saved = await updateAuthUserMetadata(authUser, compact, true);
  return saved.user_metadata || compact;
}
function isRateLimitedUserLogin(req) {
  const key = String(req.ip || req.socket?.remoteAddress || 'unknown');
  const now = Date.now();
  let attempt = userLoginAttempts.get(key);
  if (!attempt || attempt.resetAt <= now) attempt = { count: 0, resetAt: now + 15 * 60 * 1000 };
  attempt.count += 1;
  userLoginAttempts.set(key, attempt);
  if (userLoginAttempts.size > 5000) {
    for (const [entry, value] of userLoginAttempts) if (value.resetAt <= now) userLoginAttempts.delete(entry);
  }
  return attempt.count > 10;
}
async function exactCount(table) {
  requireConfigured();
  const response = await fetch(SUPABASE_URL + '/rest/v1/' + table + '?select=id', {
    method: 'HEAD',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
      Prefer: 'count=exact',
      Range: '0-0'
    },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw appError(503, 'DATABASE_COUNT_FAILED', 'Could not count records in ' + table + '.');
  const match = String(response.headers.get('content-range') || '').match(/\/(\d+)$/);
  return match ? Number(match[1]) : null;
}
function signAdminSession(user) {
  if (!ADMIN_SESSION_SECRET) throw appError(503, 'ADMIN_SESSION_UNAVAILABLE', 'Admin session signing is not configured.');
  const payload = {
    sub: user.id,
    email: normalize(user.email),
    exp: Math.floor(Date.now() / 1000) + ADMIN_SESSION_TTL_SECONDS
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', ADMIN_SESSION_SECRET).update(encoded).digest('base64url');
  return { token: encoded + '.' + signature, expiresAt: payload.exp };
}
function verifyAdminSession(token) {
  if (!ADMIN_SESSION_SECRET || typeof token !== 'string' || token.length > 2048) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const expected = crypto.createHmac('sha256', ADMIN_SESSION_SECRET).update(parts[0]).digest();
  let supplied;
  try { supplied = Buffer.from(parts[1], 'base64url'); } catch { return null; }
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (!validUuid(payload.sub) || !payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    const email = normalize(payload.email);
    if (!email || !ADMIN_EMAILS.has(email)) return null;
    return { id: payload.sub, email };
  } catch { return null; }
}
function requireAdminSession(req, res, next) {
  const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  const user = verifyAdminSession(match?.[1] || '');
  if (!user) return res.status(401).json({ error: 'ADMIN_SESSION_REQUIRED', message: 'Admin session expired. Please sign in again.' });
  req.authUser = user;
  next();
}
function isRateLimitedAdminLogin(req) {
  const key = String(req.ip || req.socket?.remoteAddress || 'unknown');
  const now = Date.now();
  let attempt = adminLoginAttempts.get(key);
  if (!attempt || attempt.resetAt <= now) attempt = { count: 0, resetAt: now + 15 * 60 * 1000 };
  attempt.count += 1;
  adminLoginAttempts.set(key, attempt);
  if (adminLoginAttempts.size > 5000) {
    for (const [entry, value] of adminLoginAttempts) if (value.resetAt <= now) adminLoginAttempts.delete(entry);
  }
  return attempt.count > 10;
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

const qrPairings = new Map();
function pruneQrPairings() {
  const now = Date.now();
  for (const [id, item] of qrPairings) if (item.expiresAt <= now || item.used) qrPairings.delete(id);
}
app.post('/api/qr/start', (req, res) => {
  pruneQrPairings();
  if (qrPairings.size > 200) return res.status(503).json({ error: 'QR_BUSY', message: 'Too many QR sessions. Try again shortly.' });
  const id = crypto.randomBytes(16).toString('hex');
  const secret = crypto.randomBytes(32).toString('base64url');
  qrPairings.set(id, { secretHash: crypto.createHash('sha256').update(secret).digest('hex'), expiresAt: Date.now() + 90_000, status: 'pending', result: null, used: false });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ id, secret, expiresIn: 90 });
});
app.get('/api/qr/status', (req, res) => {
  pruneQrPairings();
  const id = String(req.query.id || ''), secret = String(req.query.secret || '');
  const item = qrPairings.get(id);
  if (!item || !secret || !crypto.timingSafeEqual(Buffer.from(item.secretHash), Buffer.from(crypto.createHash('sha256').update(secret).digest('hex')))) {
    return res.status(404).json({ status: 'expired' });
  }
  res.setHeader('Cache-Control', 'no-store');
  if (item.status === 'approved' && item.result) {
    item.used = true;
    const result = item.result;
    qrPairings.delete(id);
    return res.json({ status: 'approved', session: result });
  }
  res.json({ status: item.status, expiresIn: Math.max(0, Math.ceil((item.expiresAt - Date.now()) / 1000)) });
});
app.post('/api/qr/approve', async (req, res) => {
  pruneQrPairings();
  const id = String(req.body?.id || ''), secret = String(req.body?.secret || '');
  const match = String(req.headers.authorization || '').match(/^Bearer\\s+(.+)$/i);
  const item = qrPairings.get(id);
  if (!item || item.expiresAt <= Date.now() || item.used || item.status !== 'pending') {
    return res.status(410).json({ error: 'QR_EXPIRED', message: 'This QR code expired. Generate a new one on the PC.' });
  }
  const expected = Buffer.from(item.secretHash);
  const supplied = Buffer.from(crypto.createHash('sha256').update(secret).digest('hex'));
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
    return res.status(403).json({ error: 'QR_INVALID', message: 'Invalid QR pairing code.' });
  }
  const token = match?.[1] || '';
  const user = await authUserFromToken(token);
  if (!user) return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Sign in on your phone before approving.' });
  const session = req.body?.session;
  if (!session || session.user?.id !== user.id ||
      typeof session.access_token !== 'string' || session.access_token !== token ||
      typeof session.refresh_token !== 'string' || session.refresh_token.length < 20) {
    return res.status(400).json({ error: 'INVALID_SESSION', message: 'The phone session could not be verified.' });
  }
  item.status = 'approved';
  item.result = session;
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true });
});
\napp.post('/api/auth/login', async (req, res) => {
  if (!configured) {
    return res.status(503).json({ error: 'SERVER_NOT_CONFIGURED', message: 'Sign-in service is not configured. Please try again later.' });
  }
  if (isRateLimitedUserLogin(req)) {
    return res.status(429).json({ error: 'LOGIN_RATE_LIMITED', message: 'Too many sign-in attempts. Wait 15 minutes and retry.' });
  }
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!email || !password || password.length > 1024) {
    return res.status(400).json({ error: 'INVALID_CREDENTIALS', message: 'Enter your email and password.' });
  }
  try {
    const response = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(12_000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.access_token || !result.refresh_token || !result.user?.id) {
      return res.status(401).json({ error: 'SIGN_IN_FAILED', message: 'Email or password is incorrect.' });
    }

    let sessionResult = result;
    let forceMetadataRefresh = false;
    const initialMetadata = sessionResult.user.user_metadata || {};
    const initialAvatar = initialMetadata.avatar_url;
    if (!validStoredAvatarUrl(initialAvatar)) {
      let recoveredAvatar = await findStoredProfileAvatar(sessionResult.user.id);
      if (!recoveredAvatar) {
        const legacyAvatar = findLegacyAvatarDataUrl(initialMetadata);
        if (legacyAvatar) {
          const raster = await rasterizeLegacyAvatar(legacyAvatar);
          if (raster) recoveredAvatar = await storeProfileAvatar(sessionResult.user.id, raster);
          else console.warn('[Profile avatar] Could not recover the current user legacy image safely.');
        }
      }
      if (recoveredAvatar) {
        sessionResult.user.user_metadata = Object.assign({}, initialMetadata, { avatar_url: recoveredAvatar });
        forceMetadataRefresh = true;
      }
    }
    function oversizedSession(value) {
      const user = value?.user || {};
      const userMetadata = user.user_metadata || {};
      const appMetadata = user.app_metadata || {};
      const userMetadataBytes = Buffer.byteLength(JSON.stringify(userMetadata), 'utf8');
      const appMetadataBytes = Buffer.byteLength(JSON.stringify(appMetadata), 'utf8');
      const avatar = userMetadata.avatar_url;
      const unsafeAvatar = avatar != null && avatar !== '' && !validStoredAvatarUrl(avatar);
      return userMetadataBytes > 3000 || appMetadataBytes > 3000 || unsafeAvatar ||
        String(value?.access_token || '').length > 12_000;
    }

    // Some auth providers merge user_metadata rather than replacing it. Explicit
    // null patches are required to remove old data-URI/SVG/provider keys completely.
    // Retry once with fresh claims after cleaning both metadata namespaces.
    for (let attempt = 0; attempt < 2 && (forceMetadataRefresh || oversizedSession(sessionResult)); attempt += 1) {
      const currentUser = sessionResult.user || result.user;
      const userMetadata = currentUser.user_metadata || {};
      const appMetadata = currentUser.app_metadata || {};
      const userMetadataBytes = Buffer.byteLength(JSON.stringify(userMetadata), 'utf8');
      const appMetadataBytes = Buffer.byteLength(JSON.stringify(appMetadata), 'utf8');
      const avatar = userMetadata.avatar_url;
      const unsafeAvatar = avatar != null && avatar !== '' && !validStoredAvatarUrl(avatar);
      const compactMetadata = compactUserMetadata(userMetadata);
      const compactApps = (appMetadataBytes > 3000 || String(sessionResult.access_token || '').length > 12_000)
        ? compactAppMetadata(appMetadata) : null;

      await updateAuthUserMetadata(currentUser, compactMetadata, true, compactApps);
      const refreshResponse = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ refresh_token: sessionResult.refresh_token }),
        signal: AbortSignal.timeout(12_000)
      });
      const refreshed = await refreshResponse.json().catch(() => ({}));
      if (!refreshResponse.ok || !refreshed.access_token || !refreshed.refresh_token) {
        throw appError(503, 'SESSION_REFRESH_FAILED', 'Your saved profile data was cleaned. Please try signing in again.');
      }
      sessionResult = refreshed;
      forceMetadataRefresh = false;
    }

    if (String(sessionResult.access_token || '').length > 12_000) {
      throw appError(503, 'SESSION_TOKEN_TOO_LARGE',
        'Your saved profile data was cleaned, but the sign-in token is still too large. Please try signing in again in a minute.');
    }
    userLoginAttempts.delete(String(req.ip || req.socket?.remoteAddress || 'unknown'));
    res.json(sessionResult);
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 503;
    res.status(status).json({
      error: error?.code || 'AUTH_LOGIN_FAILED',
      message: status === 503 ? (error?.message || 'Sign-in service is temporarily unavailable. Please retry.') : 'Sign-in failed.'
    });
  }
});
app.get('/api/admin/config', (_req, res) => res.json({
  configured,
  adminConfigured: ADMIN_EMAILS.size > 0,
  supabaseUrl: configured ? SUPABASE_URL : null
}));
app.post('/api/admin/login', async (req, res) => {
  if (!configured || !ADMIN_EMAILS.size) {
    return res.status(503).json({ error: 'ADMIN_NOT_CONFIGURED', message: 'Admin login is not configured on the server.' });
  }
  if (isRateLimitedAdminLogin(req)) {
    return res.status(429).json({ error: 'LOGIN_RATE_LIMITED', message: 'Too many sign-in attempts. Wait 15 minutes and retry.' });
  }
  const email = normalize(req.body?.email);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!email || !password || password.length > 1024) {
    return res.status(400).json({ error: 'INVALID_CREDENTIALS', message: 'Enter your admin email and password.' });
  }
  try {
    // Supabase validates the credentials; its potentially large access token never returns to the browser.
    const response = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(12_000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.user?.id || !result.user?.email) {
      return res.status(401).json({ error: 'SIGN_IN_FAILED', message: 'Email or password is incorrect.' });
    }
    const userEmail = normalize(result.user.email);
    if (!ADMIN_EMAILS.has(userEmail)) {
      return res.status(403).json({ error: 'ADMIN_REQUIRED', message: 'This account is not on the FB Chat admin allowlist.' });
    }
    adminLoginAttempts.delete(String(req.ip || req.socket?.remoteAddress || 'unknown'));
    const issued = signAdminSession({ id: result.user.id, email: userEmail });
    return res.json({
      token: issued.token,
      expires_at: issued.expiresAt,
      user: { email: userEmail }
    });
  } catch {
    return res.status(503).json({ error: 'AUTH_UNAVAILABLE', message: 'Authentication service is temporarily unavailable. Retry shortly.' });
  }
});
function sendAdminPage(_req, res) {
  // The WordPress root-site page embeds this dedicated app origin in an iframe.
  // Allow only the owned root domain to frame the admin login, never arbitrary sites.
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', "frame-ancestors https://fashionbazz.in https://www.fashionbazz.in");
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
}
app.get(['/admin-chat', '/admin-chat/'], sendAdminPage);
app.get('/admin-chat/admin.css', (_req, res) =>
  res.sendFile(path.join(__dirname, 'admin', 'admin.css')));
app.get('/admin-chat/admin.js', (_req, res) =>
  res.sendFile(path.join(__dirname, 'admin', 'admin.js')));
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

app.get('/api/me', requireAuth, async (req, res, next) => {
  let metadata = req.authUser.user_metadata || {};
  try {
    metadata = await ensureStoredAvatarMetadata(req.authUser);
  } catch {
    // An avatar migration must never block a user from opening their own profile.
  }
  res.json({
    user: { id: req.authUser.id, email: req.authUser.email || null },
    profile: publicProfile(req.profile, metadata),
    key_backup: req.profile.key_backup || null
  });
});
app.post('/api/profile', requireAuth, async (req, res, next) => {
  try {
    const username = normalize(req.body?.username);
    const displayName = String(req.body?.display_name || '').trim();
    const bio = String(req.body?.bio || '').trim();
    const avatarUrl = req.body?.avatar_url === '' || req.body?.avatar_url == null
      ? null : req.body.avatar_url;
    if (!validUsername(username)) return res.status(400).json({ error: 'INVALID_USERNAME', message: 'Username must be 3–24 letters, numbers, dots or underscores.' });
    if (!validDisplayName(displayName)) return res.status(400).json({ error: 'INVALID_DISPLAY_NAME', message: 'Display name must be 2–40 characters.' });
    if (!validBio(bio)) return res.status(400).json({ error: 'INVALID_BIO', message: 'About must be 160 characters or fewer.' });
    if (avatarUrl !== null && !validAvatarDataUrl(avatarUrl) && !validStoredAvatarUrl(avatarUrl)) return res.status(400).json({ error: 'INVALID_AVATAR', message: 'Use a PNG, JPEG or WebP profile image under the supported size limit.' });
    if (req.profile.username !== username) {
      const existing = await getProfileByUsername(username);
      if (existing && existing.id !== req.authUser.id) return res.status(409).json({ error: 'USERNAME_TAKEN', message: 'That username is already taken.' });
    }
    const rows = await db('profiles', 'on_conflict=id', {
      method: 'POST', prefer: 'resolution=merge-duplicates,return=representation',
      body: [{ id: req.authUser.id, username, display_name: displayName }]
    });
    const storedAvatarUrl = !avatarUrl
      ? null
      : (validStoredAvatarUrl(avatarUrl) ? avatarUrl : await storeProfileAvatar(req.authUser.id, avatarUrl));
    const metadataUser = await updateAuthUserMetadata(req.authUser, {
      username, display_name: displayName, bio, avatar_url: storedAvatarUrl
    });
    res.json({ profile: publicProfile(
      rows?.[0] || await getProfileById(req.authUser.id),
      metadataUser.user_metadata || { username, display_name: displayName, bio, avatar_url: storedAvatarUrl }
    ) });
  } catch (error) { next(error); }
});
app.use('/api/admin', requireAdminSession);

app.get('/api/admin/overview', async (_req, res, next) => {
  try {
    const [users, messages, webPushSubscriptions, androidDevices] = await Promise.all([
      exactCount('profiles'), exactCount('chat_messages'),
      exactCount('push_subscriptions'), exactCount('fcm_tokens')
    ]);
    const recentProfiles = await db('profiles',
      'select=id,username,display_name,created_at,public_key&order=created_at.desc&limit=8');
    const authUsers = await fetchAuthUsers(1, 1000);
    const authById = new Map(authUsers.map((item) => [item.id, item]));
    res.json({
      generatedAt: new Date().toISOString(),
      service: {
        status: 'online',
        connectedUsers: online.size,
        webPushConfigured: pushConfigured,
        nativePushConfigured: Boolean(fcmMessaging),
        adminAllowlistConfigured: ADMIN_EMAILS.size > 0
      },
      counts: { users, messages, webPushSubscriptions, androidDevices, onlineNow: online.size },
      recentUsers: (recentProfiles || []).map((row) => {
        const account = authById.get(row.id) || {};
        return {
          id: row.id, username: row.username, display_name: row.display_name,
          email: account.email || '', created_at: account.created_at || row.created_at,
          last_sign_in_at: account.last_sign_in_at || null,
          encryptionReady: Boolean(row.public_key)
        };
      })
    });
  } catch (error) { next(error); }
});

app.get('/api/admin/users', async (req, res, next) => {
  try {
    const q = normalize(req.query.q);
    const page = Math.max(1, Math.min(1000, Number.parseInt(req.query.page, 10) || 1));
    const authUsers = await fetchAuthUsers(page, 1000);
    const profileRows = await db('profiles',
      'select=id,username,display_name,created_at,public_key&order=created_at.desc&limit=1000');
    const profileById = new Map((profileRows || []).map((item) => [item.id, item]));
    const items = authUsers.map((account) => {
      const meta = account.user_metadata || {};
      const row = profileById.get(account.id);
      const safe = safeProfileMetadata(meta);
      return {
        id: account.id,
        email: account.email || '',
        username: row?.username || normalize(meta.username),
        display_name: row?.display_name || String(meta.display_name || meta.full_name || ''),
        bio: safe.bio,
        avatar_url: safe.avatar_url,
        created_at: account.created_at || row?.created_at || null,
        last_sign_in_at: account.last_sign_in_at || null,
        email_confirmed_at: account.email_confirmed_at || null,
        encryptionReady: Boolean(row?.public_key),
        banned_until: account.banned_until || null,
        providers: Array.isArray(account.app_metadata?.providers) ? account.app_metadata.providers : []
      };
    }).filter((item) => !q || normalize([
      item.email, item.username, item.display_name, item.id
    ].join(' ')).includes(q));
    res.json({ users: items.slice(0, 200), total: items.length, page, hasMore: authUsers.length === 1000 });
  } catch (error) { next(error); }
});

app.get('/api/admin/activity', async (req, res, next) => {
  try {
    const rows = await db('chat_messages',
      'select=id,sender_id,recipient_id,created_at,delivered_at,read_at&order=created_at.desc&limit=100');
    const ids = [...new Set((rows || []).flatMap((item) => [item.sender_id, item.recipient_id]))];
    const profiles = ids.length ? await db('profiles',
      'select=id,username,display_name&id=in.(' + ids.join(',') + ')') : [];
    const byId = new Map((profiles || []).map((item) => [item.id, item]));
    const userIds = new Set(ids);
    const authUsers = await fetchAuthUsers(1, 1000);
    const byAuthId = new Map(authUsers.filter((item) => userIds.has(item.id)).map((item) => [item.id, item]));
    res.json({
      privacy: 'Message bodies and ciphertext are intentionally omitted from this activity view.',
      activity: (rows || []).map((item) => ({
        id: item.id,
        created_at: item.created_at,
        delivered_at: item.delivered_at,
        read_at: item.read_at,
        sender: {
          username: byId.get(item.sender_id)?.username || 'unknown',
          display_name: byId.get(item.sender_id)?.display_name || '',
          email: byAuthId.get(item.sender_id)?.email || ''
        },
        recipient: {
          username: byId.get(item.recipient_id)?.username || 'unknown',
          display_name: byId.get(item.recipient_id)?.display_name || '',
          email: byAuthId.get(item.recipient_id)?.email || ''
        }
      }))
    });
  } catch (error) { next(error); }
});

app.get('/api/admin/devices', async (_req, res, next) => {
  try {
    const [android, web] = await Promise.all([
      db('fcm_tokens', 'select=id,user_id,platform,device_name,user_agent,created_at,updated_at&order=updated_at.desc&limit=500'),
      db('push_subscriptions', 'select=id,user_id,user_agent,created_at,updated_at&order=updated_at.desc&limit=500')
    ]);
    const ids = [...new Set([...(android || []).map((item) => item.user_id), ...(web || []).map((item) => item.user_id)])];
    const profileRows = ids.length ? await db('profiles', 'select=id,username,display_name&id=in.(' + ids.join(',') + ')') : [];
    const byId = new Map((profileRows || []).map((item) => [item.id, item]));
    res.json({
      android: (android || []).map((item) => ({
        kind: 'Android app', username: byId.get(item.user_id)?.username || 'unknown',
        display_name: byId.get(item.user_id)?.display_name || '',
        device_name: item.device_name || 'Android device',
        user_agent: item.user_agent || '', created_at: item.created_at, updated_at: item.updated_at
      })),
      web: (web || []).map((item) => ({
        kind: 'Web / PWA', username: byId.get(item.user_id)?.username || 'unknown',
        display_name: byId.get(item.user_id)?.display_name || '',
        user_agent: item.user_agent || '', created_at: item.created_at, updated_at: item.updated_at
      }))
    });
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
app.post('/api/contacts/match', requireAuth, async (req, res, next) => {
  try {
    const contacts = req.body?.contacts;
    if (!Array.isArray(contacts) || contacts.length > 400) {
      return res.status(400).json({ error: 'INVALID_CONTACTS', message: 'Import up to 400 contacts at a time.' });
    }
    // Contact values are processed in memory only. We do not log or store the address book.
    const authUsers = await fetchAuthUsers(1, 1000);
    const candidates = findContactAccountMatches(contacts, authUsers)
      .filter((item) => item.accountId !== req.authUser.id)
      .slice(0, 150);
    const ids = [...new Set(candidates.map((item) => item.accountId))];
    if (!ids.length) return res.json({ matches: [] });
    const rows = await db('profiles',
      'select=id,username,display_name,public_key,created_at&id=in.(' + ids.join(',') + ')');
    const profilesById = new Map((rows || []).map((row) => [row.id, row]));
    const accountsById = new Map(authUsers.filter((item) => ids.includes(item.id)).map((item) => [item.id, item]));
    const metadataById = new Map();
    await Promise.all(ids.map(async (id) => {
      const account = accountsById.get(id);
      if (!account) return;
      try { metadataById.set(id, await ensureStoredAvatarMetadata(account)); }
      catch { metadataById.set(id, account.user_metadata || {}); }
    }));
    const matches = [];
    for (const item of candidates) {
      const row = profilesById.get(item.accountId);
      const account = accountsById.get(item.accountId);
      if (!account) continue;
      const metadata = metadataById.get(item.accountId) || account.user_metadata || {};
      const contactProfile = row
        ? publicProfile(row, metadata)
        : {
            id: account.id,
            username: '',
            display_name: String(metadata.display_name || metadata.full_name || '').trim().slice(0, 40) || 'FB Chat member',
            public_key: null,
            created_at: account.created_at || null,
            avatar_url: null,
            bio: typeof metadata.bio === 'string' ? metadata.bio.slice(0, 160) : ''
          };
      matches.push({
        index: item.index,
        profile: Object.assign({}, contactProfile, {
          encryptionReady: Boolean(row?.public_key)
        })
      });
    }
    res.json({ matches });
  } catch (error) { next(error); }
});
app.get('/api/users/:username', requireAuth, async (req, res, next) => {
  try {
    const person = await getProfileByUsername(req.params.username);
    if (!person) return res.status(404).json({ error: 'USER_NOT_FOUND', message: 'No account found with that username.' });
    if (person.id === req.authUser.id) return res.status(400).json({ error: 'SELF_CHAT', message: 'Choose a different username.' });
    if (!person.public_key) return res.status(409).json({ error: 'KEY_NOT_READY', message: 'This user has not finished encryption setup.' });
    const authPerson = await getAuthUserById(person.id);
    const metadata = authPerson ? await ensureStoredAvatarMetadata(authPerson) : {};
    res.json({ profile: publicProfile(person, metadata) });
  } catch (error) { next(error); }
});
app.get('/api/chats', requireAuth, async (req, res, next) => {
  try {
    const id = req.authUser.id;
    const rows = await db('chat_messages',
      'select=id,sender_id,recipient_id,ciphertext,iv,created_at,delivered_at,read_at&or=(sender_id.eq.' +
      id + ',recipient_id.eq.' + id + ')&order=created_at.desc&limit=500');
    const ids = [...new Set((rows || []).map(m => m.sender_id === id ? m.recipient_id : m.sender_id))];
    const profiles = ids.length ? await db('profiles',
      'select=id,username,display_name,public_key,created_at&id=in.(' + ids.join(',') + ')') : [];
    const profileMap = new Map((profiles || []).map(p => [p.id, p]));
    const authUsers = ids.length ? await fetchAuthUsers(1, 1000) : [];
    const metadataById = new Map();
    const relevantAuthUsers = authUsers.filter((item) => ids.includes(item.id));
    await Promise.all(relevantAuthUsers.map(async (item) => {
      try {
        metadataById.set(item.id, await ensureStoredAvatarMetadata(item));
      } catch (error) {
        // A photo migration should not make the chat list unavailable.
        console.warn('[PROFILE] Existing avatar migration deferred for a chat contact.');
        metadataById.set(item.id, item.user_metadata || {});
      }
    }));
    const latest = new Map();
    for (const message of rows || []) {
      const peerId = message.sender_id === id ? message.recipient_id : message.sender_id;
      if (!latest.has(peerId)) latest.set(peerId, message);
    }
    const chats = [...latest.entries()].map(([peerId, message]) => {
      const peer = profileMap.get(peerId);
      if (!peer) return null;
      return { peer: publicProfile(peer, metadataById.get(peerId) || {}), last_message: {
        id: message.id, sender_id: message.sender_id, recipient_id: message.recipient_id,
        ciphertext: message.ciphertext, iv: message.iv,
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
    const authPeer = await getAuthUserById(peer.id);
    let peerMetadata = authPeer?.user_metadata || {};
    if (authPeer) {
      try {
        peerMetadata = await ensureStoredAvatarMetadata(authPeer);
      } catch {
        // Keep chat history available if legacy avatar migration needs another attempt.
      }
    }
    res.json({ peer: publicProfile(peer, peerMetadata), messages: rows || [] });
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
    const authRecord = await getAuthUserById(user.id);
    const publicMetadata = authRecord
      ? await ensureStoredAvatarMetadata(authRecord)
      : (user.user_metadata || {});
    const visible = safeProfileMetadata(publicMetadata);
    socket.data.user = {
      id: user.id, username: row.username, display_name: row.display_name,
      avatar_url: visible.avatar_url, bio: visible.bio
    };
    next();
  } catch (error) { next(new Error(error.code || 'SERVER_NOT_READY')); }
});
io.on('connection', (socket) => {
  const user = socket.data.user;
  const oldId = online.get(user.id);
  if (oldId && oldId !== socket.id) {
    const oldSocket = io.sockets.sockets.get(oldId);
    if (oldSocket) {
      // Notify the previous device before disconnecting it so its UI clears the old session.
      oldSocket.emit('session:replaced', { reason: 'This account was opened on another device.' });
      oldSocket.disconnect(true);
    }
  }
  online.set(user.id, socket.id);
  socketUsers.set(socket.id, user);
  socket.emit('session:ready', { user, onlineUsers: [...socketUsers.values()] });
  broadcastPresence();
  flushPendingCallEvents(user.id, socket);

  socket.on('profile:refresh', async () => {
    try {
      const current = await getProfileById(user.id);
      if (!current) return;
      user.username = current.username;
      user.display_name = current.display_name;
      const authUser = await getAuthUserById(user.id);
      const metadata = authUser ? await ensureStoredAvatarMetadata(authUser) : {};
      const visible = safeProfileMetadata(metadata);
      user.avatar_url = visible.avatar_url;
      user.bio = visible.bio;
      socket.data.user = user;
      socketUsers.set(socket.id, user);
      broadcastPresence();
    } catch { /* Profile syncing must not interrupt chat traffic. */ }
  });

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
      const authPeer = await getAuthUserById(peer.id);
      let peerMetadata = authPeer?.user_metadata || {};
      if (authPeer) {
        try {
          peerMetadata = await ensureStoredAvatarMetadata(authPeer);
        } catch {
          // Keep encrypted message history available if avatar migration fails.
        }
      }
      await db('chat_messages', 'recipient_id=eq.' + user.id + '&sender_id=eq.' + peer.id + '&delivered_at=is.null', {
        method: 'PATCH', prefer: 'return=minimal', body: { delivered_at: new Date().toISOString() }
      });
      socket.emit('chat:history', {
        peer: publicProfile(peer, peerMetadata),
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
module.exports = { app, server, io, normalize, validUsername, validDisplayName, validEncryptedMessage, validPushSubscription, validFcmToken, authUserFromToken, validAvatarDataUrl, validStoredAvatarUrl, validBio, publicProfile, compactUserMetadata, compactAppMetadata, metadataCleanupPatch, findLegacyAvatarDataUrl, rasterizeLegacyAvatar, normalizeContactPhone, findContactAccountMatches };
