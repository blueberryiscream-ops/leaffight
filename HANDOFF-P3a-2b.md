# HANDOFF-P3a-2b — 詳細パネルの正式トリガーボタン（起動型能力）＋属性表示 完了報告

宛先: 統括セッション。実装: Sonnet（本セッション）。P3a-1/P3a-2a完了・`_local/ability-annotations.json`（ユーザー校正済み90カード/148能力）が前提。**`core/`は一切触っていない**（`git status`で確認済み。差分は`scripts/`と`src/data/`・`src/ui/`のみ）。

## やったこと

DESIGN.md §5.1「起動アクションのデータ層」/ §4.8 に沿って、P3a-2aの汎用宣言口（右クリ⚡）を、詳細パネルの正式なトリガーボタンに発展させた。

### 触ったファイル

- **[scripts/build-data-bundle.mjs](scripts/build-data-bundle.mjs)**: `_local/ability-annotations.json`（無ければ空で継続）を読み、`kind + '_' + norm(name)`（既存のカードid採番と同じ関数）をキーにした`{ cardId: AbilityAnnotation[] }`に変換して、zipに`annotations.json`として追加。pool.json/images/meta.jsonは無変更。生成ログに「起動能力の注釈: N カード / M 能力」を追加（`npm run data:bundle`実行で `90カード/148能力` を確認）。
- **[src/data/types.ts](src/data/types.ts)**: `AbilityAnnotation`（`name/type/cost`）と`AnnotationsMap`型を追加（`type`は`通常起動|割込起動|常時|通常起動+割込起動`）。
- **[src/data/db.ts](src/data/db.ts)**: 新しいDexieテーブル/バージョンは**不要**にした。既存の`meta`テーブル（`{key,value}`の汎用行、bundle metaと同じ流儀）に`ANNOTATIONS_KEY='annotations'`で相乗りさせ、`readAnnotations`/`writeAnnotations`を追加。
- **[src/data/bundle.ts](src/data/bundle.ts)**: `importBundle`で`entries['annotations.json']`を読み（無ければ`{}`）、既存の1トランザクション（cards/images/meta clear→bulkPut）に`writeAnnotations`を相乗り。`loadLibrary()`の返り値に`annotations`を追加（`cards`/`imageUrls`と同じ流儀）。
- **[src/ui/App.tsx](src/ui/App.tsx)**: `annotations`をstateに持ち、`refresh`/`reset`で同期。`<Board>`に`annotations`propとして渡す。
- **[src/ui/board/Board.tsx](src/ui/board/Board.tsx)**: `annotationsOf(cardId)`ヘルパーを追加し、`<DetailPanel>`に`annotationsOf`と`dispatch`を渡す。
- **[src/ui/board/DetailPanel.tsx](src/ui/board/DetailPanel.tsx)**: 本体。詳細は下記。

### DetailPanelの実装

1. **属性の分離表示**（§4.8）: `card.kind === 'c' | 't'`のときだけ「属性: ○○」の行を追加。加えて`card.cost`があれば「召喚コスト: ○○」を別行で表示（両者は別ラベル・混ぜない）。i/e/f/bはattr行を出さず従来通り（コスト側の属性要求のため、指示書§3-4の通り「従来通りでよい」を踏襲）。
2. **起動ボタン**: `annotationsOf(cardId)`から`type !== '常時'`のものだけを抽出し、`{name}（{cost}）`ボタンを並べる。押下で`declareAction`（`kind:'能力', sourceIid:instance.iid, label:能力名, detail:コスト`）をdispatchし、P3a-1/2aのスタックにそのまま乗る。
3. **🚨 ターン非依存の徹底**: ボタンの表示条件は`instance.owner === mySeat && board.mode === 'assist'`のみ。ターン・フェイズによる出し分け／disableは一切入れていない（P4のフェイズ管理が入っても、この判定式を変える必要はない）。
4. **常時能力の可視化（任意実装分）**: 既存の「能力」一覧（`card.abilities`の生テキスト）に、注釈の`name`と一致する見出しがあれば`type`（常時/通常起動/等）の小タグを添えた。⚠️ 実機で確認したところ、`ability-annotations.json`の能力名（例:「料理」「お弁当」）と、LFWIKI由来の`card.abilities[].header`（例:「お出迎え」「イメチェン」）が**カードによっては一致しない**ケースがある（データソースが別系統のため）。一致しない場合はタグが出ないだけで実害はない（起動ボタン自体は`annotationsOf`から独立して出るので影響なし）。
5. **P3a-2aの汎用宣言口は無変更で残存**（`CardContextMenu.tsx`は今回未変更）。

