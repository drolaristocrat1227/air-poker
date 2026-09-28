/* =============================================================
   エア・ポーカー ルールエンジン検証
   index.html の <script id="core"> をそのまま取り出して実行する。
   実行:  node tests/verify.js
   ============================================================= */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = html.match(/<script id="core">([\s\S]*?)<\/script>/);
if (!m) { console.error('core スクリプトが見つかりません'); process.exit(1); }
vm.runInThisContext(m[1], { filename: 'core.js' });

const AP = globalThis.AP;
const { Game, evalCards, cmpKey, analyzePool, cid, cRank, cardStr,
        SF_SUMS, START_AIR, MAX_ROUNDS, mulberry32 } = AP;

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, detail) {
  if (cond) pass++;
  else { fail++; if (fails.length < 40) fails.push(name + (detail ? '  ── ' + detail : '')); }
}
function section(t) { console.log('\n\x1b[36m── ' + t + '\x1b[0m'); }

/* =============================================================
   共通：不変条件
   ============================================================= */
function invariants(g, tag) {
  const A = g.P[0], B = g.P[1];
  const total = A.chips + B.chips + A.committed + B.committed + g.carry
              + A.burned + B.burned + g.vanished;
  if (total !== START_AIR * 2) return `エア総量不整合 ${total} (${tag})`;
  if (g.vanished < 0) return `消滅エアが負値 (${tag})`;
  if (g.carry < 0) return `持ち越し負値 (${tag})`;
  if (g.cpuFallback) return `CPU が不正手を返した (${tag})`;
  if (A.avail !== B.avail || A.avail !== g.deck) return `山が共有されていない (${tag})`;
  let deckUsed = 0;
  for (let i = 0; i < 52; i++) if (!g.deck[i]) deckUsed++;
  if (deckUsed > 50) return `山から消えた札が多すぎる ${deckUsed} (${tag})`;
  for (const p of g.P) {
    if (p.chips < 0) return `チップ負値 ${p.name} ${p.chips} (${tag})`;
    if (p.committed < 0) return `賭け額負値 ${p.name} (${tag})`;
    if (p.o2 < -1e-6 || p.o2 > 100.001) return `酸素域外 ${p.o2} (${tag})`;
    /* 山は1組を二人で共有する。使った札は双方から消えるので、
       枚数は5の倍数になるとは限らない（重なったぶんだけ減りが鈍る）。 */
    if (p.hand) {
      if (new Set(p.hand).size !== 5) return `提示手に重複 (${tag})`;
      const s = p.hand.reduce((a, id) => a + cRank(id), 0);
      if (s !== p.target) return `提示手の合計不一致 ${s}!=${p.target} (${tag})`;
      if (!p.hand.every(id => id >= 0 && id < 52)) return `札IDが域外 (${tag})`;
    }
  }
  return null;
}

/* =============================================================
   共通：事象駆動シミュレータ
   両CPUが「同時に」考える状況を再現する。
   （逐次に回すと2階の100秒を直列に消費してしまい、後手が必ずミスになる）
   ============================================================= */
function pendingJobs(g) {
  const out = [];
  if (g.phase === 'plate') {
    for (let i = 0; i < 2; i++) if (g.P[i].isCPU && g.plateSel[i] === null) out.push({ pi: i, kind: 'plate' });
  } else if (g.phase === 'bet') {
    if (g.P[g.toAct].isCPU) out.push({ pi: g.toAct, kind: 'bet' });
  } else if (g.phase === 'build') {
    for (let i = 0; i < 2; i++) if (g.P[i].isCPU && !g.submitted[i]) out.push({ pi: i, kind: 'build' });
  }
  return out;
}

function simulate(g, think, opt) {
  opt = opt || {};
  const due = Object.create(null);
  let now = 0, decN = 0, guard = 0, err = null;
  const rec = { rounds: 0, tensai: 0, folds: 0, miss: 0, carry: 0, breaths: 0, seconds: 0 };

  while (g.phase !== 'over') {
    if (++guard > 400000) { err = 'タイムアウト（無限ループの疑い）'; break; }

    if (g.phase === 'reveal') {
      if (g.result) {
        rec.rounds++;
        if (g.result.tensai) rec.tensai++;
        if (g.result.fold) rec.folds++;
        if (g.result.type === 'carry') rec.carry++;
      }
      if (g.P[0].missed || g.P[1].missed) rec.miss++;
      g.nextRound();
      continue;
    }

    const jobs = pendingJobs(g);
    let ran = false;
    for (const j of jobs) {
      /* ベットは逐次（決定ごとに新しい思考時間）。数字選び・役作りは同時進行。 */
      const k = (j.kind === 'bet')
        ? 'bet:' + g.round + ':' + j.pi + ':' + decN
        : g.phase + ':' + g.round + ':' + g.attempt + ':' + j.kind + ':' + j.pi;
      if (due[k] === undefined) due[k] = now + think(j, g);
      if (due[k] <= now + 1e-9) {
        if (opt.pre) { const e = opt.pre(g, j); if (e) { err = e; break; } }
        g.runCPU(j); decN++; ran = true; break;
      }
    }
    if (err) break;
    if (ran) continue;

    if (!jobs.length) {           /* 人間の手番。CPU 同士では起きない */
      err = '人間の入力待ちで停止した'; break;
    }
    if (g.phase === 'bet' || g.phase === 'build') g.tick(0.1);
    now += 0.1;
    if (opt.checkInv !== false) { err = invariants(g, g.phase); if (err) break; }
  }
  rec.breaths = g.P[0].burned + g.P[1].burned;
  rec.seconds = now;
  return { g, err, rec };
}

/* 実戦相当の思考時間。ベット2〜10秒、役作り25〜95秒、数字選びは酸素を消費しない */
function realThink(seed) {
  const r = mulberry32(seed >>> 0);
  return (job) => {
    if (job.kind === 'bet') return 2 + r() * 8;
    if (job.kind === 'build') return 25 + r() * 70;
    return 1;
  };
}

/* =============================================================
   共通：進行の補助（役作りはベットより前に来る）
   ============================================================= */
function openPlates(g){ g.selectPlate(0,0); g.selectPlate(1,0); return g; }
function bestOf(g,i){
  const c=analyzePool(g.P[i].avail).bySum[g.P[i].target];
  return (c&&c.length)?c[0].cards:null;
}
/* 双方が最善手を組んで、ベットまで進める */
function toBet(g){
  openPlates(g);
  for(let i=0;i<2;i++){
    if(g.submitted[i]) continue;
    const h=bestOf(g,i);
    if(h) g.submitHand(i,h); else g.missHand(i);
  }
  return g;
}
/* ベットをコール／チェックで流す */
function passBet(g){
  let n=0;
  while(g.phase==='bet'&&n++<80) g.act(g.toAct, Math.max(0,g.deficit(g.toAct))>0?'call':'check');
  return g;
}

/* =============================================================
   1. 役の評価
   ============================================================= */
section('1. 役評価');
const C = (r, s) => cid(r, s);      // s: 0♠ 1♥ 2♦ 3♣
const key = (cards) => evalCards(cards).key;
const nm  = (cards) => evalCards(cards).name;

