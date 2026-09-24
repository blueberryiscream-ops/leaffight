# HANDOFF-P5b — 対戦卓で「デッキで始める」（開始準備 10-1・マリガン 10-1-1）

担当: 実装サブエージェント。対象コミット親: 0f140e3（未コミット。統括が検証後にコミット）。

## やったこと（ファイルごと）

- **`src/core/board.ts`**: `SetupState` 型（63-67行目）・`BoardState.setup`（79行目）・`EMPTY_BOARD.setup`（85行目付近）・
  `cloneBoard` に `setup` を追加・`fillBoardDefaults`（96行目、旧保存盤面の補完を切り出し）・
  `startWithDeck`（455行目）・`mulligan`（547行目）・`revealLeader`（587行目）の3関数を追加。
- **`src/core/actions.ts`**: `BoardAction` に `startWithDeck`/`mulligan`/`revealLeader` の3型を追加、
  `applyActionCore` に3ケース追加（131-136行目）。
- **`src/ui/board/useBoard.ts`**: 旧保存盤面の読込を `{...EMPTY_BOARD, ...saved}` の直書きから
  `board.fillBoardDefaults(saved)` 呼び出しに変更（テスト可能にするため。PHASE5b.md §3の要求）。
- **`src/ui/board/DetailPanel.tsx`**: `hiddenFromMe` の条件に `!instance.faceUp` を足した（55行目）。
  手札だけでなく、裏向きの相手のカード全般（デッキで始めたときの裏向きリーダー等）を伏せる。
  HoverPreview 側は `CardPiece` が `instance.faceUp` をそのまま渡しているので、追加コード無しで既に伏せて描画される
  （faceUp=false → `CardFace` が裏面/「裏」表示を返す。既存の仕組みで足りていた）。
- **`src/data/deck.ts`**: `sampleHand` の中にあったシャッフルを `shuffle<T>(arr, rng)` として切り出し、
  `sampleHand` もそれを使う形にした（83行目）。
- **`src/ui/board/StartWithDeckDialog.tsx`（新規）**: 「デッキで始める」ダイアログ。`listDecks()` で一覧、
  `validateDeck(...).ok` でないデッキは押せない（理由を右側に表示・`title` にも）。選ぶと自分の盤面のカードが
  1枚でもあれば `confirm`、カードデータに無い cardId があれば dispatch せずエラー表示。60枚を組み立て
  （リーダー1枚 + 残り59枚を `shuffle(rest, Math.random)`）、`startWithDeck` を dispatch。
- **`src/ui/board/Board.tsx`**: 「デッキで始める」ボタン（盤面クリアの隣）。`startWithDeckBlocked`
  （バトル中／宣言中なら理由を title に）と `hasOwnCards` を計算し、ダイアログに渡す（298-306行目・675-682行目・808-816行目）。
- **`src/ui/board/TodoBand.tsx`**: 既存ロジックを `mainBand()` に切り出し、新設の `SetupBand`
  （`setup[localSeat]` があって `leaderRevealed` が false の間に出す。マリガン／リーダーを表にするボタン）を
  先頭でチェックするよう再構成。相手の開始準備の状態（`相手: 準備中（マリガン済み）` 等）は
  自分の状態に関わらず帯の下に常に薄く表示する `opponentStatus` として追加。
- **`scripts/test-setup.ts`（新規）**: `startWithDeck`/`mulligan`/`revealLeader`/`fillBoardDefaults` を
  偽のカード・偽のデッキで検証。31ケース全て成功。
- **`scripts/test-deck.ts`**: `shuffle` のテストを3件追加（3d〜3f。元配列を破壊しない／同じ要素集合／固定rngで同じ結果）。
- **`package.json`**: `test:setup` を追加し `test` に連結。

## 判断した点

1. **PHASE5b.md §1-2 の「相手のカードの attachedTo が消したカードを指していたら null にする」は、
   相手のカードが char/leader/battle/trash/field のどのゾーンにあっても対象にした。**
   仕様文には具体的なゾーンの指定が無かったため、DESIGN.md §4.14（attachedTo はキャラに重ねるカードの一般的な仕組み）
   に沿って、ゾーンを問わず「除去された iid を指す attachedTo」を全て null にする実装にした。
