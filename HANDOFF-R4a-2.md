# HANDOFF-R4a-2: Part A（§3 の1〜5）完了・6〜12は未着手 — 実装担当の報告

2026-09-27。指示書 `PHASE-R4a-2.md`。担当は **Part A（§3 の 1〜12）**。結論から: **§3-1〜5 が完了**（D24 吸血のロボ除外・
D25(c) tested判定の強化・D21 generateCost・D22 サクリファイス・D16 世話焼き）。**§3-6〜12（hijack・呼び出し・パーティ・
借金取り・おあずけ・正式gate・残りの単体テスト）は未着手**。ツール呼び出しが150回に迫ったため、区切りのよいところ
（5項目ぶん・全部コミット済み・verify緑）で止める。

## 冒頭の数

- 対象30件（`_local/rules/faq/_r4a-scope.json`）: **✅19／保留10／❌1**（`_r4a-result.json` を `node -e` で数え直し）
  - 開始時点（統括13時点）: ✅16／保留13／❌1
  - このセッションで **+3✅**（faq-233・1608 は既に✅だったものの盤面をロボ回避に直しただけ・実質は
    faq-908修正の後追い。新規に✅になったのは faq-3217・faq-2546・faq-4096・faq-4099・faq-4102 の5件だが、
    統括13時点の✅16に4096・4102は既に含まれていたため、正味 +3）
- tested の数: **前 54（D25(c)強化前）→ 4**（D25(c) を先に実装したため。`faqReview` が全カード未着手＝Part B 前提の
  「減るのは安全側」どおり。詳細は下記 §3-2）
- `npm run verify` **EXIT 0**（各コミット後に確認済み）
- R2a 57✅・保留1／R2b 37✅／R3 18✅ は不変（下げていない）
- コミット（親リポジトリ、`Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` 付き）:
  - `1712c91` §3-1: D24 吸血のロボ除外
  - `afdb93a` §3-2: D25(c) tested判定を強める
  - `734a3c8` §3-3・3-4: D21 generateCost・D22 サクリファイス
  - `412ce03` §3-5: D16 可変の使用代償（世話焼き）
- コミット（`_local/rules/`）:
  - `f9d1f00` §3-1・`0319312` §3-2・`3162c5a` §3-3・3-4・`e7d616b` §3-5

## §3 それぞれの状況

### 1. D24 吸血のロボ除外 — 完了
- `src/engine/ctx.ts` の `CardInfo` に `charTypes?: string[]` を足し、`src/ui/engine/host.ts`・`scripts/lib/faq-run.ts` の
  CardInfo 構築（データ層から渡す経路）に通した
- `src/engine/dsl.ts` に `Cond { charType: [CardRef, string] }`、`src/engine/eval.ts` の `evalCond` に判定を足した
  （`hasAttr` と同じ形）
- `_local/rules/cards/c_ルミラ.ts`「吸血」の対象選択に `where: { not: { charType: [it, 'ロボ'] } }` を追加
- faq-908・233・1608 が対象（セリオ＝ロボを使っていた盤面）。faq-908 は統括12が既に直していた
  （`d3deca5`）。**faq-233・1608 の盤面もロボ（セリオ）を使っていたため、このセッションで同様にロボでない
  キャラ（エリア・松原葵）へ差し替えた**（`_local/rules/tools/authored/宣言と処理の段.mjs`・`穴の根拠.mjs`。
  論点・期待は変えていない。差分は上の「§3 それぞれ」の diff 確認済み）
- 単体テスト: `scripts/test-engine-host.ts` ㉑（charType 除外の Selector がロボを候補から外すことを確認）

### 2. D25(c) tested判定を強める — 完了
- `src/engine/dsl.ts` の `CardDef` に `faqReview?: Record<string, { v: 'case'|'ok'|'manual'|'na'; why?: string }>` を追加
- `_local/rules/tools/tested.ts` を書き直し: `computeTested(root)` を export する関数に分離（直接実行時だけ
  `_tested.json` を書いて要約を出す。`scripts/test-faq.ts` から import して使う二重利用）。判定は
  「そのカードが `_index.json` に登場する FAQ を faqReview が全部含み（'case'/'ok'/'manual'/'na' のどれか）・
  manual が無く・関係する T ケースが全部✅（manual なし）」のときだけ `tested`。関係 T ケースが0件なら
  faqReview が揃っていても `draft` のまま（D25(c) 明記どおり）
- `scripts/test-faq.ts` の最後に `tested の数: tested X／draft Y／manual Z（faqReview が足りなくて tested に
  なれなかった枚数: N）` を出すようにした
