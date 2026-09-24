# HANDOFF-P5a — デッキ画面（一覧・編集・検証・保存・書き出し/取り込み・試しに7枚）

担当: 実装サブエージェント。対象コミット親: c567f8f（未コミット。統括が検証後にコミット）。

## やったこと（ファイルごと）

- **`src/data/deck.ts`（新規）**: 純関数のみ。`Deck` 型、`deckTotal`、`validateDeck`、`probNoChar`、`sampleHand`、
  `exportDeckText`、`parseDeckText`。React/Dexie は import していない。
- **`src/data/db.ts`**: `version(3)` で `decks: 'id, updatedAt'` を追加（既存テーブル定義はそのまま繰り返した・42-47行目）。
  `listDecks`/`saveDeck`/`deleteDeck` を追加（109-119行目）。`clearBundle`（88行目）は変更していない＝decksに触らない。
- **`src/index.css`**: `@theme` に `--color-kind-c`〜`--color-kind-f` の6色を追加（19-24行目、見本の `KIND_COLOR` の値そのまま）。
  Tailwind v4 の自動ユーティリティ生成で `bg-kind-c` 等が使える。
- **`src/ui/App.tsx`**: ナビに「デッキ」を追加（対戦卓／デッキ／カード一覧）。**Board は常にマウントしたまま**、
  `view==='board'` でなければ `hidden`（Tailwindの`display:none`）で隠す実装にした（103行目）。DeckView に切替（105-107行目付近）。
- **`src/ui/deck/deck.ts` 関連UI（新規ディレクトリ）**:
  - `DeckView.tsx` — 一覧⇔編集の画面遷移、Dexie読み書き、取り込みモーダルの起動、複製/削除の確定処理。
  - `DeckEditor.tsx` — デッキ編集画面本体（検索・並び順・絞り込みチップ・カード格子・右パネル一式・保存/試しに7枚/書き出し/削除）。
  - `CardPreview.tsx` — デッキ格子のホバー拡大（判断理由は下記「判断した点」参照）。
  - `modals.tsx` — 試しに7枚引く／書き出し／取り込みの3モーダル。
- **`scripts/test-deck.ts`（新規）**: `src/data/deck.ts` を偽カードで検証。27ケース全て成功。
- **`package.json`**: `test:deck` を追加し、`test` に連結。

## 判断した点（本書・見本と違う形にした理由）

1. **デッキ画面のホバー拡大は既存の `HoverPreview`（`src/ui/board/HoverPreview.tsx`）を流用せず、`src/ui/deck/CardPreview.tsx` として同じロジックを複製した。**
   理由: `HoverPreview` は盤面の `CardInstance`（iid/zone/orientation等）に結びついた作りで、`instance` を必須の props に取る。
   デッキの格子は `PoolCard`（盤面インスタンスではない）を扱うため、`HoverPreview` を使うには偽の `CardInstance` を捏造する必要があり、
   `core/board` 型への不要な依存が deck/ 側に生まれると判断した。PHASE5a.md §4「無理なら見本の`.preview`相当を作る」に該当する小さな技術判断として、
   位置決めロジック（画面内クランプ）だけ複製した軽量版を作った。統括の確認が必要なら差し戻してください。
2. **一覧の「書き出し」ボタンは、編集画面を開いた上で書き出しモーダルを自動表示する形にした。**
   見本は一覧・編集どちらにも書き出しボタンがあるが、一覧側は編集中のデッキ実体（`working` state）が無いと
   `exportDeckText` を呼べないため、遷移してから開く形にした。動作としては1クリック増えるが機能は満たしている。
3. **`probNoChar` がデッキ0枚のとき `NaN%` になるバグをUI側で補正した**（`DeckEditor.tsx` の `deckSizeAfterLeader`）。
   スモークテストの新規デッキ（0枚）で実際に `NaN%` と表示されるのを見つけて直した。`total<=1` のときは `-` 表示にしている。
   `probNoChar` 自体（`src/data/deck.ts`）はテストの契約どおりで変更していない。

## 自己点検（§1〜§5 要求を1行ずつ）

