# HANDOFF — PHASE3d-1（バトルの状態機械・core専用）

**完了条件**: `npm run verify` 緑（build＋全テスト、`test:battle` 11件込み）。確認済み。

## やったこと

1. **`src/core/battle.ts` を新規作成**。§3の関数をすべて実装:
   `declareBattle` / `advanceStep` / `setParticipants` / `autoAssignLeader` / `setBattleCard` /
   `setValue` / `loopBack` / `abortBattle` / `computeDamage` / `detectAbort`。
2. **`CardInstance.used?: boolean`** を [board.ts:29](src/core/board.ts:29) に追加。
3. **`BoardState.battle: Battle | null`** を [board.ts:53](src/core/board.ts:53) に追加、
   `EMPTY_BOARD` に `battle: null` を補完、`cloneBoard` にも `battle` を足した。
4. **`board.ts` に `setUsed()`** を新設（[board.ts](src/core/board.ts)、`setFaceUp`と同型のsetter）。
   `used` を触るのは唯一これだけにして、CardInstanceの全フィールドsetterがboard.tsに集まる
   既存の慣習（setOrientation/setKiryoku/setFaceUp…）を崩さなかった。
5. **`BoardAction` にバトル遷移8種を配線**（[actions.ts](src/core/actions.ts)）:
   `declareBattle` / `advanceBattleStep` / `setBattleParticipants` / `autoAssignBattleLeader` /
   `setBattleCard` / `setBattleValue` / `loopBackBattle` / `abortBattle`。
   `declareAction`/`resolveStep`と同じ流儀（`state.battle`が無ければ何もしない防御的no-op）。
6. **`scripts/test-battle.ts` を新規**（テスト11件＋非回帰2件の計13ブロック）、`npm run test`に配線。

## 判断した点（勝手に決めず、ここに書く）

### 1. 関数シグネチャが本書§3の逐語と一部ズレている

PHASE3d-1.md §3は「すべて `(board, args) => { battle, log }` の形」と書いていますが、
**`setBattleCard`だけは `{ state, battle, log }` を返す**設計にしました。

理由: `setBattleCard`の仕事は「種目を決め、そのカードを`used=true`にする」ことで、`used`は
`BoardState.cards`側のフィールドです。`{battle, log}`だけ返す形だと、更新されたboard状態を
呼び出し側に渡す手段が無くなります（battle.tsが返り値以外の副作用でboard.tsを書き換えることは
できない＝純関数の前提を破る）。そこで`setBattleCard`のみ`state`も受け取って返す形にし、
内部で`board.setUsed()`を呼んでいます。他の関数（`declareBattle`/`advanceStep`/`setParticipants`/
`setValue`/`loopBack`/`abortBattle`）はboard状態を一切触らないので`{battle, log}`のままです。
`autoAssignLeader(board, battle, seat)`は`board`を**読み取り専用**で受け取りますが（リーダー/待機キャラを
探すため）、`state`は返しません（board側を書き換えないため）。

**統括への確認したい点**: この非対称（setBattleCardだけstateを返す）でよいか。代替案として
「`used=true`はP3d-2でUIから`setUsed`アクションを別途叩く」という切り分けも考えましたが、
それだと「種目決定＝used=trueになる」というルール上ワンセットの操作が2アクションに分裂し、
「種目を選んだのにusedが立っていない」中間状態が生まれてしまうため、今回は1関数にまとめました。

### 2. `used`を書き換えるコード自体は`board.ts`に置いた

`battle.ts`の中で直接`state.cards[iid].used = true`のように書かず、既存の`setFaceUp`と同型の
`board.setUsed()`を追加してそれを呼ぶ形にしました。CardInstanceの個々のフィールドsetterが
すべてboard.tsに集まっている既存の設計（1ファイルに副作用を集約）を崩さないための判断です。
`battle.ts`はboard.tsを普通にimportします（`cardsInZone`/`setUsed`/型）。

### 3. `board.ts ⇄ battle.ts` の循環参照について

`BoardState.battle: Battle | null`のために`board.ts`が`import type { Battle } from './battle'`
します。一方`battle.ts`は`cardsInZone`/`setUsed`をランタイムで`import { ... } from './board'`します。
**型だけの循環参照**（board→battle）と**ランタイムの片方向依存**（battle→board）が同居する形です。
`priority.ts ⇄ board.ts`に既に同じ型循環の前例があった（`board.ts`が`import type { Mode, Priority } from './priority'`、
`priority.ts`が`import type { Seat } from './board'`）ため、この形自体は踏襲です。ただし今回は
**battle.ts側がboard.tsをランタイムでもimportする**点が新しく、`tsc`/`vite build`とも問題なく通ることを
`npm run verify`で確認済みです（`check-core-isolation.mjs`もcore/内部の相互importは対象外なので通ります）。