- **副作用（想定内・報告のとおり）**: 全カード89枚のうち `faqReview` を埋めたのは今回書いた／触った5枚
  （c_ルミラ・f_サクリファイス・e_臨時収入・c_澤倉美咲・c_高瀬瑞希）だけなので、tested は 54→4 に激減した。
  これは D25(c) の「Part B が終わるまで tested の数は減ってよい（減るのは安全側）」どおりで、想定内

### 3・4. D21 generateCost・D22 サクリファイス — 完了
- 新しい `Op { op: 'generateCost'; who?: PlayerRef; icons: CostIcon[] | { callCostOf: CardRef; extra?: CostIcon[] } }`
  （固定の並び、またはカードの印刷コストを参照）
- core に `ProcAction 'procGenCost'`（`src/core/proc.ts`）を足し、発生したコストを **frameId 無し**（7-3「その他の
  代償」としてすぐ使える）で `state.costs` に足す。engine 側は `src/engine/drive.ts` の `execOp` に `'generateCost'`
  ケースを足し、`{callCostOf}` のときは `src/core/types.ts` の `parseCost` でカードの印刷コスト文字列を読む
- `Selector` に `fromSlot?: string` を足した（`src/engine/dsl.ts`・`src/engine/eval.ts`）。`forEach` で
  「宣言時に選んだ複数のうち、いまその zone にあるもの」を絞れる。**D22 サクリファイスの「実際にダウンした
  キャラだけ」に使った**: `down` の後 `forEach { zone:'trash', side:'you', fromSlot:'v' }` で、cancelDown
  （働き者・執念）で打ち消されずゴミ箱に着地したキャラだけに `generateCost` する
- `_local/rules/cards/e_臨時収入.ts`（新規）: 本文2文のうち「[WWW]を発生する」（通常型）だけ実装。
  「コストを発生するときに使うこともできる」（割込型・7-2[3] への統合）は **未実装**（下記「持ち越し」参照）。
  2つ目の ability を `kind:'manual'` にして明示、`faqReview` で faq-967・2956・2959・4189 を `'manual'`、
  faq-314・321・3320 を `'na'`（臨時収入自身の記述ではなく他カードの制限を答えるものと判断）にした
- `_local/rules/cards/f_サクリファイス.ts`: manual を解消。`faqReview` は4件とも `'case'`
- **副産物の修正**: `scripts/lib/faq-run.ts` の `autoStep` が、`min===0`（そもそも使うかどうかを聞く最初の
  選択・optionalFirst）でも既定で1件選んでしまうバグを直した。これが faq-4099 で `eachPlayer` の相手側が
  意図せずサクリファイスを使い、rio が（望まない）ボーナスドローで手札に戻る原因だった（統括12の指摘
  「働き者の moveTo が効いていない？」への回答: **moveTo 自体は正しく動いていた**。原因はテスト実行器の
  自動見送りの既定値のバグ）。修正は「min===0 のときは既定で見送る（選ばない）」。既存の R2a・R2b・R3・
  対象外参考の結果は不変（`optional:true` を持つ他の8枚のカードにも影響し得るが、verify で確認したとおり
  既存の✅件数は下がっていない）
- 単体テスト: `scripts/test-engine-host.ts` ㉒a・b（固定の並び／callCostOf の両方を、宣言→自動見送り→
  効果実行のフルパスで確認。`shouldAutoPass` を使って「自分のメインフェイズは自動で終わらない」を尊重しつつ
  見送りきる書き方を新しく作った）
- faq-4096・4099・4102・4105 が✅に。**faq-2956・2959（臨時収入の割込型としての使用）は❌／✅のまま
  残っている**（2959 は既にR2a時点の別経路で✅・2956だけ❌）。技術的な理由は下記「持ち越し」

### 5. D16 可変の使用代償（世話焼き） — 完了
- `OtherCost.kiryoku` を `number | Expr` に拡張。`Expr { chosen: string }`（宣言時に選んだ数の参照）を追加
- `Cond { downed: CardRef }`（そのカードが今ゴミ箱にある＝ダウン処理が cancelDown で打ち消されずに終わった
  近似）を追加。サクリファイスの `fromSlot` アプローチと役割は同じだが、単一カードの `if` に使うにはこちらの
  ほうが直接的（次のセッションでサクリファイス側も `downed` に寄せて簡略化できるかもしれない・提案のみ）
- `Pick { number: { min: number } }` を追加。答えは数の文字列。**上限は原典に定めが無いが、実装は候補を
  1〜20に区切った**（`src/engine/drive.ts` の `choiceOptions`。原典に書いていない細部・報告に明記）
- `parseCostText`（`src/engine/cost.ts`）に「気力－回復数」（表記ゆれ「回複数」も。データの誤字と判断）の
  パターンを足し、`{ kiryoku: { chosen: 'x' } }` を組み立てる。`payNow` は `Expr` を `evalExpr` で評価してから
  支払う