ok(nm([C(10,0),C(11,0),C(12,0),C(13,0),C(1,0)]) === 'ロイヤルストレートフラッシュ', 'ロイヤルSF');
ok(nm([C(5,1),C(6,1),C(7,1),C(8,1),C(9,1)]) === 'ストレートフラッシュ', 'SF');
ok(nm([C(1,0),C(2,0),C(3,0),C(4,0),C(5,0)]) === 'ストレートフラッシュ', 'ホイールSF');
ok(nm([C(7,0),C(7,1),C(7,2),C(7,3),C(2,0)]) === 'フォーカード', 'フォーカード');
ok(nm([C(7,0),C(7,1),C(7,2),C(2,3),C(2,0)]) === 'フルハウス', 'フルハウス');
ok(nm([C(2,0),C(5,0),C(9,0),C(11,0),C(13,0)]) === 'フラッシュ', 'フラッシュ');
ok(nm([C(9,0),C(10,1),C(11,0),C(12,0),C(13,0)]) === 'ストレート', 'ストレート');
ok(nm([C(1,0),C(2,1),C(3,0),C(4,0),C(5,0)]) === 'ストレート', 'ホイールストレート');
ok(nm([C(1,0),C(10,1),C(11,0),C(12,0),C(13,0)]) === 'ストレート', 'A ハイストレート');
ok(nm([C(7,0),C(7,1),C(7,2),C(4,3),C(2,0)]) === 'スリーカード', 'スリーカード');
ok(nm([C(7,0),C(7,1),C(4,2),C(4,3),C(2,0)]) === 'ツーペア', 'ツーペア');
ok(nm([C(7,0),C(7,1),C(4,2),C(9,3),C(2,0)]) === 'ワンペア', 'ワンペア');
ok(nm([C(7,0),C(3,1),C(4,2),C(9,3),C(2,0)]) === 'ハイカード', 'ハイカード');
ok(cmpKey(key([C(1,0),C(10,1),C(11,0),C(12,0),C(13,0)]),
          key([C(9,0),C(10,1),C(11,0),C(12,0),C(13,0)])) > 0, 'A ハイ > K ハイ');
ok(cmpKey(key([C(1,0),C(2,1),C(3,0),C(4,0),C(5,0)]),
          key([C(2,0),C(3,1),C(4,0),C(5,0),C(6,0)])) < 0, 'ホイール < 6 ハイ');
/* キッカー */
ok(cmpKey(key([C(7,0),C(7,1),C(13,2),C(4,3),C(2,0)]),
          key([C(7,2),C(7,3),C(12,0),C(4,0),C(2,1)])) > 0, 'ワンペアのキッカー比較');
ok(cmpKey(key([C(7,0),C(7,1),C(7,2),C(7,3),C(13,0)]),
          key([C(6,0),C(6,1),C(6,2),C(6,3),C(1,0)])) > 0, 'フォーカードはランク優先');
ok(cmpKey(key([C(1,0),C(1,1),C(1,2),C(1,3),C(2,0)]),
          key([C(13,0),C(13,1),C(13,2),C(13,3),C(2,1)])) > 0, 'A のフォーカードが最強');

const ladder = [
  [C(7,0),C(3,1),C(4,2),C(9,3),C(2,0)],
  [C(7,0),C(7,1),C(4,2),C(9,3),C(2,0)],
  [C(7,0),C(7,1),C(4,2),C(4,3),C(2,0)],
  [C(7,0),C(7,1),C(7,2),C(4,3),C(2,0)],
  [C(9,0),C(10,1),C(11,0),C(12,0),C(13,0)],
  [C(2,0),C(5,0),C(9,0),C(11,0),C(13,0)],
  [C(7,0),C(7,1),C(7,2),C(2,3),C(2,0)],
  [C(7,0),C(7,1),C(7,2),C(7,3),C(2,0)],
  [C(5,1),C(6,1),C(7,1),C(8,1),C(9,1)]
];
for (let i = 1; i < ladder.length; i++) ok(cmpKey(key(ladder[i]), key(ladder[i-1])) > 0, '役の序列 ' + i);

/* =============================================================
   2. 探索器（analyzePool）── 総当たりと突き合わせる
   ============================================================= */
section('2. 探索器');
{
  const full = new Uint8Array(52).fill(1);
  const an = analyzePool(full);

  let checked = 0, bad = 0;
  for (const sumStr of Object.keys(an.bySum)) {
    const sum = +sumStr;
    for (const c of an.bySum[sumStr]) {
      checked++;
      const s = c.cards.reduce((a, id) => a + cRank(id), 0);
      if (s !== sum) { bad++; continue; }
      if (new Set(c.cards).size !== 5) { bad++; continue; }
      if (!c.cards.every(id => full[id] === 1)) { bad++; continue; }
      if (cmpKey(evalCards(c.cards).key, c.key) !== 0) { bad++; continue; }
      if (c.ranks.reduce((a, r) => a + r, 0) !== sum) bad++;
    }
  }
  ok(bad === 0, '候補の整合性（合計・重複なし・在庫・役の一致）', `${checked}件中 不整合 ${bad}件`);

  const sums = Object.keys(an.bySum).map(Number).sort((a, b) => a - b);
  ok(sums[0] === 6 && sums[sums.length-1] === 64, '合計数の範囲は 6〜64',
     `${sums[0]}..${sums[sums.length-1]}`);

  const sfFound = sums.filter(s => an.bySum[s][0].cat === 8);
  const sfWant = SF_SUMS.slice().sort((a, b) => a - b);
  ok(JSON.stringify(sfFound) === JSON.stringify(sfWant),
     'SF を組める合計数が理論値と一致', JSON.stringify(sfFound));

  /* C(52,5)=2,598,960 通りを全走査して最強役を突き合わせる */
  const brute = {};
  for (let a = 0; a < 52; a++)
  for (let b = a+1; b < 52; b++)
  for (let c = b+1; c < 52; c++)
  for (let d = c+1; d < 52; d++)
  for (let e = d+1; e < 52; e++) {
    const s = cRank(a)+cRank(b)+cRank(c)+cRank(d)+cRank(e);
    const k = evalCards([a,b,c,d,e]).key;
    if (!brute[s] || cmpKey(k, brute[s]) > 0) brute[s] = k;
  }
  let mism = 0, worst = '';
  for (const s of Object.keys(brute)) {
    const mine = an.bySum[s] ? an.bySum[s][0].key : null;
    if (!mine || cmpKey(mine, brute[s]) !== 0) {
      mism++;
      if (!worst) worst = `合計${s}: 探索器=${JSON.stringify(mine)} 総当たり=${JSON.stringify(brute[s])}`;
    }
  }
  ok(mism === 0, '全 260万通りの総当たりと最強役が一致',
     mism ? worst : `${Object.keys(brute).length}通りの合計数すべて一致`);

  let ghost = 0;
  for (let s = 0; s <= 70; s++) if (!!an.bySum[s] !== !!brute[s]) ghost++;
  ok(ghost === 0, '「組める合計数」の集合が総当たりと一致');
}

/* 札が減った状態でも一致するか */
{
  const rnd = mulberry32(20260908);
  let mism = 0, cases = 0, note = '';
  for (let t = 0; t < 6; t++) {
    const av = new Uint8Array(52).fill(1);
    let removed = 0, nRemove = 10 + ((rnd() * 22) | 0);
    while (removed < nRemove) { const i = (rnd() * 52) | 0; if (av[i]) { av[i] = 0; removed++; } }
    const an = analyzePool(av);
    const live = [];
    for (let i = 0; i < 52; i++) if (av[i]) live.push(i);
    const best = {};
    for (let a = 0; a < live.length; a++)
    for (let b = a+1; b < live.length; b++)
    for (let c = b+1; c < live.length; c++)
    for (let d = c+1; d < live.length; d++)
    for (let e = d+1; e < live.length; e++) {
      const cs = [live[a],live[b],live[c],live[d],live[e]];
      const s = cs.reduce((x, id) => x + cRank(id), 0);
      const k = evalCards(cs).key;
      if (!best[s] || cmpKey(k, best[s]) > 0) best[s] = k;
    }
    for (const s of Object.keys(best)) {
      cases++;
      const mine = an.bySum[s] ? an.bySum[s][0].key : null;
      if (!mine || cmpKey(mine, best[s]) !== 0) {
        mism++;
        if (!note) note = `残${live.length}枚 合計${s}: 探索器=${JSON.stringify(mine)} 正解=${JSON.stringify(best[s])}`;
      }
    }
    for (const s of Object.keys(an.bySum)) if (!best[s]) { mism++; if (!note) note = '存在しない合計を出力 ' + s; }
  }
  ok(mism === 0, '札が欠けた山でも総当たりと一致', mism ? note : `${cases}通り一致`);
}

/* =============================================================
   3. CPU 同士の完走（実戦相当の思考時間つき）
   ============================================================= */
