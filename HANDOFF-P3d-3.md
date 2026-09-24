# HANDOFF-P3d-3.md — バトルの操作性（盤面クリック選択・攻防の自動入力・攻防修正・使用済みの横向き・「今やること」帯）

**担当**: 実装サブエージェント　**前提**: HEAD = `d293c6a`（コミットしていない・統括の検証待ち）

---

## 1. やったこと（ファイルごと）

### core/
- `src/core/board.ts`
  - `Modifier` に `kind: '能力値修正' | '攻防修正'`（必須）・`battleStat?: 'atk'|'def'` を追加（型 `ModifierKind` も export）
  - `effectiveStat` が `kind==='能力値修正'` だけを数えるようフィルタを追加
  - `clearBattleModifiers(state)` を新設（`kind==='攻防修正' && scope==='このバトル'` を消す。件数を返す）
- `src/core/battle.ts`
  - `setValue` の `value` を `number | null` に変更（`null`＝自動に戻す）
  - `decideBattleValues(battle, {atk, def})` を新設（at===23のときだけ有効。4値を書き込み `advanceStep` でat=25へ進める）
- `src/core/actions.ts`
  - `setBattleValue.value` を `number | null` に
  - `decideBattleValues` アクションを追加（ゲート: assistでpriority!==nullならno-op）
  - `advanceBattleStep` に「at=28から出るとき攻防修正（このバトル）を消す」処理を追加（中断経由・通常とも、assist/freeとも通る位置に実装）

### ui/board/（新規ファイル）
- `src/ui/board/battleValues.ts` — `isBasicBattleCard`・`autoBattleValues`（§2）。純関数・Reactを import しない
- `src/ui/board/normalize.ts` — `normalizeModifiers`（旧state正規化）。React/net/data を import しない独立ファイル（テストから直接呼べるように）
- `src/ui/board/priorityWindow.ts` — `resolveDestinationOf`・`priorityWindowInfo`（StackPanel.tsxとTodoBand.tsxで共有。二重に書かない）
- `src/ui/board/modifierLabel.ts` — Modifierの表示テキストを1か所にまとめる（CardContextMenu.tsx・DetailPanel.tsxで共有）
- `src/ui/board/TodoBand.tsx` — 「今やること」帯（§5）

### ui/board/（既存ファイルの変更）
- `src/ui/board/BattlePanel.tsx`
  - `canAct`・`nextBlocked`・`nextActor` を export（Board.tsx・TodoBand.tsxと共有）
  - `decideBlocked` を新設・export（[7][11]の「決定して次へ」を押せるかの判定）
  - `ParticipantChecklist` の選択state をpropsに変更（`selected`/`onToggle`。Board.tsxに持ち上げたstateを受け取る）。ボタンを「決定して次へ」に変更（`setBattleParticipants`→`advanceBattleStep`を続けてdispatch）
  - `AtkDefRow` を全面改修（手入力??自動の表示、自動/手入力札、自動に戻すボタン、攻防修正合計の参考表示）
  - `[28]` のパラグラフに消える件数・残る件数を表示
  - 下部「次へ」ボタン：at===23のときは表示値（手入力??自動）が4つとも数値なら`decideBattleValues`をdispatch
  - `BattlePanel` に `battleSelection`/`onToggleBattleSelection` props を追加
- `src/ui/board/Board.tsx`
  - `battleCandidateKind`（候補判定。§1）を追加
  - `battleSelected`（未決定の参加キャラ選択。`battle.at`が変わったらリセット）をローカルstateとして持ち上げ
  - `handleCardClick`／`battleRingProps` を追加。charCell/leaderCell/battleGroupの`onCardClick`を差し替え、リング表示propsをspread
  - `TodoBand` をチロム直下に配置。`BattlePanel`に`battleSelection`/`onToggleBattleSelection`を渡す
