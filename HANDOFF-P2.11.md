# HANDOFF-P2.11 — 見た目の土台（テーマA「空と紺」）実装報告

**担当**: 実装サブエージェント　**日付**: 2026-09-24
**結果**: `npm run verify` 緑（build+全テストケース成功）。§6 の機械チェック4項目すべて合格。§7 の煙試験合格。
**🚨 コミットしていません。** `git status`で変更ファイルを確認できます（差分は全て未staged）。

---

## 1. 変えたファイル

- `index.html`（Google Fonts の `<link>` 追加）
- `src/index.css`（`@theme` トークン定義／`lf-panel` `lf-btn-primary` `lf-card-rim` の `@utility`／`body` 背景・フォント）
- `src/ui/App.tsx`, `CardList.tsx`, `CardTile.tsx`, `DataGate.tsx`
- `src/ui/board/BattlePanel.tsx`, `Board.tsx`, `CardContextMenu.tsx`, `CardFace.tsx`, `CardPicker.tsx`, `CardPiece.tsx`, `ConnectionPanel.tsx`, `DetailPanel.tsx`, `DroppableSlot.tsx`, `HoverPreview.tsx`, `LogPanel.tsx`, `StackPanel.tsx`, `StackedCardSlot.tsx`, `ZoneBundle.tsx`
- `scripts/build-data-bundle.mjs`（カード裏面の同梱）
- `src/data/bundle.ts`（カード裏面の取り込み・`CARD_BACK_IMAGE_ID` の追加）

`src/core/` は無変更。`_local/`・`DESIGN.md` は読むだけ（変更していません）。

---

## 2. 置き換え表（元クラス → 新クラス）

機械的な一括置換＋個別の手直しで全て変換。`grep`（§6-1）は0件です。

| 元（Tailwind パレット） | 新（トークン） | 主な用途 |
|---|---|---|
| `text-slate-100/200/300` | `text-ink` | 本文 |
| `text-slate-400/500` | `text-ink-muted` | 補足 |
| `text-slate-600(/700)` | `text-ink-faint` | さらに弱い |
| `border-slate-500` | `border-line` | 通常の枠線 |
| `border-slate-600/700` | `border-line-strong` | やや強い枠線 |
| `border-slate-800` | `border-line` | 薄い区切り |
| `bg-slate-700` | `bg-surface-3` | 一段上（押下中等） |
| `bg-slate-800` | `bg-surface-2` | 一段上がった地 |
| `bg-slate-900` | `bg-surface-1` | パネルの地 |
| `bg-slate-950` | `bg-surface-0` | 一番奥 |
| `text/border/bg-sky-*` | `accent` | 操作・情報の差し色 |
| `text/border/bg-emerald-*`, `green-*` | `ok` | 決定・待機・気力等 |
| `text/border/bg-amber-*` | `warn` | 注意・選択中 |
| `text/border/bg-red-*` | `danger` | バトル・中断・ダウン |
| `bg-{accent,ok,warn,danger}-900/950`（暗い半透明タグ・通知） | 同トークンの低opacity（`/10`〜`/60`。用途に応じて手直し） | 通知枠・ホバー時の淡い塗り |
| `bg-{emerald,red}-900/90`＋`text-{emerald,red}-300`（能力値修正チップ）、`bg-red-800`＋`text-red-200`（ダウン表示） | `bg-{ok,danger}/90`＋`text-on-accent` | 塗り色とテキスト色が機械置換で同色衝突したため、可読性のため個別に `text-on-accent` へ修正（§3参照） |

機械置換は以下の方針で行いました:
- `text-*` は基本 `ink`／`ink-muted`／`ink-faint` の3段
- `border-*` は `line`／`line-strong` の2段（濃淡は元の600番台以上か800番台かで判定）
- `bg-*` の slate は surface-0〜3 の4段（数字通り）
- sky/emerald/green/amber/red は用途別トークン（accent/ok/warn/danger）に一本化。同一トークンの中の濃淡差は元コードにあった `/NN` の不透明度指定をできるだけ保持

