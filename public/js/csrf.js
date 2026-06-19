/**
 * Shared CSRF protection for Epilykos.
 * Overrides window.fetch to add X-Requested-With header to all non-GET requests.
 * On settings pages, also auto-stringifies array fields before POST.
 * Include via: <script src="/js/csrf.js"></script>
 */
(function() {
  const originalFetch = window.fetch;
  window.fetch = function(url, options) {
    var opts = options !== undefined ? Object.assign({}, options) : {};
    if (opts.method && opts.method.toUpperCase() !== 'GET') {
      opts.headers = opts.headers || {};
      if (opts.headers instanceof Headers) {
        opts.headers.set('X-Requested-With', 'XMLHttpRequest');
      } else {
        opts.headers['X-Requested-With'] = 'XMLHttpRequest';
      }
      // Auto-stringify array fields on settings POST
      if (typeof url === 'string' && url.endsWith('/api/settings') && opts.method.toUpperCase() === 'POST') {
        if (opts.body && typeof opts.body === 'string') {
          try {
            var bodyObj = JSON.parse(opts.body);
            var modified = false;
            var arrayKeys = ['mqtt_devices', 'ha_devices', 'modbus_devices', 'rs232_devices', 'external_sources', 'bms_devices', 'dongle_config', 'user_metrics'];
            for (var i = 0; i < arrayKeys.length; i++) {
              var key = arrayKeys[i];
              if (bodyObj.hasOwnProperty(key) && Array.isArray(bodyObj[key])) {
                bodyObj[key] = JSON.stringify(bodyObj[key]);
                modified = true;
              }
            }
            if (modified) { opts.body = JSON.stringify(bodyObj); }
          } catch(e) { console.warn('CSRF: failed to parse settings body', e); }
        }
      }
    }
    return originalFetch.call(this, url, opts);
  };
})();
