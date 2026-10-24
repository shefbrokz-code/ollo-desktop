// ollo Code: запуск код-сессии (сервер + папка) и панель «Файлы / Изменения» в код-чате.
// Сам агент — обычный чат app.js; здесь только навигация и обзор проекта.
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const CSRF = $('meta[name=csrf]').content;
  const panel = $('#codePanel'), toggle = $('#codeToggle');
  if (!panel) return;
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  async function api(action, params = {}, body) {
    const qs = new URLSearchParams({ a: action, ...params });
    const opt = { method: body ? 'POST' : 'GET', headers: { 'X-CSRF': CSRF } };
    if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    const r = await fetch('api.php?' + qs, opt);
    const j = await r.json().catch(() => ({ error: 'Ошибка сервера' }));
    if (!r.ok || j.error) throw Object.assign(new Error(j.error || 'Ошибка'), { status: r.status });
    return j;
  }

  // ---------- запуск сессии ----------
  $('#codeBtn')?.addEventListener('click', async () => {
    document.body.classList.remove('sb-open');
    const sel = $('#codeServer'), form = $('#codeForm');
    try {
      const d = await api('servers');
      const list = d.servers || [];
      sel.innerHTML = list.map((s) => `<option value="${s.id}">${esc(s.name)} — ${esc(s.username)}@${esc(s.host)}</option>`).join('');
      form.hidden = !list.length; $('#codeNoServers').hidden = !!list.length;
      if (!d.allowed) { form.hidden = true; $('#codeNoServers').hidden = false; $('#codeNoServers').textContent = 'SSH-серверы недоступны на вашем тарифе.'; }
    } catch (e) { $('#codeNote').textContent = e.message; }
    try { $('#codePath').value = localStorage.getItem('ollo-code-path') || ''; } catch {}
    $('#codeModal').hidden = false; $('#codePath').focus();
  });
  $('#codeForm').onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.submitter, note = $('#codeNote'), data = Object.fromEntries(new FormData(e.target));
    btn.disabled = true; note.textContent = 'Проверяю папку на сервере…';
    try {
      const r = await api('code_start', {}, { server_id: +data.server_id, path: data.path.trim() });
      try { localStorage.setItem('ollo-code-path', data.path.trim()); localStorage.setItem('ollo-code-panel', 'open'); } catch {}
      location.hash = '#chat/' + r.chat_id; location.reload();
    } catch (err) { note.textContent = err.message; btn.disabled = false; }
  };

  // ---------- панель код-чата ----------
  let chatId = 0, root = '', loaded = false;
  const chatFromHash = () => +((location.hash.match(/^#chat\/(\d+)/) || [])[1] || 0);
  const setOpen = (open) => {
    panel.hidden = !open; document.body.classList.toggle('code-open', open);
    try { localStorage.setItem('ollo-code-panel', open ? 'open' : 'closed'); } catch {}
    if (open && !loaded) { loaded = true; loadTree($('#cpTree'), ''); loadChanges(); }
  };
  async function detect() {
    const id = chatFromHash();
    if (id === chatId) return;
    chatId = id; loaded = false; panel.hidden = true; toggle.hidden = true; document.body.classList.remove('code-open', 'code-chat');
    if (!id) return;
    try {
      const d = await api('code_changes', { chat_id: id });
      if (chatFromHash() !== id) return;
      root = d.root; $('#cpRoot').textContent = root; toggle.hidden = false; document.body.classList.add('code-chat');
      renderChanges(d.files);
      let pref = 'open'; try { pref = localStorage.getItem('ollo-code-panel') || 'open'; } catch {}
      setOpen(pref === 'open' && innerWidth > 860);
    } catch { /* обычный чат */ }
  }
  addEventListener('hashchange', detect);
  detect();
  toggle.onclick = () => setOpen(panel.hidden);
  $('#cpClose').onclick = () => setOpen(false);
  $('#cpRefresh').onclick = () => { $('#cpTree').innerHTML = ''; loadTree($('#cpTree'), ''); loadChanges(); };
  $('.cp-tabs', panel).onclick = (e) => {
    const b = e.target.closest('[data-cp]'); if (!b) return;
    $$('.cp-tabs button', panel).forEach((x) => x.classList.toggle('on', x === b));
    $$('[data-cpane]', panel).forEach((p) => (p.hidden = p.dataset.cpane !== b.dataset.cp));
    $('#cpViewer').hidden = true;
  };

  async function loadTree(container, dir) {
    container.innerHTML = '<div class="cp-muted">Загрузка…</div>';
    try {
      const d = await api('code_tree', { chat_id: chatId, dir });
      container.innerHTML = d.items.length ? '' : '<div class="cp-muted">Пусто</div>';
      for (const it of d.items) {
        const path = (dir ? dir + '/' : '') + it.name;
        const row = document.createElement('div');
        row.className = 'cp-node' + (it.dir ? ' dir' : '');
        row.innerHTML = `<button type="button" title="${esc(path)}"><span class="cp-ico">${it.dir ? '▸' : ''}</span>${esc(it.name)}</button>`;
        const btn = row.firstChild;
        if (it.dir) {
          const kids = document.createElement('div'); kids.className = 'cp-kids'; kids.hidden = true; row.append(kids);
          btn.onclick = () => { kids.hidden = !kids.hidden; row.classList.toggle('open', !kids.hidden); if (!kids.hidden && !kids.dataset.loaded) { kids.dataset.loaded = 1; loadTree(kids, path); } };
        } else btn.onclick = () => openFile(path);
        container.append(row);
      }
    } catch (e) { container.innerHTML = `<div class="cp-muted err">${esc(e.message)}</div>`; }
  }
  async function openFile(path) {
    const v = $('#cpViewer'), code = $('#cpCode');
    $('#cpFile').textContent = path; code.className = ''; code.textContent = 'Загрузка…'; v.hidden = false;
    try {
      const f = await api('code_file', { chat_id: chatId, file: path });
      code.textContent = f.binary ? '[двоичный файл]' : f.content + (f.truncated ? '\n…[показаны первые 200 КБ]' : '');
      const ext = path.split('.').pop();
      if (!f.binary && window.hljs && f.content.length < 150000) { code.className = 'language-' + ext; try { hljs.highlightElement(code); } catch {} }
    } catch (e) { code.textContent = e.message; }
  }
  $('#cpBack').onclick = () => ($('#cpViewer').hidden = true);

  async function loadChanges() {
    if (!chatId) return;
    try { renderChanges((await api('code_changes', { chat_id: chatId })).files); } catch {}
  }
  function renderChanges(files) {
    $('#cpCount').textContent = files.length ? files.length : '';
    const box = $('#cpChanges');
    box.innerHTML = files.length ? '' : '<div class="cp-muted">Агент пока не менял файлы в этой сессии.</div>';
    for (const f of files) {
      const d = document.createElement('details'); d.className = 'cp-change';
      const diff = esc(f.output).split('\n').map((l) => `<span class="${/^\+(?!\+\+)/.test(l) ? 'add' : /^-(?!--)/.test(l) ? 'del' : /^@@/.test(l) ? 'hunk' : ''}">${l}</span>`).join('\n');
      d.innerHTML = `<summary><span class="cp-file">${esc(f.file)}</span><small>${f.edits > 1 ? f.edits + ' правки' : '1 правка'}${f.exit ? ' · ошибка' : ''}</small></summary><pre class="cp-diff">${diff}</pre>`;
      box.append(d);
    }
  }
  // после каждого действия агента обновляем список изменений
  let t = 0;
  new MutationObserver(() => { if (!document.body.classList.contains('code-chat')) return; clearTimeout(t); t = setTimeout(loadChanges, 1500); })
    .observe($('#messages'), { childList: true });
})();
