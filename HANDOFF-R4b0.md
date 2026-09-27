# HANDOFF-R4b0

PHASE-R4b0（魔法のサークレットの穴を engine で直す）の報告。**完了**。

- tested の数: 45 → 55（`node --import ./scripts/register-ts-loader.mjs _local/rules/tools/tested.ts`）
- `npm run verify`: 緑（engine-host: すべて成功）。`npm run test:faq`: R2a ✅57・保留1／R2b ✅37／R3 ✅18／R4a ✅30（下がっていない）
- コミット
  - 親リポジトリ（`C:\Claudecode作業スペース\leaffight`）: `35d3cb8` fix(engine): 魔法のサークレットの暗黙の対象を violations()・forEach で見る
  - `_local/rules/`: `3c29826` test: T ケース（faq-694・faq-709・faq-700）／`bc29ef4` docs: 10件の faqReview 見直し

## §6 報告前の自己点検

### 1. 足した T ケース（`_local/rules/tools/authored/サークレットの暗黙の対象.mjs`）

| id | FAQ の答え | 期待 | 直す前 | 直した後 |
|---|---|---|---|---|
| faq-694 | 自分自身を対象とする特殊能力（鬼化）も使用できない | `ILL(0, '空打ち')`（choices:[] の自己 statMod での宣言が空打ち） | ❌（`いいえ（通った）`） | ✅ |
| faq-709 | 全体に効果を及ぼす特殊能力（聖なる光）の対象にもならない | 装備キャラ b は気力据え置き・非装備 cc は+1回復 | ❌（`気力 b = 4（期待 3）`） | ✅ |
| faq-700 | 対象をとらない特殊能力（放棄）は使える | `LEG(0)`（違反にならない） | ✅（対照・回帰確認） | ✅ |

柏木楓（faq-694 の原FAQの主役）は記述が無いため、同名・同文・同効果の「鬼化」を持つ柏木千鶴で検証した（c_柏木千鶴.ts の読み合わせで既に同一と確認済み）。faq-709 は原FAQの主役どおり c_ティリア「聖なる光」で検証した。直す前に3件とも実行し、694・709が❌（保科智子は対照でもとから✅）であることを確認してから実装した。

### 2. §2(A) の op の分類表（`effectRefsOf`・layers.ts）

**効果を及ぼす（暗黙の対象になり得る）:**

| op | 対象フィールド |
|---|---|
| statMod | who |
| kiryoku | who |
| setKiryoku | who |
| orient | who |
| clearMods | who |
| damage | to |
| redirectDamage | to（代わりに受ける） |
| trash | what（使用代償の trash は cost であって effect ではないため対象外・牧部なつみ「心の世界」と同じ線） |
| moveTo | what |
| callByEffect | what |
| putOntoField | what |
| grantAbility | to |
| battleDamage | to（'all' は除く） |
| addContinuous | effect.who が CardRef のとき（Selector なら forEach と同じく (B) の対象） |

**及ぼさない（対象にならない）:**

draw（プレイヤー）・adjustDamage（進行中のダメージへの操作でCardRef無し）・counter／hijack（宣言・効果自体を指す。キャラへの効果ではない）・generateCost（プレイヤーのコスト）・remember（内部の控え）・choose／if／simul／forEach（制御。if は宣言時の状態で分岐を評価して中を再帰、simul は中を再帰、forEach は (B) が別に処理）・manual／trace／hole（分岐・記録）・setParticipants／setBattleChoice／firstStrike／skipBattleActions／abortBattle／startBattle／setBattleCard／putBattleCard／atBattleEnd／addDowns（バトルの進行・player対象。キャラの状態を直接書き換える対象フィールドが無い）・swapItems（アイテムの装備先の交換。装備先キャラの状態そのものは変えない）・swapZones／shuffle／offer（プレイヤー）・createToken（既存キャラでない）。

保科智子「放棄」（abortBattle）は分類表の「及ぼさない」に入るため暗黙の対象なし＝FAQ:700どおり違反にならない。

### 3. (B) forEach・selector の除外（`drive.ts` `targetableSelect`）