## 3. §1-1 の例外・個別の判断

- `white` / `black` / `transparent` はそのまま残しています（指示の例外通り）。`bg-black/60` 相当の暗幕は今回未使用。
- **機械置換の副作用を手直しした3箇所**（同一トークンで bg/text が衝突し文字が読めなくなっていたもの。理由＝可読性）:
  - `src/ui/board/BattlePanel.tsx:240`（ダウン表示バッジ）: `bg-danger text-danger` → `bg-danger text-on-accent`
  - `src/ui/board/CardPiece.tsx:163`（能力値修正チップ）: `bg-ok/90 text-ok` / `bg-danger/90 text-danger` → 両方 `text-on-accent`
  - `src/ui/board/Board.tsx:606`（ドラッグ拒否通知）: `bg-warn/60`（不透明すぎて`text-warn`が沈む）→ `bg-warn/20`
- **BattlePanel の「⚔ バトルを挑む」ボタン**: 元は赤系（危険色）でしたが、PHASE2.11.md §2 の `lf-btn-primary` 対象リストに明記されているため、指示通りプライマリボタン配色（明るい水色系）に変えました。赤みが失われる見た目の変化点として明記しておきます。
- **バトルパネルの赤みがかった枠**（見本の `.panel.battle` は `color-mix` で境界線を紅く染めている）: `lf-panel` は単純な `border-color` 固定のユーティリティなので、`border-danger/NN` を後から重ねがけすると、Tailwind v4 のユーティリティ層でどちらが勝つか保証できない（両方 `border` 系ショートハンドで同じプロパティを触る）と判断し、**危険を避けて `lf-panel` の素の見た目のまま**にしました。バトル中パネルは今、他のパネルと同じ紺色の枠です。見本通りの赤みを付けたい場合は `lf-panel` の実装をプロパティ別（`border-width`/`border-style`/`border-color`を分離）に作り直す必要があります（次回への申し送り・§7末尾参照）。

## 4. §4 カード裏面の受け渡し方式

**方式＝prop（Reactコンテキストは使っていません）。**

- `scripts/build-data-bundle.mjs`: `_local/card-back.jpg` があれば zip に `back.jpg`（無圧縮）として同梱。無ければ従来通り同梱せず続行（実行時ログにも明示）。
- `src/data/bundle.ts`: `CARD_BACK_IMAGE_ID = '__card-back__'` を新規export。`importBundle` で `entries['back.jpg']` があれば `images` 配列に `{id: CARD_BACK_IMAGE_ID, blob}` として追加 → 既存の `db.images` 保存・`loadLibrary` の `imageUrls` に自然に載る（`App.tsx` 側の変更は不要）。`meta.imageCount` にはカード裏面を数えない（カード画像枚数の表示に影響しないよう除外）。
- `CardFace.tsx`: 新しい任意prop `backImageUrl?: string` を追加。`!faceUp` のとき `backImageUrl` があれば全面画像、無ければ従来の「裏」テキスト表示のまま。
- 呼び出し元（`CardPiece.tsx` → `HoverPreview.tsx` まで貫通、`StackedCardSlot.tsx` ×3箇所、`ZoneBundle.tsx` ×2箇所＋`thin`（相手手札の帯）表示、`StackPanel.tsx` の提示エリア）は全て、既に持っている `imageUrlOf` 関数で `imageUrlOf(CARD_BACK_IMAGE_ID)` を呼んで `backImageUrl` として渡すだけ。新しいpropバケツリレーが1段（`CardPiece`→`HoverPreview`）増えた以外は既存の配線を使い回しています。

## 5. 自己点検（§1〜§4）