- `layers.ts` の `applyCostMod`（K6 costMod）は、Expr 化した `kiryoku` を対象外にした（今のプールに costMod と
  可変代償が同時に絡む例が無いため。**決めていない組み合わせ**として報告する）
- `_local/rules/cards/c_澤倉美咲.ts`・`c_高瀬瑞希.ts`（新規）。「世話焼き」だけ実装、もう一方の能力
  （舞台演出・ドレスアップ）は manual（本題と無関係な別機構が要るため）
- **原典に書いていない細部**: `choices` の並び順（対象 't' を先・回復数 'x' を後）が重要だった。
  `declare()` は宣言時の対象（`req.targets`）を `ab.choices` の並び順で先頭から機械的に消費するため、
  逆順だと `targets` の値が数の選択に誤って食われる。カードの記述ではこの並びを守る約束にするとよい
  （設計ドキュメントに書くか統括に判断を仰ぎたい・下記「新しいルールの穴の候補」ではなく実装上の作法）
- faq-3217・2546 が✅に。**faq-2546 の authored 側を1点直した**: `e_封印`（次のうち1つ・2択カード）の
  宣言に `option: '相手が特殊能力を使用したとき'` を明示した。理由: `opponent` が active（自分の番）だと、
  option を省いた場合 `doDeclare` の探索が「常に効果が発揮されている特殊能力」（通常型・いつでも宣言できる）
  のほうを先に見つけてしまい、世話焼きへの割り込みを試す前に別の宣言として成立してしまうため
  （論点・期待は不変。差分は git diff で確認済み・expect は1文字も変えていない）

## §3-6〜12: 未着手（持ち越し）

時間の都合で着手できなかった。技術的な調査結果を残す:

1. **D11〜D15 効果の乗っ取り（いただきます・幸せ泥棒・faq-829/832/835/838/841/2836）**: 未着手。新しい
   `Op { op:'hijack', ... }` の設計自体は指示書に詳しいが、実装前の調査は何もしていない
2. **D17・D18 効果で呼び出す（変わり身・faq-1628）**: 未着手
3. **D19 パーティ（faq-1010）**: 未着手
4. **D20 借金取り（faq-1350）**: 未着手
5. **D23 おあずけ（faq-869）**: 未着手
6. **faq-2956（臨時収入の割込型使用）**: 上記のとおり generateCost 自体は実装したが、7-2[3]（宣言時の
   コスト発生アクションの宣言）に「イベントカードとして使う（16-1 の手順・打ち消しの窓つき）」を差し込む
   統合が要る。今の `core/proc.ts` の `enterCostGen`（`decl.sources: CostSource[]` を消耗・ゴミ箱送りという
   機械的な発生源としてだけ処理する仕組み）を、`decl.costGens[i]` の中に「イベントの使用そのもの」という
   選択肢を1つ増やせるよう拡張する必要がある（新しい `ProcFrame` の分岐か、`CostSource` に
   `{ useEvent: string }` のような variant を足すか。設計判断が要る）
7. **§3-11 正式gate**: 上記が全部片付いて対象30件が✅にならない限り、`scripts/test-faq.ts` の `scopeD` を
   正式gateに入れていない（❌1件・保留10件が残っているため）。該当箇所（`scopeD`・ループのコメント）は
   前回セッションのコメントのまま残っている
8. **§3-12 単体テスト**: costMod・offer の合成カードでの単体テストも未着手（前回セッションからの持ち越し）

## §7 自己点検

1. §3 の1〜12: **1〜5完了。6〜12未着手**（上記のとおり）
2. 件数: `_r4a-result.json` を `node -e` で数え直し。✅19／保留10／❌1（対象30件）。R2a 57✅・保留1／
   R2b 37✅／R3 18✅ は `_r2a-result.json`・`_r2b-result.json`・`_r3-result.json` の `summary.scope` で確認・不変
3. 期待値の差分: `_local/rules` の `git diff d3deca5 HEAD -- tools/authored/` で `expect:` を含む行の追加・削除は
   **0件**（確認済み）。変えたのは盤面（faq-233・1608 のロボ回避）と `option` の明示（faq-2546）のみ、
   どちらも論点・期待は不変。既存の単体テストの期待値も変えていない（新しいテスト㉑・㉒a・bを追加しただけ）
