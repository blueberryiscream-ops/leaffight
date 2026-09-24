# PHASE 5b — 対戦卓で「デッキで始める」（開始準備 10-1・マリガン 10-1-1）

**担当**: 統括が起動するサブエージェント（実装）
**前提**: P5a（デッキ画面・`src/data/deck.ts`・Dexie `decks`）がコミット済みであること。
**まず読むもの**: `IMPLEMENTATION-NOTES.md`（§1 必読）→ `DESIGN.md §4.11・§4.21（末尾「対戦卓での使用」）・§6` →
`HANDOFF-P5a.md` → `src/core/board.ts`・`src/core/actions.ts`・`src/core/history.ts` → `src/ui/board/useBoard.ts`・`Board.tsx`・`ZoneBundle.tsx`・`DetailPanel.tsx`・`CardPiece.tsx`・`TodoBand.tsx` → `src/data/deck.ts` → 本書。
**完了判定**: `npm run verify` が緑、かつ §7 の煙試験が通る。

---

## 0. 目的と範囲

P5a で作ったデッキを対戦卓で使えるようにする。開始準備（10-1）のうち**機械的な部分を1回の操作で行い**、マリガン（10-1-1）をボタン1つにする。
ルールの判定は「手札にキャラクターカードがあるか」だけ（ui 側で数える）。それ以外の自動化はしない。

### 原典（逐語・`_local/oldrule.txt`）
```
343 10-1 ゲームの開始準備
344 ゲーム開始時に、以下の処理をお互いのプレイヤーが行います。
345 [1] リーダーキャラを自分のデッキから選び、相手プレイヤーに見せないよう裏にして自分のフィールドに出す。
346 [2] 自分のデッキをシャッフルする。
347 [3] 自分のデッキを自分の場に置く。
348 [4] 自分のデッキからカードを７枚ドローして自分の手札に加える。
349 [5] 自分の手札にキャラクターカードがない場合、『マリガン』を１回だけ宣言することができる。
350 マリガンを宣言したプレイヤーはマリガンの処理を行う。
351 マリガンの処理をした結果、自分の手札にキャラクターカードがない場合でもゲームは続行する。
352 [6] じゃんけんなどで先攻、後攻を決める。
353 [7] 自分のリーダーキャラを表にする。
354 これらの準備を行った後に、先攻プレイヤーから「ターン」を開始します。
355 10-1-1 マリガン
356 ゲームの開始準備においてマリガンを宣言したプレイヤーは次の手順を行う。
357 [1] 自分の手札を相手に公開し、キャラクターカードが無いことを相手プレイヤーに証明する。
358 [2] 自分の手札のカードをすべて自分のデッキに戻す。
359 [3] 自分のデッキをシャッフルする。
360 [4] 自分のデッキからカードを７枚ドローして自分の手札に加える。
```
- マリガンの判定に**タッグを数えない**: `oldfaq.txt:3468-3469`「手札にキャラクターカードは無いが、タッグキャラクターカードはある場合はマリガンできますか？／Ａ．できます。」、`oldrule.txt:586`「タッグキャラクターカードはキャラクターに含みません。」→ **kind==='c' だけ**を数える（P5a の `charCount` と同じ）
- 呼び出しコストは関係ない: `oldfaq.txt:3471-3472`「呼び出しコストの数にかかわらず、キャラクターカードが手札にある場合はマリガンを行えません。」
- リーダーの気力: `oldrule.txt:201`「気力上限＝（元の気力×２＋カードの効果による値の修正）」、`:614`「キャラがフィールドに出されたとき、気力上限と同じ値の気力を持つキャラとして扱われます。」→ **リーダーは 元の気力×2 の気力で置く**（既存の `maxKiryokuFor('leader', base)` を使う）

### 守ること
- 🚨 **core に乱数・時刻・カード種別の知識を持ち込まない。** シャッフルの結果（iid の並び）と、マリガンできるかの判定は ui が決めて渡す。core は「渡された並びが正しい集合か」だけ確かめる（`shuffleDeck` と同じ流儀）
- 🚨 **盤面ロックを作らない**（DESIGN §3）。開始準備中でも盤面は今までどおり触れる。ボタンが増えるだけ
- 🚨 **`localSeat` を `BoardState` に入れない**
- 🚨 **永続状態にフィールドを足したら、古い保存盤面を既定値で補完する**（`useBoard` の `{...EMPTY_BOARD, ...saved}`。P3a-1 で真っ暗になった事故の再発防止）
- 色は `@theme` トークンだけ。新しい画面部品は `lf-panel`／`lf-btn-primary` 等の既存クラスを使う
- デッキの中身・順番は今の盤面と同じく共有状態に入る（相手の手札と同じく「描画で伏せる」方式。身内用なので暗号化はしない＝既存の方針どおり）

