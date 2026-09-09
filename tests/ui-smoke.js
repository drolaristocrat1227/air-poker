/* =============================================================
   エア・ポーカー 画面の通し検証
   index.html を jsdom に読み込み、実際にボタンを押して最後まで遊ぶ。
   ・JS の実行時エラーが1件も出ないこと
   ・画面の表示値がエンジンの内部状態と常に一致すること
   ・CPU戦 / 対人戦の両方が最後まで進むこと

   実行:  npm i jsdom && node tests/ui-smoke.js
   ============================================================= */
'use strict';
const fs = require('fs');
const path = require('path');

let JSDOM;
try {
  JSDOM = require('jsdom').JSDOM;
} catch (e) {
  try {
    JSDOM = require(path.join(process.env.JSDOM_PATH || '', 'node_modules', 'jsdom')).JSDOM;
  } catch (e2) {
    console.error('jsdom が必要です:  npm i jsdom');
    process.exit(2);
  }
}

/* TARGET=dist/index.html のように指定すると配布用の出力を検査できる */
const TARGET = process.env.TARGET || 'index.html';
const html = fs.readFileSync(path.resolve(__dirname, '..', TARGET), 'utf8');
if (TARGET !== 'index.html') console.log('検査対象: ' + TARGET);

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) pass++;
  else { fail++; if (fails.length < 30) fails.push(name + (detail ? '  ── ' + detail : '')); }
}
function section(t) { console.log('\n\x1b[36m── ' + t + '\x1b[0m'); }

/* ---------- Canvas と時間の差し替え ---------- */
function makeCtxStub() {
  const noop = () => {};
  return new Proxy({}, {
    get(_, k) {
      if (k === 'createLinearGradient' || k === 'createRadialGradient')
        return () => ({ addColorStop: noop });
      if (k === 'createImageData' || k === 'getImageData')
        return (w, h) => ({ width: w | 0, height: h | 0,
                            data: new Uint8ClampedArray(Math.max(4, (w | 0) * (h | 0) * 4)) });
      if (k === 'createPattern') return () => ({ setTransform: noop });
      if (k === 'canvas') return { width: 400, height: 800 };
      if (k === 'lineWidth' || k === 'globalAlpha') return 1;
      return noop;
    },
    set() { return true; }
  });
}

function boot(seedNote, opt) {
  opt = opt || {};
  const errors = [];
  let now = 0, frameCbs = [], timers = [], tid = 1;

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'http://localhost/',
    beforeParse(w) {
      w.HTMLCanvasElement.prototype.getContext = () => makeCtxStub();
      w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {},
                              addEventListener() {}, removeEventListener() {} });
      w.devicePixelRatio = 2;
      Object.defineProperty(w, 'innerWidth', { value: 390, writable: true });
      Object.defineProperty(w, 'innerHeight', { value: 844, writable: true });
      w.requestAnimationFrame = (cb) => { frameCbs.push(cb); return frameCbs.length; };
      w.cancelAnimationFrame = () => {};
      w.setTimeout = (fn, ms) => { const id = tid++; timers.push({ id, at: now + (ms || 0), fn }); return id; };
      w.clearTimeout = (id) => { timers = timers.filter(t => t.id !== id); };
      w.setInterval = () => 0;
      w.clearInterval = () => {};
      if (opt.fetch) w.fetch = opt.fetch;
      w.addEventListener('error', (ev) => errors.push('error: ' + (ev.message || ev.error)));
      w.addEventListener('unhandledrejection', (ev) => errors.push('rejection: ' + ev.reason));
    }
  });
  dom.virtualConsole.on('jsdomError', (e) => errors.push('jsdomError: ' + e.message));

  function advance(ms) {
    now += ms;
    const due = timers.filter(t => t.at <= now).sort((a, b) => a.at - b.at);
    timers = timers.filter(t => t.at > now);
    for (const t of due) { try { t.fn(); } catch (e) { errors.push('timer: ' + e.message + '\n' + e.stack); } }
    const cbs = frameCbs; frameCbs = [];
    for (const cb of cbs) { try { cb(now); } catch (e) { errors.push('frame: ' + e.message + '\n' + e.stack); } }
  }
  return { dom, w: dom.window, d: dom.window.document, advance, errors, note: seedNote,
           get now() { return now; } };
}

