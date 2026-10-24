(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const CSRF = document.querySelector('meta[name=csrf]').content;
  const S = { user: null, plan: null, models: [], chats: [], projects: [], servers: [], sshAllowed: false, maxServers: 3,
    chatId: null, projectId: 0, model: null, busy: false, ctrl: null, pending: [], limits: { max_mb: 25, max_files: 10 },
    ctx: { projectId: 0, serverId: 0, auto: 0 } };
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
  // Активный поток привязан к конкретному чату: смена чата его не прерывает.
  const active = { chatId: null, ctrl: null, note: null };
  const tasks=new Map();let taskPolling=false,controlPending=false,taskPollTimer=0;
  const projectChatIcon='<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6A8.4 8.4 0 0 1 12.5 3h.5M19 2v6m-3-3h6"/></svg>';
  const CARET = '';

  function openAuth(mode='login') {
    const register=mode==='register'; $('#authMode').value=register?'register':'login';
    $('#authHeading').textContent=register?'Создать аккаунт ollo':'Войти в ollo';
    $('#authNameLabel').hidden=!register; $('#authSubmit').textContent=register?'Зарегистрироваться':'Войти';
    $('#authSwitchPrompt').textContent=register?'Уже есть аккаунт?':'Нет аккаунта?';
    $('#authSwitch').textContent=register?'Войти':'Зарегистрироваться';
    $('#authPassword').autocomplete=register?'new-password':'current-password';
    $('#userMenu').hidden=true;$('#authModal').hidden=false;closeSidebarMobile();
  }
  $('#authSwitch').onclick=()=>openAuth($('#authMode').value==='register'?'login':'register');
  document.addEventListener('click', e=>{
    const link=e.target.closest('a[href="auth.php"],a[href="auth.php?mode=register"]');
    if(link) { e.preventDefault();openAuth(link.getAttribute('href').includes('register')?'register':'login'); }
  });
  // ---------- настройки оформления ----------
  const SETTINGS = { theme: 'system', font: 'serif', size: 'medium', width: 'narrow', anim: 'full' };
  function applySetting(key, val) {
    const h = document.documentElement;
    if (key === 'theme') {
      if (val === 'system') delete h.dataset.theme; else h.dataset.theme = val;
      const dark = val === 'dark' || (val === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
      $('meta[name=theme-color]')?.setAttribute('content', dark ? '#262624' : '#faf9f5');
    } else if (key === 'anim') {
      h.classList.toggle('reduce-anim', val === 'reduce');
    } else {
      [...h.classList].filter((c) => c.startsWith(key + '-')).forEach((c) => h.classList.remove(c));
      h.classList.add(key + '-' + val);
    }
    store.set(key, val); SETTINGS[key] = val;
  }
  function initSettings() {
    for (const k of Object.keys(SETTINGS)) { const v = store.get(k) || SETTINGS[k]; applySetting(k, v); }
    document.querySelectorAll('#settingsModal .seg[data-set]').forEach((seg) => {
      const key = seg.dataset.set;
      const sync = () => seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === SETTINGS[key]));
      sync();
      seg.onclick = (e) => { const b = e.target.closest('button[data-v]'); if (!b) return; applySetting(key, b.dataset.v); sync(); };
    });
  }

  // ---------- утилиты ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  async function api(action, body) {
    const opt = { method: body ? 'POST' : 'GET', headers: { 'X-CSRF': CSRF } };
    if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    const r = await fetch('api.php?a=' + action, opt);
    if (r.status === 401) { openAuth(); throw new Error('Войдите в аккаунт'); }
    const j = await r.json().catch(() => ({ error: 'Ошибка сервера' }));
    if (!r.ok || j.error) throw Object.assign(new Error(j.error || 'Ошибка'), { data: j });
    return j;
  }
  function toast(msg, ms = 4000) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(t._h); t._h = setTimeout(() => (t.hidden = true), ms); }
  const humanSize = (b) => (b < 1024 ? b + ' Б' : b < 1048576 ? (b / 1024).toFixed(1) + ' КБ' : (b / 1048576).toFixed(1) + ' МБ');
  const extOf = (n) => { const m = String(n).toLowerCase().match(/\.([a-z0-9]{1,6})$/); return m ? m[1] : ''; };
  const plural = (n, a, b, c) => (n % 10 === 1 && n % 100 !== 11 ? a : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? b : c);
  function timeLabel(s) {
    if (!s) return 'только что';
    const d = new Date(s.replace(' ', 'T')); const diff = (Date.now() - d) / 60000;
    if (diff < 1) return 'только что';
    if (diff < 60) { const n = Math.floor(diff); return n + ' ' + plural(n, 'минуту', 'минуты', 'минут') + ' назад'; }
    const hm = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    return new Date().toDateString() === d.toDateString() ? hm : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) + ', ' + hm;
  }
  marked.setOptions({ gfm: true, breaks: true });
  const md = (text) => DOMPurify.sanitize(marked.parse(text || ''), { ADD_ATTR: ['target'] });

  function copyText(text, btn) {
    const done = () => { if (!btn) return; const o = btn.innerHTML; btn.classList.add('done'); btn.innerHTML = btn.classList.contains('act') ? I.check : I.check + 'Скопировано'; setTimeout(() => { btn.innerHTML = o; btn.classList.remove('done'); }, 1600); };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text) && done());
    else if (fallbackCopy(text)) done();
  }
  function fallbackCopy(text) { const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); let ok = false; try { ok = document.execCommand('copy'); } catch {} ta.remove(); return ok; }

  const I = {
    copy: '<svg viewBox="0 0 24 24" width="16" height="16"><rect x="8" y="8" width="12" height="12" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    retry: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    edit: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
    down: '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 20h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    eye: '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>',
    zip: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M10 5v3M10 9v2M10 12h2v2h-2z" stroke-linecap="round"/></svg>',
  };

  // ---------- выгрузка результата как файлы/архив (ZIP, без зависимостей) ----------
  const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function zipStore(files) { // files: [{name, data:Uint8Array}] — метод 0 (store), без сжатия
    const enc = new TextEncoder(); const chunks = []; const central = []; let offset = 0;
    const u16 = (n) => [n & 255, (n >> 8) & 255]; const u32 = (n) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255];
    for (const f of files) {
      const name = enc.encode(f.name); const crc = crc32(f.data);
      const lh = [0x50, 0x4b, 3, 4, ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(f.data.length), ...u32(f.data.length), ...u16(name.length), ...u16(0)];
      chunks.push(new Uint8Array(lh), name, f.data);
      central.push([0x50, 0x4b, 1, 2, ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(f.data.length), ...u32(f.data.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)]);
      central.push(name);
      offset += lh.length + name.length + f.data.length;
    }
    const cdStart = offset; let cdLen = 0; const cdChunks = [];
    for (let i = 0; i < central.length; i += 2) { const h = new Uint8Array(central[i]); cdChunks.push(h, central[i + 1]); cdLen += h.length + central[i + 1].length; }
    const eocd = new Uint8Array([0x50, 0x4b, 5, 6, ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(cdLen), ...u32(cdStart), ...u16(0)]);
    return new Blob([...chunks, ...cdChunks, eocd], { type: 'application/zip' });
  }
  // Named code blocks are real downloadable text files; ZIP keeps their folders.
  const clean = name => {
    const parts = String(name).normalize('NFC').replace(/\\/g,'/').split('/');
    return parts.filter(p=>p && p!=='.' && p!=='..').map(p=>p.replace(/[\u0000-\u001f<>:"|?*]/g,'_').replace(/[. ]+$/g,'')).filter(Boolean).join('/') || 'file.txt';
  };
  function annotateFiles(body, raw) {
    if(!raw) return;
    const blocks=[];
    const walk=tokens=>{ for(const token of tokens || []) { if(token.type==='code') blocks.push(token); else if(token.type==='list') token.items.forEach(item=>walk(item.tokens)); else if(token.tokens)walk(token.tokens); } };
    walk(marked.lexer(raw));
    body.querySelectorAll('pre > code').forEach((code,i)=>{
      const info=blocks[i]?.lang || '';
      const explicit=info.match(/(?:filename|file|path)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s]+))/i);
      const first=info.split(/\s+/)[0];
      const name=explicit ? explicit[1] || explicit[2] || explicit[3] : /(?:^|\/)[^/]+\.[\w]{1,12}$/.test(first) ? first : null;
      if(name)code.dataset.filename=clean(name);
      if(name && first===name)code.className='language-'+(name.split('.').pop() || 'text');
    });
  }
  function messageFiles(body) {
    const files=[], used=new Set();
    body.querySelectorAll('pre > code').forEach((code,i)=>{
      if(code.closest('.term-card')) return;
      const lang=((code.className.match(/language-([\w+#-]+)/)||[])[1]||'').toLowerCase();
      if(lang==='run')return;
      const src=code.textContent;let name=detectName(code,lang,src,i), base=name,n=1;
      while(used.has(name.toLocaleLowerCase())) { const dot=base.lastIndexOf('.'),slash=base.lastIndexOf('/');name=dot>slash?base.slice(0,dot)+'-'+(++n)+base.slice(dot):base+'-'+(++n); }
      used.add(name.toLocaleLowerCase());files.push({name,src});
    });
    return files;
  }
  function detectName(code,lang,src,index) {
    if(code.dataset.filename)return clean(code.dataset.filename);
    const nameRe=/([\p{L}\p{N}_./\\ -]+\.[a-zA-Z0-9]{1,12})/u;
    const previous=code.closest('pre').previousElementSibling;
    if(previous) {
      const inline=previous.querySelector('code');
      if(inline && /^[^\n]+\.[a-zA-Z0-9]{1,12}$/.test(inline.textContent.trim()))return clean(inline.textContent.trim());
      const text=previous.textContent.trim().replace(/^(?:файл|file|имя файла)\s*:\s*/i,'');const exact=text.match(new RegExp('^'+nameRe.source+'\\s*:?$','u'));
      if(exact && exact[1].trim().split(/\s+/).length<=3)return clean(exact[1].trim());
    }
    const comment=(src.split('\n')[0]||'').match(/^(?:#|\/\/|--|;|<!--|\/\*)\s*(?:file|filename|path)\s*[:=]\s*(.+?\.[a-zA-Z0-9]{1,12})(?:\s*-->|\s*\*\/)?$/i);
    if(comment)return clean(comment[1]);
    return lang==='dockerfile'?'Dockerfile':'file'+(index+1)+'.'+(LANG_EXT[lang]||'txt');
  }
  function fileBytes(file) {
    const bom=/\.(csv|tsv)$/i.test(file.name)?'\uFEFF':'';
    return new TextEncoder().encode(bom+file.src);
  }
  function saveBlob(blob,name) {
    const link=document.createElement('a'),url=URL.createObjectURL(blob);
    link.href=url;link.download=name;document.body.appendChild(link);link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),30000);
  }
  function downloadFile(file) {
    const ext=file.name.split('.').pop().toLowerCase();
    const mime={csv:'text/csv',tsv:'text/tab-separated-values',json:'application/json',html:'text/html',svg:'image/svg+xml',xml:'application/xml'}[ext]||'text/plain';
    saveBlob(new Blob([fileBytes(file)],{type:mime+';charset=utf-8'}),file.name.split('/').pop());
  }
  function downloadZip(files) { saveBlob(zipStore(files.map(file=>({name:file.name,data:fileBytes(file)}))),'ollo-files.zip'); }
  function fileMessageProse(raw){return marked.lexer(raw||'').filter(t=>t.type!=='code').map(t=>t.raw||'').join('').replace(/^- \[Скачать[^\n]*\]\(api\.php\?a=generated_file[^\n]*\)\s*$/gm,'').replace(/(?:^|\n)Готовые файлы:\s*$/u,'').trim();}
  function addFilesAction(el) {
    const body=el.querySelector('.a-body');if(!body)return;el.querySelector('.generated-files')?.remove();el.querySelector('.file-ready')?.remove();
    const messageId=Number(el._msg?.id||0),files=el._files||el._msg?.files||[],actions=el.querySelector('.msg-actions');if(!files.length||!actions)return;
    el.classList.add('file-response');const group=document.createElement('div');group.className='generated-files reference-artifacts';
    const makeRow=(name,ext,url,open)=>{const row=document.createElement('div');row.className='artifact-row';
      const main=document.createElement('button');main.type='button';main.className='artifact-main';main.innerHTML='<span class="artifact-symbol">'+I.zip+'</span><span class="artifact-label"><b></b><small></small></span>';main.querySelector('b').textContent=name;main.querySelector('small').textContent=ext;main.onclick=open;
      const download=document.createElement('a');download.className='artifact-download';download.href=url;download.download=name;download.textContent='Скачать';
      const menu=document.createElement('details');menu.className='artifact-options';const summary=document.createElement('summary');summary.setAttribute('aria-label','Действия с файлом '+name);summary.textContent='⌄';const option=document.createElement('button');option.type='button';option.textContent='Открыть справа';option.onclick=()=>{menu.open=false;open();};menu.append(summary,option);row.append(main,download,menu);return row;};
    let fileTarget=group;
    if(files.length>1){const zipUrl='api.php?a=generated_file&message_id='+messageId+'&zip=1';const openArchive=()=>{const dock=createPreviewDock('Файлы проекта · ZIP');if(!dock)return;for(const [index,file]of files.entries()){const button=document.createElement('button');button.className='btn sm';button.textContent=file.name;button.onclick=()=>openWorkbench(messageId,index);dock.content.append(button);}const download=document.createElement('a');download.className='btn sm';download.href=zipUrl;download.download='ollo-files.zip';download.textContent='Скачать ZIP';dock.actions.prepend(download);};group.append(makeRow('Файлы проекта','ZIP',zipUrl,openArchive));const contents=document.createElement('details');contents.className='artifact-contents';const summary=document.createElement('summary');summary.textContent='Файлы в архиве · '+files.length;contents.append(summary);group.append(contents);fileTarget=contents;}
    files.forEach((file,index)=>fileTarget.append(makeRow(file.name,(file.name.split('.').pop()||'FILE').toUpperCase(),'api.php?a=generated_file&message_id='+messageId+'&file='+index,()=>openWorkbench(messageId,index))));
    const all=document.createElement('a');all.className='artifact-download-all';all.href='api.php?a=generated_file&message_id='+messageId+'&zip=1';all.download='ollo-files.zip';all.innerHTML=I.down+' Скачать все · ZIP';group.append(all);el.insertBefore(group,actions);
  }

  const activityStyle=document.createElement('style');activityStyle.textContent=`
.msg.execution-step{margin-bottom:8px}.msg.execution-step .msg-actions{display:none}.msg.execution-step .activity-command{margin:6px 0}.msg.tool{margin-bottom:12px}.tool-error-note{font:12px/1.5 system-ui;color:#edaa85;margin:5px 0 10px;padding:0 8px;overflow-wrap:anywhere}.activity-log.task-log{border:0;border-radius:0;background:transparent;margin:12px 0 18px;color:var(--muted,#999);font:13px/1.6 system-ui}
.activity-log>summary{border-bottom:1px solid #333;padding:10px 0;cursor:pointer;display:flex;gap:9px;align-items:center}
.activity-log .task-title{flex:1}.activity-log .task-steps{padding:8px 0 8px 16px;border-left:1px solid #343434;margin:8px 0 8px 3px}
.activity-log .task-step{padding:6px 0;border:0;font:13px/1.6 system-ui}.activity-log .task-step.active{color:var(--text,#eee)}
.activity-log.complete .task-indicator{background:#888;animation:none}.activity-log .task-chevron{font-size:18px}.activity-log[open] .task-chevron{transform:rotate(90deg)}
.activity-command,.task-command{margin:10px 0;color:var(--muted,#aaa);font:13px/1.6 system-ui}.activity-command>summary,.task-command>summary{cursor:pointer;padding:8px 0;list-style:revert}.activity-command .term-card{margin-top:8px}.activity-purpose{padding:8px 14px;font:14px/1.6 system-ui}.activity-command pre{white-space:pre-wrap;overflow-wrap:anywhere}.pending .activity-command{padding:0 14px}.msg.tool{margin-top:4px;margin-bottom:10px}
@media(max-width:700px){.activity-log .task-steps{padding-left:10px}.activity-command>summary,.task-command>summary{min-height:36px;display:list-item}.activity-purpose{font-size:13px}}
`;document.head.append(activityStyle);
  function taskLabel(cmd) {
    const c=(cmd||'').trim();
    if(c.startsWith('ollo-code:')){try{const a=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(c.slice(10)),x=>x.charCodeAt(0))));if(a.edits?.length)return 'Правка файла '+a.edits[0].path;}catch{}}
    if (/^(pwd|whoami|hostname|uname|uptime|df|free)\b/.test(c)) return 'Проверка сервера';
    if (/^(find|ls|rg|grep|locate)\b/.test(c)) return 'Поиск файлов и нужных данных';
    if (/^(cat|head|tail|sed)\b/.test(c) && !/sed\s+-i/.test(c)) return 'Просмотр содержимого файлов';
    if (/\b(php -l|pytest|npm test|pnpm test|node --check)\b/.test(c)) return 'Проверка изменений';
    if (/\b(zip|tar|7z)\b/.test(c)) return 'Работа с архивом';
    if (/\b(curl|wget)\b/.test(c)) return 'Проверка сетевого ресурса';
    return 'Работа на сервере';
  }
  function durationLabel(ms) { const seconds=Math.max(1,Math.floor(ms/1000));return seconds<60?seconds+' с':Math.floor(seconds/60)+' мин '+seconds%60+' с'; }
  function activityText(text) {return String(text||'').replace(/```run[ \t]*\r?\n[\s\S]*?(?:```|$)/gi,'');}
  function createTaskLog(el) {
    const log=document.createElement('details');log.className='task-log activity-log';log.open=true;
    log.innerHTML='<summary><span class="task-indicator"></span><span class="task-title">Работаю над заданием</span><span class="task-elapsed" aria-hidden="true"></span><span class="task-chevron">›</span></summary><div class="task-steps"></div>';
    el.prepend(log);const steps=log.querySelector('.task-steps'),title=log.querySelector('.task-title');
    const start=Date.now();let active=null,ended=false,last='';
    const timer=setInterval(()=>{if(!log.isConnected){clearInterval(timer);return;}log.querySelector('.task-elapsed').textContent=durationLabel(Date.now()-start);},1000);
    return {
      step(text,detail='') { if(ended||text===last)return;last=text;if(active)active.classList.remove('active');const row=document.createElement(detail?'details':'div');row.className='task-step active';if(detail){const summary=document.createElement('summary');summary.textContent=text;const pre=document.createElement('pre');pre.textContent=detail;row.append(summary,pre);}else row.textContent=text;steps.appendChild(row);active=row; },
      title(text){if(!ended)title.textContent=text;},
      finish(text='Готово',error=false){if(ended)return;ended=true;clearInterval(timer);if(active)active.classList.remove('active');log.classList.add(error?'failed':'complete');title.textContent=error?text:text==='Остановлено'?'Остановлено':'Выполнено за '+durationLabel(Date.now()-start);log.querySelector('.task-elapsed').textContent='';log.open=false;},
    };
  }
  const isFileRequest=text=>/(?:файл|архив|\bzip\b|скача|отправ[ьи].*(?:код|данны)|пришли.*(?:код|данны))/iu.test(text || '');

  const LANG_EXT = { javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', python: 'py', py: 'py', php: 'php', html: 'html', xml: 'xml', css: 'css', scss: 'scss', json: 'json', bash: 'sh', sh: 'sh', shell: 'sh', zsh: 'sh', powershell: 'ps1', sql: 'sql', java: 'java', kotlin: 'kt', go: 'go', rust: 'rs', c: 'c', cpp: 'cpp', csharp: 'cs', ruby: 'rb', swift: 'swift', dart: 'dart', yaml: 'yml', yml: 'yml', markdown: 'md', md: 'md', svg: 'svg', nginx: 'conf', ini: 'ini', dockerfile: 'Dockerfile', jsx: 'jsx', tsx: 'tsx', vue: 'vue', lua: 'lua', text: 'txt', txt: 'txt', csv: 'csv', tsv: 'tsv', toml: 'toml', conf: 'conf', log: 'log', env: 'env' };

  function enhance(el, raw) {
    annotateFiles(el, raw);
    // команды для сервера: ```run ... ``` -> карточка-команда
    el.querySelectorAll('pre > code.language-run').forEach((c) => {
      const cmd = c.textContent.trim();
      const card = document.createElement('div');
      card.className = 'term-card cmd';
      card.innerHTML = `<div class="term-head"><span class="tdot"></span><span>команда для сервера</span><span class="spacer"></span><button type="button" class="cp">${I.copy}</button></div><pre class="term-body"><code></code></pre>`;
      card.querySelector('code').textContent = cmd;
      card.querySelector('.cp').onclick = (e) => copyText(cmd, e.currentTarget);
      const detail=document.createElement('details');detail.className='activity-command';const summary=document.createElement('summary');summary.textContent=taskLabel(cmd)+' · команда';detail.append(summary,card);c.closest('pre').replaceWith(detail);
    });
    const downloads=messageFiles(el);
    [...el.querySelectorAll('pre > code')].filter(c=>!c.closest('.term-card')).forEach((c,i)=>{ if(downloads[i])c.dataset.filename=downloads[i].name; });
    el.querySelectorAll('pre > code').forEach((c, i) => {
      if (c.dataset.hl) return; c.dataset.hl = 1;
      const lang = ((c.className.match(/language-([\w+#-]+)/) || [])[1] || '').toLowerCase();
      const src = c.textContent;
      try { if (lang && hljs.getLanguage(lang)) hljs.highlightElement(c); else c.innerHTML = hljs.highlightAuto(src).value; } catch {}
      const canPreview = ['html', 'svg'].includes(lang) || (/^\s*(<!doctype html|<html|<svg)/i.test(src) && ['', 'xml', 'markup'].includes(lang));
      const bar = document.createElement('div');
      bar.className = 'code-bar';
      bar.innerHTML = `<span class="lang">${esc(lang || 'код')}</span>${canPreview ? `<button type="button" class="pv">${I.eye}Просмотр</button>` : ''}<button type="button" class="dl">${I.down}Скачать</button><button type="button" class="cp">${I.copy}Копировать</button>`;
      bar.querySelector('.cp').onclick = (e) => copyText(src, e.currentTarget);
      bar.querySelector('.dl').onclick = () => downloadFile({name:detectName(c,lang,src,i),src});
      bar.querySelector('.pv')?.addEventListener('click', () => preview(src, lang));
      c.parentElement.prepend(bar);
    });
    el.querySelectorAll('img').forEach(img=>{if(!img.closest('button,a'))img.onclick=()=>openLightbox(img.src,img.src);});
    el.querySelectorAll('a').forEach((a) => { a.target = '_blank'; a.rel = 'noopener noreferrer';if(/предпросмотр сайта/iu.test(a.textContent)&&/^https?:/.test(a.href))a.onclick=e=>{e.preventDefault();openSitePreview(a.href);}; });
  }
  function preview(src, lang) {
    const d=createPreviewDock(lang==='svg'?'Изображение SVG':'Предпросмотр HTML');if(!d)return;
    const view=document.createElement('div');view.className='file-preview';d.content.append(view);renderFilePreview(view,lang==='svg'?'image.svg':'index.html',src);
    const copy=document.createElement('button');copy.className='btn sm';copy.textContent='Копировать';copy.onclick=e=>copyText(src,e.currentTarget);d.actions.prepend(copy);
  }
  $('#previewModal').onclick = (e) => { if (e.target.id === 'previewModal' || e.target.closest('[data-close]')) { $('#previewModal').hidden = true; $('#previewFrame').srcdoc = ''; } };

  // ---------- загрузка ----------
  async function boot() {
    const d = await api('bootstrap');
    S.user = d.user; S.plan = d.plan; S.models = d.models; S.chats = d.chats; S.projects = d.projects || [];
    S.servers = d.servers || []; S.sshAllowed = !!d.plan.ssh; S.maxServers = d.plan.max_servers || 3; S.limits = d.limits || S.limits;
    S.guest = !!d.user.guest;
    $('#userName').textContent = d.user.name;
    $('#avatar').textContent = (d.user.name || '?').trim()[0].toUpperCase();
    $('#menuEmail').textContent = d.user.email || 'Гость — без регистрации';
    $('#adminLink').hidden = !d.user.admin;
    $('#serversMenuItem').hidden = !S.sshAllowed;
    $('#srvPicker').hidden = !S.sshAllowed;
    applyGuest();
    renderPlan();
    const defaultId = d.default_model || 'claude-haiku-4.5';
    const defaultModel = S.models.find(m => m.model_id === defaultId && !m.locked);
    const migrated = store.get('ollo-default-model') === 'mini-20261022';
    const saved = migrated ? store.get('model') : null;
    S.model = S.models.find(m => m.model_id === saved && !m.locked) || defaultModel || S.models.find(m => !m.locked && m.kind === 'text') || S.models[0];
    if(defaultModel && !migrated) { store.set('model',defaultModel.model_id);store.set('ollo-default-model','mini-20261022'); }
    renderModels(); renderChats(); renderProjects(); renderSrvChip(); greet(); route();
  }
  function renderPlan() {
    const menu=$('#userMenu').querySelector('[data-act=plans]');if(menu)menu.textContent='Баланс и оплата';
    const p=S.plan,w=p.wallet||{tokens:0,reserved:0,available:0};
    $('#planName').textContent=S.guest?'Гость':S.user?.admin?'Администратор':new Intl.NumberFormat('ru').format(w.available)+' токенов';
    $('#usageBox').innerHTML=S.guest?'<p>Войдите, чтобы пополнить баланс и начать общение.</p>':`<div class="u-row"><span>Доступно токенов</span><b>${new Intl.NumberFormat('ru').format(w.available)}</b></div><div class="u-row"><span>В резерве</span><b>${new Intl.NumberFormat('ru').format(w.reserved)}</b></div><p>1 млн токенов — $1,80</p>${S.user?.admin?'<small>Режим администратора — без списаний</small>':''}`;
  }
  const bar = (label, used, limit) => { const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 100; return `<div class="u-bar"><div class="u-row"><span>${label}</span><b>${used} / ${limit}</b></div><i><s style="width:${pct}%"></s></i></div>`; };
  // гостевой режим: только текстовый генератор, вход/регистрация наверху
  function applyGuest() {
    document.body.classList.toggle('is-guest', S.guest);
    if(S.guest) $('#userName').textContent = 'Войти в аккаунт';
    if (S.guest) {
      $('#attachBtn').hidden = true; $('#srvPicker').hidden = true;
      $('#planName').textContent = 'Гость';
      $('#userMenu').querySelector('[data-act=plans]').hidden = true;
    }
  }
  function greet() { $('#greet').textContent = 'Что создадим сегодня?'; }

  // ---------- модели ----------
  let modelBrand=null,modelQuery='';
  const modelBrands=[['Claude','Anthropic','C'],['ChatGPT','OpenAI','G'],['Gemini','Google','G'],['Grok','xAI','X'],['DeepSeek','DeepSeek','D'],['Qwen','Alibaba','Q'],['GLM','Z.ai','Z'],['Kimi','Moonshot AI','K'],['MiniMax','MiniMax','M']];
  function placeModelMenu(){
    const menu=$('#modelMenu');if(menu.hidden)return;const r=$('#modelBtn').getBoundingClientRect(),gap=8,pad=12,width=Math.min(440,innerWidth-pad*2);const below=innerHeight-r.bottom-pad-gap,above=r.top-pad-gap;const down=below>=above;const height=Math.min(480,Math.max(below,above));
    Object.assign(menu.style,{position:'fixed',width:width+'px',maxHeight:height+'px',left:Math.max(pad,Math.min(innerWidth-width-pad,r.right-width))+'px',right:'auto',top:down?(r.bottom+gap)+'px':'auto',bottom:down?'auto':(innerHeight-r.top+gap)+'px'});
  }
  function renderModels() {
    $('#modelName').textContent=S.model?S.model.title:'Нет моделей';
    const old=$('#modelSearch');if(old)modelQuery=old.value;
    $('#modelMenu').innerHTML='<div id="modelOptions"></div>';
    renderModelOptions(modelQuery);placeModelMenu();
    const img=S.model&&S.model.kind==='image';$('#imgSize').hidden=!img;$('#attachBtn').hidden=img||S.guest;$('#srvPicker').hidden=img||S.guest||!S.sshAllowed;
    $('#input').placeholder=img?'Опишите картинку, которую нужно нарисовать…':document.body.classList.contains('empty')?'Чем могу помочь?':'Ответить…';
  }
  function renderModelOptions(query='') {
    modelQuery=query;const q=query.trim().toLocaleLowerCase();const box=$('#modelOptions');
    const header=modelBrand?'<button type="button" class="model-back" data-model-back>‹ Все модели</button><b class="model-panel-title">'+esc(modelBrand)+'</b>':'<div><span class="model-eyebrow">OLLO · МОДЕЛИ</span><b class="model-panel-title">Выберите помощника</b></div><span class="model-head-symbol">✦</span>';
    const matching=S.models.filter(m=>!q||[m.title,m.description,m.family,m.note].join(' ').toLocaleLowerCase().includes(q));
    let content='';
    if(!modelBrand&&!q){content=modelBrands.map(([name,company,icon])=>{const list=S.models.filter(m=>m.company===company);if(!list.length)return '';const selected=list.some(m=>m.model_id===S.model?.model_id);return `<button type="button" class="model-brand ${selected?'is-current':''}" data-model-brand="${esc(name)}"><span class="model-brand-icon">${icon}</span><span><b>${name}</b><small>${list.length} ${plural(list.length,'модель','модели','моделей')}</small></span><span class="model-brand-arrow">${selected?'✓':'↗'}</span></button>`;}).join('');}
    else{
      const company=modelBrands.find(x=>x[0]===modelBrand)?.[1];const list=matching.filter(m=>!modelBrand||m.company===company).sort((a,b)=>(a.catalog_rank||0)-(b.catalog_rank||0)||b.title.localeCompare(a.title,undefined,{numeric:true}));let family='';
      content=list.map(m=>{let title='';if(m.family!==family){family=m.family;title='<div class="mm-family">'+esc(family||'Модели')+'</div>';}const supported=m.chat_supported!==false;return title+`<button type="button" class="mm-item ${S.model?.model_id===m.model_id?'selected':''}" data-id="${esc(m.model_id)}" ${supported?'':'disabled'}><span><b>${esc(m.title)}</b><small>${esc(m.description||m.note||'Универсальная модель')}</small></span>${!supported?'<em>Другой режим</em>':S.model?.model_id===m.model_id?'<i>✓</i>':''}</button>`;}).join('')||'<p class="muted">Модели не найдены</p>';
    }
    box.innerHTML='<div class="model-panel-head">'+header+'</div><input id="modelSearch" type="search" aria-label="Поиск моделей" placeholder="Поиск моделей…"><div class="model-panel-list '+(!modelBrand&&!q?'model-brand-grid':'')+'">'+content+'</div>';
    const search=$('#modelSearch');search.value=query;search.oninput=e=>{const value=e.target.value;renderModelOptions(value);const input=$('#modelSearch');input.focus();input.setSelectionRange(value.length,value.length);placeModelMenu();};
    box.querySelectorAll('[data-model-brand]').forEach(button=>button.onclick=e=>{e.stopPropagation();modelBrand=button.dataset.modelBrand;renderModelOptions('');placeModelMenu();});box.querySelector('[data-model-back]')?.addEventListener('click',e=>{e.stopPropagation();modelBrand=null;renderModelOptions('');placeModelMenu();});
  }
  const catalogStyle=document.createElement('style');catalogStyle.textContent=`.model-menu{padding:16px!important;box-sizing:border-box;overflow-y:auto;border-radius:22px!important;border:1px solid var(--border,#3a3633);background:var(--surface,#222);box-shadow:0 24px 80px #0009;scrollbar-width:thin;scrollbar-color:#555 transparent}.model-panel-head{display:flex;align-items:center;gap:12px;padding:2px 2px 12px;font:14px system-ui}.model-eyebrow{display:block;font:600 9px system-ui;letter-spacing:1.8px;color:#ff8c5c;margin-bottom:5px}.model-panel-title{display:block;font:650 18px system-ui;letter-spacing:-.4px}.model-head-symbol{margin-left:auto;display:grid;place-items:center;width:35px;height:35px;border-radius:12px;background:#ff6a2b18;color:#ff8c5c;font-size:25px}.model-back{border:1px solid var(--border,#444);background:transparent;color:var(--muted,#aaa);padding:7px 9px;border-radius:9px;cursor:pointer;font:11px system-ui}.model-back:hover{color:#ff8c5c;border-color:#ff6a2b77}#modelSearch{box-sizing:border-box;width:100%;padding:11px 13px;margin:0 0 12px;background:var(--bg,#171717);border:1px solid var(--border,#444);border-radius:11px;color:var(--text,#eee);outline:none;font:12px system-ui}#modelSearch:focus{border-color:#ff6a2b;box-shadow:0 0 0 3px #ff6a2b12}.model-brand-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px}.model-brand{display:flex;align-items:center;gap:9px;width:100%;min-width:0;padding:11px 9px;border:1px solid var(--border,#373737);border-radius:12px;background:transparent;text-align:left;color:var(--text,#eee);cursor:pointer;min-height:62px;transition:background .15s,border-color .15s,transform .15s}.model-brand:hover{background:#ff6a2b0c;border-color:#ff6a2b88;transform:translateY(-1px)}.model-brand.is-current{border-color:#ff6a2b70;background:#ff6a2b0d}.model-brand b{font:600 12px system-ui;display:block}.model-brand small{font:10px system-ui;color:var(--muted,#999);display:block;margin-top:4px}.model-brand-icon{flex-shrink:0;width:30px;height:32px;display:grid;place-items:center;background:linear-gradient(145deg,#ff925022,#ff6a2b08);color:#ff9c70;border:1px solid #ff6a2b22;border-radius:10px;font:650 16px system-ui}.model-brand-arrow{margin-left:auto;color:var(--muted,#aaa);font:14px system-ui}.model-brand.is-current .model-brand-arrow{color:#ff8c5c}.mm-family{font:600 10px system-ui;letter-spacing:.7px;text-transform:uppercase;color:var(--muted,#999);padding:13px 9px 6px}.model-menu .mm-item{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;min-height:62px;padding:11px 12px;border:1px solid transparent;border-radius:12px;margin:3px 0;text-align:left}.model-menu .mm-item b{font:600 13px system-ui}.model-menu .mm-item small{display:block;font:11px/1.5 system-ui;color:var(--muted,#aaa);margin-top:4px;white-space:normal}.model-menu .mm-item:hover{background:#ff6a2b0b;border-color:#ff6a2b33}.model-menu .mm-item.selected{background:#ff6a2b16;border-color:#ff6a2b55}.model-menu .mm-item i{display:grid;place-items:center;flex-shrink:0;width:22px;height:22px;background:#ff6a2b;color:white;border-radius:50%;font:12px system-ui}.model-menu .mm-item:disabled{opacity:.45;cursor:default}.model-menu .mm-item em{white-space:normal;font:10px system-ui;max-width:65px}.model-brand:focus-visible,.model-back:focus-visible,.mm-item:focus-visible{outline:2px solid #ff6a2b;outline-offset:-2px}@media(max-width:420px){.model-menu{padding:12px!important}.model-brand{padding:10px 7px;gap:7px}.model-panel-title{font-size:16px}}`;document.head.append(catalogStyle);
  $('#modelBtn').onclick=e=>{e.stopPropagation();const menu=$('#modelMenu');menu.hidden=!menu.hidden;if(!menu.hidden){modelBrand=null;modelQuery='';renderModelOptions('');placeModelMenu();}};
  window.addEventListener('resize',placeModelMenu);
  $('#modelMenu').onclick = (e) => {
    e.stopPropagation();
    const b = e.target.closest('.mm-item'); if (!b) return;
    const m = S.models.find((x) => x.model_id === b.dataset.id);
    if(!m||m.chat_supported===false)return;
    if (m.locked) { openPlans(); return; }
    if (m.kind === 'image' && (S.pending.length || S.ctx.serverId)) { if (S.pending.length) { toast('Картинки рисуются только по тексту'); return; } }
    S.model = m; store.set('model', m.model_id); $('#modelMenu').hidden = true; renderModels(); $('#input').focus();
  };

  // ---------- серверы: выбор в композере ----------
  function renderSrvChip() {
    if (!S.sshAllowed) return;
    const srv = S.servers.find((s) => s.id === S.ctx.serverId);
    $('#srvName').textContent = srv ? srv.name : 'Сервер';
    $('#srvBtn').classList.toggle('active', !!srv);
  }
  $('#srvBtn').onclick = (e) => { e.stopPropagation(); renderSrvMenu(); $('#srvMenu').hidden = !$('#srvMenu').hidden; };
  function renderSrvMenu() {
    const cur = S.ctx.serverId;
    let html = `<button type="button" class="srv-item ${!cur ? 'active' : ''}" data-id="0"><span>Без сервера</span>${!cur ? '<i>✓</i>' : ''}</button>`;
    html += S.servers.map((s) => `<button type="button" class="srv-item ${s.id === cur ? 'active' : ''}" data-id="${s.id}"><span><b>${esc(s.name)}</b><small>${esc(s.username)}@${esc(s.host)}</small></span>${s.id === cur ? '<i>✓</i>' : ''}</button>`).join('');
    html += `<div class="srv-mode ${cur ? '' : 'off'}"><label><input type="checkbox" id="autoChk" ${S.ctx.auto ? 'checked' : ''}> Выполнять команды автоматически</label><small>Иначе каждую команду подтверждаете вручную</small></div>`;
    html += `<button type="button" class="srv-manage" data-manage>⚙ Управление серверами</button>`;
    $('#srvMenu').innerHTML = html;
  }
  $('#srvMenu').onclick = async (e) => {
    if (e.target.closest('[data-manage]')) { $('#srvMenu').hidden = true; openServers(); return; }
    if (e.target.id === 'autoChk' || e.target.closest('.srv-mode')) {
      const chk = $('#autoChk'); if (e.target !== chk) return;
      S.ctx.auto = chk.checked ? 1 : 0;
      if (S.chatId) api('chat_set', { chat_id: S.chatId, ssh_auto: S.ctx.auto }).catch(() => {});
      return;
    }
    const b = e.target.closest('.srv-item'); if (!b) return;
    S.ctx.serverId = +b.dataset.id;
    if (S.chatId) api('chat_set', { chat_id: S.chatId, server_id: S.ctx.serverId }).catch(() => {});
    renderSrvChip(); renderSrvMenu();
  };

  // ---------- список чатов и проектов ----------
  const pinnedIds = () => { try { return JSON.parse(store.get('ollo-pinned-'+(S.user?.id || 'guest')) || '[]'); } catch { return []; } };
  const searchQuery = () => ($('#sidebarSearch').value || '').trim().toLocaleLowerCase();
  const matchesSearch = text => String(text || '').toLocaleLowerCase().includes(searchQuery());
  function chatRow(c, nested = false) {
    const pinned = pinnedIds().includes(+c.id);
    return `<div class="chat-item ${nested ? 'nested-chat' : ''} ${+c.id === +S.chatId ? 'active' : ''} ${isChatActive(c.id) ? 'generating' : ''}" data-id="${c.id}"><a href="#chat/${c.id}" title="${esc(c.title)}"><span class="chat-row-title">${esc(c.title)}</span><svg class="chat-file-icon" viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6zM14 3v5h4"/></svg></a><button class="ci-btn" data-act="pin" title="${pinned ? 'Открепить' : 'Закрепить'}">${pinned ? '★' : '☆'}</button><button class="ci-btn" data-act="rename" title="Переименовать">✎</button><button class="ci-btn" data-act="del" title="Удалить">✕</button></div>`;
  }
  function isChatActive(id){return active.chatId && +active.chatId === +id;}
  function renderChats() {
    const pins = pinnedIds();
    const items = S.chats.filter(c => !c.project_id && !pins.includes(+c.id) && matchesSearch(c.title));
    $('#chatList').innerHTML = items.length ? items.map(c => chatRow(c)).join('') : '<div class="empty-list">'+(searchQuery() ? 'Ничего не найдено' : 'Здесь появятся ваши чаты')+'</div>';
    const pinned = S.chats.filter(c => pins.includes(+c.id) && matchesSearch(c.title));
    $('#pinnedWrap').hidden = !pinned.length;
    $('#pinnedList').innerHTML = pinned.map(c => chatRow(c)).join('');
    renderProjects();
  }
  function renderProjects() {
    const projects = S.projects.filter(p => matchesSearch(p.name) || S.chats.some(c => +c.project_id === +p.id && matchesSearch(c.title)));
    $('#projectsWrap').hidden = !projects.length;
    $('#projList').innerHTML = projects.map((p,i) => {
      const children = S.chats.filter(c => +c.project_id === +p.id && matchesSearch(c.title));
      const expanded = +p.id === +S.projectId || children.some(c => +c.id === +S.chatId) || !!searchQuery();
      return `<div class="proj-item ${+p.id === +S.projectId ? 'active' : ''}" data-id="${p.id}"><a href="#project/${p.id}" title="${esc(p.name)}"><span class="project-number">${i+1}</span><span class="project-row-title">${esc(p.name)}</span></a><button type="button" class="icon-btn project-chat-icon" data-project-chat="${p.id}" title="Новый чат" aria-label="Новый чат в проекте ${esc(p.name)}">${projectChatIcon}</button></div>${expanded ? '<div class="project-children">'+children.map(c => chatRow(c,true)).join('')+'</div>' : ''}`;
    }).join('');
  }
  $('#chatList').onclick = async (e) => {
    const btn = e.target.closest('.ci-btn'); if (!btn) { closeSidebarMobile(); return; }
    const id = +btn.closest('.chat-item').dataset.id; const chat = S.chats.find((c) => +c.id === id);
    if (btn.dataset.act === 'pin') { const pins = pinnedIds(); const next = pins.includes(id) ? pins.filter(x => x !== id) : [...pins, id]; store.set('ollo-pinned-'+(S.user?.id || 'guest'), JSON.stringify(next)); renderChats(); return; }
    if (btn.dataset.act === 'rename') { const t = prompt('Название чата', chat.title); if (!t) return; await api('rename', { id, title: t }); chat.title = t; renderChats(); if (+S.chatId === id) $('#chatTitle').textContent = t; }
    else if (confirm('Удалить чат «' + chat.title + '»?')) { await api('delete', { id }); S.chats = S.chats.filter((c) => +c.id !== id); renderChats(); if (+S.chatId === id) location.hash = ''; }
  };
  $('#projList').onclick = e => {const b=e.target.closest('[data-project-chat]');if(b){e.preventDefault();e.stopPropagation();createProjectChat(+b.dataset.projectChat,b);}closeSidebarMobile();};
  $('#pinnedList').onclick = e => $('#chatList').onclick(e);
  $('#projList').addEventListener('click', e => { if(e.target.closest('.ci-btn')) $('#chatList').onclick(e); });
  $('#sidebarSearch').oninput = renderChats;
  $('#historyBack').onclick = () => history.back();
  $('#historyForward').onclick = () => history.forward();
  $('#artifactsBtn').onclick = openLibrary;
  $('#shareBtn').onclick = async () => { try { await navigator.clipboard.writeText(location.href); toast('Ссылка скопирована. Доступ к чату остаётся у вашего аккаунта.'); } catch { toast('Не удалось скопировать ссылку'); } };
  document.addEventListener('keydown', e => { if((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if(innerWidth <= 860) document.body.classList.add('sb-open'); else document.body.classList.remove('sb-hidden'); $('#sidebarSearch').focus(); } });
  $('#newChat').onclick = () => { location.hash = ''; closeSidebarMobile(); $('#input').focus(); };
  $('#newProject').onclick = () => {location.hash='#projects';closeSidebarMobile();if(location.hash==='#projects')showProjectsPage();};
  $('#projectsNewChat').onclick=()=>$('#newChat').click();
  $('#createProjectBtn').onclick=()=>{if(S.guest){openAuth();return;}openProjectForm();};
  $('#projectsSearch').oninput=renderProjectsPage;

  function renderProjectsPage(){
    const grid=$('#projectsGrid'),query=$('#projectsSearch').value.trim().toLocaleLowerCase();grid.replaceChildren();
    const projects=S.projects.filter(p=>p.name.toLocaleLowerCase().includes(query));
    if(!projects.length){const empty=document.createElement('p');empty.className='muted projects-empty';empty.textContent=query?'Проекты не найдены':S.guest?'Войдите в аккаунт, чтобы создавать проекты и сохранять в них чаты.':'Пока нет проектов. Создайте первый проект.';grid.append(empty);return;}
    for(const p of projects){const card=document.createElement('article');card.className='project-grid-card';const link=document.createElement('a');link.href='#project/'+p.id;const name=document.createElement('h2');name.textContent=p.name;const note=document.createElement('small');const count=S.chats.filter(c=>+c.project_id===+p.id).length;note.textContent=count+' '+plural(count,'чат','чата','чатов');link.append(name,note);const button=document.createElement('button');button.type='button';button.className='icon-btn project-chat-icon';button.innerHTML=projectChatIcon;button.setAttribute('aria-label','Новый чат в проекте '+p.name);button.title='Новый чат';button.onclick=()=>createProjectChat(p.id,button);card.append(link,button);grid.append(card);}
  }
  function showProjectsPage(){S.chatId=null;S.projectId=0;S.ctx.projectId=0;document.body.classList.remove('empty','in-project');document.body.classList.add('in-projects-list');$('#projectHead').hidden=true;$('#messages').replaceChildren();$('#projectsPage').hidden=false;$('#chatTitle').textContent='Проекты';renderProjectsPage();}
  async function createProjectChat(id,button){
    if(S.busy){toast('Дождитесь завершения ответа');return;}if(button)button.disabled=true;
    try{const r=await api('project_chats_create',{project_id:id,titles:['Новый чат']});const chat=r.created[0];S.chats.unshift({...chat,model_id:S.model?.model_id||''});renderChats();location.hash='#chat/'+chat.id;$('#input').focus();}catch(e){toast(e.message);}finally{if(button?.isConnected)button.disabled=false;}
  }

  // ---------- роутинг ----------
  window.addEventListener('hashchange', route);
  async function route() {
    if(S.busy)active.rendering=false;
    if(location.hash==='#balance'&&S.user&&!S.guest){openPlans().catch(e=>toast(e.message));return;}
    if(active.chatId && S.busy) notifyBackground();
    $('#projectsPage').hidden=true;document.body.classList.remove('in-projects-list');
    $('#messages').innerHTML = ''; $('#projectHead').hidden = true;
    if(location.hash==='#projects'){showProjectsPage();return;}
    const mc = location.hash.match(/^#chat\/(\d+)/);
    const mp = location.hash.match(/^#project\/(\d+)/);
    if (mp) { S.chatId = null; await openProject(+mp[1]); return; }
    document.body.classList.remove('in-project');
    S.projectId = 0; renderProjects();
    if (!mc) { S.chatId = null; setEmpty(true); $('#chatTitle').textContent = ''; S.ctx = { projectId: 0, serverId: S.ctx.serverId, auto: S.ctx.auto }; renderChats(); renderSrvChip(); return; }
    S.chatId = +mc[1]; renderChats();
    if(active.chatId && +active.chatId===S.chatId) showActiveNotice();
    try {
      const requestedChat=S.chatId;const d = await api('chat&id=' + requestedChat);if(S.chatId!==requestedChat)return;S.chatVersion=d.version;S.chatVersionId=requestedChat;acceptTask(d.task);S.syncSignature=JSON.stringify([d.messages,d.pending]);
      $('#chatTitle').textContent = d.chat.title; setEmpty(false); if(S.model?.kind !== 'image') $('#input').placeholder = 'Ответить…';
      S.projectId = d.chat.project_id || 0;
      if(d.messages.length)queueMicrotask(showResume);
      S.ctx = { projectId: d.chat.project_id || 0, serverId: d.chat.server_id || 0, auto: d.chat.ssh_auto || 0 };
      renderSrvChip();
      let i = 0; const msgs = d.messages;
      while (i < msgs.length) { const end=Math.min(i+12,msgs.length);while(i<end)i=addGroup(msgs,i);if(i<msgs.length){await new Promise(resolve=>setTimeout(resolve,0));if(S.chatId!==requestedChat)return;} }
      if(d.pending)addPending(d.pending.cmd,!!+d.pending.danger);
      scrollDown(true);
    } catch (e) { toast(e.message); location.hash = ''; }
  }
  function setEmpty(on) { document.body.classList.toggle('empty', on); }
  function showActiveNotice(){
    if(!active.chatId || +active.chatId!==+S.chatId) return;
    const old=$('#activeNotice'); if(old) old.remove();
    const n=document.createElement('div'); n.id='activeNotice'; n.className='active-notice';
    n.setAttribute('role','status');
    n.innerHTML='<span class="thinking"><i></i><i></i><i></i></span><span>Ответ создаётся в этом чате. Можно переключиться — процесс продолжится, результат появится здесь.</span>';
    $('#messages').appendChild(n); scrollDown(true);
  }

  async function openProject(id) {
    S.projectId = id; renderProjects(); setEmpty(false);
    document.body.classList.add('in-project');
    try {
      const p = await api('project_get&id=' + id);
      S.ctx = { projectId: id, serverId: p.server_id || 0, auto: S.ctx.auto }; renderSrvChip();
      $('#chatTitle').textContent = p.name;
      $('#phName').textContent = p.name;
      const srv = S.servers.find((s) => s.id === p.server_id);
      $('#phServer').textContent = srv ? 'Сервер по умолчанию: ' + srv.name + ' (' + srv.username + '@' + srv.host + ')' : (p.instructions ? '' : 'Опишите задачу — чаты проекта будут учитывать его инструкции.');
      $('#phChats').innerHTML = p.chats.length ? p.chats.map((c) => `<a class="pc" href="#chat/${c.id}">${esc(c.title)}</a>`).join('') : '<span class="muted">В проекте пока нет чатов. Напишите внизу — создастся первый.</span>';
      $('#projectHead').hidden = false;
      $('#phNewChat').onclick=()=>createProjectChat(id,$('#phNewChat'));
      $('#phEdit').onclick = async()=>{try{openProjectForm(await api('project_get&id='+id));}catch(e){toast(e.message);}};
      $('#phDelete').onclick = async () => { if (confirm('Удалить проект «' + p.name + '»? Чаты сохранятся.')) { await api('project_delete', { id }); S.projects = S.projects.filter((x) => +x.id !== +id); renderProjects(); location.hash = ''; } };
      // создание нескольких чатов сразу
      const box = $('#phMultiBox'), inp = $('#phMultiInput'), cnt = $('#phMultiCount');
      box.hidden = true; inp.value = '';
      const lines = () => inp.value.split('\n').map((s) => s.trim()).filter(Boolean);
      const upd = () => { const n = lines().length; cnt.textContent = n ? n + ' ' + plural(n, 'чат', 'чата', 'чатов') : ''; };
      inp.oninput = upd; upd();
      $('#phMulti').onclick = () => { box.hidden = !box.hidden; if (!box.hidden) inp.focus(); };
      $('#phMultiCancel').onclick = () => { box.hidden = true; };
      $('#phMultiCreate').onclick = async () => {
        const titles = lines(); if (!titles.length) { toast('Введите хотя бы одно название'); return; }
        try {
          const r = await api('project_chats_create', { project_id: id, titles });
          (r.created || []).forEach((c) => S.chats.unshift({ id: c.id, title: c.title, project_id: id }));
          box.hidden = true; inp.value = ''; upd(); renderChats();
          toast(r.created.length + ' ' + plural(r.created.length, 'чат создан', 'чата создано', 'чатов создано'));
          openProject(id);
        } catch (e) { toast(e.message); }
      };
    } catch (e) { toast(e.message); location.hash = ''; }
  }


  const referenceChatStyle=document.createElement('style');referenceChatStyle.textContent=`
  .thread{scrollbar-gutter:stable both-edges}.messages{max-width:768px;padding-left:16px;padding-right:16px;box-sizing:border-box}.a-body img{max-width:152px;max-height:116px;object-fit:cover;border-radius:12px;cursor:zoom-in}.gen-img{max-width:152px}.gen-img img{max-height:116px;object-fit:cover}.pending .activity-purpose{margin:0;padding:9px 12px;font:13px/1.5 var(--sans)}.pending .activity-command{margin:0;padding:0 12px}.pending .activity-command>summary{padding:6px 0}.pending .pend-btns{padding:8px 12px}.pending .term-head{padding:8px 12px;font-size:12px}.msg.user{margin:24px 0 36px}.msg.user .bubble{background:var(--user-bubble);border-radius:14px;max-width:81%;padding:12px 16px;font:14px/1.45 var(--sans);color:var(--text)}.msg.assistant{margin-bottom:30px}.a-body{font-family:var(--serif);font-size:16px;line-height:1.45;color:var(--text)}.a-body p{margin:0 0 14px}.msg-actions{margin-top:10px;color:var(--muted)}.msg-actions .act{width:24px;height:24px}.msg.user .msg-actions{opacity:0}.msg.user:hover .msg-actions{opacity:1}.long-message .u-text{max-height:170px;overflow:hidden;mask-image:linear-gradient(#000 65%,transparent)}.long-message.expanded .u-text{max-height:none;mask-image:none}.show-message-more{border:0;background:none;color:var(--text);font:12px var(--sans);padding:10px 0 0;cursor:pointer}
  .activity-bundle{margin:20px 0 26px;font:13px/1.5 var(--sans);color:var(--muted)}.activity-bundle>summary{display:flex;align-items:center;gap:9px;list-style:none;cursor:pointer;min-height:30px;padding:2px 3px}.activity-bundle>summary::-webkit-details-marker{display:none}.bundle-dot{width:4px;height:4px;background:var(--accent);border-radius:50%;box-shadow:6px -4px 0 -1px #ff7a4280,-3px 5px 0 -1px #ff7a4255}.bundle-elapsed{font:12px var(--sans);color:var(--muted)}.bundle-arrow{font-size:16px;margin-left:2px}.activity-bundle[open]>summary .bundle-arrow{transform:rotate(90deg)}.bundle-rows{border:1px solid var(--border);border-radius:13px;overflow:hidden;margin:8px 0 0 32px}.bundle-rows .msg{margin:0!important}.bundle-rows .msg-actions,.bundle-rows .task-log,.activity-bundle + .msg.assistant > .task-log{display:none}.bundle-rows .execution-step .activity-command{display:none}.bundle-rows .execution-step .a-body{font:13px/1.5 var(--sans)!important;color:var(--muted);padding:9px 12px;border-bottom:1px solid var(--border)}.bundle-rows .execution-step .a-body p{margin:0}.bundle-rows .task-command{border:0;border-bottom:1px solid var(--border);border-radius:0;margin:0}.bundle-rows .task-command>summary{padding:9px 12px;color:var(--muted);font:13px/1.5 var(--sans)}.bundle-rows .task-command>summary::after{content:'›';float:none;margin-left:7px}.bundle-rows .task-command>summary::-webkit-details-marker{display:none}.bundle-rows .task-command:last-child{border-bottom:0}.bundle-rows .tool-error-note{padding:8px 12px;margin:0;border-bottom:1px solid var(--border)}.activity-bundle[data-running="1"] .bundle-dot{animation:pulse 1.4s ease-in-out infinite}.has-errors .bundle-title{color:var(--muted)}
  .msg.file-response .a-body{display:block}.msg.file-response .a-body pre{display:none}.generated-files.reference-artifacts{padding:0;border:0;background:none;border-radius:0;max-width:520px;display:flex;flex-direction:column;gap:9px;margin:16px 0 8px}.artifact-contents>summary{font:12px/1.5 var(--sans);color:var(--muted);cursor:pointer;padding:3px 0}.artifact-contents .artifact-row{margin-top:8px}.artifact-row{display:flex;align-items:center;gap:0;min-height:72px;border:1px solid var(--border);border-radius:13px;position:relative;background:var(--surface);padding:0 14px 0 20px}.artifact-main{display:flex;align-items:center;gap:20px;min-width:0;flex:1;text-align:left;border:0;background:none;color:var(--text);padding:0;cursor:pointer}.artifact-symbol{display:grid;place-items:center;flex:none;width:54px;height:54px;align-self:flex-end;border:1px solid var(--border-strong);border-bottom:0;border-radius:8px 8px 0 0;background:var(--surface-2);box-shadow:inset 1px 1px 1px #ffffff12;color:var(--muted);margin-top:17px}.artifact-symbol svg{width:19px;height:19px}.artifact-label{min-width:0;display:block}.artifact-label b{display:block;font:500 14px/1.4 var(--sans);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.artifact-label small{display:block;font:12px/1.5 var(--sans);color:var(--muted);margin-top:2px}.artifact-download{display:block;text-decoration:none;color:var(--text);background:var(--surface-2);border-radius:8px 0 0 8px;padding:7px 11px;font:12px var(--sans)}.artifact-options{position:relative;background:var(--surface-2);border-radius:0 8px 8px 0}.artifact-options>summary{list-style:none;padding:7px 9px;color:var(--muted);cursor:pointer;border-left:1px solid var(--border);font:12px var(--sans)}.artifact-options>summary::-webkit-details-marker{display:none}.artifact-options>button{position:absolute;right:0;top:34px;width:155px;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:10px;color:var(--text);z-index:5;cursor:pointer;text-align:left}.artifact-download-all{align-self:flex-start;display:flex;align-items:center;gap:6px;text-decoration:none;background:var(--surface-2);border-radius:7px;padding:7px 10px;font:12px var(--sans);color:var(--text)}.artifact-download-all svg{width:15px;height:15px}
  
  @media(max-width:860px){.msg.user .bubble{max-width:93%}.bundle-rows{margin-left:13px}.artifact-row{padding-left:12px}.artifact-main{gap:12px}.artifact-symbol{width:42px}.artifact-label b{font-size:13px}.artifact-download{padding:8px}.artifact-options>summary{padding:8px}.activity-bundle{margin:14px 0 22px}.srv-btn{max-width:100px}.artifact-row{min-height:70px}}
  `;document.head.append(referenceChatStyle);
  // ---------- группировка сообщений (ssh tool идёт отдельной карточкой) ----------
  function addGroup(msgs, i) {
    const m = msgs[i];
    if (m.kind === 'ssh') { addTermResult(m); return i + 1; }
    const el=addMessage(m);if(/```[ \t]*run[ \t]*\r?\n/i.test(m.content||''))el.classList.add('execution-step');return i + 1;
  }

  // ---------- рендер сообщений ----------
  function addMessage(msg, before) {
    const el = document.createElement('div'); el.className = 'msg ' + msg.role; el._msg = msg;el._files=msg.files || [];
    if (msg.role === 'user') {
      const list = msg.attachments || []; const isPic = (f) => f.kind === 'image';
      const files = [...list.filter(isPic), ...list.filter((f) => !isPic(f))].map((f) => fileCard(f)).join('');
      el.innerHTML = `${files ? `<div class="msg-files">${files}</div>` : ''}${msg.content ? '<div class="bubble"><div class="u-text"></div></div>' : ''}<div class="msg-actions"><span class="time">${esc(timeLabel(msg.created_at))}</span><button type="button" class="act" data-a="retry" title="Отправить заново">${I.retry}</button><button type="button" class="act" data-a="edit" title="Изменить">${I.edit}</button>${msg.content ? `<button type="button" class="act" data-a="copy" title="Копировать">${I.copy}</button>` : ''}</div>`;
      if(msg.content){const text=el.querySelector('.u-text');text.textContent=msg.content;if(msg.content.length>700||msg.content.split('\n').length>8){const bubble=el.querySelector('.bubble');bubble.classList.add('long-message');const more=document.createElement('button');more.type='button';more.className='show-message-more';more.textContent='Показать ещё';more.onclick=()=>{const expanded=bubble.classList.toggle('expanded');more.textContent=expanded?'Свернуть':'Показать ещё';};bubble.append(more);}}
    } else {
      el.innerHTML = `<div class="a-body"></div><div class="msg-actions"><button type="button" class="act" data-a="copy" title="Копировать">${I.copy}</button><button type="button" class="act" data-a="retry" title="Ответить заново">${I.retry}</button><span class="m-model"></span></div>`;
      const body = el.querySelector('.a-body');
      if (msg.image_path) { body.innerHTML = `<button type="button" class="gen-img" data-full="${esc(msg.image_path)}" data-dl="${esc(msg.image_path)}"><img src="${esc(msg.image_path)}" alt="Изображение"></button>`; el.querySelector('[data-a=copy]').outerHTML = `<a class="act" href="${esc(msg.image_path)}" download title="Скачать">${I.down}</a>`; }
      else if(msg.content){const prose=el._files.length?fileMessageProse(msg.content):msg.content;body.innerHTML=md(prose);enhance(body,prose);}
      const mm = S.models.find((x) => x.model_id === msg.model_id);
      el.querySelector('.m-model').textContent = mm ? mm.title : (msg.model_id || '');
      el._raw = msg.content;
      if (!msg.image_path) addFilesAction(el);
    }
    $('#messages').insertBefore(el, before || null); return el;
  }
  function collectActivity(tool,before){
    if(before)return;const parent=tool.parentElement;let intro=tool.previousElementSibling;
    if(!intro?.classList.contains('execution-step'))intro=null;
    const previous=(intro||tool).previousElementSibling;let bundle=previous?.classList.contains('activity-bundle')?previous:null;
    if(!bundle){bundle=document.createElement('details');bundle.className='activity-bundle';bundle.innerHTML='<summary><span class="bundle-dot"></span><span class="bundle-title"></span><span class="bundle-elapsed"></span><span class="bundle-arrow">›</span></summary><div class="bundle-rows"></div>';parent.insertBefore(bundle,intro||tool);const start=S.busy?S.activityStarted:Date.parse(String(intro?._msg?.created_at||tool._msg?.created_at||'').replace(' ','T'));if(Number.isFinite(start))bundle.dataset.started=String(start);}
    const rows=bundle.querySelector('.bundle-rows');if(intro)rows.append(intro);rows.append(tool);
    const count=rows.querySelectorAll('.msg.tool').length,errors=rows.querySelectorAll('.result.bad').length;
    bundle.querySelector('.bundle-title').textContent=S.busy?'Выполнение действий · '+count:(errors?'Действий: '+count+' · ошибок: '+errors:'Выполнено действий: '+count);
    bundle.classList.toggle('has-errors',!!errors);bundle.dataset.running=S.busy?'1':'0';bundle.open=S.busy||!!errors;
  }
  setInterval(()=>document.querySelectorAll('.activity-bundle[data-running="1"][data-started]').forEach(b=>b.querySelector('.bundle-elapsed').textContent=durationLabel(Date.now()-Number(b.dataset.started))),1000);
  function finishActivities(){document.querySelectorAll('.activity-bundle[data-running="1"]').forEach(bundle=>{bundle.dataset.running='0';const count=bundle.querySelectorAll('.msg.tool').length,errors=bundle.querySelectorAll('.result.bad').length;bundle.querySelector('.bundle-title').textContent=(errors?'Действий: '+count+' · ошибок: '+errors:'Выполнено действий: '+count);if(bundle.dataset.started)bundle.querySelector('.bundle-elapsed').textContent=durationLabel(Date.now()-Number(bundle.dataset.started));bundle.open=!!errors;});}
  // карточка результата выполнения команды
  function addTermResult(m, before) {
    const el = document.createElement('div'); el.className = 'msg tool';el._msg=m;
    const bad = (m.ssh_exit && m.ssh_exit !== 0) || m.rejected;
    el.innerHTML = `<div class="term-card result ${bad ? 'bad' : 'ok'}"><div class="term-head"><span class="tdot"></span><span>${m.rejected ? 'команда отклонена' : 'результат · код ' + (m.ssh_exit ?? 0)}</span><span class="spacer"></span><button type="button" class="cp">${I.copy}</button></div><div class="term-cmd">$ ${esc(displayCommand(m.ssh_cmd || ''))}</div><pre class="term-body"><code></code></pre></div>`;
    el.querySelector('code').textContent = m.content || '';
    el.querySelector('.cp').onclick = (e) => copyText('$ ' + displayCommand(m.ssh_cmd || '') + '\n' + (m.content || ''), e.currentTarget);
    const details=document.createElement('details');details.className='task-command';const summary=document.createElement('summary');summary.textContent=(m.rejected?'Действие отменено':m.ssh_exit===126?'Команда не запускалась':bad?'Команда завершилась с ошибкой':'Действие выполнено')+' · '+taskLabel(m.ssh_cmd);details.appendChild(summary);details.appendChild(el.firstElementChild);el.appendChild(details);if(bad&&!m.rejected){const note=document.createElement('p');note.className='tool-error-note';note.textContent=String(m.content||'Нет диагностического сообщения').split('\n').find(x=>x.trim())?.slice(0,240)||'Команда завершилась с ошибкой';el.append(note);}
    $('#messages').insertBefore(el, before || null);collectActivity(el,before); return el;
  }
  $('#messages').addEventListener('click', (e) => {
    const full = e.target.closest('[data-full]'); if (full) { openLightbox(full.dataset.full, full.dataset.dl); return; }
    const b = e.target.closest('.act[data-a]'); if (!b) return;
    const el = b.closest('.msg');
    if (b.dataset.a === 'copy') { copyText(el.classList.contains('user') ? el._msg.content : (el._raw || ''), b); return; }
    if (S.busy) { toast('Дождитесь окончания ответа'); return; }
    if (b.dataset.a === 'retry') { const u = el.classList.contains('user') ? el : prevUser(el); if (u) resend(u, u._msg.content); }
    if (b.dataset.a === 'edit') startEdit(el);
  });
  $('#messages').addEventListener('error', (e) => {
    const img = e.target; if (img.tagName !== 'IMG' || img.dataset.failed) return; img.dataset.failed = 1;
    const box = img.closest('.gen-img, .img-card'); if (!box) return;
    const div = document.createElement('div'); div.className = 'img-broken';
    div.innerHTML = `Изображение не удалось показать. <a href="${esc(img.getAttribute('src'))}" target="_blank" rel="noopener">Открыть файл</a>` + (box.classList.contains('gen-img') ? ' или нажмите ↻ ниже.' : '');
    box.replaceWith(div);
  }, true);
  function openLightbox(src, dl) {
    const d=createPreviewDock('Изображение');if(!d)return;
    const image=document.createElement('img');image.className='dock-image';image.src=src;image.alt='Предпросмотр изображения';d.content.append(image);
    const download=document.createElement('a');download.className='btn sm';download.textContent='Скачать';download.href=dl||src;download.download='';d.actions.prepend(download);
  }
  $('#lightbox').onclick = (e) => { if (!e.target.closest('.lb-bar a')) { $('#lightbox').hidden = true; $('#lbImg').src = ''; } };
  function prevUser(el) { let p = el.previousElementSibling; while (p && !p.classList.contains('user')) p = p.previousElementSibling; return p; }

  function startEdit(el) {
    const old = el.innerHTML;
    const box = document.createElement('div'); box.className = 'edit-box';
    box.innerHTML = `<textarea></textarea><div class="row-btns"><button type="button" class="btn sm" data-x>Отмена</button><button type="button" class="btn sm primary" data-s>Отправить</button></div>`;
    const ta = box.querySelector('textarea'); ta.value = el._msg.content || '';
    el.querySelector('.bubble')?.remove(); el.querySelector('.msg-actions').remove(); el.appendChild(box);
    const fit = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 400) + 'px'; }; ta.oninput = fit; fit(); ta.focus();
    box.querySelector('[data-x]').onclick = () => { el.innerHTML = old; if (el._msg.content) el.querySelector('.u-text').textContent = el._msg.content; };
    box.querySelector('[data-s]').onclick = () => { const t = ta.value.trim(); if (t || (el._msg.attachments || []).length) resend(el, t); };
    ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && matchMedia('(pointer:fine)').matches) { e.preventDefault(); box.querySelector('[data-s]').click(); } };
  }
  async function resend(userEl, text) {
    const m = userEl._msg;
    try { if (S.chatId && m.id) await api('truncate', { chat_id: S.chatId, from_id: m.id }); } catch (e) { toast(e.message); return; }
    let n = userEl; while (n) { const nx = n.nextElementSibling; n.remove(); n = nx; }
    const atts = m.attachments || [];
    if (S.model.kind === 'image') { if (atts.length) { toast('Для файлов выберите текстовую модель'); return; } sendImage(text); } else sendText(text, atts);
  }
  function scrollDown(force) { const t = $('#thread'); if (force || t.scrollHeight - t.scrollTop - t.clientHeight < 200) t.scrollTop = t.scrollHeight; }
  function errorBlock(text) {
    const el = document.createElement('div'); el.className = 'msg error';
    let extra = '';
    if (/регистрац/i.test(text)) extra = ' <a class="link" href="auth.php?mode=register">Зарегистрироваться</a>';
    else if (/тариф/i.test(text)) extra = ' <button type="button" class="link">Открыть тарифы</button>';
    el.innerHTML = `<div class="err">${esc(text)}${extra}</div>`;
    el.querySelector('button.link')?.addEventListener('click', openPlans); $('#messages').appendChild(el); scrollDown(true);
  }

  // ---------- файлы ----------
  const ARCH = ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'apk', 'jar'];
  const DOCS = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'rtf', 'csv'];
  function fileCard(f, { pending = false } = {}) {
    const ext = extOf(f.name); const isImg = f.kind === 'image' || (pending && /^(png|jpe?g|webp|gif)$/.test(ext));
    if (isImg && !pending && f.id) { const full = `api.php?a=file&id=${f.id}&view=1`; return `<button type="button" class="file-card img-card" data-full="${full}" data-dl="api.php?a=file&id=${f.id}" title="${esc(f.name)}"><img src="${full}" alt="${esc(f.name)}" loading="lazy"></button>`; }
    const thumb = f.preview || '';
    let sub = (ext || 'файл').toUpperCase() + (f.size ? ' · ' + humanSize(f.size) : ''), subCls = '';
    if (f.status === 'uploading') sub = f.progress >= 100 ? 'Читаю содержимое…' : `Загрузка ${f.progress || 0}%`;
    else if (f.status === 'error') { sub = f.error; subCls = 'bad'; }
    else if (f.kind === 'binary' && f.note) { sub = f.note; subCls = 'warn'; }
    const cls = ARCH.includes(ext) ? 'arch' : DOCS.includes(ext) ? 'doc' : '';
    const tag = pending || !f.id ? 'div' : 'a'; const href = tag === 'a' ? ` href="api.php?a=file&id=${f.id}" download title="Скачать"` : '';
    return `<${tag} class="file-card"${href} data-key="${esc(f.key || f.id)}"><span class="fc-icon ${cls}">${thumb ? `<img src="${esc(thumb)}" alt="">` : esc((ext || 'file').slice(0, 4))}</span><span class="fc-text"><b title="${esc(f.name)}">${esc(f.name)}</b><small class="${subCls}" title="${esc(sub)}">${esc(sub)}</small></span>${pending ? '<button type="button" class="fc-x" title="Убрать">✕</button>' : ''}${f.status === 'uploading' ? `<span class="fc-prog" style="width:${f.progress || 0}%"></span>` : ''}</${tag}>`;
  }
  const fileInput = $('#fileInput');
  $('#attachBtn').onclick = () => fileInput.click();
  fileInput.onchange = () => { addFiles([...fileInput.files]); fileInput.value = ''; };
  function addFiles(files) {
    if (!files.length) return;
    if (S.model?.kind === 'image') { toast('Файлы можно отправлять текстовым моделям'); return; }
    for (const file of files) {
      if (S.pending.length >= S.limits.max_files) { toast(`Не больше ${S.limits.max_files} файлов`); break; }
      if (file.size > S.limits.max_mb * 1048576) { toast(`«${file.name}» больше ${S.limits.max_mb} МБ`); continue; }
      const f = { key: 'k' + Math.random().toString(36).slice(2), name: file.name || 'image.png', size: file.size, status: 'uploading', progress: 0 };
      if (/^image\//.test(file.type)) f.preview = URL.createObjectURL(file);
      S.pending.push(f); upload(file, f);
    }
    renderPending();
  }
  function upload(file, f) {
    const xhr = new XMLHttpRequest(); const fd = new FormData(); fd.append('file', file, f.name);
    xhr.open('POST', 'api.php?a=upload'); xhr.setRequestHeader('X-CSRF', CSRF);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) { f.progress = Math.round((e.loaded / e.total) * 100); renderPending(); } };
    xhr.onload = () => { let j = {}; try { j = JSON.parse(xhr.responseText); } catch {} if (xhr.status === 413 && !j.error) j.error = 'Файл слишком большой'; if (xhr.status >= 400 || j.error) { f.status = 'error'; f.error = j.error || 'Ошибка'; } else Object.assign(f, j, { status: 'ready', preview: f.preview }); renderPending(); };
    xhr.onerror = () => { f.status = 'error'; f.error = 'Нет связи'; renderPending(); };
    f.xhr = xhr; xhr.send(fd);
  }
  function renderPending() { const row = $('#attRow'); row.hidden = !S.pending.length; row.innerHTML = S.pending.map((f) => fileCard(f, { pending: true })).join(''); updateSend(); }
  $('#attRow').onclick = (e) => {
    const x = e.target.closest('.fc-x'); if (!x) return;
    const key = x.closest('.file-card').dataset.key; const i = S.pending.findIndex((f) => (f.key || String(f.id)) === key); if (i < 0) return;
    const [f] = S.pending.splice(i, 1); f.xhr?.abort(); if (f.id && f.status === 'ready') api('unupload', { id: f.id }).catch(() => {}); renderPending();
  };
  let dragDepth = 0; const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; $('#dropZone').hidden = false; } });
  window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $('#dropZone').hidden = true; } });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth = 0; $('#dropZone').hidden = true; addFiles([...e.dataTransfer.files]); });
  $('#input').addEventListener('paste', (e) => { const files = [...(e.clipboardData?.files || [])]; if (files.length) { e.preventDefault(); addFiles(files); } });

  // ---------- композер ----------
  const input = $('#input');
  const autosize = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 280) + 'px'; };
  function currentTask(){return tasks.get(+S.chatId)||{status:'idle'};}
  function workingHere(){return (S.busy&&+active.chatId===+S.chatId)||['running','pausing'].includes(currentTask().status);}
  function acceptTask(task){if(!task?.chat_id)return;tasks.set(+task.chat_id,task);if(+task.chat_id===+S.chatId)updateSend();}
  function updateSend() {
    const uploading=S.pending.some(f=>f.status==='uploading'),draft=!!input.value.trim()||S.pending.some(f=>f.status==='ready');
    const state=currentTask().status,working=workingHere(),paused=['paused','interrupted'].includes(state);
    const mode=draft?'send':working?'pause':paused?'resume':'send',btn=$('#sendBtn');
    btn.dataset.mode=mode;btn.disabled=controlPending||uploading||(!draft&&!working&&!paused);
    btn.title=mode==='pause'?(state==='pausing'?'Пауза после текущего действия':'Приостановить после текущего действия'):mode==='resume'?'Продолжить задачу':working?'Добавить уточнение в текущее задание':'Отправить сообщение';
    btn.setAttribute('aria-label',btn.title);
    const paths={send:'<path d="M12 19V5m-6 6 6-6 6 6"/>',pause:'<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',resume:'<path d="m8 5 11 7-11 7z" fill="currentColor" stroke="none"/>'};
    btn.innerHTML='<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'+paths[mode]+'</svg>';
    const hint=$('#taskControlHint');if(hint){hint.hidden=!(working||paused||state==='waiting'||state==='queued');hint.textContent=state==='pausing'?'Приостанавливаю после текущего действия…':state==='waiting'?'Ожидает вашего подтверждения':paused?'Задание на паузе · нажмите ▶ для продолжения':state==='queued'?'Уточнение сохранено · продолжаю задание…':working?'В работе · можно отправить уточнение':'';}
    const pause=$('#taskPauseBtn');if(pause){pause.hidden=!(working&&draft);pause.disabled=controlPending||state==='pausing';}
  }
  input.addEventListener('input', () => { autosize(); updateSend(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer:fine)').matches) { e.preventDefault(); $('#composer').requestSubmit(); } });
  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    if(controlPending)return;
    if(S.busy&&!S.chatId){toast('Создаю чат… Уточнение осталось в поле ввода');return;}
    if(S.pending.some(f=>f.status==='uploading')){toast('Дождитесь загрузки файлов');return;}
    const draft=!!input.value.trim()||S.pending.some(f=>f.status==='ready');
    if(!draft && workingHere()){pauseTask().catch(e=>toast(e.message));return;}
    if(!draft && ['paused','interrupted'].includes(currentTask().status)){resumeTask().catch(e=>toast(e.message));return;}
    if(S.busy && +active.chatId!==+S.chatId){toast('В другом чате выполняется задание. Вернитесь в него или дождитесь завершения.');return;}
    if (S.pending.some((f) => f.status === 'uploading')) { toast('Дождитесь загрузки файлов'); return; }
    if(recognition){recognition.onresult=null;recognition.abort();}
    const text = input.value.trim(); const atts = S.pending.filter((f) => f.status === 'ready');
    if ((!text && !atts.length) || !S.model) return;
    input.value = ''; autosize(); S.pending = []; renderPending();
    const steer=workingHere()||['paused','interrupted','queued','waiting'].includes(currentTask().status);
    const request=steer?steerTask(text,atts):S.model.kind==='image'?sendImage(text):sendText(text,atts);
    Promise.resolve(request).catch(e=>{input.value=text;S.pending=atts;renderPending();autosize();updateSend();toast(e.message);});
  });
  function setBusy(on) { S.busy = on; document.body.classList.toggle('busy', on && active.chatId===S.chatId); updateSend(); if(on)$('#resumeResponse')?.remove();else showResume(); }
  function onChatCreated(id, title) {
    if (S.chatId === id) return;
    S.chatId = id;
    if (!S.chats.find((c) => +c.id === id)) S.chats.unshift({ id, title: title || 'Новый чат', project_id: S.ctx.projectId, server_id: S.ctx.serverId, ssh_auto: S.ctx.auto });
    history.replaceState(null, '', '#chat/' + id);
    $('#chatTitle').textContent = title || ''; if(S.model?.kind !== 'image') $('#input').placeholder = 'Ответить…'; $('#projectHead').hidden = true; document.body.classList.remove('in-project');
    renderChats();
  }
  function bumpChat() { const i = S.chats.findIndex((c) => +c.id === +S.chatId); if (i > 0) { S.chats.unshift(S.chats.splice(i, 1)[0]); renderChats(); } }

  // Preserve existing Markdown nodes while revealing the next part of a response.
  function patchStreamingNodes(parent, next) {
    let current = parent.firstChild;
    for (const desired of [...next.childNodes]) {
      if (!current) { parent.appendChild(desired); continue; }
      const after = current.nextSibling;
      if (current.nodeType !== desired.nodeType || current.nodeName !== desired.nodeName) {
        parent.replaceChild(desired, current);
      } else if (current.nodeType === 3) {
        if (current.nodeValue !== desired.nodeValue) current.nodeValue = desired.nodeValue;
      } else if (current.nodeType === 1) {
        for (const attr of [...current.attributes]) if (!desired.hasAttribute(attr.name)) current.removeAttribute(attr.name);
        for (const attr of [...desired.attributes]) if (current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
        patchStreamingNodes(current, desired);
      }
      current = after;
    }
    while (current) { const after = current.nextSibling; current.remove(); current = after; }
  }
  function renderStreaming(body, text) {
    const template = document.createElement('template');
    template.innerHTML = md(text + CARET).replace(CARET, '<span class="caret" aria-hidden="true"></span>');
    patchStreamingNodes(body, template.content);
  }

  // Render received network chunks on the next frame, without a typing backlog.
  function typer(body, onFrame) {
    let target = '', stopped = false, raf = 0;
    const paint = () => {
      raf = 0;
      if (stopped) return;
      renderStreaming(body, target); onFrame();
    };
    return {
      push(text) {
        if (stopped) return;
        target += text;
        if (!raf) {
          if (document.hidden) paint();
          else raf = requestAnimationFrame(paint);
        }
      },
      finish() {
        if (raf) cancelAnimationFrame(raf);
        if (!stopped) paint();
        return Promise.resolve();
      },
      stop() { stopped = true; if (raf) cancelAnimationFrame(raf); raf = 0; },
      get text() { return target; },
    };
  }

  async function sendText(text, atts = []) {
    if(S.guest){openAuth();return;}
    setEmpty(false);
    if (text || atts.length) { const uEl = addMessage({ role: 'user', content: text, attachments: atts.map((f) => ({ ...f })), created_at: new Date().toISOString() }); scrollDown(true); window._lastUser = uEl; }
    await streamAgent('send', { chat_id: S.chatId, model: S.model.model_id, text, attachments: atts.map((f) => f.id), project_id: S.ctx.projectId, server_id: S.ctx.serverId, ssh_auto: S.ctx.auto });
  }

  // единый обработчик потокового ответа (с поддержкой SSH-шагов)
  function notifyBackground(){
    if(S.chatId!==active.chatId) toast('Ответ продолжится в фоне — вернитесь в чат, чтобы увидеть результат');
  }
  async function streamAgent(action, payload) {
    S.activityStarted=Date.now();
    active.chatId=+((payload&&payload.chat_id)||S.chatId||0);
    active.rendering=true;
    setBusy(true);S.ctrl=new AbortController();active.ctrl=S.ctrl;
    let completed=false;let cur=null,body=null,tp=null,raw='',failed=null,fileMode=isFileRequest(payload.text),received=false;
    const preparing=new Set();
    const newBubble=async()=>{
      if(cur)await finalizeBubble();
      cur=addMessage({role:'assistant',content:'',model_id:S.model?.model_id || ''});cur.classList.add('streaming');
      body=cur.querySelector('.a-body');cur._journal=createTaskLog(cur);cur._journal.step('Задание принято');
      if(fileMode)cur.classList.add('file-response');
      tp=typer(body,()=>scrollDown());raw='';received=false;preparing.clear();scrollDown(true);
    };
    const finalizeBubble=async(immediate=false,outcome=null)=>{
      if(!cur)return;
      const current=cur;
      if(tp){if(immediate || fileMode)tp.stop();else {const active=tp,abort=()=>active.stop();S.ctrl.signal.addEventListener('abort',abort,{once:true});try{if(S.ctrl.signal.aborted)active.stop();else await active.finish();}finally{S.ctrl.signal.removeEventListener('abort',abort);}}}
      current.classList.remove('streaming');if(/```[ \t]*run[ \t]*\r?\n/i.test(raw))current.classList.add('execution-step');
      if(raw){if(!current._files?.length){body.innerHTML=md(raw);enhance(body,raw);}else {const prose=fileMessageProse(raw);body.innerHTML=md(prose);enhance(body,prose);}current._raw=raw;current._msg.content=raw;addFilesAction(current);}
      const hasFiles=!!current._files?.length;if(!hasFiles)current.classList.remove('file-response');
      current._journal.finish(outcome || (immediate?'Остановлено':hasFiles?'Файлы готовы':'Ответ готов'),!!outcome);
      if(!raw&&!hasFiles)current.remove();cur=null;body=null;tp=null;raw='';
    };
    await newBubble();
    try {
      const response=await fetch('api.php?a='+action,{method:'POST',signal:S.ctrl.signal,headers:{'Content-Type':'application/json','X-CSRF':CSRF},body:JSON.stringify(payload)});
      if(response.status===401){openAuth();throw new Error('Требуется вход');}
      if(!response.ok){const problem=await response.json().catch(()=>({}));throw new Error(problem.error||('HTTP '+response.status));}
      const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
      for(;;){
        const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true}).replace(/\r\n/g,'\n');let index;
        while((index=buffer.indexOf('\n\n'))>=0){
          const chunk=buffer.slice(0,index);buffer=buffer.slice(index+2);const event=(chunk.match(/^event: (.+)$/m)||[])[1],match=chunk.match(/^data: (.*)$/m);if(!event||!match)continue;const data=JSON.parse(match[1]);
          if(!active.rendering&&!['meta','task_state','done','error'].includes(event))continue;
          if(event==='meta') {if(!active.chatId)active.chatId=+data.chat_id;if(active.rendering)onChatCreated(data.chat_id,data.title);if(window._lastUser){window._lastUser._msg.id=data.user_msg_id;if(data.attachments?.length)window._lastUser._msg.attachments=data.attachments;window._lastUser=null;}}
          else if(event==='task_state')acceptTask(data);
          else if(event==='turn_discard'){if(tp)tp.stop();if(cur)cur.remove();cur=null;body=null;tp=null;raw='';}
          else if(event==='turn_start') {clearRunStatus();if(!cur)await newBubble();cur._journal.title('Обрабатываю задание');}
          else if(event==='delta') {
            if(!cur)await newBubble();raw+=data.t;
            if(!received){received=true;cur._journal.step(fileMode?'Подготавливаю файлы':'Получаю ответ');}
            const named=[...raw.matchAll(/^(?:`{3,}|~{3,})[^\n]*?(?:filename|file|path)\s*=\s*["']([^"'\n]+)["']/gm)].map(m=>m[1]);
            if(named.length || fileMode){fileMode=true;cur.classList.add('file-response');tp.stop();cur._journal.title('Думаю… · готовлю файлы');for(const name of named)if(!preparing.has(name)){preparing.add(name);cur._journal.step('Подготавливаю файл '+name);}}
            else {const visible=activityText(raw);if(/```run/i.test(raw)){tp.stop();body.innerHTML=md(visible);cur._journal.title('Готовлю действие на сервере');}else tp.push(data.t);}
          }
          else if(event==='turn_done') {
            if(cur){cur._msg.id=data.id;cur._files=data.files || [];cur._msg.files=cur._files;
              for(const file of cur._files)cur._journal.step('Готов файл '+file.name);
              if(cur._files.length)cur._journal.step('Ссылки на файлы и ZIP подготовлены');}
            await finalizeBubble();
          }
          else if(event==='run_status'){if(cur)cur._journal.step(data.t);else statusLine(data.t);}
          else if(event==='run_result'){clearRunStatus();$('#messages').querySelectorAll('[data-pending-action]').forEach(x=>x.remove());await finalizeBubble();addTermResult({content:data.out,ssh_cmd:data.cmd,ssh_exit:data.exit,rejected:data.rejected});scrollDown(true);}
          else if(event==='web_preview'){openSitePreview(data.url,data.image,!!data.mobile);}
          else if(event==='run_pending'){await finalizeBubble();addPending(data.cmd,data.danger);}
          else if(event==='done'){if(active.rendering){finishActivities();clearRunStatus();}completed=true;if(data.limits){S.plan={...S.plan,...data.limits};renderPlan();}}
          else if(event==='error')failed=data.error;
        }
      }
    }catch(error){if(error.name!=='AbortError')failed=error.message||'Не удалось завершить ответ. Попробуйте ещё раз.';}
    if(!completed && !S.ctrl.signal.aborted && !failed)failed='Соединение с чатом прервано. Проверяю состояние задания на сервере…';
    if(active.rendering){finishActivities();clearRunStatus();await finalizeBubble(S.ctrl.signal.aborted,failed?'Не удалось завершить задание':null);}else{tp?.stop();cur?.remove();cur=null;}
    if(failed)$('#messages').querySelectorAll('[data-pending-action] button').forEach(b=>b.disabled=false);
    if(failed || S.ctrl.signal.aborted){if(failed){if(active.rendering)errorBlock(failed);else toast('Задание в другом чате прервано. Его можно продолжить в том чате.');}showResume();}setBusy(false);
    const wasActive=active.chatId; active.chatId=null; active.ctrl=null;
    if(+wasActive===+S.chatId)$('#activeNotice')?.remove();
    if(+wasActive!==+S.chatId && !failed) toast('Ответ готов в чате');
    renderChats(); bumpChat();scheduleTaskPoll(100);
  }
  function clearRunStatus(){document.querySelectorAll('#messages .run-status').forEach(x=>x.remove());}
  function statusLine(text) {
    let div=$('#messages').querySelector('.run-status');if(!div){div=document.createElement('div');div.className='run-status';div.setAttribute('role','status');$('#messages').append(div);}
    div.innerHTML='<span class="thinking"><i></i><i></i><i></i></span><span></span>';div.lastElementChild.textContent=text;scrollDown(true);
  }
  function displayCommand(cmd){try{if(cmd.startsWith('ollo-code:')){const a=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(cmd.slice(10)),c=>c.charCodeAt(0))));if(a.edits?.length)return 'Проект: '+a.project_path+'\n'+a.edits.map(e=>'Файл: '+e.path+'\nОперация: '+e.operation+'\nБыло:\n'+(e.old_text||'—')+'\nСтанет:\n'+e.new_text).join('\n\n');return 'Проект: '+a.project_path+'\nДействие: '+(a.action||'command')+'\n'+(a.command||'');}}catch{}return cmd;}
  function addPending(cmd, danger) {
    $('#resumeResponse')?.remove();
    const awaiting=$('#messages').querySelector('.execution-step:last-child .task-title');if(awaiting)awaiting.textContent='Ожидает подтверждения';
    $('#messages').querySelectorAll('[data-pending-action]').forEach(x=>x.remove());
    const el = document.createElement('div'); el.className = 'msg tool';el.dataset.pendingAction='true';
    el.innerHTML = `<div class="term-card pending ${danger ? 'danger' : ''}"><div class="term-head"><span class="tdot"></span><span>${danger ? '⚠ Требуется подтверждение' : 'Следующий шаг'}</span></div><p class="activity-purpose">${esc(taskLabel(cmd))}. ${danger ? 'Действие может существенно изменить данные или работу сервера. Изучите команду перед подтверждением.' : 'Для выполнения требуется ваше разрешение.'}</p><details class="activity-command"><summary>Посмотреть команду</summary><pre class="term-cmd">${esc(displayCommand(cmd))}</pre></details><div class="pend-btns"><button type="button" class="btn sm primary" data-run>Выполнить</button><button type="button" class="btn sm" data-skip>Отклонить</button></div></div>`;
    el.querySelector('[data-run]').onclick = () => { el.querySelectorAll('button').forEach(b=>b.disabled=true); streamAgent('ssh_exec', { chat_id: S.chatId, cmd, approve: true }); };
    el.querySelector('[data-skip]').onclick = () => { el.querySelectorAll('button').forEach(b=>b.disabled=true); streamAgent('ssh_exec', { chat_id: S.chatId, cmd, approve: false }); };
    $('#messages').appendChild(el); scrollDown(true);
  }

  async function sendImage(text) {
    setEmpty(false);
    const uEl = addMessage({ role: 'user', content: text, created_at: new Date().toISOString() }); scrollDown(true);
    const el = addMessage({ role: 'assistant', content: '', model_id: S.model.model_id }); el.classList.add('streaming');
    el.querySelector('.a-body').innerHTML = '<div class="img-wait"><span class="thinking"><i></i><i></i><i></i></span> Рисую изображение…</div>';
    scrollDown(true); setBusy(true);
    try {
      const d = await api('image', { chat_id: S.chatId, model: S.model.model_id, text, size: $('#imgSize').value, project_id: S.ctx.projectId });
      el.remove(); onChatCreated(d.chat_id, text.slice(0, 48)); uEl._msg.id = d.user_msg_id;
      addMessage({ ...d.message, model_id: S.model.model_id }); scrollDown(true);
      S.plan = { ...S.plan, ...d.limits }; renderPlan();
    } catch (e) { el.remove(); if (e.data?.chat_id) { onChatCreated(e.data.chat_id, text.slice(0, 48)); uEl._msg.id = e.data.user_msg_id; } errorBlock(e.message); }
    finally { setBusy(false); bumpChat(); }
  }

  // ---------- проекты: форма ----------
  function fillServerSelect(sel, current) {
    sel.innerHTML = '<option value="0">— без сервера —</option>' + S.servers.map((s) => `<option value="${s.id}" ${s.id === current ? 'selected' : ''}>${esc(s.name)} (${esc(s.host)})</option>`).join('');
  }
  function openProjectForm(p) {
    const f = $('#projectForm'); f.reset();
    f.id.value = p ? p.id : ''; f.name.value = p ? p.name : ''; f.instructions.value = p ? (p.instructions || '') : '';
    $('#pmTitle').textContent = p ? 'Проект: ' + p.name : 'Новый проект';
    $('#pmServerL').hidden = !S.sshAllowed; if (S.sshAllowed) fillServerSelect(f.server_id, p ? p.server_id : 0);
    $('#projectModal').hidden = false; setTimeout(() => f.name.focus(), 50);
  }
  $('#projectForm').onsubmit = async (e) => {
    e.preventDefault(); const f = e.target;
    const payload = { id: +f.id.value || 0, name: f.name.value.trim(), instructions: f.instructions.value, server_id: S.sshAllowed ? +f.server_id.value : 0 };
    if (!payload.name) return;
    try {
      const r = await api('project_save', payload);
      const ex = S.projects.find((x) => +x.id === r.id);
      if (ex) { ex.name = r.name; ex.server_id = r.server_id; } else S.projects.unshift({ id: r.id, name: r.name, server_id: r.server_id });
      renderProjects();if(location.hash==='#projects')renderProjectsPage(); $('#projectModal').hidden = true;
      location.hash = '#project/' + r.id;
      if (location.hash === '#project/' + r.id) openProject(r.id);
    } catch (e) { toast(e.message); }
  };

  // ---------- серверы ----------
  async function openServers() {
    $('#userMenu').hidden = true;
    try { const d = await api('servers'); if (!d.allowed) { toast('SSH доступен на тарифе выше'); openPlans(); return; } S.servers = d.servers; S.maxServers = d.max; }
    catch (e) { toast(e.message); return; }
    renderServers(); $('#serversModal').hidden = false;
  }
  function renderServers() {
    $('#srvCards').innerHTML = S.servers.length ? S.servers.map((s) => `<div class="srv-card" data-id="${s.id}"><div class="sc-main"><b>${esc(s.name)}</b><small>${esc(s.username)}@${esc(s.host)}:${s.port}</small>${s.status === 'ok' ? '<span class="pill ok">подключался</span>' : s.status === 'fail' ? '<span class="pill bad">ошибка связи</span>' : ''}</div><div class="sc-btns"><button type="button" class="btn sm" data-edit>Изменить</button><button type="button" class="btn sm danger" data-del>Удалить</button></div></div>`).join('') : '<p class="muted">Серверы ещё не добавлены.</p>';
    $('#srvAdd').disabled = S.servers.length >= S.maxServers && !S.user.admin;
    $('#srvAdd').textContent = $('#srvAdd').disabled ? `Лимит серверов: ${S.maxServers}` : '+ Добавить сервер';
  }
  $('#srvCards').onclick = async (e) => {
    const card = e.target.closest('.srv-card'); if (!card) return; const id = +card.dataset.id; const s = S.servers.find((x) => x.id === id);
    if (e.target.closest('[data-edit]')) editServer(s);
    else if (e.target.closest('[data-del]') && confirm('Удалить сервер «' + s.name + '»?')) { await api('server_delete', { id }); S.servers = S.servers.filter((x) => x.id !== id); renderServers(); renderSrvChip(); if (S.ctx.serverId === id) S.ctx.serverId = 0; renderSrvChip(); }
  };
  $('#srvAdd').onclick = () => editServer(null);
  function editServer(s) {
    const f = $('#serverForm'); f.reset(); $('#seResult').hidden = true;
    f.id.value = s ? s.id : ''; f.name.value = s ? s.name : ''; f.host.value = s ? s.host : ''; f.port.value = s ? s.port : 22; f.username.value = s ? s.username : 'root';
    $('#seTitle').textContent = s ? 'Сервер: ' + s.name : 'Новый сервер';
    const auth = s ? s.auth_type : 'password'; setAuthMode(auth);
    f.secret.placeholder = s ? 'оставьте пустым, чтобы не менять' : 'пароль от сервера';
    $('#serverEditModal').hidden = false; setTimeout(() => f.name.focus(), 50);
  }
  function setAuthMode(mode) {
    document.querySelectorAll('#serverEditModal .seg[data-set=auth] button').forEach((b) => b.classList.toggle('on', b.dataset.v === mode));
    $('#passL').hidden = mode === 'key'; $('#keyL').hidden = mode !== 'key'; $('#serverForm').dataset.auth = mode;
  }
  document.querySelector('#serverEditModal .seg[data-set=auth]').onclick = (e) => { const b = e.target.closest('button[data-v]'); if (b) setAuthMode(b.dataset.v); };
  function serverPayload() {
    const f = $('#serverForm'); const auth = f.dataset.auth || 'password';
    return { id: +f.id.value || 0, name: f.name.value.trim(), host: f.host.value.trim(), port: +f.port.value || 22, username: f.username.value.trim() || 'root', auth_type: auth, secret: auth === 'key' ? f.secret_key.value.trim() : f.secret.value };
  }
  $('#serverForm').onsubmit = async (e) => {
    e.preventDefault(); const p = serverPayload(); if (!p.name || !p.host) { toast('Укажите название и адрес'); return; }
    try { const r = await api('server_save', p); const ex = S.servers.find((x) => x.id === r.id); if (ex) Object.assign(ex, r); else S.servers.push(r); renderServers(); renderSrvMenu(); renderSrvChip(); $('#serverEditModal').hidden = true; toast('Сервер сохранён'); }
    catch (e) { toast(e.message); }
  };
  $('#seTest').onclick = async () => {
    const p = serverPayload(); if (!p.name || !p.host) { toast('Заполните адрес'); return; }
    const res = $('#seResult'); res.hidden = false; res.className = 'se-result'; res.textContent = 'Проверяю подключение…';
    try {
      let id = +$('#serverForm').id.value;
      if (!id || p.secret) { const saved = await api('server_save', p); id = saved.id; $('#serverForm').id.value = id; const ex = S.servers.find((x) => x.id === id); if (ex) Object.assign(ex, saved); else S.servers.push(saved); renderServers(); }
      const r = await api('server_test', { id });
      res.className = 'se-result ' + (r.ok ? 'ok' : 'bad'); res.textContent = (r.ok ? '✓ ' : '✗ ') + r.message;
    } catch (e) { res.className = 'se-result bad'; res.textContent = e.message; }
  };

  // ---------- тарифы ----------
  async function openPlans() {
    if(S.guest){openAuth();return;}$('#modelMenu').hidden=true;$('#userMenu').hidden=true;
    const d=await api('wallet');S.plan.wallet=d.wallet;renderPlan();
    const grid=$('#plansGrid');grid.style.display='block';grid.innerHTML=`<div class="wallet-summary"><small>Доступно</small><h3>${new Intl.NumberFormat('ru').format(d.wallet.available)} токенов</h3><p>1 000 000 токенов = <b>$1,80</b></p><p class="muted">Входящие + исходящие токены. Без подписки и срока действия.</p>${d.wallet.reserved?'<p>Зарезервировано на запросы: '+new Intl.NumberFormat('ru').format(d.wallet.reserved)+'</p>':''}</div><label>Сколько миллионов токенов купить<input id="buyMillions" type="number" min="1" max="1000" step="1" value="1" style="width:100%;padding:12px;border:1px solid #555;border-radius:10px;background:transparent;color:inherit;margin:8px 0"></label><p id="buyTotal"></p><div style="display:flex;gap:10px;flex-wrap:wrap"><button type="button" class="btn primary" id="buyCard" ${d.providers.card?'':'disabled'}>Оплатить картой</button><button type="button" class="btn" id="buyCrypto" ${d.providers.crypto?'':'disabled'}>Криптовалюта</button></div><p class="muted">${!d.providers.card?'Оплата картой пока не подключена. ':''}${!d.providers.crypto?'Криптовалюта пока не подключена.':''}</p><div id="checkoutResult" role="status"></div><button type="button" class="btn sm" id="walletRefresh">Обновить баланс</button><h3>История операций</h3><div id="walletHistory"></div>`;
    const millions=$('#buyMillions'),total=$('#buyTotal');const update=()=>{const n=Number(millions.value);total.textContent=Number.isInteger(n)&&n>=1&&n<=1000?'К оплате: $'+(n*1.8).toFixed(2)+(d.providers.card?' · '+(n*1.8*d.usd_kzt).toLocaleString('ru',{minimumFractionDigits:2,maximumFractionDigits:2})+' ₸':''):'Введите целое число от 1 до 1000';};millions.oninput=update;update();
    $('#walletHistory').innerHTML=d.history.length?d.history.map(x=>`<div style="padding:10px 0;border-bottom:1px solid #444"><b>${x.delta>0?'+':''}${new Intl.NumberFormat('ru').format(x.delta)}</b> · ${esc(x.note)}<br><small class="muted">${esc(x.created_at)}</small></div>`).join(''):'Операций пока нет';
    let attempt=crypto.getRandomValues(new Uint8Array(16)).reduce((a,b)=>a+b.toString(16).padStart(2,'0'),'');let busy=false;
    const buy=async(provider)=>{if(busy)return;const n=Number(millions.value);if(!Number.isInteger(n)||n<1||n>1000){toast('Введите целое число миллионов');return;}busy=true;const box=$('#checkoutResult');box.textContent='Создаю счёт…';try{const r=await api('payment_create',{provider,millions:n,attempt});box.replaceChildren();const link=document.createElement('a');link.className='btn primary';link.href=r.url;link.target='_blank';link.rel='noopener noreferrer';link.textContent='Перейти к оплате';box.append(link);const note=document.createElement('p');note.textContent='После оплаты вернитесь и нажмите «Обновить баланс». Токены начислятся после подтверждения платежа.';box.append(note);}catch(e){box.textContent=e.message;}finally{busy=false;}};
    $('#buyCard').onclick=()=>buy('card');$('#buyCrypto').onclick=()=>buy('crypto');$('#walletRefresh').onclick=()=>openPlans().catch(e=>toast(e.message));
    $('#payInfo').replaceChildren();$('#plansModal').querySelector('h2').textContent='Баланс и оплата';$('#plansModal').hidden=false;
  }

  // ---------- меню, модалки, сайдбар ----------
  function closeModal(sel) { $(sel).hidden = true; }
  document.querySelectorAll('.modal').forEach((m) => { if (m.id === 'previewModal' || m.id === 'lightbox') return; m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) m.hidden = true; }); });
  $('#userBtn').onclick = (e) => { e.stopPropagation(); if(S.guest) { openAuth(); return; } $('#userMenu').hidden = !$('#userMenu').hidden; };
  $('#userMenu').onclick = (e) => { const a = e.target.closest('[data-act]')?.dataset.act; if(a === 'login' || a === 'register') openAuth(a); if(a === 'connections') { $('#userMenu').hidden=true; $('#connectionsModal').hidden=false; } if (a === 'plans') openPlans().catch(e=>toast(e.message)); if (a === 'settings') { $('#userMenu').hidden = true; $('#settingsModal').hidden = false; } if (a === 'servers') openServers(); };
  $('#settingsBtn').onclick = () => { $('#settingsModal').hidden = false; };
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.model-picker')) $('#modelMenu').hidden = true;
    if (!e.target.closest('.srv-picker')) $('#srvMenu').hidden = true;
    if (!e.target.closest('.sb-bottom')) $('#userMenu').hidden = true;
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelectorAll('.modal').forEach((m) => (m.hidden = true)); });
  const mobile = () => matchMedia('(max-width: 860px)').matches;
  $('#sbClose').onclick = () => { if (mobile()) closeSidebarMobile(); else { document.body.classList.add('sb-hidden'); store.set('sb', 'hidden'); } };
  $('#sbOpen').onclick = () => { if (mobile()) document.body.classList.add('sb-open'); else { document.body.classList.remove('sb-hidden'); store.set('sb', ''); } };
  $('#scrim').onclick = closeSidebarMobile;
  function closeSidebarMobile() { document.body.classList.remove('sb-open'); }
  if (store.get('sb') === 'hidden') document.body.classList.add('sb-hidden');
  setInterval(() => document.querySelectorAll('.msg.user .time').forEach((t) => { const m = t.closest('.msg')._msg; if (m.created_at) t.textContent = timeLabel(m.created_at); }), 60000);

  if(window.ollo?.desktop){
    const refreshAccount=async()=>{S.chatId=null;S.projectId=null;S.ctx={projectId:0,serverId:0,auto:0};$('#messages').replaceChildren();location.hash='';await boot();$('#userMenu').querySelector('[data-act=plans]').hidden=!!S.guest;document.querySelectorAll('.desktop-guest').forEach(el=>el.hidden=!S.guest);document.querySelectorAll('.desktop-account').forEach(el=>el.hidden=!!S.guest);};
    for(const form of [$('#authForm'),...document.querySelectorAll('.logout-form')]){form.addEventListener('submit',async e=>{e.preventDefault();const button=form.querySelector('[type=submit]');if(button?.disabled)return;if(button)button.disabled=true;try{const data=new URLSearchParams(new FormData(form));const url=new URL(form.getAttribute('action')||'auth.php',location.href);const r=await fetch(url.href,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},body:data});const result=await r.json();if(!result.ok)throw new Error(result.error||'Не удалось войти');await refreshAccount();$('#authModal').hidden=true;}catch(error){toast(error.message||'Не удалось войти. Повторите попытку.');}finally{if(button)button.disabled=false;}});}
  }
  if(location.hash==='#login' || location.hash==='#register' || $('#authModal').dataset.error==='1') openAuth(location.hash==='#register'?'register':'login');
  if($('#authNotice')) toast($('#authNotice').textContent);
  // Keep the composer above the mobile keyboard without scrolling the whole page.
  const viewport = window.visualViewport;
  let viewportBaseline=viewport?.height || innerHeight, viewportWidth=innerWidth;
  const syncViewport = () => {
    if(mobile() && viewport) {
      if(viewportWidth!==innerWidth) { viewportWidth=innerWidth;viewportBaseline=viewport.height; }
      else viewportBaseline=Math.max(viewportBaseline,viewport.height);
      document.body.classList.toggle('keyboard-open',document.activeElement===input && viewport.height < viewportBaseline*.78);
      document.documentElement.style.setProperty('--app-height', Math.round(viewport.height)+'px');
      if(document.activeElement === input) {
        const thread=$('#thread');requestAnimationFrame(()=>{thread.scrollTop=thread.scrollHeight;});
      }
    } else { document.documentElement.style.removeProperty('--app-height'); document.body.classList.remove('keyboard-open'); }
  };
  if(viewport) viewport.addEventListener('resize',syncViewport);
  window.addEventListener('resize',syncViewport);input.addEventListener('focus',syncViewport);input.addEventListener('blur',()=>document.body.classList.remove('keyboard-open'));syncViewport();
  initSettings();
  boot().catch((e) => toast(e.message || 'Не удалось загрузить данные'));

  // File workspace: originals remain immutable, edits are stored as separate versions.
  function featureDialog(title) {
    const wrap=document.createElement('div');wrap.className='feature-overlay';wrap.innerHTML='<section class="feature-panel" role="dialog" aria-modal="true"><header><h2></h2><button class="btn sm" type="button" aria-label="Закрыть">✕</button></header><div class="feature-content"></div></section>';
    wrap.querySelector('h2').textContent=title;const close=()=>{wrap.remove();document.removeEventListener('keydown',key);};const key=e=>{if(e.key==='Escape')close();};wrap.querySelector('header button').onclick=close;wrap.onclick=e=>{if(e.target===wrap)close();};document.addEventListener('keydown',key);document.body.append(wrap);wrap.querySelector('header button').focus();return {wrap,content:wrap.querySelector('.feature-content'),close};
  }
  let activePreview=null;
  function createPreviewDock(title) {
    if(activePreview && !activePreview.close(false))return null;
    const wrap=document.createElement('aside');wrap.className='preview-dock';wrap.setAttribute('aria-label','Предпросмотр файла');
    wrap.innerHTML='<div class="preview-resizer" role="separator" tabindex="0" aria-label="Ширина предпросмотра" aria-orientation="vertical"></div><header class="preview-header"><h2></h2><div class="preview-actions"><button class="icon-btn" type="button" data-expand aria-label="Развернуть предпросмотр" title="Развернуть">⤢</button><button class="icon-btn" type="button" data-dismiss aria-label="Закрыть предпросмотр" title="Закрыть">✕</button></div></header><div class="feature-content dock-content"></div>';
    const restore=document.activeElement;const result={wrap,content:wrap.querySelector('.dock-content'),actions:wrap.querySelector('.preview-actions'),beforeClose:null,close(force=false){if(!force && result.beforeClose && !result.beforeClose())return false;wrap.remove();document.body.classList.remove('preview-open','preview-expanded','preview-resizing');document.removeEventListener('keydown',key);if(activePreview===result)activePreview=null;if(restore?.isConnected)restore.focus({preventScroll:true});return true;}};
    const key=e=>{if(e.key==='Escape' && !document.querySelector('.feature-overlay')){e.preventDefault();result.close(false);}};
    wrap.querySelector('h2').textContent=title;wrap.querySelector('[data-dismiss]').onclick=()=>result.close(false);
    wrap.querySelector('[data-expand]').onclick=e=>{const expanded=document.body.classList.toggle('preview-expanded');e.currentTarget.setAttribute('aria-label',expanded?'Свернуть предпросмотр':'Развернуть предпросмотр');e.currentTarget.title=expanded?'Свернуть':'Развернуть';e.currentTarget.textContent=expanded?'⤡':'⤢';};
    const resize=wrap.querySelector('.preview-resizer');
    const setWidth=width=>{const sidebar=$('#sidebar');const sidebarWidth=sidebar && getComputedStyle(sidebar).position!=='fixed'?sidebar.getBoundingClientRect().width:0;const max=Math.max(320,innerWidth-sidebarWidth-340);document.body.style.setProperty('--preview-width',Math.round(Math.max(320,Math.min(max,width)))+'px');};
    resize.onpointerdown=e=>{if(e.button!==0)return;e.preventDefault();resize.setPointerCapture(e.pointerId);document.body.classList.add('preview-resizing');};
    resize.onpointermove=e=>{if(resize.hasPointerCapture(e.pointerId))setWidth(innerWidth-e.clientX);};
    resize.onpointerup=resize.onpointercancel=e=>{if(resize.hasPointerCapture(e.pointerId))resize.releasePointerCapture(e.pointerId);document.body.classList.remove('preview-resizing');};
    resize.onkeydown=e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();setWidth(wrap.getBoundingClientRect().width+(e.key==='ArrowLeft'?32:-32));}};
    document.body.append(wrap);document.body.classList.add('preview-open');document.addEventListener('keydown',key);activePreview=result;wrap.querySelector('[data-dismiss]').focus({preventScroll:true});return result;
  }
  function openSitePreview(url,image=null,mobile=false){
    const d=createPreviewDock('Предпросмотр сайта');if(!d)return;
    d.content.innerHTML='<div class="site-preview-toolbar"><button class="btn sm" data-desktop>Компьютер</button><button class="btn sm" data-mobile>Телефон</button><button class="btn sm" data-refresh>Обновить</button></div><div class="site-preview-address"></div><div class="site-preview-note" role="status"></div><div class="site-preview-stage"></div>';
    const stage=d.content.querySelector('.site-preview-stage'),note=d.content.querySelector('.site-preview-note');d.content.querySelector('.site-preview-address').textContent=url;
    let generation=0;
    const show=src=>{stage.replaceChildren();const img=document.createElement('img');img.src=src;img.alt=mobile?'Мобильный предпросмотр сайта':'Предпросмотр сайта на компьютере';img.style.width=mobile?'390px':'100%';img.style.maxWidth='100%';stage.append(img);note.textContent='Реальный снимок страницы · '+(mobile?'390 × 844':'1440 × 960')+' · без входа в аккаунт';};
    const sync=()=>{for(const [sel,on]of [['[data-desktop]',!mobile],['[data-mobile]',mobile]]){const b=d.content.querySelector(sel);b.classList.toggle('primary',on);b.setAttribute('aria-pressed',String(on));}};
    const load=async()=>{const n=++generation;sync();note.textContent='Открываю страницу…';try{const r=await api('web_preview',{url,mobile,chat_id:S.chatId||0});if(n!==generation||!d.wrap.isConnected)return;show(r.image);}catch(e){if(n===generation)note.textContent=e.message;}};
    d.content.querySelector('[data-desktop]').onclick=()=>{mobile=false;load();};d.content.querySelector('[data-mobile]').onclick=()=>{mobile=true;load();};d.content.querySelector('[data-refresh]').onclick=load;sync();if(image)show(image);else load();
  }
  const sitePreviewStyle=document.createElement('style');sitePreviewStyle.textContent='.site-preview-toolbar .primary,.pending [data-run]{background:#ff6a2b!important;border-color:#ff6a2b!important;color:#fff!important}.site-preview-toolbar{display:flex;gap:7px;padding:12px;flex-wrap:wrap;position:sticky;top:0;background:var(--surface,#222);z-index:2}.site-preview-address{padding:0 14px 10px;font:12px system-ui;overflow-wrap:anywhere;color:var(--muted,#aaa)}.site-preview-note{padding:0 14px 12px;font:12px/1.5 system-ui;color:var(--muted,#aaa)}.site-preview-stage{padding:12px;display:flex;justify-content:center;align-items:flex-start;background:#101010;min-height:200px}.site-preview-stage img{height:auto;border:1px solid #444;border-radius:12px;box-shadow:0 8px 30px #0005}';document.head.append(sitePreviewStyle);
  async function openWorkbench(mid,index) {
    const d=createPreviewDock('Файл');if(!d)return;d.content.textContent='Загружаю…';
    try {
      let data=await api('file_content&message_id='+mid+'&index='+index);if(!d.wrap.isConnected)return;
      d.wrap.querySelector('h2').textContent=data.name;
      d.content.innerHTML='<div class="workspace-toolbar"><button class="btn sm" data-preview>Предпросмотр</button><button class="btn sm" data-edit>Редактор</button><select aria-label="Версия файла"></select><button class="btn primary sm" data-save>Сохранить новую версию</button><a class="btn sm" data-download download>Скачать</a></div><p class="workspace-note">Изменения сохраняются отдельной версией. Оригинал остаётся доступен.</p><textarea class="file-editor" spellcheck="false" aria-label="Содержимое файла"></textarea><div class="file-preview" hidden></div>';
      const editor=d.content.querySelector('textarea'),preview=d.content.querySelector('.file-preview'),select=d.content.querySelector('select'),download=d.content.querySelector('[data-download]');
      const sync=()=>{editor.value=data.content;select.replaceChildren();const original=new Option('Оригинал','original');select.add(original);for(const v of data.versions)select.add(new Option('Версия '+v.id+' · '+v.created_at,String(v.id)));select.value=data.version?String(data.version):'original';download.href=data.version?'api.php?a=version_download&message_id='+mid+'&index='+index+'&version='+data.version:'api.php?a=generated_file&message_id='+mid+'&file='+index;download.download=data.name.split('/').pop();};sync();
      let dirty=false;d.beforeClose=()=>!dirty || confirm('Закрыть файл без сохранения изменений?');editor.oninput=()=>{dirty=true;d.content.querySelector('.workspace-note').textContent='Есть несохранённые изменения';};
      select.onchange=async()=>{if(dirty && !confirm('Открыть другую версию и отменить несохранённые изменения?')){select.value=data.version?String(data.version):'original';return;}const v=select.value;data=await api('file_content&message_id='+mid+'&index='+index+(v==='original'?'&original=1':'&version='+v));sync();dirty=false;renderFilePreview(preview,data.name,editor.value);};
      const editButton=d.content.querySelector('[data-edit]'),previewButton=d.content.querySelector('[data-preview]');
      const selectTab=isPreview=>{previewButton.classList.toggle('on',isPreview);editButton.classList.toggle('on',!isPreview);previewButton.setAttribute('aria-pressed',String(isPreview));editButton.setAttribute('aria-pressed',String(!isPreview));};
      editButton.onclick=()=>{preview.hidden=true;editor.hidden=false;selectTab(false);};
      previewButton.onclick=()=>{renderFilePreview(preview,data.name,editor.value);preview.hidden=false;editor.hidden=true;selectTab(true);};
      previewButton.click();
      d.content.querySelector('[data-save]').onclick=async e=>{const btn=e.currentTarget;btn.disabled=true;try{data=await api('file_version',{message_id:mid,index,content:editor.value});sync();dirty=false;d.content.querySelector('.workspace-note').textContent='Новая версия сохранена';if(!preview.hidden)renderFilePreview(preview,data.name,editor.value);toast('Версия сохранена');}catch(err){toast(err.message);}finally{btn.disabled=false;}};
    }catch(e){d.content.textContent=e.message;}
  }
  function renderFilePreview(target,name,text) {
    target.replaceChildren();const ext=extOf(name);
    if(['html','htm','svg'].includes(ext)) {
      const frame=document.createElement('iframe');frame.title='Предпросмотр '+name;frame.setAttribute('sandbox','');frame.referrerPolicy='no-referrer';
      frame.srcdoc='<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; img-src data:; style-src &#39;unsafe-inline&#39;; form-action &#39;none&#39;; base-uri &#39;none&#39;">'+text;target.append(frame);
    }else if(['csv','tsv'].includes(ext)) {
      const sep=ext==='tsv'?'\t':(text.split('\n')[0].includes(';')?';':',');const rows=[];let row=[],cell='',quote=false;
      for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quote && text[i+1]==='"'){cell+='"';i++;}else quote=!quote;}else if(c===sep&&!quote){row.push(cell);cell='';}else if(c==='\n'&&!quote){row.push(cell.replace(/\r$/,''));rows.push(row);row=[];cell='';if(rows.length>=500)break;}else cell+=c;}if(cell||row.length){row.push(cell);rows.push(row);}
      const table=document.createElement('table');for(const [i,r] of rows.entries()){const tr=document.createElement('tr');for(const value of r.slice(0,100)){const td=document.createElement(i?'td':'th');td.textContent=value;tr.append(td);}table.append(tr);}target.append(table);const note=document.createElement('small');note.textContent='Предпросмотр: до 500 строк и 100 столбцов';target.append(note);
    }else {const pre=document.createElement('pre');try{pre.textContent=ext==='json'?JSON.stringify(JSON.parse(text),null,2):text;}catch{pre.textContent=text;}target.append(pre);}
  }
  async function openLibrary() {
    const d=featureDialog('Библиотека файлов');closeSidebarMobile();d.content.innerHTML='<input class="library-search" type="search" placeholder="Поиск по имени файла или чату" aria-label="Поиск файлов"><div class="library-items">Загружаю…</div>';
    const list=d.content.querySelector('.library-items'),search=d.content.querySelector('input');
    try {const {files}=await api('library');const paint=()=>{list.replaceChildren();const query=search.value.toLocaleLowerCase();const found=files.filter(f=>(f.name+' '+(f.chat_title||'')).toLocaleLowerCase().includes(query));if(!found.length){list.textContent='Файлы не найдены';return;}for(const file of found){const item=document.createElement('article');item.className='library-item';const title=document.createElement('b');title.textContent=file.name;const sub=document.createElement('small');sub.textContent=(file.chat_title||'Вложение')+' · '+humanSize(file.size);item.append(title,sub);if(file.image || /\.(png|jpg|jpeg|gif|webp)$/i.test(file.name)){const image=document.createElement('img');image.loading='lazy';image.alt=file.name;image.src=file.url;item.append(image);}const actions=document.createElement('div');const a=document.createElement('a');a.href=file.url;a.download=file.name;a.className='btn sm';a.textContent='Скачать';actions.append(a);if(file.message_id){const edit=document.createElement('button');edit.className='btn sm';edit.textContent='Открыть';edit.onclick=()=>{d.close();openWorkbench(file.message_id,file.index);};actions.append(edit);}if(file.chat_id){const chat=document.createElement('button');chat.className='btn sm';chat.textContent='К чату';chat.onclick=()=>{d.close();location.hash='#chat/'+file.chat_id;};actions.append(chat);}item.append(actions);list.append(item);}};search.oninput=paint;paint();search.focus();}catch(e){list.textContent=e.message;}
  }
  // Server state, not a synthetic chat message, controls continuation.
  function showResume(){$('#resumeResponse')?.remove();updateSend();scheduleTaskPoll(100);}
  async function pauseTask(){
    if(!S.chatId||controlPending)return;controlPending=true;updateSend();
    try{acceptTask((await api('task_pause',{chat_id:S.chatId})).task);scheduleTaskPoll(300);}
    finally{controlPending=false;updateSend();}
  }
  async function resumeTask(automatic=false){
    if(!S.chatId||S.busy||controlPending)return;
    if($('#messages').querySelector('[data-pending-action]')){toast('Подтвердите или отклоните ожидающее действие');return;}
    controlPending=true;const id=+S.chatId;
    try{acceptTask({chat_id:id,status:'running'});controlPending=false;await streamAgent('task_resume',{chat_id:id,automatic});}
    finally{controlPending=false;updateSend();}
  }
  async function steerTask(text,atts){
    const id=+S.chatId,requestId=crypto.randomUUID();let result;
    // Retry the same idempotency key if only the acknowledgement was lost.
    for(let attempt=0;attempt<2;attempt++){
      try{result=await api('task_steer',{chat_id:id,text,attachments:atts.map(f=>f.id),request_id:requestId});break;}
      catch(e){if(attempt||!navigator.onLine)throw e;}
    }
    acceptTask(result.task);
    if(+S.chatId===id && result.task.status!=='waiting')$('#messages').querySelectorAll('[data-pending-action]').forEach(el=>el.remove());
    if(+S.chatId===id){addMessage({id:result.message_id,role:'user',content:text,attachments:atts,created_at:new Date().toISOString()});scrollDown(true);toast('Уточнение добавлено в задание');}
    scheduleTaskPoll(100);
  }
  function scheduleTaskPoll(delay=2000){clearTimeout(taskPollTimer);taskPollTimer=setTimeout(pollTask,delay);}
  async function pollTask(){
    if(taskPolling||document.hidden||!S.chatId||!S.user||S.guest){scheduleTaskPoll(5000);return;}
    taskPolling=true;const id=+S.chatId;
    try{
      const {task}=await api('task_state&chat_id='+id);acceptTask(task);
      if(+S.chatId===id && !(S.busy&&+active.chatId===id&&active.rendering)){
        const latest=Math.max(0,...[...$('#messages').querySelectorAll('.msg')].map(el=>+el._msg?.id||0));
        if(task.last_message_id!==latest){
          const chat=await api('chat&id='+id+'&version='+encodeURIComponent(S.chatVersionId===id?(S.chatVersion||''):''));
          if(+S.chatId===id&&!chat.unchanged){
            const t=$('#thread'),near=t.scrollHeight-t.scrollTop-t.clientHeight<160,top=t.scrollTop;
            $('#messages').replaceChildren();let i=0;while(i<chat.messages.length)i=addGroup(chat.messages,i);
            if(chat.pending)addPending(chat.pending.cmd,!!+chat.pending.danger);
            S.chatVersion=chat.version;S.chatVersionId=id;S.syncSignature=JSON.stringify([chat.messages,chat.pending]);acceptTask(chat.task);
            if(near)scrollDown(true);else t.scrollTop=top;
          }
        }
        if(task.status==='queued'&&!task.locked&&!S.busy&&!controlPending)await resumeTask(true);
      }
    }catch(e){/* Keep the draft and retry state sync; never resend a command. */}
    finally{taskPolling=false;scheduleTaskPoll(workingHere()?2000:5000);}
  }
  const taskHint=document.createElement('div');taskHint.id='taskControlHint';taskHint.setAttribute('role','status');taskHint.hidden=true;$('#composer').before(taskHint);
  const pauseButton=document.createElement('button');pauseButton.id='taskPauseBtn';pauseButton.type='button';pauseButton.className='icon-btn';pauseButton.hidden=true;pauseButton.title='Приостановить после текущего действия';pauseButton.setAttribute('aria-label',pauseButton.title);pauseButton.textContent='■';pauseButton.onclick=()=>pauseTask().catch(e=>toast(e.message));$('#composer .composer-bar .left').append(pauseButton);
  const taskStyle=document.createElement('style');taskStyle.textContent='body.busy #sendBtn svg{display:block}body.busy #sendBtn::before{display:none}#taskControlHint{max-width:var(--chat-width,768px);margin:0 auto 7px;color:var(--muted,#99958d);font:12px/1.4 var(--sans)}#taskControlHint[hidden],#taskPauseBtn[hidden]{display:none!important}#taskPauseBtn{color:#ff6b26}#sendBtn[data-mode="resume"]{background:var(--accent);color:#fff}#sendBtn[data-mode="pause"]{background:var(--accent);color:#fff}';document.head.append(taskStyle);
  window.addEventListener('focus',()=>scheduleTaskPoll(100));document.addEventListener('visibilitychange',()=>{if(!document.hidden)scheduleTaskPoll(100);});window.addEventListener('hashchange',()=>{updateSend();scheduleTaskPoll(100);});scheduleTaskPoll(500);
  // Speech API is exposed only when supported; transcript stays editable before sending.
  const Speech=window.SpeechRecognition||window.webkitSpeechRecognition;
  const mic=document.createElement('button');mic.type='button';mic.className='btn sm voice-input';const micIcon='<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></svg>';mic.innerHTML=micIcon;mic.title=Speech?'Голосовой ввод':'Голосовой ввод не поддерживается этим браузером';mic.setAttribute('aria-label',mic.title);$('#composer .composer-bar .left').append(mic);
  let recognition=null;
  if(Speech){mic.onclick=()=>{if(recognition){recognition.stop();return;}const r=new Speech();recognition=r;r.lang='ru-RU';r.continuous=true;r.interimResults=true;const initial=input.value;r.onresult=e=>{let transcript='';for(let i=0;i<e.results.length;i++)transcript+=e.results[i][0].transcript+' ';input.value=(initial?initial+' ':'')+transcript.trim();input.dispatchEvent(new Event('input'));};r.onstart=()=>{mic.classList.add('recording');mic.textContent='■';mic.title='Остановить запись';};r.onend=()=>{recognition=null;mic.classList.remove('recording');mic.innerHTML=micIcon;mic.title='Голосовой ввод';};r.onerror=e=>{if(e.error==='aborted')return;toast(({'not-allowed':'Разрешите доступ к микрофону в настройках браузера','audio-capture':'Микрофон не найден или занят','no-speech':'Речь не распознана. Попробуйте ещё раз','network':'Сервис распознавания недоступен. Попробуйте открыть сайт в Chrome или Edge','service-not-allowed':'Этот браузер не разрешает распознавание речи. Откройте сайт в Chrome или Edge'})[e.error]||('Голосовой ввод: '+e.error));};try{r.start();}catch(e){recognition=null;toast(e.message);}};}else{mic.onclick=()=>toast('Для голосового ввода откройте сайт в Chrome или Edge с поддержкой распознавания речи.');}
  const srvObserver=new MutationObserver(()=>{const mode=document.querySelector('.srv-mode');if(!mode || mode.querySelector('.access-policy') || !S.ctx.serverId)return;const id=S.ctx.serverId;mode.replaceChildren();const label=document.createElement('label');label.textContent='Доступ к серверу';const select=document.createElement('select');select.className='access-policy';select.setAttribute('aria-label','Режим доступа к серверу');for(const [v,t] of [['read','Только чтение'],['confirm','Подтверждать каждую команду'],['auto','Автоматически, опасные — с подтверждением']])select.add(new Option(t,v));select.disabled=true;label.append(select);mode.append(label);const note=document.createElement('small');note.textContent='Чтение: pwd, whoami, hostname, uptime, ls, df -h, free -m, uname -a.';mode.append(note);api('server_policy&id='+id).then(d=>{select.value=d.mode;select.disabled=false;}).catch(e=>toast(e.message));select.onchange=async()=>{select.disabled=true;try{await api('server_policy',{id,mode:select.value});S.ctx.auto=select.value==='auto'?1:0;if(S.chatId)await api('chat_set',{chat_id:S.chatId,ssh_auto:S.ctx.auto});toast('Режим сохранён');}catch(e){toast(e.message);}finally{select.disabled=false;}};});srvObserver.observe(document.body,{childList:true,subtree:true});
  // Shared account synchronization: only the server is authoritative.
  let accountSyncing=false;
  function draftKey(){return 'ollo-draft-'+(S.user?.id||'guest')+'-'+(location.hash||'new');}
  function restoreAccountDraft(){if(S.busy)return;input.value=store.get(draftKey())||'';input.dispatchEvent(new Event('input'));}
  input.addEventListener('input',()=>{if(S.user)store.set(draftKey(),input.value);});
  $('#composer').addEventListener('submit',()=>queueMicrotask(()=>{if(!input.value)store.set(draftKey(),'');}));
  window.addEventListener('hashchange',()=>queueMicrotask(restoreAccountDraft));
  async function synchronizeAccount(){
    if(accountSyncing||S.busy||document.hidden)return;
    accountSyncing=true;
    try{
      if(!S.user){await boot();restoreAccountDraft();document.body.classList.remove('sync-offline');return;}
      const d=await api('bootstrap');const changedUser=+d.user.id!==+S.user.id;
      if(changedUser){S.user=d.user;location.reload();return;}
      S.plan=d.plan;S.models=d.models;S.chats=d.chats;S.projects=d.projects||[];S.servers=d.servers||[];
      const currentModel=S.models.find(m=>m.model_id===S.model?.model_id&&!m.locked);S.model=currentModel||S.models.find(m=>m.model_id===d.default_model&&!m.locked)||S.models.find(m=>!m.locked&&m.kind==='text');
      renderChats();renderModels();renderPlan();if(location.hash==='#projects')renderProjectsPage();
      const id=S.chatId;
      if(id && !S.busy){
        if(!S.chats.some(c=>+c.id===+id)){toast('Чат удалён в другой версии ollo');location.hash='';return;}
        const chat=await api('chat&id='+id+'&version='+encodeURIComponent(S.chatVersionId===id?(S.chatVersion||''):''));acceptTask(chat.task);if(chat.unchanged)return;const signature=JSON.stringify([chat.messages,chat.pending]);if(S.chatId===id){S.chatVersion=chat.version;S.chatVersionId=id;}
        if(S.chatId===id&&!S.busy&&S.syncSignature!==signature){
          const thread=$('#thread'),fromBottom=thread.scrollHeight-thread.scrollTop-thread.clientHeight;
          $('#messages').replaceChildren();let i=0;while(i<chat.messages.length)i=addGroup(chat.messages,i);S.syncSignature=signature;if(chat.pending)addPending(chat.pending.cmd,!!+chat.pending.danger);
          $('#chatTitle').textContent=chat.chat.title;S.projectId=chat.chat.project_id||0;S.ctx.projectId=S.projectId;
          if(fromBottom<100)scrollDown(true);else thread.scrollTop=Math.max(0,thread.scrollHeight-thread.clientHeight-fromBottom);
          showResume();
        }
      }
      if(location.hash.match(/^#project\//)){
        const project=S.projects.find(p=>+p.id===+S.projectId);if(!project){location.hash='#projects';}
        else{ $('#phName').textContent=project.name;$('#chatTitle').textContent=project.name;const chats=S.chats.filter(c=>+c.project_id===+project.id);$('#phChats').innerHTML=chats.length?chats.map(c=>`<a class="pc" href="#chat/${c.id}">${esc(c.title)}</a>`).join(''):'<span class="muted">В проекте пока нет чатов.</span>'; }
      }
      document.body.classList.remove('sync-offline');
      const status=$('#desktopSyncStatus');if(status)status.textContent=S.guest?'Гость · войдите для синхронизации':'Синхронизировано';
    }catch(e){document.body.classList.add('sync-offline');const status=$('#desktopSyncStatus');if(status)status.textContent='Нет соединения · повторить';}
    finally{accountSyncing=false;}
  }
  setInterval(synchronizeAccount,15000);
  window.addEventListener('focus',synchronizeAccount);window.addEventListener('online',synchronizeAccount);document.addEventListener('visibilitychange',()=>{if(!document.hidden)synchronizeAccount();});
  if(window.ollo?.desktop && typeof window.ollo.getState==='function' && typeof window.ollo.onUpdate==='function'){
    const status=document.createElement('button');status.id='desktopSyncStatus';status.type='button';status.className='desktop-sync';status.textContent='Подключаюсь…';status.title='Синхронизировать с аккаунтом ollo';status.onclick=synchronizeAccount;$('.sb-bottom').prepend(status);
    const update=document.createElement('button');update.id='desktopUpdateBtn';update.className='btn sm desktop-update';update.type='button';update.textContent='Обновления';update.title='Обновления приложения';$('.topbar').append(update);
    let ready=false;const updateStatus=d=>{ready=d.status==='ready';update.textContent=ready?'Установить '+d.availableVersion:d.status==='downloading'?'Обновление '+(d.percent||0)+'%':d.status==='checking'?'Проверяю…':'Обновления';update.classList.toggle('ready',ready);};
    update.onclick=()=>ready?window.ollo.installUpdate():window.ollo.checkUpdates();
    window.ollo.onUpdate(updateStatus);
    window.ollo.onAction(action=>{if(action==='new-chat')$('#newChat').click();if(action==='projects')$('#newProject').click();if(action==='files')openLibrary();if(action==='sync')synchronizeAccount();});
    window.ollo.getState().then(state=>{updateStatus(state.update);document.title='ollo · '+state.version;if(state.authError){openAuth();toast(state.authError);}});
    document.querySelectorAll('.desktop-guest').forEach(el=>el.hidden=!S.guest);
    setTimeout(()=>{document.querySelectorAll('.desktop-guest').forEach(el=>el.hidden=!S.guest);document.querySelectorAll('.desktop-account').forEach(el=>el.hidden=!!S.guest);restoreAccountDraft();synchronizeAccount();},1200);
  }

})();