4. 原典に書いていない細部（実装で決めたこと）:
   - D24: `charTypes` を持たないカードは `?? []` で「キャラタイプ無し」扱い（既定値）
   - D22: 「実際にダウンしたか」の判定を `Selector.fromSlot` ＋ `zone:'trash'` で近似（cancelDown系の
     2例＝働き者・執念だけが根拠。将来ゴミ箱以外に行く「打ち消されないダウン」が増えたら要見直し）
   - D16: `Pick{number}` の候補上限を実装で20に区切った（原典に上限の定めなし）。`choices` の並び順
     （対象を先・数を後）が `declare()` の対象消費ロジック上の制約から必要だった
   - D16: costMod（K6）と可変代償（Expr化した kiryoku）の組み合わせは今回スコープ外・対象外にした
     （今のプールに両方が絡むカードが無いため）
   - D21: generateCost で得たコストは `frameId: null`（即座に「その他の代償」）とした。臨時収入の
     通常使用・サクリファイスの両方とも「今すぐ使えるコスト」という扱いが自然と判断（原典に明記は無い）
5. tested の数: 54→4（前後）。なれなかった理由の内訳は「faqReview が _index.json の関係 FAQ を全部
   含んでいない」が84枚（ほぼ全部・Part B 未着手のため）。'ok' の抜き取り5件は**今回そもそも 'ok' の
   review エントリがまだ少ない**（c_澤倉美咲の faq-3214が唯一の 'ok'）。その1件: 「本文は『気力を減らす』
   方向のみ（cost.other は self の消費・delta は常に負）なので、対象の気力を減らす向きの読みはそもそも
   起きない」（FAQ:3214「使用すると気力が増える方向にはできない」に対する読み合わせの理由）
6. Part B（省いた部分を manual にした・FAQ と食い違って直した）はこのセッションの対象外（Part A のみ担当）。
   ただし今回**新規に書いた5枚**（c_ルミラは既存の書き直し）はいずれも本文の一部を manual で明示している
   （臨時収入の割込型使用・サクリファイスの舞台演出・世話焼き以外の能力）
7. 保留・ケースが間違っていると思ったもの: 無し（保留10件は全部「記述が無い」という一貫した理由。
   統括13の§2で設計が決まっている項目なので、間違った期待ではなく単に未実装）
8. 新しいルールの穴の候補: **無し**（このセッションで決めていない穴は見つからなかった。D16 の
   costMod との組み合わせは「穴」ではなく「今のプールに実例が無いので後回しにした」という別種の課題）
9. 「多い」は使っていない

## 続きのセッションへ

### 次にやるべき順（提案）
1. §3-6（D11〜D15 効果の乗っ取り）が最も件数が多い（5件）ので優先度が高いが、新しい Op の設計が
   一番重い。指示書 §3-6 の記述（D11〜D15 の乗っ取り・NH-17 の機会）をそのまま実装できるはず
2. §3-3・4 で見つけた「臨時収入の割込型統合」（faq-2956）は `core/proc.ts` の `enterCostGen` に手を入れる
   必要があり、他の項目と独立に進められる。優先度は統括の判断次第
3. §3-7・3-8・3-9・3-10（呼び出し・パーティ・借金取り・おあずけ）は指示書どおりの順で
4. 全部✅になったら §3-11（正式gate）・§3-12（残りの単体テスト）

### 引き継ぎの最低限
- 対象ファイル: `_local/rules/cards/e_いただきます.ts`・`e_幸せ泥棒.ts`・`c_猪名川由宇.ts`・`e_変わり身.ts`・
  `e_パ-ティ.ts`・`e_借金取り.ts`・`e_おあずけ.ts`・`e_記憶喪失.ts`（すべて新規）・`src/engine/dsl.ts`
  （`Op` に hijack・callByEffect 系を足す）・`src/engine/drive.ts`（実装）・`src/core/proc.ts`
  （効果で呼び出す手順・enterCostGen の拡張、要るなら）
- やること一言: 指示書 `PHASE-R4a-2.md` §3-6〜12 をそのまま実装する
- 完了条件: 対象30件が✅（保留3件まで理由つき可）・❌0・`npm run verify` 緑・正式gate組み込み
- 未決事項: 臨時収入の割込型統合の設計（`enterCostGen` の拡張方法）
- 詳細は本ファイルの上のセクションと `PHASE-R4a-2.md`・`PHASE-R4a.md`・`HANDOFF-R4a.md` を読んで

## ビルド状態・副産物の発見
- `npm run verify` **EXIT 0**（このセッションの最終状態）
- `_local/rules/tools/tested.ts` は `computeTested()` を export する形に書き直したため、他のツールから
  import して再利用できる（今回は `scripts/test-faq.ts` から使った）
- `scripts/lib/faq-run.ts` の `autoStep` の既定選択ロジックのバグ修正（上記）は、他の `optional:true` を
  持つカード（`c_アレイ`・`c_エビル`・`c_佐藤雅史`・`c_芳賀玲子`・`c_藤井冬弥`・`i_どろぼう`・
  `t_姉妹うさぎ`・`t_郁美&雄蔵`）のテストにも影響し得るが、`npm run verify` で確認したとおり既存の
  ✅件数は下がっていない