2. **TodoBand.tsx を大きめにリファクタリングした**（既存ロジックを `mainBand()` に切り出し）。
   理由: 「相手の開始準備の状態を帯の下に常に表示する」（§2-2）を、既存の10箇所近い早期 return
   全てに個別に手を入れずに実現するため、外側で1回だけラップする形にした。既存の `mainBand` 内部の
   分岐ロジック自体は一切変更していない（コピーそのまま）。
3. **`StartWithDeckDialog` はボタンごと新規ファイルにした**（`CardPicker.tsx` のような既存パターンを踏襲）。
   PHASE5b.md は置き場所を指定していなかったため、他のダイアログ（`modals.tsx`）と同じ中央モーダル型
   （`fixed inset-0 ... grid place-items-center`）にした。
4. **マリガン時の `confirm` の文言はPHASE5b.md本文に無いため独自に書いた**
   （「マリガンします（手札を公開してすべてデッキに戻し、シャッフルして7枚引き直します）。よろしいですか？」）。
   DrawModal 等の既存の文言トーンに合わせた。

## 自己点検（§1〜§3 要求を1行ずつ）

| # | 要求 | 実装した場所 | 確かめた方法 |
|---|---|---|---|
| §1-1 | `SetupState` 型・`BoardState.setup`（EMPTY_BOARDでは`{A:null,B:null}`） | `src/core/board.ts:63-85` | test:setup 6a・煙試験（setup読み取り） |
| §1-2 startWithDeck | battle/priority が non-null なら何もしない | `src/core/board.ts:465` | test:setup 3a・3b |
| §1-2 startWithDeck | owner の全ゾーンのカードが消える（共有field含む） | `src/core/board.ts:471-479` | test:setup 2a・2b・2c |
| §1-2 startWithDeck | 消したカードへの modifier が消える | `src/core/board.ts:480-484` | test:setup 2e |
| §1-2 startWithDeck | 相手のattachedToが消したカードを指していたらnull | `src/core/board.ts:479`（cards構築ループ内） | test:setup 2f |
| §1-2 startWithDeck | 相手のカードは1枚も変わらない | `src/core/board.ts:471-479`（owner一致分だけ触る） | test:setup 2d |
| §1-2 startWithDeck | リーダーは裏向き・**orientation=ready**（利用者確定） | `src/core/board.ts:488-498` | test:setup 1a・1b・1c・煙試験（IndexedDB実測） |
| §1-2 startWithDeck | リーダーの気力は渡した値 | 同上 | test:setup 1d・煙試験（kiryoku=10, 元5×2） |
| §1-2 startWithDeck | deckの並びどおり置く（index0=一番上） | `src/core/board.ts:501-528` | test:setup 1g |
| §1-2 startWithDeck | 上からdraw枚を手札へ（faceUp=true） | 同上 | test:setup 1f・1h |
| §1-2 startWithDeck | setup[owner]セット（mulliganUsed/leaderRevealed=false） | `src/core/board.ts:530-537` | test:setup 1系・煙試験（IndexedDB実測） |
| §1-2 startWithDeck | ログにリーダー名を出さない | `src/core/board.ts:539-543` | test:setup 1i・煙試験（ログ文字列に「相田響子」等含まれない目視） |
| §1-2 mulligan | setupがnull/mulliganUsed/leaderRevealedのどれかなら何もしない | `src/core/board.ts:551-552` | test:setup 4f・4g・4i |
| §1-2 mulligan | orderedIidsがhand∪deckとちょうど同じ集合でなければ何もしない | `src/core/board.ts:555-563` | test:setup 4h |
| §1-2 mulligan | 手札を全部デッキへ→並び替え→draw枚を手札へ | `src/core/board.ts:566-575` | test:setup 4a・4b・4c |
| §1-2 mulligan | ログに公開した手札名 | `src/core/board.ts:583` | test:setup 4e |
| §1-2 mulligan | 手札にキャラクターカードが無いかはcoreで判定しない | ui側（TodoBand.tsx）が判定・core は集合検証のみ | コードレビュー |
| §1-2 revealLeader | setupがnullかleaderRevealedなら何もしない | `src/core/board.ts:589` | test:setup 5d |
| §1-2 revealLeader | faceUp=true・leaderRevealed=true・ログにカード名 | `src/core/board.ts:593-599` | test:setup 5a・5b・5c |
| §1-2 | 3つともUndo/Redoの対象 | `applyAction`経由で`history.dispatch`に自然に乗る（他アクションと同じ仕組み・専用コード無し） | コードレビューのみ（**未確認**＝実クリックでのUndo/Redoは試していない） |
| §2-1 | 「デッキで始める」ボタン（盤面クリアの隣） | `src/ui/board/Board.tsx:673-682` | 煙試験（ボタン表示・クリックで開く） |
| §2-1 | デッキ一覧ダイアログ（名前・リーダー名・60/60✓・validateDeck.ok以外は選べない） | `src/ui/board/StartWithDeckDialog.tsx` | 煙試験（統括検証デッキ 60/60が選べる・クリックで開始準備が走る） |
| §2-1 | デッキが無ければ「デッキ画面で作ってください」 | `StartWithDeckDialog.tsx`（decks.length===0の分岐） | コードレビューのみ（**未確認**＝decks空の状態を作って試していない） |
| §2-1 | 自分の盤面にカードがあればconfirm | `Board.tsx:306`(hasOwnCards) / `StartWithDeckDialog.tsx`(handlePick) | コードレビューのみ（**未確認**＝2回目の「デッキで始める」でconfirmが出るかは試していない） |
| §2-1 | バトル中・宣言中はボタンを押せない（理由をtitleに） | `Board.tsx:298-305`(startWithDeckBlocked) | コードレビューのみ（**未確認**＝実際にバトル中にして確かめていない） |
| §2-1 | カードデータに無いcardIdがあればdispatchせずエラー表示 | `StartWithDeckDialog.tsx`(unknownIds) | コードレビューのみ（**未確認**） |
| §2-1 | `shuffle<T>`切り出し・`sampleHand`が流用・テスト1件足す | `src/data/deck.ts:83`・`scripts/test-deck.ts` 3d〜3f | test:deck 3d・3e・3f |
| §2-1 | ゲストも同じ手順（自分のIndexedDBから作ってホストへ送る） | 既存の`dispatch`経路をそのまま使う（専用コード無し・useBoard.tsのguest分岐が自動的に効く） | コードレビューのみ（**未確認**＝2タブ検証は統括の担当） |
| §2-2 | 「今やること」帯に開始準備の案内文 | `src/ui/board/TodoBand.tsx:75`(SetupBand内) | 煙試験（帯の文言表示を確認） |
| §2-2 | 「マリガン」ボタン（押せるのは!mulliganUsedかつ手札のkind==='c'が0枚のときだけ・押せない理由はtitle） | `TodoBand.tsx:44-60`(canMulligan/mulliganTitle)・85行目(ボタン) | 煙試験（キャラを含む手札でdisabled=true・titleが理由文言と一致） |
| §2-2 | マリガン押下時confirm→シャッフル→mulligan dispatch（revealedNames=手札名） | `TodoBand.tsx:65-70` | コードレビューのみ（**未確認**＝実クリックは手札にキャラ0枚の状態を作れず未試行。ツール回数超過を避けるため） |
| §2-2 | 「リーダーを表にする」ボタン | `TodoBand.tsx:90-96` | 煙試験（クリックでfaceUp=true・帯が消えることを確認） |
| §2-2 | 相手の開始準備の状態を表示 | `TodoBand.tsx:112-119`(opponentStatus) | コードレビューのみ（**未確認**＝2タブ検証は統括の担当。ソロでは相手側setupが常にnullなので表示されない） |
| §2-3 | `DetailPanel.tsx`の`hiddenFromMe`に裏向き相手カードを追加 | `src/ui/board/DetailPanel.tsx:55` | コードレビューのみ（**未確認**＝自分の視点だけの検証環境のため、相手視点での確認は統括の2タブ検証待ち） |
| §2-3 | HoverPreviewも同じく裏向き相手カードは表を出さない | 変更不要（`CardPiece`が渡す`faceUp`が既に`instance.faceUp`そのものなので既存の仕組みで足りていた） | コードレビュー（CardFace.tsxのfaceUp分岐を確認） |
| §2-3 | 盤面のCardPieceはfaceUpで裏面を描く（裏向きリーダーで確かめる） | 変更なし（既存実装） | 煙試験（IndexedDBでリーダーfaceUp=falseを確認。DOM上の見た目は未実測＝目視のスクリーンショットは指示により撮っていない） |
| §3 | test-setup.ts 全項目 | `scripts/test-setup.ts` | `npm run test:setup` 緑（31ケース全成功） |
| 守ること | coreに乱数・時刻・カード種別の知識を持ち込まない | `startWithDeck`/`mulligan`は渡された並び・集合だけを見る。乱数はui（`StartWithDeckDialog.tsx`・`TodoBand.tsx`）で消費 | コードレビュー・`npm run build`のcore-isolationチェック緑 |
| 守ること | 盤面ロックを作らない | 新規フィールドはsetup情報のみ。既存のドラッグ・クリック操作を塞ぐコードは追加していない | コードレビュー |
| 守ること | localSeatをBoardStateに入れない | 変更していない（Board.tsxのlocalSeatはuseBoard.tsのローカルstateのまま） | コードレビュー |
| 守ること | 永続状態にフィールドを足したら旧保存盤面を既定値で補完 | `fillBoardDefaults`（board.ts:96）・`useBoard.ts`で使用 | test:setup 6a |
| 守ること | 色は@themeトークンのみ | 新規ファイル（StartWithDeckDialog.tsx・TodoBand.tsx追加分）はlf-panel/lf-btn-primary等の既存クラスのみ使用 | grep実測（下記） |
| 守ること | デッキの中身・順番は共有状態（暗号化しない） | `startWithDeck`のdeck配列はBoardStateのcardsにそのまま入る（既存のデッキ実装と同じ） | コードレビュー |

