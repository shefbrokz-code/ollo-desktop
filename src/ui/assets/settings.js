// Настройки, меню аккаунта, горячие клавиши и уведомления. Работает поверх app.js:
// открывает его окна через пункты меню и не трогает его внутреннее состояние.
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const CSRF = $('meta[name=csrf]').content;
  const modal = $('#settingsModal');
  const pref = {
    get: (k, d) => { try { return localStorage.getItem('ollo-pref-' + k) || d; } catch { return d; } },
    set: (k, v) => { try { localStorage.setItem('ollo-pref-' + k, v); } catch {} },
  };
  const isGuest = () => !!$('#userMenu [data-act=login]');

  async function api(action, body) {
    const opt = { method: body ? 'POST' : 'GET', headers: { 'X-CSRF': CSRF } };
    if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    const r = await fetch('api.php?a=' + action, opt);
    const j = await r.json().catch(() => ({ error: 'Ошибка сервера' }));
    if (!r.ok || j.error) throw new Error(j.error || 'Ошибка');
    return j;
  }
  const note = (el, text, ok = true) => { el.textContent = text; el.classList.toggle('err', !ok); clearTimeout(el._t); el._t = setTimeout(() => (el.textContent = ''), 5000); };

  // ---------- окно настроек с разделами ----------
  function showTab(tab) {
    $$('.settings-tabs button', modal).forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    $$('.settings-panes section', modal).forEach((s) => (s.hidden = s.dataset.pane !== tab));
    if (tab === 'general') loadProfile();
    if (tab === 'billing') $('#settingsUsage').innerHTML = $('#usageBox').innerHTML;
    if (tab === 'account') $('#accEmail').textContent = $('#menuEmail').textContent;
  }
  function openSettings(tab = 'general') {
    $('#userMenu').hidden = true;
    const guest = isGuest();
    $$('.settings-tabs [data-auth]', modal).forEach((b) => (b.hidden = guest));
    $('#profileForm').hidden = guest;
    $('.guest-note', modal).hidden = !guest;
    modal.hidden = false;
    showTab(tab);
  }
  $('.settings-tabs', modal).onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) showTab(b.dataset.tab); };
  // app.js открывает окно сам — показываем первый раздел
  $('#settingsBtn').onclick = () => openSettings('appearance');
  $('#userMenu').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'settings') { e.stopImmediatePropagation(); openSettings(); }
    if (act === 'shortcuts') openSettings('shortcuts');
  }, true);

  // кнопки-переходы в другие окна: используем существующие пункты меню app.js
  modal.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]')?.dataset.go;
    if (!go) return;
    modal.hidden = true;
    if (go === 'logout') { $('.logout-form')?.submit(); return; }
    $(`#userMenu [data-act="${go}"]`)?.click();
  });

  // ---------- профиль ----------
  let profileLoaded = false;
  async function loadProfile() {
    if (profileLoaded || isGuest()) return;
    try {
      const p = await api('profile_get');
      const f = $('#profileForm');
      ['name', 'call_name', 'occupation', 'preferences'].forEach((k) => (f.elements[k].value = p[k] || ''));
      profileLoaded = true;
    } catch (e) { note($('#profileNote'), e.message, false); }
  }
  $('#profileForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target, data = Object.fromEntries(new FormData(f));
    try {
      await api('profile_save', data);
      if (data.name.trim()) { $('#userName').textContent = data.name.trim(); $('#avatar').textContent = data.name.trim()[0].toUpperCase(); }
      note($('#profileNote'), 'Сохранено. Учитывается в новых ответах.');
    } catch (err) { note($('#profileNote'), err.message, false); }
  };

  // ---------- аккаунт и данные ----------
  $('#passwordForm').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('password_change', Object.fromEntries(new FormData(e.target))); e.target.reset(); note($('#passwordNote'), 'Пароль изменён'); }
    catch (err) { note($('#passwordNote'), err.message, false); }
  };
  $('#deleteAllChats').onclick = async () => {
    const word = prompt('Все чаты будут удалены безвозвратно. Введите УДАЛИТЬ для подтверждения:');
    if (word === null) return;
    try {
      const r = await api('chats_delete_all', { confirm: word.trim() });
      alert(`Удалено чатов: ${r.deleted}` + (r.busy ? `. Не удалено (идёт ответ): ${r.busy}` : ''));
      location.hash = ''; location.reload();
    } catch (err) { alert(err.message); }
  };

  // ---------- локальные настройки чата ----------
  $$('.seg[data-local]', modal).forEach((seg) => {
    const key = seg.dataset.local, def = seg.querySelector('button').dataset.v;
    const sync = () => seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === pref.get(key, def)));
    sync();
    seg.onclick = async (e) => {
      const b = e.target.closest('[data-v]'); if (!b) return;
      if (key === 'notify' && b.dataset.v === 'on' && 'Notification' in window && Notification.permission !== 'granted') {
        if (await Notification.requestPermission() !== 'granted') { alert('Браузер не разрешил уведомления'); return; }
      }
      pref.set(key, b.dataset.v); sync();
    };
  });

  // Ctrl+Enter-режим: обычный Enter переносит строку, перехватываем до обработчика app.js
  document.addEventListener('keydown', (e) => {
    if (e.target.id !== 'input' || e.key !== 'Enter' || e.isComposing || pref.get('send', 'enter') !== 'ctrl') return;
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); e.stopImmediatePropagation(); $('#composer').requestSubmit(); }
    else if (!e.shiftKey) e.stopImmediatePropagation();
  }, true);

  // уведомление и звук, когда ответ готов, а окно не в фокусе
  let wasBusy = false;
  new MutationObserver(() => {
    const busy = document.body.classList.contains('busy');
    if (wasBusy && !busy && document.hidden) {
      if (pref.get('notify', 'off') === 'on' && 'Notification' in window && Notification.permission === 'granted')
        new Notification('ollo', { body: 'Ответ готов', icon: '/pwa/icon-180.png' }).onclick = () => window.focus();
      if (pref.get('sound', 'off') === 'on') beep();
    }
    wasBusy = busy;
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  function beep() {
    try {
      const ctx = new AudioContext(), o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 660; g.gain.setValueAtTime(0.08, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
      o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.35);
    } catch {}
  }

  // ---------- боковая панель: сворачивание в узкую полосу ----------
  const mobile = () => innerWidth <= 860;
  function toggleSidebar() {
    if (mobile()) { document.body.classList.toggle('sb-open'); return; }
    const hidden = document.body.classList.toggle('sb-hidden');
    try { localStorage.setItem('sb', hidden ? 'hidden' : ''); } catch {}
    const t = $('#sbClose'); t.title = t.ariaLabel = hidden ? 'Развернуть панель' : 'Свернуть панель';
  }
  $('#sbClose').onclick = toggleSidebar;
  // в свёрнутой панели клик по поиску сначала разворачивает её
  $('.sb-search').addEventListener('mousedown', () => { if (!mobile() && document.body.classList.contains('sb-hidden')) toggleSidebar(); });

  // ---------- горячие клавиши ----------
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (e.key === 'Escape') {
      const open = $$('.modal:not([hidden])').pop();
      if (open && open.id !== 'previewModal') { open.hidden = true; return; }
      $('#userMenu').hidden = true;
    }
    if (!mod) return;
    if (e.shiftKey && k === 'o') { e.preventDefault(); $('#newChat').click(); }
    else if (!e.shiftKey && k === 'b' && e.target.id !== 'input') { e.preventDefault(); toggleSidebar(); }
    else if (k === ',') { e.preventDefault(); openSettings(); }
    else if (k === '/') { e.preventDefault(); openSettings('shortcuts'); }
  });
})();