section('3. CPU 総当たり対戦');
{
  const diffs = ['easy', 'normal', 'hard'];
  let bad = 0, note = '', games = 0;
  const agg = { rounds: 0, tensai: 0, folds: 0, miss: 0, carry: 0, breaths: 0, seconds: 0 };
  const endBy = { drown: 0, rounds: 0 };
  const winBy = [0, 0, 0];

  for (const d of diffs) {
    for (let seed = 1; seed <= 400; seed++) {
      const sd = seed * 7919 + diffs.indexOf(d) * 13;
      const g = new Game({ mode: 'cpu', difficulty: d, seed: sd });
      g.P[0].isCPU = true; g.P[1].isCPU = true;
      const r = simulate(g, realThink(sd));
      games++;
      if (r.err) { bad++; if (!note) note = `seed=${sd} ${d}: ${r.err}`; continue; }
      if (g.phase !== 'over') { bad++; if (!note) note = `seed=${sd}: 終了しない`; continue; }
      if (g.round > MAX_ROUNDS) { bad++; if (!note) note = `seed=${sd}: 回戦超過 ${g.round}`; }
      endBy[g.overReason] = (endBy[g.overReason] || 0) + 1;
      winBy[g.winner === null ? 2 : g.winner]++;
      for (const k of Object.keys(agg)) agg[k] += r.rec[k] || 0;
    }
  }
  ok(bad === 0, `CPU 対戦 ${games} 戦が不変条件を満たして完走`, note);

  /* 席順の偏りが極端でないか（先手／後手） */
  const decided = winBy[0] + winBy[1];
  const firstRate = winBy[0] / decided;
  ok(firstRate > 0.40 && firstRate < 0.60, '先手・後手の勝率が極端に偏らない',
     `先手 ${(firstRate*100).toFixed(1)}%（${winBy[0]}-${winBy[1]}、引分 ${winBy[2]}）`);

  console.log(`   決着内訳  溺死 ${endBy.drown||0} / 5回戦終了 ${endBy.rounds||0}`);
  console.log(`   1戦平均   回戦 ${(agg.rounds/games).toFixed(2)} ・ 天災 ${(agg.tensai/games).toFixed(2)}` +
              ` ・ フォールド ${(agg.folds/games).toFixed(2)} ・ ミス ${(agg.miss/games).toFixed(3)}` +
              ` ・ 持越 ${(agg.carry/games).toFixed(3)}`);
  console.log(`   呼吸消費  1戦あたり ${(agg.breaths/games).toFixed(1)} 枚（両者合計）` +
              ` ・ 所要 ${(agg.seconds/games).toFixed(0)} 秒`);
}

/* =============================================================
   4. 難易度の強さが単調か
   ============================================================= */
section('4. 難易度の強さ');
{
  function duel(seed, dA, dB) {
    const g = new Game({ mode: 'cpu', difficulty: dA, seed });
    g.P[0].isCPU = true; g.P[1].isCPU = true;
    const r = simulate(g, realThink(seed), {
      pre: (gg, j) => { gg.diff = (j.pi === 0 ? dA : dB); return null; }
    });
    return r.err ? { err: r.err } : { g };
  }
  const pairs = [['easy','hard'], ['easy','normal'], ['normal','hard']];
  for (const [a, b] of pairs) {
    let winA = 0, winB = 0, draw = 0, err = null;
    for (let s = 1; s <= 400; s++) {
      const swap = (s % 2 === 0);          /* 席順の有利不利を打ち消す */
      const r = duel(s * 104729, swap ? b : a, swap ? a : b);
      if (r.err) { err = r.err; break; }
      const w = r.g.winner;
      if (w === null) { draw++; continue; }
      const winnerDiff = (w === 0) ? (swap ? b : a) : (swap ? a : b);
      if (winnerDiff === a) winA++; else winB++;
    }
    ok(!err, `${a} vs ${b} が完走`, err || '');
    const rate = winB / (winA + winB || 1);
    ok(rate > 0.52, `${b} の勝率が ${a} を明確に上回る`,
       `${b} ${winB}勝 / ${a} ${winA}勝 / 引分 ${draw} → ${(rate*100).toFixed(1)}%`);
    console.log(`   ${a} ${winA} - ${winB} ${b}（引分 ${draw}）  ${b} 勝率 ${(rate*100).toFixed(1)}%`);
  }
}

/* =============================================================
   5. ベット規則の境界
   ============================================================= */
section('5. ベット規則');
{
  const g = new Game({ mode: 'pvp', seed: 42 });
  toBet(g);
  ok(g.phase === 'bet', '数字開示でベットへ移行');
  ok(g.pot() === 2, '1回戦の参加料は各1（場に2）', String(g.pot()));
  ok(g.maxRaise(g.toAct) === Math.floor(g.pot() / 2), 'レイズ上限＝場のエアの半分',
     `${g.maxRaise(g.toAct)} / ${Math.floor(g.pot()/2)}`);
  ok(g.act(g.toAct, 'raise', 999) === true, '上限超過のレイズは上限へ丸められる');
  ok(g.P[0].committed + g.P[1].committed === 3, 'レイズ後の場は 3',
     String(g.P[0].committed + g.P[1].committed));
  ok(g.act(g.toAct, 'check') === false, '差額があるときチェックは拒否');
  ok(g.act(1 - g.toAct, 'call') === false, '手番でない側の行動は拒否');
  g.act(g.toAct, 'call');
  ok(g.phase === 'reveal', 'コールでベット終了→決着へ（役作りは済んでいる）');
  ok(g.P[0].committed === g.P[1].committed, 'コール後は賭け額が揃う');

  const g2 = new Game({ mode: 'pvp', seed: 7 });
  toBet(g2);
  for (let i = 0; i < 320; i++) g2.tick(0.1);
  ok(g2.raiseOpen === false, '30秒経過でレイズ不可になる');
  ok(g2.act(g2.toAct, 'raise', 1) === false, '時間切れ後のレイズは拒否される');
  ok(g2.act(g2.toAct, 'check') === true, '時間切れ後もチェックはできる');

  const g3 = new Game({ mode: 'pvp', seed: 99 });
  toBet(g3);
  let t = 0;
  while (g3.phase === 'bet' && t < 20000) { g3.tick(0.1); t++; }
  ok(g3.phase !== 'bet', '完全放置でもベット段階は必ず終了する', `${(t*0.1).toFixed(1)}秒`);

  /* オールインの超過返却 */
  const g4 = new Game({ mode: 'pvp', seed: 5150 });
  toBet(g4);
  g4.P[1].chips = 2;                                  /* 後手を短いスタックにする */
  const totalBefore = g4.P[0].chips + g4.P[1].chips + g4.P[0].committed + g4.P[1].committed;
  let guard = 0;
  while (g4.phase === 'bet' && guard++ < 50) {
    const pi = g4.toAct, d = Math.max(0, g4.deficit(pi));
    const mx = g4.maxRaise(pi);
    if (mx > 0 && d === 0) g4.act(pi, 'raise', mx); else g4.act(pi, 'call');
  }
  ok(g4.P[0].committed === g4.P[1].committed, 'オールイン決着でも賭け額は揃う',
     `${g4.P[0].committed} / ${g4.P[1].committed}`);
  ok(g4.P[0].chips + g4.P[1].chips + g4.P[0].committed + g4.P[1].committed
     + g4.vanished === totalBefore,
     '超過返却でエアが増減しない',
     `${g4.P[0].chips + g4.P[1].chips + g4.P[0].committed + g4.P[1].committed + g4.vanished}`
     + ' vs ' + totalBefore);
}

/* =============================================================
   6. 役作りの時間切れ・天災・持ち越し
   ============================================================= */
