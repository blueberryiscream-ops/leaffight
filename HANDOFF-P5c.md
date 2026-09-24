# HANDOFF-P5c — デッキ・ゴミ箱のダブルクリック割り当て／非公開カードの名前漏れ

**担当**: 実装セッション（サブエージェント）　**前提**: P5b（`b0da19b`）コミット済み。**このセッションはコミットしていない。**

---

## 1. やったこと

### core（`src/core/board.ts`）
- `isPublicCard(c: Pick<CardInstance,'zone'|'faceUp'>): boolean`（139行目）を新設。
  `zone !== 'deck' && zone !== 'hand' && faceUp`。移動前後の仮の状態（`{zone, faceUp}`）を渡しても使えるよう
  `CardInstance` 全体ではなく `zone`/`faceUp` だけを要求する型にした。
- `moveCard`（228行目）: 移動前・後のどちらかが `isPublicCard` なら従来どおり名前あり、
  両方非公開なら `カードを1枚 {from} から {to} へ移動した`（名前なし）。
- `setOrientation`・`setKiryoku`・`adjustKiryoku`・`setUsed`・`removeCard`: 対象カード（移動しない＝
  before/afterが同じ）が非公開なら主語を `カード` に置き換え。
- `setFaceUp`（`flip` が呼ぶ）: 表→裏は「前が公開」、裏→表は「後が公開」なのでどちらも名前を出す。
  前後とも非公開（手札内でのflip等）のときだけ `カード` にする。
- `addModifier`・`removeModifier`・`clearModifiers`: 対象カード（`targetIid`）を `state.cards` から引いて
  非公開なら `カード` に。
- `attach`・`detach`: `itemName`（付けるカード自身）を対象カードの公開性で判定。`attach` は
  `targetName`（付け先）も別途判定（両方とも非公開なら両方 `カード`）。
- `spawnCard` は変更なし（判断理由は§3）。

### ui（ダブルクリック・§3）
- `src/ui/board/CardPiece.tsx`: `onDoubleClick` をゾーン分岐に変更。
  - `char`・`battle`・`leader` → 従来どおり `toggleOrientation`
  - `deck` → `instance.owner === mySeat` のときだけ `moveCard`（`toZone:'hand'`）で1枚ドロー。相手のデッキは何もしない
  - それ以外（`hand`・`trash`・`field`・`pending`）→ 何もしない
  - 新規 `mySeat?: Seat` prop を追加（デッキの持ち主判定用）。冒頭のコメント（旧: 「左ダブルクリック→待機⇔消耗」固定）もゾーンごとの表に書き直した。

### ui（名前を見せない・§4）
- `src/ui/board/visibility.ts`（新規）: `hiddenFromViewer(c, mySeat)` を新設。
  `zone==='deck'` は常にtrue（自分のデッキでも隠す）、それ以外は
  `owner !== mySeat && (zone==='hand' || !faceUp)`。
- `src/ui/board/DetailPanel.tsx`: 旧 `hiddenFromMe`（手札とfaceUpだけ見て、デッキは素通りしていた）を
  `hiddenFromViewer` に置き換え。文言分岐に `デッキのカード（非公開）` を追加。
- `src/ui/board/CardContextMenu.tsx`: `hiddenFromViewer(instance, mySeat)` を計算し、
  - 見出しの名前 → `（非公開のカード）`
  - 気力セクション・能力値修正/攻防修正セクション・付随カードセクション・「⚡ スタックに宣言」ボタン → `hidden` のとき丸ごと非表示
  - 「待機↔消耗」「表↔裏」「ゴミ箱へ」「盤外に出す」の操作ボタンは残した（dispatchの`cardName`は従来どおり本当の名前を渡す＝ログ側の`isPublicCard`が隠す設計）
- `src/ui/board/ZoneBundle.tsx`: 新規必須prop `mySeat: Seat` を追加。デッキ束の一番上カードに
  `hidden={hiddenFromViewer(list[0], mySeat)}`（旧盤面でfaceUp:trueのまま置かれていても裏面を描く）と
  `mySeat={mySeat}`（ダブルクリック判定用）を渡す。`HandFan` にも `mySeat` を通した（手札のダブルクリックは
  何もしないので実質未使用だが、CardPieceの型・将来の一貫性のため）。