/* ---------- 画面とエンジンの整合 ---------- */
function checkDisplay(env) {
  const { d, w } = env;
  const g = w.__ap.game, ui = w.__ap.ui;
  if (!g || ui.screen !== 'game') return null;
  const v = ui.viewer, o = 1 - v;
  const txt = (id) => d.getElementById(id).textContent;
  if (txt('me-air') !== String(g.P[v].chips)) return `手持ちエアの表示が違う ${txt('me-air')} != ${g.P[v].chips}`;
  if (txt('opp-air') !== String(g.P[o].chips)) return `相手エアの表示が違う ${txt('opp-air')} != ${g.P[o].chips}`;
  if (txt('f-pot') !== String(g.pot())) return `場のエアの表示が違う ${txt('f-pot')} != ${g.pot()}`;
  if (txt('f-round') !== String(g.round)) return `回戦数の表示が違う`;
  const tm = txt('t-me');
  if (g.P[v].target && tm !== String(g.P[v].target)) return `自分の数字の表示が違う ${tm}`;
  if (!g.P[v].target && tm !== '??') return `未開示の数字が漏れている ${tm}`;
  const o2 = Math.max(0, g.P[v].o2);
  if (txt('me-o2') !== String(Math.ceil(o2))) return `酸素の表示が違う`;
  return null;
}

/* エア総量の不変条件 */
function checkAir(env) {
  const g = env.w.__ap.game;
  if (!g) return null;
  const t = g.P[0].chips + g.P[1].chips + g.P[0].committed + g.P[1].committed
          + g.carry + g.P[0].burned + g.P[1].burned + g.vanished;
  if (t !== 50) return `エア総量が ${t}`;
  if (g.cpuFallback) return 'CPU が不正手を返した';
  return null;
}

/* ---------- 人間役 ---------- */
function makeHuman(seed) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  return { rnd };
}

