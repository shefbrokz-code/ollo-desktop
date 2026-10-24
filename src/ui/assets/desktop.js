// Windows-приложение: обновление без переустановки. Сообщаем основному процессу, идёт ли ответ модели,
// показываем отсчёт перед перезапуском и «ollo обновлён» после него. В браузере ничего не делает.
(() => {
  'use strict';
  const ollo = window.ollo;
  if (!ollo?.desktop || typeof ollo.setBusy !== 'function') return;
  const $ = (s) => document.querySelector(s);

  // перезапуск не прерывает генерацию ответа
  let busy = null;
  const syncBusy = () => { const b = document.body.classList.contains('busy'); if (b !== busy) { busy = b; ollo.setBusy(b); } };
  new MutationObserver(syncBusy).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  syncBusy();

  const bar = document.createElement('div');
  bar.className = 'update-bar'; bar.hidden = true; bar.setAttribute('role', 'status');
  bar.innerHTML = '<span class="ub-text"></span><button type="button" class="btn sm primary ub-now">Перезапустить сейчас</button><button type="button" class="btn sm ub-later">Позже</button>';
  document.body.append(bar);
  bar.querySelector('.ub-now').onclick = () => ollo.installUpdate();
  bar.querySelector('.ub-later').onclick = () => { bar.hidden = true; ollo.postponeUpdate(); };

  const plural = (n) => n % 10 === 1 && n % 100 !== 11 ? 'секунду' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'секунды' : 'секунд';
  ollo.onUpdate((u) => {
    const text = bar.querySelector('.ub-text');
    if (u.status === 'restarting') {
      text.textContent = `Обновление ollo ${u.availableVersion || ''} установится через ${u.seconds} ${plural(u.seconds)}. Приложение откроется на этом же месте.`;
      bar.hidden = false;
    } else if (u.status === 'installing') {
      text.textContent = 'Устанавливаю обновление…'; bar.querySelectorAll('button').forEach((b) => (b.hidden = true)); bar.hidden = false;
    } else bar.hidden = true;
  });

  ollo.getState().then((s) => {
    if (!s.justUpdated) return;
    const t = $('#toast');
    if (t) { t.textContent = `ollo обновлён до версии ${s.justUpdated}`; t.hidden = false; setTimeout(() => (t.hidden = true), 6000); }
  }).catch(() => {});
})();
