# 実装ノート — 次のセッションが即座に立ち上がるための1枚

対象: `leaffight/` の実装セッション全般。HANDOFF-P0〜P2.7に散らばっている教訓をここに集約する。
**このファイルは「次の自分」へのメモ。** 新しい罠を踏んだら、ここに追記すること。

---

## 1. この環境の制約

### `preview_screenshot` / `computer` は必ずタイムアウトする
この開発環境のBrowserペインはネイティブ viewport が 0×0 相当で、視覚的なスクリーンショット系ツールは機能しない。**検証はDOM実測 + `javascript_tool` で代替する。**

### 実ドラッグの発火方法（dnd-kit）
```js
function fire(el, type, x, y) {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, view: window }));
}
const sr = source.getBoundingClientRect(), tr = target.getBoundingClientRect();
const sx = sr.left + sr.width/2, sy = sr.top + sr.height/2, tx = tr.left + tr.width/2, ty = tr.top + tr.height/2;
fire(source, 'mousedown', sx, sy); await wait(50);
fire(document, 'mousemove', sx+15, sy+15); await wait(50);   // dnd-kitのactivationConstraint:{distance:6}を超える
fire(document, 'mousemove', (sx+tx)/2, (sy+ty)/2); await wait(50);
fire(document, 'mousemove', tx, ty); await wait(100);
fire(document, 'mouseup', tx, ty); await wait(300);
```
`mousedown`はソース要素に、`mousemove`/`mouseup`は`document`に発火させる（dnd-kitの内部リスナーの張り方に合わせる）。

### `mouseenter`/`mouseleave` はネイティブ dispatchEvent で発火しない
Reactは `mouseover`/`mouseout`（bubbling）から `onMouseEnter`/`onMouseLeave` を合成している。
```js
wrapper.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, relatedTarget: document.body }));
```
`mouseenter`をそのままdispatchしても反応しない。**`mouseover`＋`bubbles:true`を使うこと。**

### `resize_window` は既に読み込み済みのページで `ResizeObserver` を発火させない
`resize_window`で表示中のページのビューポートを変えても、`getBoundingClientRect()`/`clientHeight`はレイアウト計算として正しく更新されるが、**`ResizeObserver`のコールバックが発火しない**（フレッシュに`new ResizeObserver()`で作り直しても再現する＝実装のバグではなく、この検証環境（CDPベースのviewport変更）の制約と判断）。
**対策: 特定の解像度を検証したいときは、`resize_window`で先にサイズを変えてから`navigate`でページを再読み込みする**（既存ページをresizeしただけでは、ResizeObserverに依存するコンポーネントの再計測が反映されない）。実ブラウザでユーザーが本当にウィンドウをリサイズする場合はResizeObserverの標準仕様通り動作するはずで、これはあくまで自動検証時の制約。

### `tabs_create` で作った新規タブは 0×0 viewport から始まる
`resize_window`で明示的にリサイズするまで `innerWidth`/`innerHeight` が0になる。2タブ検証（P2以降）で必ず両方リサイズすること。

### `preview_start` が `.claude/launch.json` の設定を見つけられないことがある（P3d-2bで発見）
サブエージェント実行環境によっては、`.claude/launch.json`にちゃんと`leaffight-dev`の設定があっても
`preview_start`が「No server named "leaffight-dev" found」を返し、他プロジェクトのサーバー名しか
見えないことがある（ツールの解決先プロジェクトルートが実行時のcwdと一致しないケースと推測）。
**代替手順**: `npm run dev`をBashで`run_in_background`起動 → `navigate`で`http://localhost:5300`を
直接開く（`preview_start`を経由せず`navigate`だけでBrowserペインが開く）。

### データ未読込（leaffight-data.zip）を手作業のファイル選択なしで読ませる方法
`DataGate.tsx`は`<input type="file">`でZIPを受け取る作りなので、自動化ではファイル選択ダイアログを
操作できない。代わりに、vite dev serverがプロジェクトルート配下を静的配信していることを利用し、
`javascript_tool`で以下を実行する（`dist-data/leaffight-data.zip`が存在する前提）。
```js
const res = await fetch('/dist-data/leaffight-data.zip');
const blob = await res.blob();
const file = new File([blob], 'leaffight-data.zip', { type: 'application/zip' });
const dt = new DataTransfer();
dt.items.add(file);
const input = document.querySelector('input[type=file]');
input.files = dt.files;
input.dispatchEvent(new Event('change', { bubbles: true }));
```
2タブ検証では、P3d-2b の実装サブは両方のタブで実行する必要があったと報告している（理由は未確認。
同一オリジンの IndexedDB は通常タブ間で共有されるので、ブラウザペインのタブごとに保存領域が分かれている可能性がある）。
統括5の検証時は、既に両タブともデータ読込済みだった。

