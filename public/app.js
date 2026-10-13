(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const details = {
    Aarav:{name:'Aarav Sharma',initial:'A',color:'',sample:[['Aarav Sharma','Hey! How are you?','10:40 PM',false],['You','All good. What are you working on?','10:41 PM',true],['Aarav Sharma',"That sounds great! Let's do it.",'10:42 PM',false]]},
    Sana:{name:'Sana Khan',initial:'S',color:'a2',sample:[['Sana Khan','Hey, I sent you that picture.','9:56 PM',false],['You','Got it 😊','9:58 PM',true]]},
    Rohan:{name:'Rohan Verma',initial:'R',color:'a3',sample:[['Rohan Verma','Have you tried the new editor?','8:21 PM',false],['You','Not yet, will try it tonight.','8:22 PM',true],['Rohan Verma','Cool, I can share a quick walkthrough.','8:26 PM',false]]},
    'Creators Club':{name:'Creators Club',initial:'✦',color:'a4',sample:[['Neha','Shared the new draft.','7:13 PM',false]]},
    Neha:{name:'Neha Verma',initial:'N',color:'a5',sample:[['Neha Verma','Thank you 😊','Yesterday',false]]},
    Family:{name:'Family',initial:'♡',color:'',sample:[['Maa','Call me when free.','Yesterday',false]]}
  };
  let me = localStorage.getItem('fbchat-name') || '';
  let activePeer = '', activeKind = 'dm', filterMode = 'all', socket = null, connected = false;
  let onlineUsers = [], localMessages = {}, unreadCounts = {};
  function toast(msg) {
    const el = $('#toast'); el.textContent = msg; el.classList.add('show');
    clearTimeout(window.__fbtoast); window.__fbtoast = setTimeout(() => el.classList.remove('show'), 2500);
  }
  function validName(s) { return typeof s === 'string' && s.trim().length >= 2 && s.trim().length <= 32 && !/[<>]/.test(s); }
  function infoFor(peer) { return details[peer] || {name:peer,initial:(peer[0]||'?').toUpperCase(),color:'',sample:[]}; }
  function setConnected(ok) {
    connected = ok;
    $('#inboxSub').textContent = ok ? 'Connected · live messaging available' : 'Offline · reconnecting';
    $('#inboxSub').style.color = ok ? 'var(--green)' : 'var(--muted)';
    if (activePeer) $('#activeStatus').textContent = ok ? 'Connected to chat server' : 'Chat server unavailable';
  }
  function ensureChatItem(peer) {
    let node = $$('.chatitem').find(el => norm(el.dataset.peer) === norm(peer));
    if (node) return node;
    const inf = infoFor(peer), btn = document.createElement('button');
    btn.className = 'chatitem'; btn.dataset.peer = peer;
    btn.innerHTML = '<div class="chatavatar '+esc(inf.color)+'">'+esc(inf.initial)+'</div><div class="chatbody"><div class="chatrow"><strong>'+esc(inf.name)+'</strong><time>Now</time></div><div class="lastmsg">Start a conversation</div></div>';
    btn.addEventListener('click', () => openChat(peer, 'dm'));
    $('#chatList').prepend(btn); return btn;
  }
  function renderChats() {
    const q = norm($('#chatSearch').value);
    $$('.chatitem').forEach(el => {
      const peer = el.dataset.peer || '', group = el.dataset.group === 'true', last = (localMessages[peer] || []).slice(-1)[0];
      const searchText = norm(peer + ' ' + (last ? last.text : el.querySelector('.lastmsg')?.textContent || ''));
      let show = searchText.includes(q);
      if (filterMode === 'groups') show = show && group;
      if (filterMode === 'unread') show = show && Number(unreadCounts[peer] || 0) > 0;
      el.style.display = show ? 'flex' : 'none';
      if (last) {
        const msgEl = el.querySelector('.lastmsg'); if (msgEl) msgEl.textContent = (norm(last.from) === norm(me) ? 'You: ' : '') + last.text;
        const time = el.querySelector('time'); if (time) time.textContent = last.time || 'Now';
      }
      el.classList.toggle('active', peer === activePeer);
      const av = el.querySelector('.chatavatar');
      if (av && onlineUsers.some(n => norm(n) === norm(peer)) && !av.querySelector('.online-dot')) {
        const dot = document.createElement('span'); dot.className = 'online-dot'; av.appendChild(dot);
      }
      if (av && !onlineUsers.some(n => norm(n) === norm(peer))) av.querySelector('.online-dot')?.remove();
    });
  }
  function bubbleHTML(msg) {
    const mine = norm(msg.from) === norm(me);
    return '<div class="bubble '+(mine?'mine':'')+'">'+(activeKind === 'group' && !mine ? '<div class="bubble-author">'+esc(msg.from || '')+'</div>' : '')+
      esc(String(msg.text || '').replace(/\r/g,''))+'<div class="bmeta"><span>'+esc(msg.time || 'now')+'</span>'+(mine?'<span class="ticks">✓✓</span>':'')+'</div></div>';
  }
  function sampleHistory(peer) {
    const inf = infoFor(peer);
    return (inf.sample || []).map((m,i) => ({id:'sample-'+peer+'-'+i,from:m[3]?(me||'You'):m[0],text:m[1],time:m[2]}));
  }
  function renderMessages(history) {
    const list = history || localMessages[activePeer] || sampleHistory(activePeer);
    $('#messages').innerHTML = '<div class="daydivider">TODAY</div>'+list.map(bubbleHTML).join('');
    $('#messages').scrollTop = $('#messages').scrollHeight;
  }
  function openChat(peer, kind) {
    if (!peer) return;
    activePeer = peer; activeKind = kind || ((details[peer] && ['Creators Club','Family'].includes(peer)) ? 'group' : 'dm');
    if (!localMessages[peer]) localMessages[peer] = [];
    const inf = infoFor(peer);
    $('#welcome').hidden = true; $('#convHead').hidden = false; $('#messages').hidden = false; $('#composerWrap').hidden = false;
    $('#activeName').textContent = inf.name; $('#activeAvatar').textContent = inf.initial; $('#activeAvatar').className = 'chatavatar '+inf.color;
    $('#activeStatus').textContent = connected ? (onlineUsers.some(n => norm(n) === norm(peer)) ? 'online' : 'Ready to chat') : 'Offline · server not connected';
    unreadCounts[peer] = 0; renderChats(); renderMessages();
    $('#app').classList.add('chat-open');
    if (socket && connected && activeKind === 'dm') socket.emit('chat:open', {peer});
  }
  function startSocket() {
    if (typeof window.io !== 'function') { setConnected(false); return; }
    socket = window.io({transports:['websocket','polling']});
    socket.on('connect', () => { if (me) socket.emit('session:join', {name:me}); });
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', () => setConnected(false));
    socket.on('session:error', d => toast(d?.message || 'Could not join chat server.'));
    socket.on('session:ready', d => {
      setConnected(true); onlineUsers = Array.isArray(d?.onlineUsers) ? d.onlineUsers : [];
      renderChats(); if (activePeer && activeKind === 'dm') socket.emit('chat:open', {peer:activePeer});
    });
    socket.on('presence:list', users => { onlineUsers = Array.isArray(users) ? users : []; renderChats(); });
    socket.on('chat:history', d => {
      if (!d || d.peer !== activePeer || !Array.isArray(d.messages)) return;
      localMessages[activePeer] = d.messages; renderMessages(d.messages); renderChats();
    });
    socket.on('chat:message', msg => {
      if (!msg || !msg.from || !msg.text) return;
      const peer = norm(msg.from) === norm(me) ? msg.to : msg.from;
      const displayPeer = Object.keys(details).find(n => norm(n) === norm(peer)) || peer;
      if (!localMessages[displayPeer]) localMessages[displayPeer] = [];
      if (!localMessages[displayPeer].some(m => m.id && m.id === msg.id)) localMessages[displayPeer].push(msg);
      ensureChatItem(displayPeer);
      if (activePeer === displayPeer) renderMessages();
      else { unreadCounts[displayPeer] = (unreadCounts[displayPeer] || 0) + 1; toast('New message from '+msg.from); }
      renderChats();
    });
    socket.on('chat:typing', d => { if (d && d.from === activePeer) $('#activeStatus').textContent = d.active ? 'typing…' : 'online'; });
  }
  function showNameModal() { if (!me) { $('#nameModal').classList.add('show'); $('#displayName').focus(); } }
  $('#nameForm').addEventListener('submit', e => {
    e.preventDefault(); const name = $('#displayName').value.trim();
    if (name.length < 2) { toast('Please enter at least 2 characters.'); return; }
    me = name; localStorage.setItem('fbchat-name', me); $('#nameModal').classList.remove('show');
    if (socket) socket.disconnect(); startSocket(); toast('Welcome, '+me+'!');
  });
  $$('.chatitem').forEach(el => el.addEventListener('click', () => openChat(el.dataset.peer, el.dataset.group === 'true' ? 'group' : 'dm')));
  $('#chatSearch').addEventListener('input', renderChats);
  $$('[data-filter]').forEach(b => b.addEventListener('click', () => {
    filterMode = b.dataset.filter; $$('[data-filter]').forEach(x => x.classList.toggle('active',x===b)); renderChats();
  }));
  $('#backToChats').addEventListener('click', () => $('#app').classList.remove('chat-open'));
  $('#composeForm').addEventListener('submit', e => {
    e.preventDefault(); const input = $('#messageInput'), text = input.value.trim(); if (!text) return;
    if (!me) { showNameModal(); return; }
    const msg = {id:'local-'+Date.now(),from:me,to:activePeer,text,time:new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})};
    if (socket && connected && activeKind === 'dm') {
      socket.emit('chat:send',{to:activePeer,text},ack => {
        if (ack?.error) { toast(ack.error); return; }
        if (ack?.message) {
          if (!localMessages[activePeer]) localMessages[activePeer] = [];
          if (!localMessages[activePeer].some(m => m.id === ack.message.id)) localMessages[activePeer].push(ack.message);
          renderMessages(); renderChats();
        }
      });
    } else {
      if (!localMessages[activePeer]) localMessages[activePeer] = [];
      localMessages[activePeer].push(msg); renderMessages(); renderChats();
      toast('Saved in this page only. Connect server for live delivery.');
    }
    input.value = ''; input.style.height = '28px';
  });
  $('#messageInput').addEventListener('keydown', e => { if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('#composeForm').requestSubmit();} });
  $('#messageInput').addEventListener('input', () => {
    const el=$('#messageInput'); el.style.height='28px'; el.style.height=Math.min(el.scrollHeight,120)+'px';
    if(socket&&connected&&activePeer)socket.emit('chat:typing',{to:activePeer,active:!!el.value.trim()});
  });
  $('#emojiBtn').addEventListener('click',()=>{const el=$('#messageInput');el.value+=' 😊';el.focus();});
  $('#attachBtn').addEventListener('click',()=>toast('Media upload is not implemented yet.'));
  $('#micBtn').addEventListener('click',()=>toast('Voice messages are on the roadmap.'));
  $('#videoCall').addEventListener('click',()=>toast('Video calls need WebRTC and a signalling service.'));
  $('#voiceCall').addEventListener('click',()=>toast('Voice calling is not implemented yet.'));
  $('#searchInChat').addEventListener('click',()=>{
    const term=prompt('Search this conversation');if(!term)return;
    const found=(localMessages[activePeer]||[]).filter(m=>String(m.text).toLowerCase().includes(term.toLowerCase()));
    renderMessages(found);if(!found.length)toast('No matching messages in loaded history.');
  });
  $('#chatDetails').addEventListener('click',()=>toast('Conversation settings and group details are planned.'));
  $('#newChat').addEventListener('click',()=>{
    $('#genericTitle').textContent='Start a new chat';$('#genericDescription').textContent='Enter the display name the other person uses in this app.';
    $('#genericLabel').textContent='Person name';$('#genericLabel').style.display='block';$('#genericInput').style.display='block';
    $('#genericInput').placeholder='e.g. Sana Khan';$('#genericSubmit').textContent='Start conversation';$('#genericSubmit').style.display='block';
    $('#genericCancel').textContent='Cancel';$('#genericModal').classList.add('show');$('#genericInput').focus();
  });
  $('#genericCancel').addEventListener('click',()=>$('#genericModal').classList.remove('show'));
  $('#genericForm').addEventListener('submit',e=>{
    e.preventDefault();const name=$('#genericInput').value.trim();
    if(!validName(name)||norm(name)===norm(me)){toast('Enter another valid display name.');return}
    const peer=Object.keys(details).find(n=>norm(n)===norm(name))||name;
    let item=$$('.chatitem').find(el=>norm(el.dataset.peer)===norm(peer));
    if(!item){const inf=infoFor(peer);item=document.createElement('button');item.className='chatitem';item.dataset.peer=peer;
      item.innerHTML='<div class="chatavatar '+esc(inf.color)+'">'+esc(inf.initial)+'</div><div class="chatbody"><div class="chatrow"><strong>'+esc(inf.name)+'</strong><time>Now</time></div><div class="lastmsg">New conversation</div></div>';
      item.addEventListener('click',()=>openChat(peer,'dm'));$('#chatList').prepend(item);}
    $('#genericModal').classList.remove('show');openChat(peer,'dm');
  });
  function infoModal(title,desc){
    $('#genericTitle').textContent=title;$('#genericDescription').textContent=desc;
    $('#genericLabel').style.display='none';$('#genericInput').style.display='none';$('#genericSubmit').style.display='none';
    $('#genericCancel').textContent='Close';$('#genericModal').classList.add('show');
  }
  $('#profileButton').addEventListener('click',()=>infoModal('Your profile',(me||'Guest')+' — display name is stored only in this browser.'));
  $('#settingsButton').addEventListener('click',()=>infoModal('Settings','This starter does not yet have account login, account recovery, end-to-end encryption, or configurable privacy controls.'));
  $('#genericModal').addEventListener('click',e=>{if(e.target===$('#genericModal'))$('#genericModal').classList.remove('show')});
  $$('[data-rail]').forEach(b=>b.addEventListener('click',()=>{
    const messages={chats:'You are viewing chats.',status:'Status updates are planned.',communities:'Community rooms are planned.',calls:'Voice and video calls are not implemented yet.'};
    $$('[data-rail]').forEach(x=>x.classList.toggle('active',x===b));toast(messages[b.dataset.rail]||'Feature planned.');
  }));
  function init(){renderChats();if(me)startSocket();else showNameModal();}
  init();
})();