| 要求 | 実装場所 |
|---|---|
| §1 トークン定義 | `src/index.css:3-18`（`@theme`） |
| §1 body背景 | `src/index.css:44-46` |
| §1-1 パレット色置換 | 全 `src/ui/**` ファイル（§6-1のgrep 0件で確認済み） |
| §2 `lf-panel` | `src/index.css:20-27`（定義）／適用: `BattlePanel.tsx:360,381`、`Board.tsx:618,654`、`LogPanel.tsx:8`、`StackPanel.tsx:284,296,329` |
| §2 `lf-btn-primary` | `src/index.css:29-33`（定義）／適用: `BattlePanel.tsx:118-125`(決定)`,246-262`(ダメージを適用)`,365`(⚔バトルを挑む)`,527-534`(次へ)、`StackPanel.tsx:356-362`(通す)`,371-377`(解決) |
| §2 `lf-card-rim`・選択中の金の輪・ホバーaccent | `CardPiece.tsx:140-142` |
| §2 rimを付けない場所（拡大プレビュー・詳細パネル・カード一覧） | `HoverPreview.tsx`（rim無し・`border-ok`のまま）、`DetailPanel.tsx`（rim無し）、`CardTile.tsx`（rim無し）を確認済み |
| §3 M PLUS 1p | `index.html:6-10`（`<link>`）、`src/index.css:52`（`font-family`先頭。後ろに`system-ui`等を残存＝読み込めなくても表示される） |
| §4 カード裏面一式 | 上記§4参照 |

## 6. §6 機械チェックの出力

**1. grep（パレット色クラス残存チェック）**
```
$ grep -rnE "\b(bg|text|border|from|to|via|ring|outline|shadow|decoration|divide|fill|stroke)-(slate|sky|emerald|amber|red|green|zinc|gray|blue|rose|yellow|orange|indigo|violet|neutral|stone)-[0-9]" src/ui
（0件）
```

**2. `npm run verify`**
全ケース成功（build成功・`test:core-priority`/`test:timing`/`test:play-declare`/`test:battle`/`test:battle-flow` 全て✅、失敗0件）。「全ケース成功」行を除いた個別✅行の中に失敗（❌）は無し。

**3. zip内の裏面画像**
```
$ unzip -l dist-data/leaffight-data.zip | grep back.jpg
    57872  2026-09-24 09:19   back.jpg
```

**4. 縦スクロール無し**
- 1280×720: `innerHeight=720` / `scrollingElement.scrollHeight=720`（超過なし）
- 1920×1080: `innerHeight=1080` / `scrollingElement.scrollHeight=1080`（超過なし）
（両方とも `resize_window`→`navigate`で再読み込みしてから計測。IMPLEMENTATION-NOTES.mdの既知の制約に従いました）

## 7. §7 煙試験の結果

- devサーバー: 既に他プロセスがport 5300で起動済みだったため、`preview_start`/新規起動はせず既存サーバーへ直接`navigate`（IMPLEMENTATION-NOTES.md記載の代替手順通り）。
- 新しいzip読み込み: 既存IndexedDBに旧データが残っていたため、`indexedDB.deleteDatabase('leaffight')`→再読み込み→fetch→DataTransfer の手順で新zip（back.jpg入り）を読み込み直しました。
- console: エラー無し（`read_console_messages` onlyErrors=true で0件、通常ログもvite接続メッセージのみ）
- 裏面画像: `<img alt="裏面">` が `blob:` src・`naturalWidth=358`（>0）で確認（相手手札の帯＝`ZoneBundle`のthinモード）
- §6-4: 上記の通り両解像度で合格
- `lf-card-rim`: カードを1枚盤面に追加し、`getComputedStyle` で `box-shadow: rgb(244, 236, 255) 0px 0px 0px 1.5px, rgba(185, 168, 255, 0.4) 0px 0px 10px 0px, rgba(0, 0, 0, 0.533) 0px 4px 10px 0px`（指示のトークン値と一致）を確認
- スクリーンショットは撮っていません
- 2タブでの対戦確認はしていません（統括の担当）

**使ったツール呼び出し回数（§7区間のみ）**: navigate×4、javascript_tool×8、resize_window×3、find×1、computer×1（screenshotタイムアウトで失敗・以降JS実行に切替）、read_console_messages×2 ＝ 合計19回（上限40回以内）

