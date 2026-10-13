(() => {
  'use strict';
  if (!('serviceWorker' in navigator)) return;

  let installPrompt = null;
  const button = document.getElementById('installAppButton');

  function showInstallButton() {
    if (button && installPrompt && !window.matchMedia('(display-mode: standalone)').matches) {
      button.hidden = false;
    }
  }

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event;
    showInstallButton();
  });

  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    if (button) button.hidden = true;
  });

  if (button) {
    button.addEventListener('click', async () => {
      if (!installPrompt) {
        alert('Chrome menu ⋮ → Install app / Add to Home screen se install kar lo.');
        return;
      }
      installPrompt.prompt();
      await installPrompt.userChoice.catch(() => null);
      installPrompt = null;
      button.hidden = true;
    });
  }

  navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
    .then((registration) => {
      registration.update().catch(() => {});
      window.addEventListener('pageshow', () => registration.update().catch(() => {}));
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') registration.update().catch(() => {});
      });
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) worker.postMessage({ type: 'SKIP_WAITING' });
        });
      });
    })
    .catch((error) => console.warn('App update registration failed:', error));

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (sessionStorage.getItem('fb-chat-sw-refresh') === '1') {
      sessionStorage.removeItem('fb-chat-sw-refresh');
      return;
    }
    sessionStorage.setItem('fb-chat-sw-refresh', '1');
    window.location.reload();
  });
})();