section('6. 役作り・天災・持ち越し');
{
  /* 進行の順番：数字 → 役作り → ベット → 決着 */
  {
    const g0 = new Game({ mode: 'pvp', seed: 31 });
    ok(g0.phase === 'plate', '始まりは数字選び');
    openPlates(g0);
    ok(g0.phase === 'build', '数字を開いたら、まず役作り');
    g0.submitHand(0, bestOf(g0, 0));
    ok(g0.phase === 'build', '片方だけではまだ役作り中');
    g0.submitHand(1, bestOf(g0, 1));
    ok(g0.phase === 'bet', '双方が組み終えてからベットへ入る');
  }

  /* フォールドしても札は温存できない */
  {
    const g0 = new Game({ mode: 'pvp', seed: 32 });
    toBet(g0);
    const laid = [g0.P[0].hand.slice(), g0.P[1].hand.slice()];
    g0.act(g0.toAct, 'fold');
    ok(g0.phase === 'reveal', 'フォールドで決着へ');
    ok(laid[0].every(id => g0.P[0].avail[id] === 0) &&
       laid[1].every(id => g0.P[1].avail[id] === 0),
       'フォールドでも出した5枚は双方とも使用済みになる');
  }

  /* 役作りの時間切れ */
  const g = new Game({ mode: 'cpu', difficulty: 'normal', seed: 3 });
  g.selectPlate(0, 0);
  while (g.pendingCPU()) g.runCPU(g.pendingCPU());
  ok(g.phase === 'build', '役作り段階へ');
  while (g.pendingCPU()) g.runCPU(g.pendingCPU());
  let u = 0;
  while (g.phase === 'build' && u < 3000) { g.tick(0.1); u++; }
  ok(g.phase === 'bet', '100秒放置でミス扱いになり、ベットへ進む', `${(u*0.1).toFixed(1)}秒`);
  ok(g.P[0].missed === true, '未提出側がミス扱いになる');
  passBet(g);
  while (g.pendingCPU()) g.runCPU(g.pendingCPU());
  ok(g.phase === 'reveal', 'ベットのあと決着する');
  ok(g.result.winner === 1, 'ミスした側が敗ける');

  /* 天災 */
  const g2 = new Game({ mode: 'pvp', seed: 11 });
  openPlates(g2);
  const h0 = bestOf(g2, 0), h1 = bestOf(g2, 1);
  const dupExpected = h0.some(x => h1.indexOf(x) >= 0);
  g2.submitHand(0, h0); g2.submitHand(1, h1);
  const chipsBefore = [g2.P[0].chips, g2.P[1].chips];
  const paid = [g2.P[0].committed, g2.P[1].committed];
  passBet(g2);
  ok(g2.phase === 'reveal', 'ベットが済めば決着');
  ok(!!g2.result.tensai === dupExpected, '天災の判定が札の重複と一致');
  if (g2.result.type === 'win' && g2.result.tensai) {
    const L = 1 - g2.result.winner, W = g2.result.winner;
    ok(g2.result.extra === Math.min(chipsBefore[L], paid[L]),
       '天災の追加没収＝奪われたエアと同数（残高が上限）');
    ok(g2.vanished === g2.result.extra, '天災で失われたエアは消滅する（勝者へ渡らない）',
       `消滅 ${g2.vanished} / 追加没収 ${g2.result.extra}`);
    ok(g2.P[W].chips === chipsBefore[W] + g2.result.pot,
       '勝者が受け取るのは場のエアだけ',
       `${g2.P[W].chips} vs ${chipsBefore[W] + g2.result.pot}`);
  }
  ok(h0.every(id => g2.deck[id] === 0), '提示した札は以後使えない（自分）');
  ok(h1.every(id => g2.deck[id] === 0), '提示した札は以後使えない（相手）');
  ok(h0.every(id => g2.P[1].avail[id] === 0),
     '相手が使った札も自分の山から消える（1組を共有している）');
  const dupCount = h0.filter(id => h1.indexOf(id) >= 0).length;
  let gone = 0;
  for (let i = 0; i < 52; i++) if (!g2.deck[i]) gone++;
  ok(gone === 10 - dupCount, '重なったぶんだけ山の減りが鈍る',
     `消えた ${gone} 枚 / 重複 ${dupCount} 枚`);

  /* 不正な役は拒否される */
  const g3 = new Game({ mode: 'pvp', seed: 77 });
  openPlates(g3);
  const good = bestOf(g3, 0);
  ok(g3.submitHand(0, [good[0], good[0], good[1], good[2], good[3]]) === false, '同じ札の重複提示は拒否');
  ok(g3.submitHand(0, good.slice(0, 4)) === false, '4枚の提示は拒否');
  const wrong = good.slice();
  wrong[0] = (wrong[0] + 4) % 52;
  if (wrong.reduce((a, id) => a + cRank(id), 0) !== g3.P[0].target)
    ok(g3.submitHand(0, wrong) === false, '合計が合わない提示は拒否');
  ok(g3.submitHand(0, good) === true, '正しい提示は受理される');

  /* 双方ミスの再挑戦と持ち越し */
  const g4 = new Game({ mode: 'pvp', seed: 5 });
  openPlates(g4);
  const potWas = g4.pot();
  let tries = 0;
  g4.missHand(0); g4.missHand(1); tries++;
  ok(g4.phase === 'bet', '双方ミスでも、まずベットへ進む');
  passBet(g4);
  ok(g4.phase === 'build' && g4.buildAlt === true,
     '双方ミスのやり直しは、ベットのあと交互に行う');
  let guard2 = 0;
  while (g4.phase === 'build' && guard2++ < 10) { g4.missHand(0); g4.missHand(1); tries++; }
  ok(g4.phase === 'reveal', '双方ミスを繰り返しても必ず決着する', `試行 ${tries}`);
  ok(tries === 3, '再挑戦は2回まで（計3回でミス確定）', `試行 ${tries}`);
  ok(g4.result.type === 'carry', '3回ミスで持ち越しになる');
  ok(g4.carry === potWas, '持ち越し額が場のエアと一致', `${g4.carry} / ${potWas}`);
  g4.nextRound();
  ok(g4.pot() === potWas + 4, '次回戦の場に持ち越しが乗る（＋参加料2×2）', String(g4.pot()));
}

/* =============================================================
   7. 呼吸と溺死
   ============================================================= */