---

## 8. 判断が要る発見・申し送り

1. **バトルパネルの赤みがかった枠を再現していません**（§3参照）。見本の `.panel.battle` は `color-mix()` で紺の枠に赤を混ぜていますが、`lf-panel` ユーティリティ（`border`ショートハンドで幅・スタイル・色をまとめて定義）に対して別クラスで`border-color`だけ重ねがけするのはTailwind v4のレイヤー順序上fragileと判断し見送りました。この赤みが欲しい場合は `lf-panel` を `border-width`/`border-style`/`border-color`のプロパティ別ユーティリティに分割する必要があります。
2. **「⚔ バトルを挑む」ボタンが赤→水色（プライマリ色）になりました**。指示書のlf-btn-primary対象リストに明記されていたのでその通りにしましたが、「危険なアクション」という色の意味が失われる副作用があります。試遊してみて違和感があれば、このボタンだけ`lf-btn-primary`を外して`border-danger text-danger`に戻すのが安価な差し戻しです。
3. `_local/card-back.jpg` は既に存在していたため、`npm run data:bundle` で実際に `back.jpg` 入りのzipを作り直し、動作確認済みです。
4. カード裏面の受け渡しは、盤面上の全てのCardPiece呼び出し箇所（StackedCardSlot・ZoneBundle・StackPanelの提示エリア）に配線しましたが、通常プレイでは「デッキ」と「相手の手札」以外は既定で表向き（DESIGN §4.18.0）なので、実際に裏面画像が見えるのはデッキの束・相手手札の帯・手動で裏返した時だけです（想定通り）。

---

## 統括の検証（統括5・2026-09-24）

**判定: 合格（統括が4点直してコミット）。** verify 緑（236件・❌0）。§6-1 の grep 0件・`src/core/` 無変更を確認。
配置系クラス（w/h/p/m/gap/text-[..] 等）は差分の削除側と追加側で数が一致（増えたのは裏面画像の `h-full w-full` と外枠の `overflow-hidden` だけ）。

### 統括が直したもの
1. カードの枠線が `border`→`border-2` に変わっていた（中身が縮む＝大きさを変えない約束に反する）→ 1px に戻し、選択中の金の輪は `outline-2 outline-offset-2 outline-warn`（配置に影響しない）
2. 盤面の外枠 `Board.tsx` が `bg-surface-0` で塗りつぶし、body のグラデーションを隠していた → 塗りを外した
3. 付随カード数バッジ `bg-accent text-white`（明るい空色に白文字で読めない）→ `text-on-accent`
4. バトルパネルの赤い枠（サブが見送った §3）→ `lf-panel` の枠色を `--lf-panel-border` で上書きできる形にし、BattlePanel で `[--lf-panel-border:rgb(255_122_138/0.55)]`

### 統括の実測（DOM）
- 1920×1080: 裏面 img 2枚（blob・幅358）／カード 105×147（変更前と同じ）／`lf-card-rim` の box-shadow／枠線 1px／M PLUS 1p 読込済み／body グラデーション可視／`lf-panel` の地と枠／縦スクロールなし
- 選択中の輪: `outline 2px solid #ffd98a offset 2px`（ペイン非表示で transition が止まるため finish してから読んだ）
- 1280×720: 2つ目のタブ（zip 読み込み直しなし）でも裏面が出る＝IndexedDB はタブ間共有（サブのメモを訂正）／マス 93px・カード 67×93 は **変更前（stash して同じ盤面で測定）と同一**／縦横スクロールなし
- **未実測**: バトル中のパネルの赤枠の見た目（盤面に未使用バトルカードが無い）。クラスがビルドに出ていることのみ確認

### 使用量
5時間枠: 指示書づくり 6%→8%、サブ 8%→20%（**+12%**・ツール139回・16分）、統括の検証と修正 20%→約24%。
P3d-2b（サブ +40%）より大きく下がった＝サブの実機確認を煙試験に絞った効果。
