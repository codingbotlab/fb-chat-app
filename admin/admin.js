(() => {
  'use strict';
  const $ = (selector) => document.querySelector(selector);
  let config = null;
  let authSession = null;
  let lastPanel = 'overview';
  const readSession = () => {
    try { return JSON.parse(sessionStorage.getItem('fb-chat-admin-session') || 'null'); }
    catch { return null; }
  };
  const saveSession = (data) => {
    authSession = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Number(data.expires_at || (Math.floor(Date.now() / 1000) + Number(data.expires_in || 3600))),
      user: data.user
    };
    sessionStorage.setItem('fb-chat-admin-session', JSON.stringify(authSession));
  };
  function fmtDate(value) {
    if (!value) return '—';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString([], {dateStyle:'medium',timeStyle:'short'});
  }
  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  }
  function safeAvatar(value) {
    if (typeof value !== 'string') return '';
    if (value.length <= 40000 && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return value;
    try {
      const url = new URL(value), base = new URL(config?.supabaseUrl || '');
      return url.protocol === 'https:' && url.origin === base.origin &&
        /^\/storage\/v1\/object\/public\/fbchat-profiles\/[0-9a-f-]{36}\.(?:jpg|png|webp)$/i.test(url.pathname) ? value : '';
    } catch { return ''; }
  }
  async function refreshSession() {
    if (!authSession?.refresh_token) throw new Error('Please sign in again.');
    const response = await fetch(config.supabaseUrl + '/auth/v1/token?grant_type=refresh_token', {
      credentials:'omit',
      method:'POST',
      headers:{'Content-Type':'application/json',apikey:config.supabaseAnonKey},
      body:JSON.stringify({refresh_token:authSession.refresh_token})
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) throw new Error('Session expired. Sign in again.');
    saveSession(data);
  }
  async function api(path, options = {}, canRetry = true) {
    if (!authSession?.access_token) throw new Error('Sign in to continue.');
    if (authSession.expires_at < Math.floor(Date.now()/1000) + 20 && authSession.refresh_token) {
      await refreshSession();
    }
    const response = await fetch(path, {
      credentials:'omit',
      cache:'no-store',
      method:options.method || 'GET',
      headers:Object.assign({'Content-Type':'application/json',Authorization:'Bearer '+authSession.access_token},options.headers||{}),
      body:options.body
    });
    if (response.status === 401 && canRetry && authSession.refresh_token) {
      await refreshSession();
      return api(path, options, false);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || (response.status + ' request failed'));
    return data;
  }
  function loginError(message) { $('#loginError').textContent = message || ''; }
  function showLogin(message = '') {
    $('#loginView').hidden = false;
    $('#dashboardView').hidden = true;
    $('#refreshButton').hidden = true;
    $('#logoutButton').hidden = true;
    $('#adminEmail').textContent = '';
    loginError(message);
  }
  function showDashboard() {
    $('#loginView').hidden = true;
    $('#dashboardView').hidden = false;
    $('#refreshButton').hidden = false;
    $('#logoutButton').hidden = false;
    $('#adminEmail').textContent = authSession?.user?.email || '';
  }
  async function login(event) {
    event.preventDefault();
    if (!config?.configured) return loginError('The chat authentication/database is not configured.');
    if (!config.adminConfigured) return loginError('Admin access is not enabled yet. The owner must add ADMIN_EMAILS to the server environment.');
    $('#loginSubmit').disabled = true; $('#loginSubmit').textContent = 'Signing in…'; loginError('');
    try {
      const response = await fetch(config.supabaseUrl + '/auth/v1/token?grant_type=password', {
        credentials:'omit',
        method:'POST',
        headers:{'Content-Type':'application/json',apikey:config.supabaseAnonKey},
        body:JSON.stringify({email:$('#email').value.trim(),password:$('#password').value})
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.access_token) throw new Error(data.msg || data.message || data.error_description || 'Sign in failed.');
      saveSession(data);
      $('#password').value = '';
      showDashboard();
      await loadPanel('overview');
    } catch (error) {
      authSession = null; sessionStorage.removeItem('fb-chat-admin-session');
      showLogin(error.message || 'Could not sign in.');
    } finally {
      $('#loginSubmit').disabled = false; $('#loginSubmit').textContent = 'Sign in securely';
    }
  }
  async function logout() {
    try {
      if (authSession?.access_token && config?.supabaseUrl) {
        await fetch(config.supabaseUrl + '/auth/v1/logout', {
          credentials:'omit',
          method:'POST',headers:{apikey:config.supabaseAnonKey,Authorization:'Bearer '+authSession.access_token}
        });
      }
    } catch {}
    authSession = null; sessionStorage.removeItem('fb-chat-admin-session'); showLogin('Signed out.');
  }
  function renderStats(counts = {}) {
    const data = [
      ['Total users',counts.users,'Registered profiles'],
      ['Messages',counts.messages,'Encrypted database records'],
      ['Online now',counts.onlineNow,'Live connected accounts'],
      ['Android devices',counts.androidDevices,'Registered notification devices']
    ];
    $('#statGrid').innerHTML = data.map(([label,value,note]) =>
      '<article class="stat"><div class="label">'+esc(label)+'</div><div class="value">'+esc(value ?? '—')+'</div><div class="note">'+esc(note)+'</div></article>').join('');
  }
  function renderHealth(service = {}) {
    const row = (label, okay, trueText='Enabled', falseText='Not configured') =>
      '<div class="health-row"><span>'+esc(label)+'</span><strong class="health-state">'+esc(okay ? trueText : falseText)+'</strong></div>';
    $('#servicePill').textContent = service.status === 'online' ? 'Service online' : 'Service status';
    $('#servicePill').classList.toggle('muted',service.status !== 'online');
    $('#healthList').innerHTML =
      row('Web service',service.status === 'online','Online','Unavailable')+
      row('Realtime connected users',Number(service.connectedUsers)>0,'Connected: '+service.connectedUsers,'No active connections')+
      row('Browser push',service.webPushConfigured,'Configured','Not configured')+
      row('Android push',service.nativePushConfigured,'Configured','Not configured')+
      row('Admin allowlist',service.adminAllowlistConfigured,'Configured','Needs setup');
  }
  function userTable(users, compact = false) {
    if (!users?.length) return '<div class="empty">No matching accounts found.</div>';
    const heading = compact
      ? '<thead><tr><th>Account</th><th>Encryption</th><th>Created</th></tr></thead>'
      : '<thead><tr><th>Account</th><th>Email</th><th>Created</th><th>Last sign-in</th><th>Encryption</th></tr></thead>';
    const body = users.map((u) => {
      const photo = safeAvatar(u.avatar_url);
      const style = photo ? ' style="background-image:url(\''+photo+'\')"' : '';
      const avatar = '<span class="avatar"'+style+'>'+(photo ? '' : esc((u.display_name || u.username || u.email || '?').slice(0,1).toUpperCase()))+'</span>';
      const name = '<span class="user-cell">'+avatar+'<span><strong>'+esc(u.display_name || 'No display name')+'</strong><small>@'+esc(u.username || 'not set')+'</small></span></span>';
      const enc = u.encryptionReady ? '<span class="status">Ready</span>' : '<span class="status warn">Not ready</span>';
      const row = compact
        ? '<tr><td>'+name+'</td><td>'+enc+'</td><td>'+esc(fmtDate(u.created_at))+'</td></tr>'
        : '<tr><td>'+name+'</td><td>'+esc(u.email || '—')+'</td><td>'+esc(fmtDate(u.created_at))+'</td><td>'+esc(fmtDate(u.last_sign_in_at))+'</td><td>'+enc+'</td></tr>';
      return row;
    }).join('');
    return '<table>'+heading+'<tbody>'+body+'</tbody></table>';
  }
  async function loadOverview() {
    const data = await api('/api/admin/overview');
    renderStats(data.counts);
    renderHealth(data.service);
    $('#recentUsers').innerHTML = userTable(data.recentUsers, true);
    $('#lastUpdated').textContent = 'Last refreshed ' + fmtDate(data.generatedAt);
  }
  async function loadUsers() {
    $('#usersTable').innerHTML = '<div class="loading">Loading accounts…</div>';
    const q = $('#userSearch').value.trim();
    const data = await api('/api/admin/users' + (q ? '?q='+encodeURIComponent(q) : ''));
    $('#usersTable').innerHTML = userTable(data.users, false);
    $('#userCount').textContent = 'Showing ' + data.users.length + ' accounts in this result. ' + (data.hasMore ? 'More auth records may exist beyond the current page.' : '');
  }
  async function loadActivity() {
    $('#activityTable').innerHTML = '<div class="loading">Loading activity metadata…</div>';
    const data = await api('/api/admin/activity');
    const html = (data.activity || []).map((m) => {
      const state = m.read_at ? 'Read' : m.delivered_at ? 'Delivered' : 'Saved';
      return '<tr><td>'+esc(fmtDate(m.created_at))+'</td><td><strong>'+esc(m.sender.display_name || m.sender.username)+'</strong><small>@'+esc(m.sender.username)+' · '+esc(m.sender.email)+'</small></td><td><strong>'+esc(m.recipient.display_name || m.recipient.username)+'</strong><small>@'+esc(m.recipient.username)+' · '+esc(m.recipient.email)+'</small></td><td><span class="status">'+state+'</span></td></tr>';
    }).join('');
    $('#activityTable').innerHTML = html ? '<table><thead><tr><th>Time</th><th>Sender</th><th>Recipient</th><th>Status</th></tr></thead><tbody>'+html+'</tbody></table>' : '<div class="empty">No message records yet.</div>';
  }
  function deviceTable(items, android = false) {
    if (!items?.length) return '<div class="empty">No registered devices yet.</div>';
    const rows = items.map((d) => '<tr><td><strong>'+esc(d.display_name || d.username)+'</strong><small>@'+esc(d.username)+'</small></td>'+(android ? '<td>'+esc(d.device_name || 'Android device')+'</td>' : '')+'<td><small class="truncate">'+esc(d.user_agent || 'User agent unavailable')+'</small></td><td>'+esc(fmtDate(d.updated_at || d.created_at))+'</td></tr>').join('');
    return '<table><thead><tr><th>Account</th>'+(android?'<th>Device</th>':'')+'<th>Browser / app information</th><th>Last registered</th></tr></thead><tbody>'+rows+'</tbody></table>';
  }
  async function loadDevices() {
    const data = await api('/api/admin/devices');
    $('#deviceStats').innerHTML = [
      ['Android registrations',data.android.length,'FCM token values stay hidden'],
      ['Web registrations',data.web.length,'Push endpoints stay hidden']
    ].map(([label,value,note])=>'<article class="stat"><div class="label">'+esc(label)+'</div><div class="value">'+esc(value)+'</div><div class="note">'+esc(note)+'</div></article>').join('');
    $('#androidTable').innerHTML = deviceTable(data.android,true);
    $('#webTable').innerHTML = deviceTable(data.web,false);
  }
  async function loadPanel(panel) {
    lastPanel = panel;
    $('#dashboardError').hidden = true;
    document.querySelectorAll('.tab').forEach((el)=>el.classList.toggle('active',el.dataset.panel===panel));
    document.querySelectorAll('.panel').forEach((el)=>el.hidden=el.id!=='panel-'+panel);
    try {
      if(panel==='overview') await loadOverview();
      else if(panel==='users') await loadUsers();
      else if(panel==='activity') await loadActivity();
      else if(panel==='devices') await loadDevices();
    } catch(error) {
      if(error.message && /admin|sign in|session|expired|403|401/i.test(error.message)) {
        $('#dashboardError').hidden=false; $('#dashboardError').textContent=error.message;
      } else {
        $('#dashboardError').hidden=false; $('#dashboardError').textContent=error.message || 'Could not load this section.';
      }
      if (/not on the FB Chat admin allowlist/i.test(error.message)) await logout();
    }
  }
  async function init() {
    try {
      const response = await fetch('/api/admin/config',{cache:'no-store',credentials:'omit'});
      config = await response.json();
      if(!response.ok) throw new Error('Could not load admin setup. Reload this page and retry.');
      if(!config.configured) $('#configNotice').textContent='Chat authentication/database is not configured.';
      else if(!config.adminConfigured) $('#configNotice').textContent='Admin login is locked until ADMIN_EMAILS is set in the Render environment.';
      else $('#configNotice').hidden=true;
      $('#configNotice').hidden = Boolean(config.configured && config.adminConfigured);
    } catch(error) {
      showLogin(error.message);
      return;
    }
    authSession = readSession();
    if(authSession?.access_token && config.adminConfigured) {
      showDashboard();
      try { await loadPanel('overview'); }
      catch(error) { showLogin(error.message || 'Please sign in again.'); }
    } else {
      authSession = null; sessionStorage.removeItem('fb-chat-admin-session'); showLogin();
    }
  }
  $('#loginForm').addEventListener('submit',login);
  $('#logoutButton').addEventListener('click',logout);
  $('#refreshButton').addEventListener('click',()=>void loadPanel(lastPanel));
  document.querySelectorAll('[data-panel]').forEach((el)=>el.addEventListener('click',()=>void loadPanel(el.dataset.panel)));
  document.querySelectorAll('[data-jump]').forEach((el)=>el.addEventListener('click',()=>void loadPanel(el.dataset.jump)));
  $('#searchUsersButton').addEventListener('click',()=>void loadUsers());
  $('#userSearch').addEventListener('keydown',(event)=>{if(event.key==='Enter'){event.preventDefault();void loadUsers();}});
  init();
})();