---

## 1. core（`src/core/board.ts`・`actions.ts`）

### 1-1 状態
```ts
interface SetupState { deckName: string; mulliganUsed: boolean; leaderRevealed: boolean }
// BoardState に追加
setup: Record<Seat, SetupState | null>   // EMPTY_BOARD では { A: null, B: null }
```
- `null` ＝デッキで始めていない（今までどおりの手置き）。`clearBoard` で両方 null に戻る

### 1-2 アクション（3つ）
```ts
| { type: 'startWithDeck'; owner: Seat; deckName: string;
    leader: { iid: string; cardId: string; kiryoku: number | null };
    deck: { iid: string; cardId: string }[];   // 🚨 ui がシャッフル済みの並び（先頭＝一番上）
    draw: number }                              // 7
| { type: 'mulligan'; owner: Seat; orderedIids: string[]; revealedNames: string[]; draw: number }
| { type: 'revealLeader'; owner: Seat; cardName: string }
```
- **startWithDeck**:
  1. `battle !== null` または `priority !== null` なら何もしない（`log: ''`）。バトル・宣言の途中で盤面を差し替えると参照が壊れるため
  2. `owner` のカードを**全ゾーンから**消す（共有フィールドの `owner` 一致分も）。消したカードを対象にした `modifiers` も消す。
     **相手のカードの `attachedTo` が消したカードを指していたら `null` にする**（ぶら下がり参照を残さない）
  3. リーダーを `leader` ゾーンに `faceUp: false`・`kiryoku` は渡された値で置く。🚨 **向きは `orientation: 'ready'`（縦置き＝待機）**。`spawnCard` の既定（leader＝消耗）ではないので明示して上書きする（利用者確定 2026-09-24・§6）
  4. `deck` の並びどおり `deck` ゾーンに置く（index 0 が一番上＝`ZoneBundle` が見せる札）
  5. 上から `draw` 枚を `hand` へ（`faceUp: true`。相手の画面では既存どおり伏せて描画される）
  6. `setup[owner] = { deckName, mulliganUsed: false, leaderRevealed: false }`
  7. ログ: `「{deckName}」で開始準備（リーダーを裏向きで置き・{n}枚シャッフル・{draw}枚ドロー）`。🚨 **リーダーの名前をログに出さない**（[1]「相手プレイヤーに見せないよう」）
- **mulligan**:
  1. `setup[owner]` が null／`mulliganUsed`／`leaderRevealed` のどれかなら何もしない（`log: ''`）。「1回だけ」「開始準備の中だけ」を core で守る
  2. `orderedIids` が「owner の hand ∪ deck」とちょうど同じ集合でなければ何もしない
  3. 手札を全部デッキへ → `orderedIids` の並びにする → 上から `draw` 枚を手札へ → `mulliganUsed = true`
  4. ログ: `マリガン: 手札を公開 [{revealedNames.join('・')}]`（10-1-1[1] の公開をログで行う）
  - 🚨 「手札にキャラクターカードが無いか」は core では判定しない（カード種別を知らないため）。ui がボタンを出し分ける
- **revealLeader**: `setup[owner]` が null または `leaderRevealed` なら何もしない。リーダーを `faceUp: true`、`leaderRevealed = true`、ログ `リーダーを表にした: {cardName}`
- 3つとも Undo/Redo の対象（既存の history にそのまま乗る）

## 2. ui

### 2-1 「デッキで始める」
- 置き場所: 盤面上部の既存の「盤面クリア」ボタンの隣
- 押すと自分のデッキ一覧（`listDecks()`）を小さなダイアログで出す（デッキ名・リーダー名・`60/60 ✓`）。
  **`validateDeck(...).ok` でないデッキは選べない**（灰色＋理由を1行）。デッキが無ければ「デッキ画面で作ってください」
- 選んだら:
  - 自分の盤面（`owner === mySeat` のカード）が1枚でもあれば `confirm('自分の盤面のカードをすべて片付けて、このデッキで置き直します。よろしいですか？')`
  - バトル中・宣言中ならボタンを押せない（理由を title に）
  - `counts` から iid を振って60枚を作り、`leaderCardId` の1枚をリーダーに、残り59枚を**`Math.random` でシャッフル**して（`src/data/deck.ts` の `sampleHand` の中にあるシャッフルを `export function shuffle<T>(arr: T[], rng: () => number): T[]` として切り出し、`sampleHand` もそれを使う形にしてから流用。テストに1件足す） `startWithDeck` を dispatch
  - 今のカードデータに無い cardId があれば dispatch せずに「カードデータに無いカード: …」と出す
- ゲストも同じ手順（自分の IndexedDB のデッキから作ってホストへ送る。既存の dispatch がそのまま送る）

