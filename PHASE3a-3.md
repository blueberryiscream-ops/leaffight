# PHASE 3a-3 — 手札プレイの自動宣言（ドロップ＝宣言、着地は解決時）

**担当**: 実装セッション（Sonnetで十分。仕様は全部ここに書いた／設計判断が要る発見が出たら実装せず統括に返すこと）
**前提**: P3a-1r（優先権エンジン新モデル）/ P3a-2a（StackPanel）/ P3a-2b（起動ボタン）/ P3c（割り込み自動検出v1）まで完了・コミット済み。HEAD = `060ce02`。
**まず読むもの**: `IMPLEMENTATION-NOTES.md`（環境制約・既知の罠）→ `DESIGN.md §5.1`（特に「モデルの訂正」「起動アクションのデータ層と起動UX」）→ 本書。

---

## 0. このフェーズの目的（なぜやるか）

**「相手のカードプレイに割り込む」が、まだ構造的にできない。** それを塞ぐ。

- プール416種の47%がタイミング系。「ガセネタ」「時間稼ぎ」は**相手のイベントを打ち消す完全カウンター**（DESIGN §5.1「データの裏付け」）。打ち消しは**解決の前**に飛ぶもの。
- ところが現状 `Board.tsx:148 handleDragEnd` は素の `moveCard` を投げるだけで、手札からカードを出しても**優先権の窓が開かない**。P3cの自動検出は事後（カードが場に出た後）にしか鳴らず、割り込むには Undo で戻す運用になっている（`HANDOFF-P3c.md` 申し送り2）。
- しかも `src/core/timing.ts:31` の `kind === 'プレイ'` 分岐（《イベントカードを使用するとき》《フィールドカードを使用するとき》《キャラクターカードが呼び出されるとき》）は**既に書かれているのに、その宣言を生む経路が無いためほぼ死んでいる**。本フェーズでここが開通する。

**ユーザー判断（2026-07-25）**: 手札から盤面へのドラッグは「**宣言だけ**」とし、**カードは解決時に着地させる**（ドロップ即着地ではない）。ルール上、打ち消しは解決前に飛ぶので、宣言中のカードが既に場にあるのは誤り。

---

## 1. スコープ

### やること
1. **手札 → 場/ゴミ箱 のドラッグを「プレイ宣言」に変える**（アシストモード時のみ）。
2. 宣言中のカードを新ゾーン **`pending`** に退避し、**両者から中身が見える**ようにする（打ち消し判断に必要）。
3. **解決（着地）／取り消し（手札に戻す）** の2択を解決ステップに出す。

### やらないこと（次以降・混ぜない）
- **アイテムの `attach` 経由のプレイ**（`CardControls` の「アイテムを付ける」）は今回スコープ外。素の `attach` のまま。→ 申し送りに書くこと。
- コストの検証・消費（P3b）。
- バトル宣言 / バトル7段（次フェーズ）。
- 起動型能力の宣言（P3a-2b で実装済み・無改造）。
- 🚨 **効果の解決内容・合法性判定は一切やらない**（DESIGN §5.1「あえて作らない」）。`pending` は「宣言されたカードの一時置き場」であって、ルール上の意味は持たない。

---

## 2. core の変更

### 2-1. `core/board.ts` — ゾーン `pending` を追加

```ts
export type ZoneId = 'deck' | 'hand' | 'trash' | 'leader' | 'char' | 'battle' | 'field' | 'pending'
```

- **束ゾーン**（`SLOT_CAPACITY` に入れない・`isSlotted` は false のまま＝変更不要）。
- `ZONE_LABEL`（`board.ts:348`）に `pending: '宣言中'` を追加（`Record<ZoneId,…>` なので tsc が抜けを検出する）。
- `resolveFaceUp`（`board.ts:148`）は**変更不要**。手札のカードは既に `faceUp: true` なので `pending` でも表のまま、`pending → hand` も表のままで正しい。
- **相手手札の裏描画（P2.5）は `zone === 'hand'` 判定なので、`pending` は自動的に対象外＝両者から見える。** ここは触らない。

