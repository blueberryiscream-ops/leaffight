# PHASE 2.11 — 見た目の土台（テーマA「空と紺」）

**担当**: 統括が起動するサブエージェント（実装）
**前提**: HEAD＝P3d-2b 完了後。利用者が見本 `_local/見た目の方向性.html` で **A「空と紺」を選んだ（2026-09-24）**。
**まず読むもの**: `IMPLEMENTATION-NOTES.md §1` → `DESIGN.md §4.18.0・§4.18.3・§7.5` → 見本の HTML（`.stage[data-theme="A"]` のトークンと、`.card` `.panel` `.btn` の規則）→ 本書。
**完了判定**: `npm run verify` が緑、§6 の機械チェックが全部通る、§7 の煙試験が通る。

---

## 0. 目的と範囲

色・文字・影・背景・カード裏面だけを替えて、アプリをテーマAの見た目にする。
**配置は今後変わる**（レイアウト A/B の採否・バトル窓の体感・P4）ので、**配置・大きさ・挙動には一切手を付けない**。
今後の部品が最初からテーマに沿うよう、**色を意味の名前（トークン）で1か所に定義**し、部品はそれだけを使う形にする。

### 守ること
- 🚨 **配置・マスの大きさ・余白・文字サイズ・挙動を変えない**（`w-*` `h-*` `p-*` `gap-*` `text-[Npx]` 等は触らない）。変えるのは色・フォント・影・背景・角丸の見た目だけ
- 🚨 `src/core/` は変更しない。盤面に `overflow-auto` を使わない。1画面に収める（DESIGN §4.18.1）
- 🚨 **カード画像・裏面画像をリポジトリに入れない**（DESIGN §7.5）。裏面はデータの zip 経由で配る（§4）
- 旧盤面・旧データ zip（裏面が入っていない）で壊れないこと
- `_local/` と `DESIGN.md` は読むだけ。**コミットしない**

---

## 1. トークン（`src/index.css` の `@theme`）

Tailwind v4 の `@theme` に**意味の名前**で色を定義する（`bg-panel` `text-ink-muted` `border-line` のように使える）。
値は見本の A から取る。下の表の値をそのまま使うこと（微調整は統括と利用者が後でやる）。

| トークン | 値 | 用途（置き換え元の目安） |
|---|---|---|
| `--color-surface-0` | `#0a1426` | 一番奥（入力欄の地・`bg-slate-950`） |
| `--color-surface-1` | `#13243f` | パネルの地（`bg-slate-900`） |
| `--color-surface-2` | `#1c3358` | 一段上がった地（`bg-slate-800`） |
| `--color-surface-3` | `#2a4a78` | さらに上（`bg-slate-700`・押下中など） |
| `--color-line` | `rgb(207 226 255 / 0.22)` | 通常の枠線（`border-slate-800/700`） |
| `--color-line-strong` | `rgb(207 226 255 / 0.45)` | 強めの枠線（`border-slate-600/500`） |
| `--color-ink` | `#eef4ff` | 本文（`text-slate-100〜300`・`text-white` の本文用途） |
| `--color-ink-muted` | `#9fb6d8` | 補足（`text-slate-400/500`） |
| `--color-ink-faint` | `#6f88ad` | さらに弱い（`text-slate-600`） |
| `--color-accent` | `#8fd0ff` | 操作・情報の差し色（`sky-*`） |
| `--color-ok` | `#7fe0c4` | 決定・待機・気力など肯定（`emerald-*` `green-*`） |
| `--color-warn` | `#ffd98a` | 注意・選択中の金（`amber-*`） |
| `--color-danger` | `#ff7a8a` | バトル・中断・ダウン（`red-*`） |
| `--color-on-accent` | `#0f2542` | 明るい地のボタン上の文字 |

- 元の濃淡の違い（`sky-300` と `sky-400` など）は**1つのトークン＋不透明度**で表す（`text-accent`／`text-accent/80`、`bg-accent/10`、`border-accent/60`）。
  置き換え表を作って HANDOFF に載せる（元クラス → 新クラス）
- `body` の背景は見本の `--bg`（`radial-gradient(ellipse at 30% 20%, #2a4a78 0%, #13243f 45%, #0a1426 100%)`・`background-attachment: fixed`）

### 1-1. 置き換え
- `src/ui/` の全ファイルで、Tailwind のパレット色クラス（`slate` `sky` `emerald` `amber` `red` `green` `zinc` `gray` 等の `-数字`）を上のトークンに置き換える。
- **例外として残してよいもの**: `white` `black` `transparent`、画像の上に重ねる暗幕（`bg-black/60` 等）。それ以外で残すなら理由を HANDOFF に1行ずつ書く

## 2. 質感（見本の `.panel` `.btn` `.card`）

