/** Session-bound CSRF tokens for same-origin fetch and binary uploads. */
(function () {
  'use strict';
  const originalFetch = window.fetch;
  let tokenPromise;
  function token() {
    if (!tokenPromise) {
      tokenPromise = originalFetch.call(window, '/api/csrf-token', { credentials: 'same-origin', cache: 'no-store' })
        .then(async function (response) {
          if (!response.ok) throw new Error('Unable to obtain CSRF session token');
          const body = await response.json();
          if (typeof body.token !== 'string' || !/^[a-f0-9]{64}$/.test(body.token)) throw new Error('Invalid CSRF session token');
          return body.token;
        }).catch(function (error) { tokenPromise = undefined; throw error; });
    }
    return tokenPromise;
  }
  function invalidate() { tokenPromise = undefined; }
  window.EpilykosCsrf = { token: token, invalidate: invalidate };
  window.fetch = async function (input, options) {
    const opts = Object.assign({}, options);
    const request = typeof Request !== 'undefined' && input instanceof Request;
    const url = new URL(request ? input.url : input, window.location.href);
    const method = String(opts.method || (request && input.method) || 'GET').toUpperCase();
    if (url.origin !== window.location.origin || ['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      return originalFetch.call(this, input, opts);
    }
    opts.headers = new Headers(opts.headers === undefined && request ? input.headers : opts.headers);
    opts.headers.set('X-Requested-With', 'XMLHttpRequest');
    opts.headers.set('X-CSRF-Token', await token());
    // Settings stores these list values as JSON strings.
    if (url.pathname === '/api/settings' && method === 'POST' && typeof opts.body === 'string') {
      try {
        const body = JSON.parse(opts.body);
        const keys = ['mqtt_devices', 'ha_devices', 'modbus_devices', 'rs232_devices', 'external_sources', 'bms_devices', 'dongle_config', 'user_metrics'];
        for (const key of keys) if (Object.prototype.hasOwnProperty.call(body, key) && Array.isArray(body[key])) body[key] = JSON.stringify(body[key]);
        opts.body = JSON.stringify(body);
      } catch (error) { console.warn('CSRF: failed to parse settings body', error); }
    }
    const response = await originalFetch.call(this, input, opts);
    if (response.status === 403 && response.headers.get('X-CSRF-Error') === 'token') invalidate();
    // Never replay a state-changing request automatically.
    return response;
  };
})();