### 2-2. `core/priority.ts` — `DeclaredAction` に着地先を持たせる

```ts
import type { Seat, ZoneId } from './board'

/** 宣言中のカードを解決時にどこへ着地させるか。engineはこれを一切解釈しない（ただの運搬物） */
export interface PlayPlacement {
  toOwner?: Seat
  toZone: ZoneId
  toIndex?: number
}

export interface DeclaredAction {
  by: Seat
  sourceIid: string | null
  kind: DeclaredActionKind
  actionType: ActionTiming
  label: string
  detail?: string
  place?: PlayPlacement | null   // ← 追加。手札プレイ宣言のときだけ入る
}
```

🚨 **`priority.ts` の状態遷移ロジックは 1 行も変えない。** `place` は素通しするだけ。ゾーン名を運ぶだけなのでカード知識ゼロは保たれている（`Seat` を既に import しているので `ZoneId` の追加 import も core 内で閉じる）。

### 2-3. `core/priority.ts` — 読み取り専用ヘルパー `canDeclare` を追加

UI が「今このドラッグを宣言に変換してよいか」を事前判定するため。`awaitingSeat`/`resolvingSeat` と同じ並びに置く。**`declareAction` 本体の受理条件と完全に同じ式**にすること（二重定義にせず、内部で `referenceSeat` を使う）。

```ts
/** その席が今「宣言」を通せるか（declareAction が受理するか）の事前判定。表示・入力ガード用 */
export function canDeclare(priority: Priority | null, seat: Seat): boolean
```

- `priority === null` → true（新しい窓を開ける）
- `step === 'awaitActive'` → `seat === referenceSeat(...)`
- `step === 'awaitNonActive'` → `seat === other(referenceSeat(...))`
- `step === 'processActive' | 'processNonActive'` → true（入れ子の割り込み）

### 2-4. `core/actions.ts` — reducer で「カードの移動」と「優先権の更新」を1アクションにまとめる

`BoardAction` の `resolveStep` に取り消しフラグを足す：

```ts
| { type: 'resolveStep'; cancel?: boolean }
```

**`declareAction` ケース**:
```
1. priorityEngine.declareAction(state.priority, action.action) を呼ぶ
2. 🚨 result.log === '' なら engine に弾かれている（priority.ts:110-111 の「不正: 何もしない」）。
   このとき state を一切変えずに返す。カードを動かしてはならない。
3. 受理された場合のみ、action.action.place && sourceIid があれば
   board.moveCard(state, { iid: sourceIid, toOwner: action.action.by, toZone: 'pending', cardName }) を
   適用し、その結果の state に priority を載せて返す。
```
⚠️ **順序に注意**: 「engine で受理判定 → 通ったらカードを動かす」。逆にすると弾かれた宣言でカードが手札から消える。

**`resolveStep` ケース**:
```
1. 更新前の priority から「今まさに解決される DeclaredAction」を取り出す
   （frames末尾の step が processActive なら active、processNonActive なら nonActive。
    resolvingSeat と同じ判定。宣言フェーズ中なら null）。
2. priorityEngine.resolveStep(state.priority) を呼ぶ。log === '' なら弾かれているので state 不変で返す。
3. 受理され、かつ 1 の action に place があり、そのカードが今 zone === 'pending' にいるなら:
     cancel === true  → board.moveCard(… toOwner: action.by, toZone: 'hand')
     それ以外         → board.moveCard(… place の toOwner/toZone/toIndex へ)
4. ログは「〜を解決」/「〜を取り消した（手札に戻した）」が分かる文言にする。
```

**`setMode` ケース（🚨 見落とし厳禁）**:
`free` に切り替えると `priority` が `null` になる（`priority.ts:196`）。このとき **`pending` に残ったカードは行き場を失って盤面から消える**（`pending` はどこにも描画されないため）。
→ **`free` へ切り替えるときは `pending` のカードを全て持ち主の手札に戻すこと。**

**不変条件（テストで担保する）**: `priority === null` のとき `pending` は空。

### 2-5. `core/timing.ts` — 変更不要（ただし確認すること）