### 2-2 開始準備中の表示（`setup[mySeat]` が null でなく `leaderRevealed` が false の間）
- 「今やること」帯（`TodoBand`）に: `開始準備: マリガン（手札にキャラクターカードが無いときだけ）→ じゃんけん等で先攻後攻を決める → リーダーを表にする`
- ボタン2つ（帯の中か、盤面上部。どちらでもよい）:
  - **「マリガン」**: 押せるのは `!mulliganUsed` かつ **自分の手札に `kind==='c'` が0枚**のときだけ（タッグは数えない）。押せないときは理由を title に。
    押したら `confirm` → 手札＋デッキの iid をシャッフル → `mulligan` を dispatch（`revealedNames` は手札のカード名）
  - **「リーダーを表にする」**: `revealLeader`
- 相手の開始準備の状態（マリガン済みか・リーダーを表にしたか）が相手側の画面でも分かるように、帯か盤面上部に短く出す（例: `相手: 準備中（マリガン済み）`）

### 2-3 裏向きのリーダーを相手に見せない
- 🚨 **今は `DetailPanel.tsx:52` の `hiddenFromMe` が `zone === 'hand'` しか見ていない。** 裏向き（`faceUp === false`）の相手のカードも伏せる条件に足す。
  `HoverPreview`（拡大）も同じく、裏向きの相手のカードは表を出さない。自分の裏向きリーダーは自分には見えてよい（実物でも自分は知っている）
- 盤面の `CardPiece` は `faceUp` で既に裏面を描くはずだが、裏向きリーダーで確かめる

## 3. テスト（`npm run verify` に足す）

新規 `scripts/test-setup.ts`（core だけ・偽のカード）を `package.json` の `test` に1行:
- `startWithDeck`: リーダー1枚が leader・faceUp=false・**orientation=ready**・kiryoku が渡した値／deck 52枚・hand 7枚／hand の7枚が渡した並びの先頭7枚／ログにリーダー名が含まれない
- 既存の自分のカード（char・trash・field）が消える／**相手のカードは1枚も変わらない**／消したカードへの modifier が消える／相手のアイテムの attachedTo が消したカードを指していたら null
- `battle` または `priority` が non-null なら状態が変わらない
- `mulligan`: 手札7枚がデッキに戻り、渡した並びの先頭7枚が手札／2回目は何もしない／`leaderRevealed` 後は何もしない／集合が合わない orderedIids は何もしない／setup が null なら何もしない
- `revealLeader`: faceUp=true・ログにカード名／2回目は何もしない
- 古い保存盤面（`setup` なし）を `useBoard` と同じ補完にかけて `setup` が `{A:null,B:null}` になる（補完関数を切り出してテストできる形にする）
- 🚨 期待値は本書 §1 と原典の逐語から作る（実装の出力を写さない）

## 4. やらないこと
- 先攻後攻の決定（[6]＝人がじゃんけん等で決める）・ターン開始
- 開始時の手札公開以外の非公開情報の保護（既存の方針どおり）
- デッキ切れ敗北・手札上限の強制
- リーダー専用カード（標準プール外）

## 5. 報告
`HANDOFF-P5b.md` を1枚（形は P5a と同じ）:
- やったこと／判断した点／申し送り
- **自己点検**: §1〜§3 の要求を1行ずつ表にし「実装した場所（ファイル:行）」「確かめた方法（テスト名／煙試験／未確認）」。
  テストに無い要求（ボタンの出し分け・title の理由・確認ダイアログ・DetailPanel/HoverPreview の伏せ・トークン色・古い盤面の補完）も1行ずつ。未は「未」
- `npm run verify` の結果（テスト件数は出力を数え直す）
- 🚨 **コミットしない**

## 6. 未決事項（実装で決めない）
- ✅ 解決: **開始時のリーダーは縦置き＝待機（`ready`）**（原典に明文なし→利用者確定 2026-09-24）。§1-2 startWithDeck の3で明示する。テストにも「leader の orientation が ready」を足す

## 7. 確認（サブは煙試験だけ・🚨 10手順以内・ブラウザのツール呼び出し40回まで）
- `npm run verify` 緑
- 開発サーバー（`leaffight-dev`）1タブ・solo で `javascript_tool`:
  1. コンソールにエラーが無い
  2. デッキ画面で有効なデッキが1つあることを確かめる（無ければ作る）
  3. 対戦卓で「デッキで始める」→ リーダー1・手札7・デッキ52（DOM か状態で数える）
  4. マリガンボタンの押せる/押せないが手札のキャラクターカード有無と一致
  5. 「リーダーを表にする」で表になる
- 2タブ（相手に伏せて見えるか）は**統括がやる**のでやらない。40回に達したらそこまでを HANDOFF に書いて止める。スクリーンショットは撮らない