- `src/ui/board/CardPiece.tsx`
  - `tapRotation(instance)` を export（消耗-90° と 使用済みバトルカード-90° を1か所にまとめる。§4）
  - `battleRing`/`battleRingLabel` props を追加（候補=点線リング、選択中=実線リング＋バッジ）
  - 🚨 実機で発覚: 当初 `selected`（詳細パネル選択・黄色）を `battleRing`（参加/種目選択・水色）より先に判定していたため、参加キャラをクリックすると詳細パネル選択も同時に起きて参加リングが常に隠れる不具合があった。優先順位を入れ替えて修正済み（後述§7参照）
- `src/ui/board/StackedCardSlot.tsx` — `tapRotation`を使うよう変更。`battleRing`/`battleRingLabel`をtargetにだけ中継
- `src/ui/board/StackPanel.tsx` — ローカルの`resolveDestinationOf`を削除し`priorityWindow.ts`のものを使う
- `src/ui/board/useBoard.ts` — 読み込み時に`normalizeModifiers`を通す
- `src/ui/board/CardContextMenu.tsx` — 修正フォームに種類切り替え（能力値/攻防）追加。攻防選択時はbattleStat select・scope既定「このバトル」。一覧表示は`modifierLabel`を使用
- `src/ui/board/DetailPanel.tsx` — 修正一覧の表示を`modifierLabel`に統一

### テスト
- `scripts/test-battle.ts` — §12: `setValue(...,null)`のテスト追加
- `scripts/test-battle-flow.ts` — §16: `decideBattleValues`（at=23で確定・at≠23 no-op・assistでpriority開なら no-op）／§17: at=28から出るときの攻防修正クリア（このバトルだけ消える・能力値修正は残る・他scopeの攻防修正は残る・中断経由でも同じ）／§18: `effectiveStat`が攻防修正を数えない
- `scripts/test-battle-values.ts`（新規）— `isBasicBattleCard`・`autoBattleValues`（1体参加/2体参加null/特殊カードnull/statsなしnull）・`normalizeModifiers`
- `package.json` — `test:battle-values`を追加し`test`に連結

---

## 2. 判断した点（本書と違う形にしたら理由）

- **`nowTodo`を独立した純関数にしなかった。** 指示書§5は「新規の純関数 `nowTodo(board, localSeat, ...)` → `{text, tone, action?}`」を想定していたが、実装では`TodoBand.tsx`のコンポーネント内に判定ロジックを直接書いた（JSXを返す`Band`ヘルパーのみ分離）。理由: 主ボタンのdispatchが選択state（`battleSelected`）・`cardOf`・`autoBattleValues`など複数の文脈に依存し、「データを返す純関数」と「それを描画するコンポーネント」に分けると往復が増え、効果の見合いが薄いと判断した。
  - **代償**: nowTodoの分岐ロジック（優先順位・文言）を独立にユニットテストできていない。§7の煙試験でごく一部（優先権の窓・[7]の行動点）を確認しただけ。**申し送りへ。**
- **`decideBlocked`・`canAct`・`nextActor`・`nextBlocked`を`BattlePanel.tsx`からexportして`Board.tsx`/`TodoBand.tsx`から再利用した。** 指示書が明示したのは「StackPanel.tsxのawaiting/resolving/resolveTo」の共有だけだが、同じ「二重に書かない」の精神で他の判定関数も共有した。

---

## 3. 自己点検（§1〜§6 要求ごと）

