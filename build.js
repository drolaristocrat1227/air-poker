/* =============================================================
   配布用の一式（dist/）を作る。

     node build.js

   index.html は「アーティファクト形式」＝ <html>/<head>/<body> を持たない。
   これをそのまま自分のURLに置くと、マニフェストや Service Worker が効かず
   ホーム画面に追加しても単体アプリにならない。
   ここでは正式な文書に組み直し、PWA として成立する形に整える。
   ============================================================= */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SRC  = path.join(ROOT, 'index.html');
const DIST = path.join(ROOT, 'docs');   /* GitHub Pages が公開できる場所 */

const src = fs.readFileSync(SRC, 'utf8');

const version = (src.match(/name="app-version"\s+content="([^"]+)"/) || [])[1];
if (!version) { console.error('index.html に app-version がありません'); process.exit(1); }

/* index.html は先頭が meta/title/link/style、その後が本文。
   <style> は1つだけという前提で頭と胴に割る。 */
const styleCount = (src.match(/<style>/g) || []).length;
if (styleCount !== 1) {
  console.error(`<style> が ${styleCount} 個あります。1個であることを前提にしています。`);
  process.exit(1);
}
const cut  = src.indexOf('</style>') + '</style>'.length;
const head = src.slice(0, cut).trim();
const body = src.slice(cut).trim();

/* head 側に、埋め込みでは効かない宣言（マニフェスト・アイコン）を足す */
const headExtra = `
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="icon-180.png">
<link rel="icon" type="image/png" sizes="192x192" href="icon-192.png">
<link rel="icon" type="image/png" sizes="512x512" href="icon-512.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="エア・ポーカー">
<meta name="description" content="水没した監視塔で、呼吸を賭けるポーカー。">`;

/* Service Worker の登録と、新しい版が来たときの案内 */
const swGlue = `
<script id="sw">
/* 圏外でも遊べるようにし、新しい版が置かれたら知らせる */
(function(){
  if(!('serviceWorker' in navigator)) return;
  if(location.protocol!=='https:'&&location.hostname!=='localhost'&&location.hostname!=='127.0.0.1') return;
  var reg=null;
  function offer(w){
    if(!window.__ap||!window.__ap.offerUpdate) return;
    window.__ap.offerUpdate('が用意できました', function(){
      try{
        navigator.serviceWorker.addEventListener('controllerchange', function(){ location.reload(); });
        w.postMessage({type:'SKIP_WAITING'});
        setTimeout(function(){ location.reload(); }, 1200);   /* 念のため */
      }catch(e){ location.reload(); }
    });
  }
  navigator.serviceWorker.register('sw.js').then(function(r){
    reg=r;
    if(r.waiting && navigator.serviceWorker.controller) offer(r.waiting);
    r.addEventListener('updatefound', function(){
      var w=r.installing;
      if(!w) return;
      w.addEventListener('statechange', function(){
        if(w.state==='installed' && navigator.serviceWorker.controller) offer(w);
      });
    });
  },function(){});
  /* 戻ってきたときに新しい版が出ていないか見に行く */
  document.addEventListener('visibilitychange', function(){
    if(document.visibilityState==='visible' && reg) { try{ reg.update(); }catch(e){} }
  });
})();
</script>`;

const doc = `<!doctype html>
<html lang="ja">
<head>
${head.replace(/^<style>/m, '<style>')}
${headExtra.trim()}
</head>
<body>
${body}
${swGlue.trim()}
</body>
</html>
`;

const manifest = {
  name: 'エア・ポーカー',
  short_name: 'エアポーカー',
  description: '水没した監視塔で、呼吸を賭けるポーカー。',
  lang: 'ja',
  start_url: './',
  scope: './',
  display: 'standalone',
  display_override: ['standalone', 'fullscreen'],
  orientation: 'portrait',
  background_color: '#04141a',
  theme_color: '#04141a',
  categories: ['games'],
  icons: [
    { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
  ]
};

const swSrc = fs.readFileSync(path.join(ROOT, 'src', 'sw.js'), 'utf8');
const sw = swSrc.split('__VERSION__').join(version);
if (sw.indexOf('__VERSION__') >= 0) { console.error('sw.js の版番号を差し替えられませんでした'); process.exit(1); }
if (!/air-poker-' \+ VERSION|air-poker-/.test(sw)) { console.error('sw.js の構造が想定と違います'); process.exit(1); }

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });
fs.writeFileSync(path.join(DIST, 'index.html'), doc, 'utf8');
fs.writeFileSync(path.join(DIST, 'manifest.webmanifest'), JSON.stringify(manifest, null, 2), 'utf8');
fs.writeFileSync(path.join(DIST, 'sw.js'), sw, 'utf8');
for (const f of ['icon-180.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png']) {
  fs.copyFileSync(path.join(ROOT, 'assets', f), path.join(DIST, f));
}

/* 置き場所の説明を同梱しておく */
fs.writeFileSync(path.join(DIST, 'README.txt'),
`エア・ポーカー ${version} ─ 配布用一式

このフォルダの中身をまるごと、HTTPS のURLに置いてください。
サブフォルダでも構いません（相対パスで参照しています）。

  例) https://example.com/airpoker/  に置く
      → スマホのブラウザで開き、「ホーム画面に追加」

置いたあとに出来ること
  ・アドレスバーの無い全画面アプリとして起動する
  ・一度開けば圏外でも遊べる
  ・新しい版を上書きすると、次に開いたとき更新の案内が出る

更新のしかた
  1. index.html の app-version を上げる
  2. node build.js
  3. dist/ の中身を同じURLに上書き
`, 'utf8');

const size = (p) => (fs.statSync(p).size / 1024).toFixed(1) + ' KB';
console.log(`エア・ポーカー ${version} の配布用一式を docs/ に書き出しました`);
for (const f of fs.readdirSync(DIST)) console.log('  ' + f.padEnd(26) + size(path.join(DIST, f)));