- `src/ui/board/Board.tsx`: `zoneBundle` ヘルパーの `<ZoneBundle>` に `mySeat={mySeat}` を追加。
- `HoverPreview.tsx`・`CardFace.tsx`・`StackedCardSlot.tsx` は無変更（`CardPiece` が計算した
  `faceUp`（`hidden`込み）をそのまま受け取る構造なので、`hidden` を正しく渡せば自動的に伝播する）。

### テスト
- `scripts/test-visibility.ts`（新規）: `isPublicCard` の真理値表（§1）、`moveCard`
  （デッキ→手札=名前なし／手札→キャラ=名前あり／手札→ゴミ箱=名前あり／手札→デッキ=名前なし／
  デッキ内並べ替え=名前なし）、`toggleOrientation`（デッキ=名前なし／キャラ=名前あり）、
  `flip`（裏→表・表→裏はどちらも名前あり／手札内は名前なし）。期待値はPHASE5c.md §1・§2の本文から作成
  （実装の出力を写していない）。`package.json` に `test:visibility` を追加し `test` チェーンに連結。

---

## 2. §2「ログを組み立てる箇所」の表（grepで全件確認）

| 関数 | cardName等を使う | 対象か | 理由・対応 |
|---|---|---|---|
| `spawnCard` | ✅ | **対象外** | 新規生成で「移動前」が存在しない。判断の詳細は§3参照 |
| `moveCard` | ✅ | ✅当てた | §2本文の主対象。before/after両方`isPublicCard`で判定 |
| `setOrientation`（`toggleOrientation`が呼ぶ） | ✅ | ✅当てた | 移動しない単発操作。対象カード1つの公開性で判定 |
| `setKiryoku` | ✅ | ✅当てた | 同上 |
| `adjustKiryoku` | ✅ | ✅当てた | 同上 |
| `setFaceUp`（`flip`が呼ぶ） | ✅ | ✅当てた | 🚨前後どちらか一方が公開なら名前あり（指示書の例外を素直に実装） |
| `setUsed` | ✅ | ✅当てた | 同上（バトルカードのused。通常は常に公開ゾーンだが念のため統一） |
| `addModifier` | ✅ | ✅当てた | `modifier.targetIid`から対象を引いて判定 |
| `removeModifier` | ✅ | ✅当てた | `mod.targetIid`から対象を引いて判定 |
| `clearModifiers` | ✅ | ✅当てた | `args.iid`から対象を引いて判定 |
| `attach` | ✅（item/target 2つ） | ✅当てた | item・targetそれぞれ別に判定（両方とも非公開なら両方`カード`） |
| `detach` | ✅ | ✅当てた | itemの公開性で判定 |
| `toTrash` | — | 対象外（moveCard委譲） | `moveCard`を呼ぶだけなので二重に手当てしない |
| `removeCard` | ✅ | ✅当てた | 対象カードの公開性で判定 |
| `shuffleDeck` | — | 対象外 | `cardName`を使わず`owner`（A/B）だけ。元々個別カード名を出していない |
| `clearBoard` | — | 対象外 | カード名を使わない固定文言 |
| `startWithDeck` | — | 対象外（既存で対応済み） | リーダー名を出さない設計が既にある（10-1[1]、P5bで実装済み） |
| `mulligan` | — | 対象外（意図的に公開） | `revealedNames`はマリガン規則上、本人が見て良い/公開が前提の一覧。隠す対象ではない |
| `revealLeader` | ✅ | 対象外（常に公開が正しい） | 呼ばれた時点で`faceUp:true`にする操作そのもの＝常に「後が公開」になるので、`isPublicCard`判定をしても必ず名前が出る。無条件で名前ありのままが正しい挙動と判断し、コードは変更していない |

---

## 3. 判断した点（指示書に明記が無く、自分で決めた点）

1. **`spawnCard` は対象外にした。** `moveCard`と違い「移動前」が存在しない（新規生成）ため、
   `isPublicCard`のbefore/after判定の枠組みに素直に乗らない。カード追加（`＋カードを追加`）は
   利用者が明示的にそのカードを選んで置く操作なので、置いた本人にとって名前は既知であり、
   ログに出ても情報が漏れるわけではないと判断した。もし今後「相手に見せず自分のデッキへカードを
   足す」用途で`spawnCard(zone:'deck')`を使うことがあれば、この判断を見直す必要がある。
