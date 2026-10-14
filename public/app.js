(() => {
  'use strict';
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const te = new TextEncoder();
  const td = new TextDecoder();
  const USER_RE = /^[a-z0-9_.]{3,24}$/;
  const KDF_ITERATIONS = 310000;

  let config = null, session = null, me = null, profile = null, privateKey = null;
  let socket = null, connected = false, mode = 'login', activePeer = null;
  let nativeFcmToken = '';
  let onlineUsers = [], chats = new Map(), histories = new Map(), unread = new Map();
  let busy = false, toastTimer = null, typingTimer = null, changedFingerprint = null, replyTarget = null;
  let chatOpenRequest = 0;

  const norm = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const to64 = (buffer) => {
    let raw = '';
    for (const byte of new Uint8Array(buffer)) raw += String.fromCharCode(byte);
    return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  };
  const from64 = (value) => {
    let raw = String(value).replace(/-/g, '+').replace(/_/g, '/');
    while (raw.length % 4) raw += '=';
    return Uint8Array.from(atob(raw), (character) => character.charCodeAt(0));
  };
  function toast(message, duration = 3500) {
    $('#toastMessage').textContent = String(message || '');
    $('#toast').classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('#toast').classList.remove('show'), duration);
  }
  function authMessage(message = '', isError = false) {
    $('#authMessage').textContent = message;
    $('#authMessage').classList.toggle('error', Boolean(isError));
  }
  function setAuthMode(next, message = '') {
    mode = next === 'signup' ? 'signup' : 'login';
    const signup = mode === 'signup';
    $('#loginTab').classList.toggle('active', !signup);
    $('#signupTab').classList.toggle('active', signup);
    $('#signupFields').hidden = !signup;
    $('#displayName').required = signup;
    $('#username').required = signup;
    $('#authTitle').textContent = signup ? 'Create your account' : 'Welcome back';
    $('#authDescription').textContent = signup
      ? 'Choose a unique username to start encrypted chats.'
      : 'Sign in to continue your private conversations.';
    $('#authSubmit').textContent = signup ? 'Create account securely' : 'Sign in securely';
    $('#password').autocomplete = signup ? 'new-password' : 'current-password';
    authMessage(message);
  }
  function showAuth(message = '', error = false) {
    $('#authOverlay').classList.add('show');
    authMessage(message, error);
  }
  function nameOf(person) {
    return person?.display_name || person?.username || 'Unknown';
  }
  function online(id) {
    return onlineUsers.some((person) => person.id === id);
  }

  let draftAvatarUrl = null, profileAvatarDirty = false;

  function setAvatar(element, person) {
    if (!element) return;
    element.replaceChildren();
    const photo = person?.avatar_url;
    if (typeof photo === 'string' && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(photo) && photo.length <= 90_000) {
      element.classList.add('has-photo');
      const image = document.createElement('img');
      image.src = photo; image.alt = nameOf(person) + ' profile photo';
      element.appendChild(image);
    } else {
      element.classList.remove('has-photo');
      element.textContent = nameOf(person).slice(0, 1).toUpperCase();
    }
  }
  function dateLabel(value) {
    if (!value) return '';
    const date = new Date(value), today = new Date();
    if (Number.isNaN(date.getTime())) return '';
    if (date.toDateString() === today.toDateString())
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    return date.toDateString() === yesterday.toDateString() ? 'Yesterday'
      : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  function clock(value) {
    const date = new Date(value || Date.now());
    return Number.isNaN(date.getTime()) ? ''
      : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  function setConnected(value, label = '') {
    connected = Boolean(value);
    $('#connectionDot').classList.toggle('online', connected);
    $('#inboxSub').textContent = connected ? 'Connected · encrypted chats' : (label || 'Connecting securely…');
    if (activePeer) $('#activeStatus').textContent = connected
      ? (online(activePeer.id) ? 'online' : 'end-to-end encrypted') : 'Reconnecting…';
  }

  function headers(extra = {}) {
    return Object.assign({ 'Content-Type': 'application/json' },
      session?.access_token ? { Authorization: 'Bearer ' + session.access_token } : {}, extra);
  }
  async function api(url, options = {}, retry = true) {
    const response = await fetch(url, Object.assign({ credentials: 'same-origin' }, options, {
      headers: headers(options.headers || {})
    }));
    if (response.status === 401 && retry && session?.refresh_token) {
      try { await refreshSession(); return api(url, options, false); } catch {}
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.message || 'Request failed (' + response.status + ')');
      error.status = response.status;
      error.code = data.error;
      throw error;
    }
    return data;
  }
  async function syncNativePushToken() {
    if (!window.FBChatNative || !me || !session?.access_token) return;
    try {
      const token = String(window.FBChatNative.getFcmToken() || '');
      if (token.length >= 20) nativeFcmToken = token;
    } catch {}
    if (!nativeFcmToken) {
      try { window.FBChatNative.refreshToken(); } catch {}
      return;
    }
    const marker = 'fbchat-fcm-registered-' + me.id;
    // Always re-register on app resume/auth; the server may have lost its token
    // table even when this browser still has a local marker. The endpoint upserts.
    try {
      await api('/api/fcm/register', {
        method: 'POST',
        body: JSON.stringify({ token: nativeFcmToken, platform: 'android', device_name: 'FB Chat Android' })
      });
      localStorage.setItem(marker, nativeFcmToken);
    } catch (error) {
      console.warn('Native push token registration failed:', error?.message || 'request failed');
    }
  }
  function acceptNativeFcmToken(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 4096) return;
    nativeFcmToken = token;
    void syncNativePushToken();
  }
  // WebView can receive its FCM token before authentication finishes.
  // Retry registration when the app returns to the foreground or network comes back.
  let nativePushRetryQueued = false;
  function retryNativePushRegistration() {
    if (nativePushRetryQueued) return;
    nativePushRetryQueued = true;
    Promise.resolve().then(() => {
      nativePushRetryQueued = false;
      void syncNativePushToken();
    });
  }
  window.addEventListener('focus', retryNativePushRegistration);
  window.addEventListener('online', retryNativePushRegistration);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') retryNativePushRegistration();
  });
  async function unregisterNativePushToken() {
    if (!window.FBChatNative || !me || !session?.access_token || !nativeFcmToken) return;
    try {
      await api('/api/fcm/register', {
        method: 'DELETE',
        body: JSON.stringify({ token: nativeFcmToken })
      });
    } catch {}
    localStorage.removeItem('fbchat-fcm-registered-' + me.id);
  }
  async function authRequest(path, body) {
    if (!config?.configured || !config.supabaseUrl || !config.supabaseAnonKey)
      throw new Error('Database setup is not connected yet. The chat website is live, but sign-in and saving messages are disabled until the free database is configured.');
    const response = await fetch(config.supabaseUrl + '/auth/v1/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: config.supabaseAnonKey },
      body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.msg || data.message || data.error_description || data.error || 'Authentication failed.');
    return data;
  }
  function saveSession(data) {
    session = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Number(data.expires_at || (Math.floor(Date.now() / 1000) + Number(data.expires_in || 3600))),
      token_type: data.token_type || 'bearer',
      user: data.user || session?.user || null
    };
    localStorage.setItem('fbchat-session', JSON.stringify(session));
  }
  function clearSession() {
    try { socket?.disconnect(); } catch {}
    socket = null; session = null; me = null; profile = null; privateKey = null; activePeer = null;
    onlineUsers = []; chats = new Map(); histories = new Map(); unread = new Map(); connected = false;
    localStorage.removeItem('fbchat-session');
    $('#app').classList.remove('chat-open');
    $('#connectionDot').classList.remove('online');
  }
  async function refreshSession() {
    if (!session?.refresh_token) throw new Error('Your session expired. Sign in again.');
    const data = await authRequest('token?grant_type=refresh_token', { refresh_token: session.refresh_token });
    if (!data.access_token || !data.refresh_token) throw new Error('Session refresh failed.');
    saveSession(data);
  }
  async function makeSessionFresh() {
    if (!session?.access_token) return false;
    if (session.expires_at <= Math.floor(Date.now() / 1000) + 60) {
      try { await refreshSession(); } catch { clearSession(); return false; }
    }
    return true;
  }

  // Private ECDH key material is stored locally as a non-extractable CryptoKey.
  // The encrypted recovery bundle is AES-GCM protected with a PBKDF2 key.
  function openKeyDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('fbchat-encryption-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('keys', { keyPath: 'userId' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Cannot open local key storage.'));
    });
  }
  async function readLocalKey(userId) {
    const db = await openKeyDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('keys', 'readonly'), req = tx.objectStore('keys').get(userId);
      req.onsuccess = () => { db.close(); resolve(req.result || null); };
      req.onerror = () => { db.close(); reject(req.error); };
    });
  }
  async function saveLocalKey(record) {
    const db = await openKeyDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('keys', 'readwrite');
      tx.objectStore('keys').put(record);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  }
  async function fingerprint(jwk) {
    return to64(await crypto.subtle.digest('SHA-256', te.encode([jwk.kty, jwk.crv, jwk.x, jwk.y].join('.'))));
  }
  function prettyFingerprint(value) {
    return String(value || '').replace(/[-_]/g, '').toUpperCase().match(/.{1,4}/g)?.join(' ') || '';
  }
  async function importPublic(jwk) {
    if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y)
      throw new Error('The contact encryption key is invalid.');
    return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  }
  async function passwordKey(password, salt, iterations = KDF_ITERATIONS) {
    const material = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, material,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function makeBackup(privateJwk, password, fp) {
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await passwordKey(password, salt);
    const plain = te.encode(JSON.stringify({ version: 1, fingerprint: fp, privateJwk }));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
    return { version: 1, iterations: KDF_ITERATIONS, salt: to64(salt), iv: to64(iv), ciphertext: to64(encrypted), fingerprint: fp };
  }
  async function recoverPrivate(bundle, password, fp) {
    if (!bundle || bundle.version !== 1 || !bundle.salt || !bundle.iv || !bundle.ciphertext)
      throw new Error('No usable encrypted key backup exists for this account. Do not create a replacement key.');
    if (bundle.fingerprint && bundle.fingerprint !== fp) throw new Error('The saved encryption key fingerprint does not match.');
    try {
      const key = await passwordKey(password, from64(bundle.salt), Number(bundle.iterations) || KDF_ITERATIONS);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: from64(bundle.iv) }, key, from64(bundle.ciphertext));
      const parsed = JSON.parse(td.decode(plain));
      if (parsed.version !== 1 || parsed.fingerprint !== fp || !parsed.privateJwk?.d) throw new Error('Invalid bundle.');
      return parsed.privateJwk;
    } catch {
      throw new Error('Could not unlock the encrypted key backup. Check your account password. A password reset may not unlock older messages.');
    }
  }
  async function importPrivate(jwk) {
    return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  }
  async function newKeyPair(userId, password) {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    const fp = await fingerprint(publicJwk);
    const backup = await makeBackup(privateJwk, password, fp);
    const key = await importPrivate(privateJwk);
    ['d', 'x', 'y'].forEach((field) => { privateJwk[field] = ''; });
    await saveLocalKey({ userId, privateKey: key, publicJwk, fingerprint: fp, savedAt: Date.now() });
    return { publicJwk, key_backup: backup, privateKey: key };
  }
  async function restoreKey(userId, profileData, password) {
    if (!password) throw new Error('Sign in again with your password to unlock the key backup on this device.');
    const fp = await fingerprint(profileData.public_key);
    const jwk = await recoverPrivate(profileData.key_backup, password, fp);
    const key = await importPrivate(jwk);
    ['d', 'x', 'y'].forEach((field) => { jwk[field] = ''; });
    await saveLocalKey({ userId, privateKey: key, publicJwk: profileData.public_key, fingerprint: fp, savedAt: Date.now() });
    return key;
  }
  async function ensureEncryption(profileData, userId, password) {
    if (!crypto?.subtle || !window.indexedDB)
      throw new Error('This browser does not support secure key storage. Use a modern browser over HTTPS.');
    if (profileData.public_key) {
      const fp = await fingerprint(profileData.public_key);
      let local = null;
      try { local = await readLocalKey(userId); } catch {}
      if (local?.privateKey && local.fingerprint === fp) { privateKey = local.privateKey; return; }
      privateKey = await restoreKey(userId, profileData, password);
      return;
    }
    if (profileData.key_backup) throw new Error('The account has a key backup but no public key. Contact the app owner before continuing.');
    if (!password) throw new Error('Sign in again with your password to set up encryption on this device.');
    const created = await newKeyPair(userId, password);
    const saved = await api('/api/me/crypto', { method: 'PUT', body: JSON.stringify({ public_key: created.publicJwk, key_backup: created.key_backup }) });
    profileData.public_key = saved.profile.public_key;
    privateKey = created.privateKey;
  }
  async function deriveMessageKey(peerPublicJwk, senderId, recipientId) {
    if (!privateKey) throw new Error('Your private key is locked. Sign in again to unlock it.');
    const peer = await importPublic(peerPublicJwk);
    const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256);
    const base = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey({
      name: 'HKDF', hash: 'SHA-256', salt: te.encode('fb-chat-message-key-v1'),
      info: te.encode('fb-chat-v1|' + senderId + '|' + recipientId)
    }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function encryptText(text, peer) {
    const key = await deriveMessageKey(peer.public_key, me.id, peer.id);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const value = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(text));
    return { ciphertext: to64(value), iv: to64(iv) };
  }
  async function decryptText(message, peer) {
    try {
      const key = await deriveMessageKey(peer.public_key, message.sender_id, message.recipient_id);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: from64(message.iv) }, key, from64(message.ciphertext));
      return td.decode(plain);
    } catch { return '[Unable to decrypt on this device]'; }
  }
  function decodeMessageContent(raw) {
    try {
      const value = JSON.parse(raw);
      if (value && value.version === 1 && typeof value.text === 'string') {
        return { plaintext: value.text, reply: value.reply && typeof value.reply.text === 'string' ? value.reply : null, media: value.media && typeof value.media.data === 'string' ? value.media : null };
      }
    } catch {}
    return { plaintext: String(raw || ''), reply: null, media: null };
  }
  function starStorageKey() { return 'fbchat-starred-' + (me?.id || 'anonymous'); }
  function hiddenStorageKey() { return 'fbchat-hidden-' + (me?.id || 'anonymous'); }
  function readStoredSet(key) {
    try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')); } catch { return new Set(); }
  }
  function playMessageSound() {
    if (localStorage.getItem('fbchat-message-sound') === 'off') return;
    if (document.visibilityState !== 'visible') return;
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      const context = new AudioContextClass();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(880, context.currentTime);
      oscillator.frequency.setValueAtTime(1175, context.currentTime + 0.075);
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.09, context.currentTime + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.19);
      oscillator.connect(gain); gain.connect(context.destination);
      oscillator.start(); oscillator.stop(context.currentTime + 0.2);
      oscillator.addEventListener('ended', () => context.close().catch(() => {}), { once: true });
      context.resume().catch(() => {});
    } catch {}
  }
  function urlBase64ToUint8Array(value) {
    const padding = '='.repeat((4 - value.length % 4) % 4);
    const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  }
  async function enablePushNotifications() {
    if (!me || !session?.access_token) { showAuth('Sign in to enable message notifications.'); return; }
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      toast('Background push is not supported in this app container. Install FB Chat from Chrome for PWA push, or use a native FCM-enabled APK.');
      return;
    }
    try {
      const info = await fetch('/api/push/public-key', { cache: 'no-store' }).then((response) => response.json());
      if (!info.enabled || !info.publicKey) {
        toast('Server push is not configured yet. The app needs its VAPID keys and push database table.', 5000);
        return;
      }
      const permission = Notification.permission === 'granted'
        ? 'granted' : await Notification.requestPermission();
      if (permission !== 'granted') {
        toast('Allow notifications in Android app/site settings to receive message alerts.', 5000);
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(info.publicKey)
        });
      }
      await api('/api/push/subscribe', {
        method: 'POST',
        body: JSON.stringify({ subscription: subscription.toJSON() })
      });
      localStorage.setItem('fbchat-push-enabled', 'on');
      toast('Push enabled. Background messages use your Android notification sound and vibration.', 4500);
    } catch (error) {
      toast(error.message || 'Could not enable push notifications.', 4500);
    }
  }
  async function disablePushNotifications() {
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager?.getSubscription();
      if (subscription) {
        try { await api('/api/push/subscribe', { method: 'DELETE', body: JSON.stringify({ endpoint: subscription.endpoint }) }); } catch {}
        await subscription.unsubscribe();
      }
      localStorage.removeItem('fbchat-push-enabled');
      toast('Message push notifications turned off.');
    } catch (error) { toast(error.message || 'Could not turn notifications off.'); }
  }
  async function openChatByUsername(username) {
    const cleaned = norm(username);
    if (!USER_RE.test(cleaned)) return;
    if (!me) {
      sessionStorage.setItem('fbchat-open-chat', cleaned);
      return;
    }
    try {
      const data = await api('/api/users/' + encodeURIComponent(cleaned));
      addChat(data.profile);
      await openChat(data.profile);
    } catch (error) {
      toast(error.message || 'Could not open chat from notification.');
    }
  }
  function handleQueuedNotificationChat() {
    if (!me) return;
    const params = new URLSearchParams(location.search);
    const username = params.get('openChat') || sessionStorage.getItem('fbchat-open-chat');
    if (!username) return;
    sessionStorage.removeItem('fbchat-open-chat');
    if (params.has('openChat')) {
      params.delete('openChat');
      history.replaceState(null, '', location.pathname + (params.toString() ? '?' + params.toString() : '') + location.hash);
    }
    void openChatByUsername(username);
  }
  function handleQueuedNotificationCall() {
    if (!me) return;
    const params = new URLSearchParams(location.search);
    const from = params.get('openCall');
    const kind = params.get('callKind') === 'video' ? 'video' : 'audio';
    if (!from || !USER_RE.test(from)) return;
    params.delete('openCall'); params.delete('callKind');
    history.replaceState(null, '', location.pathname + (params.toString() ? '?' + params.toString() : '') + location.hash);
    const open = () => incomingCallDialog({ from: from.toLowerCase(), displayName: from, kind });
    if (socket?.connected) open();
    else if (socket) socket.once('connect', open);
  }
  async function checkPeerKey(peer) {
    const fp = await fingerprint(peer.public_key), store = 'fbchat-peer-pin-' + peer.id, prior = localStorage.getItem(store);
    if (prior && prior !== fp) return { trusted: false, fingerprint: fp };
    if (!prior) localStorage.setItem(store, fp);
    return { trusted: true, fingerprint: fp };
  }

  function addChat(peer, latest = null) {
    if (!peer?.id || !peer.username) return;
    const previous = chats.get(peer.id);
    chats.set(peer.id, { peer, lastMessage: latest || previous?.lastMessage || null });
    renderChats();
  }
  function getChatById(id) { return chats.get(id); }
  function getChatByUsername(username) {
    return [...chats.values()].find((item) => norm(item.peer.username) === norm(username));
  }
  function renderChats() {
    const root = $('#chatList'), query = norm($('#chatSearch').value);
    const filter = $('.filter.active')?.dataset.filter || 'all';
    const list = [...chats.values()].sort((a, b) =>
      new Date(b.lastMessage?.created_at || b.peer.created_at || 0) -
      new Date(a.lastMessage?.created_at || a.peer.created_at || 0));
    root.replaceChildren();
    let shown = 0;
    for (const item of list) {
      const person = item.peer, last = item.lastMessage, unreadCount = Number(unread.get(person.id) || 0), isHere = online(person.id);
      if (!norm(person.display_name + ' ' + person.username).includes(query)) continue;
      if (filter === 'unread' && !unreadCount) continue;
      if (filter === 'online' && !isHere) continue;
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'chatitem' + (activePeer?.id === person.id ? ' active' : '');
      const avatar = document.createElement('div');
      avatar.className = 'chatavatar'; setAvatar(avatar, person);
      if (isHere) { const dot = document.createElement('span'); dot.className = 'online-dot'; avatar.appendChild(dot); }
      const body = document.createElement('div'); body.className = 'chatbody';
      const row = document.createElement('div'); row.className = 'chatrow';
      const title = document.createElement('strong'); title.textContent = nameOf(person);
      const time = document.createElement('time'); time.textContent = dateLabel(last?.created_at || person.created_at);
      row.append(title, time);
      const preview = document.createElement('div'); preview.className = 'lastmsg';
      preview.textContent = last?.preview || '🔒 End-to-end encrypted';
      body.append(row, preview);
      if (unreadCount) { const badge = document.createElement('span'); badge.className = 'unread'; badge.textContent = String(Math.min(99, unreadCount)); body.appendChild(badge); }
      button.append(avatar, body); button.addEventListener('click', () => openChat(person)); root.appendChild(button); shown++;
    }
    if (!shown) {
      const empty = document.createElement('div'); empty.className = 'list-empty';
      const icon = document.createElement('div'); icon.className = 'empty-symbol'; icon.textContent = filter === 'unread' ? '✓' : '✳';
      const title = document.createElement('strong'); title.textContent = filter === 'unread' ? 'All caught up' : (query ? 'No matching chats' : 'Your chats will appear here');
      const note = document.createElement('p'); note.textContent = query ? 'Try a different name or username.' : (filter === 'online' ? 'Nobody in your chat list is online.' : 'Start a secure chat with someone’s username.');
      const action = document.createElement('button'); action.type = 'button'; action.className = 'text-action'; action.textContent = 'Start a chat'; action.addEventListener('click', showNewChat);
      empty.append(icon, title, note, action); root.appendChild(empty);
    }
    $('#unreadDot').hidden = ![...unread.values()].some((n) => n > 0);
  }
  function renderHistory(peerId) {
    const root = $('#messages'), list = histories.get(peerId) || [];
    const hidden = readStoredSet(hiddenStorageKey()), starred = readStoredSet(starStorageKey());
    const visible = list.filter((message) => !hidden.has(message.id));
    root.replaceChildren();
    const divider = document.createElement('div'); divider.className = 'daydivider'; divider.textContent = '🔒 END-TO-END ENCRYPTED'; root.appendChild(divider);
    if (!visible.length) {
      const note = document.createElement('div'); note.className = 'systemnote';
      note.textContent = list.length ? 'No visible messages in this chat.' : 'Messages are encrypted on this device. Send a hello to start.';
      root.appendChild(note);
    }
    let previousDay = '';
    for (const message of visible) {
      const date = new Date(message.created_at || Date.now());
      const dayKey = Number.isNaN(date.getTime()) ? 'unknown' : date.toDateString();
      if (dayKey !== previousDay) {
        previousDay = dayKey;
        const label = document.createElement('div'); label.className = 'message-date';
        const today = new Date(), yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
        label.textContent = dayKey === today.toDateString() ? 'Today'
          : dayKey === yesterday.toDateString() ? 'Yesterday'
            : Number.isNaN(date.getTime()) ? 'Earlier' : date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
        root.appendChild(label);
      }
      const bubble = document.createElement('article');
      bubble.className = 'bubble' + (message.sender_id === me.id ? ' mine' : '');
      bubble.dataset.messageId = message.id;
      if (message.reply && typeof message.reply.text === 'string') {
        const quote = document.createElement('div'); quote.className = 'reply-quote';
        const author = document.createElement('strong'); author.textContent = message.reply.author || 'Reply';
        const snippet = document.createElement('span'); snippet.textContent = message.reply.text.slice(0, 280);
        quote.append(author, snippet); bubble.appendChild(quote);
      }
      if (message.media && /^data:(image|video|audio)\//.test(message.media.data) && message.media.data.length <= 50000) {
        const media = message.media;
        if (media.mime?.startsWith('image/')) {
          const image = document.createElement('img'); image.src = media.data; image.alt = media.name || 'Shared image'; image.className = 'shared-media'; image.loading = 'lazy'; bubble.appendChild(image);
        } else if (media.mime?.startsWith('video/')) {
          const video = document.createElement('video'); video.src = media.data; video.controls = true; video.playsInline = true; video.className = 'shared-media'; bubble.appendChild(video);
        } else {
          const audio = document.createElement('audio'); audio.src = media.data; audio.controls = true; bubble.appendChild(audio);
        }
        const filename = document.createElement('div'); filename.className = 'media-filename'; filename.textContent = media.name || 'Shared media'; bubble.appendChild(filename);
      }
      const body = document.createElement('div'); body.className = 'bubble-text'; body.textContent = message.plaintext || '';
      if (body.textContent) bubble.appendChild(body);
      const meta = document.createElement('div'); meta.className = 'bmeta';
      if (starred.has(message.id)) {
        const star = document.createElement('span'); star.className = 'star-mark'; star.textContent = '★'; star.title = 'Starred message'; meta.appendChild(star);
      }
      const time = document.createElement('span'); time.textContent = clock(message.created_at); meta.appendChild(time);
      if (message.sender_id === me.id) { const ticks = document.createElement('span'); ticks.className = 'ticks'; ticks.textContent = message.read_at ? '✓✓' : (message.delivered_at ? '✓✓' : '✓'); meta.appendChild(ticks); }
      const more = document.createElement('button'); more.type = 'button'; more.className = 'message-more';
      more.setAttribute('aria-label', 'Message options'); more.title = 'Message options'; more.textContent = '⋮';
      more.addEventListener('click', (event) => { event.stopPropagation(); messageActionsDialog(message); });
      bubble.append(more, meta); root.appendChild(bubble);
    }
    root.scrollTop = root.scrollHeight;
  }
  async function openChat(person) {
    if (!person || person.id === me?.id || !person.public_key) { toast('This person has not finished encryption setup.'); return; }
    const requestId = ++chatOpenRequest;
    activePeer = person; changedFingerprint = null; unread.set(person.id, 0);
    $('#welcome').hidden = true; $('#convHead').hidden = false; $('#messages').hidden = false; $('#composerWrap').hidden = false;
    $('#activeName').textContent = nameOf(person); setAvatar($('#activeAvatar'), person);
    $('#activeStatus').title = person.bio || '';
    $('#activeStatus').textContent = connected ? (online(person.id) ? 'online' : 'end-to-end encrypted') : 'Connecting…';
    $('#app').classList.add('chat-open'); renderChats();
    try {
      const trust = await checkPeerKey(person);
      if (requestId !== chatOpenRequest || activePeer?.id !== person.id) return;
      if (!trust.trusted) {
        changedFingerprint = trust.fingerprint; $('#chatDetails').dataset.keyChanged = 'true'; $('#composerWrap').hidden = true;
        $('#activeStatus').textContent = 'Security warning · key changed'; $('#messages').replaceChildren();
        const warning = document.createElement('div'); warning.className = 'systemnote warning';
        warning.textContent = 'This contact’s public key changed. Verify the fingerprint via another trusted channel before accepting it.';
        $('#messages').appendChild(warning); toast('Contact key changed. Sending is blocked until verification.', 6000); return;
      }
      $('#chatDetails').dataset.keyChanged = 'false';
      const data = await api('/api/chats/' + encodeURIComponent(person.username) + '/messages');
      if (requestId !== chatOpenRequest || activePeer?.id !== person.id) return;
      addChat(data.peer);
      const history = [];
      for (const message of data.messages || []) {
        const decoded = decodeMessageContent(await decryptText(message, person));
        history.push(Object.assign({}, message, decoded));
      }
      if (requestId !== chatOpenRequest || activePeer?.id !== person.id) return;
      histories.set(person.id, history);
      const last = history[history.length - 1], entry = chats.get(person.id);
      if (entry && last) entry.lastMessage = Object.assign({}, last, { preview: last.plaintext || '🔒 Encrypted message' });
      renderHistory(person.id); renderChats();
      if (socket?.connected) { socket.emit('chat:open', { peer: person.username }); socket.emit('chat:read', { peer: person.username }); }
    } catch (error) { if (requestId === chatOpenRequest && activePeer?.id === person.id) toast(error.message || 'Could not load this conversation.'); }
  }
  async function loadChats() {
    const data = await api('/api/chats'); chats = new Map();
    for (const item of data.chats || []) {
      const latest = item.last_message ? Object.assign({}, item.last_message) : null;
      if (latest?.ciphertext && latest.iv && item.peer?.public_key) {
        const decoded = decodeMessageContent(await decryptText(latest, item.peer));
        latest.preview = decoded.media
          ? (decoded.media.mime?.startsWith('image/') ? '📷 Photo' : decoded.media.mime?.startsWith('video/') ? '🎬 Video' : '🎵 Audio')
          : (decoded.plaintext || '').trim().replace(/\s+/g, ' ').slice(0, 120) || '🔒 Encrypted message';
      } else latest && (latest.preview = '🔒 Encrypted message');
      addChat(item.peer, latest);
    }
    renderChats();
  }
  async function applySession(password) {
    if (!await makeSessionFresh()) throw new Error('Sign in to continue.');
    const data = await api('/api/me');
    me = data.user;
    profile = Object.assign({}, data.profile, { key_backup: data.key_backup || null });
    await ensureEncryption(profile, me.id, password || '');
    $('#authOverlay').classList.remove('show');
    $('#profileButton').title = nameOf(profile) + ' · profile';
    setConnected(false, 'Connecting securely…');
    await loadChats();
    startSocket();
    if (window.FBChatNative) {
      void syncNativePushToken();
      try { window.FBChatNative.refreshToken(); } catch {}
      // Legacy native builds need this sign-in check to discover their first in-app update.
      try { window.FBChatNative.checkForAppUpdate(); } catch {}
    }
    handleQueuedNotificationChat();
    handleQueuedNotificationCall();
    void showCallPermissionPrompt();
    if (window.FBChatNative && typeof window.FBChatNative.checkForAppUpdate !== 'function'
        && localStorage.getItem(LEGACY_UPDATE_DISMISSED_KEY) !== 'dismissed'
        && localStorage.getItem(LEGACY_UPDATE_DISMISSED_KEY) !== 'downloaded') {
      setTimeout(showLegacyAndroidUpdateDialog, 3500);
    }
  }
  function startSocket() {
    try { socket?.disconnect(); } catch {}
    if (!session?.access_token) return;
    socket = window.io({ auth: { token: session.access_token }, transports: ['websocket', 'polling'] });
    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false, 'Offline · reconnecting'));
    socket.on('connect_error', (error) => {
      setConnected(false, 'Waiting for secure connection');
      if (error?.message === 'AUTH_REQUIRED') toast('Session expired. Sign in again.');
      if (error?.message === 'ENCRYPTION_SETUP_REQUIRED') toast('Encryption setup is incomplete.');
    });
    enableMediaControls();
    socket.on('session:ready', (data) => { onlineUsers = Array.isArray(data?.onlineUsers) ? data.onlineUsers : []; setConnected(true); renderChats(); });
    socket.on('presence:list', (users) => { onlineUsers = Array.isArray(users) ? users : []; setConnected(true); renderChats(); });
    socket.on('chat:error', (data) => toast(data?.message || 'Chat error.'));
    socket.on('chat:history', async (data) => {
      if (!data?.peer || !Array.isArray(data.messages) || activePeer?.id !== data.peer.id) return;
      const history = [];
      for (const message of data.messages) {
        const decoded = decodeMessageContent(await decryptText(message, activePeer));
        history.push(Object.assign({}, message, decoded));
      }
      if (activePeer?.id !== data.peer.id) return;
      histories.set(data.peer.id, history); renderHistory(data.peer.id);
    });
    socket.on('chat:message', async (message) => {
      if (!message?.id || !message.ciphertext || !message.iv || !message.sender_id) return;
      let person = getChatById(message.sender_id)?.peer || (activePeer?.id === message.sender_id ? activePeer : null);
      if (!person && message.sender_username) {
        try { person = (await api('/api/users/' + encodeURIComponent(message.sender_username))).profile; } catch { return; }
      }
      if (!person) return;
      const history = histories.get(person.id) || [];
      if (history.some((item) => item.id === message.id)) return;
      playMessageSound();
      const decoded = decodeMessageContent(await decryptText(message, person));
      const plain = decoded.plaintext, saved = Object.assign({}, message, decoded);
      history.push(saved); histories.set(person.id, history);
      const item = chats.get(person.id);
      if (item) item.lastMessage = Object.assign({}, saved, { preview: plain });
      else addChat(person, Object.assign({}, saved, { preview: plain }));
      if (activePeer?.id === person.id) { renderHistory(person.id); socket.emit('chat:read', { peer: person.username }); }
      else { unread.set(person.id, (unread.get(person.id) || 0) + 1); toast('New encrypted message from ' + nameOf(person)); }
      renderChats();
    });
    socket.on('chat:receipts', (data) => {
      if (!data) return;
      for (const [peerId, history] of histories.entries()) {
        let updated = false;
        for (const message of history) {
          if (message.sender_id === me.id && message.recipient_id === data.peer_id) {
            if (data.read) message.read_at = new Date().toISOString();
            else if (data.delivered) message.delivered_at = new Date().toISOString();
            updated = true;
          }
        }
        if (updated && activePeer?.id === peerId) renderHistory(peerId);
      }
    });
    socket.on('chat:typing', (data) => {
      if (activePeer && norm(activePeer.username) === norm(data?.from)) {
        $('#typingLine').hidden = !data.active;
        $('#activeStatus').textContent = data.active ? 'typing…' : (online(activePeer.id) ? 'online' : 'end-to-end encrypted');
      }
    });
  }

  async function submitAuth(event) {
    event.preventDefault(); if (busy) return;
    if (!config?.configured) { authMessage('Database setup is not connected yet. Accounts remain disabled until configuration is complete.', true); return; }
    const email = $('#email').value.trim(), password = $('#password').value;
    const username = norm($('#username').value), display = $('#displayName').value.trim();
    if (password.length < 10) { authMessage('Password must be at least 10 characters.', true); return; }
    if (mode === 'signup' && !USER_RE.test(username)) { authMessage('Username must be 3–24 characters: letters, numbers, dots or underscores.', true); return; }
    if (mode === 'signup' && (display.length < 2 || display.length > 40 || /[<>]/.test(display))) { authMessage('Display name must be 2–40 characters.', true); return; }
    busy = true; $('#authSubmit').disabled = true; $('#authSubmit').textContent = mode === 'signup' ? 'Creating account…' : 'Signing in…'; authMessage('');
    try {
      if (mode === 'signup') {
        const data = await authRequest('signup', { email, password, data: { username, display_name: display } });
        if (!data.access_token || !data.refresh_token) { setAuthMode('login', 'Account created. Check your email for the confirmation link, then sign in.'); return; }
        saveSession(data);
      } else {
        const data = await authRequest('token?grant_type=password', { email, password });
        if (!data.access_token || !data.refresh_token) throw new Error('Sign-in did not return a session.');
        saveSession(data);
      }
      await applySession(password); $('#password').value = ''; toast('Signed in. The private key is unlocked on this device.');
    } catch (error) { authMessage(error.message || 'Could not sign in.', true); }
    finally { busy = false; $('#authSubmit').disabled = false; $('#authSubmit').textContent = mode === 'signup' ? 'Create account securely' : 'Sign in securely'; }
  }
  function showNewChat() {
    if (!me) { showAuth('Sign in before starting a chat.'); return; }
    $('#genericTitle').textContent = 'Start a new chat';
    $('#genericDescription').textContent = 'Enter the exact username the other person chose during sign-up.';
    $('#genericLabel').textContent = 'Username'; $('#genericLabel').hidden = false;
    $('#genericInput').hidden = false; $('#genericInput').value = ''; $('#genericInput').maxLength = 24; $('#genericInput').placeholder = 'e.g. sana_khan';
    $('#genericSubmit').hidden = false; $('#genericSubmit').textContent = 'Find account';
    $('#genericForm').hidden = false; $('#genericFoot').textContent = 'Both accounts must finish encryption setup before chatting.';
    $('#genericModal').hidden = false; $('#genericInput').focus();
  }
  function infoModal(title, description, actions = []) {
    $('#genericTitle').textContent = title; $('#genericDescription').textContent = description;
    $('#genericLabel').hidden = true; $('#genericInput').hidden = true; $('#genericSubmit').hidden = true; $('#genericForm').hidden = true;
    $('#genericFoot').replaceChildren();
    for (const item of actions) {
      if (item.type === 'toggle') {
        const row = document.createElement('label'); row.className = 'permission-row';
        const copy = document.createElement('span'); copy.className = 'permission-copy';
        const heading = document.createElement('strong'); heading.textContent = item.label;
        const detail = document.createElement('small'); detail.textContent = item.detail || '';
        const status = document.createElement('small'); status.className = 'permission-status'; status.textContent = item.status || '';
        copy.append(heading, detail, status);
        const input = document.createElement('input'); input.type = 'checkbox'; input.setAttribute('role', 'switch');
        input.checked = Boolean(item.checked); input.setAttribute('aria-label', item.label);
        input.addEventListener('change', async () => {
          const wanted = input.checked; input.disabled = true;
          try {
            const result = await item.action(wanted);
            if (result && typeof result.checked === 'boolean') input.checked = result.checked;
            if (result?.status) status.textContent = result.status;
          } catch (error) {
            input.checked = !wanted; status.textContent = error?.message || 'Could not update permission.';
          } finally { input.disabled = false; }
        });
        row.append(copy, input); $('#genericFoot').appendChild(row); continue;
      }
      const button = document.createElement('button'); button.type = 'button';
      button.className = item.className || 'text-action'; button.textContent = item.label;
      button.addEventListener('click', item.action); $('#genericFoot').appendChild(button);
    }
    $('#genericModal').hidden = false;
  }
  async function findUser(event) {
    event.preventDefault();
    const username = norm($('#genericInput').value);
    if (!USER_RE.test(username) || username === norm(profile?.username)) { toast('Enter another valid username.'); return; }
    $('#genericSubmit').disabled = true;
    try {
      const data = await api('/api/users/' + encodeURIComponent(username));
      $('#genericModal').hidden = true; addChat(data.profile); await openChat(data.profile);
    } catch (error) { $('#genericFoot').textContent = error.message || 'Could not find that account.'; toast(error.message || 'Could not find that account.'); }
    finally { $('#genericSubmit').disabled = false; }
  }
  function messageActionsDialog(message) {
    const starred = readStoredSet(starStorageKey()).has(message.id);
    const actions = [
      {
        label: 'Reply',
        action: () => {
          replyTarget = {
            id: message.id,
            author: message.sender_id === me.id ? 'You' : nameOf(activePeer),
            text: String(message.plaintext || '').slice(0, 280)
          };
          $('#replyText').textContent = 'Replying to ' + replyTarget.author + ': ' + replyTarget.text;
          $('#replyBar').hidden = false;
          $('#genericModal').hidden = true;
          $('#messageInput').focus();
        }
      },
      {
        label: 'Copy message',
        action: async () => {
          try {
            await navigator.clipboard.writeText(String(message.plaintext || ''));
            toast('Message copied.');
          } catch { toast('Copy is not available in this browser.'); }
          $('#genericModal').hidden = true;
        }
      },
      {
        label: starred ? 'Remove star' : 'Star message',
        action: () => {
          const values = readStoredSet(starStorageKey());
          if (values.has(message.id)) values.delete(message.id); else values.add(message.id);
          localStorage.setItem(starStorageKey(), JSON.stringify([...values]));
          $('#genericModal').hidden = true;
          if (activePeer) renderHistory(activePeer.id);
          toast(values.has(message.id) ? 'Message starred on this device.' : 'Star removed.');
        }
      },
      {
        label: 'Delete for me',
        className: 'danger-action',
        action: () => {
          const values = readStoredSet(hiddenStorageKey());
          values.add(message.id);
          localStorage.setItem(hiddenStorageKey(), JSON.stringify([...values]));
          $('#genericModal').hidden = true;
          if (activePeer) renderHistory(activePeer.id);
          toast('Message hidden on this device only.');
        }
      },
      { label: 'Close', action: () => { $('#genericModal').hidden = true; } }
    ];
    infoModal('Message options', 'Actions apply to this message. Starred and hidden-message settings are saved only on this device.', actions);
  }

  let peerConnection = null, localStream = null, remoteMediaStream = null, remoteVideoStream = null;
  let currentCallPeer = null, currentCallKind = 'audio', incomingCall = null;
  let pendingRemoteIceCandidates = [], callStartedAt = 0, callConnectedAt = 0;
  let callClockTimer = null, toneTimer = null, toneContext = null, toneNodes = [];
  let isMuted = false, isCameraDisabled = false, isSpeakerEnabled = true, isFrontCamera = true;
  let callDirection = 'outgoing';
  const pendingCallSignals = new Map();
  const rtcConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ],
    bundlePolicy: 'max-bundle'
  };
  function callStatus(text) { const el = $('#callStatus'); if (el) el.textContent = text; }
  function showCallUi(show) {
    $('#callOverlay').hidden = !show;
    if ($('#callFloatingButton')) $('#callFloatingButton').hidden = !peerConnection || show;
  }
  function startCallTone(kind) {
    stopCallTone();
    try {
      if (window.FBChatNative && typeof window.FBChatNative.startCallTone === 'function') {
        window.FBChatNative.startCallTone(kind || 'ringback');
        return;
      }
    } catch {}
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      toneContext = new AudioContextClass();
      const playBurst = () => {
        if (!toneContext || toneContext.state === 'closed') return;
        const now = toneContext.currentTime, oscillator = toneContext.createOscillator(), gain = toneContext.createGain();
        oscillator.type = 'sine'; oscillator.frequency.value = kind === 'incoming' ? 440 : 425;
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.12, now + 0.04);
        gain.gain.setValueAtTime(0.12, now + 0.45);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.52);
        oscillator.connect(gain); gain.connect(toneContext.destination);
        oscillator.start(now); oscillator.stop(now + 0.55); toneNodes.push(oscillator);
        oscillator.addEventListener('ended', () => {
          toneNodes = toneNodes.filter(node => node !== oscillator);
          try { oscillator.disconnect(); gain.disconnect(); } catch {}
        }, { once: true });
      };
      playBurst(); toneTimer = setInterval(playBurst, kind === 'incoming' ? 1050 : 2100);
      toneContext.resume().catch(() => {});
    } catch {}
  }
  function stopCallTone() {
    clearInterval(toneTimer); toneTimer = null;
    toneNodes.forEach(node => { try { node.stop(); } catch {} }); toneNodes = [];
    if (toneContext) { const old = toneContext; toneContext = null; old.close().catch(() => {}); }
    try { if (window.FBChatNative && typeof window.FBChatNative.stopCallTone === 'function') window.FBChatNative.stopCallTone(); } catch {}
  }
  function setCallAudioRoute(speaker) {
    isSpeakerEnabled = Boolean(speaker);
    const button = $('#speakerCallButton');
    if (button) {
      button.classList.toggle('control-active', isSpeakerEnabled);
      button.setAttribute('aria-pressed', String(isSpeakerEnabled));
      const label = button.querySelector('span:last-child');
      if (label) label.textContent = isSpeakerEnabled ? 'Speaker' : 'Earpiece';
    }
    try {
      if (window.FBChatNative && typeof window.FBChatNative.setCallAudioRoute === 'function') {
        window.FBChatNative.setCallAudioRoute(isSpeakerEnabled);
      } else {
        const audio = $('#remoteCallAudio');
        if (audio && 'setSinkId' in audio) audio.setSinkId('default').catch(() => {});
      }
    } catch {}
  }
  function playRemoteMedia(element) {
    if (!element) return;
    const result = element.play();
    if (result && typeof result.catch === 'function') result.catch(error => {
      console.warn('[FBChatCall] media playback was blocked:', error?.name || error?.message || error);
    });
  }
  function attachRemoteTrack(event) {
    if (!event?.track) return;
    if (!remoteMediaStream) remoteMediaStream = new MediaStream();
    if (!remoteVideoStream) remoteVideoStream = new MediaStream();
    const addTrackOnce = (stream, track) => {
      if (track && !stream.getTracks().some(item => item.id === track.id)) stream.addTrack(track);
    };
    // Keep media kinds on separate streams. The video element is muted on purpose; remote
    // audio is played through its own audio element so Android autoplay never blocks video.
    for (const stream of (event.streams || [])) {
      for (const track of stream.getTracks()) addTrackOnce(
        track.kind === 'video' ? remoteVideoStream : remoteMediaStream, track
      );
    }
    addTrackOnce(event.track.kind === 'video' ? remoteVideoStream : remoteMediaStream, event.track);
    if (event.track.kind === 'video') {
      const video = $('#remoteCallVideo'), placeholder = $('#remoteCallPlaceholder');
      video.muted = true; video.autoplay = true; video.playsInline = true;
      video.srcObject = remoteVideoStream; video.hidden = false;
      if (placeholder) placeholder.hidden = true;
      event.track.onunmute = () => {
        video.hidden = false;
        if (placeholder) placeholder.hidden = true;
        playRemoteMedia(video);
        callStatus('Remote video playing');
      };
      event.track.onmute = () => {
        if (placeholder && !isCameraDisabled) {
          const title = placeholder.querySelector('strong');
          if (title) title.textContent = 'The other camera is paused';
          placeholder.hidden = false;
        }
      };
      playRemoteMedia(video);
    } else if (event.track.kind === 'audio') {
      const audio = $('#remoteCallAudio');
      audio.srcObject = remoteMediaStream; audio.muted = false; audio.volume = 1;
      playRemoteMedia(audio);
    }
  }
  async function setRemoteDescriptionAndFlush(description) {
    await peerConnection.setRemoteDescription(description);
    const queued = pendingRemoteIceCandidates.splice(0);
    for (const candidate of queued) {
      try { await peerConnection.addIceCandidate(candidate); }
      catch (error) { console.warn('[FBChatCall] queued ICE candidate:', error?.message || error); }
    }
  }
  function setCallControlState() {
    const micButton = $('#muteCallButton');
    if (micButton) {
      const label = micButton.querySelector('span:last-child');
      if (label) label.textContent = isMuted ? 'Unmute' : 'Mute';
      micButton.classList.toggle('control-active', isMuted);
      micButton.setAttribute('aria-pressed', String(isMuted));
    }
    const cameraButton = $('#cameraCallButton');
    if (cameraButton) {
      const label = cameraButton.querySelector('span:last-child');
      if (label) label.textContent = isCameraDisabled ? 'Camera on' : 'Camera off';
      cameraButton.classList.toggle('control-active', isCameraDisabled);
      cameraButton.setAttribute('aria-pressed', String(isCameraDisabled));
      cameraButton.disabled = currentCallKind !== 'video';
    }
    if ($('#flipCameraButton')) $('#flipCameraButton').disabled = currentCallKind !== 'video';
  }
  async function acquireCallMedia(kind) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera/microphone access is unavailable. Update the app or open the HTTPS site in Chrome.');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false
      });
    } catch (firstError) {
      const retryable = ['NotFoundError', 'NotReadableError', 'OverconstrainedError', 'AbortError'].includes(firstError?.name)
        || /audio source not found|requested device not found/i.test(String(firstError?.message || ''));
      if (!retryable) throw withMediaStage(firstError, 'microphone');
      await new Promise(resolve => setTimeout(resolve, 250));
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); }
      catch (retryError) { throw withMediaStage(retryError, 'microphone'); }
    }
    if (kind !== 'video') return stream;
    try {
      const cameraStream = await navigator.mediaDevices.getUserMedia({
        audio: false, video: { facingMode: { ideal: 'user' }, width: { ideal: 640 }, height: { ideal: 480 } }
      });
      const videoTrack = cameraStream.getVideoTracks()[0];
      if (!videoTrack) throw new Error('No camera track was returned by Android.');
      stream.addTrack(videoTrack); isFrontCamera = true;
      cameraStream.getAudioTracks().forEach(track => track.stop());
      return stream;
    } catch (error) {
      stream.getTracks().forEach(track => track.stop());
      throw withMediaStage(error, 'camera');
    }
  }
  function withMediaStage(error, stage) {
    const wrapped = new Error(error?.message || (stage === 'camera' ? 'Camera could not start.' : 'Microphone could not start.'));
    wrapped.name = error?.name || 'Error'; wrapped.mediaStage = stage;
    return wrapped;
  }
  function callMediaErrorMessage(error) {
    const detail = String(error?.message || '').toLowerCase(), stage = error?.mediaStage || 'microphone';
    if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError')
      return stage === 'camera' ? 'Camera permission denied. Check Android Settings > Apps > FB Chat > Permissions.'
        : 'Microphone permission denied. Check Android Settings > Apps > FB Chat > Permissions.';
    if (error?.name === 'NotFoundError' || /audio source not found|requested device not found|no audio device/i.test(detail))
      return stage === 'camera' ? 'Camera source not found. Check camera permissions and close other camera apps.'
        : 'Microphone source not found. Check microphone permission and the system-wide microphone privacy switch.';
    if (error?.name === 'NotReadableError' || error?.name === 'AbortError')
      return stage === 'camera' ? 'Camera is busy. Close Camera or another video-call app and retry.'
        : 'Microphone is busy. Close Recorder, Camera or other call apps and retry.';
    return error?.message || 'Could not access camera or microphone. Check Android permissions and retry.';
  }
  function setupPeerConnection() {
    peerConnection = new RTCPeerConnection(rtcConfig);
    remoteMediaStream = new MediaStream(); remoteVideoStream = new MediaStream(); pendingRemoteIceCandidates = [];
    peerConnection.ontrack = attachRemoteTrack;
    peerConnection.onicecandidate = event => {
      if (event.candidate && currentCallPeer && socket?.connected)
        socket.emit('call:signal', { to: currentCallPeer, signal: { candidate: event.candidate.toJSON?.() || event.candidate } });
    };
    peerConnection.onconnectionstatechange = () => {
      if (!peerConnection) return;
      const state = peerConnection.connectionState;
      if (state === 'connected') {
        callConnectedAt = callConnectedAt || Date.now(); stopCallTone(); callStatus('Connected');
        if ($('#callTimer')) $('#callTimer').hidden = false;
      } else if (state === 'connecting') callStatus('Connecting…');
      else if (state === 'disconnected') callStatus('Reconnecting…');
      else if (state === 'failed') { callStatus('Connection failed'); toast('Network path failed. Some networks need a TURN relay for video calls.', 5000); }
    };
    peerConnection.oniceconnectionstatechange = () => {
      if (peerConnection?.iceConnectionState === 'failed') callStatus('Network path failed');
      else if (peerConnection?.iceConnectionState === 'disconnected') callStatus('Reconnecting…');
    };
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
  }
  function formatCallDuration(ms) {
    const sec = Math.max(0, Math.floor(ms / 1000));
    return String(Math.floor(sec / 60)).padStart(2,'0') + ':' + String(sec % 60).padStart(2,'0');
  }
  function readCallHistory() {
    try {
      const rows = JSON.parse(localStorage.getItem('fbchat-call-history') || '[]');
      return Array.isArray(rows) ? rows.filter(item => item && typeof item.id === 'string').slice(0, 50) : [];
    } catch { return []; }
  }
  function storeCallHistory(entry) {
    try { const rows = readCallHistory(); rows.unshift(entry); localStorage.setItem('fbchat-call-history', JSON.stringify(rows.slice(0,50))); } catch {}
  }
  function startCallClock() {
    clearInterval(callClockTimer);
    const timer = $('#callTimer'); if (timer) timer.hidden = false;
    callClockTimer = setInterval(() => {
      if (timer) timer.textContent = formatCallDuration((callConnectedAt || callStartedAt) ? Date.now() - (callConnectedAt || callStartedAt) : 0);
    }, 1000);
  }
  async function startCall(kind) {
    if (!activePeer || !socket?.connected) return toast('Open a chat and connect before calling.');
    if (localStorage.getItem(callPermissionToggleKey('microphone')) === 'off') return toast('Microphone is disabled in Settings. Enable it before calling.', 4500);
    if (kind === 'video' && localStorage.getItem(callPermissionToggleKey('camera')) === 'off') return toast('Camera is disabled in Settings. Enable it before making a video call.', 4500);
    if (peerConnection) return toast('A call is already active.');
    currentCallPeer = activePeer.username; currentCallKind = kind === 'video' ? 'video' : 'audio';
    callDirection = 'outgoing'; callStartedAt = Date.now(); callConnectedAt = 0;
    isMuted = false; isCameraDisabled = false; isSpeakerEnabled = true; isFrontCamera = true;
    $('#callTitle').textContent = (currentCallKind === 'video' ? 'Video call · ' : 'Voice call · ') + nameOf(activePeer);
    $('#callAvatar').textContent = nameOf(activePeer).slice(0,1).toUpperCase();
    $('#remotePlaceholderAvatar').textContent = nameOf(activePeer).slice(0,1).toUpperCase();
    $('#callTimer').hidden = true; $('#remoteCallVideo').hidden = true;
    $('#remoteCallPlaceholder').hidden = currentCallKind !== 'video'; $('#remoteCallAudio').srcObject = null;
    try {
      localStream = await acquireCallMedia(currentCallKind);
      $('#localCallVideo').srcObject = localStream; $('#localCallVideo').classList.add('front-camera'); $('#localCallVideo').hidden = currentCallKind !== 'video';
      setupPeerConnection(); setCallControlState(); setCallAudioRoute(true);
      $('#remoteCallVideo').srcObject = null;
      showCallUi(true); callStatus('Calling…'); startCallClock(); startCallTone('ringback');
      socket.emit('call:invite', { to: currentCallPeer, kind: currentCallKind });
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      socket.emit('call:signal', { to: currentCallPeer, signal: { description: peerConnection.localDescription.toJSON?.() || peerConnection.localDescription } });
    } catch (error) { endCall(false, 'failed'); toast(callMediaErrorMessage(error)); }
  }
  async function acceptIncomingCall() {
    if (!incomingCall || !socket?.connected) return;
    if (localStorage.getItem(callPermissionToggleKey('microphone')) === 'off') {
      socket.emit('call:end', { to: incomingCall.from }); incomingCall = null; stopCallTone();
      toast('Microphone is disabled in Settings. Enable it before accepting calls.', 4500); return;
    }
    if (incomingCall.kind === 'video' && localStorage.getItem(callPermissionToggleKey('camera')) === 'off') {
      socket.emit('call:end', { to: incomingCall.from }); incomingCall = null; stopCallTone();
      toast('Camera is disabled in Settings. Enable it before accepting video calls.', 4500); return;
    }
    const call = incomingCall; incomingCall = null;
    callDirection = 'incoming'; currentCallPeer = call.from; currentCallKind = call.kind === 'video' ? 'video' : 'audio';
    callStartedAt = Date.now(); callConnectedAt = 0; isMuted = false; isCameraDisabled = false; isSpeakerEnabled = true; isFrontCamera = true;
    stopCallTone();
    try {
      localStream = await acquireCallMedia(currentCallKind);
      $('#callTitle').textContent = (currentCallKind === 'video' ? 'Video call · ' : 'Voice call · ') + (call.displayName || call.from);
      $('#callAvatar').textContent = (call.displayName || call.from).slice(0,1).toUpperCase();
      $('#remotePlaceholderAvatar').textContent = (call.displayName || call.from).slice(0,1).toUpperCase();
      $('#callTimer').hidden = true; $('#localCallVideo').srcObject = localStream; $('#localCallVideo').classList.add('front-camera');
      $('#localCallVideo').hidden = currentCallKind !== 'video'; $('#remoteCallVideo').srcObject = null; $('#remoteCallVideo').hidden = true;
      $('#remoteCallPlaceholder').hidden = currentCallKind !== 'video'; $('#remoteCallAudio').srcObject = null;
      setupPeerConnection(); setCallControlState(); setCallAudioRoute(true); showCallUi(true); callStatus('Connecting…'); startCallClock();
      socket.emit('call:accept', { to: currentCallPeer });
      if (call.description) await setRemoteDescriptionAndFlush(call.description);
      for (const candidate of (call.candidates || [])) {
        if (!peerConnection.remoteDescription) pendingRemoteIceCandidates.push(candidate);
        else { try { await peerConnection.addIceCandidate(candidate); } catch (error) { console.warn('[FBChatCall] initial candidate:', error); } }
      }
      if (peerConnection.remoteDescription) {
        const answer = await peerConnection.createAnswer(); await peerConnection.setLocalDescription(answer);
        socket.emit('call:signal', { to: currentCallPeer, signal: { description: peerConnection.localDescription.toJSON?.() || peerConnection.localDescription } });
      }
    } catch (error) { endCall(true, 'failed'); toast(callMediaErrorMessage(error)); }
  }
  async function handleCallSignal(data) {
    if (!peerConnection || data.from !== currentCallPeer || !data.signal) return;
    try {
      if (data.signal.description) {
        const description = data.signal.description;
        if (description.type === 'offer' && peerConnection.signalingState === 'stable') {
          await setRemoteDescriptionAndFlush(description);
          const answer = await peerConnection.createAnswer(); await peerConnection.setLocalDescription(answer);
          socket.emit('call:signal', { to: currentCallPeer, signal: { description: peerConnection.localDescription.toJSON?.() || peerConnection.localDescription } });
        } else if (description.type === 'answer' && peerConnection.signalingState === 'have-local-offer') {
          await setRemoteDescriptionAndFlush(description);
        }
      }
      if (data.signal.candidate) {
        if (!peerConnection.remoteDescription) pendingRemoteIceCandidates.push(data.signal.candidate);
        else await peerConnection.addIceCandidate(data.signal.candidate);
      }
    } catch (error) { console.warn('[FBChatCall] signaling:', error?.message || error); }
  }
  function endCall(notify = true, finalState) {
    const peer = currentCallPeer;
    if (notify && peer && socket?.connected) socket.emit('call:end', { to: peer });
    stopCallTone(); clearInterval(callClockTimer); callClockTimer = null;
    const duration = callConnectedAt ? Date.now() - callConnectedAt : 0;
    if (peer && callStartedAt) {
      const state = finalState || (callConnectedAt ? 'completed' : (callDirection === 'incoming' ? 'missed' : 'cancelled'));
      storeCallHistory({ id: String(Date.now()) + '-' + Math.random().toString(36).slice(2,8), peer, kind: currentCallKind, direction: callDirection, state, duration, at: new Date().toISOString() });
    }
    try { peerConnection?.close(); } catch {}
    peerConnection = null;
    if (localStream) localStream.getTracks().forEach(track => track.stop());
    localStream = null; remoteMediaStream = null; remoteVideoStream = null; pendingRemoteIceCandidates = [];
    ['localCallVideo','remoteCallVideo','remoteCallAudio'].forEach(id => { const el = $('#'+id); if (el) { try { el.pause?.(); } catch {} el.srcObject = null; } });
    $('#localCallVideo').classList.remove('front-camera'); $('#remoteCallVideo').hidden = true; $('#remoteCallPlaceholder').hidden = true; $('#callTimer').hidden = true;
    currentCallPeer = null; incomingCall = null; callStartedAt = 0; callConnectedAt = 0;
    try { if (window.FBChatNative?.endCallAudio) window.FBChatNative.endCallAudio(); } catch {}
    showCallUi(false);
  }
  function incomingCallDialog(data) {
    if (!data?.from || !['audio','video'].includes(data.kind)) return;
    if (peerConnection || incomingCall?.from === data.from) return;
    incomingCall = data;
    const queued = pendingCallSignals.get(data.from) || []; pendingCallSignals.delete(data.from);
    for (const signal of queued) {
      if (signal.description) incomingCall.description = signal.description;
      if (signal.candidate) (incomingCall.candidates ||= []).push(signal.candidate);
    }
    $('#callTitle').textContent = (data.kind === 'video' ? 'Incoming video call · ' : 'Incoming voice call · ') + (data.displayName || data.from);
    $('#callAvatar').textContent = (data.displayName || data.from).slice(0,1).toUpperCase();
    $('#remotePlaceholderAvatar').textContent = (data.displayName || data.from).slice(0,1).toUpperCase();
    callStatus('Incoming call'); startCallTone('incoming');
    infoModal('Incoming ' + (data.kind === 'video' ? 'video' : 'voice') + ' call', (data.displayName || data.from) + ' (@' + data.from + ') is calling you.',
      [
        { label: 'Accept', className: 'primary', action: async () => { $('#genericModal').hidden = true; stopCallTone(); await acceptIncomingCall(); } },
        { label: 'Decline', className: 'danger-action', action: () => {
          $('#genericModal').hidden = true; stopCallTone(); socket?.emit('call:end', { to: data.from });
          storeCallHistory({ id: String(Date.now()) + '-' + Math.random().toString(36).slice(2,8), peer: data.from, kind: data.kind, direction: 'incoming', state: 'rejected', duration: 0, at: new Date().toISOString() });
          incomingCall = null;
        }}
      ]);
  }
  async function toggleCamera() {
    const track = localStream?.getVideoTracks()[0];
    if (!track) return toast('Camera controls are available during a video call.', 3000);
    isCameraDisabled = !isCameraDisabled; track.enabled = !isCameraDisabled; setCallControlState();
    const placeholder = $('#remoteCallPlaceholder');
    if (placeholder) { placeholder.textContent = isCameraDisabled ? 'Your camera is off' : 'Waiting for the other camera…'; placeholder.hidden = !isCameraDisabled; }
  }
  async function flipCamera() {
    if (!peerConnection || currentCallKind !== 'video' || !navigator.mediaDevices?.getUserMedia) return;
    const sender = peerConnection.getSenders().find(item => item.track?.kind === 'video');
    if (!sender) return toast('No camera track is available to switch.');
    const nextFacing = isFrontCamera ? 'environment' : 'user';
    try {
      const fresh = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: nextFacing }, width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
      const nextTrack = fresh.getVideoTracks()[0]; if (!nextTrack) throw new Error('No camera track returned.');
      await sender.replaceTrack(nextTrack);
      const previous = localStream.getVideoTracks()[0]; if (previous) { localStream.removeTrack(previous); previous.stop(); }
      localStream.addTrack(nextTrack); $('#localCallVideo').srcObject = localStream;
      isFrontCamera = !isFrontCamera; $('#localCallVideo').classList.toggle('front-camera', isFrontCamera); isCameraDisabled = false; setCallControlState();
      fresh.getTracks().filter(track => track !== nextTrack).forEach(track => track.stop());
    } catch (error) { toast('Could not switch camera: ' + (error.message || 'camera unavailable'), 4500); }
  }
  function toggleMute() {
    const tracks = localStream?.getAudioTracks() || [];
    if (!tracks.length) return toast('No microphone track is available.');
    isMuted = !isMuted; tracks.forEach(track => { track.enabled = !isMuted; }); setCallControlState();
  }
  function toggleCallSpeaker() {
    setCallAudioRoute(!isSpeakerEnabled);
    toast(isSpeakerEnabled ? 'Speakerphone enabled.' : 'Earpiece mode selected.', 1500);
  }
  function minimizeCall() { if (peerConnection) showCallUi(false); }
  function showCallHistory() {
    const entries = readCallHistory();
    if (!entries.length) return infoModal('Calls', 'Recent voice and video calls will appear here on this device.', [{ label: 'Close', action: () => { $('#genericModal').hidden = true; } }]);
    const summary = entries.slice(0,15).map(item => {
      const direction = item.direction === 'incoming' ? 'Incoming' : 'Outgoing';
      const type = item.kind === 'video' ? 'video' : 'voice';
      const state = item.state === 'missed' ? 'missed' : item.state === 'rejected' ? 'declined' : item.state === 'completed' ? formatCallDuration(item.duration || 0) : item.state;
      return direction + ' ' + type + ' call with @' + item.peer + ' · ' + state + ' · ' + new Date(item.at).toLocaleString();
    }).join('\n');
    infoModal('Recent calls', summary, [
      { label: 'Clear history on this device', className: 'danger-action', action: () => { localStorage.removeItem('fbchat-call-history'); $('#genericModal').hidden = true; toast('Call history cleared on this device.'); } },
      { label: 'Close', action: () => { $('#genericModal').hidden = true; } }
    ]);
  }
  function enableMediaControls() {
    if ($('#voiceCallButton')) $('#voiceCallButton').onclick = () => void startCall('audio');
    if ($('#videoCallButton')) $('#videoCallButton').onclick = () => void startCall('video');
    if ($('#endCallButton')) $('#endCallButton').onclick = () => endCall(true);
    if ($('#muteCallButton')) $('#muteCallButton').onclick = toggleMute;
    if ($('#cameraCallButton')) $('#cameraCallButton').onclick = () => void toggleCamera();
    if ($('#flipCameraButton')) $('#flipCameraButton').onclick = () => void flipCamera();
    if ($('#speakerCallButton')) $('#speakerCallButton').onclick = toggleCallSpeaker;
    if ($('#minimizeCallButton')) $('#minimizeCallButton').onclick = () => { if (peerConnection) showCallUi(false); };
    if ($('#callFloatingButton')) $('#callFloatingButton').onclick = () => showCallUi(true);
    if (socket && !socket.__fbCallHandlers) {
      socket.__fbCallHandlers = true;
      socket.on('call:incoming', incomingCallDialog);
      socket.on('call:signal', data => {
        if (!peerConnection) {
          if (incomingCall && data.from === incomingCall.from) {
            if (data.signal?.description) incomingCall.description = data.signal.description;
            if (data.signal?.candidate) (incomingCall.candidates ||= []).push(data.signal.candidate);
          } else if (data.from && data.signal) {
            const queued = pendingCallSignals.get(data.from) || []; queued.push(data.signal);
            pendingCallSignals.set(data.from, queued.slice(-64));
          }
          return;
        }
        void handleCallSignal(data);
      });
      socket.on('call:accepted', () => { stopCallTone(); callStatus('Connecting…'); });
      socket.on('call:ringing', () => callStatus('Ringing…'));
      socket.on('call:ended', data => {
        if (data.from === currentCallPeer || data.from === incomingCall?.from) {
          endCall(false, callConnectedAt ? 'completed' : (callDirection === 'incoming' ? 'missed' : 'cancelled'));
          toast('Call ended.');
        }
      });
      socket.on('call:error', data => { stopCallTone(); callStatus(data.message || 'Call failed'); toast(data.message || 'Call failed'); });
    }
  }

  async function sendMessage(event) {
    event.preventDefault();
    if (!activePeer || !profile) return;
    const input = $('#messageInput'), text = input.value.trim(), file = $('#mediaInput')?.files?.[0] || null;
    if (!text && !file) return;
    if (text.length > 4000) { toast('Message is too long.'); return; }
    if (file && file.size > 24000) { toast('Encrypted attachments are currently limited to 24 KB per file.'); return; }
    if (!socket?.connected || !connected) { toast('Reconnecting. The message was not sent.'); return; }
    if (changedFingerprint) { toast('Verify the contact fingerprint before sending.'); return; }
    $('#sendBtn').disabled = true;
    try {
      const reply = replyTarget ? { id: replyTarget.id, author: replyTarget.author, text: replyTarget.text } : null;
      let media = null;
      if (file) {
        const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result || '')); reader.onerror = () => reject(new Error('Could not read this file.')); reader.readAsDataURL(file); });
        if (!/^data:(image|video|audio)\//.test(data)) throw new Error('Only image, video and audio files are supported.');
        media = { name: file.name.slice(0, 120), mime: file.type, data };
      }
      const encrypted = await encryptText(JSON.stringify({ version: 1, text, reply, media }), activePeer);
      await new Promise((resolve, reject) => {
        socket.timeout(12000).emit('chat:send', Object.assign({ to: activePeer.username }, encrypted), (timeout, ack) => {
          if (timeout) return reject(new Error('No server acknowledgement. Please retry.'));
          if (ack?.error) return reject(new Error(ack.error));
          if (!ack?.message?.id) return reject(new Error('The server did not confirm saving this message.'));
          const saved = Object.assign({}, ack.message, { plaintext: text, reply, media });
          const history = histories.get(activePeer.id) || []; history.push(saved); histories.set(activePeer.id, history);
          addChat(activePeer, Object.assign({}, saved, { preview: text })); renderHistory(activePeer.id);
          input.value = ''; input.style.height = '24px'; if ($('#mediaInput')) $('#mediaInput').value = '';
          replyTarget = null; $('#replyBar').hidden = true; $('#replyText').textContent = '';
          $('#emojiPicker').hidden = true;
          if (ack.delivered) toast('Message sent securely.', 1200); resolve();
        });
      });
    } catch (error) { toast(error.message || 'Could not send the message.'); }
    finally { $('#sendBtn').disabled = false; input.focus(); }
  }
  async function signOut() {
    await unregisterNativePushToken();
    try {
      if (session?.access_token && config?.configured) await fetch(config.supabaseUrl + '/auth/v1/logout', {
        method: 'POST', headers: { apikey: config.supabaseAnonKey, Authorization: 'Bearer ' + session.access_token }
      });
    } catch {}
    clearSession(); renderChats(); $('#genericModal').hidden = true; $('#authOverlay').classList.add('show');
    setAuthMode('login', 'Signed out successfully.');
  }
  function updateProfileAvatarPreview() {
    const target = $('#profileAvatarPreview');
    target.replaceChildren();
    if (draftAvatarUrl) {
      const image = document.createElement('img'); image.src = draftAvatarUrl; image.alt = 'Profile photo preview';
      target.appendChild(image);
    } else target.textContent = nameOf(profile).slice(0, 1).toUpperCase();
  }
  function closeProfileDialog() { $('#profileModal').hidden = true; }
  async function profileDialog() {
    if (!me || !profile) return;
    draftAvatarUrl = profile.avatar_url || null; profileAvatarDirty = false;
    $('#profileNameInput').value = profile.display_name || '';
    $('#profileUsernameInput').value = profile.username || '';
    $('#profileBioInput').value = profile.bio || '';
    $('#profileBioCount').textContent = String($('#profileBioInput').value.length);
    $('#profileEmailLabel').textContent = me.email || '';
    $('#profileSaveError').textContent = '';
    $('#profileSaveButton').disabled = false;
    $('#profileSaveButton').textContent = 'Save changes';
    updateProfileAvatarPreview();
    $('#genericModal').hidden = true;
    $('#profileModal').hidden = false;
    $('#profileNameInput').focus();
  }
  async function resizeProfilePhoto(file) {
    if (!file || !/^image\/(?:jpeg|png|webp)$/i.test(file.type)) throw new Error('Choose a JPG, PNG or WebP image.');
    if (file.size > 10 * 1024 * 1024) throw new Error('Choose a photo smaller than 10 MB.');
    const source = await new Promise((resolve, reject) => {
      const image = new Image(), url = URL.createObjectURL(file);
      image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not open that image.')); };
      image.src = url;
    });
    const side = 512, canvas = document.createElement('canvas');
    canvas.width = side; canvas.height = side;
    const context = canvas.getContext('2d', { alpha: false });
    const crop = Math.min(source.naturalWidth, source.naturalHeight);
    const sx = (source.naturalWidth - crop) / 2, sy = (source.naturalHeight - crop) / 2;
    context.drawImage(source, sx, sy, crop, crop, 0, 0, side, side);
    for (const quality of [0.82, 0.68, 0.54, 0.42]) {
      const value = canvas.toDataURL('image/jpeg', quality);
      if (value.length <= 88_000) return value;
    }
    throw new Error('That photo is too detailed to compress. Try another image.');
  }
  async function saveProfile(event) {
    event.preventDefault();
    if (!me || !profile) return;
    const username = norm($('#profileUsernameInput').value);
    const displayName = $('#profileNameInput').value.trim();
    const bio = $('#profileBioInput').value.trim();
    if (!USER_RE.test(username)) { $('#profileSaveError').textContent = 'Username must be 3–24 letters, numbers, dots or underscores.'; return; }
    if (displayName.length < 2 || displayName.length > 40 || /[<>]/.test(displayName)) { $('#profileSaveError').textContent = 'Display name must be 2–40 characters.'; return; }
    $('#profileSaveButton').disabled = true; $('#profileSaveButton').textContent = 'Saving…'; $('#profileSaveError').textContent = '';
    try {
      const avatar = profileAvatarDirty ? draftAvatarUrl : (profile.avatar_url || null);
      const data = await api('/api/profile', {
        method: 'POST',
        body: JSON.stringify({ username, display_name: displayName, bio, avatar_url: avatar })
      });
      profile = Object.assign({}, profile, data.profile);
      $('#profileButton').title = nameOf(profile) + ' · profile';
      if (socket?.connected) socket.emit('profile:refresh');
      if (activePeer) {
        const newer = chats.get(activePeer.id);
        if (newer) { newer.peer = activePeer; chats.set(activePeer.id, newer); }
      }
      renderChats(); updateProfileAvatarPreview(); closeProfileDialog();
      toast('Profile updated successfully.');
    } catch (error) {
      $('#profileSaveError').textContent = error.message || 'Could not save profile. Try again.';
    } finally {
      $('#profileSaveButton').disabled = false; $('#profileSaveButton').textContent = 'Save changes';
    }
  }
  const CALL_PERMISSION_PROMPT_KEY = 'fbchat-call-permission-prompt-v1';
  const LEGACY_ANDROID_UPDATE_URL = 'https://github.com/codingbotlab/fb-chat-app/releases/latest/download/FBChat-latest.apk';
  const LEGACY_UPDATE_DISMISSED_KEY = 'fbchat-legacy-update-dismissed-v1';
  function showLegacyAndroidUpdateDialog() {
    if (!window.FBChatNative || typeof window.FBChatNative.checkForAppUpdate === 'function') return;
    if ($('#genericModal') && !$('#genericModal').hidden) {
      toast('A new Android app version is ready. Open Settings to download it.', 5000);
      return;
    }
    infoModal('One-time Android update required',
      'This older installation was signed with a previous key that is no longer available, so Android cannot update it in place. Download the new APK, then uninstall this old copy and install the download. Sign in again with your existing account password. Server chat history may be recoverable through the encrypted key backup; device-only drafts and settings may be lost. After this one-time migration, future versions will show an update prompt inside FB Chat.',
      [
        { label: 'Download latest APK', className: 'primary', action: () => {
          localStorage.setItem(LEGACY_UPDATE_DISMISSED_KEY, 'downloaded');
          $('#genericModal').hidden = true;
          window.location.href = LEGACY_ANDROID_UPDATE_URL;
        }},
        { label: 'Later', action: () => {
          localStorage.setItem(LEGACY_UPDATE_DISMISSED_KEY, 'dismissed');
          $('#genericModal').hidden = true;
        }}
      ]);
  }
  function callPermissionToggleKey(kind) { return 'fbchat-call-' + kind + '-enabled'; }
  async function getMediaPermissionStatus(kind) {
    if (window.FBChatNative && typeof window.FBChatNative.getCallPermissionStatus === 'function') {
      try { const status = JSON.parse(window.FBChatNative.getCallPermissionStatus() || '{}'); return status[kind] ? 'granted' : 'not-granted'; } catch {}
    }
    try {
      if (navigator.permissions?.query) {
        const result = await navigator.permissions.query({ name: kind === 'microphone' ? 'microphone' : 'camera' });
        return result.state || 'prompt';
      }
    } catch {}
    return 'prompt';
  }
  function permissionStatusText(kind, state) {
    if (localStorage.getItem(callPermissionToggleKey(kind)) === 'off') return 'Disabled inside FB Chat.';
    if (state === 'granted') return 'Device permission: allowed.';
    if (state === 'denied') return 'Permission denied. Check browser or device settings.';
    if (state === 'not-granted') return 'Device permission not granted yet; turn on to request it.';
    return 'Not requested yet; turn on to ask for permission.';
  }
  async function requestMediaPermission(kind) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera/microphone access is unavailable here. Update the app or open the HTTPS website in Chrome.');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: kind === 'microphone', video: kind === 'camera' });
    stream.getTracks().forEach(track => track.stop());
    return true;
  }
  async function showCallPermissionPrompt() {
    if (!me || localStorage.getItem(CALL_PERMISSION_PROMPT_KEY) === 'done') return;
    const [mic, cam] = await Promise.all([getMediaPermissionStatus('microphone'), getMediaPermissionStatus('camera')]);
    if (mic === 'granted' && cam === 'granted') {
      localStorage.setItem(CALL_PERMISSION_PROMPT_KEY, 'done');
      if (localStorage.getItem(callPermissionToggleKey('microphone')) == null) localStorage.setItem(callPermissionToggleKey('microphone'), 'on');
      if (localStorage.getItem(callPermissionToggleKey('camera')) == null) localStorage.setItem(callPermissionToggleKey('camera'), 'on');
      return;
    }
    infoModal('Voice & video calls are here', 'Allow microphone access for voice calls and camera access for video calls. Android will ask for device permission when needed. You can change these controls later in Settings.',
      [
        { label: 'Enable microphone & camera', className: 'primary', action: async () => {
          $('#genericModal').hidden = true;
          localStorage.setItem(CALL_PERMISSION_PROMPT_KEY, 'done');
          try {
            if (!navigator.mediaDevices?.getUserMedia) throw new Error('Media permission is not available in this app version.');
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
            stream.getTracks().forEach(track => track.stop());
            localStorage.setItem(callPermissionToggleKey('microphone'), 'on');
            localStorage.setItem(callPermissionToggleKey('camera'), 'on');
            toast('Microphone and camera are ready for calls.', 4000);
          } catch (error) {
            toast(error?.name === 'NotAllowedError' ? 'Permission was declined. Open Settings and enable microphone/camera access to try again.' : (error?.message || 'Could not enable call permissions.'), 5500);
          }
        }},
        { label: 'Not now', action: () => {
          localStorage.setItem(CALL_PERMISSION_PROMPT_KEY, 'done');
          $('#genericModal').hidden = true;
        }}
      ]);
  }

  async function settingsDialog() {
    const nativeApp = Boolean(window.FBChatNative);
    const soundOn = localStorage.getItem('fbchat-message-sound') !== 'off';
    const pushOn = localStorage.getItem('fbchat-push-enabled') === 'on';
    const registered = Boolean(me && localStorage.getItem('fbchat-fcm-registered-' + me.id));
    const [micState, cameraState] = await Promise.all([getMediaPermissionStatus('microphone'), getMediaPermissionStatus('camera')]);
    const permissionToggle = (kind, label, state) => {
      const saved = localStorage.getItem(callPermissionToggleKey(kind));
      return {
        type: 'toggle', label,
        detail: 'Controls whether FB Chat may use this device feature for calls.',
        status: permissionStatusText(kind, state),
        checked: saved === 'on' || (saved == null && state === 'granted'),
        action: async (enabled) => {
          if (!enabled) {
            localStorage.setItem(callPermissionToggleKey(kind), 'off');
            return { checked: false, status: 'Disabled inside FB Chat. System permission is unchanged.' };
          }
          try {
            await requestMediaPermission(kind);
            localStorage.setItem(callPermissionToggleKey(kind), 'on');
            return { checked: true, status: 'Device permission allowed.' };
          } catch (error) {
            localStorage.setItem(callPermissionToggleKey(kind), 'off');
            const latest = await getMediaPermissionStatus(kind);
            const status = latest === 'denied' || latest === 'not-granted'
              ? 'Not allowed. Use device/browser settings if the system prompt no longer appears.'
              : (error?.message || 'Permission was not granted.');
            return { checked: false, status };
          }
        }
      };
    };
    const actions = [
      permissionToggle('microphone', 'Microphone for voice calls', micState),
      permissionToggle('camera', 'Camera for video calls', cameraState),
      {
        label: soundOn ? 'Turn message sound off' : 'Turn message sound on',
        action: () => {
          localStorage.setItem('fbchat-message-sound', soundOn ? 'off' : 'on');
          $('#genericModal').hidden = true;
          toast(soundOn ? 'Message sound turned off.' : 'Message sound turned on.');
        }
      },
      {
        label: nativeApp
          ? (registered ? 'Refresh Android notifications' : 'Enable Android notifications')
          : (pushOn ? 'Turn off push notifications' : 'Enable push notifications'),
        action: async () => {
          $('#genericModal').hidden = true;
          if (nativeApp) {
            try {
              window.FBChatNative.requestNotificationPermission();
              window.FBChatNative.refreshToken();
              await syncNativePushToken();
              toast('Android notification setup requested. Allow notifications in Android settings.', 5000);
            } catch {
              toast('Open Android app settings and allow notifications.', 5000);
            }
          } else if (pushOn) await disablePushNotifications();
          else await enablePushNotifications();
        }
      },
      ...(nativeApp ? [{
        label: typeof window.FBChatNative.checkForAppUpdate === 'function' ? 'Check for app updates' : 'Download latest Android app',
        action: () => {
          if (typeof window.FBChatNative.checkForAppUpdate !== 'function') {
            showLegacyAndroidUpdateDialog();
            return;
          }
          $('#genericModal').hidden = true;
          nativeUpdateCheckManual = true;
          try {
            if (typeof window.FBChatNative.checkForAppUpdateNow === 'function') {
              window.FBChatNative.checkForAppUpdateNow();
            } else {
              // Older APKs do not expose the forced-check bridge yet.
              window.FBChatNative.checkForAppUpdate();
            }
          } catch { nativeUpdateCheckManual = false; toast('Could not check for updates. Connect to the internet and retry.'); }
        }
      }, { label: 'Open Android app permissions', action: () => {
        try { window.FBChatNative.openAppSettings(); }
        catch { toast('Open Android Settings → Apps → FB Chat → Permissions.', 5000); }
      }}] : []),
      { label: 'Privacy & encryption details', action: () => { $('#genericModal').hidden = true; void securityDialog(); } },
      { label: 'Close', action: () => { $('#genericModal').hidden = true; } }
    ];
    const description = nativeApp
      ? 'Use the switches below to enable or disable camera and microphone inside FB Chat. Android still controls device-level permissions; use Open Android app permissions to revoke them completely.'
      : 'Use the switches below to allow camera and microphone inside FB Chat. Your browser controls site-level permission; to revoke it completely, open this site’s permissions in the browser.';
    infoModal('Settings & permissions', description, actions);
  }
  async function securityDialog() {
    if (!activePeer) {
      infoModal('Privacy & security', 'Messages are encrypted in this browser using ECDH P-256 and AES-GCM. The database stores ciphertext. This prototype has not had an independent security audit.',
        [{ label: 'Close', action: () => { $('#genericModal').hidden = true; } }]);
      return;
    }
    const fp = await fingerprint(activePeer.public_key), changed = $('#chatDetails').dataset.keyChanged === 'true';
    const description = nameOf(activePeer) + ' (@' + activePeer.username + ')\n\nPublic key fingerprint:\n' +
      prettyFingerprint(fp) + '\n\nCompare this fingerprint with the other person via another trusted channel. First-contact pinning alone does not prove the contact’s identity.';
    const actions = [];
    if (changed) actions.push({
      label: 'I verified this new fingerprint',
      className: 'danger-action',
      action: async () => {
        if (await fingerprint(activePeer.public_key) !== changedFingerprint) return toast('The key changed again. Reopen security details.');
        localStorage.setItem('fbchat-peer-pin-' + activePeer.id, changedFingerprint);
        changedFingerprint = null; $('#chatDetails').dataset.keyChanged = 'false'; $('#genericModal').hidden = true; await openChat(activePeer);
      }
    });
    actions.push({ label: 'Close', action: () => { $('#genericModal').hidden = true; } });
    infoModal('Encryption & fingerprint', description, actions);
  }
  function bindUi() {
    $('#authForm').addEventListener('submit', submitAuth);
    enableMediaControls();
    $('#loginTab').addEventListener('click', () => setAuthMode('login'));
    $('#signupTab').addEventListener('click', () => setAuthMode('signup'));
    $('#newChat').addEventListener('click', showNewChat);
    $('#emptyNewChat').addEventListener('click', showNewChat);
    $('#welcomeNewChat').addEventListener('click', showNewChat);
    $('#genericForm').addEventListener('submit', findUser);
    $('#genericCancel').addEventListener('click', () => { $('#genericModal').hidden = true; });
    $('#genericModal').addEventListener('click', (event) => { if (event.target === $('#genericModal')) $('#genericModal').hidden = true; });
    $('#chatSearch').addEventListener('input', renderChats);
    $$('[data-filter]').forEach((button) => button.addEventListener('click', () => {
      $$('[data-filter]').forEach((item) => item.classList.toggle('active', item === button)); renderChats();
    }));
    $('#backToChats').addEventListener('click', () => { chatOpenRequest++; $('#app').classList.remove('chat-open'); });
    $('#composeForm').addEventListener('submit', sendMessage);
    $('#attachMediaButton')?.addEventListener('click', () => $('#mediaInput')?.click());
    $('#mediaInput')?.addEventListener('change', () => {
      const file = $('#mediaInput').files?.[0];
      if (file) toast('Selected ' + file.name + '. Send it with the message button; files are encrypted before upload.');
    });
    $('#messageInput').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('#composeForm').requestSubmit(); }
    });
    $('#messageInput').addEventListener('input', () => {
      const input = $('#messageInput'); input.style.height = '24px'; input.style.height = Math.min(input.scrollHeight, 120) + 'px';
      if (socket?.connected && activePeer) {
        socket.emit('chat:typing', { to: activePeer.username, active: Boolean(input.value.trim()) });
        clearTimeout(typingTimer);
        typingTimer = setTimeout(() => { if (socket?.connected && activePeer) socket.emit('chat:typing', { to: activePeer.username, active: false }); }, 900);
      }
    });
    $('#emojiBtn').addEventListener('click', () => {
      $('#emojiPicker').hidden = !$('#emojiPicker').hidden;
    });
    $$('.emoji-choice').forEach((button) => button.addEventListener('click', () => {
      const input = $('#messageInput');
      const start = input.selectionStart ?? input.value.length, end = input.selectionEnd ?? input.value.length;
      input.setRangeText(button.dataset.emoji, start, end, 'end');
      input.focus(); input.dispatchEvent(new Event('input'));
      $('#emojiPicker').hidden = true;
    }));
    $('#cancelReply').addEventListener('click', () => {
      replyTarget = null; $('#replyBar').hidden = true; $('#replyText').textContent = ''; $('#messageInput').focus();
    });
    $('#searchInChat').addEventListener('click', () => {
      if (!activePeer) return;
      const term = prompt('Search loaded messages'); if (!term) return;
      const original = histories.get(activePeer.id) || [];
      const filtered = original.filter((message) => String(message.plaintext || '').toLowerCase().includes(term.toLowerCase()));
      histories.set(activePeer.id, filtered); renderHistory(activePeer.id); histories.set(activePeer.id, original);
      if (!filtered.length) toast('No matching messages in loaded history.');
    });
    $('#chatDetails').addEventListener('click', securityDialog);
    $('#profileButton').addEventListener('click', profileDialog);
    $('#settingsButton').addEventListener('click', settingsDialog);
    $('#mobileSettingsButton').addEventListener('click', settingsDialog);
    const bottomNavItems = $$('[data-bottom-nav]');
    const showMainSection = (section) => {
      bottomNavItems.forEach((item) => {
        const active = item.dataset.bottomNav === section;
        item.classList.toggle('active', active);
        if (active) item.setAttribute('aria-current', 'page');
        else item.removeAttribute('aria-current');
      });
      $$('[data-rail]').forEach((item) => item.classList.toggle('active', item.dataset.rail === section));
      if (section === 'chats') {
        $('#app').classList.remove('chat-open');
        return;
      }
      $('#app').classList.remove('chat-open');
      const screens = {
        updates: ['Updates', 'Status updates and channels will appear here. Status sharing is not available yet.'],
        communities: ['Communities', 'Your community announcements and group conversations will appear here. Communities are not available yet.']
      };
      if (section === 'calls') { showCallHistory(); return; }
      const screen = screens[section];
      if (screen) infoModal(screen[0], screen[1], [{ label: 'Close', action: () => { $('#genericModal').hidden = true; } }]);
    };
    bottomNavItems.forEach((button) => button.addEventListener('click', () => showMainSection(button.dataset.bottomNav)));
    $$('[data-rail]').forEach((button) => button.addEventListener('click', () => showMainSection(button.dataset.rail)));
  }
  async function initialize() {
    bindUi(); $('#authOverlay').classList.add('show'); setAuthMode('login');
    try { config = await fetch('/api/config', { cache: 'no-store' }).then((r) => r.json()); }
    catch { config = { configured: false }; }
    if (!config.configured) {
      showAuth('The site is deployed, but its free authentication/database keys are not connected yet. Sign-in is disabled until setup is complete.', true);
      $('#authSubmit').disabled = true; renderChats(); return;
    }
    $('#authSubmit').disabled = false;
    try { session = JSON.parse(localStorage.getItem('fbchat-session') || 'null'); } catch { session = null; }
    if (session?.access_token && session?.refresh_token) {
      try { await applySession(''); }
      catch (error) { const msg = error.message || 'Please sign in again.'; clearSession(); showAuth(msg, true); }
    } else showAuth();
    renderChats();
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'FBCHAT_PUSH') {
        if (event.data.username) toast('New encrypted message from @' + event.data.username, 2800);
      }
      if (event.data?.type === 'FBCHAT_OPEN_CHAT' && event.data.username) {
        void openChatByUsername(event.data.username);
      }
    });
  }
  let nativeUpdateCheckManual = false;
  window.fbchatOnNativeUpdateCheck = (result) => {
    if (result?.error) {
      if (nativeUpdateCheckManual) toast('Could not check for app updates. Connect to the internet and try again.', 4500);
      nativeUpdateCheckManual = false;
      return;
    }
    if (!result?.updateAvailable) {
      if (nativeUpdateCheckManual) toast('FB Chat is up to date' + (result?.currentVersion ? ' (v' + result.currentVersion + ')' : '') + '.', 3500);
      nativeUpdateCheckManual = false;
      return;
    }
    if (!nativeUpdateCheckManual && $('#genericModal') && !$('#genericModal').hidden) {
      toast('FB Chat v' + result.latestVersion + ' is available. Open Settings → Check for app updates.', 5500);
      return;
    }
    nativeUpdateCheckManual = false;
    infoModal('Update available', 'FB Chat v' + result.latestVersion + ' is ready to install. Download it now; Android will ask you to confirm the installation. Your account messages stay on the server, but always keep your sign-in password handy.',
      [
        { label: 'Download & install', className: 'primary', action: () => {
          $('#genericModal').hidden = true;
          try { window.FBChatNative.installAppUpdate(result.downloadUrl); }
          catch { toast('Could not start the updater. Please retry from Settings.', 4500); }
        }},
        { label: 'Later', action: () => { $('#genericModal').hidden = true; } }
      ]);
  };
  window.fbchatOnFcmToken = acceptNativeFcmToken;
  window.fbchatOpenNativeChat = (username) => { void openChatByUsername(username); };
  window.fbchatOpenNativeCall = (username, kind) => {
    const open = () => incomingCallDialog({ from: String(username || '').toLowerCase(), displayName: String(username || ''), kind: kind === 'video' ? 'video' : 'audio' });
    if (socket?.connected) open();
    else if (socket) socket.once('connect', open);
    else {
      const url = new URL(location.href);
      url.searchParams.set('openCall', String(username || '').toLowerCase());
      url.searchParams.set('callKind', kind === 'video' ? 'video' : 'audio');
      location.href = url.toString();
    }
  };
  initialize().catch((error) => { console.error('FB Chat initialization failed:', error); showAuth(error.message || 'Could not initialize. Reload the page.', true); });
})();
