'use strict';

const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e6,
  pingTimeout: 20000,
  pingInterval: 25000
});

const PORT = Number(process.env.PORT) || 3000;
const MAX_NAME = 32;
const MAX_MESSAGE = 4000;
const MAX_HISTORY = 500;
const online = new Map();
const displayNames = new Map();
const conversations = new Map();

function normalize(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}
function validName(value) {
  return typeof value === 'string' &&
    value.trim().length >= 2 &&
    value.trim().length <= MAX_NAME &&
    !/[<>]/.test(value);
}
function validMessage(value) {
  return typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= MAX_MESSAGE;
}
function pairKey(a, b) {
  return [normalize(a), normalize(b)].sort().join('|');
}
function getHistory(a, b) {
  return conversations.get(pairKey(a, b)) || [];
}
function sendPresence() {
  io.emit('presence:list', Array.from(displayNames.values()));
}

app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0
}));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'fb-chat-app',
    connectedUsers: online.size,
    uptimeSeconds: Math.round(process.uptime())
  });
});

io.on('connection', (socket) => {
  socket.on('session:join', (payload = {}) => {
    const name = payload.name;
    if (!validName(name)) {
      socket.emit('session:error', { message: 'Choose a display name between 2 and 32 characters.' });
      return;
    }

    const key = normalize(name);
    const existingId = online.get(key);
    if (existingId && existingId !== socket.id) {
      const oldSocket = io.sockets.sockets.get(existingId);
      if (oldSocket) {
        oldSocket.emit('session:error', { message: 'This display name connected in another session.' });
        oldSocket.data.key = undefined;
        oldSocket.data.displayName = undefined;
      }
      online.delete(key);
    }

    socket.data.displayName = name.trim();
    socket.data.key = key;
    online.set(key, socket.id);
    displayNames.set(key, name.trim());
    socket.emit('session:ready', {
      user: name.trim(),
      onlineUsers: Array.from(displayNames.values())
    });
    sendPresence();
  });

  socket.on('chat:open', (payload = {}) => {
    const from = socket.data.displayName;
    const peer = typeof payload.peer === 'string' ? payload.peer.trim() : '';
    if (!from || !validName(peer) || normalize(from) === normalize(peer)) return;
    socket.emit('chat:history', {
      peer,
      messages: getHistory(from, peer),
      online: online.has(normalize(peer))
    });
  });

  socket.on('chat:send', (payload = {}, ack = () => {}) => {
    const from = socket.data.displayName;
    const to = typeof payload.to === 'string' ? payload.to.trim() : '';
    const text = payload.text;

    if (!from) return ack({ error: 'Choose your display name first.' });
    if (!validName(to) || normalize(from) === normalize(to)) return ack({ error: 'Choose a valid recipient.' });
    if (!validMessage(text)) return ack({ error: 'Message must be between 1 and 4000 characters.' });

    const key = pairKey(from, to);
    const history = conversations.get(key) || [];
    const message = {
      id: String(Date.now()) + '-' + Math.random().toString(36).slice(2, 9),
      from,
      to,
      text: text.trim(),
      time: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
    };

    history.push(message);
    if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
    conversations.set(key, history);

    ack({ message, delivered: online.has(normalize(to)) });
    const recipientId = online.get(normalize(to));
    if (recipientId) io.to(recipientId).emit('chat:message', message);
  });

  socket.on('chat:typing', (payload = {}) => {
    const from = socket.data.displayName;
    const to = typeof payload.to === 'string' ? payload.to.trim() : '';
    if (!from || !validName(to) || normalize(from) === normalize(to)) return;
    const recipientId = online.get(normalize(to));
    if (recipientId) io.to(recipientId).emit('chat:typing', {
      from,
      active: Boolean(payload.active)
    });
  });

  socket.on('disconnect', () => {
    const key = socket.data.key;
    if (key && online.get(key) === socket.id) {
      online.delete(key);
      displayNames.delete(key);
      sendPresence();
    }
  });
});

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log('FB Chat starter listening on http://localhost:' + PORT);
  });
}

module.exports = { app, server, io, normalize, validName, validMessage, pairKey };
