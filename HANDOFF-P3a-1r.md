# HANDOFF-P3a-1r — 優先権エンジン＆表示の作り直し（正しいモデルへ） 完了報告

宛先: 統括セッション。実装: Sonnet（本セッション）。DESIGN.md §5.1「🚨 モデルの訂正（2026-07-19）」を受けて、旧P3a-1/P3a-2aの`core/priority.ts`（flat stack + LIFO resolveTop）とStackPanel（縦長リスト）を全面作り直し。

## やったこと

### 新データモデル（[src/core/priority.ts](src/core/priority.ts)、全面書き直し）

- `DeclaredAction { by, sourceIid, kind, actionType, label, detail? }`（旧`StackItem`を置換。`id`は廃止＝新モデルは各枠にActionを直接持つので採番不要）。
- `ActionWindow { active, nonActive, step }`（1つの窓＝アクティブ/非アクティブの2枠。`step`は`awaitActive|awaitNonActive|processActive|processNonActive`の4段階）。
- `Priority { frames: ActionWindow[], activePlayer }`（`frames`は入れ子の窓のスタック。末尾＝現在の窓）。
- `declareAction` / `passPriority`（挙動変更）/ `resolveStep`（新規。旧`resolveTop`のLIFO発火を置換）/ `setMode`（変更なし）。

### 遷移の核心判断（申し送り必読）

指示書§3の遷移表を文字通り実装すると**入れ子フレームで破綻する**ことを実装中に発見し、修正した:

- 指示書の各ガードは`activePlayer`（`Priority`直下の1個のフィールド）を参照する書き方だが、これは**ルート窓では正しいが、入れ子窓では壊れる**。入れ子窓は「割り込んだ側」が`active`枠を埋めて開く（`activePlayerは据え置き`＝グローバル値は変えない、と明記されている）ため、文字通り`other(activePlayer)`でガードすると、割り込んだ本人が再び要求されて**次の応答者が永遠に来ない**バグになる（実際に指示書の手検算ケース3を素直に実装してデスクチェックすると矛盾が出る）。
- **解決**: `referenceSeat(priority, frame) = frame.active?.by ?? priority.activePlayer` という補助関数を導入し、全てのガードをこれ経由にした。`active`が埋まっていれば**その宣言者を基準**にする（ルート窓は`activePlayer`と一致するので指示書通りの挙動と等価、入れ子窓は割り込んだ側が正しく基準になる）。`active`がまだ空（`awaitActive`）のときだけグローバル`activePlayer`にフォールバックする。
- これにより単体テストの**5ケース全て（入れ子を含む）が矛盾なく通る**ことを確認済み（下記）。設計判断としてここが一番の申し送り事項。

### 表示（[src/ui/board/StackPanel.tsx](src/ui/board/StackPanel.tsx)、全面書き直し）

- 縦長リストを廃止。**「自分の宣言／相手の宣言」の2枠**＋現在の`step`でボタンを出し分け。
- 宣言フェーズ（await*）: 応答待ちが自分なら「通す（パス）」、相手ならその旨の表示。
- 処理フェーズ（process*）: 解決担当が自分なら「解決（完了）」（`resolveStep`。**自動化しない**）、相手ならその旨の表示。
- 入れ子（`frames.length > 1`）は「割り込み処理中（N段）」の小表示。
- 自動パストグルは維持。旧実装は「stackの最上段id」でバトル宣言の新規性を判定していたが、新モデルには`id`も`stack`最上段の概念も無いため、**「現在の窓にバトル種別の宣言が存在するかどうか」で判定**する形に作り直した（存在する間は自動パスしない・自動でOFFにする。resolveStepは元から自動化していない）。
- `core/priority.ts`に読み取り専用ヘルパー`awaitingSeat`/`resolvingSeat`を追加し、UIはこれを呼ぶだけ（遷移ロジックの複製を避けた）。

### 呼び出し側の追従

- [CardContextMenu.tsx](src/ui/board/CardContextMenu.tsx)「⚡スタックに宣言」: `action: { by, kind:'能力', actionType:'通常型', sourceIid, label }`（`id`削除）。
- [DetailPanel.tsx](src/ui/board/DetailPanel.tsx) 起動ボタン: 注釈の`type`（`通常起動|割込起動|通常起動+割込起動`）を`toActionTiming()`で`actionType`（`通常型|割込型`）に変換して渡す（複合型は`割込型`に寄せた。coreはactionTypeの中身で分岐しないので表示・記録用の割り切り）。

### 旧盤面の移行（[src/ui/board/useBoard.ts](src/ui/board/useBoard.ts)）

