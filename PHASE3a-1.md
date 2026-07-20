# PHASE 3a-1 — 優先権/スタックエンジン（core専用・カード知識ゼロ）

宛先: 実装セッション（Sonnet）。この1枚＋DESIGN §5.1 で着手できる。
統括: 2026-07-18（Opus）。**設計の正は DESIGN §5.1**（本書はそれを実装可能な状態機械に厳密化したもの）。

## 0. これは何 / スコープ

DESIGN §5.1 の「中身を知らない優先権/スタックエンジン」の **core 部分だけ** を作る。**UIは作らない**（P3a-2）。**カードの効果は一切解釈しない**（積む・順番・合意で降ろす、の状態機械のみ）。

**IN（このフェーズ）**
- `StackItem` / `PriorityState` / `mode` のデータ型を共有状態に追加
- 純粋reducer: **declare（宣言を積む）／pass（合意）**、pass の結果 **両者合意で resolveTop（最上段を降ろす）** が自動発火
- 既存の `BoardAction` ユニオン＋`applyAction` に統合

**OUT（やらない）**
- UI（スタック置き場の描画・パスボタン・トリガーボタン・自動パストグル）＝**P3a-2**
- 効果の解決内容・合法性判定（今そのカードで応答可能か、効果がどうなるか）＝**永久にやらない**（§5.1「あえて作らない」）
- 同時処理のアクティブ優先の厳密な並べ替え（§5.1 line: ツールは強制せず人間が並べる）＝**やらない**
- コスト処理（③）＝**P3b** / バトル7段スクリプト＝別フェーズ / ターン・フェイズ管理＝P4

## 1. データモデル（`core/`。カードの中身は知らない）

DESIGN §5.1 の型を実装する。**共有・同期される状態**に置く（`localSeat` は絶対に混ぜない＝§原則）。`BoardState` に生やす：

```ts
export interface StackItem {
  id: string            // 呼び出し側が採番（core は乱数/採番しない）
  by: Seat              // 宣言したプレイヤー
  kind: 'プレイ' | '能力' | 'バトル' | 'その他'
  sourceIid: string | null  // どのカードか（任意・表示用）
  label: string         // 能力名/カード名（表示用。abilities[].header 等）
  detail?: string       // 効果文（表示用のみ。engineは解釈しない）
  note?: string         // プレイヤーの手書き補足（任意）
}

export interface PriorityState {
  stack: StackItem[]              // 未解決の宣言。末尾＝最上段（LIFOで降ろす）
  activePlayer: Seat              // この窓を開いた側（＝手番側の想定）。表示・情報用
  awaitingConsentFrom: Seat       // 今「進めてよいか？」を答える番のプレイヤー
  consentedInARow: Seat[]         // 直近の宣言以降、連続で合意（pass）した記録（13-3-1）
}

// BoardState に追加
//   priority: PriorityState | null   // null＝窓が開いていない（自由操作中）
//   mode: 'assist' | 'free'          // free＝優先権オフ（このengineを使わない）
```
`EMPTY_BOARD` に `priority: null, mode: 'assist'` を足す。

## 2. アクションと遷移（★ここが本体・厳密に）

`BoardAction` に3つ追加：
```ts
| { type: 'declareAction'; item: StackItem }   // 宣言を積む（新規窓 or 割り込みの入れ子）
| { type: 'passPriority'; by: Seat }           // 合意（割り込まない）
| { type: 'setMode'; mode: 'assist' | 'free' } // モード切替
```
`applyAction` に配線し、`core/priority.ts`（新規）に純粋関数として実装（core→core importはOK。ui/net/data/外部は禁止）。

### 遷移規則（`other(s)` = 相手の Seat）

**declareAction(item)** — `item.by` が宣言者：
- `priority === null`（窓が閉じている＝自由操作中）に宣言 → **窓を開く**:
  `priority = { stack: [item], activePlayer: item.by, awaitingConsentFrom: other(item.by), consentedInARow: [] }`
- `priority !== null`（窓が開いている）に宣言（＝割り込み/応答）:
  - ガード: `item.by === priority.awaitingConsentFrom` でなければ**何もしない（不正）**。
  - `stack` の末尾に push、`awaitingConsentFrom = other(item.by)`、`consentedInARow = []`。
  - （宣言は必ず「進めてよいか？」を相手に渡し、連続合意カウントをリセットする）