2. **CardContextMenuで「⚡ スタックに宣言」ボタンも非公開時は隠した。** 指示書は
   「待機↔消耗」「表↔裏」「ゴミ箱へ」等の操作ボタンは残してよいと書いているが、この宣言ボタンは
   `label: name`（本当の名前）をスタック側に渡す操作であり、隠す意図と矛盾すると判断して
   気力/修正/付随カードのセクションと同様に非表示にした。
3. **`attach`/`detach`は item と target を別々に非公開判定した。** 指示書はここを名指ししていないが、
   §2「他のアクションも同様に」の一般則を素直に適用した。実戦では target（キャラ等）はほぼ常に公開
   ゾーンなのでこの判断が効く場面は稀（例: 裏向きリーダーにアイテムを付ける等）。
4. **`setKiryoku`/`adjustKiryoku`/`setUsed`にも同じ非公開判定を適用した。** 気力・used は通常
   公開ゾーン（char/leader/battle）でしか動かないため実戦での影響はほぼ無いが、
   「裏向きリーダーの気力を開始準備中に弄る」等の縁で非公開状態がありうるため、統一的に適用した。
5. **ZoneBundleの`mySeat`を必須propにした。** `hideContents`（既存の手札用フラグ）と役割が重なるが、
   デッキの`hidden`計算とダブルクリック判定の両方で必要なため、`hideContents`は残したまま
   `mySeat`を追加した（`hideContents`の計算式を`hiddenFromViewer`に統一する変更はスコープ外として見送った）。

---

## 4. 自己点検表

| 要求 | 実装した場所 | 確かめた方法 |
|---|---|---|
| §1 `isPublicCard`（core） | `src/core/board.ts:139` | `scripts/test-visibility.ts` 0a〜0h（真理値表） |
| §1 `hiddenFromViewer`（ui） | `src/ui/board/visibility.ts` | 煙試験4・5（右クリック/左クリックでデッキの名前が出ない） |
| §2 `moveCard`名前なし/あり | `src/core/board.ts:228-283` | `test-visibility.ts` 1a〜1f・煙試験2 |
| §2 その他アクションのログ（表） | 本書§2の表・`src/core/board.ts`各関数 | `test-visibility.ts` 2a・2b・3a〜3c（toggleOrientation/flip）／気力等は目視レビューのみ（未確認: 自動テストでは網羅していない） |
| §3 ダブルクリックのゾーン分岐 | `src/ui/board/CardPiece.tsx:153-166` | 煙試験2〜4（デッキ=ドロー／ゴミ箱・手札=無反応／リーダー=orientation切替） |
| §3 デッキ束は一番上(list[0])に届く | `src/ui/board/ZoneBundle.tsx`（既存のbundle表示がlist[0]をそのまま使う） | 煙試験2でhand 7→8枚を確認 |
| §3 title（ツールチップ）の追随 | `src/ui/board/CardPiece.tsx:23-30`（コード内コメント） | DOMに`title`属性のダブルクリック説明は元々無かった（コメントのみ更新） |
| §4 右クリックメニュー名前/中身を隠す | `src/ui/board/CardContextMenu.tsx:47-52,73-78,102-118,162,288` | 煙試験5（メニュー本文が`（非公開のカード）自分 ・ deck✕待機 → 消耗裏 → 表ゴミ箱へ盤外に出す`） |
| §4 詳細パネルの文言分岐 | `src/ui/board/DetailPanel.tsx:52-78` | 煙試験5（`詳細デッキのカード（非公開）`） |
| §4 CardPiece/HoverPreviewがhiddenFromViewerを通す | `src/ui/board/ZoneBundle.tsx`（deck束のhidden計算） | 目視レビュー（faceUp:trueで手置きされた旧盤面のケースは自動化テスト無し・未確認） |
| §5 テスト追加 | `scripts/test-visibility.ts`・`package.json` | `npm run verify` で実行（後述） |
| §5 煙試験1〜5 | ブラウザ検証 | 全て確認済み（詳細は本書§5） |

---

## 5. 煙試験（実施結果）

1. コンソールにエラーが無い → ✅（`read_console_messages` 2回とも「No console logs.」）
2. 「デッキで始める」（既存の統括検証デッキ60/60を選択）→ デッキ一番上を`dblclick`→ 手札7→8枚、
   ログに `カードを1枚 デッキ から 手札 へ移動した`（名前なし） → ✅