## grep実測: パレット色の直書き

```
$ grep -nE "#[0-9a-fA-F]{3,8}" src/ui/board/StartWithDeckDialog.tsx src/ui/board/TodoBand.tsx src/core/board.ts src/core/actions.ts src/data/deck.ts
（出力なし＝0件）
```

## `npm run verify` の結果

`npm run build`（core-isolation → tsc → vite build）緑。`npm run test` は既存7スイート＋新規`test:setup`の計8スイート、
すべて成功。**出力を数え直し済み**: `✅` 341件・`❌` 0件（`grep -c` で実測）。exit code 0。

## 煙試験の結果（§7）

開発サーバーは `preview_start {name:"leaffight-dev"}` が「見つからない」エラーを返したため
（IMPLEMENTATION-NOTES.md記載の既知の制約）、既に起動していた `npm run dev`（ポート5300）へ`navigate`で接続した。

1. コンソールエラー無し（`read_console_messages`で2回確認）。
2. 既存IndexedDBに「統括検証デッキ」（60/60 ✓・リーダー相田響子）があることをIndexedDB直読みで確認（新規作成不要だった）。
3. 「デッキで始める」→ダイアログでデッキ名・リーダー名・60/60✓が表示 → クリックで開始準備が実行され、
   ログに「「統括検証デッキ」で開始準備（リーダーを裏向きで置き・59枚シャッフル・7枚ドロー）」と表示（リーダー名は含まれない）。
   IndexedDB実測: `byZone = {deck:52, hand:7, leader:1}`、leaderは`faceUp:false・orientation:'ready'・kiryoku:10`（元5×2）。
