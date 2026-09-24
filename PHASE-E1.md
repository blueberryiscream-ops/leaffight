# PHASE-E1: 効果レシピの型・実行器・部品6つ・提案ボタン

> ⏸ **保留（2026-09-25 統括9）**: 利用者の依頼は「ルールエンジンを作れるようになったか」の見直しだった。`PROPOSAL-ルールエンジン再検討.md` の結論が出るまで着手しない。E0 は有効。

統括9・2026-09-25。設計の正は `DESIGN.md` §5.3。**PHASE-E0 のコミット後に着手する**（`Ability.cost` が分かれ、本文が本文だけになっている前提）。
報告は `HANDOFF-E1.md` に書く。

## 0. 目的

解決の段で「提案: ○○［実行］」を押すと、効果の盤面操作がまとめて済み、Undo 1回で戻る。これを**手書きのレシピ12件**で通す。
全カード分のレシピの一括生成は E2（この段階ではやらない）。

### 守ること（🚨 は破ったら差し戻し）
- 🚨 **ルールエンジンにしない**（DESIGN §5.3「越えない線」）: 使えるかを判定しない／「〜したとき」を自動で起こさない／対象の範囲を検証しない（候補を光らせるのは手助けで、違うカードも選べる）
- 🚨 `core/` に ui/net/data/外部パッケージを import しない。**core にカードの知識を入れない**（レシピを読むのは core の外）
- 🚨 `localSeat` を `BoardState` に入れない。対象を選んでいる途中の状態はクライアントの手元（React の state）に持つ
- 🚨 盤面に `overflow-auto` を使わない
- 乱数・時刻を core に持ち込まない
- 色は `src/index.css` の `@theme` トークンだけ
- 旧バンドル（`recipes.json` が無い zip）でも落ちない＝提案が出ないだけ
- ブラウザでの確認は**煙試験だけ・ツール10回以内**（1タブで e_降霊術 を宣言→提案→実行→Undo が通る程度）。**2タブの確認は統括がやる**

## 1. まとめ操作 `applyEffect`（core）

- `BoardAction` に `{ type: 'applyEffect'; label: string; actions: BoardAction[] }` を足す（`src/core/actions.ts`）
- `applyAction` は `actions` を順に適用する。ログが空の子（対象が既に無い等）は飛ばす。**全部空なら全体のログも空**（＝何も起きない。`history.ts` の規則のまま）
- ログは1行: `効果「{label}」: {子のログを「／」でつないだもの}`
- `actions` の中に `applyEffect`・優先権の操作（`declareAction`／`passPriority`／`resolveStep`／`setMode`）・バトルの操作が入っていたら**その子は無視**（入れ子と、効果が進行を勝手に進めるのを防ぐ）
- これで Undo 1回・通信1通・ゲストにもログ1行、が今の仕組みのまま効く。**通信・履歴のコードは変えないはず**（変えたら理由を報告）

## 2. 札（行動制限）の修正の種類

- `ModifierKind` に `'札'` を足す（`src/core/board.ts:43`）。`note` に文言、`scope` に期間。`stat`・`delta` は使わない
- 表示は `modifierLabel.ts` に足す（能力値修正と見分けがつく形。例 `🚫 対象にならず…`）。[28] の攻防修正クリアで消えないこと（`kind` で分けているので消えないはず。テストで確かめる）

## 3. レシピの型と実行器（`src/effects/` を新設。core の外）

