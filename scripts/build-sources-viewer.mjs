// 一次資料ビューアの生成。ルール・FAQ・エラッタを引きながら作業するための静的HTML。
// 🚨 中身は一切改変しない。行の文字列はそのまま。付けるのは「行番号・見出しの索引・検索」だけ。
//    統括が oldrule.txt:1075 のように行番号で引用するので、行番号での移動を必ず用意する。
// 出力: _local/資料ビューア.html（gitignore対象。ローカルで開くだけ）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const L = path.join(ROOT, '_local')
const read = (f) => fs.readFileSync(path.join(L, f), 'utf8').replace(/^﻿/, '').split(/\r?\n/)

// --- 詳細ルール: 「7-3 発生したコストの扱い」のような節番号で切る ----------
function parseRule(lines) {
  const isHead = (s) => /^\d+(-\d+)*\s+\S/.test(s)
  const blocks = []
  let cur = { head: '（前書き）', line: 1, body: [] }
  lines.forEach((t, i) => {
    if (isHead(t)) {
      if (cur.body.length || blocks.length || cur.head) blocks.push(cur)
      cur = { head: t, line: i + 1, body: [] }
    } else cur.body.push({ line: i + 1, t })
  })
  if (cur.body.length || blocks.length || cur.head) blocks.push(cur)
  return blocks
}

// --- 簡易ルール: 構造が緩いので ● を見出しにするだけ（16KBなので素で読める）---
function parseKanni(lines) {
  const blocks = []
  let cur = { head: '（冒頭）', line: 1, body: [] }
  lines.forEach((t, i) => {
    if (/^●/.test(t)) {
      if (cur.body.length || blocks.length || cur.head) blocks.push(cur)
      cur = { head: t, line: i + 1, body: [] }
    } else cur.body.push({ line: i + 1, t })
  })
  if (cur.body.length || blocks.length || cur.head) blocks.push(cur)
  return blocks
}

// --- エラッタ: ●カード名（種別 Ver.x）ごと。Version 見出しは区切りとして拾う ---
function parseErrata(lines) {
  const blocks = []
  let cur = { head: '（冒頭・目次）', line: 1, body: [] }
  lines.forEach((t, i) => {
    if (/^●/.test(t) || /^(Version|バージョン)/.test(t)) {
      if (cur.body.length || blocks.length || cur.head) blocks.push(cur)
      cur = { head: t, line: i + 1, body: [] }
    } else cur.body.push({ line: i + 1, t })
  })
  if (cur.body.length || blocks.length || cur.head) blocks.push(cur)
  return blocks
}

// --- FAQ: 見出し（カード名/分類）→ Ｑ．→ Ａ．→（日付） の繰り返し -----------
// 折り返しで Ｑ/Ａ の続きが次行に来るので、状態機械で追う。
function parseFaq(lines) {
  const blocks = []
  let cur = null
  let mode = null // 'q' | 'a' | null
  const push = () => { if (cur) blocks.push(cur) }
  const newHead = (t, i) => { push(); cur = { head: t, line: i + 1, entries: [] } }

  lines.forEach((t, i) => {
    const n = i + 1
    if (!t.trim()) return
    if (/^Ｑ．/.test(t)) {
      if (!cur) newHead('（見出しなし）', i)
      cur.entries.push({ line: n, q: [{ line: n, t }], a: [], date: null })
      mode = 'q'
      return
    }
    if (/^Ａ．/.test(t)) {
      if (cur && cur.entries.length) { cur.entries[cur.entries.length - 1].a.push({ line: n, t }); mode = 'a' }
      return
    }
    if (/^（\d{4}\//.test(t)) {
      if (cur && cur.entries.length) cur.entries[cur.entries.length - 1].date = { line: n, t }
      mode = null
      return
    }
    // マーカーの無い行: Ｑ/Ａ の続きか、新しい見出しか
    if (mode === 'q' && cur?.entries.length) cur.entries[cur.entries.length - 1].q.push({ line: n, t })
    else if (mode === 'a' && cur?.entries.length) cur.entries[cur.entries.length - 1].a.push({ line: n, t })
    else newHead(t, i)
  })
  push()
  return blocks
}

