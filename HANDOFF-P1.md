# P1 引き継ぎメモ — ローカル盤面

実施: 2026-07-13 / 作業セッション（P0を担当したセッションを継続。Sonnetに切替。PHASE1.md §発行 の指示どおり）
宛先: 統括セッション

---

## 0. 完了状況

| # | 完了条件 | 状態 |
|---|---|---|
| 1 | §4.13のレイアウトで両プレイヤーの盤面が表示される | ✅（構造は再現。180°回転は簡略化。§4参照） |
| 2 | プールのカードを任意のゾーンに置ける | ✅ カードピッカーから 自分/相手 × デッキ/手札/リーダー へ投入可 |
| 3 | ドラッグでゾーン間移動・並べ替え。固定スロット | ✅ dnd-kit実装。実ブラウザのマウスイベントで検証済み |
| 4 | 待機↔消耗／気力±／能力値修正／表↔裏／ゴミ箱送り | ✅ 全て実機で動作確認 |
| 5 | 操作ログ・Undo/Redo | ✅ |
| 6 | 1人で両陣営を自由に操作できる | ✅（対称に実装。ロックなし） |

スコープ外（通信・ターン進行・コストプール・ダウン自動処理・勝敗判定・場の制限強制・デッキ構築・見た目の作り込み）には手を付けていない。

---

## 1. `core/` に置いた状態・reducer

| ファイル | 内容 |
|---|---|
| `src/core/board.ts` | `CardInstance` `Modifier` `BoardState` 型、`SLOT_CAPACITY`、`spawnCard` `moveCard` `setOrientation` `toggleOrientation` `setKiryoku` `adjustKiryoku` `setFaceUp` `flip` `addModifier` `removeModifier` `clearModifiers` `attach` `detach` `toTrash` `removeCard` `shuffleDeck` `clearBoard`（すべて純関数 `(state, args) => {state, log}`） |
| `src/core/actions.ts` | `BoardAction` 判別共用体 + `applyAction(state, action)` ディスパッチャ。**P2でネット越しに送る単位もこれになる想定**（DESIGN.md §6） |
| `src/core/history.ts` | Undo/Redo。`past`/`future` はスナップショット配列（各要素が `{state, log}` のペア）。Redoしてもログが正しく復活する設計 |

**`ui/` との境界**: `ui/board/useBoard.ts` が唯一の橋渡し。`History` を `useState` で持ち、`dispatch(action)` は `core/history.dispatch` を呼ぶだけ。`iid`/`Modifier.id` は **`ui/` 側で `crypto.randomUUID()` を生成**して action に積む（core は乱数を一切生成しない。DESIGN.md §6地雷どおり）。シャッフルも同様に `ui/board/Board.tsx` の `handleShuffle` が `Math.random()` でFisher–Yatesを行い、**結果の並び（iid配列）だけ**を `shuffleDeck` action に渡す。`core/` は並びを適用するだけ。

`check-core-isolation.mjs` は今回も通過（`core/board.ts` `core/actions.ts` `core/history.ts` はいずれも外部パッケージ・`ui/`/`data/`/`net/` を import していない）。

---

## 2. Undo/Redoの実装

PHASE1.md §2.4の「past/future配列」を素直に実装したが、素直にやると**Redoでログ行が失われる**バグを最初に作り込んだ（`past: BoardState[]` と `log: LogEntry[]` を別配列で持つ設計だと、Undoでlogをpopしてもそれをfuture側に退避する場所が無い）。

**修正**: `past`/`future` の要素を `{state, log}` のペアにした。
```ts
interface Snapshot { state: BoardState; log: LogEntry }
interface History { present: BoardState; past: Snapshot[]; future: Snapshot[] }
```
`past[i].state` = そのアクションを実行する**前**の状態、`past[i].log` = そのアクションのログ。Undoは最後のpastを取り出してpresentに戻し、`{state: 旧present, log: 同じログ}` をfutureの先頭に積む。Redoはその逆。これでUndo→Redoを何度往復してもログが正確に再現される（実機で確認済み。§4参照）。

**P2との整合**: `BoardState` は `Record<string,CardInstance>` と `Record<string,Modifier>` だけの素データ（クラスなし・関数なし）なので、構造化クローンでそのままIndexedDBに保存でき、将来JSON化してネットワーク越しに送るのも問題ない。**Undo履歴そのもの（`past`/`future`）は永続化していない**（IndexedDBに保存するのは `present` のみ）。P2でホスト権威にするとき、`past/future` はクライアントローカルの「自分の巻き戻し」用途に留め、ネットワーク同期の対象は `present`（＝ `BoardState`）だけにするのが素直だと思う。

---

## 3. §4.13レイアウトの再現度

**構造は再現、見た目の180°回転は簡略化した。**