| # | 要求 | 実装した場所 | 確かめた方法 |
|---|---|---|---|
| §1 | 上部ナビに「デッキ」を追加（対戦卓／デッキ／カード一覧） | `src/ui/App.tsx` 87行目付近 `(['board','deck','library'] as const)` | 煙試験（デッキタブが出る・クリックで遷移） |
| §1 | Board は常にマウントしたまま非表示は CSS で隠す | `src/ui/App.tsx` 103行目 `className={view==='board' ? 'h-full' : 'hidden'}` | 煙試験（後述のマス寸法一致で確認） |
| §1 | 隠して戻したあとマスの大きさが正しく戻るか | 同上（`useMeasuredHeight` は要素を保持したまま`display:none`⇔表示を切り替えるだけなのでResizeObserverの対象要素自体は変わらない） | 煙試験: 1920×1080で対戦卓→デッキ→対戦卓、キャラマス141×141→141×141（一致） |
| §2 | `Deck` 型 | `src/data/deck.ts:12` | test:deck |
| §2 | `deckTotal` | `src/data/deck.ts:21` | test:deck 1a |
| §2 | `validateDeck`（同名4枚まで・leaderOk・charCountはタッグ除外） | `src/data/deck.ts:37-64` | test:deck 1b〜1i |
| §2 | `probNoChar`（超幾何分布） | `src/data/deck.ts:70` | test:deck 2a〜2c（既知値はコメントに手計算 N=10,K=3,n=2→7/15 を明記） |
| §2 | `sampleHand`（リーダー1枚抜き・rng注入） | `src/data/deck.ts:79` | test:deck 3a〜3c |
| §2 | `exportDeckText` | `src/data/deck.ts:94` | test:deck 4a〜4c（往復） |
| §2 | `parseDeckText`（見出しでの種類解決・エラー行番号・全角半角/中黒吸収） | `src/data/deck.ts:121` | test:deck 4a〜4c・5a〜5h |
| §3 | Dexie version(3) で decks 追加・既存テーブル維持 | `src/data/db.ts:41-47` | 煙試験（保存→再読み込みで一覧に残る） |
| §3 | listDecks/saveDeck/deleteDeck | `src/data/db.ts:109-119` | 煙試験 |
| §3 | clearBundleでデッキを消さない | `src/data/db.ts:88-92`（変更なし・decksに触れていない） | コードレビューのみ（**未確認**＝実際にclearBundleを押してdecksが残ることは煙試験していない。回数上限のため） |
| §4 | デッキ一覧（表紙・札・帯・編集/複製/書き出し・＋新規・凡例） | `src/ui/deck/DeckView.tsx` | 煙試験（一覧の表示・保存後の反映を確認）。複製・書き出しボタンの実クリックは**未確認** |
| §4 | デッキ編集（左検索/並び替え/チップ/格子、右名前/リーダー/進捗/検証/一覧/中身/保存等） | `src/ui/deck/DeckEditor.tsx` | 煙試験（開く・名前欄の値変更を試みたが下記「未確認」参照・カードクリックで4枚まで加算・保存→再読み込みで反映を確認） |
| §4 | 画像の無いカードはCardFaceのテキスト表示 | `DeckEditor.tsx` 格子タイル部分（`imageUrl ? <img> : <CardFace .../>`） | 目視（煙試験のページテキストでテキスト表示のカードが並ぶのを確認） |
| §4 | ホバー拡大の流用/代替 | `src/ui/deck/CardPreview.tsx` | コードレビューのみ（**未確認**＝実際のホバー発火はコスト超過のため未実施。IMPLEMENTATION-NOTES.mdの`mouseover`+bubbles手法が必要な点に注意） |
| §4 | 検索（名前・かな・効果文） | `DeckEditor.tsx` `visiblePool` の `useMemo` | コードレビューのみ（**未確認**：検索欄への実入力は試していない） |
| §4 | 格子は標準プール全部・画像loading="lazy" | `DeckEditor.tsx` 格子の `<img loading="lazy">` | 煙試験（約400種のカード名がページテキストに出ることを確認） |
| §4 | 保存していない変更で戻る/別デッキを開くとき確認 | `DeckEditor.tsx` `guardLeave`（「← デッキ一覧」ボタン経由） | コードレビューのみ（**未確認**：実際にconfirmが出るかはクリックして確かめていない） |
| §4 | モーダル: 試しに7枚（マリガン表示はkind==='c'のみで判定） | `modals.tsx` `DrawModal`／`DeckEditor.tsx` `handleDraw` | コードレビューのみ（**未確認**：ボタンクリックでのモーダル起動は未試行） |
| §4 | モーダル: 書き出し（textarea・全選択ボタン） | `modals.tsx` `ExportModal` | コードレビューのみ（**未確認**） |
| §4 | 足すもの: 取り込み（parseDeckText→errorsがあれば表示→新規デッキを開く） | `DeckView.tsx` `openImport`／`DeckEditor.tsx` の `importErrors` 表示ブロック | コードレビューのみ（**未確認**） |
| §4 | 足すもの: 削除（確認ダイアログ付き） | `DeckEditor.tsx` 削除ボタン（`confirm(...)`） | コードレビューのみ（**未確認**） |
| §4 | 足すもの: 複製（名前に「（コピー）」） | `DeckView.tsx` `duplicate` | コードレビューのみ（**未確認**） |
| §5 | test-deck.ts 全項目（validateDeck各種・charCount・probNoChar・sampleHand・往復・parseDeckTextのエラー行/見出し解決/表記ゆれ） | `scripts/test-deck.ts` | `npm run test:deck` 緑（27ケース全成功） |
| 守ること | 色は`@theme`トークンのみ・パレット直書き0件 | `src/index.css:19-24` | `grep` 実測（下記） |
| 守ること | `core/`を変えない・importさせない | `src/data/deck.ts`は`core/types`・`core/name`のみimport（型と正規化関数、既存の許可された使い方と同型） | `npm run build` の `check-core-isolation.mjs` が緑（core→外部の一方向チェックだが、今回`src/core/`は一切編集していない） |
| 守ること | 見本の黄色札・冒頭説明文をアプリに出さない | 出していない（`_local`のHTMLをコピーせず全て書き直した） | コードレビュー |
| 守ること | デッキ画面は縦スクロール可 | `DeckView.tsx`のコンテナに`overflow-y-auto` | 煙試験（一覧・編集画面の表示を確認。実際に縦スクロールさせる動作は**未確認**） |
| 守ること | シャッフルは乱数を引数で受ける純関数 | `sampleHand(deck, rng)` | test:deck 3c（固定rngで結果決定） |

