// 対象指定の注釈を確定データに落とす（2026-09-23 ユーザー回答を取り込み）。
// 出力: _local/target-annotations.json
//   { events: {cardId: {target, source}}, abilities: {"カード／能力": {target, source}} }
//   target: true=対象を指定する / false=しない / null=保留
//   source: 'user'=ユーザーが判断 / 'machine'=機械の判定のまま（未校正）
// 🚨 machine の分はユーザーが1件ずつ見たわけではない。実装で疑わしい挙動が出たらここを疑うこと。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const L = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), '_local')

// --- ユーザーが判断した37件（2026-09-23 宿題ページの回答） ---------------
const NO = `人数調整 アクシデント おみくじ クリティカル 先手必勝 バトルチェンジ おあずけ 緊急入荷
クレーンゲーム 再企画 バーゲン・セール フリーマーケット 両成敗 輪廻 和平交渉`.split(/\s+/).filter(Boolean)
const ABILITY_NO = `コリン／いきあたりばったり セバスチャン／肉のカーテン たま／逃げる ルミラ／吸血
因幡ましろ／探し物 岡田・松本・吉井／クレーム 坂神蝉丸・覆製身／警告 千堂和樹／熱血
長岡志保／志保ちゃん情報 藤田浩之／潜在能力 柏木梓／鬼の力 柏木耕一／獣のちから 柏木楓／鬼化
柳川祐也／狩猟者 藍原瑞穂／調べる たま＆アレイ／遅刻 マルチ＆セリオ／応援 楓＆初音／ダブル鬼化`
  .split(/\s+/).filter(Boolean)
const ABILITY_YES = ['メイフィア／模写', '宮内レミィ／タックル']
const PENDING_EVENT = ['ダウジング']
const PENDING_ABILITY = ['ティリア／勇者の魂']

const evRows = JSON.parse(fs.readFileSync(path.join(L, '対象注釈-作業中.json'), 'utf8')).filter((r) => r.kind === 'e')
const abRows = JSON.parse(fs.readFileSync(path.join(L, '対象注釈-能力-作業中.json'), 'utf8'))

const events = {}
for (const r of evRows) {
  let target, source
  if (r.verdict === '？') {
    source = 'user'
    if (PENDING_EVENT.includes(r.name)) target = null
    else if (NO.includes(r.name)) target = false
    else { console.error(`  ⚠️ 回答に無い保留イベント: ${r.name}`); target = null; source = 'unanswered' }
  } else { target = r.verdict === '○'; source = 'machine' }
  events[r.id] = { name: r.name, target, source }
}

const abilities = {}
for (const r of abRows) {
  const key = r.card + '／' + r.ab
  let target, source
  if (r.why.startsWith('本文を特定できない')) { target = null; source = 'no-text' }
  else if (r.verdict === '？') {
    source = 'user'
    if (PENDING_ABILITY.includes(key)) target = null
    else if (ABILITY_YES.includes(key)) target = true
    else if (ABILITY_NO.includes(key)) target = false
    else { console.error(`  ⚠️ 回答に無い保留能力: ${key}`); target = null; source = 'unanswered' }
  } else { target = r.verdict === '○'; source = 'machine' }
  abilities[key] = { card: r.card, ability: r.ab, type: r.type, target, source }
}

const count = (o, f) => Object.values(o).filter(f).length
const stat = (o, label) => {
  console.log(`  ${label}: 対象あり ${count(o, (x) => x.target === true)} / なし ${count(o, (x) => x.target === false)} / 保留 ${count(o, (x) => x.target === null)}`)
  console.log(`    内訳: ユーザー判断 ${count(o, (x) => x.source === 'user')} / 機械のまま ${count(o, (x) => x.source === 'machine')}` +
    (count(o, (x) => x.source === 'no-text') ? ` / 本文なし ${count(o, (x) => x.source === 'no-text')}` : '') +
    (count(o, (x) => x.source === 'unanswered') ? ` / 🚨未回答 ${count(o, (x) => x.source === 'unanswered')}` : ''))
}

fs.writeFileSync(path.join(L, 'target-annotations.json'), JSON.stringify({
  generated: '2026-09-23',
  note: 'C-7の決定により「対象が要るか」の1ビットのみ。個数も範囲も持たない（範囲まで注釈するとルールエンジンになる）。source=machine はユーザー未校正。',
  events, abilities,
}, null, 1))

stat(events, 'イベント')
stat(abilities, '起動型能力')
console.log(`\n✅ _local/target-annotations.json`)