`@utility` で次の3つを作り、**指定した場所だけ**に付ける（他は §1 の置き換えだけで足りる）。
- `lf-panel`: 見本の `.panel`（地 `linear-gradient(180deg, #1c3358e6, #122542e6)`・枠 `--color-line-strong`・影 `0 0 0 1px #ffffff10, 0 8px 24px #0006`・角丸 8px）。
  付ける場所: 右列の BattlePanel・DetailPanel の箱・StackPanel、左列のログ、ヘッダー下の接続/システムの箱（既存の `rounded border bg-slate-900/60` 系の外枠を置き換え）
- `lf-btn-primary`: 見本の `.btn`（地 `linear-gradient(180deg, #e9f4ff, #b9d8f5)`・文字 `--color-on-accent`・枠 白・太字）。
  付ける場所: StackPanel の「通す（パス）」「解決」、BattlePanel の「次へ」「決定」「ダメージを適用」「⚔ バトルを挑む」。無効時は今の `disabled:opacity-30` を保つ
- `lf-card-rim`: 見本の `.card` の影（`0 0 0 1.5px #f4ecff, 0 0 10px #b9a8ff66, 0 4px 10px #0008`）。
  付ける場所: 盤面・手札のカード（`CardPiece` の外枠。今の `border-slate-600` の枠線の代わり）。**拡大プレビュー・詳細パネル・カード一覧には付けない**
  - 選択中は今の緑の輪の代わりに**金の輪**（`--color-warn`・見本の `.card.sel`）。ホバーの枠色は `accent`

## 3. 文字

- 本文フォントを **M PLUS 1p**（400/700/800）にする。`index.html` に Google Fonts の `<link>`（`display=swap`）を足し、
  `body` の `font-family` の先頭に置く（後ろに今の system-ui 系を残す＝読み込めなくても表示される）
- 🚨 フォントで文字幅が変わってもマスの大きさは変わらないはずだが、**§6 の縦スクロールの機械チェックで確かめる**

## 4. カード裏面

- 素材: `_local/card-back.jpg`（利用者提供・権利物）
- `scripts/build-data-bundle.mjs`: `_local/card-back.jpg` があれば zip に `back.jpg` として入れる（無ければ入れずに続行＝`annotations.json` と同じ流儀）
- `src/data/bundle.ts`: `entries['back.jpg']` があれば `db.images` に **id `__card-back__`** で保存。`loadLibrary` の `imageUrls` に自然に載る
- `CardFace.tsx` の裏面（今の「裏」の文字）を、裏面画像があれば全面画像（`object-cover`）に。無ければ今の表示のまま（旧 zip 互換）。
  受け渡しは prop でも React の context でもよい（`CardFace` を使う4か所 `CardPiece` `HoverPreview` `CardTile` ほかに素直な方）。どちらにしたか HANDOFF に書く
- `npm run data:bundle` を実行して `dist-data/leaffight-data.zip` を作り直す（`dist-data/` は gitignore 済み）

## 5. やらないこと

- 配置・大きさの変更、ロゴの追加、文言の変更、アニメーション
- CardList（カード一覧画面）の作り込み（§1 の色の置き換えだけはやる）
- 見本の B/C 案やテーマ切替機能

## 6. 機械チェック（HANDOFF に出力を貼る）

1. `grep -rnE "\b(bg|text|border|from|to|via|ring|outline|shadow|decoration|divide|fill|stroke)-(slate|sky|emerald|amber|red|green|zinc|gray|blue|rose|yellow|orange|indigo|violet|neutral|stone)-[0-9]" src/ui` → **0件**（例外は §1-1 の理由つきのみ）
2. `npm run verify` 緑。件数は「全ケース成功」の行を除いて数える
3. `dist-data/leaffight-data.zip` に `back.jpg` が入っている（`unzip -l` 等の出力）
4. 盤面の縦スクロールなし: 1280×720 と 1920×1080 で `document.scrollingElement.scrollHeight <= innerHeight`

## 7. 煙試験（🚨 ツール呼び出しは**合計40回まで**。2タブの対戦確認はしない＝統括がやる）

- dev サーバー（`.claude/launch.json` の `leaffight-dev`・見つからなければ `npm run dev` をバックグラウンドで起動して `http://localhost:5300` を開く）で1タブだけ開く
- 新しい zip を読み込ませる（`IMPLEMENTATION-NOTES.md` の fetch→DataTransfer の手順）
- 確かめること: console エラーなし／デッキのカードに裏面画像が出る（`img` の `src` が blob: で naturalWidth>0）／§6-4／カード1枚に `lf-card-rim` が効いている（computed `box-shadow`）
- スクリーンショットは撮らない（タイムアウトする）

## 8. 報告

`HANDOFF-P2.11.md` を1枚:
- 変えたファイル／置き換え表（元クラス → 新クラス）／§1-1 の例外とその理由／§4 の受け渡し方式
- **自己点検**: §1〜§4 の要求それぞれに「実装した場所（ファイル:行）」。§6・§7 に無い要求（`lf-panel` を付けた場所の一覧、選択中の金の輪、ホバー色、フォントの後ろに system-ui を残したこと）も1行ずつ
- §6 の出力、§7 の結果、使ったツール回数
- 🚨 **コミットしない**