section('7. 呼吸・溺死');
{
  /* 自分の手番でだけ酸素が減る */
  const g = new Game({ mode: 'pvp', seed: 1234 });
  toBet(g);
  const actor = g.toAct, idle = 1 - actor;
  for (let i = 0; i < 100; i++) g.tick(0.1);            // 10秒
  ok(Math.abs((100 - g.P[actor].o2) - 20) < 0.4, '選択中の者は10秒で酸素20%を失う（倍速）',
     (100 - g.P[actor].o2).toFixed(2));
  ok(Math.abs((100 - g.P[idle].o2) - 10) < 0.4, '選び終えた者は通常の速さで減る',
     (100 - g.P[idle].o2).toFixed(2));

  /* 数字板の選択にも30秒の持ち時間があり、選び終わるまでは倍速 */
  const gp = new Game({ mode: 'pvp', seed: 2468 });
  ok(gp.phase === 'plate', '開始直後は数字板の選択');
  ok(gp.plateClock[0] === AP.PLATE_TIME && AP.PLATE_TIME === 30, '数字板の持ち時間は30秒');
  for (let i = 0; i < 50; i++) gp.tick(0.1);            // 5秒
  ok(Math.abs((100 - gp.P[0].o2) - 10) < 0.3, '数字を選ぶ間も倍速で減る',
     (100 - gp.P[0].o2).toFixed(2));
  ok(Math.abs(gp.plateClock[0] - 25) < 0.2, '持ち時間が減る', gp.plateClock[0].toFixed(1));
  /* 対人戦では、選び終えた側は目隠しの向こうに退くので消費が止まる */
  gp.selectPlate(0, 0);
  const o2WasP = gp.P[0].o2;
  for (let i = 0; i < 50 && gp.phase === 'plate'; i++) gp.tick(0.1);
  ok(gp.P[0].o2 === o2WasP, '対人戦では選び終えた側は目隠しの向こうで消費が止まる',
     (o2WasP - gp.P[0].o2).toFixed(2));

  /* CPU 戦では盤面に着いたままなので、選び終えると通常の速さに戻る */
  const gc = new Game({ mode: 'cpu', difficulty: 'normal', seed: 2469 });
  for (let i = 0; i < 30; i++) gc.tick(0.1);           // 3秒 迷う（倍速）
  const fastPart = 100 - gc.P[0].o2;
  ok(Math.abs(fastPart - 6) < 0.3, 'CPU戦でも選択中は倍速', fastPart.toFixed(2));
  gc.selectPlate(0, 0);
  ok(gc.phase === 'plate', 'CPU がまだ選んでいる');
  const o2WasC = gc.P[0].o2;
  for (let i = 0; i < 50 && gc.phase === 'plate'; i++) gc.tick(0.1);
  ok(Math.abs((o2WasC - gc.P[0].o2) - 5) < 0.3, '選び終えると通常の速さに戻る',
     (o2WasC - gc.P[0].o2).toFixed(2));

  const gp2 = new Game({ mode: 'pvp', seed: 1357 });
  let pg = 0;
  while (gp2.phase === 'plate' && pg++ < 1200) gp2.tick(0.1);
  ok(gp2.phase !== 'plate', '放置しても30秒で数字が押し出される', `${(pg * 0.1).toFixed(1)}秒`);
  ok(gp2.P[0].target > 0 && gp2.P[1].target > 0, '押し出された数字も場に出る');

  /* 酸素が尽きたらエアを1枚使って呼吸する */
  const g0 = new Game({ mode: 'pvp', seed: 999 });
  toBet(g0);
  const who = g0.toAct;
  g0.P[who].o2 = 6;
  const chipsWas = g0.P[who].chips;
  for (let i = 0; i < 100 && g0.phase === 'bet'; i++) g0.tick(0.1);
  ok(g0.P[who].burned === 1, '酸素が尽きるとエアを1枚使って呼吸する', `消費 ${g0.P[who].burned}`);
  ok(g0.P[who].chips === chipsWas - 1, '消費したエアは手持ちから減る');
  ok(g0.P[who].o2 > 80, '呼吸で酸素が満たされる', g0.P[who].o2.toFixed(1));

  /* 役作り100秒を使い切ると、ちょうどエア1枚ぶん */
  const gb = new Game({ mode: 'pvp', seed: 4242 });
  openPlates(gb);
  while (gb.phase === 'bet') gb.act(gb.toAct, Math.max(0, gb.deficit(gb.toAct)) > 0 ? 'call' : 'check');
  const bw = gb.buildTurn, o2b = gb.P[bw].o2, chipsB = gb.P[bw].chips;
  let gguard = 0;
  while (gb.phase === 'build' && gb.buildTurn === bw && gguard++ < 1200) gb.tick(0.1);
  const spent = (chipsB * 100 + o2b) - (gb.P[bw].chips * 100 + gb.P[bw].o2);
  ok(Math.abs(spent - 200) < 2.5, '役作りに100秒を使い切ると倍速でエア2枚ぶん消費する',
     spent.toFixed(1));

  /* 早く提示すればそこで消費が止まる ── 速さがそのままエアになる */
  function airLeftAfterBuild(elapsedSteps) {
    const gg = new Game({ mode: 'pvp', seed: 5150 });
    openPlates(gg);
    while (gg.phase === 'bet') gg.act(gg.toAct, Math.max(0, gg.deficit(gg.toAct)) > 0 ? 'call' : 'check');
    const w = gg.buildTurn;
    for (let i = 0; i < elapsedSteps && gg.phase === 'build' && gg.buildTurn === w; i++) gg.tick(0.1);
    if (gg.phase === 'build' && gg.buildTurn === w) {
      gg.submitHand(w, analyzePool(gg.P[w].avail).bySum[gg.P[w].target][0].cards);
    }
    for (let i = 0; i < 600; i++) gg.tick(0.1);       // 提示後も時間を進めてみる
    return gg.P[w].chips * 100 + gg.P[w].o2;
  }
  const fast = airLeftAfterBuild(150), slow = airLeftAfterBuild(800);   // 15秒 / 80秒
  ok(fast > slow + 50, '速く役を決めるほどエアが残る',
     `15秒 ${fast.toFixed(0)} / 80秒 ${slow.toFixed(0)}`);

  /* 停止・一時停止では減らない */
  const g1 = new Game({ mode: 'pvp', seed: 4321 });
  toBet(g1);
  const t0 = g1.toAct, o2Was = g1.P[t0].o2;
  g1.phase = 'reveal';
  for (let i = 0; i < 600; i++) g1.tick(0.1);
  ok(g1.P[t0].o2 === o2Was, '結果表示中は酸素が減らない');
  g1.phase = 'bet'; g1.paused = true;
  for (let i = 0; i < 600; i++) g1.tick(0.1);
  ok(g1.P[t0].o2 === o2Was, '目隠し中（一時停止）は酸素が減らない');

  /* 溺死 */
  const g3 = new Game({ mode: 'pvp', seed: 8 });
  toBet(g3);
  const dz = g3.toAct;
  g3.P[dz].chips = 0; g3.P[dz].o2 = 0.5;
  g3.tick(1);
  ok(g3.P[dz].drowning === true, 'エアが尽きると溺水状態になる');
  ok(g3.P[dz].o2 === 0, '溺水中の酸素は0で止まる');
  g3.act(dz, 'fold');                 /* 降りて負ける＝場のエアは戻らない */
  ok(g3.phase === 'reveal', '決着へ進む');
  ok(g3.P[dz].chips === 0, '手持ちは0のまま');
  g3.nextRound();
  ok(g3.phase === 'over' && g3.winner === 1 - dz, '手持ち0のまま回戦を終えると敗北', `winner=${g3.winner}`);
  ok(g3.overReason === 'drown', '敗因は溺死');

  /* 役作りがベットより前に来たため、降りても役作りぶんの酸素は既に払っている。
     降りて浮くのは賭けたエアだけ。札は温存できない。 */
  {
    const gf = new Game({ mode: 'pvp', seed: 7373 });
    toBet(gf);
    const laid = [gf.P[0].hand.slice(), gf.P[1].hand.slice()];
    const chipsBefore = gf.P[0].chips;
    gf.act(gf.toAct, 'fold');
    ok(laid[0].every(id => gf.P[0].avail[id] === 0),
       '降りても自分の出した5枚は使用済みになる');
    ok(laid[1].every(id => gf.P[1].avail[id] === 0),
       '降りても相手の出した5枚は使用済みになる');
    ok(gf.P[0].chips === chipsBefore, '降りたぶん、それ以上は賭けずに済む');
  }

  /* CPU は待たせない代わりに思考時間を酸素へ計上する */
  const g4 = new Game({ mode: 'cpu', difficulty: 'normal', seed: 55 });
  g4.selectPlate(0, 0);
  while (g4.phase === 'plate' && g4.pendingCPU()) g4.runCPU(g4.pendingCPU());
  ok(g4.phase === 'build', '数字のあとは役作り');
  const before4 = g4.P[1].chips * 100 + g4.P[1].o2;
  g4.runCPU(g4.pendingCPU());
  const after4 = g4.P[1].chips * 100 + g4.P[1].o2;
  ok(before4 - after4 > 15, 'CPU の役作りも酸素を消費する', `${(before4 - after4).toFixed(1)}%`);
  ok(g4.P[1].lastBuild > 10, 'CPU の役作り時間が記録される', `${g4.P[1].lastBuild.toFixed(0)}秒`);
  ok(g4.P[1].thought > 0, 'CPU の思考時間が積算される');
}

/* =============================================================
   8. 数字板の配り方
   ============================================================= */