function playOne(opt) {
  const env = boot(opt.label);
  const { d, w, advance } = env;
  const H = makeHuman(opt.seed);
  const rec = { plates: 0, bets: 0, builds: 0, reveals: 0, passes: 0, timeouts: 0,
                folds: 0, raises: 0, hints: 0, frames: 0 };
  let issue = null;

  advance(16);
  if (opt.blind) {
    d.getElementById('opt-blind').click();
    if (!w.__ap.ui.blind) return { issue: '暗算モードに切り替わらない', rec, env };
  }
  const startBtn = d.querySelector('[data-start="' + opt.start + '"]');
  if (!startBtn) return { issue: 'モード選択ボタンが無い: ' + opt.start, rec, env };
  startBtn.click();
  if (opt.blind && !w.__ap.game.blind) return { issue: '暗算モードが対局へ渡っていない', rec, env };

  const vis = (id) => d.getElementById(id).classList.contains('on');
  const gameOver = () => d.getElementById('s-over').classList.contains('on');

  let guard = 0;
  while (!gameOver()) {
    if (++guard > 40000) { issue = 'ゲームが終わらない（進行不能）'; break; }
    advance(50);
    rec.frames++;

    issue = checkAir(env) || checkDisplay(env);
    if (issue) break;
    if (env.errors.length) { issue = env.errors[0]; break; }
    if (!vis('s-game')) continue;

    const g = w.__ap.game, ui = w.__ap.ui;

    if (vis('panel-pass')) {
      const okb = d.getElementById('pass-ok');
      if (!okb.hidden) {
        /* 目隠し中は酸素が止まっているはず */
        const before = g.P[0].o2;
        advance(400);
        if (Math.abs(g.P[0].o2 - before) > 1e-9) { issue = '目隠し中に酸素が減っている'; break; }
        rec.passes++;
        okb.click();
      }
      continue;
    }

    if (vis('panel-plate')) {
      const btns = [...d.querySelectorAll('#plate-list .pbtn')].filter(b => !b.disabled);
      if (!btns.length) { issue = '選べる数字板が無い'; break; }
      /* 使用済みの板が押せないことも確認 */
      const dead = [...d.querySelectorAll('#plate-list .pbtn')].filter(b => b.disabled);
      const selBefore = g.plateSel.slice();
      if (dead.length) { dead[0].click();
        if (JSON.stringify(g.plateSel) !== JSON.stringify(selBefore)) { issue = '使用済みの数字板が選べてしまう'; break; } }
      btns[Math.floor(H.rnd() * btns.length)].click();
      rec.plates++;
      continue;
    }

    if (vis('panel-bet')) {
      const bc = d.getElementById('b-call');
      if (bc.disabled) continue;                     /* CPU の手番 */
      rec.bets++;
      const br = d.getElementById('b-raise');
      const r = H.rnd();
      if (r < 0.04) { d.getElementById('b-fold').click(); rec.folds++; }
      else if (r < 0.34 && !br.disabled) {
        br.click();
        const rr = d.getElementById('rz-range');
        const mx = parseInt(rr.max, 10);
        rr.value = String(Math.max(1, Math.round(mx * (0.2 + H.rnd() * 0.8))));
        d.getElementById('rz-go').click();
        rec.raises++;
      } else if (r < 0.40) {
        /* 何もせず時間を進める（強制決着の経路） */
        advance(4000);
        rec.timeouts++;
      } else bc.click();
      continue;
    }

    if (vis('panel-build')) {
      const pi = ui.buildFor;
      const p = g.P[pi];
      const blind = g.blind;

      if (blind) {
        if (d.querySelectorAll('#bd-deck .cel.used').length) {
          issue = '暗算モードなのに使用済みの印が出ている'; break; }
        if (!d.getElementById('sum-box').classList.contains('blind')) {
          issue = '暗算モードなのに合計が表示されている'; break; }
        if (d.getElementById('bd-blind').hidden) {
          issue = '暗算モードの注意書きが出ていない'; break; }
        if (/♠|♥|♦|♣/.test(d.getElementById('bd-info').textContent.replace(/目標数字[^]*/, ''))) {
          issue = '暗算モードなのに相手の使用済みの札が見えている'; break; }
      } else {
        if (d.getElementById('sum-box').classList.contains('blind')) {
          issue = '標準モードなのに合計が隠れている'; break; }
      }

      /* 暗算モードでは、わざと誤った5枚を出してミスになることを確かめる */
      if (blind && H.rnd() < 0.18) {
        const all = [...d.querySelectorAll('#bd-deck .cel')].filter(c => !c.disabled);
        const picks = [];
        while (picks.length < 5 && all.length) picks.push(all.splice((H.rnd()*all.length)|0, 1)[0]);
        for (const c of picks) c.click();
        const okb = d.getElementById('bd-ok');
        if (ui.sel.length === 5) {
          if (okb.disabled) { issue = '暗算モードでは5枚そろえば提示できるはず'; break; }
          const wrong = !g.validHand(pi, ui.sel);
          const sel = ui.sel.slice();
          okb.click();
          /* 誤った5枚が「有効な役」として通ってしまわないこと。
             双方ミスなら即座に再挑戦へ移るため、missed フラグではなく手の中身で見る。 */
          const h = g.P[pi].hand;
          if (wrong && h && h.length === 5 && sel.every((x, i2) => h[i2] === x)) {
            issue = '誤った5枚が有効な役として受理された'; break; }
          rec.builds++;
          continue;
        }
        d.getElementById('bd-clear').click();
      }

      const cands = w.AP.analyzePool(p.avail).bySum[p.target];
      if (!cands || !cands.length) {
        if (blind) { d.getElementById('bd-clear').click(); advance(12000); }
        else advance(3000);
        continue;
      }

      if (H.rnd() < 0.15 && !d.getElementById('bd-hint').disabled) {
        d.getElementById('bd-hint').click();
        rec.hints++;
      }
      if (H.rnd() < 0.06) { advance(6000); rec.timeouts++; continue; }   /* 考え込む */

      const cards = cands[Math.floor(H.rnd() * Math.min(3, cands.length))].cards;
      /* 6枚目を押しても増えないこと、押し直しで外れることを確かめる */
      const cel = (id) => d.querySelector('#bd-deck .cel[data-id="' + id + '"]');
      cel(cards[0]).click();
      cel(cards[0]).click();                                   /* 解除 */
      if (ui.sel.length !== 0) { issue = '選択の解除ができない'; break; }
      for (const id of cards) cel(id).click();
      if (ui.sel.length !== 5) { issue = '5枚選べていない'; break; }
      const extra = [...d.querySelectorAll('#bd-deck .cel')]
        .find(c => !c.disabled && cards.indexOf(+c.getAttribute('data-id')) < 0);
      if (extra) { extra.click(); if (ui.sel.length !== 5) { issue = '6枚目が選べてしまう'; break; } }
      const okBtn = d.getElementById('bd-ok');
      if (okBtn.disabled) { issue = `正しい5枚なのに決定できない（目標 ${p.target}）`; break; }
      /* 標準モードでは使用済みの札が押せないこと */
      if (!blind) {
        const usedCell = [...d.querySelectorAll('#bd-deck .cel.used')][0];
        if (usedCell && !usedCell.disabled) { issue = '使用済みの札が選べてしまう'; break; }
      }
      okBtn.click();
      rec.builds++;
      continue;
    }

    if (vis('panel-reveal')) {
      rec.reveals++;
      d.getElementById('rv-next').click();
      continue;
    }
  }

  if (!issue && env.errors.length) issue = env.errors[0];
  return { issue, rec, env };
}