- `hand → pending`（宣言）はどのフック条件にも当たらない＝**余計なタイミングは鳴らない**。宣言そのものから `declareTimings` が正しく鳴る。
- `pending → trash`（イベント解決）は `trashTimings` の `b.zone === 'hand'` に当たらない＝鳴らない。これは**正しい挙動**（《手札をゴミ箱送りにするとき》はコスト/ディスカードのタイミングであってイベント使用ではない。従来は手札→ゴミ箱ドラッグで誤爆していた）。
- 実装後に `npm run test:timing` が全緑のままであることを確認する。**もし赤くなったら勝手に期待値を書き換えず、統括に報告すること。**

---

## 3. UI の変更

### 3-1. `Board.tsx` `handleDragEnd`（148行目）

以下**すべて**を満たすときだけ `declareAction` に変換する。1つでも外れたら**現行どおり素の `moveCard`**（＝挙動を変えない）。

- `board.mode === 'assist'`
- `instance.zone === 'hand'`
- 着地先 `target.toZone` が `'char' | 'leader' | 'battle' | 'field' | 'trash'` のいずれか
  - **`'deck'` は含めない**（手札をデッキに戻すのは雑務。DESIGN §5.1「盤面の雑務は宣言＝スタック対象にしない」）
  - **`'trash'` を含めるのは意図的**: イベントカードには場の置き場が無く、「手札→ゴミ箱にドラッグ＝イベント使用」が実物の動きと一致するため。これが今回いちばん効かせたい経路。
- `canDeclare(board.priority, localSeat) === true`
  - false のときは**カードを動かさず**、UIログに「今は宣言できません（相手の応答待ち）」等を出して終わる。**黙って何も起きないのは不可**。

発行するアクション:
```ts
dispatch({
  type: 'declareAction',
  action: {
    by: localSeat,
    sourceIid: iid,
    kind: 'プレイ',
    actionType: <下記の導出>,
    label: cardName,
    detail: `${ZONE_LABEL[target.toZone]}へ`,
    place: { toOwner: target.toOwner, toZone: target.toZone, toIndex: target.toIndex },
  },
})
```

**`actionType` の導出（機械的に決める。カードの中身は見ない）**:
- 現在の窓の `step` が `processActive | processNonActive` → `'割込型'`（処理中への割り込み＝入れ子）
- それ以外（窓が無い / 宣言フェーズ）→ `'通常型'`

### 3-2. `StackPanel.tsx`

**(a) `ActionSlot` に「宣言中のカードを見る」導線を足す**
相手は宣言されたカードの**中身を見て**打ち消すか決める。`pending` のカードは盤面に描画されないのでクリックできない。
→ `action.sourceIid` があればカード名をボタンにし、押すと既存の詳細パネル選択（`Board.tsx:114 selectedIid` / `onCardClick={setSelectedIid}`）に流す。`StackPanel` に `onSelectCard?: (iid: string) => void` を足して `Board.tsx` から `setSelectedIid` を渡す。
- `action.place` があれば着地先（`detail`）も表示する。

**(b) 解決ステップに「取り消し」を出す**
`resolving === localSeat` かつ**その解決対象の宣言に `place` がある**ときだけ、既存の「解決（完了）」の隣に:
```
取り消し（手札に戻す）  → dispatch({ type: 'resolveStep', cancel: true })
```
- `place` が無い宣言（起動型能力など）には出さない。
- **なぜ「手札に戻す」だけか**: 打ち消されたイベントがゴミ箱行きか手札戻りかはルールの解釈であり、ツールは判定しない（§5.1「あえて作らない」）。中立に手札へ戻し、その後の処理は人間がドラッグでやる。この理由をコードコメントに残すこと。

**(c) 自動パスとの関係**
既存の自動パス（`StackPanel:128-148`）は**バトル宣言のときだけ**自動オフになる。手札プレイ宣言は対象外＝自動パスが効いたままでよい（それが自動パスの目的）。**ここは変えない。**

---

## 4. テスト（`npm run test:*` に足す）

既存の `test:core-priority` / `test:timing` と同じ流儀（Node 25 ネイティブTS・devDependency 追加なし）で、reducer レベルのケースを追加する（`test:play-declare` 等）。