section('8. 数字板');
{
  const anFull = analyzePool(new Uint8Array(52).fill(1));
  let bad = 0, note = '';
  const hist = {};
  for (let s = 0; s < 500; s++) {
    const g = new Game({ mode: 'pvp', seed: s * 31 + 5 });
    const all = g.P[0].plates.concat(g.P[1].plates);
    if (new Set(all).size !== 10) { bad++; if (!note) note = '数字が重複した'; }
    if (!all.every(n => n >= AP.PLATE_LO && n <= AP.PLATE_HI)) { bad++; if (!note) note = '範囲外の数字'; }
    if (!all.every(n => !!anFull.bySum[n])) { bad++; if (!note) note = '初期デッキで組めない数字が配られた'; }
    for (const n of all) hist[n] = (hist[n] || 0) + 1;
  }
  ok(bad === 0, '数字板は重複なく配られ、初期デッキでは必ず組める（500回）', note);
  ok(AP.PLATE_LO === 6 && AP.PLATE_HI === 64, '配布範囲は 6〜64',
     `${AP.PLATE_LO}〜${AP.PLATE_HI}`);

  const seen = Object.keys(hist).length;
  ok(seen === AP.PLATE_HI - AP.PLATE_LO + 1, '6〜64 の全ての数字が現れる', `${seen} 種`);
  /* 山を共有すると終盤の帯が狭まるので、端の数字は各自2枚まで、
     残り3枚は終盤まで組める中核帯から配る。 */
  let bad2 = 0, note2 = '';
  for (let s2 = 0; s2 < 400; s2++) {
    const g = new Game({ mode: 'pvp', seed: s2 * 71 + 9 });
    for (const p of g.P) {
      const wide = p.plates.filter(n => n < AP.CORE_LO || n > AP.CORE_HI).length;
      const core = p.plates.filter(n => n >= AP.CORE_LO && n <= AP.CORE_HI).length;
      if (wide !== 2 || core !== 3) { bad2++; if (!note2) note2 = `端${wide}枚 / 中核${core}枚`; }
    }
  }
  ok(bad2 === 0, '各自「端に寄った数字2枚＋中核帯3枚」で配られる', note2);
  const wideSeen = Object.keys(hist).map(Number).filter(n => n < AP.CORE_LO || n > AP.CORE_HI).length;
  const coreSeen = Object.keys(hist).map(Number).filter(n => n >= AP.CORE_LO && n <= AP.CORE_HI).length;
  ok(coreSeen === AP.CORE_HI - AP.CORE_LO + 1, '中核帯の数字は全て出る', String(coreSeen));
  ok(wideSeen >= 30, '端の数字も широко 出る'.replace('широко', '広く'), String(wideSeen));

  /* S.F. 圏内の均等配分は廃止した ── 枚数はばらつき、0枚の配りもある */
  const sfCounts = {};
  for (let s = 0; s < 500; s++) {
    const g = new Game({ mode: 'pvp', seed: s * 977 + 3 });
    const c = g.P[0].plates.filter(n => SF_SUMS.indexOf(n) >= 0).length;
    sfCounts[c] = (sfCounts[c] || 0) + 1;
  }
  ok(Object.keys(sfCounts).length > 1, 'ストレートフラッシュ圏内の枚数は固定されない',
     JSON.stringify(sfCounts));
  ok((sfCounts[0] || 0) > 0, 'S.F. 圏内の数字が1枚も来ない配りもある',
     `${sfCounts[0] || 0}/500 回`);
}

section('9. 端の数字の危うさ');
{
  /* 6 や 64 のような端の数字は組める役が一通りしかなく、札が減れば組めなくなる。
     これは 6〜64 配布の設計上の帰結であり、エンジンは自動ミス／持ち越しで安全に処理する。
     ここでは「どの程度の頻度で、どの回戦に起きるか」を測っておく。 */
  let noSol = 0, cases = 0, byRound = [0, 0, 0, 0, 0, 0];
  for (let s = 1; s <= 300; s++) {
    const sd = s * 613;
    const g = new Game({ mode: 'cpu', difficulty: 'hard', seed: sd });
    g.P[0].isCPU = true; g.P[1].isCPU = true;
    simulate(g, realThink(sd), {
      pre: (gg, j) => {
        if (j.kind !== 'build' || gg.attempt !== 1 || j.pi !== 0) return null;
        for (const p of gg.P) { cases++; if (!p.hasSol) { noSol++; byRound[gg.round]++; } }
        return null;
      }
    });
  }
  const rate = cases ? noSol / cases : 0;
  ok(rate < 0.03, '「組めない」が起きる割合は数%以内に収まる',
     `${noSol}/${cases} = ${(rate * 100).toFixed(2)}%（回戦別 ${byRound.slice(1).join('・')}）`);
  ok(byRound[1] === 0, '配ったばかりの山（第1回戦）では必ず組める',
     `回戦別 ${byRound.slice(1).join('・')}`);
  ok(byRound[1] + byRound[2] <= cases * 0.02, '序盤で起きても2%以内に収まる',
     `第1回戦 ${byRound[1]} / 第2回戦 ${byRound[2]} / 全${cases}件`);

  /* 起きた場合でも安全に処理されること */
  const g3 = new Game({ mode: 'pvp', seed: 4004 });
  for (let i = 0; i < 52; i++) { g3.P[0].avail[i] = 0; g3.P[1].avail[i] = 0; }
  openPlates(g3);
  ok(g3.P[0].hasSol === false && g3.P[1].hasSol === false, '組める役が無いことを検知する');
  let guard = 0;
  while (g3.phase === 'bet' && guard++ < 50)
    g3.act(g3.toAct, Math.max(0, g3.deficit(g3.toAct)) > 0 ? 'call' : 'check');
  ok(g3.phase === 'reveal', '双方組めなくても決着段階へ進む');
  ok(g3.result && g3.result.type === 'carry', '場のエアは次回戦へ持ち越される');

  /* 山が痩せても、打ち直しによって必ず組める数字になる */
  {
    let checked = 0, dead = 0;
    for (let s3 = 1; s3 <= 200; s3++) {
      const g = new Game({ mode: 'cpu', difficulty: 'normal', seed: s3 * 311 });
      g.P[0].isCPU = true; g.P[1].isCPU = true;
      let guard3 = 0, seen3 = 0;
      while (g.phase !== 'over' && guard3++ < 200000) {
        if (g.phase === 'plate' && seen3 !== g.round) {
          seen3 = g.round;
          const an = analyzePool(g.deck);
          for (const p of g.P)
            for (let k = 0; k < 5; k++) {
              if (p.plateUsed[k]) continue;
              checked++;
              if (!an.bySum[p.plates[k]]) dead++;
            }
        }
        if (g.phase === 'reveal') { g.nextRound(); continue; }
        const j = g.pendingCPU();
        if (j) g.runCPU(j); else g.tick(0.1);
      }
    }
    ok(dead === 0, '回戦の初めに、手持ちの数字板は全て組める状態になっている',
       `${dead}/${checked} 枚が組めない`);
  }

  /* 打ち直しが実際に起きること、元より狭い帯に収まること */
  {
    const g = new Game({ mode: 'pvp', seed: 777 });
    /* 山を強引に痩せさせる */
    for (let i = 0; i < 52; i++) if (i % 4 !== 0) g.deck[i] = 0;
    g.P[0].plates[0] = 6; g.P[1].plates[0] = 64;
    g.remintDeadPlates();
    const an = analyzePool(g.deck);
    ok(!!an.bySum[g.P[0].plates[0]] && !!an.bySum[g.P[1].plates[0]],
       '組めなくなった数字板は組める数字へ打ち直される',
       `${g.P[0].plates[0]} / ${g.P[1].plates[0]}`);
    ok(g.reminted[0].length + g.reminted[1].length >= 2, '打ち直しが記録される');
  }

  /* 片方だけミスならその者が回戦を落とす */
  {
    const g = new Game({ mode: 'pvp', seed: 4242 });
    openPlates(g);
    g.submitHand(1, bestOf(g, 1));
    g.missHand(0, '合計数が違う');
    passBet(g);
    ok(g.phase === 'reveal' && g.result.winner === 1, 'ミスした側がその回戦を落とす');
  }
}

/* =============================================================
   10. CPU の指し手が常に合法か
   ============================================================= */
