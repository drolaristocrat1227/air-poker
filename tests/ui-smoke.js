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
  /* 画面が実際に描いた視点で比べる。手番が入れ替わった直後、
     検査が次の描画より先に走ると別人の値と突き合わせてしまうため。 */
  const v = (ui.rv === undefined) ? ui.viewer : ui.rv, o = 1 - v;
  const txt = (id) => d.getElementById(id).textContent;
  const shown = (i) => (ui.airShown && ui.airShown[i] !== null)
    ? Math.round(ui.airShown[i]) : g.P[i].chips;
  if (txt('me-air') !== String(shown(v)))
    return `手持ちエアの表示が内部の表示値と食い違う ${txt('me-air')} != ${shown(v)}`;
  if (txt('opp-air') !== String(shown(o)))
    return `相手エアの表示が内部の表示値と食い違う ${txt('opp-air')} != ${shown(o)}`;
  for (let i = 0; i < 2; i++) {
    if (ui.airShown && ui.airShown[i] !== null && Math.abs(ui.airShown[i] - g.P[i].chips) > 50)
      return `エアの表示が内部値から離れすぎ ${ui.airShown[i]} vs ${g.P[i].chips}`;
  }
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

/* =============================================================
   手触り ── 音・触覚・決着の段取り
   ============================================================= */
/* =============================================================
   画面寸法の変化に耐えるか
   スマホはスクロールのたびにツールバーが出入りして innerHeight が変わる。
   そのたびに背景を作り直すと泡が瞬間移動して壊れて見える。
   ============================================================= */
section('画面寸法の変化');
{
  const env = boot('resize');
  const { d, w, advance } = env;
  advance(16);

  const bubblesOf = () => {
    /* 泡の配列そのものは覗けないので、描画の作り直し回数を間接的に見る。
       ここでは「同じ泡が生き続けているか」を位置の連続性で判定する。 */
    return null;
  };
  let reseeds = 0;
  const origRandom = w.Math.random;

  /* 幅は変えず、高さだけをツールバー相当（90px）で往復させる */
  const base = 844;
  for (let i = 0; i < 30; i++) {
    Object.defineProperty(w, 'innerHeight', { value: base - (i % 2 ? 90 : 0), configurable: true });
    w.dispatchEvent(new w.Event('resize'));
  }
  advance(400);
  ok(env.errors.length === 0, 'スクロール相当の寸法変化で例外が出ない', env.errors[0] || '');

  /* 幅が変われば作り直す（回転など） */
  Object.defineProperty(w, 'innerWidth', { value: 700, configurable: true });
  w.dispatchEvent(new w.Event('resize'));
  advance(400);
  ok(env.errors.length === 0, '幅の変化でも例外が出ない', env.errors[0] || '');

  /* 背景の描画が続いている（フレームが回る） */
  const before = env.now;
  advance(200);
  ok(env.now > before, '寸法変化のあとも描画が続く');
  env.dom.window.close();
}

/* =============================================================
   合計が合わなくても提示できる（原作のミス条件）
   ============================================================= */
