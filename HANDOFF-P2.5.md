# P2.5 引き継ぎメモ — 座席モデル

実施: 2026-07-17 / 作業セッション（P2を担当したセッションを継続。Sonnetのまま）
宛先: 統括セッション

---

## 0. 完了状況

**完了条件6つ、すべて達成。**

| # | 完了条件 | 結果 |
|---|---|---|
| 1 | `core/` に `'me'`/`'opp'` が1つも残っていない | ✅ grep 0件 |
| 2 | `localSeat` が `BoardState` に含まれていない | ✅ `BoardState` は `cards`/`modifiers` のみ。`localSeat` は `useBoard.ts` のReact state |
| 3 | 2タブ検証: 両者が「自分が手前」に見える | ✅ DOM実測（§4） |
| 4 | 相手の手札が伏せて見える | ✅ 双方向で確認（§4） |
| 5 | 双方向の盤面同期がP2から劣化していない | ✅ 実ドラッグで確認（§4） |
| 6 | `npm run build` green、`check-core-isolation` 通過 | ✅ |

---

## 1. `localSeat` をどこに置いたか

**`ui/board/useBoard.ts`** に置いた（`net/session.ts` ではない）。理由:

- `session.ts` は「ホスト権威プロトコル本体」であり、`core/`（`applyAction`/`dispatchHistory`）だけに依存する**UI非依存の純粋モジュール**として P2 で作った。座席の割り当て（ホスト=A/ゲスト=B）は接続の**役割**から機械的に決まるだけで、プロトコルのメッセージング（`hello`/`sync`/`action`/`state`）には一切関与しない。`session.ts` に足すと、本来不要な概念を純粋層に持ち込むことになる。
- `useBoard.ts` は既に `mode`（`solo`/`host`/`guest`）を持っており、`connectHost`/`connectGuest` の成功時点で `localSeat` を確定させるのが最も自然（`connectHost` 成功 → `'A'`、`connectGuest` 成功 → `'B'`、`disconnect` → `'A'` に戻す）。
- ソロ時は `'A'` 既定で、`setLocalSeat` で `'A'`⇄`'B'` を手動切替できる（PHASE2.5.md §2.3 の任意機能。実装した）。ただし**接続中は切替を無効化**している（`modeRef` を見て `mode !== 'solo'` なら `setLocalSeat` が何もしない）。役割で決まった座席をユーザー操作で壊せないようにするため。

`net/session.ts` は今回**一切変更していない**（`NetMessage` にも手を入れていない。座席の割り当ては「役割から自明に導出」で済み、ネゴシエーション用のメッセージは不要だった）。

---

## 2. 改名で触った範囲

`tsc --noEmit` を都度実行し、型エラーが0件になるまで機械的に潰した（PHASE2.5.md §6の推奨どおり）。

| ファイル | 変更 |
|---|---|
| `src/core/board.ts` | `Player`→`Seat`、値を `'me'\|'opp'`→`'A'\|'B'` に変更。`PLAYER_LABEL`（`自分`/`相手`のマップ）を**削除**し、シャッフルのログを座席名（`A`/`B`）に変更 |
| `src/core/actions.ts` | 型 import を `Seat` に追随（ロジック変更なし） |
| `src/ui/board/useBoard.ts` | `localSeat`/`setLocalSeat`/`otherSeat` を追加。`connectHost`/`connectGuest`/`disconnect` で座席を確定・リセット |
| `src/ui/board/Board.tsx` | `mySeat`/`theirSeat` を計算し、`SeatBoard`・`CardPicker`・`CardControls` に配線。ソロ時のみ表示される視点切替ボタンを追加 |
| `src/ui/board/PlayerBoard.tsx` → **`SeatBoard.tsx`にリネーム** | `replace_all` で `PlayerBoard`（関数名）も `SeatBoard` に変わったため、ファイル名も揃えた。`mySeat` propを追加し、手札ゾーンにだけ `hideContents` を渡す |
| `src/ui/board/ZoneBundle.tsx` | `hideContents?: boolean` を追加。手札を伏せる指示をそのまま `CardPiece` に伝える |
| `src/ui/board/CardPiece.tsx` | `hidden?: boolean` を追加。**カード自体の `faceUp`（ゲーム内の表裏）とは独立**に、描画だけ強制的に裏向きにする |
| `src/ui/board/CardPicker.tsx` | `TARGET_ZONES` の決め打ち配列を `mySeat` から動的に組み立てる関数に変更 |
| `src/ui/board/CardControls.tsx` | `mySeat` propを追加し「自分/相手」ラベルの判定に使用。**副次的に見つけた漏洩を修正**（§3） |

---

## 3. 壊れかけた箇所（実装中に発見・修正）

**`CardControls.tsx` の「アイテムを付ける」ドロップダウンが、相手の伏せた手札の中身をそのまま見せてしまうところだった。**

`handCandidates`（付けられるアイテム候補）は `cardsInZone(board, instance.owner, 'hand')` で、選択中のカードの**持ち主**の手札から候補を出していた。これは自分のカードを選んでいる分には問題ないが、**相手の場のカードをクリックしてパネルを開いた場合**、`instance.owner` が相手の座席になり、候補リストに**相手の伏せた手札のカード名がそのまま並んでしまう**。せっかく盤面の見た目では手札を伏せているのに、このドロップダウンだけザル、という状態だった。