section('10. CPU の合法性');
{
  let illegal = 0, note = '', acts = 0, builds = 0, plates = 0;
  for (const d of ['easy', 'normal', 'hard']) {
    for (let s = 1; s <= 250; s++) {
      const sd = s * 977 + d.length;
      const g = new Game({ mode: 'cpu', difficulty: d, seed: sd });
      g.P[0].isCPU = true; g.P[1].isCPU = true;
      const r = simulate(g, realThink(sd), {
        pre: (gg, j) => {
          if (j.kind === 'bet') {
            acts++;
            const a = AP.cpuBet(gg, j.pi);
            const p = gg.P[j.pi], def = Math.max(0, gg.deficit(j.pi));
            if (a.action === 'raise') {
              if (!(a.amount >= 1 && a.amount <= gg.maxRaise(j.pi)))
                return `不正なレイズ額 ${a.amount}（上限 ${gg.maxRaise(j.pi)}）`;
              if (def + a.amount > p.chips) return '所持を超える賭け';
              if (!gg.raiseOpen) return 'レイズ不可時間にレイズしようとした';
            } else if (a.action === 'check' && def > 0) return '差額があるのにチェック';
            else if (a.action === 'call' && def === 0 && p.chips < 0) return 'ありえないコール';
          } else if (j.kind === 'build') {
            builds++;
            const p = gg.P[j.pi];
            const h = p.plan || AP.cpuPlanHand(gg, j.pi);
            if (h && !gg.validHand(j.pi, h))
              return `不正な役 ${h.map(cardStr).join(' ')}（目標 ${p.target}）`;
            if (!h && p.hasSol) return '組めるのに手を作らなかった';
          } else {
            plates++;
            const idx = AP.cpuPlate(gg, j.pi);
            if (!(idx >= 0 && idx < 5) || gg.P[j.pi].plateUsed[idx]) return '使用済みの数字板を選んだ';
          }
          return null;
        }
      });
      if (r.err) { illegal++; if (!note) note = `seed=${sd} ${d}: ${r.err}`; }
      if (g.cpuFallback) { illegal++; if (!note) note = 'フォールバックが発動した'; }
    }
  }
  ok(illegal === 0, `CPU の指し手が全て合法（ベット${acts} 役作り${builds} 数字${plates}）`, note);
}

/* =============================================================
   11. 上級 CPU の天災狙いが勝ちを捨てていないか
   ============================================================= */
section('11. 上級 CPU の天災狙い');
{
  let sacrificed = 0, cases = 0, tensaiHit = 0, note = '';
  for (let s = 1; s <= 400; s++) {
    const sd = s * 1597;
    const g = new Game({ mode: 'cpu', difficulty: 'hard', seed: sd });
    g.P[0].isCPU = true; g.P[1].isCPU = true;
    const r = simulate(g, realThink(sd), {
      pre: (gg, j) => {
        if (j.kind !== 'build') return null;
        const me = gg.P[j.pi], opp = gg.P[1 - j.pi];
        const mine = analyzePool(me.avail).bySum[me.target];
        const theirs = analyzePool(opp.avail).bySum[opp.target];
        if (!mine || !theirs || !me.plan) return null;
        cases++;
        const chosen = evalCards(me.plan).key;
        if (cmpKey(mine[0].key, theirs[0].key) > 0 && cmpKey(chosen, theirs[0].key) <= 0) {
          sacrificed++;
          if (!note) note = `勝てる手を捨てた 目標${me.target}: 選=${JSON.stringify(chosen)}` +
                            ` 最強=${JSON.stringify(mine[0].key)} 相手最強=${JSON.stringify(theirs[0].key)}`;
        }
        return null;
      }
    });
    tensaiHit += r.rec.tensai;
  }
  ok(sacrificed === 0, '上級 CPU は天災狙いで勝ちを手放さない',
     note || `${cases} 件検査 / 天災 ${tensaiHit} 回発生`);
}

/* =============================================================
   12. 難易度のバランス（人間モデル二種を相手にする）
   ・のんびり型 … 最善手は組むが、常にコール／チェック
   ・熟考型     … 相手の数字から理論上の最強手を計算し、勝てるときだけ押す
   ============================================================= */
section('12. バランス（対 人間モデル）');
{
  function bestCards(g, pi) {
    const c = analyzePool(g.P[pi].avail).bySum[g.P[pi].target];
    return (c && c.length) ? c[0].cards : null;
  }
  function platePlain(g, pi, r) {
    const rem = [];
    for (let i = 0; i < 5; i++) if (!g.P[pi].plateUsed[i]) rem.push(i);
    return rem[(r() * rem.length) | 0];
  }
  const casual = {
    plate: platePlain,
    hand: bestCards,
    bet: (g, pi) => (Math.max(0, g.deficit(pi)) > 0 ? { action: 'call' } : { action: 'check' })
  };
  const careful = {
    /* 弱い数字から先に切り、勝負どころの後半に強い数字を残す */
    plate: (g, pi) => {
      const an = analyzePool(g.P[pi].avail), oan = analyzePool(g.P[1 - pi].avail);
      const pool = [];
      for (let n = AP.PLATE_LO; n <= AP.PLATE_HI; n++) if (g.playedNums.indexOf(n) < 0) pool.push(n);
      const sc = [];
      for (let i = 0; i < 5; i++) {
        if (g.P[pi].plateUsed[i]) continue;
        const c = an.bySum[g.P[pi].plates[i]];
        if (!c) { sc.push({ i, s: -1 }); continue; }
        let w = 0;
        for (const n of pool) {
          const oc = oan.bySum[n];
          if (!oc) { w++; continue; }
          const k = cmpKey(c[0].key, oc[0].key);
          w += k > 0 ? 1 : (k < 0 ? 0 : 0.5);
        }
        sc.push({ i, s: w / pool.length });
      }
      sc.sort((a, b) => a.s - b.s);
      const idx = Math.min(sc.length - 1, Math.round((g.round - 1) / (MAX_ROUNDS - 1) * (sc.length - 1)));
      return sc[idx].i;
    },
    hand: bestCards,
    bet: (g, pi) => {
      const mine = analyzePool(g.P[pi].avail).bySum[g.P[pi].target];
      const theirs = analyzePool(g.P[1 - pi].avail).bySum[g.P[1 - pi].target];
      const d = Math.max(0, g.deficit(pi)), mx = g.maxRaise(pi);
      const myK = (mine && mine.length) ? mine[0].key : null;
      const opK = (theirs && theirs.length) ? theirs[0].key : null;
      const cmp = !opK ? 1 : (!myK ? -1 : cmpKey(myK, opK));
      if (cmp > 0) {
        if (g.raiseOpen && mx > 0) return { action: 'raise', amount: mx };
        return d > 0 ? { action: 'call' } : { action: 'check' };
      }
      if (cmp < 0) return d > 0 ? { action: 'fold' } : { action: 'check' };
      return d > 0 ? { action: 'call' } : { action: 'check' };
    }
  };

  function playVsCPU(seed, diff, human) {
    const g = new Game({ mode: 'cpu', difficulty: diff, seed });
    const r = mulberry32((seed ^ 0x9e3779b9) >>> 0);
    const cpuThink = realThink(seed);
    const humanThink = (j) => (j.kind === 'bet' ? 4 : (j.kind === 'build' ? 55 : 1));
    const due = Object.create(null);
    let now = 0, decN = 0, guard = 0;

    while (g.phase !== 'over') {
      if (++guard > 400000) return { err: 'タイムアウト' };
      if (g.phase === 'reveal') { g.nextRound(); continue; }
      const jobs = [];
      if (g.phase === 'plate') {
        for (let i = 0; i < 2; i++) if (g.plateSel[i] === null) jobs.push({ pi: i, kind: 'plate' });
      } else if (g.phase === 'bet') jobs.push({ pi: g.toAct, kind: 'bet' });
      else if (g.phase === 'build') {
        for (let i = 0; i < 2; i++) if (!g.submitted[i]) jobs.push({ pi: i, kind: 'build' });
      }
      if (!jobs.length) { g.tick(0.1); now += 0.1; continue; }

      let ran = false;
      for (const j of jobs) {
        const k = (j.kind === 'bet')
          ? 'bet:' + g.round + ':' + j.pi + ':' + decN
          : g.phase + ':' + g.round + ':' + g.attempt + ':' + j.kind + ':' + j.pi;
        if (due[k] === undefined) due[k] = now + (j.pi === 0 ? humanThink(j) : cpuThink(j, g));
        if (due[k] > now + 1e-9) continue;
        if (j.pi === 1) g.runCPU(j);
        else if (j.kind === 'plate') g.selectPlate(0, human.plate(g, 0, r));
        else if (j.kind === 'bet') {
          const a = human.bet(g, 0, r);
          if (!g.act(0, a.action, a.amount)) g.act(0, Math.max(0, g.deficit(0)) > 0 ? 'call' : 'check');
        } else {
          const h = human.hand(g, 0);
          if (h && g.validHand(0, h)) g.submitHand(0, h); else g.missHand(0);
        }
        decN++; ran = true; break;
      }
      if (ran) continue;
      if (g.phase === 'bet' || g.phase === 'build') g.tick(0.1);
      now += 0.1;
      const e = invariants(g, '人間対戦');
      if (e) return { err: e };
    }
    return { g };
  }

  const models = [['のんびり型', casual], ['熟考型', careful]];
  const table = {};
  let broke = null;
  for (const [mname, hm] of models) {
    table[mname] = {};
    for (const d of ['easy', 'normal', 'hard']) {
      let win = 0, lose = 0, draw = 0;
      for (let s = 1; s <= 250; s++) {
        const out = playVsCPU(s * 2749 + d.length, d, hm);
        if (out.err) { broke = `${mname} vs ${d}: ${out.err}`; break; }
        if (out.g.winner === 0) win++; else if (out.g.winner === 1) lose++; else draw++;
      }
      if (broke) break;
      table[mname][d] = win / (win + lose || 1);
      console.log(`   ${mname} vs ${d}: ${win}勝 ${lose}敗 ${draw}分  勝率 ${(table[mname][d]*100).toFixed(1)}%`);
    }
    if (broke) break;
  }
  ok(!broke, '人間モデルとの対戦が完走', broke || '');
  if (!broke) {
    ok(table['のんびり型'].easy > 0.35,
       'のんびり型でも初級には手が届く', `${(table['のんびり型'].easy*100).toFixed(1)}%`);
    ok(table['熟考型'].easy > table['のんびり型'].easy,
       '読みの深さが勝率に反映される（初級）',
       `熟考 ${(table['熟考型'].easy*100).toFixed(1)}% / のんびり ${(table['のんびり型'].easy*100).toFixed(1)}%`);
    ok(table['熟考型'].hard > table['のんびり型'].hard,
       '読みの深さが勝率に反映される（上級）',
       `熟考 ${(table['熟考型'].hard*100).toFixed(1)}% / のんびり ${(table['のんびり型'].hard*100).toFixed(1)}%`);
    ok(table['のんびり型'].easy > table['のんびり型'].hard,
       '同じ打ち方なら上級のほうが手強い',
       `初級 ${(table['のんびり型'].easy*100).toFixed(1)}% → 上級 ${(table['のんびり型'].hard*100).toFixed(1)}%`);
    ok(table['熟考型'].hard > 0.30,
       '上級にも勝ち筋が残っている', `${(table['熟考型'].hard*100).toFixed(1)}%`);
  }
}

