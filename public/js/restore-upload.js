/* Sequential binary restore transport; no whole-file ArrayBuffer/FormData. */
(function (root) {
  'use strict';
  function connect(options) {
    var job = null, timer, xhr, cancelled = false, disposed = false, uploading = false, watching = false, authRequired = false, prompting = false;
    var status = options.status, progress = options.progress, cancelButton = options.cancel, row = options.row;
    function terminal(phase) { return ['selected', 'recovered', 'failed', 'cancelled', 'unknown'].indexOf(phase) !== -1; }
    function describe(s) {
      var labels = { uploading: 'Uploading backup', passphrase: 'This backup has saved passwords protected by a passphrase. Waiting for the passphrase.', preparing: 'Validating and preparing backup. This can take a while.', activating: 'Activating backup. The connection may briefly drop.', recovering: 'Restarting to recover the restore result.', selected: 'Backup restored.', recovered: 'Restore interrupted. The original database was recovered.', failed: 'Restore failed.', cancelled: 'Restore cancelled.', unknown: 'Restore result needs inspection.' };
      return (labels[s.phase] || s.phase) + (s.error ? ' ' + s.error : '');
    }
    function controls(s) {
      var active = s && !terminal(s.phase);
      row.hidden = !active; cancelButton.disabled = authRequired || !active || ['activating', 'recovering'].indexOf(s.phase) !== -1;
      options.restore.disabled = authRequired || !!active; options.backup.disabled = authRequired || !!active;
    }
    function render(s, bytes) {
      job = s; controls(s);
      if (!s) return;
      status.textContent = describe(s);
      if (s.phase === 'passphrase') ask(s);
      if (s.phase === 'uploading') {
        progress.max = s.bytes; progress.value = bytes === undefined ? s.received : bytes;
        status.textContent += ' — ' + Math.floor(100 * progress.value / s.bytes) + '% (' + progress.value.toLocaleString() + ' / ' + s.bytes.toLocaleString() + ' bytes).';
      } else progress.removeAttribute('value');
    }
    // The upload is done and the restore is waiting. The dialog is the page's
    // (options.askPassphrase → { passphrase } | { skip: true } | null); a wrong
    // passphrase leaves the job waiting with the reason, so it asks again.
    async function ask(s) {
      if (prompting || disposed || authRequired || typeof options.askPassphrase !== 'function') return;
      prompting = true;
      var id = encodeURIComponent(s.id), error = s.error || '';
      try {
        for (;;) {
          var answer = await options.askPassphrase({ error: error });
          if (disposed) return;
          try {
            if (!answer) render(await json('/api/restore-jobs/' + id + '/cancel', { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest' } }));
            else render(await json('/api/restore-jobs/' + id + '/passphrase', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify(answer) }));
            return;
          } catch (failure) {
            if (authorizationEnded(failure)) return;
            if (answer && (failure.status === 422 || failure.status === 400)) { error = failure.message; continue; }
            status.textContent = failure.message; return;
          }
        }
      } finally { prompting = false; schedule(); }
    }
    async function json(url, settings) {
      var response = await root.fetch(url, settings), body = await response.json().catch(function () { return {}; });
      if (!response.ok) { var error = new Error(body.error || 'Restore request failed (' + response.status + ')'); error.status = response.status; throw error; }
      return body;
    }
    function authorizationEnded(error) {
      if (error.status !== 401 && error.status !== 403) return false;
      authRequired = true; clearTimeout(timer); controls(job);
      status.innerHTML = 'Your session ended. <a href="/login.html" target="_blank" rel="noopener">Sign in in another tab</a>, then return here to check the restore result.';
      return true;
    }
    function schedule() { clearTimeout(timer); if (!authRequired && !disposed && job && !terminal(job.phase)) timer = setTimeout(poll, 2000); }
    async function poll() {
      try {
        var s = await json('/api/restore-jobs/' + encodeURIComponent(job.id)); render(s);
        if (s.phase === 'selected' && watching) { watching = false; options.onSelected(); }
      } catch (error) { if (!authorizationEnded(error)) status.textContent = 'Waiting for Epilykos to reconnect and report the restore result…'; }
      schedule();
    }
    async function chunk(file, offset, end) {
      var token = await root.EpilykosCsrf.token();
      if (cancelled || disposed) throw new Error('Upload cancelled');
      return new Promise(function (resolve, reject) {
        xhr = new root.XMLHttpRequest();
        xhr.open('PUT', '/api/restore-jobs/' + encodeURIComponent(job.id) + '/chunks');
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
        xhr.setRequestHeader('X-CSRF-Token', token);
        xhr.setRequestHeader('X-Restore-Offset', String(offset)); xhr.timeout = 300000;
        xhr.upload.onprogress = function (e) { render(job, offset + e.loaded); };
        xhr.onload = function () {
          var body; try { body = JSON.parse(xhr.responseText); } catch (_) { body = {}; }
          if (xhr.status === 403 && xhr.getResponseHeader('X-CSRF-Error') === 'token') root.EpilykosCsrf.invalidate();
          if (xhr.status < 200 || xhr.status >= 300) { var error = new Error(body.error || 'Upload failed (' + xhr.status + ')'); error.status = xhr.status; reject(error); }
          else resolve(body);
        };
        xhr.onerror = xhr.ontimeout = function () { reject(new Error('Upload connection interrupted. Checking the restore status…')); };
        xhr.onabort = function () { reject(new Error('Upload cancelled')); };
        xhr.send(file.slice(offset, end));
      });
    }
    async function start(file) {
      if (uploading || disposed || (job && !terminal(job.phase))) return;
      cancelled = false; uploading = true; options.restore.disabled = true; options.backup.disabled = true; clearTimeout(timer); status.textContent = 'Checking DATA space for the backup…';
      try {
        var s = await json('/api/restore-jobs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, body: JSON.stringify({ bytes: file.size, name: file.name }) });
        watching = true; render(s);
        while (job.received < file.size && !cancelled) {
          var offset = job.received, end = Math.min(offset + job.chunkBytes, file.size), started = Date.now();
          render(await chunk(file, offset, end)); xhr = null;
          // Fit long transfers into the existing API rate window, leaving room
          // for other settings requests. No server request timeout is changed.
          if (job.phase === 'uploading') await new Promise(function (resolve) { setTimeout(resolve, Math.max(0, 1000 - (Date.now() - started))); });
        }
      } catch (error) { if (!authorizationEnded(error)) status.textContent = error.message; }
      finally { xhr = null; uploading = false; controls(job); schedule(); }
    }
    cancelButton.addEventListener('click', async function () {
      if (!job) return;
      cancelled = true; if (xhr) xhr.abort(); cancelButton.disabled = true;
      try { render(await json('/api/restore-jobs/' + encodeURIComponent(job.id) + '/cancel', { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest' } })); }
      catch (error) { if (!authorizationEnded(error)) status.textContent = error.message; schedule(); }
    });
    async function refresh() {
      if (uploading || disposed) return;
      try { var result = await json('/api/restore-jobs'), wasAuthRequired = authRequired; authRequired = false; if (result.status) { watching = !terminal(result.status.phase); render(result.status); schedule(); } else { job = null; controls(null); if (wasAuthRequired) status.textContent = 'Signed in. No restore job is recorded.'; } }
      catch (error) { authorizationEnded(error); }
    }
    function focus() { if (authRequired) refresh(); }
    root.addEventListener('focus', focus);
    return { start: start, refresh: refresh, dispose: function () { disposed = true; clearTimeout(timer); root.removeEventListener('focus', focus); } };
  }
  root.EpilykosRestoreUploads = { connect: connect };
})(typeof window === 'undefined' ? globalThis : window);