```ts
// src/effects/recipe.ts
type Side = 'mine' | 'theirs' | 'any'           // 実行する席から見た向き
type TargetRef =
  | { self: true }                               // 能力の元カード
  | { pick: string }                             // picks の id
  | { all: { side: Side; zones: ZoneId[] } }     // 「すべての相手キャラ」等
  | { leader: 'mine' | 'theirs' }
interface PickSpec { id: string; count: number; side: Side; zones: ZoneId[]; hint: string } // hint 例「リーダー以外の相手キャラ1体」
type Until = 'ターン終了時' | 'このバトル'
type Step =
  | { op: 'stat'; target: TargetRef; stat: Attr; n: number; until: Until }
  | { op: 'kiryoku'; target: TargetRef; n: number }          // ダメージは負の数
  | { op: 'trash'; target: TargetRef }
  | { op: 'orient'; target: TargetRef; to: 'ready' | 'rested' }
  | { op: 'flag'; target: TargetRef; text: string; until: Until }
  | { op: 'draw'; who: 'self' | 'opponent' | 'both'; n: number }
interface Recipe {
  cardId: string
  ability: string          // 能力名（Ability.header）。イベント等で能力名が空なら ''
  picks: PickSpec[]
  steps: Step[]
  confidence: 'high' | 'low'
  note?: string
}
```

- `planEffect(recipe, ctx) => BoardAction[]`（純関数）。`ctx = { state, by: Seat, sourceIid, picks: Record<string, string[]>, cardOf }`
  - `stat`→`addModifier`（kind 能力値修正・scope=until・sourceLabel=能力名かカード名）／`kiryoku`→`adjustKiryoku`（max はカードデータの気力。リーダーは §4.3 の扱いを既存の右クリック操作と同じ関数で）／`trash`→`toTrash`／`orient`→`setOrientation`／`flag`→`addModifier`（kind 札）／`draw`→ その席のデッキの上から `moveCard` で手札へ。デッキが足りなければ有る分だけ
  - **既存の右クリック操作と同じ BoardAction を作ること**（新しい盤面操作を core に足さない。同じ操作なら割り込みの通知 P3c も今のまま鳴る）
  - modifier の id など一意な値は `ctx` から受け取る（core に乱数を持ち込まない。今の右クリック側の作り方に合わせる）
- `describeRecipe(recipe) => string`: 日本語の要約（ボタンと⚠の記録に使う）。例 `自分が2枚ドロー`／`選んだキャラ1体: 気力+3・消耗`
- `validateRecipe(recipe, card)`: 形の検査だけ（`pick` の参照先がある・n が 0 でない・stat が5つのどれか）。**意味の正しさは見ない**

## 4. データの経路

- `_local/effect-recipes.json`（新設・`Recipe[]`）→ `build-data-bundle.mjs` で `validateRecipe` 相当の形の検査をして zip に `recipes.json` で同梱。**カードの id がプールに無ければビルドを失敗させる**
- `bundle.ts` で読む（`annotations.json` と同じ流儀・無ければ空）。IndexedDB への保存も annotations と同じ流儀で
- 引き方: 解決を待つ宣言の `sourceIid` → カード id。`kind==='能力'` なら `label` と一致する `ability`、`kind==='プレイ'` なら `ability===''`。**`label` に何が入るかは `DetailPanel` と手札プレイの宣言を現物で確かめてから書く**（違ったら報告）

## 5. 提案ボタン（`StackPanel.tsx`）

- 出す条件: アシストモード・今まさに解決される宣言（`resolvingSeat` と同じ判定）が**自分の席**のもの・レシピがあり `confidence==='high'`
- 表示: `提案: {describeRecipe}` ［実行］［⚠ 違う］。「提案」の文字を必ず出す。今の［解決］ボタンはそのまま残す
- ［実行］:
  - `picks` が空 → すぐ `applyEffect` を送る
  - `picks` がある → **対象選びの状態**に入る（Board の手元の state）。`hint` を「今やること」帯（`TodoBand`）に出し、候補（`side`・`zones` に合うカード）にリングを出す。**候補以外も選べる**（リングは手助け）。`count` 枚選んだら［決定］で `applyEffect`、［やめる］で抜ける。バトルの参加キャラ選び（`Board.tsx:37` `battleCandidateKind`・`:187` `handleCardClick`・`:203` `battleRingProps`）の仕組みを**同じ形で一般化**して使う（バトル中の選択と衝突しないこと＝対象選び中はそちらを優先）
  - 実行しても**自動で解決しない**。押したら［実行］は「実行済み」になり、人が［解決］を押す