### `javascript_tool` が時々30秒タイムアウトする
複数カードを連続で追加するような長めのループ処理で、原因不明のタイムアウトが繰り返し発生した。ページ自体は生きており、タイムアウト時点までの操作は正常に反映されている。**対策: 1〜2枚ずつ、短いスクリプトに分けて実行する。**

---

## 2. CSSの罠

### `aspect-ratio` + `%`（max-width/max-height）の循環参照（P2.6で発見）
**幅が確定していない要素**（flexの `flex:0 1 auto` で content-basedにshrink-wrapする子要素など）に対して、`aspect-ratio` + `max-width:100%`（または`height:100%`+`max-width:100%`）を使うと、パーセンテージの分解基準が循環参照になり、**ブラウザが不安定な値で確定させる**。症状は「最初の1枚（または特定の1枚）だけ小さく描画される」という偏った形で出るため、**カード1枚だけ表示したテストでは発覚しない。3枚以上、できれば画像あり/なし混在で並べて初めて発覚する。**

**解決の型**: 「aspect-ratioを確立する層」（親: 明示的に`h-full`+`aspect-[63/88]`で定義済みサイズを持つ）と、「それをw-full/h-fullで単純に埋めるだけの層」（子: `<button>`等）を分離する。子に独自のaspect-ratio計算をさせない。

### P2.7でさらに踏んだ変種: 行の高さをJS計測値で自分に設定する循環参照
マスのサイズを「行の実高さ」から計算するため`ResizeObserver`で行の`clientHeight`を測る実装（`useMeasuredHeight`）を作ったが、**測定対象の行自身に、測定結果（state）を`style={{height}}`として設定してしまい**、常に初期値0で固定される、という新種の循環参照を作った。
**教訓: 「計測する対象」と「計測結果を使って別の何かのサイズを決める対象」は分離すること。行の高さは親グリッド（`grid-template-rows: fr`）に完全に委ね、`ref`は読み取り専用の計測にだけ使う。**

### P2.10でさらに踏んだ変種: レイアウト差し替え時に計測が更新されない（DOM再利用の罠）
実行時にレイアウトA⇄Bを切り替える（中央の盤面グリッドdivの中身を丸ごと差し替える）と、**マスの大きさが古いレイアウトの値のまま固まる**（リロードすれば直る）。原因は、切替前後で**同じ位置に同じ要素型（`div`）が来る**と、Reactが既存のDOM要素を再利用し、計測用`ref`のコールバックが再発火しないため（`ResizeObserver`は張り直されない）。
**教訓: 動的にレイアウトを差し替える箇所では、差し替わる部分の最外周に別々の`key`（例 `key="A"`/`key="B"`）を付けてReactに作り直させる。計測フックは`useRef`+`useLayoutEffect([])`ではなく、マウント/アンマウントで確実に呼ばれる「コールバックref方式」にしておくと保険になる。**

### マスをflex-1で引き伸ばさない（P2.6→P2.7で修正）
`flex-1`で行の幅を等分すると、①カードサイズがマスより大幅に小さくなり無駄な余白が出る、②**枠数の違う行では1枠の幅が変わり、列が揃わなくなる**（ゴミ箱・デッキがキャラ・リーダーの整列を崩す）。
**マスの大きさは「消耗（90°回転）したカードが収まる最小」で計算する**（カード比63:88、高さHのとき、回転する zone は H×H、回転しない zone は 0.716H×H）。全ての行で列を揃えるには、固定pxのマスを組み、CSS Gridの `1fr auto 1fr` で中央のクラスタ/フィールドを盤面の水平中央に固定する。

---

## 3. dnd-kitの罠

### `closestCenter`単体は「広いドロップ領域の端」で誤爆する（P2.8で発見）
手札のように「実際の占有幅より広いドロップ判定領域」を持つゾーンがあると、その領域の**端（見た目は空いているが実際はそのゾーンの内側）**にドロップしても、**中心座標が近いだけの別の（小さい）ゾーン**に奪われることがある。`closestCenter`は「ポインタがどの矩形の内側にいるか」ではなく「ドラッグ中の矩形の中心と各droppableの中心の距離」で決めるため、広いゾーンの端は自分自身の中心から遠く、隣の行の小さいゾーンの中心の方が近い、という逆転が起きる。

