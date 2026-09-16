// 宿題ページの生成（統括が利用者に渡す用）。
// 文章の校正シートは6週間動かなかったので、クリックだけで終わる形に作り直す。
// 出力: _local/宿題.html（gitignore対象。ローカルで開くだけの静的ファイル）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const L = path.join(ROOT, '_local')

// --- 判断もの（校正シート由来） -------------------------------------------
const D = (id, group, q, why, opts) => ({ id, group, q, why, opts })
const R = '（統括の推奨）'
const decisions = [
  D('A-1', 'バトル', 'バトル参加キャラが消耗するのは「キャラを指定した瞬間」でよいか',
    '設計書の2箇所が食い違っていた。原典20-4[7]「バトル参加キャラ１体を指定する。その後、そのキャラを消耗させる」＋FAQも同じ。→ §4.10（種目を決めるとき）が誤りで §5.2（キャラ指定時）が正しい、として直す。',
    ['それでよい', '違う（あとで理由を聞かせてください）']),
  D('A-2', 'バトル', '「バトル終了時」と「バトルが終了したとき」を別物として扱ってよいか',
    'カードテキストの1文字違いで挙動が変わる。中断したとき、前者は走るが後者は走らない（20-6-1）。ツールで1つのボタンにまとめると事故る。',
    ['別物として扱う', '違う']),
  D('A-3', 'バトル', 'バトル終了で消えるのは「攻防修正」だけ、という区別を作ってよいか',
    '能力値修正はターン終了まで残る（12-1）。今のツールは「このバトル」の修正を一括で消すので、消してはいけないものを消している。',
    ['区別を作る', '違う']),
  D('A-4', 'バトル', '割り込みの窓の数を「約13個」と固定しない、でよいか',
    '原典[21]で手順[19]に戻れるので、窓の数は実行時に決まる（上限なし）。設計書の「約13個」という書き方を直したい。',
    ['それでよい', '違う']),
  D('B-1', 'バトル', 'バトル種目（バトルカード）を選ぶのは、挑んだ側？ 受けた側？',
    '⚠️資料が正反対。詳細ルールは主語を一度も書いていない。簡易ルール＝「挑んだ側が宣言」、FAQ(2007/10/18)＝「本来バトルを受ける側のプレイヤーが選ぶ」。実戦の記憶で決めてほしい。',
    ['挑んだ側が選ぶ', '受けた側が選ぶ', '状況による']),
  D('B-2', 'バトル', '待機キャラを切らすと詰む、という負け筋をツールが警告すべきか',
    '待機キャラがいないとリーダーが自動で受けさせられ、リーダーが倒れると即敗北（9-1）。ルール上まっとうな負け筋なので、口を出すと邪魔かもしれない。',
    ['警告は要らない', '警告してほしい', '待機キャラ数の表示だけ']),
  D('C-1', 'バトル', 'バトルに複数のキャラが参加できる形にするか',
    '鬼ごっこ／かくれんぼ／缶けり／だるまさんが転んだ の4枚が「待機状態の味方キャラ全員で受けなければならない」。効果の判定はしないが、盤面が複数参加を表現できないとあなたが正しい状態を作れない。',
    ['複数持てる形にする' + R, '1体だけの形にして、この4枚はフリーモードで遊ぶ']),
  D('C-2', 'バトル', 'バトルが2本同時に走る状況に対応するか',
    '相手のバトル宣言に《抜き打ち》で割り込むと、後から宣言したバトルが先に処理され、終わってから元のバトルが走る（FAQで公認）。',
    ['まず1本だけ作る。2本目はフリーモードで手動' + R, '最初から2本並べられるように作る']),
  D('C-3', 'バトル', '参加キャラの消耗を自動にするか',
    '原典は「指定したら消耗させる」だが、カード効果で先に参加が決まっていた場合は消耗させてはいけない（FAQ「決闘」）。',
    ['自動で消耗＋1タップで戻せる' + R, '毎回「消耗させますか？」と聞く', '全部手動（今まで通り）']),
  D('C-4', 'バトル', 'バトル中に何を宣言できるかを、ツールが制限するか',
    'FAQは「バトル中はその他アクションとアクションアイテムは使えない」と言うが、キャラ配置やアイテム装備が可能かは原典に書かれていない。',
    ['制限しない（合法性は人間が判断）' + R, '明記されている禁止だけ止める']),

  D('A-5', 'コスト', '「気力−2」などはコストではない、という用語の訂正でよいか',
    '原典8「使用代償＝コスト＋属性＋その他」で、気力−2は「その他」。設計書 §5.1 は「コストには気力−Nも含まれる」と書いていて用語が逆。実装の作りは正しいので書き方だけ直す。',
    ['それでよい', '違う']),
  D('A-6', 'コスト', '発生したコストは「種類」と「属性」で寿命が違う、を設計書に追記してよいか',
    '原典7-3は4文あるのに設計書は1文目しか書いていない。「種類は割り込み型アクション内に限り有効」「属性はそのコストが失われるまで有効」が落ちている。P3bの前提になる。',
    ['それでよい', '違う']),
  D('A-7', 'コスト', 'エントリーフェイズの「回復」は任意、に直してよいか',
    '原典10-4は[2]回復だけ「任意に」で、[3][4]（バトルカードの未使用化・ドロー）は「必ず」。設計書 §4.9 は必須に読める書き方になっている。',
    ['それでよい', '違う']),
  D('B-3', 'コスト', '消耗したリーダーから [L] コストは出せるか',
    '⚠️原典に記述なし。FAQにも該当なし。一般則(7-2)からは「出せない」がほぼ確実だが、明文が無いのであなたの判断が要る。',
    ['出せない', '出せる']),
  D('B-4', 'コスト', 'カードデータをエラッタ後の内容に直すか',
    'マルチ『受け渡し』は使用代償が「このキャラをゴミ箱送りにする」→「このキャラをダウンさせる」に変わっているのに、データは古いまま。ダウンなら相手にボーナスドロー1枚が走るので処理が別物になる。',
    ['エラッタ後に直す', '当面そのままでよい', 'まず影響するカードの一覧だけ見たい']),

  D('C-5', '取り消し', '「取り消し（手札に戻す）」ボタンをどうするか',
    'あのボタンは相手が「通す」と言った後にしか押せない。しかし原典13-1は「両者の合意が得られた時点で処理は行われ、処理を行う前に巻き戻すことはできません」。つまりルールが禁じている操作しかできない位置にある（私の設計ミス）。',
    ['ボタンを削除する。打ち消されたら人間がゴミ箱へドラッグ' + R, '「不発（ゴミ箱へ）」ボタンは残したい', '今のままでよい']),

  D('C-6', '対象指定', '対象指定のしくみを作るか',
    '原典は「構成要素＝カード＋対象＋使用代償」で、対象は宣言時に指定する（16-1[3]等）。対象をIDで持つだけで「対象が場から失われた＝中断」を機械が検出できる（効果の中身を知らないまま）。相手が何を対象にしたか見えるので打ち消しの判断にも要る。',
    ['作る' + R, '当面いらない（対象は口頭で伝える）']),
  D('C-7', '対象指定', '対象の注釈をどこまで細かくするか',
    'この下の○×37件がまさにその作業。粒度を上げるほどあなたの作業が増える。範囲（味方のみ/相手のみ）まで注釈するとルールエンジンになるので非推奨。',
    ['「対象が要るか」の1ビットだけ' + R, '個数（1体/2体/全員）まで', '範囲（味方のみ等）まで']),

  D('C-8', '未実装', '割り込みのカウントダウンを作るか',
    '設計書 §4.19 に「秒数は設定可・無限も選べる・既定＝無限。後付けが高くつくので器だけ今作る」とあなたの判断が書かれているが、実装されていない。ただし優先権エンジンが窓を持つ構造になった今は、窓に秒数を足すだけで済む形になっている。',
    ['P6（仕上げ）まで先送り' + R, '今すぐ器だけ作る', 'やめる（身内でしか遊ばないと決める）']),
]

