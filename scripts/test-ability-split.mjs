// PHASE-E0.md §4 検証スクリプト。scripts/lib/ability-split.mjs の
// 1(使用代償/Auto/キャラタイプの分け方)と2(取り出し方)を、手で書いた入力文字列で直接assertする。
// ビルドの出力（dist-data/leaffight-data.zip）は読まない。入力は _local/sources/cards_v2.json の
// 実データ形式（{header, text}）を真似た、手書きの最小例。

import { splitAbilities, splitOneEntry } from './lib/ability-split.mjs'

let failures = 0

function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    failures++
    console.error(`❌ ${msg}\n   expected: ${e}\n   actual:   ${a}`)
  } else {
    console.log(`✅ ${msg}`)
  }
}

function ability(entry) {
  // splitOneEntry は1エントリを複数の能力に分割する（1エントリ=1能力の場合は要素数1）
  return splitOneEntry(entry)
}

// =============================================================================
// 1. 使用代償の分け方: R\n\n本文 / Auto\n[タグ]\n\n本文 / 気力表記コスト\n本文 / コスト無し(-)\n本文
// =============================================================================
{
  // R\n\n本文 相当（entry.header="名前 R", entry.text="本文の段落"）
  const r = ability({ header: '気力回復 R', text: 'キャラ１体の気力を１点回復する' })
  assertEqual(r.length, 1, '1a: cost=R → 能力1つに分割')
  assertEqual(
    { header: r[0].header, cost: r[0].cost, auto: r[0].auto, tag: r[0].tag, text: r[0].text },
    { header: '気力回復', cost: 'R', auto: false, tag: null, text: 'キャラ１体の気力を１点回復する' },
    '1a: cost=Rはcostに入り、textは本文だけ',
  )

  // Auto\n[魔族]\n\n本文 相当
  const auto = ability({ header: '闇の力 Auto', text: '[魔族]\n\nこのキャラは能力値が高い' })
  assertEqual(auto.length, 1, '1b: Auto → 能力1つに分割')
  assertEqual(
    { header: auto[0].header, cost: auto[0].cost, auto: auto[0].auto, tag: auto[0].tag, text: auto[0].text },
    { header: '闇の力', cost: '', auto: true, tag: '魔族', text: 'このキャラは能力値が高い' },
    '1b: Autoはcostに入れずauto:trueに。[魔族]はtextから抜けてtagになる',
  )

  // 気力表記コスト（WG＋気力－１相当。COST_RE_SRCの「リーダーの気力－N」語彙で実データにある形）
  const kiryoku = ability({ header: '犠牲 リーダーの気力－１', text: '手札を１枚捨てる' })
  assertEqual(kiryoku.length, 1, '1c: 気力表記コスト → 能力1つに分割')
  assertEqual(
    { header: kiryoku[0].header, cost: kiryoku[0].cost, auto: kiryoku[0].auto, text: kiryoku[0].text },
    { header: '犠牲', cost: 'リーダーの気力－１', auto: false, text: '手札を１枚捨てる' },
    '1c: 気力を含むコスト表記もそのままcostへ',
  )

  // 使用代償なし（'-'）→ cost=''（無ければ''。PHASE-E0.md §1）
  const none = ability({ header: '見た目 -', text: '特に効果はない' })
  assertEqual(none.length, 1, '1d: コスト無し(-) → 能力1つに分割')
  assertEqual(
    { header: none[0].header, cost: none[0].cost, auto: none[0].auto, text: none[0].text },
    { header: '見た目', cost: '', auto: false, text: '特に効果はない' },
    "1d: '-'はコスト無し扱いでcost=''になる（畳み込まない）",
  )
}

// =============================================================================
// 2. キャラタイプの取り出し方: 使用代償/Autoの直後の[タグ]だけがtag。5種以外や本文中は拾わない
// =============================================================================
{
  // 5種以外の角括弧行（[水中バトルペナルティ]）はキャラタイプとみなさず、本文に残す
  const notCharType = ability({
    header: '特性 Auto',
    text: '[水中バトルペナルティ]\n\n水中戦でのペナルティを受けない',
  })
  assertEqual(
    { tag: notCharType[0].tag, text: notCharType[0].text },
    { tag: null, text: '[水中バトルペナルティ]\n\n水中戦でのペナルティを受けない' },
    '2a: キャラタイプ5種以外の角括弧行はtagにせず本文に残す',
  )

  // 本文中（先頭ではない位置）の[ロボ]はキャラタイプとして拾わない
  const midText = ability({
    header: '出荷 R',
    text: '自分の手札の[ロボ]のキャラクター１体を選んで場に出す',
  })
  assertEqual(
    { tag: midText[0].tag, text: midText[0].text },
    { tag: null, text: '自分の手札の[ロボ]のキャラクター１体を選んで場に出す' },
    '2b: 本文中に埋め込まれた[ロボ]はtagとして拾わない（先頭行だけを見る）',
  )

  // 5種すべてが同じ位置で拾えることの確認
  for (const t of ['魔族', 'ロボ', '鬼', '強化兵', '天使']) {
    const r = ability({ header: `技 Auto`, text: `[${t}]\n\n本文` })
    assertEqual(r[0].tag, t, `2c: キャラタイプ[${t}]をtagとして拾う`)
  }

  // 統括9: 括弧の無いキャラタイプ行（実データ: ＨＭ－１２Ｓ「ロボ」・イビル＆エビル「魔族」）
  const bare = ability({ header: '量産 Auto', text: 'ロボ\n\nこの『ＨＭ－１２Ｓ』は…' })
  assertEqual(
    { tag: bare[0].tag, text: bare[0].text },
    { tag: 'ロボ', text: 'この『ＨＭ－１２Ｓ』は…' },
    '2d: 括弧の無いキャラタイプ行も拾い、本文から外す',
  )
  // 2つ目の能力の本文の頭に改行を残さない（実データ: ＨＭ－１３「サテライトサービス」）
  const second = ability({ header: '量産 Auto', text: '本文1\n\nサテライトサービス Auto\nこのキャラがバトルを挑んだとき' })
  assertEqual(second[1]?.text, 'このキャラがバトルを挑んだとき', '2e: 2つ目以降の能力の本文の頭に改行を残さない')
}

// =============================================================================
// 3. splitAbilities: 文字消失が起きないこと（コスト/タグをtext外に出しても合計の文字は保たれる）
// =============================================================================
{
  const losses = []
  splitAbilities([{ header: '闇の力 Auto', text: '[魔族]\n\nこのキャラは能力値が高い' }], losses)
  assertEqual(losses.length, 0, '3a: cost/Auto/タグをtextから分離しても文字消失は検出されない')
}

console.log(failures === 0 ? `\n✅ 全て成功` : `\n❌ ${failures} 件失敗`)
process.exit(failures === 0 ? 0 : 1)