- 変えた箇所: `execOp` の `case 'forEach'`（`select` → `targetableSelect`）と `case 'simul'` 内の forEach 展開（同じく `targetableSelect`）の2箇所。処理する瞬間（select する今）の盤面で `untargetableBy(ctx, state, iid, '特殊能力')` を確かめて外す。
- 外す条件: 発生源（`env.self`＝暗黙の対象と同じ判定源）が `isCharSource`（kind が c か t）のときだけ。イベント・フィールド・アイテムの効果（`env.self` が e/f/i）は外さない（FAQ:1264 の幸せ泥棒の乗っ取り・choose(mode:target) 経由も対象外のまま）。
- 数える・条件（`{count: Selector}`・`exists`・`sameName` 等）は `eval.ts` の `select()`／`evalCond()` を直接使っており、`drive.ts` の `targetableSelect` を経由しない＝今までどおり外さない（FAQ:3642 と同じ線）。

### 4. faqReview の見直し（前 → 後）

| カード | id | 前 | 後 |
|---|---|---|---|
| c_柏木耕一 | faq-694 | manual | ok |
| c_柳川祐也 | faq-694 | manual | ok |
| c_光岡悟 | faq-694 | manual | ok |
| c_佐藤雅史 | faq-694 | manual | ok |
| c_牧部なつみ | faq-694 | manual | ok |
| c_セバスチャン | faq-694 | manual | ok |
| c_因幡ましろ | faq-694 | manual | ok |
| c_柏木千鶴 | faq-694 | manual | case |
| t_詠美&由宇 | faq-709 | manual | ok |
| i_魔法のサ-クレット | faq-709 | manual | case |

指定の10件に加え、同じ実装で直る c_ティリア の faq-709（聖なる光・実際に T ケースの盤面に使ったカード）も manual → case に変えた（§6-6 参照）。

### 5. tested・test:faq・verify

- tested の数: 45 → 55（draft 4→5・manual 52→41。合計101で変わらず）
- `npm run test:faq`: R2a ✅57・保留1／R2b ✅37／R3 ✅18／R4a ✅30（全て変化なし・下がっていない）。新しい3件は対象外（scope 外）の参考実行枠で ✅3→✅5 に増加
- `npm run verify`: 緑（exit 0。engine-host も全項目 ✅）

### 6. 決めたこと・迷ったこと・新しい穴の候補

- **decl.targets を書き換えず、violations() の中だけで implicit targets を合成した**（`ProcDecl` に新フィールドを足さない）。cost 計算（`effectiveCost`）や `patternHits.targetWhere` は宣言時の `decl.targets`（choices 由来）のまま変えていない。暗黙の対象を `decl.targets` 自体に混ぜると、costMod・targetWhere（例: 「参加キャラを対象にとる特殊能力」FAQ:600・603）の判定条件まで暗黙の対象で広がってしまうリスクがあり、今回の仕様（§2(A) は untargetable の判定だけ）を超える変更になるため避けた。
- **`if` は宣言時点の状態で `evalCond` して実際に通る枝だけを再帰した**（then/else 両方を見て過大に対象を広げない）。今のプールに `if` を使う該当カードは無く、実地の T ケースは書けていない（穴の候補ではなく、単に検証カードが無い）。
- **`putOntoField`／`callByEffect` を「及ぼす」に分類した**副作用として、因幡ましろ「探し物」の `putOntoField(what:slot('u'))`（姉妹うさぎを出す）も暗黙の対象になるが、処理前は手札にいてサークレットの対象になり得ないため実害は無い（c_因幡ましろ.ts に注記）。同様の分類で他のカードに実害が出る組み合わせが無いか、プール全体の再監査はしていない（既存 tested 30件・draft 5件の再実行で退行が無いことは確認済み）。
- **`grantAbility`・`battleDamage` は「及ぼす」に分類したが、今のプールに who/to が self 等の直接 CardRef で書かれた該当カードが無く、実地の T ケースでは検証していない**（分類の根拠は §2(A) の一般原則のみ）。
- **`addContinuous` は `effect.who` が CardRef のときだけ暗黙の対象にした**（Selector なら (B) の forEach 相当として次に層を導出する時点で `effectOn` が既に見ている＝FAQ:697 の既存実装のまま。二重に塞ぐ必要はない）。
- **新しい穴の候補**: `choose(mode:'target', when:'resolve')` で処理時に選ぶ対象（例えば模写の宣言のような「処理のときに選ぶ」タイプ）はサークレットの untargetable を経由しない設計のまま（i_魔法のサ-クレット.ts の「未対応（R4）」注記どおり・FAQ:1264 で「使える」ことが答えなので今回はこれ以上塞がない）。一般規則で答えが出るため、新規の穴としては報告しない。
