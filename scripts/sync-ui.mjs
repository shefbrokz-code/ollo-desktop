// Обновляет встроенную офлайн-копию интерфейса с сайта перед сборкой.
// Онлайн приложение и так грузит интерфейс с ollo.su; копия нужна только без сети.
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const SITE = 'https://ollo.su';
const UI = new URL('../src/ui/', import.meta.url).pathname;
const assets = ['assets/app.js', 'assets/style.css', 'assets/settings.js', 'assets/code.js', 'assets/favicon.svg'];

async function get(path) {
  const r = await fetch(SITE + '/' + path, { headers: { 'X-Ollo-Client': 'Windows/build' } });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.text();
}
for (const a of assets) {
  const file = join(UI, a);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, await get(a));
  console.log('synced', a);
}
let html = await get('index.php');
html = html.replace(/(<meta name="csrf" content=")[^"]*(")/, '$1$2').replace('</head>', '<link rel="stylesheet" href="assets/desktop.css">\n</head>');
if (!html.includes('assets/settings.js')) throw new Error('index.php has unexpected markup');
await writeFile(join(UI, 'index.html'), html);
console.log('synced index.html');
