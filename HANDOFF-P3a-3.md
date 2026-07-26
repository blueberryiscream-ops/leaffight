# HANDOFF-P3a-3 — 手札プレイの自動宣言（ドロップ＝宣言、着地は解決時） 完了報告

宛先: 統括セッション。実装: Sonnet（本セッション）。P3a-1r/P3a-2a/P3a-2b/P3c完了・HEAD=060ce02が前提。

## やったこと

「相手のカードプレイに割り込む」を構造的に可能にした。手札→場/ゴミ箱のドラッグを、即着地ではなく「プレイ宣言」に変え、優先権エンジンの窓を経由してから解決時に着地する形にした。

### core（`git diff src/core/priority.ts` で確認済み: 状態遷移ロジックは1行も変えていない）

- **[core/board.ts](src/core/board.ts)**: `ZoneId`に`'pending'`を追加、`ZONE_LABEL`に`pending:'宣言中'`を追加。束ゾーン（`isSlotted`は変更不要、既に`false`扱い）。
- **[core/priority.ts](src/core/priority.ts)**: `DeclaredAction`に`place?: PlayPlacement | null`を追加（`PlayPlacement{toOwner?,toZone,toIndex?}`）。**engineはこれを一切読まない**（`declareAction`/`passPriority`/`resolveStep`本体は無改造）。読み取り専用ヘルパー`canDeclare(priority,seat)`を新設し、`declareAction`の受理条件（`awaitActive→seat===ref` / `awaitNonActive→seat===other(ref)` / `process*→常にtrue`）と完全に同じ式にした。
- **[core/actions.ts](src/core/actions.ts)**: reducerで「カードの移動」と「優先権の更新」を1アクションにまとめた。
  - `declareAction`: **engineの受理判定が先、カード移動は後**（`log===''`なら即return、stateは一切変えない）。受理された場合のみ`place`があれば対象カードを`pending`へ`moveCard`。
  - `resolveStep`に`cancel?: boolean`を追加。**適用前**のpriorityから「今解決される宣言」を`resolvingAction()`（新設のprivateヘルパー、`resolvingSeat`と同じ判定だがaction本体を返す）で取り出し、resolveStep適用後に`cancel`なら`hand`へ、通常なら`place`通りの着地先へ`moveCard`。ログは取り消し時「〜を取り消した（手札に戻した）」に文言を差し替え。
  - `setMode`: `mode==='free'`のとき、`pending`にいる全カードを持ち主の`hand`へ強制的に戻す（🚨見落とし厳禁の項目。忘れると`pending`のカードは描画先を持たず盤面から消える）。

### UI

- **[ui/board/Board.tsx](src/ui/board/Board.tsx)** `handleDragEnd`: `mode==='assist' && zone==='hand' && toZoneが{char,leader,battle,field,trash}`のときだけ`declareAction`に変換（`'deck'`は対象外、`'trash'`は対象＝イベント使用に一致）。`canDeclare`がfalseなら**カードを動かさず**、ローカルのみの`dragNotice`バナー（2.5秒で自動消去。共有ログではなく各クライアント個別の表示。「黙って何も起きない」を避ける要件を満たしつつ、"何も起きなかった試み"を両者のログに残さない判断）。`actionType`は現在の窓の`step`が`process*`なら`'割込型'`、それ以外は`'通常型'`を機械的に算出。
- **[ui/board/StackPanel.tsx](src/ui/board/StackPanel.tsx)**: `ActionSlot`にカード名クリック→`onSelectCard(sourceIid)`（詳細パネルへ。`pending`は盤面に描画されないための代替導線。DetailPanelは`zone==='hand'`のときだけ伏せるので`pending`は自然に両者へ全文表示される＝追加実装不要だった）。解決ボタンの隣に、`place`がある宣言のときだけ「取り消し（手札に戻す）」を追加。
- **[ui/board/useInterruptNotices.ts](src/ui/board/useInterruptNotices.ts)**: 🐛**発見して修正したバグ**（後述）。

## 🚨 実装中に発見したバグ（勝手に仕様を変えず、ここに書く）

`core/timing.ts`の`cardKindOf`コールバックは、`declareTimings`/`resolvedTimings`内で`cardKindOf(action.sourceIid)`として呼ばれる。`sourceIid`は**CardInstanceのiid**であって、カード辞書のキー（PoolCard.id）ではない。ところが呼び出し元の[useInterruptNotices.ts](src/ui/board/useInterruptNotices.ts)は`(cardId) => cardOf(cardId)?.kind`という、**cardIdがそのまま渡ってくる前提**の実装になっていた。

- P3cの時点ではkind='プレイ'の宣言を生む経路が存在しなかったため、この不整合は「常にundefinedを返す」という形で**無害に眠っていた**（P3c HANDOFF §7で「紛らわしいので事実として残す」とだけ記録されていた）。
- 本フェーズでkind='プレイ'の宣言（手札ドラッグ）を実際に開通させたことで、**このバグがそのまま『カードプレイに対する割り込み通知が一切鳴らない』という致命的な形で顕在化する**ことが分かった（本フェーズの完了条件そのものが機能しなくなる）。
- **`core/timing.ts`は指示書通り無改造**のまま、呼び出し側（`useInterruptNotices.ts`）で`iid→CardInstance→cardId→PoolCard.kind`と一段挟んで正しく解決するよう修正した。実機で「Aがガセネタを使用したとき、時間稼ぎを持つBに通知が出る」ことを確認済み（下記）。
- 判断の性質: これは設計判断ではなく機械的なID解決の修正（core/timing.tsの契約自体は変えていない）と考え、その場で修正した。ただし影響範囲が「本フェーズの主目的の成否」に直結するため、独断で直したことをここに明記する。