再現したもの:
- 中央（相手との境界）から自陣の端へ向かう順序: `[前線: バトル×3 + フィールド]` → `[キャラ段×5]` → `[最後列: ゴミ箱/リーダー/デッキ]` → `[手札]`
- 相手を上・自分を下に配置し、**行の並び順を逆転**させることで「相手陣が上」を表現（`PlayerBoard.tsx` の `reversed` prop）
- フィールド系ゾーンは固定スロット（`SLOT_CAPACITY = {leader:1, char:5, battle:3, field:1}`）。ドラッグで好きなスロットへ。**占有スロットへドラッグすると、既存カードと入れ替わる**（`moveCard` の実装。実物マットでの「入れ替え」に相当）
- デッキ/手札/ゴミ箱は固定スロットでなく束・横帯（`ZoneBundle.tsx`）

簡略化した点（**要判断・統括に確認したい**):
- 「相手陣を180°回転」を**個々のカードのCSS回転としては実装していない**。行の順序を逆にするだけで、カード自体は自分陣と同じ向きで描画される。理由: 消耗状態の90°回転（実装済み）と重ね合わせると回転の合成が絡み、P1の時間対効果に見合わないと判断した。見た目の作り込みはP5と明記されているため、**構造的な位置関係（どこに何があるか）を優先し、視覚的な180°回転は持ち越した**。
- 手札の「自分は表・相手は伏せて枚数のみ」は**実装していない**。P1は同一ユーザーが両陣営を操作するため、両陣営とも同じ見た目（`faceUp` フィールドに従う。既定は手札に置いた瞬間 `faceUp:true`）にした。`faceUp` はカード単位で持っているので、P2で「相手の手札は常に伏せる」という**表示側のルール**を足すのは実装済みのデータモデルの上に乗るだけで済む（`CardInstance.faceUp` は既にある。P2では「相手の手札は所有者以外には常にfaceUp=falseとして描画する」という描画ルールを足せばよい）。
- フィールドカードは§4.13では「両軍で1枚を共有」だが、P1では**プレイヤーごとに1スロット**にした（`field` ゾーンは owner スコープ）。場の制限の強制はP3スコープなので、これで問題ないはず。

---

## 4. 検証結果（実機、証拠つき）

`preview_start` で `leaffight-dev`（ポート5300）を起動。**前回（P0）と同じく `preview_screenshot`/`computer` ツールは常にタイムアウトした**ため、`javascript_tool` で本物のDOMイベント（`MouseEvent` の `mousedown`→`mousemove`→`mouseup` を dnd-kit の `MouseSensor` に直接投げる）を使い、実際のドラッグ&ドロップを発火させて検証した。コンソールはセッション通してエラー・警告ゼロ。

| 項目 | 結果 |
|---|---|
| デッキ→手札→キャラ段へドラッグ | ✅ 実際に `mousedown/mousemove/mouseup` を発火させて確認。各ステップでゾーンの枚数・カードの移動を確認 |
| 消耗（90°回転）↔戻す | ✅ `getComputedStyle().transform` が `matrix(0,1,-1,0,0,0)`（=90°）↔ `matrix(1,0,0,1,0,0)`（=0°）で切り替わることを確認 |
| 気力の増減・上限クランプ | ✅ 初期化(5)→ -5→0 → +1→1 → +5+5(連打)→**5でクランプ**（上限超過が無視される。DESIGN.md §4.6どおり） |
| 残り気力⇄ダメージ表示切替 | ✅ 残り3/5 ⇄ ダメージ2/5（5-3）で相互変換を確認 |
| 能力値修正の追加・表示 | ✅ 「鬼のちから 力+2」を追加→カード上に `力+2` チップが即座に表示、コントロールパネルの一覧にも反映 |
| ゴミ箱送り→Undoで戻る→Redoで再度ゴミ箱 | ✅ 気力・修正の値もろとも正確に往復（スナップショット方式の実証） |
| リロードで盤面が復元する | ✅ ページリロード後、ゴミ箱の中身（気力・修正込み）がそのまま復元 |
| 盤面クリア | ✅ ボタン→confirm→IndexedDBの`board`テーブルが空になることを直接確認 |
| P0のカード一覧タブとの共存 | ✅ タブ切替で状態が壊れないことを確認（422種一覧は健在） |

途中で見つけて直したバグ: 気力の「残り⇄ダメージ」切替ボタンの**ラベルが現在のモードを表示していて、押した後どうなるかが分からなかった**（例えば「残り気力表示」と書いてあるのに実際は既にダメージ表示中、のような食い違い）。`表示: 残り気力（切替）` のように「現在のモード＋切替であること」を明示する表記に直した。

**DOM検証用に `data-dropid`（ゾーン/スロット）・`data-iid`・`data-orientation`（カード）属性を追加した。** 機能には影響しないが、今後の自動検証やデバッグに使える。

---

## 5. ハマった点

### 5.1 Undo/Redoでログが消える設計ミス（§2で既述）
`past: BoardState[]` と `log` を別配列で持つと、Undo時にpopしたログをfuture側に退避する場所が無く、Redoで元に戻せない。`{state, log}` のペア配列に直して解決。**実装前に気づけた**（コードを書きながら気づき、書き直した。実機で往復させて壊れていないことを確認済み）。

### 5.2 気力表示トグルのラベルバグ
§4参照。テスト中に「ボタンを押しても意図と逆の状態になる」ように見えて混乱し、コードを読み直して発見した（現在のモードを書いていて、遷移先を書いていなかった）。**UIのラベルは「押すとどうなるか」を書くべきで「今何か」を書くべきではない**、という一般的な教訓。

