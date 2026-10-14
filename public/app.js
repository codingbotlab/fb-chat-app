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
        return { plaintext: value.text, reply: value.reply && typeof value.reply.text === 'string' ? value.reply : null };
      }
    } catch {}
    return { plaintext: String(raw || ''), reply: null };
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
      avatar.className = 'chatavatar'; avatar.textContent = nameOf(person).slice(0, 1).toUpperCase();
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
      const body = document.createElement('div'); body.className = 'bubble-text'; body.textContent = message.plaintext || '';
      bubble.appendChild(body);
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
    activePeer = person; changedFingerprint = null; unread.set(person.id, 0);
    $('#welcome').hidden = true; $('#convHead').hidden = false; $('#messages').hidden = false; $('#composerWrap').hidden = false;
    $('#activeName').textContent = nameOf(person); $('#activeAvatar').textContent = nameOf(person).slice(0, 1).toUpperCase();
    $('#activeStatus').textContent = connected ? (online(person.id) ? 'online' : 'end-to-end encrypted') : 'Connecting…';
    $('#app').classList.add('chat-open'); renderChats();
    try {
      const trust = await checkPeerKey(person);
      if (!trust.trusted) {
        changedFingerprint = trust.fingerprint; $('#chatDetails').dataset.keyChanged = 'true'; $('#composerWrap').hidden = true;
        $('#activeStatus').textContent = 'Security warning · key changed'; $('#messages').replaceChildren();
        const warning = document.createElement('div'); warning.className = 'systemnote warning';
        warning.textContent = 'This contact’s public key changed. Verify the fingerprint via another trusted channel before accepting it.';
        $('#messages').appendChild(warning); toast('Contact key changed. Sending is blocked until verification.', 6000); return;
      }
      $('#chatDetails').dataset.keyChanged = 'false';
      const data = await api('/api/chats/' + encodeURIComponent(person.username) + '/messages');
      addChat(data.peer);
      const history = [];
      for (const message of data.messages || []) {
        const decoded = decodeMessageContent(await decryptText(message, person));
        history.push(Object.assign({}, message, decoded));
      }
      histories.set(person.id, history);
      const last = history[history.length - 1], entry = chats.get(person.id);
      if (entry && last) entry.lastMessage = Object.assign({}, last, { preview: last.plaintext || '🔒 Encrypted message' });
      renderHistory(person.id); renderChats();
      if (socket?.connected) { socket.emit('chat:open', { peer: person.username }); socket.emit('chat:read', { peer: person.username }); }
    } catch (error) { toast(error.message || 'Could not load this conversation.'); }
  }
  async function loadChats() {
    const data = await api('/api/chats'); chats = new Map();
    for (const item of data.chats || []) addChat(item.peer, Object.assign({}, item.last_message, { preview: '🔒 Encrypted message' }));
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
    }
    handleQueuedNotificationChat();
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
  async function sendMessage(event) {
    event.preventDefault();
    if (!activePeer || !profile) return;
    const input = $('#messageInput'), text = input.value.trim();
    if (!text) return;
    if (text.length > 4000) { toast('Message is too long.'); return; }
    if (!socket?.connected || !connected) { toast('Reconnecting. The message was not sent.'); return; }
    if (changedFingerprint) { toast('Verify the contact fingerprint before sending.'); return; }
    $('#sendBtn').disabled = true;
    try {
      const reply = replyTarget ? { id: replyTarget.id, author: replyTarget.author, text: replyTarget.text } : null;
      const encrypted = await encryptText(JSON.stringify({ version: 1, text, reply }), activePeer);
      await new Promise((resolve, reject) => {
        socket.timeout(12000).emit('chat:send', Object.assign({ to: activePeer.username }, encrypted), (timeout, ack) => {
          if (timeout) return reject(new Error('No server acknowledgement. Please retry.'));
          if (ack?.error) return reject(new Error(ack.error));
          if (!ack?.message?.id) return reject(new Error('The server did not confirm saving this message.'));
          const saved = Object.assign({}, ack.message, { plaintext: text, reply });
          const history = histories.get(activePeer.id) || []; history.push(saved); histories.set(activePeer.id, history);
          addChat(activePeer, Object.assign({}, saved, { preview: text })); renderHistory(activePeer.id);
          input.value = ''; input.style.height = '24px';
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
  async function profileDialog() {
    if (!me || !profile) return;
    infoModal('Your account', nameOf(profile) + '\n@' + profile.username + '\n' + (me.email || ''),
      [{ label: 'Sign out', className: 'danger-action', action: signOut },
       { label: 'Close', action: () => { $('#genericModal').hidden = true; } }]);
  }
  async function settingsDialog() {
    const nativeApp = Boolean(window.FBChatNative);
    const soundOn = localStorage.getItem('fbchat-message-sound') !== 'off';
    const pushOn = localStorage.getItem('fbchat-push-enabled') === 'on';
    const registered = Boolean(me && localStorage.getItem('fbchat-fcm-registered-' + me.id));
    const actions = [
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
      { label: 'Privacy & encryption details', action: () => { $('#genericModal').hidden = true; void securityDialog(); } },
      { label: 'Close', action: () => { $('#genericModal').hidden = true; } }
    ];
    const description = nativeApp
      ? 'FB Chat will register this Android device for background alerts. Android controls notification permission, sound, and vibration. Message text is not included in push payloads.'
      : 'Message sound plays while this app is open. Background push requires browser notification permission and server push keys. Your message text is never included in push notifications.';
    infoModal('Settings', description, actions);
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
    $('#backToChats').addEventListener('click', () => $('#app').classList.remove('chat-open'));
    $('#composeForm').addEventListener('submit', sendMessage);
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
    const bottomNavItems = $('[data-bottom-nav]');
    const showMainSection = (section) => {
      bottomNavItems.forEach((item) => {
        const active = item.dataset.bottomNav === section;
        item.classList.toggle('active', active);
        if (active) item.setAttribute('aria-current', 'page');
        else item.removeAttribute('aria-current');
      });
      $('[data-rail]').forEach((item) => item.classList.toggle('active', item.dataset.rail === section));
      if (section === 'chats') {
        $('#app').classList.remove('chat-open');
        return;
      }
      $('#app').classList.remove('chat-open');
      const screens = {
        updates: ['Updates', 'Status updates and channels will appear here. Status sharing is not available yet.'],
        communities: ['Communities', 'Your community announcements and group conversations will appear here. Communities are not available yet.'],
        calls: ['Calls', 'Voice and video calling is not available yet. Your future calls will appear here.']
      };
      const screen = screens[section];
      if (screen) infoModal(screen[0], screen[1], [{ label: 'Close', action: () => { $('#genericModal').hidden = true; } }]);
    };
    bottomNavItems.forEach((button) => button.addEventListener('click', () => showMainSection(button.dataset.bottomNav)));
    $('[data-rail]').forEach((button) => button.addEventListener('click', () => showMainSection(button.dataset.rail)));
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
  window.fbchatOnFcmToken = acceptNativeFcmToken;
  window.fbchatOpenNativeChat = (username) => { void openChatByUsername(username); };
  initialize().catch((error) => { console.error('FB Chat initialization failed:', error); showAuth(error.message || 'Could not initialize. Reload the page.', true); });
})();
