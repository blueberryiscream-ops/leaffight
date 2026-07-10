# フェーズ0 指示書 — 基盤づくり

発行: 統括セッション（Opus）/ 2026-07-10
実施: **Sonnet 作業セッション**
前提資料: `DESIGN.md`（これが「正」。着手前に §3 アーキテクチャ・§5 汎用ギミック・§7 カードデータ を必ず読むこと）

---

## 0. このフェーズのゴール

**完了条件（これが満たされたら報告して終了）**

1. `npm run build` が型チェック込みで通る
2. GitHub Pages に自動デプロイされ、公開URLでアプリが開く
3. 起動後、ユーザーがローカルのデータファイルを読み込むと、**ver.1〜3プールの約420種のカードが一覧表示される**（テキスト表示、画像があれば表示）
4. `core/` が `ui/` `net/` を一切 import していない

**やらないこと（スコープ外・触るな）**
- 盤面、対戦、通信、ルール処理、デッキビルダー（P1以降）
- 見た目の作り込み（P5）

---

## 1. 環境

- Windows / PowerShell 5.1（**日本語まわりの罠は `DESIGN.md` の落とし穴を読むこと**）
- Node 22 / npm
- 既存の姉妹プロジェクト `C:\Claudecode作業スペース\tcg-companion\` が同じスタックで完動している。**迷ったらそこを参照して流儀を合わせる。**
- 開発ポートは **5300**（tcg-companion が 5200 を使うため衝突回避）。`vite.config.ts` に `server:{ host:true, port:5300, strictPort:true }` を焼き込む。
- `.claude/launch.json` に `"leaffight-dev"` を追加し、preview_* ツールで動作確認できるようにする。
- `start-dev.bat`（ダブルクリック起動）も用意する。tcg-companion のものを流用。

---

## 2. 技術スタック（確定済み・議論不要）

TypeScript / React / Vite / Tailwind / Dexie(IndexedDB) / GitHub Actions + Pages。
`vite.config.ts` の `base` は `'/leaffight/'`。

---

## 3. ディレクトリ構成（厳守）

```
leaffight/
  src/
    core/    純TypeScript。React・DOM・通信・Dexie を一切 import しない。
             ゲーム状態・ルール・型定義。将来 C# に翻訳する層。
    net/     通信。P0では空でよいが Transport インターフェースだけ置く。
    ui/      React コンポーネント。
    data/    cards の型・ローダ・IndexedDB(Dexie)。
  scripts/
    build-data-bundle.mjs   ← 下記 §5
  _local/    （既存・gitignore済み。触るのは読み取りのみ）