### 4. `detectAbort`（統括に必ず説明するよう指示された箇所）

**「バトルの結果でダウンした場合を除く」をどう判定したか**:

このフェーズの設計上、`detectAbort(before, after, battle)`は**`BoardAction`に依存せず
state差分だけ**から判定する関数です（P3cの`core/timing.ts`と同じ流儀＝ゲスト側でも同じロジックで
動くようにするため、本書§4(b)の指示どおり）。つまり「なぜ参加キャラが消えたか」という**原因の情報は
そもそも渡ってきません**。

そこで、**`battle.step`が`'結果'`である間に起きた参加キャラの喪失は、この関数の対象外（中断としない）**
という判定にしました。根拠: 原典20-4の[23]-[27]（攻防確定→ダメージ計算→《結果計算時》窓→
ダメージ/ダウン処理→《結果を出したとき》窓）は"結果"段の内部処理そのものであり、DESIGN.md §5.2の
7段圧縮でもこの範囲がまるごと`'結果'`ステップに対応しています。つまり「このバトルの結果でダウンする」
という原典の事象は、必ず`battle.step === '結果'`の間に起きる処理です。このタイミングでの参加キャラの
喪失（trashへの移動等）は「このバトル自身の結果によるもの」とみなして除外し、それ以外の段
（`'バトル中アクション'`＝割り込み能力等で参加キャラが消えるケース、`'終了'`＝結果処理後に何かが
起きたケース）での喪失は除外せず中断として検出します。

**副作用として、20-6の判定自体も原典どおり「手順[19]～手順[28]の間」に絞りました**（`battle.step`が
`'バトル中アクション'|'結果'|'終了'`のいずれかのときだけ`detectAbort`が動く。それより前の段
＝宣言/挑んだ側指定/挑まれた側指定/種目決定 での中断は、本書§4(a)が担当する
「`advanceStep`の前提チェック→`abortBattle`」の系統であり、`detectAbort`の管轄外という理解です）。
テスト9dでこの境界（種目決定段での喪失は検出しない）を確認しています。

**統括に独立検証してほしい点**:
- `battle.step==='結果'`中の喪失を一律で除外する設計は、「この関数はアクションを見ない」という
  制約下での近似です。理論上、結果段の最中に**このバトルと無関係な**理由（例: 相手が割り込みで
  無関係な別キャラを対象にした能力を使い、たまたま結果段のタイミングと重なった）で参加キャラが
  消えるケースがあれば、本来は中断すべきなのに見逃す可能性があります。ただし結果段は「窓を開けず
  ダメージ計算とダウン処理を人間が一息に行う」短い区間（DESIGN.md §5.2の7段構成では、結果段の中に
  割り込み窓が無い＝バトル中アクション段でしか割り込みは起きない設計）なので、実害は無いはずだと
  判断しました。この前提（結果段では割り込みが起きない）が違えば、この設計は見直しが要ります。
- `used`のロールバック無し（FAQ oldfaq.txt:3751-3752）はテスト10で確認済みですが、`abortBattle`自体は
  `battle`しか触らない（`state`を受け取らない）設計なので、「触らないから壊れない」という消極的な
  正しさです。P3d-2で中断時にボード側の処理（攻防修正クリア等・[28]）を書くときも、`used`を
  戻す処理を書かないよう注意してください。

## 申し送り（P3d-2への引き継ぎ）

- **`computeDamage`/`detectAbort`はBoardActionに配線していません**。理由: `computeDamage`は
  「計算するだけ、盤面には適用しない」（本書§5「ダメージの適用」はP3d-2の担当）ため、単発アクションに
  する意味が薄いと判断しました。`detectAbort`はP3c型の「dispatch後に呼び出し側が能動的にチェックする」
  関数（`history.ts`の`dispatch`をラップするか、UI層で毎アクション後に`before/after`を渡して呼ぶ）を
  想定しているため、こちらも本フェーズではBoardActionにしていません。P3d-2で優先権の窓・UIと接続する際、
  どちらもフックする場所（`history.dispatch`のラッパーか、個別UIコンポーネント側か）を統括判断で
  決めてください。
- **参加キャラの消耗（C-3「参加キャラの消耗は自動」）はこのフェーズでは実装していません**。
  本書§3の関数表に`setParticipants`/`autoAssignLeader`の消耗自動化が明記されておらず、
  §1のやること4項目にも含まれていなかったため、範囲外と判断しました。DESIGN.md §5.2の運用方針
  C-3（「1タップで戻せるように」）はUI寄りの要件でもあるため、P3d-2でconsumeを別途足すのが良さそうです。