4. マリガンボタン: 押した直後の手札にキャラクターカード（kind='c'）が含まれていたため`disabled:true`、
   `title:"手札にキャラクターカードがあるためマリガンできません"`（判定ロジックと一致）。
   **手札にキャラクターカードが0枚のケース（押せる状態）は、乱数の結果を制御できずツール回数の都合で作れなかった＝未確認**。
5. 「リーダーを表にする」をクリック → IndexedDB実測でリーダーの`faceUp:true`・`setup.A.leaderRevealed:true`を確認。
   帯（「開始準備:…」）がその後消えることも `body.innerText` で確認。

スクリーンショットは撮っていない（指示どおり `javascript_tool`/IndexedDB直読みのみ）。2タブ検証（相手に伏せて見えるか等）は
**統括がやる**ので行っていない。

**ブラウザのツール呼び出し回数**: 15回（`preview_start`失敗1・`navigate`1・`javascript_tool`9・`read_console_messages`2・`find`1・`computer`失敗1）。
40回以内に収まった。手順としては§7の5項目すべて実施（10手順以内）。

## 未実装・未確認の項目（まとめ）

- Undo/Redoで3アクション（startWithDeck/mulligan/revealLeader）が実クリックで正しく戻るかの実機確認。
- 「デッキが無い」「盤面にカードがあってconfirmが出る」「カードデータに無いcardId」「バトル中はボタンを押せない」の
  4つの分岐は、コードレビューのみで実クリック未確認（ツール回数節約のため、最短経路の煙試験だけ実施）。