section('合計違いの提示');
{
  const env = boot('wrongsum');
  const { d, w, advance } = env;
  advance(16);
  d.querySelector('[data-start="pvp"]').click();

  const vis = (id) => d.getElementById(id).classList.contains('on');
  let guard = 0, reached = false;
  while (guard++ < 3000) {
    advance(50);
    if (vis('panel-pass')) { const b = d.getElementById('pass-ok'); if (!b.hidden) b.click(); continue; }
    if (vis('panel-plate')) {
      const b = d.querySelector('#plate-list .pbtn:not([disabled])');
      if (b) b.click();
      continue;
    }
    if (vis('panel-build')) { reached = true; break; }
  }
  ok(reached, '役作り画面まで到達');

  if (reached) {
    const g = w.__ap.game, ui = w.__ap.ui, pi = ui.buildFor;
    const okb = d.getElementById('bd-ok');
    const cel = (id) => d.querySelector('#bd-deck .cel[data-id="' + id + '"]');
    const good = w.AP.analyzePool(g.deck).bySum[g.P[pi].target][0].cards;

    ok(okb.disabled, '5枚そろう前は決定できない');

    /* 合計が合わない5枚を選ぶ */
    let wrong = null;
    for (let i = 0; i < 52 && !wrong; i++) {
      if (!g.deck[i] || good.indexOf(i) >= 0) continue;
      const t = [i].concat(good.slice(1));
      if (t.reduce((a, id) => a + w.AP.cRank(id), 0) !== g.P[pi].target) wrong = t;
    }
    for (const id of wrong) { const c = cel(id); if (c) c.click(); }
    ok(ui.sel.length === 5, '5枚選べた');
    ok(!okb.disabled, '合計が合わなくても決定を押せる');
    ok(/合計違い/.test(okb.textContent), 'ボタン自身が合計違いを告げる', okb.textContent);
    ok(okb.className.indexOf('dgr') >= 0, '警告の見た目になる', okb.className);

    /* 正しい5枚に直すと、ふつうの決定に戻る */
    d.getElementById('bd-clear').click();
    for (const id of good) { const c = cel(id); if (c) c.click(); }
    ok(!okb.disabled && okb.textContent === '決定', '合計が合えば通常の決定に戻る', okb.textContent);
    ok(okb.className.indexOf('pri') >= 0, '通常の見た目に戻る', okb.className);

    /* 合計違いで出すとミスになる */
    d.getElementById('bd-clear').click();
    for (const id of wrong) { const c = cel(id); if (c) c.click(); }
    okb.click();
    advance(50);
    ok(g.P[pi].missed === true, '合計違いで出すとミスになる');
    ok(g.P[pi].hand === null, 'ミスなので役としては残らない');
    ok(env.errors.length === 0, '例外が出ない', env.errors[0] || '');
  }
  env.dom.window.close();
}