/* =============================================================
   実行
   ============================================================= */
section('画面の通し検証');
{
  const N = parseInt(process.env.UI_RUNS || '10', 10);
  const modes = [
    { start: 'cpu:easy',   label: 'CPU 初級' },
    { start: 'cpu:normal', label: 'CPU 中級' },
    { start: 'cpu:hard',   label: 'CPU 上級' },
    { start: 'pvp',        label: '対人（交代）' },
    { start: 'cpu:normal', label: 'CPU 中級・暗算', blind: true },
    { start: 'cpu:hard',   label: 'CPU 上級・暗算', blind: true },
    { start: 'pvp',        label: '対人・暗算',     blind: true }
  ];
  for (const mo of modes) {
    const sum = { plates:0, bets:0, builds:0, reveals:0, passes:0, timeouts:0,
                  folds:0, raises:0, hints:0 };
    let bad = 0, note = '', reached = 0, results = {};
    for (let k = 0; k < N; k++) {
      const out = playOne({ start: mo.start, seed: 11 + k * 7717, label: mo.label, blind: mo.blind });
      if (out.issue) { bad++; if (!note) note = `seed=${11 + k*7717}: ${out.issue}`; continue; }
      const dd = out.env.d;
      if (dd.getElementById('s-over').classList.contains('on')) {
        reached++;
        const res = dd.getElementById('ov-res').textContent.trim();
        results[res] = (results[res] || 0) + 1;
        if (dd.querySelectorAll('#ov-stats div').length !== 8) { bad++; if (!note) note = '戦績の項目数が違う'; }
      }
      for (const kk of Object.keys(sum)) sum[kk] += out.rec[kk] || 0;
      out.env.dom.window.close();
    }
    ok(bad === 0, `${mo.label} ─ ${N} 戦が最後まで遊べる`, note);
    ok(reached === N - bad, `${mo.label} ─ 全戦が決着画面へ到達`, `${reached}/${N}`);
    console.log(`   ${mo.label}: 決着 ${JSON.stringify(results)}`);
    console.log(`      1戦平均 数字${(sum.plates/N).toFixed(1)} ベット${(sum.bets/N).toFixed(1)}` +
                `（レイズ${(sum.raises/N).toFixed(1)} 降り${(sum.folds/N).toFixed(1)}` +
                ` 放置${(sum.timeouts/N).toFixed(1)}） 役作り${(sum.builds/N).toFixed(1)}` +
                ` 目隠し${(sum.passes/N).toFixed(1)} ヒント${(sum.hints/N).toFixed(1)}`);
  }
}

