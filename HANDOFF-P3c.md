# HANDOFF-P3c — 割り込み自動検出 v1（既存操作フック範囲） 完了報告

宛先: 統括セッション。実装: Sonnet（本セッション）。P3a-1r（優先権エンジン新モデル）/ P3a-2b（注釈bundle同梱）完了が前提。

## やったこと

DESIGN.md §5.1「⭐割り込み自動検出」の第一版。既存の自動化操作（宣言/解決・気力増減・手札→ゴミ箱）をフックにして、原典60種の正規タイミングのうち約36件を導出し、「候補が1件以上あるプレイヤーにだけ通知を出す」を実装した。

### 🚨 設計上の重要な判断: アクションではなく状態差分から導出する

指示書§2は「declareAction/resolveStep等の**操作**からタイミングを導出する」フック表だったが、実装は**BoardAction ではなく before/after の BoardState 差分**から導出する設計にした。

理由: DESIGN §6の通信設計は「ゲストは結果のstateを丸ごと受け取るだけで、元のBoardActionは見えない」（`{kind:'state', state}` のみ配信、アクション自体は配信しない）。もしタイミング導出がBoardActionに依存する実装だったら、**ゲスト側では動かない**（ホストの操作をゲストが検出できない）。状態差分ベースにしたことで、ホスト/ゲストどちらでも同一ロジックで同じ通知が出る（実機の2タブ検証で確認済み）。

この設計変更に伴う副作用（申し送り）:
- `adjustKiryoku`/`toTrash`等のBoardActionには元々「操作者(by)」フィールドが無い（誰でも押せる汎用操作のため）。ネットワーク越しに「誰が操作したか」を追跡する手段が無いので、**気力増減・手札ゴミ箱系のイベントのactorは「対象カードの持ち主」で代用**した。現行の割り込み注釈データ（ダメージ/ダウン系）はいずれも`相手が`/`自分が`スコープを使っておらず、`味方キャラが`等のtargetIid基準スコープのみを使うため実害は無いことをデータで確認済み（`_local/interrupt-annotations.json`の該当エントリを全件確認）。将来、気力系に`相手が`/`自分が`スコープの注釈が追加された場合はこの割り切りの見直しが必要（[core/timing.ts](src/core/timing.ts)にコメントで明記済み）。
- 宣言/解決（declareAction/resolveStep）系は`DeclaredAction.by`がpriority状態に埋め込まれて同期されるため、こちらは正確なactorを取れる（実装上の非対称。コメントで明記）。

### 触ったファイル

**データ経路（P3a-2bと同じ流儀）**
- [scripts/build-data-bundle.mjs](scripts/build-data-bundle.mjs): `_local/interrupt-annotations.json`（54件）を`kind+'_'+norm(card)`キーのオブジェクトに変換し、zipに`interrupts.json`として追加。1カード複数件は配列で束ねる。生成ログに件数を追加（実測: **51カード/54件**）。
- [data/types.ts](src/data/types.ts): `InterruptAnnotation{ability,cost,subject,timings}` / `InterruptsMap` を追加。
- [data/db.ts](src/data/db.ts) / [data/bundle.ts](src/data/bundle.ts): `annotations`と同じ`meta`テーブル相乗りで`readInterrupts`/`writeInterrupts`。`loadLibrary()`の返り値に`interrupts`を追加。
- [ui/App.tsx](src/ui/App.tsx) → [ui/board/Board.tsx](src/ui/board/Board.tsx): `interrupts`state/propを新設し、`StackPanel`の2箇所の呼び出しに`cardOf`/`interrupts`を追加で渡した。

**§2 フック表（新規・core専用）**
- [src/core/timing.ts](src/core/timing.ts): `TimingEvent{timing,actor,targetIid}` と `deriveTimingEvents(before, after, cardKindOf)`。宣言/解決は`Priority.frames`の差分から検出（`detectDeclared`/`detectResolved`）、気力増減はカード全走査で`kiryoku`の減少/増加を検出（減少かつ1→0以下でダウンも追加発火）、手札→ゴミ箱は`zone`遷移で検出。カード種別（c/t/b/i/e/f）はcoreが持たないため、`cardKindOf`という呼び出し側供給の関数で解決する（core隔離を維持）。

**§3 主語スコープ照合（新規・data層）**
- [src/data/interrupt.ts](src/data/interrupt.ts): `findInterruptCandidates(event, viewer, board, interrupts)`。指示書§3の表（相手が/自分が/味方キャラが・自分のキャラが/このキャラが/このアイテムを装備したキャラが/なし）をそのまま実装。候補範囲は「viewer所有かつzone≠deck/trash」（盤面・手札・装備アイテムに相当。装備アイテムはattach()が`zone`を変えない実装のため実質`hand`のまま残ることを確認して対応）。
  - ⚠️ **core/に置かなかった**: `InterruptAnnotation`はdata層の型であり、core/はui/net/dataをimportできない（DESIGN §3）。BoardStateとInterruptAnnotationの両方を要る照合ロジックはdata/側に置いた（data→coreのimportは既存の`data/db.ts`等と同じで問題ない）。