1. 手札の e カードを `place={toZone:'trash'}` で宣言 → カードの zone が `pending` になる／`priority` が開く。
2. 上を `resolveStep`（cancel なし）→ zone が `trash` になり、窓が閉じる。
3. 上を `resolveStep({cancel:true})` → zone が `hand` に戻り、窓が閉じる。
4. **弾かれる宣言**（相手の応答待ち中に自分が宣言）→ **state が完全に不変**（カードが手札から消えない）。
5. 宣言中に `setMode('free')` → `pending` が空になり、カードが持ち主の手札に戻る。
6. `canDeclare` が `declareAction` の受理と一致する（4パターン）。

---

## 5. 実機検証（🚨 fresh 盤面だけでテストしないこと）

過去、実装セッションは**新規盤面でしか試さず**、旧盤面クラッシュ（`3d9d858`）とゲスト側の動作見落とし（P3c）を出している。以下は**必ず**やる。

1. **旧盤面の互換**: 今の localStorage（`pending` を知らない state）を残したまま起動して壊れないこと。**保存済み盤面を消してから始めない。**
2. **2タブ（ホスト=A / ゲスト=B）で、両方向を通す**:
   - ホストが手札のイベントを**ゴミ箱へドラッグ** → 両タブで「宣言中」に見える／ゲスト側に《イベントカードを使用するとき》の割り込み通知が出る（該当札を仕込んでおく）→ ゲストが割り込み宣言 → 入れ子で解決 → 親の解決でカードがゴミ箱へ着地。
   - **同じことをゲスト側が宣言する向きでもやる**（§6でゲストは結果 state しか受け取らない。ここが過去の落とし穴）。
3. **取り消し**: 解決ステップで「取り消し」を押すと手札に戻り、両タブで一致すること。
4. **キャラ召喚**: 手札のキャラを `char` スロットへドラッグ → 宣言 → 解決で**そのスロット（toIndex）に着地**すること。
5. **free モード**: 手札ドラッグが従来どおり即移動すること。宣言中に free へ切り替えるとカードが手札に戻ること。
6. **非回帰**: 盤面内のドラッグ移動 / 手札→デッキ / アイテム attach / 起動型トリガーボタン（P3a-2b）/ カード比 0.7159 / 1920×1080・1280×720でスクロール0 / レイアウトA・B両方 / コンソールエラー0。
7. `npx tsc --noEmit`・`npm run build`（core隔離チェック込み）・`npm run test:core-priority`・`npm run test:timing` が全緑。

⚠️ この環境では `preview_screenshot` / `computer` がタイムアウトする。`javascript_tool` での DOM 実測＋`MouseEvent` 直接発火で検証する（`IMPLEMENTATION-NOTES.md`）。dnd-kit の検証手法も同ファイルにある。

---

## 6. 完了条件

- [ ] 手札→場/ゴミ箱のドラッグが、アシストモードで**宣言**になる（即着地しない）
- [ ] 宣言中のカードが `pending` にあり、**両者から名前と詳細が見える**
- [ ] 解決で着地先へ着地／取り消しで手札に戻る（2タブ双方向で一致）
- [ ] 弾かれた宣言でカードが消えない・`free` 切替でカードが迷子にならない
- [ ] P3cの割り込み通知が**カードプレイに対して**鳴る（＝本フェーズの主目的）
- [ ] 上記テスト・非回帰・build 全緑
- [ ] `HANDOFF-P3a-3.md` を1枚書く（やったこと／判断した点／申し送り／検証の実測値）

## 7. 申し送りに必ず書くこと

- アイテムの `attach` 経由のプレイが宣言を経ないこと（スコープ外）
- `timing.ts` の `cardKindOf` は引数名が `cardId` だが実際には**インスタンスID (`sourceIid`) が渡っている**（`timing.ts:32`）。今回は触らないが、紛らわしいので気づいた事実として残す
- 実装中に「仕様が現物と食い違う」「設計判断が要る」と感じた点は**勝手に決めずここに書く**（統括が判断する）