- ［⚠ 違う］: `{ at, cardId, ability, summary: describeRecipe, recipe }` を localStorage `lf.recipeReports` に足す（try/catch）。
  ログパネルの見出しに小さく「⚠ n件を書き出す」を出し、押すとクリップボードに JSON をコピーして件数を表示する。0件なら出さない
- 相手の画面には提案を出さない（結果の `applyEffect` のログ1行が届くだけ）

## 6. 手書きのレシピ12件（`_local/effect-recipes.json`）

本文を読んで書く（本文はE0後の `pool.json`）。**レシピの形が本文と合わないカードがあったら、無理に書かず報告する**（型の見直しは統括が決める）。

| カード | 能力 | 狙い |
|---|---|---|
| e_降霊術 | '' | draw 自分2 |
| e_死中に活 | '' | draw 自分3 |
| e_プレゼント | '' | draw both 1 |
| e_弓矢 | '' | pick 1（any・char/leader）に kiryoku −1 |
| e_鬼の暴走 | '' | all（theirs・char/leader）に kiryoku −1 |
| e_嫌がらせ | '' | pick 1（any・char）に −2 ＋ leader mine に −2 |
| e_安眠 | '' | pick 1 に kiryoku +3 と orient rested（同じ pick を2つの step で使う） |
| e_穏形法 | '' | pick 1 に flag「すべてのアクションの対象にならず、バトルに参加できない」ターン終了時 |
| e_会場閉鎖 | '' | pick 1（any・battle）を trash |
| c_神岸あかり | お弁当 | pick 1 に kiryoku +1 |
| c_柏木梓 | 鬼の力 | self に 力+2 ターン終了時 |
| c_柏木楓 | 鬼化 | self に 力+2・早+2 ターン終了時 |

「ダメージ」を気力の減少として扱うのは、今の右クリックの「ダメージ」操作と同じにする（別の操作があるならそちらを使い、報告する）。

## 7. テスト（`scripts/test-effects.ts` を新設・`package.json` の `test` に1行）

- `planEffect`: 上の12件のうち少なくとも8件について、**期待する BoardAction 列を手で書いて**比べる（実装の出力を写さない。`test-timing.ts:45` の事故＝フェイクが実装の誤りを写した件を繰り返さない）
- `applyEffect`: 子3つを1回で適用→ログ1行／子が全部空→状態もログも変わらない／子に `resolveStep` が混じっても無視される／`undo` 1回で元に戻る
- 札: 札の modifier が [28] の攻防修正クリアで消えない
- `draw`: デッキ1枚で2枚ドロー→1枚だけ動く

## 8. 出力
- `npm run data:bundle` のレポートに: レシピの件数・形の検査の結果
- `HANDOFF-E1.md` に: 12件それぞれの `describeRecipe` の出力と元の本文を並べた表（統括が目で突き合わせる）

## 9. 完了条件
- `npm run verify` が緑（件数を書く）
- 新しい zip に `recipes.json` が入り、12件が読める
- 煙試験: 1タブで e_降霊術 の宣言→解決の段で提案が出る→実行でデッキから2枚手札へ→Undo 1回で戻る

## 10. 報告前の自己点検（表で書く）
- §1〜§7 の各項目: やった／やっていない／やれなかった理由
- 🚨「越えない線」の3点それぞれについて、どのコードで守っているか（ファイル:行）
- 数字はスクリプトで数え直す。「〜が多い」には件数と実例
- 既存の操作と違う BoardAction を作った箇所があれば全部

## 11. 報告の形（`HANDOFF-E1.md`）
やったこと／変えたファイル／12件の表／自己点検／判断に迷ったこと（統括に返す）／副産物の発見。**コミットはしない**（統括が検証してからコミット）。

## 12. やらないこと
- 打ち消し（`counter`）＝E2（原典照合が先）
- レシピの一括生成＝E2
- 継続効果の札を盤面に常時出すこと＝E4
- 使用代償の自動支払い＝P3b
- 宣言時の対象指定（`DeclaredAction.targets`）＝P3a-5