**UI（"提案"のみ・エンジン無改造）**
- [ui/board/useInterruptNotices.ts](src/ui/board/useInterruptNotices.ts)（新規フック）: `board`の変化を`useRef`で前回スナップショットと比較し、`deriveTimingEvents`→`findInterruptCandidates`（`localSeat`視点）で通知を組み立てる。**候補0件のイベントは通知化しない**（＝目的そのもの）。`mode==='free'`では検出自体スキップし、free切替時に既存の通知も畳む。
- [ui/board/StackPanel.tsx](src/ui/board/StackPanel.tsx): `InterruptBanner`コンポーネントを追加し、優先権窓なし/ありどちらの表示ブロックにも差し込んだ（＝「StackPanelの近く」を、実質StackPanel内の最上部にした）。候補クリック→`declareAction`（`actionType:'割込型'`、カード種別が`e`なら`kind:'プレイ'`、それ以外は`kind:'能力'`）を発行し、既存の優先権フローにそのまま乗る。通知は個別に✕で閉じられる。

### core/priority.tsは無改造
`declareAction`/`passPriority`/`resolveStep`は一切触っていない。`git status`で`src/core/priority.ts`が差分に出ていないことを確認済み。

## 検証

### 単体テスト（`npm run test:timing`・新規）

[scripts/test-timing.ts](scripts/test-timing.ts)。§2フック表6パターン＋非回帰1件、§3主語スコープ6種＋非回帰3件、**全件✅**。

### 2タブ実機（localhost:5300、A=ホスト/B=ゲスト）

準備: Aに神岸あかり(leader・お弁当ボタンあり)・河島はるか(手札)・セバスチャン(手札)・衣装・鎧(手札→神岸あかりに装備)。Bに河島はるか(手札、Aの同名カードとの対比用)。

1. **相手がスコープ／特殊能力を使用したとき**: Aが「お弁当」を宣言→B通す→A解決（＝《特殊能力を使用したとき》発火、actor=A）。**Bにだけ**「《特殊能力を使用したとき》— 割り込める札があります: すっとぼけ（河島はるか/W）」が出現。**Aには出ない**（A自身も同名カードを持つが、`相手が`は`actor!==owner`が条件でA自身の宣言では成立しない＝正しくスコープが効いている）。
2. **候補クリック→優先権フローに合流**: Bが通知の「すっとぼけ」をクリック→`declareAction`（割込型）が発行され、両タブのStackPanelの2枠にそのまま乗った（自分の宣言／相手の宣言表示・パス/解決ボタンとも正常）。解決すると窓が閉じ、**Aにも新たな通知**（「Bが特殊能力(すっとぼけ)を使用したとき」→今度はA自身の河島はるかコピーが`相手が`条件でBの行動に反応）が出た。これは実装ミスではなく、割り込みの割り込みが連鎖しうる正しい挙動（人間が判断してクリックしなければ何も起きない）。
3. **味方キャラがスコープ／ダメージを受けるとき**: A自身の神岸あかりの気力を-1→Aに「《ダメージを受けるとき》— 割り込める札があります: 肉のカーテン（セバスチャン/R）」が出現（Bには出ない）。
4. **このアイテムを装備したキャラがスコープ**: 同じダメージ操作で、装備済みの衣装・鎧も**同時に別の通知**として「《ダメージを受けたとき》— 割り込める札があります: (カード効果)（衣装・鎧/）」が出現（1回の操作から複数タイミングが同時発火し、それぞれ独立した通知になることを確認）。
5. **候補0件なら静か**: 神岸あかりの気力を+1（回復）→どちらのタブにも通知が出ない（保有カードの中に《気力を回復させる効果が発生したとき》の注釈を持つカードが無いため）。これが今回の目的の中核。
6. **free modeでは出さない**: モードをフリーに切替→起動ボタン・⚡宣言口が消えるのと同時に、ダメージ操作をしても通知が一切出ないことを確認。アシストに戻すと通知検出が再開。
7. レイアウトA/B両方で`InterruptBanner`がStackPanel内に正しく表示されることを確認。両タブともコンソールエラー0（全ステップで`read_console_messages`確認）。
8. `npx tsc --noEmit`・`npm run build`（core隔離チェック＋tsc＋vite build）ともにエラー0。`npm run test:core-priority`（P3a-1rの遷移テスト）も全件✅のまま非回帰。

## 申し送り（v2へ）

1. **actorの割り切り**（上記「設計上の重要な判断」参照）: 気力/ゴミ箱系イベントのactorは対象カードの持ち主で代用。将来この系統に`相手が`/`自分が`スコープの注釈が入ったら、ネットワーク越しの真の操作者追跡（プロトコル拡張が要る）を検討する必要がある。
2. **v1未対応**: バトル固有13件（バトル7段の状態機械待ち）・フェイズ3件（P4）・コスト4件（P3b）・「〜するとき」の厳密な事前割り込み（現状は事後検出、Undoで戻して割り込む運用）。指示書§7の通りそのまま持ち越し。
3. **候補クリックのkind判定**は`cardOf(candidate.cardId)?.kind==='e' ? 'プレイ' : '能力'`という簡易判定。i/f種別の割り込み候補（衣装・鎧のようなアイテム、アンチ・イベント等のフィールド）は現状すべて`'能力'`扱いになる。今回のデータでは実害無し（f種別3件はいずれもフェイズタイミングでv1では発火自体しない）が、i種別の候補が増えたら見直しの余地がある。
4. **通知の同時多発**: 1回の操作で複数のタイミング（ダメージが発生したとき/を受けるとき/を受けたとき等）が同時に発火する場合、各タイミングごとに独立した通知ボックスが並ぶ実装にした（統合しない）。実機で数が多いと感じたら、統括判断で「同一操作由来はまとめて1枠」に変更する余地がある。
5. **候補の並び順**は`Object.values(board.cards)`の走査順（挿入順に依存）。決定論的だが「意味のある順」ではない。実機で気になれば統括判断でソート基準を足すとよい。