- マリガンボタンが「押せる」状態（手札にキャラクターカードが0枚）の実クリック確認。
- ゲストからの「デッキで始める」・相手の開始準備状態表示（opponentStatus）の2タブ確認は統括の担当。
- DetailPanel/HoverPreviewの「相手視点で裏向きリーダーが伏せられる」確認は2タブが必要なため統括待ち。

## 申し送り

- `SetupState`/`setup`フィールドはDESIGN.md §4.21の記述通り。今後P4（ターン進行）で「先攻後攻」を実装する際、
  ここには手を入れていない（§4「やらないこと」通り、じゃんけん等の先攻後攻決定は対象外のまま）。
- `TodoBand.tsx`の`mainBand`は既存ロジックをそのまま切り出しただけで中身は変更していない。次に手を入れる時は
  `SetupBand`とその上の`TodoBand`本体（opponentStatusの合成）だけを見れば良い。

## 🚨 コミットしていません（統括が検証してからコミットしてください）

---

## 統括8の検証（2026-09-24）

- `npm run verify` 緑（統括が数え直して ✅341・❌0）
- **2タブ（testplay host/guest）で確かめたこと**:
  - ホストが「デッキで始める」→ 盤面にカードがあるので確認ダイアログ → ログ「「統括検証デッキ」で開始準備（…）」。リーダー名はどちらの画面にも出ない
  - ゲストの画面: ホストのリーダーと手札は裏面の画像（alt「裏面」）。クリックしても詳細に中身が出ない。帯に「相手: 準備中」→ マリガン後は「相手: 準備中（マリガン済み）」→ 表にした後は「相手: 準備完了」
  - マリガンが押せる状態: キャラクター1枚（リーダー）＋タッグ12枚＋イベント47枚の検証用デッキを IndexedDB に一時的に作って確認（検証後に削除）。手札にキャラクターカードが無いと押せる → 確認 → ログ「マリガン: 手札を公開 [7枚の名前]」→ 2回目は押せない（title「マリガンは1回だけ」）
  - キャラクター入りの手札ではマリガンを押せない（title に理由）。ゲストの「デッキで始める」もホストに届き、ホストの画面では伏せて見える
  - 「リーダーを表にする」→ ログ「リーダーを表にした: 相田響子」、ゲストの画面にもリーダーの表が出る
  - 新しいタブでコンソールのエラーは0件（統括が `useBoard` を書き換えたときの HMR で出たフック順エラーは、読み込み直した後は出ない）
- **統括が直した2点**:
  1. 🚨 **ゲストにログが一切出ていなかった（P2 からある不具合）**。ゲストは `past` を持たず、ログは `past` から作るため。ホストが `state`/`sync` にログを載せて送り（`NetMessage.log?`）、ゲストはそれを表示するようにした（`src/net/session.ts`・`useBoard.ts`）。これが無いと、ホストのマリガンの手札公開（10-1-1[1]）がゲストに届かない。2タブで両方向に届くことを確認済み
  2. 裏向きのリーダーをクリックすると、詳細に「相手の手札（伏せ）」と出ていた → 手札以外は「相手の裏向きのカード」に（`DetailPanel.tsx`）
- 未確認のまま残るもの: Undo/Redo の実クリック、デッキ0件の表示、カードデータに無い cardId、バトル中のボタン無効化（コードレビューのみ）
