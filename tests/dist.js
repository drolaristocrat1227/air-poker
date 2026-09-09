/* =============================================================
   配布用一式（dist/）の検査
     node build.js && node tests/dist.js
   ============================================================= */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'docs');
let pass = 0, fail = 0;
const fails = [];
const ok = (c, n, d) => { if (c) pass++; else { fail++; fails.push(n + (d ? '  ── ' + d : '')); } };
const rd = (f) => fs.readFileSync(path.join(DIST, f), 'utf8');
const has = (f) => fs.existsSync(path.join(DIST, f));

console.log('\x1b[36m── 配布用一式\x1b[0m');

const srcVer = (fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
  .match(/name="app-version"\s+content="([^"]+)"/) || [])[1];
ok(!!srcVer, '本体に版番号がある', srcVer);

for (const f of ['index.html', 'manifest.webmanifest', 'sw.js', 'README.txt',
                 'icon-180.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'])
  ok(has(f), `${f} が出力される`);

/* index.html は正式な文書になっているか */
const doc = rd('index.html');
ok(/^<!doctype html>/i.test(doc), '正式な HTML 文書になっている');
ok(/<html lang="ja">/.test(doc) && /<head>/.test(doc) && /<body>/.test(doc), 'html/head/body がある');
const headPart = doc.slice(0, doc.indexOf('</head>'));
ok(/<meta charset="utf-8">/.test(headPart), 'charset が head にある');
ok(/viewport-fit=cover/.test(headPart), 'viewport が head にある');
ok(/<link rel="manifest" href="manifest\.webmanifest">/.test(headPart), 'マニフェストが head にある');
ok(/<link rel="apple-touch-icon" href="icon-180\.png">/.test(headPart), 'アイコンが head にある');
ok(/apple-mobile-web-app-capable/.test(headPart), '全画面起動の宣言が head にある');
ok((doc.match(/<link rel="manifest"/g) || []).length === 1, 'マニフェストの宣言は1つだけ');
ok(/<script id="core">/.test(doc) && /<script id="ui">/.test(doc), '本体スクリプトが入っている');
ok(/<script id="sw">/.test(doc), 'Service Worker の登録が入っている');
ok(doc.indexOf('__VERSION__') < 0, 'index.html に置換漏れが無い');
const docVer = (doc.match(/name="app-version"\s+content="([^"]+)"/) || [])[1];
ok(docVer === srcVer, '版番号が本体と一致', `${docVer} / ${srcVer}`);

/* 中身が本体と同じか（取りこぼしが無いか） */
const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const grab = (s, id) => (s.match(new RegExp(`<script id="${id}">([\s\S]*?)</script>`)) || [])[1] || '';
ok(grab(doc, 'core') === grab(src, 'core'), 'ルールエンジンが本体と同一');
ok(grab(doc, 'ui') === grab(src, 'ui'), '画面スクリプトが本体と同一');
ok(doc.indexOf('<canvas id="bg">') >= 0, '背景キャンバスが残っている');

/* Service Worker */
const sw = rd('sw.js');
ok(sw.indexOf('__VERSION__') < 0, 'sw.js に置換漏れが無い');
const swVer = (sw.match(/var VERSION = '([^']+)'/) || [])[1];
ok(swVer === srcVer, 'sw.js の版番号が一致', `${swVer} / ${srcVer}`);
ok(/air-poker-' \+ VERSION/.test(sw), 'キャッシュ名に版番号が入る');
for (const u of ['./index.html', './manifest.webmanifest', './icon-192.png'])
  ok(sw.indexOf("'" + u + "'") >= 0, `${u} を先読みする`);
ok(/skipWaiting/.test(sw), '即時更新に対応している');
try { new Function(sw); ok(true, 'sw.js の構文が正しい'); }
catch (e) { ok(false, 'sw.js の構文が正しい', e.message); }

/* マニフェスト */
let mj = null;
try { mj = JSON.parse(rd('manifest.webmanifest')); } catch (e) {}
ok(!!mj, 'マニフェストが JSON として妥当');
if (mj) {
  ok(mj.display === 'standalone', '全画面で起動する', mj.display);
  ok(mj.start_url === './' && mj.scope === './', '相対パスで置き場所を選ばない');
  ok(!!mj.name && !!mj.short_name, '名前がある', mj.name);
  ok(mj.icons.length >= 3, 'アイコンが3種以上', String(mj.icons.length));
  ok(mj.icons.some(i => /maskable/.test(i.purpose || '')), 'マスク用アイコンがある');
  ok(mj.icons.every(i => has(i.src)), 'マニフェストのアイコンが全て存在する');
  ok(mj.background_color === '#04141a' && mj.theme_color === '#04141a', '配色が本体と揃っている');
}

/* アイコンが本物の PNG で、宣言どおりの大きさか */
for (const [f, w] of [['icon-180.png', 180], ['icon-192.png', 192],
                      ['icon-512.png', 512], ['icon-maskable-512.png', 512]]) {
  const b = fs.readFileSync(path.join(DIST, f));
  const sig = b.slice(0, 8).toString('hex') === '89504e470d0a1a0a';
  const iw = b.readUInt32BE(16), ih = b.readUInt32BE(20);
  ok(sig && iw === w && ih === w, `${f} が ${w}x${w} の PNG`, `${iw}x${ih}`);
}

console.log('\n' + '─'.repeat(58));
if (fail === 0) console.log(`\x1b[32m全 ${pass} 項目 合格\x1b[0m`);
else {
  console.log(`\x1b[31m${pass} 合格 / ${fail} 失敗\x1b[0m`);
  for (const f of fails) console.log('  ✗ ' + f);
  process.exitCode = 1;
}