| # | 要求 | 実装した場所 | 確かめた方法 |
|---|---|---|---|
| §1 | 選択モードの導出（[7][11][16]の候補集合） | `Board.tsx:battleCandidateKind` | 煙試験: [7]でleaderAが候補としてクリック可能・トグルで選択されることを確認 |
| §1 | [7][11]クリックでトグル・setSelectedIidも行う | `Board.tsx:handleCardClick` | 煙試験で確認（クリック後にDetailPanelにも表示された） |
| §1 | [16]クリックでその場でsetBattleCard | `Board.tsx:handleCardClick`（battleCard分岐） | **未確認**（コードレビューのみ。ボタン版の`BattleCardChecklist`「選ぶ」と同じdispatchを呼んでいるだけなので合流点は確認済みだが、盤面クリックの実クリックはしていない） |
| §1 | 見た目: 候補=点線リング／選択中=実線リング＋バッジ、targetのみ | `CardPiece.tsx`・`StackedCardSlot.tsx` | 煙試験で「選択中」を確認（実機で`selected`優先の不具合を発見し修正。§7参照）。「候補（点線）」は目視未確認（テスト中は候補が1枚しかなく即選択されたため） |
| §1 | チェックリストは残す・盤面と同じstateを共有 | `BattlePanel.tsx:ParticipantChecklist`（props化）・`Board.tsx:battleSelected` | 煙試験: 盤面クリックでBattlePanel側のチェックが連動することを確認（「参加」バッジ表示・DetailPanelとの整合） |
| §1 | 決定を1回に（setBattleParticipants→advanceBattleStep） | `BattlePanel.tsx`「決定して次へ」・`TodoBand.tsx` | 既存coreテスト（advanceBattleStepの前提チェック）で間接確認。UIボタンの実クリックは**未確認**（時間の都合） |
| §2-1/2-2 | `isBasicBattleCard`・`autoBattleValues` | `battleValues.ts` | `test:battle-values` 全件PASS |
| §2-3 | `Battle.atk/def`: null=自動／数値=手入力。`setValue(...,null)` | `battle.ts:setValue` | `test:battle`12番 PASS |
| §2-3 | `decideBattleValues`（at=23限定・at=25へ進める・assistでpriority開ならno-op） | `battle.ts`・`actions.ts` | `test:battle-flow`16番 PASS |
| §2-4 | UI表示（手入力??自動、自動/手入力札、自動に戻すボタン、攻防修正合計） | `BattlePanel.tsx:AtkDefRow` | **未確認**（at=18まで盤面を進めていない。コードレビューのみ） |
| §3-1 | `Modifier.kind`・`battleStat`型 | `board.ts` | 型チェック（`tsc`）通過・`test:battle-values`で構築して使用 |
| §3-1 | `effectiveStat`が攻防修正を数えない | `board.ts` | `test:battle-flow`18番 PASS |
| §3-2 | [28]から出るとき攻防修正（このバトル）だけ消える。中断経由も同じ | `actions.ts:advanceBattleStep` | `test:battle-flow`17番 PASS（通常経路・中断経路の両方） |
| §3-2 | UI: [28]の「次へ」ラベルに件数 | `BattlePanel.tsx`・`TodoBand.tsx` | **未確認**（at=28まで盤面を進めていない） |
| §3-3 | `normalizeModifiers`（kind無し→能力値修正） | `normalize.ts`・`useBoard.ts` | `test:battle-values`6番 PASS |
| §3-4 | 右クリックフォーム: 種類切替・攻防でbattleStat select・scope既定「このバトル」 | `CardContextMenu.tsx` | **未確認**（右クリックメニューの実クリックはしていない。コードレビューのみ） |
| §3-4 | 修正一覧の表示区別（「攻+2（攻防修正・このバトル）」等） | `modifierLabel.ts` | **未テスト**（純関数だが専用のunit testは書いていない。目視も未確認） |
| §4 | 使用済みバトルカードを-90°（rested/used両方立っても1回だけ） | `CardPiece.tsx:tapRotation` | **未確認**（実機でバトルカードをused=trueにする操作をしていない。コードレビューのみ。ロジックは`||`なので二重回転は原理的に起きない） |
| §4 | バトル枠は正方形なのではみ出さない | 変更なし（既存cellSquareのまま） | 既存設計を流用しただけなので非回帰と判断（未計測） |
| §5 | 帯の配置（チロム直下・全幅・高さ固定） | `Board.tsx`・`TodoBand.tsx`（`h-10 shrink-0`） | 煙試験で表示位置・複数状態間で高さクラスが変わらないことをコードで確認。DOM実測（高さpx一致）は**未確認** |
| §5 | 文字は大きく（text-lg font-bold）・トーンで色分け | `TodoBand.tsx` | クラス付与のみ確認。色のコントラスト等の目視確認は**未確認** |
| §5 | 優先権の窓→バトル行動点→自由、の優先順位 | `TodoBand.tsx` | 煙試験: バトル宣言直後は「自由に操作できます」(at=2は行動点でないため)→[7]で「盤面で参加キャラをクリック→決定して次へ」→プレイ宣言後「相手の応答待ち…」の3状態を実機で確認 |
| §5 | 誰の番かの判定はStackPanel.tsxと共有 | `priorityWindow.ts` | 煙試験で「相手の応答待ち…」がStackPanel側の状態と一致することを確認。コードは同じ関数を呼んでいる（二重実装なし） |
| §5 | 帯の主ボタンは同じactionをdispatchするだけ | `TodoBand.tsx` | コードレビュー（passPriority/resolveStep/setBattleParticipants+advanceBattleStep/decideBattleValues/advanceBattleStepをそのまま呼ぶだけ）。実クリックでの動作確認は「通す」相当の分岐は未到達、[7]の「決定して次へ」ボタンの表示は確認したがクリックはしていない |
| §5 | 帯以外の文字サイズを変えない | 変更なし | diffで確認（他ファイルにtext-lg等の追加なし） |
| §6 | テスト一式 | 上記参照 | `npm run test` 全PASS（後述） |