// --- ○×もの（機械が判断できなかった分） -----------------------------------
const evRows = JSON.parse(fs.readFileSync(path.join(L, '対象注釈-作業中.json'), 'utf8'))
  .filter((r) => r.kind === 'e' && r.verdict === '？')
  .map((r) => ({ id: 'E-' + r.id, name: r.name, text: r.text, why: r.why }))
const abRows = JSON.parse(fs.readFileSync(path.join(L, '対象注釈-能力-作業中.json'), 'utf8'))
  .filter((r) => r.verdict === '？' && !r.why.startsWith('本文を特定できない'))
  .map((r) => ({ id: 'A-' + r.card + '-' + r.ab, name: r.card + '／' + r.ab, text: r.text, why: r.why }))

const data = { decisions, targets: [...evRows, ...abRows] }

const html = `<!DOCTYPE html>
<meta charset="utf-8">
<title>リーフファイト — 宿題</title>
<style>
:root{--bg:#0f172a;--card:#1e293b;--line:#334155;--fg:#e2e8f0;--dim:#94a3b8;--ok:#34d399;--warn:#fbbf24;--pick:#0ea5e9}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.7 system-ui,"Segoe UI",sans-serif}
header{position:sticky;top:0;background:#0f172ae6;backdrop-filter:blur(6px);border-bottom:1px solid var(--line);padding:12px 16px;z-index:10}
h1{margin:0 0 6px;font-size:17px}
.bar{height:6px;background:var(--line);border-radius:3px;overflow:hidden}
.bar>div{height:100%;background:var(--ok);width:0;transition:width .2s}
.meta{color:var(--dim);font-size:13px;margin-top:6px;display:flex;gap:14px;flex-wrap:wrap;align-items:center}
main{max-width:860px;margin:0 auto;padding:18px 16px 120px}
h2{font-size:15px;color:var(--warn);border-bottom:1px solid var(--line);padding-bottom:6px;margin:30px 0 14px}
.q{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:0 0 12px}
.q.done{border-color:var(--ok);opacity:.55}
.tag{display:inline-block;font-size:11px;color:var(--dim);border:1px solid var(--line);border-radius:4px;padding:1px 7px;margin-right:8px}
.qt{font-weight:600;margin:8px 0}
.why{color:var(--dim);font-size:13px;background:#0f172a;border-left:3px solid var(--line);padding:8px 11px;border-radius:0 6px 6px 0;margin:8px 0 12px;white-space:pre-wrap}
.card-text{color:var(--fg);font-size:13.5px;background:#0f172a;border-left:3px solid var(--pick);padding:9px 11px;border-radius:0 6px 6px 0;margin:8px 0 12px}
.opts{display:flex;gap:8px;flex-wrap:wrap}
button.opt{background:#0f172a;color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:9px 14px;font:inherit;font-size:13.5px;cursor:pointer;text-align:left}
button.opt:hover{border-color:var(--pick)}
button.opt.sel{background:var(--pick);border-color:var(--pick);color:#06283d;font-weight:600}
button.opt.skip{color:var(--dim)}
button.opt.skip.sel{background:var(--dim);border-color:var(--dim);color:#0f172a}
footer{position:fixed;bottom:0;left:0;right:0;background:#0f172af2;border-top:1px solid var(--line);padding:11px 16px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
footer button{background:var(--ok);color:#06281d;border:0;border-radius:8px;padding:11px 20px;font:inherit;font-weight:700;cursor:pointer}
footer button.ghost{background:transparent;color:var(--dim);border:1px solid var(--line);font-weight:400}
#toast{position:fixed;left:50%;bottom:74px;transform:translateX(-50%);background:var(--ok);color:#06281d;padding:9px 18px;border-radius:8px;font-weight:600;opacity:0;transition:opacity .25s;pointer-events:none}
#toast.on{opacity:1}
.note{color:var(--dim);font-size:13px;margin:6px 0 20px}
</style>
<header>
  <h1>リーフファイト — あなたにしか決められないこと</h1>
  <div class="bar"><div id="prog"></div></div>
  <div class="meta"><span id="cnt"></span><span>答えは自動保存されます。途中でページを閉じても大丈夫です。</span></div>
</header>
<main>
  <p class="note">全部埋めなくて構いません。答えたものから作業を進めます。迷ったら「わからない」を押してください（そこは私が調べ直すか、保留にします）。</p>
  <h2>1. 判断（19件）— 設計をどうするか</h2>
  <div id="d"></div>
  <h2>2. ○ × で答えるだけ（37件）— このカードは「対象」を選ぶか</h2>
  <p class="note">カードを使うとき、<b>「相手のキャラ1体を選ぶ」のように誰か／何かを指定する必要があるか</b>を見てください。<br>
  例：《破壊電波》「リーダー以外の1キャラを消耗させる」→ <b>どのキャラか選ぶので ○</b>。<br>
  例：《臨時収入》「コスト3点を払ったことになる」→ <b>選ぶものが無いので ×</b>。<br>
  <b>迷ったら × で構いません。</b>×でも人間が手で選べるだけで、機能は失われません。</p>
  <div id="t"></div>
</main>
<footer>
  <button id="btn-copy">結果をコピー</button>
  <button class="ghost" id="btn-save">ファイルに保存</button>
  <button class="ghost" id="btn-reset">最初からやり直す</button>
</footer>
<div id="toast"></div>
<script>
const DATA = ${JSON.stringify(data)};
const KEY = 'lf-homework-v1';
let ans = {};
let canSave = true;
try { localStorage.setItem(KEY + '-probe', '1'); localStorage.removeItem(KEY + '-probe') } catch (e) { canSave = false }
try { ans = JSON.parse(localStorage.getItem(KEY) || '{}') } catch (e) { ans = {} }

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const total = () => DATA.decisions.length + DATA.targets.length;

function pick(id, v) {
  ans[id] = v;
  try { localStorage.setItem(KEY, JSON.stringify(ans)) } catch (e) {}
  render();
}
function optBtn(id, label, cls) {
  const sel = ans[id] === label ? ' sel' : '';
  // 🚨 インラインonclickにJSON文字列を埋めると属性のダブルクォートで壊れる（2026-09-16に実機で検出）。
  //    data属性＋イベント委譲にして、値はesc()でエスケープする。
  return '<button class="opt' + (cls||'') + sel + '" data-id="' + esc(id) + '" data-v="' + esc(label) + '">' + esc(label) + '</button>';
}
document.addEventListener('click', e => {
  const b = e.target.closest('button.opt');
  if (b) pick(b.dataset.id, b.dataset.v);
});
function render() {
  document.getElementById('d').innerHTML = DATA.decisions.map(x =>
    '<div class="q' + (ans[x.id] ? ' done' : '') + '">' +
      '<span class="tag">' + esc(x.group) + ' ' + esc(x.id) + '</span>' +
      '<div class="qt">' + esc(x.q) + '</div>' +
      '<div class="why">' + esc(x.why) + '</div>' +
      '<div class="opts">' + x.opts.map(o => optBtn(x.id, o)).join('') +
        optBtn(x.id, 'わからない / 保留', ' skip') + '</div>' +
    '</div>').join('');

  document.getElementById('t').innerHTML = DATA.targets.map((x, i) =>
    '<div class="q' + (ans[x.id] ? ' done' : '') + '">' +
      '<span class="tag">' + (i + 1) + ' / ' + DATA.targets.length + '</span><b>' + esc(x.name) + '</b>' +
      '<div class="card-text">' + esc(x.text || '（効果テキストなし）') + '</div>' +
      '<div class="opts">' +
        optBtn(x.id, '○ 対象を選ぶ') + optBtn(x.id, '× 選ばない') +
        optBtn(x.id, 'わからない / 保留', ' skip') + '</div>' +
    '</div>').join('');

  const n = Object.keys(ans).length;
  document.getElementById('prog').style.width = (n / total() * 100) + '%';
  document.getElementById('cnt').textContent = n + ' / ' + total() + ' 件';
}
function buildText() {
  let s = '# リーフファイト 宿題の回答（' + new Date().toLocaleString('ja-JP') + '）\\n\\n## 判断\\n';
  for (const x of DATA.decisions) s += '- ' + x.id + ' ' + x.q + '\\n  → ' + (ans[x.id] || '（未回答）') + '\\n';
  s += '\\n## 対象を選ぶか\\n';
  for (const x of DATA.targets) s += '- ' + x.name + ' → ' + (ans[x.id] || '（未回答）') + '\\n';
  return s;
}
function toast(m) { const t = document.getElementById('toast'); t.textContent = m; t.classList.add('on'); setTimeout(() => t.classList.remove('on'), 1600) }
function copyOut() { navigator.clipboard.writeText(buildText()).then(() => toast('コピーしました。Claudeに貼ってください')).catch(() => toast('コピーできませんでした。保存を使ってください')) }
function download() {
  const b = new Blob([buildText()], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(b); a.download = 'リーフファイト宿題の回答.txt'; a.click();
  toast('保存しました');
}
document.getElementById('btn-copy').onclick = copyOut;
document.getElementById('btn-save').onclick = download;
document.getElementById('btn-reset').onclick = () => { if (confirm('全部消します。よろしいですか？')) { try { localStorage.removeItem(KEY) } catch (e) {} ; ans = {}; render() } };
render();
if (!canSave) {
  const w = document.createElement('div');
  w.style.cssText = 'background:#7f1d1d;color:#fecaca;padding:10px 14px;border-radius:8px;margin:0 0 16px;font-size:13.5px';
  w.textContent = '⚠️ このブラウザでは自動保存が使えません。閉じる前に必ず下の「ファイルに保存」を押してください。';
  document.querySelector('main').prepend(w);
}
</script>
`

fs.writeFileSync(path.join(L, '宿題.html'), html)
console.log('✅ _local/宿題.html を生成')
console.log(`   判断 ${decisions.length} 件 / ○× ${data.targets.length} 件 = 合計 ${decisions.length + data.targets.length} 件`)
