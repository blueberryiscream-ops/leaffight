# PHASE 3a-1r — 優先権エンジン＆表示の作り直し（正しいモデルへ）

宛先: 実装セッション（Sonnet）。この1枚＋**DESIGN §5.1（先に必ず読む）**で着手。
統括: 2026-07-19（Opus）。**旧P3a-1のモデルが誤りだったため作り直す**（DESIGN §5.1「モデルの訂正」参照）。

## 0. なぜ作り直すか（要点）

旧`core/priority.ts`は「`stack: StackItem[]` に宣言を積み続け、両者パスで最上段をLIFOで降ろす」＝MTG寄りの**誤ったモデル**だった。原典§11-2/§13の正しいモデルは：
- **1つのアクション窓で各プレイヤー最大1宣言＝2枠**（積み上がる山ではない）。
- **処理順は固定：アクティブP → 非アクティブP**（LIFOではない）。
- **入れ子＝ある処理の途中で《○○とき》が開き、そこで割り込み型が1＋1で走る再帰**（フレームのスタック）。

## 1. スコープ

**IN**: `core/priority.ts`（エンジン）と`StackPanel.tsx`（表示）を新モデルに作り直す。既存の呼び出し側（`declareAction`を投げる`CardContextMenu`/`DetailPanel`、`passPriority`の「通す」ボタン）を新アクションに追従。
**OUT**: 効果の解決内容・合法性判定（永久にやらない）／割り込み自動検出（トリガー種別注釈が校正中。DESIGN §5.1煩雑さ対策・別フェーズ）／バトル7段のタイミング窓状態機械（別フェーズ）／コスト（P3b）。

## 2. データモデル（`core/priority.ts`・カード知識ゼロ）

DESIGN §5.1 の型を、状態が一意に決まるよう`step`で明示する：

```ts
export interface DeclaredAction {
  by: Seat; sourceIid: string | null;
  kind: 'プレイ' | '能力' | 'バトル' | 'その他';
  actionType: '通常型' | '割込型';
  label: string; detail?: string;
}
export type WindowStep = 'awaitActive' | 'awaitNonActive' | 'processActive' | 'processNonActive'
export interface ActionWindow {
  active: DeclaredAction | null;      // アクティブPの宣言
  nonActive: DeclaredAction | null;   // 非アクティブPの同時アクション
  step: WindowStep;                   // 窓の進行段階（下記）
}
export interface Priority {
  frames: ActionWindow[];  // 窓のスタック（入れ子）。末尾=現在の窓。通常1個、割り込みで数段。
  activePlayer: Seat;      // 手番側＝処理順の優先（当面は最初に窓を開いた側で代用。ターン管理はP4）
}
// BoardState は priority: Priority | null（null＝窓なし）と mode: 'assist'|'free' を持つ（既存）
```
⚠️ 旧`PriorityState`（`stack`/`awaitingConsentFrom`/`consentedInARow`）と旧`StackItem`は**削除**。旧盤面が旧shapeの`priority`を持っていても壊れないよう、読込側は「`frames`が無い形はnull扱い」にする（§6 移行）。

## 3. 状態遷移（★本体・厳密に。純粋関数＋単体テスト）

`other(s)`=相手席。現在の窓＝`frames`の末尾。「両者が行動済み」＝active/nonActiveの担当がそれぞれ宣言orパス済み。

### アクション（`BoardAction`に配線）
```ts
| { type: 'declareAction'; action: DeclaredAction }  // 宣言（窓を開く/枠を埋める/割り込みで入れ子）
| { type: 'passPriority'; by: Seat }                 // 宣言せずパス
| { type: 'resolveStep' }                            // 現在の処理段階を人間が解決→次へ
| { type: 'setMode'; mode: 'assist' | 'free' }       // 既存
```

### declareAction(action)
- **priority===null**（窓なし）→ 新規窓を開く。`activePlayer = action.by`（開いた側＝手番側の代用）。
  `frame = { active: action, nonActive: null, step: 'awaitNonActive' }`（アクティブが宣言済み、次は非アクティブの機会）。
  ※非アクティブ側が先に開く場合（相手ターンでの割り込み）もあるが、当面は「開いた側をactive扱い」で可。実機で不自然なら統括に返す。
- **現在窓.step==='awaitActive' かつ action.by===activePlayer** → `active=action`、`step='awaitNonActive'`。
- **現在窓.step==='awaitNonActive' かつ action.by===other(activePlayer)** → `nonActive=action`、宣言フェーズ終了 → `step= active ? 'processActive' : 'processNonActive'`。
- **現在窓.step が processActive/processNonActive のとき declareAction**（＝処理中の割り込み）→ **入れ子で新しい窓をpush**（上記「新規窓」と同じ要領。`activePlayer`は据え置き）。解決したら親に戻る。
- 上記いずれにも当てはまらない（手番でない等）→ **何もしない**（不正、log空）。