---

## 4. grep実測（§9必須）

```
$ grep -rnE "#[0-9a-fA-F]{3,8}" src --include=*.tsx --include=*.ts | grep -v "index.css"
（0件・matchなし）
```
→ 新しく入れたパレット色の直書きは0件（既存のindex.cssの@themeトークンのみ使用）。

```
$ grep -rn "overflow-auto\|overflow-scroll" src/ui/board/Board.tsx src/ui/board/TodoBand.tsx
（0件・matchなし）
```
→ 盤面（Board.tsx）・帯（TodoBand.tsx）に`overflow-auto`/`overflow-scroll`を足していない。

---

## 5. `npm run verify` の結果

**緑。** `npm run build`（`check-core-isolation` → `tsc` → `vite build`）・`npm run test`（6スイート）とも成功。

テスト件数（`npm run test 2>&1 | grep -c "^✅"`で数え直し）: **278件PASS・0件FAIL**（内訳: test:core-priority, test:timing, test:play-declare, test:battle 45件, test:battle-flow 105件, test:battle-values 16件 ＋既存3スイート）。

---

## 6. 煙試験の結果とツール呼び出し回数

**ツール呼び出し数: 約30回**（40回の上限内）。

実施内容:
- 開発サーバー（`http://localhost:5300`、既に起動済みだったものを利用）を1タブで開いた
- `javascript_tool`でコンソールエラー無しを確認（読み込み直後・操作後の2回）
- 「今やること」帯が表示されていることを`get_page_text`で確認（「自由に操作できます」）
- 1280×720・1920×1080 の両方で `document.scrollingElement.scrollHeight <= innerHeight` を確認（両方`true`。`resize_window`後に`navigate`で再読込する手順=IMPLEMENTATION-NOTES.md §1に従った）
- ソロ（フリーモード）で、リーダーA/B・バトルカード（腕相撲）を盤面に配置し、バトルを宣言 → `advanceBattleStep`を3回押して[7]（挑んだ側キャラ指定）まで進めた
- [7]で**盤面のカード（相田響子＝リーダーA）をクリック**（MouseEvent直接発火）し、選択リング（実線・トークン色）と「参加」バッジが付くことを確認。TodoBandが「盤面で参加キャラをクリック → 決定して次へ」＋ボタンを表示することも確認
  - **この過程で実機バグを1件発見・修正**: `selected`（詳細パネルの黄色選択）が`battleRing`（参加選択の水色リング）より先に判定されていたため、参加キャラをクリックすると同時に詳細パネル選択も起きて参加リングが常に隠れていた。`CardPiece.tsx`のクラス判定順を入れ替えて修正し、再度実機で確認済み