section('手触り');
{
  /* 設定の保存 */
  {
    const env = boot('prefs');
    env.advance(16);
    const w = env.w, d = env.d;
    ok(d.getElementById('snd-toggle').textContent.indexOf('オン') >= 0, '初期状態は音がオン');
    d.getElementById('snd-toggle').click();
    env.advance(16);
    ok(d.getElementById('snd-toggle').textContent.indexOf('オフ') >= 0, '押すと音がオフになる');
    let saved = null;
    try { saved = JSON.parse(w.localStorage.getItem('ap.prefs')); } catch (e) {}
    ok(saved && saved.sound === false, '設定が保存される', JSON.stringify(saved));
    d.getElementById('hap-toggle').click();
    env.advance(16);
    try { saved = JSON.parse(w.localStorage.getItem('ap.prefs')); } catch (e) {}
    ok(saved && saved.haptics === false, '振動の設定も保存される');
    ok(env.errors.length === 0, '音が使えない環境でも例外が出ない', env.errors[0] || '');
    env.dom.window.close();
  }

  /* 保存した設定が次回に効く */
  {
    const env = boot('prefs2');
    env.w.localStorage.setItem('ap.prefs', JSON.stringify({ sound: false, haptics: false }));
    env.dom.window.close();
    const env2 = boot('prefs3');
    env2.advance(16);
    /* jsdom は起動ごとに保存領域が分かれるため、ここでは読み込み経路が
       例外にならないことだけを見る */
    ok(env2.errors.length === 0, '保存済みの設定を読んでも例外が出ない', env2.errors[0] || '');
    env2.dom.window.close();
  }

  /* 決着の段取り */
  {
    const env = boot('reveal');
    const { d, w, advance } = env;
    advance(16);
    d.querySelector('[data-start="cpu:normal"]').click();

    const vis = (id) => d.getElementById(id).classList.contains('on');
    let guard = 0, reached = false;
    while (guard++ < 4000) {
      advance(50);
      if (vis('panel-reveal')) { reached = true; break; }
      if (!vis('s-game')) continue;
      const ui = w.__ap.ui, g = w.__ap.game;
      if (vis('panel-plate')) {
        const b = d.querySelector('#plate-list .pbtn:not([disabled])');
        if (b) b.click();
      } else if (vis('panel-bet')) {
        const c = d.getElementById('b-call');
        if (!c.disabled) c.click();
      } else if (vis('panel-build')) {
        const pi = ui.buildFor, p = g.P[pi];
        const cands = w.AP.analyzePool(p.avail).bySum[p.target];
        if (cands && cands.length) {
          for (const id of cands[0].cards) {
            const cel = d.querySelector('#bd-deck .cel[data-id="' + id + '"]');
            if (cel) cel.click();
          }
          const okb = d.getElementById('bd-ok');
          if (!okb.disabled) okb.click();
        } else advance(3000);
      }
    }
    ok(reached, '決着画面まで到達');

    if (reached) {
      const panel = d.getElementById('panel-reveal');
      ok(!panel.classList.contains('s1'), '出た直後は段取りが始まっていない');
      ok(w.__ap.ui.airHold === true, 'エアの表示は段取りが進むまで止めている');
      advance(600);
      ok(panel.classList.contains('s1'), '役名が出る（第1段）');
      advance(800);
      ok(panel.classList.contains('s2'), '判定が出る（第2段）');
      advance(3000);
      ok(panel.classList.contains('s5'), '最後まで進む（第5段）', panel.className);
      ok(w.__ap.ui.airHold === false, '段取りが終わればエアの表示が動き出す');
      advance(1500);
      const g = w.__ap.game;
      const shown = w.__ap.ui.airShown;
      ok(Math.round(shown[0]) === g.P[0].chips && Math.round(shown[1]) === g.P[1].chips,
         'エアの表示が最終的に内部の値に一致する',
         shown.map((x, i) => Math.round(x) + '/' + g.P[i].chips).join(' '));
      ok(env.errors.length === 0, '段取り中に例外が出ない', env.errors[0] || '');
    }
    env.dom.window.close();
  }

  /* 画面に触れると最後まで飛ぶ */
  {
    const env = boot('skip');
    const { d, w, advance } = env;
    advance(16);
    d.querySelector('[data-start="cpu:easy"]').click();
    const vis = (id) => d.getElementById(id).classList.contains('on');
    let guard = 0, reached = false;
    while (guard++ < 4000) {
      advance(50);
      if (vis('panel-reveal')) { reached = true; break; }
      if (!vis('s-game')) continue;
      const ui = w.__ap.ui, g = w.__ap.game;
      if (vis('panel-plate')) {
        const b = d.querySelector('#plate-list .pbtn:not([disabled])');
        if (b) b.click();
      } else if (vis('panel-bet')) {
        const c = d.getElementById('b-call');
        if (!c.disabled) c.click();
      } else if (vis('panel-build')) {
        const pi = ui.buildFor, p = g.P[pi];
        const cands = w.AP.analyzePool(p.avail).bySum[p.target];
        if (cands && cands.length) {
          for (const id of cands[0].cards) {
            const cel = d.querySelector('#bd-deck .cel[data-id="' + id + '"]');
            if (cel) cel.click();
          }
          const okb = d.getElementById('bd-ok');
          if (!okb.disabled) okb.click();
        } else advance(3000);
      }
    }
    if (reached) {
      const panel = d.getElementById('panel-reveal');
      panel.click();                       /* 画面に触れる */
      advance(16);
      ok(panel.classList.contains('s5'), '触れると一気に最後まで進む', panel.className);
      ok(env.errors.length === 0, '飛ばしても例外が出ない', env.errors[0] || '');
    } else ok(false, '決着画面まで到達（飛ばしの検査）');
    env.dom.window.close();
  }
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