- `normalizePriority()`を追加。読込んだ`priority`が`null`でなく、かつ`frames`プロパティを持たない（＝旧shape）場合は`null`に正規化する。既存の`{...EMPTY_BOARD, ...saved}`補完のすぐ後段に挟んだ。
- **実機で意図的に旧shapeを注入して検証**: IndexedDBに`{stack:[...], awaitingConsentFrom:'B', consentedInARow:[]}`という旧shapeの`priority`を直接書き込んでからリロードし、クラッシュせず「（割り込みなし）」（＝null正規化済み）になることをDOM/コンソール実測で確認（後述）。

## 検証

### 単体テスト（`npm run test:core-priority`を新モデルに全置換）

[scripts/test-core-priority.ts](scripts/test-core-priority.ts)。PHASE3a-1r.md §3の5ケース（基本／1＋1／入れ子／誰も宣言せず／不正）＋setMode＋既存reducer非回帰、**全件✅**。
- ケース4（誰も宣言せず）は、reducer経由では`awaitActive`（`active===null`）状態に到達できない（`declareAction`は常に宣言と同時に`active`を埋めて窓を開くため）ことに気づき、`priorityEngine.passPriority()`を`Priority`型の状態を直接構成して単体で叩く形にした（純粋関数は到達可能性によらず任意の妥当な入力で検証してよい、という方針）。
- ケース3（入れ子）が上記「设計判断」のバグを検出したテスト。修正前は親フレーム復帰後の応答者ガードが噛み合わず失敗していた。

### 2タブ実機（localhost:5300、A=ホスト/B=ゲスト）

1. **旧盤面移行**: IndexedDBに旧shape（`stack`ベース）の`priority`を直接注入→リロード→クラッシュせず「（割り込みなし）」表示、コンソールエラー0。
2. **基本**: 神岸あかりの「お弁当（R）」ボタン→2枠に反映（A「自分の宣言」/B「相手の宣言」で正しく視点が入れ替わる）→B「通す」→processActive→A「解決（完了）」→窓閉じる。両タブ同期・ログ整合を確認。
3. **1＋1**: A宣言→B宣言（右クリ⚡汎用宣言口）→両者の枠が埋まりprocessActive→A解決→processNonActiveへ（アクティブ→非アクティブ順）→B解決→窓閉じる。両タブ同期を確認。
4. **入れ子**: processActive中にBが割り込み宣言→「割り込み処理中（2段）」表示に切り替わり2枠がその場で内側フレームの内容に更新される→A通す→B解決→popされ「割り込み処理中」表示が消え親のprocessActiveに戻る（外側の宣言内容が維持されていることを確認）→残りを解決して窓閉じる。
5. **モード切替**: フリーへ切替で両タブとも「フリーモード中（優先権オフ）」＋起動ボタン非表示に、アシストに戻すと復帰。共有・同期を確認。
6. レイアウトB切替でも新StackPanelが専用枠に正しく表示されることを確認。両タブともコンソールエラー0。
7. `npx tsc --noEmit`・`npm run build`（core隔離チェック＋tsc＋vite build）ともにエラー0。

## 申し送り

1. **`referenceSeat`の判断（上記）は統括の再確認を推奨**。指示書§3の遷移表を字面通り実装すると入れ子で壊れるため、`Priority.activePlayer`を「ガードの直接の判定材料」ではなく「`active`未確定時のフォールバックのみ」に格下げした。ルート窓の挙動は指示書と完全に等価（`active.by === activePlayer`が常に成立するため）なので、通常のプレイでは違いは出ない。将来ターン管理（P4）で`activePlayer`を本物の手番トラッキングに使い始める際、この関数の意味づけを再確認してほしい。
2. **`activePlayer`は現状ほぼ表示・ブックキーピング用**（ゲーティングの主体は`referenceSeat`）。P4でターン管理が入ったら、ここに「本当の手番プレイヤー」を流し込む形で自然に拡張できるはず（フィールドの意味は変えずに、値の出所がP4のターン管理に変わるだけ）。
3. **自動パスのバトル自動オフ判定を作り直した**（旧: 最上段の新規idで判定 → 新: 現在の窓にバトル種別の宣言が存在するかで判定）。旧実装より単純だが、意味的には「バトル関連の窓では自動パスしない」という、より安全側の判断になっている。実機で違和感があれば統括判断で調整してほしい。
4. **`awaitingSeat`/`resolvingSeat`をcoreの公開APIとして追加**した。UI側で遷移ロジックを再実装せずに済むようにするための意図的な設計判断（P3a-2b以前はUI側にロジックが漏れていた反省を踏まえた）。
5. コスト自動処理（P3b）・手札ドラッグ自動宣言（P3a-3）・バトル7段の状態機械は本フェーズのスコープ外のまま。