**passPriority(by)** — `by` が合意：
- ガード: `priority === null` または `by !== priority.awaitingConsentFrom` なら**何もしない**。
- `consentedInARow` に `by` を追加。
- **両プレイヤーが `consentedInARow` に入った**（直近宣言以降、両者が連続合意）→ **resolveTop を発火**:
  - `stack` の末尾（最上段）を pop（＝その担当者が effect を手で解決する合図。engineは中身に関与しない。ログに「〜を解決」を出す）。
  - `consentedInARow = []`。
  - `stack` が空になった → **窓を閉じる**（`priority = null`、自由操作へ）。
  - `stack` が残る → 合意ラウンドを開き直す: `awaitingConsentFrom = other(activePlayer)`。
- **まだ片方だけ合意** → `awaitingConsentFrom = other(by)`（もう片方に「進めてよいか？」を渡す）。

**setMode(mode)** — `mode` をセット。`free` にしたら `priority = null`（窓を畳む）。`free` 中は declare/pass は使われない想定（UIが窓を開かない。P3a-2）。

### 遷移が正しいことの手検算（この通り動くこと）
- **基本**: A declare → awaiting B → B pass（[B]）→ awaiting A → A pass（[A,B]＝両者）→ **resolveTop で item を降ろす** → stack空 → 窓閉じる。✅（＝「両者パス→解決」§13-3-1）
- **入れ子の割り込み**: A declare(itemA) → awaiting B → B declare(itemB)（応答・push・awaiting A・consentリセット）→ A pass([A]) → awaiting B → B pass([A,B]) → **itemB を降ろす（LIFO）** → stack=[itemA]残 → awaiting other(active=A)=B → … → itemA も同様に降りて窓閉じる。✅
- **不正**: awaiting が B の時に A が pass/declare → 無視。✅

## 3. core 隔離・純粋性（`scripts/check-core-isolation.mjs` が止める）
- `core/priority.ts` は **ui/net/data/外部パッケージを import しない**。
- **乱数・時刻を持たない**。`StackItem.id` は呼び出し側が採番して渡す（既存の iid 方針と同じ）。
- 返り値は既存の `Result`（`{ state, log }`）に合わせる。ログ文言は日本語で簡潔に（例: `A が「調べる」を宣言`, `B が通した`, `「調べる」を解決`）。

## 4. 検証（core は純粋なので状態機械を直接テストできる）
- **遷移シナリオを実行して assert**（§2の手検算3ケース＋モード切替を最低限）。方法は実装判断: vitest を足す（devDep追加はCLAUDE.mdのシステム変更ログに記録）／もしくは `npx tsx` 等で純粋関数を直接叩くスクリプト。**現物で状態遷移が一致することを示すこと**（報告に before→after のstate断片を載せる）。
- `npm run build`（`check-core-isolation` ＋ `tsc`）がエラー0。
- 既存の盤面操作（spawn/move/attach 等）に一切影響が無いこと（priority/mode を足しただけ、既存reducerは不変）。

## 5. 完了報告（統括へ）
`HANDOFF-P3a-1.md` 1枚。追加した型、`priority.ts` の遷移実装、検証シナリオの実測（state遷移）、core分離チェック通過、既存機能非回帰。設計判断で迷った点（例: resolveTop後の `awaitingConsentFrom` の開き直しを `other(activePlayer)` にした是非）は申し送りに。

## 6. 申し送り（次フェーズの布石）
- P3a-2（UI）でこの `priority` を読んで「スタック処理中置き場」に描画し、パスボタン＝`passPriority`、詳細パネルのトリガーボタン＝`declareAction` を発行する。**engineは既にあるので、UIは状態を見て投げるだけ**にできる設計。
- §6通信は既に「順序つき・応答つき」の器がある（DESIGN §6）。`declareAction/passPriority` はその上に自然に乗る。ホスト権威で `priority` を同期すること。
- 同時処理のアクティブ優先の厳密順（11-2-2）は**engineで強制しない**方針（§5.1）。もし実機で人間の並べ替えが煩雑と分かれば、その時に統括判断で足す（今は入れない）。