- **旧盤面非回帰**: `useBoard.ts`の`{...EMPTY_BOARD, ...saved}`パターンで`battle`は自動的に`null`
  補完されます（新規コード追加不要）。テスト11・`npm run dev`起動確認（コンソールエラー無し、
  ブラウザで`http://localhost:5300`を開いて確認済み）の両方でOK。

## テストの実測値

`npm run test:battle` — 13ブロック・アサーション39件、全緑（内訳: 本書§6の11項目＋4b/6bの非回帰2件、
9番は9a〜9dの4小ケースに分割）。`npm run verify`全体も緑（build含む）。

## コミットについて

指示どおりコミットはしていません。

---

## 差し戻し対応（統括4・2026-09-23）

`PHASE3d-1-差し戻し.md`（統括3の独立検証の結果、統括4が交代して指示）に沿って修正した。
統括3には送っていない（統括4の指示どおり、報告はこの節に書くだけに留める）。

### 変更点

1. **①setBattleCardの非対称は承認**。変更なし。

2. **②detectAbortの「バトルの結果でダウンした場合を除く」判定を、段（step）から原因の記録
   （`Battle.resultDowned: string[]`）に差し替えた**。
   - [battle.ts](src/core/battle.ts)の`Battle`インターフェースに`resultDowned: string[]`を追加。
     初期値は`declareBattle`で`[]`（このフェーズでは誰も入れない。P3d-2が[26]の適用時に埋める）。
   - `detectAbort`の除外条件を `battle.step === '結果'` → `(battle.resultDowned ?? []).includes(iid)` に変更。
     `?? []`は旧shape（`resultDowned`が無いBattle）が万一読み込まれても例外を投げないための防御
     （テスト9gで確認）。
   - 根拠: `oldrule.txt:1114-1119`（20-4結果段）に[25][27]の2つの窓（アクション宣言の機会）があり、
     段だけでは[25]の窓の効果による喪失と[26]由来のダウンを区別できないため
     （PHASE3d-1-差し戻し.md §2、統括3の指摘どおり）。

3. **③detectAbortからバトルカードの判定を削除した（統括の指示書自体の誤り）**。
   20-9・12-2・FAQ(oldfaq.txt:3443-3444「バトルは続行します」)の逐語を、削除箇所に
   コメントとして残した（[battle.ts](src/core/battle.ts)の`detectAbort`のdocコメント内）。

4. **detectAbortが走る段から`終了`を外した**（対象は`バトル中アクション`/`結果`の2段だけ）。
   `終了`段を外した理由のコメント（統括4補足のとおり、「[28]はアクション宣言の機会を持たない」
   だけでなく「[28]と[29]が1段に合体していて盤面から区別できないので人間判断にした」という
   2行の説明）を`detectAbort`のdocコメントに追加した。

### テストの変更

`scripts/test-battle.ts`のテスト9を全面差し替え（§5の指示どおり、期待値は原典の逐語から作った。
「今の実装の出力」からは作っていない）:

- 9a: バトル中アクション段の参加キャラ喪失 → 中断検出（変更なし）
- 9b: 結果段・`resultDowned`に**記録済み**の参加キャラ喪失 → 中断しない（新規。旧9bは
  `battle.step==='結果'`だけで判定していたため、新仕様では`resultDowned`を明示的にセットする形に修正）
- 9c: 結果段でも`resultDowned`に**入っていない**参加キャラの喪失 → 中断する（新規。[25]窓のケース。
  差し戻し前は存在しなかった＝これが検証で見つかった見落とし）
- 9d: バトルカードがゴミ箱送りされても中断しない（**反転**。旧9cは「中断する」だったが、
  20-9/12-2/FAQの逐語に基づき「続行する」へ反転）
- 9e: 種目決定段（[19]より前）での喪失は対象外（旧9dのまま、番号だけ繰り下げ）
- 9f: 終了段での参加キャラ喪失は対象外（新規）
- 9g: `resultDowned`が無い旧shapeのBattieでも`detectAbort`が例外を投げない（新規・非回帰）
- 旧テスト11の手組みBattleオブジェクトに`resultDowned: []`を追加（型エラー回避、および
  「フィールド追加後もEMPTY_BOARD側の旧盤面耐性は変わらない」ことの確認を兼ねる）

テスト件数: `test:battle`は旧11件→新16件相当（9が9a〜9gの7小ケースに分割・増加、他は変更なし）。
`npm run verify`は build＋test 4スイートすべて緑（確認済み）。

### コミットについて

差し戻し対応後もコミットしていません（統括4が検証してからコミットする指示のため）。