/* 連戦（もう一度／タイトルへ）の動作 */
section('画面遷移');
{
  const env = boot('遷移');
  const { d, advance, w } = env;
  advance(16);
  d.querySelector('[data-rules]').click();
  ok(d.getElementById('s-rules').classList.contains('on'), 'ルール画面が開く');
  d.querySelector('[data-back]').click();
  ok(d.getElementById('s-title').classList.contains('on'), 'ルールから戻れる');

  d.querySelector('[data-start="cpu:normal"]').click();
  advance(50);
  ok(d.getElementById('s-game').classList.contains('on'), '対戦画面が開く');
  const g1 = w.__ap.game;
  /* 決着画面まで一気に進める */
  g1.P[1].chips = 0; g1.phase = 'reveal'; g1.result = { type: 'win', winner: 0, pot: 2, tensai: false, dup: [] };
  w.__ap.ui.key = '';
  advance(50);
  d.getElementById('rv-next').click();
  advance(50);
  ok(d.getElementById('s-over').classList.contains('on'), '決着画面へ移る');
  d.getElementById('ov-again').click();
  advance(50);
  ok(d.getElementById('s-game').classList.contains('on'), '「もう一度」で再戦できる');
  ok(w.__ap.game !== g1 && w.__ap.game.round === 1, '再戦は第1回戦から');
  ok(w.__ap.game.P[0].chips + w.__ap.game.P[0].committed === 25, '再戦でエアが初期化される');
  d.getElementById('rv-next');           /* 存在確認のみ */
  advance(50);
  ok(env.errors.length === 0, '遷移中に実行時エラーが出ない', env.errors[0] || '');
}

/* =============================================================
   スマホ対応と更新機能
   ============================================================= */
section('スマホ対応・更新');
{
  const env = boot('mobile');
  const { d, w, advance } = env;
  advance(16);

  /* 版番号 */
  const meta = d.querySelector('meta[name="app-version"]');
  ok(!!meta, '版番号が埋め込まれている');
  const ver = meta && meta.getAttribute('content');
  ok(/^\d+\.\d+\.\d+$/.test(ver || ''), '版番号の形式が正しい', ver);
  ok(d.getElementById('ver-txt').textContent === ver, '画面に版番号が出る', ver);
  ok(w.__ap.version === ver, '内部の版番号と一致');

  /* ホーム画面へ追加するための宣言が head に入っているか */
  const vp = d.querySelector('meta[name="viewport"]');
  ok(vp && /viewport-fit=cover/.test(vp.getAttribute('content')),
     'ノッチ下まで描く viewport が設定される', vp && vp.getAttribute('content'));
  ok(!!d.querySelector('meta[name="apple-mobile-web-app-capable"][content="yes"]'),
     'iOS で全画面起動する宣言がある');
  ok(!!d.querySelector('meta[name="apple-mobile-web-app-title"]'), 'ホーム画面での名前がある');
  ok(!!d.querySelector('meta[name="theme-color"]'), 'テーマ色がある');
  const icons = [...d.querySelectorAll('link[rel="apple-touch-icon"]')];
  ok(icons.length === 1, 'ホーム画面用のアイコンがちょうど1つ宣言されている', String(icons.length));
  const ih = icons[0] && icons[0].getAttribute('href');
  ok(!!ih && (/^data:image\/png;base64,/.test(ih) || /\.png$/.test(ih)),
     'アイコンの参照先が妥当', ih && ih.slice(0, 40));
  const manis = [...d.querySelectorAll('link[rel="manifest"]')];
  ok(manis.length === 1, 'マニフェストがちょうど1つ宣言されている', String(manis.length));
  const mh = manis[0] && manis[0].getAttribute('href');
  if (mh && /^data:application\/manifest\+json,/.test(mh)) {
    let j = null;
    try { j = JSON.parse(decodeURIComponent(mh.split(',')[1])); } catch (e) {}
    ok(j && j.display === 'standalone' && j.name, '埋め込みマニフェストの中身が妥当',
       j ? `${j.name} / ${j.display}` : '解析できない');
  } else {
    ok(mh === 'manifest.webmanifest', '配布版は外部マニフェストを参照する', mh);
    const mj = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'docs', 'manifest.webmanifest'), 'utf8'));
    ok(mj.display === 'standalone' && !!mj.name && mj.icons.length >= 2,
       '配布版マニフェストの中身が妥当', `${mj.name} / ${mj.display} / アイコン${mj.icons.length}種`);
  }

  /* 更新の帯は既定で隠れている */
  ok(!d.getElementById('update-bar').classList.contains('on'), '起動時に更新の帯は出ていない');
  ok(env.errors.length === 0, 'スマホ向けの初期化で例外が出ない', env.errors[0] || '');
  env.dom.window.close();
}