/* =============================================================
   13. 速さがそのままエアになるか（消費モデルの核心）
   ============================================================= */
section('13. 速さの価値');
{
  /* 両者とも「常にコール」で毎回戦かならず役作りまで進む条件にし、
     役作りにかける秒数だけを変えて勝率と呼吸量を比べる。 */
  function bestCards(g, pi) {
    const c = analyzePool(g.P[pi].avail).bySum[g.P[pi].target];
    return (c && c.length) ? c[0].cards : null;
  }
  function duel(seed, tA, tB) {
    const g = new Game({ mode: 'pvp', seed });
    const r = mulberry32((seed ^ 0x5bf0) >>> 0);
    const think = [tA, tB], due = Object.create(null);
    let now = 0, dec = 0, guard = 0;
    while (g.phase !== 'over') {
      if (++guard > 500000) return null;
      if (g.phase === 'reveal') { g.nextRound(); continue; }
      let job = null;
      if (g.phase === 'plate') { const t = g.plateTurn(); if (g.plateSel[t] === null) job = { pi: t, kind: 'plate' }; }
      else if (g.phase === 'bet') job = { pi: g.toAct, kind: 'bet' };
      else if (g.phase === 'build') { const t = g.buildTurn; if (!g.submitted[t]) job = { pi: t, kind: 'build' }; }
      if (!job) { g.tick(0.1); now += 0.1; continue; }
      const k = (job.kind === 'bet')
        ? 'b' + g.round + job.pi + dec
        : g.phase + g.round + g.attempt + job.kind + job.pi;
      if (due[k] === undefined)
        due[k] = now + (job.kind === 'bet' ? 4 : (job.kind === 'build' ? think[job.pi] : 6));
      if (due[k] <= now + 1e-9) {
        if (job.kind === 'plate') {
          const rem = [];
          for (let i = 0; i < 5; i++) if (!g.P[job.pi].plateUsed[i]) rem.push(i);
          g.selectPlate(job.pi, rem[(r() * rem.length) | 0]);
        } else if (job.kind === 'bet') {
          g.act(job.pi, Math.max(0, g.deficit(job.pi)) > 0 ? 'call' : 'check');
        } else {
          const h = bestCards(g, job.pi);
          if (h && g.validHand(job.pi, h)) g.submitHand(job.pi, h); else g.missHand(job.pi);
        }
        dec++; continue;
      }
      const e = invariants(g, '速さ検証');
      if (e) return { err: e };
      g.tick(0.1); now += 0.1;
    }
    return { g };
  }
  function run(tA, tB, N) {
    const w = [0, 0, 0]; let b0 = 0, b1 = 0, n = 0, err = null;
    for (let s = 1; s <= N; s++) {
      const out = duel(s * 104729, tA, tB);
      if (!out) { err = 'タイムアウト'; break; }
      if (out.err) { err = out.err; break; }
      const g = out.g; n++;
      w[g.winner === null ? 2 : g.winner]++;
      b0 += g.P[0].burned; b1 += g.P[1].burned;
    }
    return { err, rate: w[0] / (w[0] + w[1] || 1), w, b0: b0 / n, b1: b1 / n };
  }

  const even = run(50, 50, 400);
  ok(!even.err, '同条件の対戦が完走', even.err || '');
  ok(even.rate > 0.44 && even.rate < 0.56, '同条件なら席順で有利不利が出ない',
     `P1 ${(even.rate * 100).toFixed(1)}%（${even.w[0]}-${even.w[1]}、分 ${even.w[2]}）`);
  ok(Math.abs(even.b0 - even.b1) < 0.4, '同条件なら呼吸量もほぼ同じ',
     `${even.b0.toFixed(2)} / ${even.b1.toFixed(2)}`);

  const gap = run(25, 75, 400);
  ok(gap.rate > 0.54, '速く役を決める側が明確に有利になる',
     `25秒側 ${(gap.rate * 100).toFixed(1)}%（${gap.w[0]}-${gap.w[1]}）`);
  ok(gap.b0 < gap.b1 - 2, '速い側は呼吸に使うエアが少なくて済む',
     `25秒 ${gap.b0.toFixed(2)}枚 / 75秒 ${gap.b1.toFixed(2)}枚`);
  console.log(`   両者50秒: P1 ${(even.rate*100).toFixed(1)}%  呼吸 ${even.b0.toFixed(2)}/${even.b1.toFixed(2)}`);
  console.log(`   25秒 vs 75秒: 速い側 ${(gap.rate*100).toFixed(1)}%  呼吸 ${gap.b0.toFixed(2)}/${gap.b1.toFixed(2)}`);

  const wide = run(15, 90, 300);
  ok(wide.rate > gap.rate, '差が大きいほど効き方も大きくなる',
     `15秒 vs 90秒 → ${(wide.rate * 100).toFixed(1)}%`);
  console.log(`   15秒 vs 90秒: 速い側 ${(wide.rate*100).toFixed(1)}%  呼吸 ${wide.b0.toFixed(2)}/${wide.b1.toFixed(2)}`);
}

/* =============================================================
   結果
   ============================================================= */
console.log('\n' + '─'.repeat(58));
if (fail === 0) {
  console.log(`\x1b[32m全 ${pass} 項目 合格\x1b[0m`);
} else {
  console.log(`\x1b[31m${pass} 合格 / ${fail} 失敗\x1b[0m`);
  for (const f of fails) console.log('  ✗ ' + f);
  process.exitCode = 1;
}