3. 手札の1枚を`dblclick` → `data-orientation`は`ready`のまま変化なし → ✅
   （ゴミ箱は今回の盤面が空だったため個別確認できず。ZoneBundleの分岐はデッキと同一コードパスで
   `zone`が`trash`の場合は「それ以外」扱いになるだけなのでコードレビューで確認・**実機未確認**）
4. リーダー（`char`/`battle`/`leader`扱い）を`dblclick` → `data-orientation`が`ready`→`rested`に変化 → ✅
   （char/battleは盤面に無かったためleaderで代表確認。コード上は同じ分岐なのでchar/battleも同様のはず）
5. デッキを右クリック → メニュー本文 `（非公開のカード）自分 ・ deck✕待機 → 消耗裏 → 表ゴミ箱へ盤外に出す`
   （気力・修正・付随カード・⚡宣言のセクションは非表示） → ✅
   デッキを左クリック → 詳細パネル `詳細デッキのカード（非公開）` → ✅

**未確認（実機での個別確認なし。コードレビューのみ）**:
- ゴミ箱のダブルクリックが実際に何も起きないこと（盤面にゴミ箱の中身が無かったため。ZoneBundle/CardPiece
  のコード上は`zone==='trash'`が「何もしない」分岐に入ることを確認済み）
- char・battleゾーン単体でのダブルクリック（leaderで代表確認。同一コード分岐）
- 相手（B席）のデッキをダブルクリックして本当に何も起きないこと（`instance.owner===mySeat`の否定側。
  コードは`owner===mySeat`のときだけdispatchする作りなので理屈上は安全だが、2タブ検証は統括の担当）
- 相手の手札・裏向きカードの`CardPiece`/`HoverPreview`が`hiddenFromViewer`を正しく通ること
  （デッキ以外は`hidden`propを明示的に渡していない＝既存の`instance.faceUp`依存のまま。デッキ以外は
  スコープ外と判断したので未変更・未確認）

---

## 6. `npm run verify` の結果

```
npm run build → ✅ 成功（core分離チェックOK・tsc OK・vite build OK）
npm run test  → ✅ 361件成功 / 0件失敗（test-visibility.ts の18件を含む。出力をgrep -cで数え直し済み）
```

---

## 7. 申し送り（統括判断が要ること）

- §5「判断した点」1〜5は設計判断というより実装上の解釈なので、方針として問題なければそのままで良いはず。
  特に1（`spawnCard`対象外）は、今後「相手に見せず山札へカードを直接足す」ような使い方が出てきたら
  再検討が必要。
- 未確認事項（§5末尾4点）は、2タブ検証（相手デッキのダブルクリックが本当に無反応か、相手の裏向き
  カードの見た目）を含むため、統括の2タブ検証時にあわせて確認してほしい。
- ブラウザツール呼び出しは合計18回（40回制限に対して余裕あり）。煙試験の手順は概ね5項目で収めた。

**変更ファイル一覧**:
- `src/core/board.ts`
- `src/ui/board/visibility.ts`（新規）
- `src/ui/board/CardPiece.tsx`
- `src/ui/board/ZoneBundle.tsx`
- `src/ui/board/Board.tsx`
- `src/ui/board/DetailPanel.tsx`
- `src/ui/board/CardContextMenu.tsx`
- `scripts/test-visibility.ts`（新規）
- `package.json`

🚨 コミットしていません（統括の検証待ち）。

---

## 統括8の検証（2026-09-24）

- `npm run verify` 緑（統括が数え直して ✅361・❌0）。`visibility.ts`・`CardPiece` のダブルクリックの分岐を精読
- 2タブ（testplay host/guest）:
  - ホストが自分のデッキをダブルクリック → デッキ 52→51、ログ「カードを1枚 デッキ から 手札 へ移動した」（名前なし）。**ゲストの画面のログにも名前なしで出る**
  - リーダーのダブルクリック → ready→rested（従来どおり）
  - 手札の石原麗子を右クリック →「ゴミ箱へ」→ ログに名前あり（公開になるので正しい）→ ゴミ箱のカードをダブルクリックしても向きは ready のまま
  - ゲストがホスト側の裏向きのカードをダブルクリック → 何も起きない（ログが増えない）
- 修正なし