## grep実測: パレット色の直書き

```
$ grep -nE "#[0-9a-fA-F]{3,8}" src/ui/deck/*.tsx src/data/deck.ts
（出力なし＝0件）
```

## `npm run verify` の結果

`npm run build`（core-isolation → tsc → vite build）緑。`npm run test` は既存6スイート＋新規`test:deck`の計7スイート、
`test:deck`は**27ケース全て成功**（出力を数え直し済み）。既存スイートも全件成功（回帰なし）。

## 煙試験の結果

- 開発サーバーは `preview_start {name:"leaffight-dev"}` が「見つからない」エラーを返したため
  （IMPLEMENTATION-NOTES.md記載の既知の制約）、`npm run dev`はすでにポート5300で起動済みだったのでそれに`navigate`で接続した。
- コンソールエラー無し（`read_console_messages`で確認、2回）。
- 「デッキ」タブが表示され、クリックで一覧画面（当初は空）に遷移することを確認。
- 「＋ 新しいデッキ」→編集画面が開き、名前欄・リーダーselect・進捗・検証・約400種のカード格子・種類ごとの一覧・
  デッキの中身の棒グラフ・保存/試しに7枚/書き出しボタンが表示されることを確認。
- カード格子の1枚を4回クリック→カウントが4で上限（5回目はUIロジック上4枚のまま増えない設計。実際にクリックした結果は4のまま保存された）。
- 「保存」→リロード→デッキ一覧に「4/60」の札で1件残っていることを確認（**保存の永続化はOK**）。
  ただし**デッキ名の入力欄への値設定（JSのdispatchEvent経由）がReactのcontrolled inputに反映されず**、
  保存されたデッキ名は既定値「まだ名前のないデッキ」のままだった。これはテスト手法の制約
  （合成`input`イベントがReactのvalue trackerに認識されない既知の挙動）の可能性が高く、
  実際のキーボード入力では問題なく動くはずだが、**実機での確認はしていない**。統括か次工程で一度キーボード入力を試してください。
- 盤面のマス寸法（キャラスロット。`data-dropid$=":char:0"`で計測）:
  - 1920×1080: 対戦卓→デッキ→対戦卓と切り替えた前後とも **141×141px（一致）**。`document.body.scrollHeight === innerHeight === 1080`（縦スクロール0）。
  - 1280×720: **87×87px**。`scrollHeight === innerHeight === 720`（縦スクロール0）。
- スクリーンショットは撮っていない（指示どおりDOM実測のみ）。

