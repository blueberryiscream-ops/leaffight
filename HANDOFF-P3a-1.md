# HANDOFF-P3a-1 — 優先権/スタックエンジン core部分 完了報告

宛先: 統括セッション。実装: Sonnet（本セッション）。

## やったこと

DESIGN.md §5.1 の「中身を知らないスタック/優先権エンジン」の **core 部分のみ** を実装。UIなし（P3a-2で）。効果の解決内容・合法性判定・コストは一切扱っていない。

### 追加した型・ファイル

- **[src/core/priority.ts](src/core/priority.ts)**（新規）: `StackItem` / `PriorityState` / `Mode` の型と、純関数 `declareAction` / `passPriority` / `setMode` / `other`。core→core import のみ（`./board` から `Seat` を型import）。乱数・時刻なし。`StackItem.id` は呼び出し側採番。
- **[src/core/board.ts](src/core/board.ts)**: `BoardState` に `priority: PriorityState | null` と `mode: Mode` を追加。`EMPTY_BOARD` に `priority: null, mode: 'assist'` を追加。`cloneBoard` がこの2フィールドを引き継ぐよう修正（既存カード/modifiers操作は不変のまま素通しするだけ）。
- **[src/core/actions.ts](src/core/actions.ts)**: `BoardAction` に `declareAction` / `passPriority` / `setMode` を追加し、`applyAction` に配線（`priorityEngine.*` を呼んで `state.priority`/`state.mode` を更新するだけの薄いラッパー）。

### 遷移実装（PHASE3a-1.md §2 通り）

- `declareAction`: 窓が閉じていれば新規オープン（`activePlayer = item.by`, `awaitingConsentFrom = other(item.by)`）。窓が開いていれば `item.by === awaitingConsentFrom` をガードし、push + `awaitingConsentFrom` 反転 + `consentedInARow` リセット。不正なら何もしない（stateそのまま、log空）。
- `passPriority`: `by === awaitingConsentFrom` をガード。片方だけ合意なら `awaitingConsentFrom` を渡す。両者連続合意なら **resolveTop**: 最上段pop → stack空なら窓閉じる（`priority = null`）、残るなら合意ラウンドを `awaitingConsentFrom = other(activePlayer)` で開き直す。
- `setMode`: `free` にしたら `priority = null`。`assist` への切替では現在の `priority` をそのまま維持（仕様に明記はないが、free中は元々priorityがnullのはずなので実害はなく、「assist再入で開いてる窓を誤って畳む」事故を避けるため。§6の申し送り参照）。

## 検証（現物で状態遷移を実測）

`core` が純粋なので、`vitest` は追加せず **Node 25 のネイティブTS型剥がし**（`node scripts/test-core-priority.ts`）で直接叩くスクリプトにした。**devDependency追加なし＝システム変更ログへの記載も不要**と判断。

- 拡張子省略のcore内import（`from './board'`。tsconfig `moduleResolution: bundler` 前提）をNode ESMが解決できないため、テスト専用の最小ローダ [scripts/ts-extensionless-loader.mjs](scripts/ts-extensionless-loader.mjs) を追加（`.ts`補完のみ。ビルド本体には無関係）。
- 実行コマンド: `npm run test:core-priority`（package.jsonに追加）。

実測ログ（全件✅、抜粋）:
```
log: A が「調べる」を宣言
✅ ケース1: declare後はBが応答待ち
log: B が通した
✅ ケース1: B pass後はAが応答待ち／consentedInARowに[B]
log: A が通した／「調べる」を解決
✅ ケース1: 両者pass後にresolveTopが発火しstack空→窓閉じる

log: B が「itemB」を宣言（LIFOでpush、awaiting=A、consentedInARowリセット）
log: B が通した／「itemB」を解決（itemAのみ残る、awaiting=other(activePlayer=A)=B）
log: A が通した／「itemA」を解決（stack空→窓閉じる）

✅ ケース3: awaitingでない側のpass/declareは無視される（state不変・log空）

log: フリーモードに切り替えた → priority=null, mode=free
✅ assistに戻すと mode=assist, priority=null（維持）

✅ 非回帰: spawnCardはpriority/modeに触れず、従来通りカードを追加する
```
（PHASE3a-1.md §2 の手検算3ケース＋モード切替＋既存reducer非回帰、全てassert通過）

- `npm run build`（`check-core-isolation` + `tsc` + `vite build`）→ **エラー0**。
- `check-core-isolation.mjs` 通過（`priority.ts` は `./board` のみimport、外部/ui/net/data importなし）。
- 既存の盤面操作（spawn/move/attach等）は無変更。`BoardState` に2フィールド追加しただけで、既存の全reducerは `cloneBoard` 経由でそのまま値を引き継ぐのみ。

## 申し送り・設計判断で迷った点

1. **resolveTop後の `awaitingConsentFrom` の開き直しを `other(activePlayer)` にした**（指示書通り）。`activePlayer` は「窓を開いた側」で固定（入れ子の割り込みでも変わらない）。ケース2で検証済み: itemA(by=A)がactivePlayer、itemB解決後の再オープンは `other(A)=B` から。指示書の意図と一致していると判断したが、実機で「itemBの宣言者(B)から再開すべきでは」という違和感が出たら要相談（今回はDESIGN §5.1の「アクティブP優先」解釈に忠実に振った）。
2. **`setMode('assist')` は現在の `priority` を維持する**実装にした（指示書は「freeにしたらnull」しか明記していない）。free中はUIがdeclare/passを発行しない想定（PHASE3a-1.md §2末尾）なので実質差は出ないはずだが、仕様の行間を埋めた判断として記録。
3. **不正操作（awaiting でない側の宣言/pass）は「何もしない」＝ `state` をそのまま返す**実装（`log: ''`）。呼び出し側（将来のUI/net）がこの空logを「無視された」の合図として使える設計にしている。

## 次（P3a-2への引き継ぎ）

- `priority` を読んで「スタック処理中置き場」を描画し、パスボタン＝`passPriority`、トリガーボタン＝`declareAction`を発行するUIを作るだけで良い状態（engine側は完成）。
- `StackItem.label/detail` は `abilities[].header/text` を渡す想定（DESIGN §5.1「起動アクションのデータ層」）。core側はラベルの中身を一切解釈していないので、そのまま渡せる。
