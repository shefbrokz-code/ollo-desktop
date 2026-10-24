'use strict';
const { app, BrowserWindow, protocol, net, ipcMain, Menu, dialog, shell, session, Notification, nativeTheme } = require('electron');
const path=require('node:path');const fs=require('node:fs/promises');const {pathToFileURL}=require('node:url');
const {autoUpdater}=require('electron-updater');
protocol.registerSchemesAsPrivileged([{scheme:'ollo',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true,corsEnabled:true}}]);
const SITE='https://ollo.su';const CSP="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://ollo.su; font-src 'self' data:; connect-src 'self'; frame-src 'self' about: blob:; object-src 'none'; base-uri 'self'; form-action 'self'";const LOCAL='ollo://app';const ROOT=path.join(__dirname,'ui');
let win=null,csrf='',handshake=null,lastAuthError='',updateState={status:'idle',version:app.getVersion()},checking=false;
const smoke=process.argv.includes('--service-smoke');
if(smoke)app.setPath('userData',path.join(app.getPath('temp'),'ollo-native-service-test'));
if(!smoke && !app.requestSingleInstanceLock()){app.quit();process.exit(0);}
app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.show();win.focus();}});
async function establish(force=false){
 if(csrf&&!force)return;if(handshake)return handshake;
 handshake=(async()=>{const r=await session.defaultSession.fetch(SITE+'/api.php?a=desktop_session',{credentials:'include',cache:'no-store'});if(!r.ok)throw new Error('Сервер ollo недоступен');const data=await r.json();if(!/^[a-f0-9]+$/.test(data.csrf||''))throw new Error('Не удалось установить защищённую сессию');csrf=data.csrf;if(data.auth_error)lastAuthError=String(data.auth_error);})();
 try{await handshake;}finally{handshake=null;}
}
function remotePath(url){
 const p=url.pathname;if(p==='/api.php'||p==='/auth.php')return p+url.search;
 if(/^\/data\/images\/[a-zA-Z0-9_./-]+$/.test(p) && !p.includes('..'))return p;
 return null;
}
async function backend(url,request){
 await establish();const headers={'X-Ollo-Client':'Windows/'+app.getVersion(),'X-CSRF':csrf};const type=request.headers.get('content-type');if(type)headers['Content-Type']=type;
 let body=['GET','HEAD'].includes(request.method)?undefined:Buffer.from(await request.arrayBuffer());
 if(url.pathname==='/auth.php'&&body&&type?.includes('application/x-www-form-urlencoded')){const form=new URLSearchParams(body.toString());form.set('csrf',csrf);body=form.toString();}
 const options={method:request.method,headers,body,credentials:'include',redirect:'manual'};
 let r=await session.defaultSession.fetch(SITE+remotePath(url),options);
 if(r.status===419){await establish(true);headers['X-CSRF']=csrf;if(url.pathname==='/auth.php'&&body){const form=new URLSearchParams(body.toString());form.set('csrf',csrf);options.body=form.toString();}r=await session.defaultSession.fetch(SITE+remotePath(url),options);}
 if(url.pathname==='/auth.php'){
  lastAuthError='';await establish(true);if(request.headers.get('accept')?.includes('application/json'))return Response.json({ok:!lastAuthError,error:lastAuthError});return new Response(null,{status:303,headers:{Location:LOCAL+'/index.html'+(lastAuthError?'#login':'')}});
 }
 const outHeaders=new Headers(r.headers);outHeaders.delete('set-cookie');outHeaders.delete('content-encoding');outHeaders.delete('content-length');outHeaders.set('Cache-Control','no-store');
 const location=outHeaders.get('location');if(location){const destination=new URL(location,SITE);if(destination.origin!==SITE)return new Response('Redirect rejected',{status:403});outHeaders.set('location',LOCAL+'/index.html');}
 return new Response(r.body,{status:r.status,statusText:r.statusText,headers:outHeaders});
}
// Интерфейс берём с сайта, чтобы приложение не отставало от веб-версии; встроенная копия — запасной вариант без сети.
const REMOTE_UI=/^\/(?:|index\.html|index\.php|sw\.js|manifest\.webmanifest|(?:assets|pwa)\/[A-Za-z0-9_./-]+)$/;
async function remoteUi(url){
 if(url.pathname.includes('..')||/^\/assets\/desktop\.css$/.test(url.pathname))return null;
 const page=['/','/index.html','/index.php'].includes(url.pathname);
 try{
  await establish();
  const r=await session.defaultSession.fetch(SITE+(page?'/index.php':url.pathname)+url.search,{credentials:'include',cache:'no-store',headers:{'X-Ollo-Client':'Windows/'+app.getVersion()}});
  if(!r.ok)return null;
  const headers=new Headers(r.headers);headers.delete('set-cookie');headers.delete('content-encoding');headers.delete('content-length');headers.set('X-Content-Type-Options','nosniff');
  if(!page)return new Response(r.body,{status:200,headers});
  // десктопные стили остаются локальными
  const html=(await r.text()).replace('</head>','<link rel="stylesheet" href="assets/desktop.css">\n</head>');
  headers.set('Content-Type','text/html; charset=utf-8');headers.set('Cache-Control','no-store');
  return new Response(html,{status:200,headers});
 }catch{return null;}
}
async function localProtocol(request){
 try{
  const url=new URL(request.url);if(url.hostname!=='app')return new Response('Not found',{status:404});
  if(remotePath(url))return await backend(url,request);
  if(request.method!=='GET'&&request.method!=='HEAD')return new Response('Method not allowed',{status:405});
  if(REMOTE_UI.test(url.pathname)){const remote=await remoteUi(url);if(remote){if((remote.headers.get('content-type')||'').includes('text/html'))remote.headers.set('Content-Security-Policy',CSP);return remote;}}
  const relative=decodeURIComponent(url.pathname==='/' || url.pathname==='/index.php'?'/index.html':url.pathname);const file=path.resolve(ROOT,'.'+relative);
  if(!file.startsWith(ROOT+path.sep))return new Response('Not found',{status:404});
  const r=await net.fetch(pathToFileURL(file).toString());
  const headers=new Headers(r.headers);headers.set('X-Content-Type-Options','nosniff');
  if(file.endsWith('.html'))headers.set('Content-Security-Policy',CSP);
  return new Response(r.body,{status:r.status,headers});
 }catch(error){if(new URL(request.url).pathname==='/api.php')return Response.json({error:'Нет соединения с ollo. Проверьте интернет и повторите попытку.'},{status:503});return new Response('Не удалось открыть ресурс',{status:503});}
}
function validSender(event){return !!win && event.sender===win.webContents && event.senderFrame===win.webContents.mainFrame && event.senderFrame.url.startsWith(LOCAL+'/');}
function publishUpdate(status,extra={}){updateState={...updateState,status,...extra};if(win&&!win.isDestroyed())win.webContents.send('ollo:update',updateState);}
async function checkUpdates(manual=false){if(checking)return updateState;if(!app.isPackaged){publishUpdate('development');return updateState;}checking=true;publishUpdate('checking');try{await autoUpdater.checkForUpdates();}catch{publishUpdate('error',{message:'Не удалось проверить обновления. Повторите позже.'});if(manual&&win)dialog.showMessageBox(win,{type:'warning',message:'Сервер обновлений недоступен',detail:'Работу с чатами можно продолжить.',buttons:['OK']});}finally{checking=false;}return updateState;}
autoUpdater.disableDifferentialDownload=true;autoUpdater.autoDownload=true;autoUpdater.autoInstallOnAppQuit=true;autoUpdater.allowDowngrade=false;
autoUpdater.on('update-available',info=>publishUpdate('available',{availableVersion:info.version}));
autoUpdater.on('update-not-available',()=>publishUpdate('current'));
autoUpdater.on('download-progress',p=>publishUpdate('downloading',{percent:Math.round(p.percent)}));
autoUpdater.on('error',()=>publishUpdate('error',{message:'Не удалось загрузить обновление'}));
autoUpdater.on('update-downloaded',info=>{publishUpdate('ready',{availableVersion:info.version});if(Notification.isSupported())new Notification({title:'Обновление ollo готово',body:'Установите новую версию в удобный момент.'}).show();});
function menu(){Menu.setApplicationMenu(Menu.buildFromTemplate([
 {label:'Файл',submenu:[{label:'Главный экран',accelerator:'CommandOrControl+Home',click:()=>win?.loadURL(LOCAL+'/index.html')},{label:'Новый чат',accelerator:'CommandOrControl+N',click:()=>win?.webContents.send('ollo:action','new-chat')},{label:'Проекты',accelerator:'CommandOrControl+Shift+P',click:()=>win?.webContents.send('ollo:action','projects')},{label:'Файлы',click:()=>win?.webContents.send('ollo:action','files')},{type:'separator'},{label:'Выход',role:'quit'}]},
 {label:'Правка',submenu:[{role:'undo',label:'Отменить'},{role:'redo',label:'Повторить'},{type:'separator'},{role:'cut',label:'Вырезать'},{role:'copy',label:'Копировать'},{role:'paste',label:'Вставить'},{role:'selectAll',label:'Выделить всё'}]},
 {label:'Вид',submenu:[{role:'resetZoom',label:'Обычный масштаб'},{role:'zoomIn',label:'Увеличить'},{role:'zoomOut',label:'Уменьшить'},{role:'togglefullscreen',label:'Во весь экран'},{label:'Синхронизировать',accelerator:'F5',click:()=>win?.webContents.send('ollo:action','sync')}]},
 {label:'Справка',submenu:[{label:'Проверить обновления',click:()=>checkUpdates(true)},{label:'О программе',click:()=>dialog.showMessageBox(win,{type:'info',message:'ollo '+app.getVersion(),detail:'Приложение Windows с собственным локальным интерфейсом. Чаты, проекты и файлы синхронизируются с аккаунтом ollo.',buttons:['OK']})}]}
]));}
async function createWindow(){
 let state={width:1400,height:900};try{state={...state,...JSON.parse(await fs.readFile(path.join(app.getPath('userData'),'window.json'),'utf8'))};}catch{}
 win=new BrowserWindow({width:Math.max(880,state.width),height:Math.max(600,state.height),minWidth:880,minHeight:600,title:'ollo',backgroundColor:nativeTheme.shouldUseDarkColors?'#262624':'#faf9f5',show:false,autoHideMenuBar:true,icon:path.join(__dirname,'../build/icon.png'),webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true,spellcheck:true}});
 win.once('ready-to-show',()=>{win.show();if(state.maximized)win.maximize();});
 win.webContents.setWindowOpenHandler(({url})=>{let target;try{target=new URL(url,LOCAL);}catch{return {action:'deny'};}if(target.protocol==='ollo:' && target.hostname==='app' && target.pathname==='/api.php')win.webContents.downloadURL(target.href);else if(target.protocol==='https:'||target.protocol==='http:'){shell.openExternal(target.href);}else if(target.hostname==='app' && /^\/(admin|app)\//.test(target.pathname))shell.openExternal(SITE+target.pathname);return {action:'deny'};});
 win.webContents.on('will-navigate',(e,legacyUrl)=>{const url=e.url||legacyUrl;const target=new URL(url);if(target.protocol==='ollo:'&&/^\/(admin|app)\//.test(target.pathname)){e.preventDefault();shell.openExternal(SITE+target.pathname);return;}if(!url.startsWith(LOCAL+'/')){e.preventDefault();if(/^https?:/.test(url))shell.openExternal(url);}});
 win.webContents.on('will-frame-navigate',event=>{if(event.isMainFrame && !event.url.startsWith(LOCAL+'/'))event.preventDefault();});
 win.webContents.on('will-attach-webview',e=>e.preventDefault());
 win.on('close',()=>{const bounds=win.getNormalBounds();fs.writeFile(path.join(app.getPath('userData'),'window.json'),JSON.stringify({width:bounds.width,height:bounds.height,maximized:win.isMaximized()})).catch(()=>{});});
 win.on('closed',()=>win=null);await win.loadURL(LOCAL+'/index.html');
}
app.whenReady().then(async()=>{
 if(smoke){try{await establish();const r=await session.defaultSession.fetch(SITE+'/api.php?a=bootstrap',{credentials:'include'});const b=await r.json();if(!b.user||!Array.isArray(b.chats))throw new Error('API bootstrap failed');const request=new Request(LOCAL+'/api.php?a=bootstrap');const proxied=await localProtocol(request);const data=await proxied.json();if(!data.user||data.user.id!==b.user.id)throw new Error('Session is not persistent across requests');const local=await localProtocol(new Request(LOCAL+'/index.html'));const html=await local.text();if(!html.includes('desktop.css')||!html.includes('id="projectsPage"'))throw new Error('Local interface missing');if(!html.includes('assets/settings.js'))throw new Error('Remote interface not loaded');const legacyHome=await localProtocol(new Request(LOCAL+'/index.php'));if(!(await legacyHome.text()).includes('id="projectsPage"'))throw new Error('Home alias failed');const js=await localProtocol(new Request(LOCAL+'/assets/app.js'));if(!(await js.text()).includes('Shared account synchronization'))throw new Error('Sync module missing');console.log(JSON.stringify({test:'native-service',ok:true,guest:!!data.user.guest,models:data.models.length,chats:data.chats.length,csrf:!!csrf,localInterface:true}));app.exit(0);}catch(e){console.error(e.message);app.exit(1);}return;}
 const ALLOWED_PERMISSIONS=new Set(['clipboard-sanitized-write','notifications','media']);
 const ownPage=(contents,url)=>contents===win?.webContents && String(url||'').startsWith(LOCAL+'/');
 session.defaultSession.setPermissionRequestHandler((contents,permission,callback,details)=>{
  const audioOnly=permission!=='media'||((details.mediaTypes||[]).length>0&&(details.mediaTypes||[]).every(t=>t==='audio'));
  callback(ownPage(contents,details.requestingUrl) && ALLOWED_PERMISSIONS.has(permission) && audioOnly);
 });
 session.defaultSession.setPermissionCheckHandler((contents,permission,origin)=>ownPage(contents,origin+'/') && (permission==='notifications'||permission==='media'||permission==='clipboard-sanitized-write'));
 protocol.handle('ollo',localProtocol);
 ipcMain.handle('ollo:state',e=>{if(!validSender(e))throw new Error('Unauthorized');const error=lastAuthError;lastAuthError='';return {version:app.getVersion(),update:updateState,authError:error};});
 ipcMain.handle('ollo:update-check',e=>{if(!validSender(e))throw new Error('Unauthorized');return checkUpdates(true);});
 ipcMain.handle('ollo:update-install',async e=>{if(!validSender(e)||updateState.status!=='ready')return false;const {response}=await dialog.showMessageBox(win,{type:'question',message:'Установить обновление ollo?',detail:'Приложение закроется и запустится снова. Сначала завершите текущий ответ.',buttons:['Установить и перезапустить','Позже'],defaultId:1,cancelId:1});if(response===0)setImmediate(()=>autoUpdater.quitAndInstall(false,true));return response===0;});
 menu();await createWindow();setTimeout(()=>checkUpdates(false),5000);setInterval(()=>checkUpdates(false),2*3600000).unref();
 app.on('activate',()=>{if(!win)createWindow();});
}).catch(e=>{dialog.showErrorBox('ollo',e.message);app.quit();});
app.on('window-all-closed',()=>app.quit());