async function updateTests() {
  /* Promise の解決（マイクロタスク）を挟んでから判定する */
  const settle = async (env, times) => {
    for (let i = 0; i < (times || 4); i++) { await new Promise(r => setImmediate(r)); env.advance(50); }
  };

  /* 同じ版が返るとき ── 帯は出ない */
  {
    const env = boot('up-same');
    env.advance(16);
    const v = env.d.querySelector('meta[name="app-version"]').getAttribute('content');
    env.w.fetch = () => Promise.resolve({ ok: true,
      text: () => Promise.resolve('<meta name="app-version" content="' + v + '">') });
    env.d.getElementById('ver-check').click();
    await settle(env);
    ok(!env.d.getElementById('update-bar').classList.contains('on'),
       '最新版なら更新の帯は出ない');
    ok(env.errors.length === 0, '確認中に例外が出ない', env.errors[0] || '');
    env.dom.window.close();
  }

  /* 新しい版が返るとき ── 帯が出て版番号を示す */
  {
    const env = boot('up-new');
    env.advance(16);
    env.w.fetch = () => Promise.resolve({ ok: true,
      text: () => Promise.resolve('<meta name="app-version" content="9.9.9">') });
    env.d.getElementById('ver-check').click();
    await settle(env);
    ok(env.d.getElementById('update-bar').classList.contains('on'),
       '新しい版があれば更新の帯が出る');
    ok(/9[.]9[.]9/.test(env.d.getElementById('update-txt').textContent),
       '帯に新しい版番号が出る', env.d.getElementById('update-txt').textContent.slice(0, 40));
    ok(!!env.d.getElementById('update-go'), '更新ボタンがある');
    ok(env.errors.length === 0, '更新案内で例外が出ない', env.errors[0] || '');
    env.dom.window.close();
  }

  /* 確認に失敗するとき ── 手動更新を案内して落ちない */
  {
    const env = boot('up-fail');
    env.advance(16);
    env.w.fetch = () => Promise.reject(new Error('blocked'));
    env.d.getElementById('ver-check').click();
    await settle(env);
    ok(env.d.getElementById('update-bar').classList.contains('on'),
       '確認できないときは手動更新を案内する');
    ok(env.errors.length === 0, '確認失敗でも例外にならない', env.errors[0] || '');
    env.dom.window.close();
  }

  /* HTTP エラーが返るとき */
  {
    const env = boot('up-500');
    env.advance(16);
    env.w.fetch = () => Promise.resolve({ ok: false, status: 500,
      text: () => Promise.resolve('') });
    env.d.getElementById('ver-check').click();
    await settle(env);
    ok(env.d.getElementById('update-bar').classList.contains('on'),
       'サーバがエラーでも手動更新を案内する');
    ok(env.errors.length === 0, 'HTTPエラーでも例外にならない', env.errors[0] || '');
    env.dom.window.close();
  }

  /* fetch が無い環境でも自動確認で落ちない */
  {
    const env = boot('up-none');
    env.advance(16);
    env.advance(2000);          // 起動1.8秒後の自動確認を通す
    await settle(env);
    ok(env.errors.length === 0, 'fetch が無い環境でも自動確認が例外にならない',
       env.errors[0] || '');
    env.dom.window.close();
  }
}

/* =============================================================
   結果
   ============================================================= */
function finish() {
  console.log('\n' + '─'.repeat(58));
  if (fail === 0) console.log(`\x1b[32m全 ${pass} 項目 合格\x1b[0m`);
  else {
    console.log(`\x1b[31m${pass} 合格 / ${fail} 失敗\x1b[0m`);
    for (const f of fails) console.log('  ✗ ' + f);
    process.exitCode = 1;
  }
}
updateTests().then(finish, function (e) {
  console.error('更新テストで例外:', (e && e.stack) || e);
  process.exitCode = 1;
  finish();
});