const docs = [
  { id: 'rule', name: '詳細ルール', file: 'oldrule.txt', kind: 'sec', note: '最も権威が高い。章節番号で引用される', blocks: parseRule(read('oldrule.txt')) },
  { id: 'faq', name: '公式FAQ', file: 'oldfaq.txt', kind: 'faq', note: '個別裁定。詳細ルールを補う', blocks: parseFaq(read('oldfaq.txt')) },
  { id: 'errata', name: 'エラッタ', file: 'olderatta.txt', kind: 'sec', note: 'カードのテキスト訂正。カードデータより優先される', blocks: parseErrata(read('olderatta.txt')) },
  { id: 'kanni', name: '簡易ルール', file: 'kanni_rule.txt', kind: 'sec', note: '要約版。詳細ルールと食い違うことがある（実例あり）', blocks: parseKanni(read('kanni_rule.txt')) },
]

for (const d of docs) {
  const n = d.kind === 'faq' ? d.blocks.reduce((s, b) => s + b.entries.length, 0) : d.blocks.length
  console.log(`  ${d.name.padEnd(8)} ${String(d.blocks.length).padStart(4)} 見出し / ${n} 件`)
}

const html = `<!DOCTYPE html>
<meta charset="utf-8">
<title>リーフファイト — 一次資料ビューア</title>
<style>
:root{--bg:#0f172a;--pane:#111c31;--card:#1a2740;--line:#2f3f5c;--fg:#e6edf7;--dim:#8fa3c0;--hi:#38bdf8;--mark:#fde047}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:14.5px/1.85 system-ui,"Segoe UI","Yu Gothic UI",sans-serif;display:flex;flex-direction:column}
header{background:#0d1728;border-bottom:1px solid var(--line);padding:9px 14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
h1{margin:0;font-size:15px;white-space:nowrap}
.tabs{display:flex;gap:5px}
.tab{background:transparent;color:var(--dim);border:1px solid var(--line);border-radius:7px;padding:6px 13px;font:inherit;font-size:13px;cursor:pointer}
.tab.on{background:var(--hi);border-color:var(--hi);color:#05283b;font-weight:700}
input{background:#0b1425;color:var(--fg);border:1px solid var(--line);border-radius:7px;padding:7px 11px;font:inherit;font-size:13.5px}
#q{flex:1;min-width:180px}
#jump{width:112px}
.hint{color:var(--dim);font-size:12px}
.wrap{flex:1;display:flex;min-height:0}
nav{width:270px;flex:0 0 270px;background:var(--pane);border-right:1px solid var(--line);overflow-y:auto;padding:8px 0}
nav a{display:block;padding:5px 12px;color:var(--dim);text-decoration:none;font-size:12.5px;border-left:3px solid transparent;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
nav a:hover{background:#16233b;color:var(--fg)}
nav a.on{border-left-color:var(--hi);color:var(--fg);background:#16233b}
main{flex:1;overflow-y:auto;padding:14px 18px 60vh}
.blk{background:var(--card);border:1px solid var(--line);border-radius:9px;margin:0 0 12px;overflow:hidden}
.blk>h3{margin:0;padding:9px 13px;background:#16233b;font-size:14px;border-bottom:1px solid var(--line);display:flex;gap:10px;align-items:baseline}
.ln{color:var(--dim);font:12px ui-monospace,monospace;flex:0 0 auto}
.body{padding:6px 0}
.row{display:flex;gap:11px;padding:1px 13px}
.row:hover{background:#16233b}
.row .ln{flex:0 0 46px;text-align:right;user-select:none;opacity:.55}
.row .t{white-space:pre-wrap;word-break:break-word;flex:1}
.row.target{background:#1e3a5f;outline:1px solid var(--hi)}
.qa{border-top:1px solid var(--line);padding:8px 13px}
.qa:first-child{border-top:0}
.qa .q{color:#fbbf24}
.qa .a{color:#86efac}
.qa .d{color:var(--dim);font-size:12px}
.qa p{margin:2px 0;display:flex;gap:11px}
.qa .t{white-space:pre-wrap;word-break:break-word;flex:1}
mark{background:var(--mark);color:#111;border-radius:2px}
.empty{color:var(--dim);padding:24px 6px}
.src{color:var(--dim);font-size:12px;margin:0 0 12px}
</style>
<header>
  <h1>リーフファイト 一次資料</h1>
  <div class="tabs" id="tabs"></div>
  <input id="q" placeholder="全文検索（例: バトル参加キャラ／使用代償／消耗）">
  <input id="jump" placeholder="行番号へ" inputmode="numeric">
  <span class="hint" id="stat"></span>
</header>
<div class="wrap">
  <nav id="nav"></nav>
  <main id="main"></main>
</div>
<script>
const DOCS = ${JSON.stringify(docs)};
let cur = 'rule', query = '';

const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const hl = s => {
  const e = esc(s);
  if (!query) return e;
  try { return e.replace(new RegExp(query.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&'), 'gi'), m => '<mark>' + m + '</mark>') }
  catch (err) { return e }
};
const doc = () => DOCS.find(d => d.id === cur);
const hit = s => !query || String(s).toLowerCase().includes(query.toLowerCase());

function blockText(b) {
  return b.head + ' ' + (b.entries
    ? b.entries.map(e => e.q.map(x => x.t).join('') + e.a.map(x => x.t).join('') + (e.date ? e.date.t : '')).join(' ')
    : b.body.map(x => x.t).join(''));
}
function visible() { return doc().blocks.filter(b => hit(blockText(b))) }

function render() {
  const d = doc(), vis = visible();
  document.getElementById('tabs').innerHTML = DOCS.map(x =>
    '<button class="tab' + (x.id === cur ? ' on' : '') + '" data-tab="' + x.id + '">' + esc(x.name) + '</button>').join('');
  document.getElementById('nav').innerHTML = vis.map(b =>
    '<a href="#b' + b.line + '" data-line="' + b.line + '">' + esc(b.head.slice(0, 40)) + '</a>').join('')
    || '<div class="empty" style="padding:14px">該当なし</div>';

  const body = vis.map(b => {
    const inner = b.entries
      ? b.entries.map(e =>
          '<div class="qa">' +
            e.q.map(x => '<p class="q"><span class="ln">' + x.line + '</span><span class="t">' + hl(x.t) + '</span></p>').join('') +
            e.a.map(x => '<p class="a"><span class="ln">' + x.line + '</span><span class="t">' + hl(x.t) + '</span></p>').join('') +
            (e.date ? '<p class="d"><span class="ln">' + e.date.line + '</span><span class="t">' + esc(e.date.t) + '</span></p>' : '') +
          '</div>').join('')
      : '<div class="body">' + b.body.map(x =>
          '<div class="row" id="L' + x.line + '"><span class="ln">' + x.line + '</span><span class="t">' + hl(x.t) + '</span></div>').join('') + '</div>';
    return '<section class="blk" id="b' + b.line + '"><h3><span class="ln">' + b.line + '</span><span>' + hl(b.head) + '</span></h3>' + inner + '</section>';
  }).join('');

  document.getElementById('main').innerHTML =
    '<p class="src">' + esc(d.file) + '　' + esc(d.note) + '　（本文は一切改変していません。行番号は元ファイルの行です）</p>' +
    (body || '<div class="empty">該当なし</div>');

  const n = d.blocks.reduce((s, b) => s + (b.entries ? b.entries.length : b.body.length), 0);
  document.getElementById('stat').textContent = vis.length + ' / ' + d.blocks.length + ' 見出し（全 ' + n + ' 行）';
}

document.getElementById('tabs').addEventListener('click', e => {
  const b = e.target.closest('[data-tab]'); if (!b) return;
  cur = b.dataset.tab; render(); document.getElementById('main').scrollTop = 0;
});
document.getElementById('nav').addEventListener('click', e => {
  const a = e.target.closest('a'); if (!a) return;
  e.preventDefault();
  document.querySelectorAll('nav a').forEach(x => x.classList.remove('on'));
  a.classList.add('on');
  document.getElementById('b' + a.dataset.line)?.scrollIntoView({ block: 'start' });
});
let t;
document.getElementById('q').addEventListener('input', e => {
  clearTimeout(t); t = setTimeout(() => { query = e.target.value.trim(); render() }, 180);
});
// 行番号での移動（統括の引用 oldrule.txt:1075 を照合するため）
document.getElementById('jump').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  const n = parseInt(e.target.value, 10); if (!n) return;
  query = ''; document.getElementById('q').value = ''; render();
  const el = document.getElementById('L' + n) || [...document.querySelectorAll('.ln')].find(x => x.textContent == n)?.parentElement;
  if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('target'); setTimeout(() => el.classList.remove('target'), 2500) }
  else alert('この資料に ' + n + ' 行目は見つかりませんでした（タブを確認してください）');
});
render();
</script>
`

fs.writeFileSync(path.join(L, '資料ビューア.html'), html)
console.log(`✅ _local/資料ビューア.html （${(html.length / 1024 / 1024).toFixed(2)} MB）`)
