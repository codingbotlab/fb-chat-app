'use strict';
const CACHE_NAME = 'fb-chat-shell-v19';
const APP_SHELL = [
  '/',
  '/manifest.webmanifest',
  '/styles.css?v=wa-profile-fullscreen-4',
  '/app.js',
  '/pwa.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-512-maskable.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith('fb-chat-shell-') && key !== CACHE_NAME)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let payload = {};
    try { payload = event.data ? event.data.json() : {}; } catch {}
    const openClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const foreground = openClients.some((client) => client.visibilityState === 'visible' && client.focused);
    if (foreground) {
      for (const client of openClients) {
        if (client.visibilityState === 'visible') {
          client.postMessage({ type: 'FBCHAT_PUSH', username: payload.username || '' });
        }
      }
      return;
    }
    await self.registration.showNotification(payload.title || 'FB Chat', {
      body: payload.body || 'You have a new encrypted message',
      icon: payload.icon || '/icons/icon-192.png',
      badge: payload.badge || '/icons/icon-192.png',
      tag: payload.tag || ('fb-chat-' + (payload.username || 'message')),
      renotify: true,
      silent: false,
      vibrate: [140, 70, 140],
      timestamp: Date.now(),
      data: { username: payload.username || '', url: payload.url || '/' }
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const username = String(data.username || '');
  const target = new URL('/?openChat=' + encodeURIComponent(username), self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if ('focus' in client) {
        await client.focus();
        client.postMessage({ type: 'FBCHAT_OPEN_CHAT', username });
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Never cache auth, API responses, or the Socket.IO transport/library.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/') ||
      url.pathname === '/admin-chat' || url.pathname.startsWith('/admin-chat/')) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const response = await fetch(request, { cache: 'no-store' });
      if (response && response.ok && response.type === 'basic') {
        await cache.put(request, response.clone());
      }
      return response;
    } catch (error) {
      const cached = await cache.match(request);
      if (cached) return cached;
      if (request.mode === 'navigate') {
        return (await cache.match('/')) || Response.error();
      }
      throw error;
    }
  })());
});