## 検証

### 単体テスト（`npm run test:play-declare`・新規）

[scripts/test-play-declare.ts](scripts/test-play-declare.ts)。§4の6ケース（宣言→pending化／解決→着地／取り消し→hand復帰／弾かれた宣言でstate不変／setMode('free')でpending全戻し／canDeclareと実際の受理の一致×7パターン）、**全件✅**。既存`test:core-priority`・`test:timing`も無改造のまま全緑（回帰なし）。

### 2タブ実機（localhost:5300、A=ホスト/B=ゲスト。javascript_toolでdnd-kitのMouseEventを直接発火）

1. **🚨 旧盤面の互換**: IndexedDBに「`place`フィールドを持たない旧DeclaredAction」で優先権窓が開いた状態の盤面を直接注入→リロード→クラッシュせず、StackPanelが正しく表示（`place`が無いので「取り消し」ボタンも出ない）。コンソールエラー0。
2. **ホスト→ゲスト方向**: Aが手札のガセネタ（イベント）をA自身のゴミ箱へドラッグ→即着地せず「プレイ・通常型」として両タブに「宣言中」表示（B側は「相手の宣言」欄にカード名クリック→詳細パネルで全文閲覧可能＝両者から中身が見えることを確認）→B「通す」→A「解決」→カードが`trash`に着地→**Bが時間稼ぎ（相手が／イベントカードを使用したとき）の割り込み候補通知を受け取る**（本フェーズの主目的）。
3. **ゲスト→ホスト方向**（過去2回見落とされていた向き）: Bが手札の時間稼ぎをB自身のゴミ箱へドラッグ→宣言→A「通す」→B「解決」（ゲスト側のresolveStep発行も含めて動作）→**Aがアクシデント（相手が／イベントカードを使用したとき）の割り込み候補通知を受け取る**。両方向とも問題なし。
4. **取り消し**: Aが手札のアクシデントを宣言→B「通す」→Aが「解決」ではなく「取り消し（手札に戻す）」を選択→ログ「〜を取り消した（手札に戻した）」→カードが両タブで`hand`に戻ることをIndexedDB直接確認。
5. **キャラ召喚**: 手札のセバスチャンを`A:char:2`スロットへドラッグ→宣言→解決→IndexedDBで`zone:'char', index:2`にちょうど着地していることを確認（ドロップ先のtoIndexが正しく素通しされている）。
6. **free mode**:
   - フリーモード中の手札ドラッグ（いただきますを手札→ゴミ箱）が**即座に**`moveCard`（ログ「〜から〜へ移動した」形式）で動くこと、宣言化されないことを確認。
   - アシストモードで宣言（大嵐→pending、窓オープン）した**直後にfreeへ切替**→カードが持ち主の`hand`に戻り、`priority:null`、盤面のpendingカードが0件になることをIndexedDBで直接確認（B側の同期状態も確認）。
7. **弾かれた宣言**: 窓が開いて相手の応答待ち中に、宣言主本人がさらに別のカードを宣言しようとする操作を実機で発火→カードは動かず、ローカルバナー「今は「エクストリーム」を宣言できません（相手の応答待ち）」が表示され、2.5秒後に自動的に消えることを確認。
8. **非回帰**: 盤面内ドラッグ（キャラ→別スロット）、右クリックメニュー経由のアイテムattach（衣装・鎧→セバスチャン、ドラッグでなく従来のUIで実施）、起動型トリガーボタン（お弁当）、レイアウトA/B切替、1920×1080・1280×720いずれもスクロール0（`document.documentElement.scrollHeight/Width`を実測）。全ステップでコンソールエラー0。
9. `npx tsc --noEmit`・`npm run build`（core隔離チェック込み）・`npm run test:core-priority`・`npm run test:timing`・`npm run test:play-declare`、すべて緑。

## 申し送り

1. **アイテムのattach経由のプレイは今回スコープ外のまま**（指示書§0の通り）。右クリックメニューの「付ける」は素の`attach`のままで、宣言を経ない。手札からアイテムを直接キャラスロットへドラッグした場合は他のカード種別と同様に「プレイ宣言」経路に乗るが（`isPlayDeclare`の判定はカード種別を見ていないため）、`core/timing.ts`の`declareTimings`はkind='i'/'b'には正規タイミングを割り当てないため、通知は鳴らない（宣言→pending→解決の機構自体は動くが、割り込み検出という実利は無い）。将来アイテムの正式なプレイ経路を作る際はここを起点にできる。
2. **`cardKindOf`のiid/cardId混同バグ**（上記）は`useInterruptNotices.ts`側で修正済み。`core/timing.ts`のパラメータ名`cardId`は依然として紛らわしいままなので、将来のリファクタで`cardKindOf`の引数名を`sourceIid`等に改めることを検討してもよい（今回はcore/timing.tsを無改造にする指示を優先し、呼び出し側だけを直した）。
3. **`canDeclare`のawaitActive分岐**は、現行の宣言経路（`declareAction`は必ずactiveを即座に埋める）では実運用上到達しない（P3a-1r HANDOFFで既に指摘済みの構造）。単体テストでは状態を直接構成して検証している。
4. **バトル宣言・バトル7段**は引き続き別フェーズ。`kind:'バトル'`の宣言経路はまだ無い。
5. コスト検証・消費（P3b）は引き続き未着手。