```

**`core/` の import 制約は ESLint ルールか、最低でもレビュー観点として明記すること。** これを破ると将来のUnity移植が死ぬ。

---

## 4. 権利面の制約（重要・設計の前提）

**カード画像もカードデータもリポジトリに入れない。** アプリは**コードのみ**を公開する。

したがって：
- カードデータは**ビルド時に埋め込まない**。
- ユーザーが起動後にローカルの `leaffight-data.zip` を選択 → ブラウザ内で展開 → **IndexedDB に保存**して以後使う。
- `.gitignore` に `_local/`, `dist-data/`, `public/cards/`, `*.zip` を入れる（一部は既に記載済み）。

---

## 5. データバンドル生成スクリプト（`scripts/build-data-bundle.mjs`）

ローカルでのみ実行する。出力はコミットしない（`dist-data/` は gitignore）。

**入力**
| パス | 内容 |
|---|---|
| `_local/sources/cards_v2.json` | 全4,570実体（LFWIKI由来） |
| `_local/cards.json` | tcg-db 由来（画像パス `image` を持つ） |
| `_local/card_images/{setDir}/{id}.jpg` | tcg-db 画像 412枚 |
| `_local/sources/x_cards.csv` | X由来（`cardName`,`cardVer`,`file`） |
| `_local/x_card_images/{tweetId}.jpg` | X 画像 388枚 |

**処理**

1. **プール抽出**: `cards_v2.json` から `setVer` が次の17個のいずれかのものだけを残す。
   ```
   0.9β, 1.00, 1.01β, 1.01, 1.01A, 1.02, 1.03, 1.03A, 1.04,
   2.00β, 2.00, 2.01, 2.02, 2.02A, 2.03, 3.00β, 3.00, 3.01
   ```
   **この配列は1箇所（定数）にだけ書く。** 後日 ver.4 以降を足すのが「配列に追記するだけ」で済むこと（ユーザー明示要望）。

2. **刷り → カードへの畳み込み**: 同じカードが複数の版で刷られている。**キー = `kind` + 正規化カード名**。
   同キーの中から、下の版順で**最も新しい刷りを採用**する（後の版がエラッタ反映済みのため）。
   ```
   0.9β < 1.00 < 1.01β < 1.01 < 1.01A < 1.02 < 1.03 < 1.03A < 1.04
        < 2.00β < 2.00 < 2.01 < 2.02 < 2.02A < 2.03 < 3.00β < 3.00 < 3.01
   ```
   採用しなかった刷りの `setVer` は `printings: string[]` として残すこと。

3. **名前の正規化関数 `norm(s)`**（`_local/sources/coverage.ps1` の `Norm` を JS に移植）
   - HTMLエンティティを **2回** デコード（Xの本文は二重エンコード）
   - 全角ASCII `U+FF01–U+FF5E` → 半角（`- 0xFEE0`）。**カタカナは変換しない**
   - `U+3000`（全角空白）→ 半角空白
   - 中黒 `・ ‧ ·` を除去、空白をすべて除去
   - 長音・ダッシュ類 `ー － ‐ ‑ ‒ – — ―` を `-` に統一
   - ⚠️ 正規化は**突き合わせ用のキーにのみ使う**。表示名は元の文字列を保持すること。

4. **画像の紐付け**: `norm(カード名)` をキーに、
   - **第1候補 = tcg-db 画像**（カードのスキャン画像。綺麗）
   - **第2候補 = X 画像**（実物カードの写真。角度・光にばらつきあり）
   - どちらも無ければ画像なし。

5. **出力**: `dist-data/leaffight-data.zip`
   ```
   pool.json            … カード配列（下記スキーマ）
   images/{cardId}.jpg  … 紐付いた画像のみ
   meta.json            … { generatedAt, poolSets[], cardCount, imageCount }
   ```

**`pool.json` のカードスキーマ**
```ts
type PoolCard = {
  id: string;          // `${kind}_${norm(name)}` … 安定した一意キー
  kind: 'c'|'t'|'b'|'i'|'e'|'f';   // キャラ/タッグ/バトル/アイテム/イベント/フィールド
  name: string;        // 表示名（元の文字列）
  kana: string;
  setVer: string;      // 採用した刷りの版
  printings: string[]; // この版以外に存在する刷り
  num: number;         // wiki のカード番号（無い場合 -1）
  kiryoku: number|null;
  stats: { 力:number; 早:number; 賢:number; 根:number; 感:number } | null;
  cost: string;        // 'WW' 等。W/R/G/L/T
  attr: string;        // 属性（複合は元表記のまま）
  battleAtk: string;   // バトルカードのみ。'力' '-' '？' 等
  battleDef: string;
  abilities: { header: string; text: string }[];
  illust: string;
  cells: string[];     // ★ wiki の生セル。絶対に落とさない（再解釈のため）
  image: string|null;  // 'images/xxx.jpg' or null
};
```

**スクリプト実行後、次を標準出力に出すこと**（統括への報告に使う）:
- プール内のユニークカード数（`kind`+正規化名 ベース）
- 画像が紐付いた数と割合、種別ごとの内訳
- 画像なしカードの数

> 統括の実測値: 正規化名ベースで **420種 / 画像211種（50.2%）**、キャラ94%・タッグ72%。
> `kind`+名前のキーにすると数がわずかに増える可能性がある。**実際の数を報告すること。** 大きくズレたら正規化のバグを疑え。

---

## 6. アプリ側（P0で作るもの）

1. **初回起動画面**: 「データファイル（`leaffight-data.zip`）を読み込む」ボタン。
   - ZIP展開はブラウザ内で行う（`fflate` 推奨。軽い）。
   - `pool.json` と画像を Dexie で IndexedDB に保存。画像は Blob で保存。
   - 2回目以降は自動で IndexedDB から読む。
   - 「データを削除して読み込み直す」も置く。

2. **カード一覧画面**: 420種を表示。
   - **テキスト表示が基本形。画像は「あれば載せる」装飾。**
   - **画像の有無でレイアウトが崩れないこと**（これは受け入れ条件）。
   - 種別・属性・名前でのフィルタ／検索。
   - キャラは 気力・能力値・コスト・属性・特殊能力を表示。
   - バトルカードは `攻:X 防:Y` を表示。

3. **`core/` に置く型だけ先に切る**: `Card`, `Zone`, `CostKind`（W/R/G/L/T）, `Attr`（力/早/賢/根/感）。
   ゲーム状態や遷移は P1 以降。**ここで作り込むな。**

4. **`net/Transport` インターフェースだけ置く**（実装なし）。
   ```ts
   export interface Transport {
     host(): Promise<string>;
     join(code: string): Promise<void>;
     send(msg: unknown): void;
     onMessage(cb: (msg: unknown) => void): void;
   }
   ```

---

## 7. デプロイ

- リポジトリ: `blueberryiscream-ops/leaffight`（**Public、コードのみ**）
- `.github/workflows/deploy.yml` … main への push で build → `actions/deploy-pages`
- Node は 22
- **リポジトリ作成と GitHub 認証はユーザーの操作が必要**。tcg-companion のときと同じ手順で伴走すること（Pages の Source = GitHub Actions）。

---

## 8. 検証（必須）

- `npm run build` を通す（型エラーを残さない）
- `preview_start` で `leaffight-dev` を起動し、`preview_console_logs` でエラーゼロを確認
- データZIPを読み込ませ、一覧が出ることを `preview_snapshot` / `preview_screenshot` で確認
- **画像なしカードでレイアウトが崩れないこと**を実際に確認（画像なしカードは209種あるので必ず出る）

---

## 9. 終了時にやること

`leaffight/HANDOFF-P0.md` を1枚書いて、統括セッションに戻る。含めるもの:

- 実際のカード数・画像被覆率（種別ごと）。統括の見積もり（420種/50.2%）とのズレと、その理由
- 採用したライブラリと理由（特にZIP展開）
- ハマった点（特に文字コード・名前の正規化）
- `core/` の import 制約をどう担保したか
- 公開URL
- P1 に持ち越す課題

---

## 10. 注意（過去に踏んだ地雷）

- **PowerShellスクリプトに日本語パスを直書きしない。** `$PSScriptRoot` から導く。BOM無しUTF-8だと文字化けして落ちる。
- Node側でも `_local/` のパスは相対で解決すること。
- `cells` フィールドを削るな。抽出を間違えたときの唯一の復旧手段。
- カード名の正規化は**キー専用**。画面には元の名前を出す。