**対策**: `pointerWithin`を先に試し、何もヒットしない時だけ`closestCenter`にフォールバックする合成戦略にする（`Board.tsx`の`collisionDetectionStrategy`）。
```ts
const collisionDetectionStrategy: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args)
  if (pointerCollisions.length > 0) return pointerCollisions
  return closestCenter(args)
}
```
新しいドロップゾーン（P3のスタック枠等）を足すときも、ゾーンの実際の占有幅とドロップ判定領域の大きさが違うなら同じ罠を踏む可能性がある。

---

## 4. PowerShell（データ生成スクリプト系）

- **BOM付きUTF-8**で保存しないと日本語が壊れる（PowerShell 5.1）。Writeツールで書いた`.ps1`は`Get-Content -Raw -Encoding UTF8`→`Set-Content -Encoding UTF8`でBOM付きに直す。
- **日本語パスを直書きしない**。`$PSScriptRoot`から導出する。
- `[ordered]@{}` は `Group-Object -Property` で集計できない。集計・JSON出力の前に`[pscustomobject]`に変換する。
- パスに`[ ]`が含まれると`Set-Content -Path`がワイルドカード解釈になる。`[System.IO.File]::WriteAllText`と`-LiteralPath`を使う。

---

## 5. 設計上の禁止事項（破るとビルドや設計が壊れる）

- 🚨 **`core/`に`ui/`・`net/`・`data/`・外部パッケージをimportしない。** `scripts/check-core-isolation.mjs`が`npm run build`の最初に走り、破るとビルドが落ちる（それが正しい）。
- 🚨 **`localSeat`を`BoardState`に入れない。** `BoardState`は両クライアントに配信される共有物。`localSeat`（自分がどちらの座席か）はクライアントごとに違う値なので、入れた瞬間に配信で上書きされて壊れる（P2.5で確定した設計）。
- 🚨 **盤面（対戦卓の本体）に`overflow-auto`/`overflow-scroll`を使わない。** 使ってよいのはログ・詳細パネルの本文・右クリックメニュー・カードピッカーだけ（内容が可変で当然スクロールするところ）。P2.6以前はこれを破っていて縦スクロールが出ていた。
- **`core/`に乱数・時刻を持ち込まない。** シャッフルの並び順、UUID生成は`ui/`側で行い、結果（配列・値）だけを`core/`のreducerに渡す。P2でホストの操作をそのまま再生できるようにするための制約。
- **相手陣は「反転コピー」でなく「点対称（180°回転）」。** 反転コピーで実装すると、フィールドの左右位置が両陣営で「同じ側」になり、共有スロットのはずが2枚同時に置けてしまうバグの原因になった（P2.5で発見・修正）。
- **相手の操作で自分が開いているUIの前提が消えるケースに注意（Rules of Hooksの罠）。** カードの操作パネル/コンテキストメニューを開いている最中に、そのカードが（ネット越しの相手や自分の別操作で）盤面から消えることがある。**全てのHooksは早期returnより前で呼ぶこと。** P1・P2で実際にクラッシュした（`if (!instance) return null` の後に`useState`を書いてしまっていた）。

---

## 6. フェーズをまたいだ経緯（要点だけ）

- **P0**: データ基盤。`cards_v2.json`の`cost`フィールドは壊れている（レアリティ`R`を誤検出）。`cells`（生データ）から再導出すること。
- **P1**: ローカル盤面。`core/board.ts`にBoardState/reducer、Undo/Redoはスナップショット方式。
- **P2**: 通信（PeerJS）。ホスト権威、ゲストは楽観的更新なし。
- **P2.5**: 座席モデル。`Player('me'|'opp')`→`Seat('A'|'B')`。`core/`から視点依存語を排除。
- **P2.6**: レイアウト刷新（1画面に収める）。`flex-1`で引き伸ばした結果、列が揃わなくなるバグを作った。
- **P2.7**: レイアウト修正。マスのサイズをJS計測の固定pxに、中心線をリーダー-フィールド-リーダーで一致させた。
- **P2.8**: カードの見た目（比率固定・表記法統一・デッキ出入りのfaceUp自動化・手札ドロップ判定・ホバー拡大）。

各フェーズの詳細は `HANDOFF-P0.md`〜`HANDOFF-P2.8.md` を参照。設計の「正」は`DESIGN.md`。