## 検証（2タブ・実機。localhost:5300、ホスト=A/ゲスト=B）

`npm run data:bundle`でannotations入りzipを再生成（`起動能力の注釈: 90 カード / 148 能力`のログを確認）→ DOM経由でファイル入力に投入して実際のインポート経路を通した。

1. **起動ボタン**: 「神岸あかり」をAのリーダーに配置→左クリック→詳細パネルに「属性: 感」「起動」セクションの「お弁当（R）」ボタンが表示。常時の「料理」にはボタン無し（表示もされない＝`annotations`側にしか存在しない名前のため、能力一覧との突合は上記4.の通り別問題）。
2. **起動→スタック→解決の一周**: 「お弁当（R）」を押す→両タブのスタック処理中置き場に`能力/お弁当`（detailに`R`）が同時に乗る（Aは「自分・能力／相手の応答待ち…」、Bは「相手・能力／通す（パス）」）。B「通す」→A「通す」→**両者パスでresolveTopが発火**し、ログに`A が通した／「お弁当」を解決`、両タブとも「（割り込みなし）」に復帰。
3. **ターン非依存＋所有者ゲート**: Bタブで同じ「神岸あかり」（Bから見て相手のカード）を左クリック→「属性: 感」は出るが「起動」セクション自体が現れない（`instance.owner === mySeat`のガードで正しく非表示）ことをDOM実測で確認。ターン管理は未実装のままだが、実装上ターン・フェイズを一切参照していないことをコードレビューでも確認済み。
4. **属性表示**: キャラの詳細に「属性: 感」、召喚コストは別行「召喚コスト: W」で分離表示。混ざっていないことを確認。
5. **非回帰**: annotation未収載のカード（アイテム「あきんどのそろばん」で確認）を手札に置いて詳細を開いても「起動」セクションが出ないだけでクラッシュしない（`召喚コスト: W`は出るが`属性:`行は出ない＝i/e/f/bで意図通り）。P3a-2aの汎用宣言口（右クリ「⚡ スタックに宣言」）は無変更のまま動作を確認。2タブ同期は上記2.で確認済み。コンソールエラー0（`read_console_messages`で両タブとも確認）。
6. `npx tsc --noEmit`・`npm run build`（core隔離チェック＋tsc＋vite build）ともにエラー0。`npm run test:core-priority`（P3a-1の状態遷移テスト）も全件✅のまま非回帰（`core/`を触っていないので当然だが実行して確認）。

## 申し送り（P3a-3・P3bへ）

- **手札ドラッグ自動宣言（P3a-3）**: 今回の「起動」ボタンはあくまで**盤面に出ているカードの起動型能力**用。手札のカード（イベント/アイテム/フィールド/キャラ召喚）をドラッグ&ドロップした瞬間に`declareAction(kind:'プレイ')`を自動発行する部分はまだ未実装（DESIGN §5.1「起動アクションのデータ層」後半の「手札プレイ＝ドラッグで自動宣言」）。
- **コスト自動処理（P3b）**: `annotations[].cost`はラベル表示のみ（例「お弁当（R）」の`R`）。コストプールからの検証・差し引きは未実装。気力系コスト表記（`気力-２`等）も同様にラベルのみ。
- **注釈未収載カード**: i/e/f全種と、校正対象外のキャラ/タッグはannotationsに無いので「起動」セクションが出ない。これらは引き続きP3a-2aの汎用宣言口（右クリ⚡）で手動宣言するか、P3a-3の手札ドラッグ宣言（イベント/アイテム/フィールド側）でカバーする想定。
- **能力名の突合問題（上記4.）**: `ability-annotations.json`の能力名とLFWIKI側`card.abilities[].header`が食い違うカードがある（今回の神岸あかりで実際に確認）。起動ボタン自体の動作には影響しないが、「能力」一覧の常時タグが期待通り出ないケースがある。気になる場合は将来的に注釈データ側の名前をLFWIKI側に合わせて校正し直すか、タグ付けを諦めて外すかの判断が要る（今回はどちらも壊さない形で実装、実害小さいため据え置き）。
- 複合型`通常起動+割込起動`は`type !== '常時'`のフィルタで自然に起動可としてボタンが出る実装（該当カードは今回未確認だが、フィルタロジック上は問題ない）。