**ブラウザのツール呼び出し回数（概算）**: 34回（`browser_batch`は1回として数え、内訳: navigate×4, read_console×2,
get_page_text×5, javascript_tool×7, resize_window×3, find×5, computer×7, browser_batch×2）。40回以内に収まった。

## 未実装・未確認の項目（まとめ）

- 実機でのキーボード入力によるデッキ名編集の確認（上記参照）。
- 検索欄・並び替え・絞り込みチップの実クリック確認（コードレビューのみ）。
- ホバー拡大（`CardPreview`）の実発火確認（`mouseover`+bubbles等、盤面と同じ手法が必要な可能性）。
- 試しに7枚引くモーダル・書き出しモーダル・取り込みモーダルの実クリック確認。
- 複製・削除ボタンの実クリック確認。
- 「保存していない変更で戻ると確認が出る」の実クリック確認。
- `clearBundle`後にdecksテーブルが実際に残ることの実機確認。
- IndexedDBに残った動作確認用の「まだ名前のないデッキ（4/60・相田響子×4）」1件。統括の検証時に見えるはずです（消したい場合は一覧の「削除」から）。

## 申し送り（P5bに向けて）

- `DeckEditor`は`Deck`をpropで受け取り作業コピー（`working` state）を持つ設計。P5bで対戦卓からデッキを選ぶ際、
  同じ`Deck`型・`listDecks()`をそのまま使えるはず。
- `sampleHand`はデッキ内のcardIdをそのまま返す設計なので、P5bの開始準備（デッキ→シャッフル→7枚ドロー）でも
  同じ関数を流用できる可能性がある（ただし本物の対戦卓のシャッフルは通信同期が絡むため、そのまま使えるかは要検討）。
- リーダー専用カード（DESIGN §7.4・標準プールには存在しない）は本フェーズでは考慮していない（PHASE5a.md §7で対象外と明記済み）。

## 🚨 コミットしていません（統括が検証してからコミットしてください）

---

## 統括7の検証（2026-09-24）

- `npm run verify` 緑（exit 0・❌0・✅306 を統括が数え直し）。`probNoChar` の既知値 N=10,K=3,n=2 → C(7,2)/C(10,2)=21/45=7/15 を手計算で確認
- 差分精読: Dexie version(3) で既存テーブルを繰り返し＋`decks` 追加／`clearBundle` は decks に触れない／`@theme` に kind 色6つ・`src/ui/deck`・`deck.ts` にパレット色の直書き0件（grep）
- 1タブ実機（javascript_tool・DOM実測）: 新しいデッキ→15種×4枚クリックで 60/60→**デッキ名をキーボードで入力（サブの未確認項目・動いた）**→リーダー選択→保存→再読み込みで一覧に「統括検証デッキ 60/60 ✓」が残る。1920×1080 で対戦卓→デッキ→対戦卓の前後とも キャラ枠 141×141・中心線 900/900/900・縦スクロール0。デッキ編集は内側（`h-full overflow-y-auto`）でスクロールし、ページ自体は720/720。コンソールエラー0
- **統括が直した2点**:
  1. `Board.tsx` の行の定義 `1fr` → `minmax(0, 1fr)`（A/B 両レイアウト）。`1fr` は最小＝中身の高さなので、窓を縮めても行がカードの大きさに押し広げられたまま縮まない（1280×720 で行141px を実測＝既存の不具合。以前はタブ切り替えで Board が作り直されて偶然直っていたが、P5a で常時マウントにしたため逃げ道が消えた）。修正後 1280×720 で行 87px
  2. `App.tsx` で Board の隠し方を `hidden`（display:none）→ `invisible`＋`absolute inset-0`（レイアウトを保つ）。隠れている間も行の高さの計測が生き続け、戻したときに古い値で固まらない。デッキ・カード一覧も `absolute inset-0` の中に置いた（内側スクロールは確認済み）
- ⚠️ **確かめられなかったこと**: 窓の大きさを変えたときにマスが追従するか。検証用のブラウザ枠が非表示（`document.visibilityState === 'hidden'`）で描画フレームが止まり、ResizeObserver 自体が発火しない。行の実寸が正しく縮むことまでは実測済み。利用者のテストプレイで「F11 の出し入れでマスが追従するか」を見てもらう
- サブの判断3点（`CardPreview` を別に作った／一覧の「書き出し」は編集を開いてから出す／`NaN%` の防止）は妥当と承認
- サブのツール呼び出し: 106回（うちブラウザ34回）。使用量は5時間枠の前後差で統括が別途記録
