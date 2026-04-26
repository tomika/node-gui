(function () {
  'use strict';

  async function messageToBackend(value) {
    const response = await fetch('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });

    if (!response.ok) {
      let details = '';
      try {
        const text = await response.text();
        details = text ? ': ' + text : '';
      } catch (_) {
        details = '';
      }
      throw new Error('Backend request failed with status ' + response.status + details);
    }

    return response.json();
  }

  globalThis.messageToBackend = messageToBackend;
})();