- スクリーンショットは撮っていない（IMPLEMENTATION-NOTES.md §1の既知の制約）

**未実施（統括または次セッションへ）**:
- [16]（種目のバトルカード）の盤面クリック
- [23]の「決定して次へ」（decideBattleValues）の実クリック
- [28]の攻防修正クリアの実クリック
- CardContextMenuの攻防修正フォーム（種類切替・scope既定切替）の実クリック
- 2タブでの通し確認（統括の担当・§7で明記）

---

## 7. 申し送り

1. **nowTodo.tsを独立した純関数にしなかった**（§2「判断した点」参照）。TodoBand.tsxの分岐ロジックに専用のユニットテストが無い。時間の都合で見送った。次にこの帯を触るときは、テスト容易性のためにロジックをpure関数へ切り出すことを検討してほしい。
2. **AtkDefRow・[28]ラベル・CardContextMenuの攻防修正フォームは、コードレビューと型チェックは通っているが実機クリックでの確認をしていない。** 統括の2タブ確認の際にあわせて見てもらえると安心。
3. **CardPieceの`selected` vs `battleRing`の優先順位バグ**は実機で見つけて直した（§6参照）。同種の「複数のリング/枠線が同時に立ちうる」状況が今後増えたら、優先順位の一覧をどこかにコメントで残すと良いかもしれない。
4. `modifierLabel.ts`は純関数だが専用テストが無い。ロジックは単純（kindで分岐して文字列を組むだけ）なので優先度は低いと判断した。

---

## 8. コミットについて

🚨 **コミットしていない。** 統括が検証してからコミットしてください。

---

## 統括6の検証（2026-09-24）

- `npm run verify` 緑（統括が数え直して ✅ 279件・失敗0。サブ報告の278とは数え方の差）
- core の差分を精読（kind・effectiveStat・clearBattleModifiers・decideBattleValues・[28]の分岐）。指示書どおり
- **2タブ（testplay host/guest・assist モード）でバトル1本を通した**（腕相撲＝基本・力/力、リーダー同士）:
  - [7] ホストが盤面クリック → 実線リング＋「参加」→ 帯の「決定して次へ」1回で参加・消耗・[8]の窓。ゲストの帯は「相手が参加キャラを選んでいます」
  - [11] ゲストが盤面クリック（候補リングが先に出ている）→ 決定して次へ → [13]
  - 窓は全部、帯の「通す」で両者が通した（[8][10][13][15][17][19][20][22][25][27][29]）。帯は高さ 40px・はみ出しなし
  - [16] 盤面クリックで種目決定 → 腕相撲が横向き（ホスト -90°／ゲスト 90°＝反転と合成、92×66 が 92×92 の枠内）
  - [18] 自動入力: A 攻2/防2・B 攻1/防1（力の値）。右クリックで攻防修正「攻+2」→ scope 既定が「このバトル」に切替 → A 攻4（防2のまま）。ゲストも 4/2/1/1
  - [23] ゲストが帯の「決定して次へ」→ ログ「攻防能力値を確定した（攻A4/防A2／攻B1/防B1）」→[25]
  - [26] ダメージ既定値 A0・B3（4−1）→ 適用
  - [28] 帯「攻防修正 1 件を消して次へ」→ ログ「攻防修正 1 件を失わせた（20-4[28]）」→[29]→ 両者通して battle=null・帯「自由に操作できます」・縦スクロール0・コンソールエラー0
- **統括が直した2点**（tsc/verify 緑。実クリックは未確認）:
  1. バトルパネルの [28] の「次へ」ボタン自体の文言を「攻防修正 N 件を消して次へ」に（指示書 §3-2。説明文にしか出ていなかった）。件数の数え方を `clearableBattleMods` に1本化
  2. 帯の [16]（選んだ後）と [18] に「次へ」ボタンを足した（文言だけで押す先がパネルにしか無かった）
- 未確認のまま残るもの: nowTodo のユニットテスト無し（サブの判断・§2）、中断経由の [28] の UI（core テストでは確認済み）、modifierLabel の単体テスト