### passPriority(by)
- **step==='awaitActive' かつ by===activePlayer** → active宣言なし → `step='awaitNonActive'`。
- **step==='awaitNonActive' かつ by===other(activePlayer)** → nonActive宣言なし → 宣言フェーズ終了。
  - active/nonActive 両方null（誰も宣言しなかった）→ **窓を閉じる**（frameをpop。framesが空ならpriority=null）。§13-3-1（両者不作為→前進）。
  - どちらか宣言あり → `step= active ? 'processActive' : 'processNonActive'`。
- それ以外 → 何もしない。

### resolveStep()（人間が「この処理を解決した」）
- **step==='processActive'** → activeのアクションを解決済みとする → `step= nonActive ? 'processNonActive' : (窓を閉じる)`。
- **step==='processNonActive'** → 解決済み → **窓を閉じる**（pop。空ならpriority=null）。
- 窓を閉じた後、親フレームが残っていればそのstepの続きから。

### setMode(mode)
- `free`→`priority=null`。`assist`→現状維持（既存踏襲）。

### 手検算（この通り動くこと・単体テストで assert）
1. **基本（自分だけ）**: A declare→step awaitNonActive→B pass→active有/nonActive無→processActive→resolveStep→窓閉じる。
2. **1＋1**: A declare→B declare→processActive→resolve→processNonActive→resolve→閉じる（アクティブ→非アクティブ順）。
3. **入れ子**: 上の processActive 中に B が declare→新フレームpush→その窓を1〜2で解決→pop→親のprocessActiveに戻る。
4. **誰も宣言せず**: A pass→B pass→窓閉じる（§13-3-1）。
5. **不正**: 手番でない側のdeclare/passは無視。

## 4. 表示の作り直し（StackPanel.tsx）

- **縦長リストを廃止**。**基本2枠：自分の宣言／相手の宣言**（現在フレームの active/nonActive を、localSeat視点で「自分/相手」に振り分けて表示）。空枠は「（宣言なし）」。
- **現在の`step`で操作を出し分け**：
  - awaitActive/awaitNonActive で `awaiting===localSeat` なら「通す（パス）」ボタン（＝`passPriority`）。宣言は既存のトリガーボタン/宣言口（`declareAction`）。相手待ちなら「相手の応答待ち…」。
  - processActive/processNonActive で、その担当が localSeat なら「解決（完了）」ボタン（＝`resolveStep`）。人間が効果を手で処理してから押す。相手の処理待ちなら待機表示。
- **入れ子**は現在フレーム（最内）を表示し、深さがあれば「割り込み処理中（N段）」の小表示。深さは通常浅い。
- 自動パストグルは維持（awaiting が自分になったら自動`passPriority`。バトル宣言で自動オフの第一版も維持）。**⚠️ resolveStep は自動化しない**（人間の解決確認）。
- レイアウトA/B両方の「スタック処理中置き場」枠に、この2枠版を入れる（枠自体はP2.10で確保済み・縦長でなくなるので余白が出る→レイアウト調整はP2.10側で別途）。

## 5. 呼び出し側の追従
- `CardContextMenu.tsx`「⚡スタックに宣言」/ `DetailPanel.tsx` トリガーボタン → `declareAction` の payload を新`DeclaredAction`に（`actionType`を付ける。トリガーボタンは能力の型から`通常型`/`割込型`、汎用宣言口は`通常型`暫定）。
- `StackPanel` の「通す」= `passPriority`、「解決」= `resolveStep`。

## 6. 移行・非回帰
- **旧盤面対応**: `useBoard` は既に `{...EMPTY_BOARD,...saved}` で補完済み（priority:null）。加えて、万一 saved.priority が旧shape（`stack`を持つ）だった場合に備え、**読込時に「`priority`に`frames`が無ければ null に落とす」** 正規化を入れる（`data/db.ts` の readBoardState か useBoard で）。
- `EMPTY_BOARD` の `priority:null`/`mode:'assist'` は維持。
- `npm run test:core-priority` を新モデルの遷移テストに置き換え（§3の手検算5ケース）。build（core隔離＋tsc）緑。既存の盤面操作・同期・レイアウトA/B・トリガーボタンの非回帰。

## 7. 検証（2タブ実機＋単体テスト）
- 単体: §3の5ケースを assert。
- 2タブ: 神岸あかり「お弁当」宣言→2枠に出る→相手が通す→自分が解決→窓閉じる。1＋1（両者宣言→アクティブ→非アクティブ順で解決）。入れ子（処理中に相手が割り込み宣言→一段深い窓→解決→戻る）。モード切替。console0/tsc/build緑。

## 8. 完了報告
`HANDOFF-P3a-1r.md`。新データモデル、遷移実装、単体テスト結果、2枠表示の実測、入れ子の実測、旧盤面移行の確認、非回帰。設計判断の迷い（activePlayer暫定の是非等）は申し送り。