修正: `instance.owner === mySeat` のときだけ候補を出すようにした（相手のカードを選んでいるときは、そもそも「手札から選ぶ」の選択肢を出さない）。実機で確認済み（§4「host tab: hasAttachDropdown: false」）。

これは PHASE2.5.md §6 が警告していた「相手の操作で自分の画面の前提が消える」系ではなく、**新しく足した座席分岐が既存のUI要素に思わぬ形で波及した**パターン。座席で描画を分岐させる変更は、影響範囲を機械的なリネームだけでなく「この値、他のどこかで持ち主のデータを引っ張っていないか」まで見直す必要があると実感した。

---

## 4. 検証結果（実機、証拠つき）

前回同様、別のチャットセッションがすでに `leaffight-dev`（ポート5300）を使用中だったため、**このセッション専用に一時的に別ポート（5301）で `vite` を直接起動**して検証した（`.claude/launch.json` や `vite.config.ts` には一切手を入れていない。検証後にプロセスを終了済み）。

`preview_screenshot`/`computer` は今回もタイムアウトしたため、P1/P2と同じ手法（`javascript_tool` での実 `MouseEvent` 発火 + DOM直読み）で検証した。

| 項目 | 結果 |
|---|---|
| ソロ時の視点切替ボタン | ✅ 「視点切替（現在: A）」→クリック→「視点切替（現在: B）」。接続するとボタン自体が消えることを確認 |
| ホスト/ゲスト接続 | ✅ ルームコード発行→参加、双方「接続済み」 |
| **両タブで「自分が手前」** | ✅ DOM構造で実測。ホスト側: 下段(自分)コンテナのdropidが全て`A:*`、上段(相手)が全て`B:*`。ゲスト側: 下段が全て`B:*`、上段が全て`A:*`。**双方が自分の座席を手前に見ている**ことを構造的に証明 |
| **相手の手札が伏せて見える** | ✅ ホストが自分の手札（A）にカードを追加→ホスト画面では名前が見える→**ゲスト画面ではその同じカードが「裏」表示**（名前非表示）。逆方向（ゲストが自分の手札に追加→ホスト画面で「裏」）も確認。同じ `BoardState` を共有していながら、描画だけが視点で分岐していることを確認 |
| CardControlsのラベル | ✅ 自分のカードをクリック→「自分 ・ hand」。相手のカードをクリック→「相手 ・ char」 |
| 攻撃修正の漏洩（§3の修正） | ✅ 相手のカードを選択時、「手札から選ぶ」ドロップダウン自体が表示されないことを確認 |
| **P2同期の非回帰** | ✅ ゲストで実ドラッグ（手札→キャラ枠）→ホストの同じキャラ枠に反映。ホストのログにも「アレイ を 手札 から キャラ へ移動した」が記録される（ゲストのactionがホストの`core/history`を通った証拠） |
| コンソールエラー | ✅ 両タブともゼロ |
| `npm run build` / `check-core-isolation` | ✅ green |

---

## 5. P3への申し送り

- **`activePlayer: Seat` / `awaitingConsentFrom: Seat` / `StackItem.by: Seat` が自然に書けるようになった。** `core/` は既に「A陣とB陣」しか知らない状態なので、DESIGN.md §5.1のデータモデルをそのまま追加できるはず。
- **UIが「自分が求められている」を判定できる形になっている。** `awaitingConsentFrom === mySeat` のような比較が `ui/board/Board.tsx`（`mySeat` を既に持っている）でそのまま書ける。座席の受け渡し経路（`localSeat` は `useBoard.ts` にあり、コンポーネント間は素直にpropsで渡している）もP3の「割り込み確認ダイアログ」にそのまま使えるはず。
- **`net/session.ts` は今回無傷。** P3で `NetMessage` に `declare`/`respond`/`pass`/`resolve` を足すときも、座席まわりの土台を壊す心配はない。
- **CardControlsの漏洩修正（§3）のような「座席分岐が既存機能に波及する」パターンは、P3でスタックUIを作るときにも起こりうる。** 例えば「スタックの中身を見る」ときに相手の手札由来の情報が混ざっていないか、新しいUI要素を作るたびに一度疑う価値がある。

---

## 6. 触ったファイル

```
leaffight/
  src/core/board.ts                 Player→Seat（'me'/'opp'→'A'/'B'）。PLAYER_LABEL削除
  src/core/actions.ts                型追随のみ
  src/ui/board/useBoard.ts           localSeat/setLocalSeat/otherSeat を追加
  src/ui/board/Board.tsx             mySeat/theirSeatの配線、視点切替ボタン
  src/ui/board/PlayerBoard.tsx        削除（→SeatBoard.tsxへ）
  src/ui/board/SeatBoard.tsx          新規（PlayerBoard.tsxのリネーム＋mySeat対応）
  src/ui/board/ZoneBundle.tsx        hideContents prop追加
  src/ui/board/CardPiece.tsx         hidden prop追加（faceUpとは独立の強制非表示）
  src/ui/board/CardPicker.tsx        TARGET_ZONESをmySeat基準の関数に変更
  src/ui/board/CardControls.tsx      mySeat propでラベル判定。attach候補の漏洩を修正
```