### 5.3 dnd-kitのドラッグを自動検証する方法
`preview_screenshot`/`computer` がP0同様タイムアウトするため、視覚的な確認ができない。**`MouseEvent` を `document` に直接 `dispatchEvent` することで、dnd-kitの `MouseSensor`（内部で `document.addEventListener` を使っている）を実際に起動できる**と分かった。React合成イベント経由ではなくネイティブイベントとして発火させるのがポイント（`el.dispatchEvent(new MouseEvent(...))` はReactのイベントデリゲーションを正しく通る）。座標は `getBoundingClientRect()` から実座標を計算し、`mousedown`→(6px以上動かす`mousemove`。`activationConstraint:{distance:6}`のため)→ターン上への`mousemove`→`mouseup` の順で発火させると、実際のドロップと同じ `onDragEnd` が呼ばれる。今後のP2/P3検証でも同じ手法が使えるはず。

### 5.4 気力・能力値の初期値
- `CardInstance.kiryoku` は `spawnCard` 時点では常に `null`（DESIGN.md §2.1の「P1ではユーザーが手で設定できれば十分」に従った）。コントロールパネルに「気力を初期値（N）にする」ボタンを用意し、`card.kiryoku`（リーダーなら×2。DESIGN.md §4.3）をユーザーが明示的にセットする形にした。**自動セットはしていない**（zoneに応じた自動初期化は今後の判断次第。P1では「置いたら手動で初期化」という運用で十分だった）。
- 能力値修正のクイック操作（±1ボタンのようなもの）は**あえて作らなかった**。DESIGN.md §4.16の Modifier は「出所」を必須で持つ設計思想なので、出所テキストを書かせるフォームのみにした。無名の「+1」を連打できてしまうと、封印などで個別に消せるという設計の利点が薄れると判断した。

---

## 6. P2に渡す申し送り

- **`core/actions.ts` の `BoardAction` がそのままネットワークで送るメッセージの候補**。DESIGN.md §6が要求する「順序つき・応答つき」は、P2で `BoardAction` に連番/IDを足すか、ラッパー型（`{seq: number, action: BoardAction}`）で包む形になると思う。`iid`/`Modifier.id` は既に呼び出し側（送信側）が生成する設計なので、ホスト/ゲストのどちらが打っても衝突しない（`crypto.randomUUID()`）。
- **`BoardState` は素データなのでそのままJSON化してブロードキャストできる**。DESIGN.md §6の「stateを丸ごとブロードキャスト」を素直に実装できるはず。
- **P1では「手番ロック」の概念を一切持ち込んでいない**（`Player`型はただのタグで、どちらの盤面も同じ人が自由に触れる）。PHASE1.md §0の禁止事項（ターン起因のロックを作らない）どおり。P2/P3で優先権システム（DESIGN.md §5.1）を足すときも、この「誰でも触れる」土台はそのまま活きるはず。
- **手札の表裏の非対称表示（自分=表、相手=伏せ）はP1では実装していない**（§3で既述）。`CardInstance.faceUp` は既にあるので、P2で「相手の手札は所有者以外には常に伏せて描画する」という**描画側のルール**を足すだけで済むはず。ネットワーク越しに相手の手札の中身を送るかどうか（ホストが伏せ札のまま送るか、中身ごと送って描画だけ隠すか）はP2で判断が必要。
- **`ui/board/useBoard.ts` の永続化は `present` のみ**。Undo履歴はリロードで失われる（意図的な割り切り）。P2でリロード後も相手と状態がズレないためには、そもそもホストが正を持つのでこの割り切りは問題にならないはず。

---

## 7. 触ったファイル

```
leaffight/
  package.json                        @dnd-kit/core, @dnd-kit/utilities を追加
  src/core/board.ts                   新規
  src/core/actions.ts                 新規
  src/core/history.ts                 新規
  src/data/db.ts                      board テーブルを追加（version 2）。clearBundle が board も消すよう変更
  src/ui/App.tsx                      対戦卓/カード一覧のタブ切替を追加
  src/ui/CardList.tsx                 高さ・スクロールをタブ内に収まるよう調整
  src/ui/board/useBoard.ts            新規（History のReactラッパー、IndexedDB自動保存）
  src/ui/board/Board.tsx              新規（トップレベル。DndContext、レイアウト組み立て）
  src/ui/board/PlayerBoard.tsx        新規（1人分の盤面レイアウト）
  src/ui/board/DroppableSlot.tsx      新規（固定スロット1マス）
  src/ui/board/ZoneBundle.tsx         新規（デッキ/手札/ゴミ箱の束）
  src/ui/board/CardPiece.tsx          新規（盤面上のカード1枚）
  src/ui/board/CardControls.tsx       新規（クリックで開く操作パネル）
  src/ui/board/CardPicker.tsx         新規（カード追加ピッカー）
  src/ui/board/LogPanel.tsx           新規（ログ・Undo/Redo・盤面クリア）
```
