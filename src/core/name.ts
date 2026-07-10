// カード名の正規化。
//
// ⚠️ ここは「検索用」。カードIDを決める正規化は scripts/build-data-bundle.mjs 側が正で、
//    そちらが3つのデータソース（LFWIKI / tcg-db / X）を突き合わせる唯一の場所。
//    表示名は常に元の文字列を使う（DESIGN.md §10）。

/** 全角ASCII→半角、長音/ダッシュ統一、中黒と空白を除去。比較用のキーを作る */
export function searchKey(s: string): string {
  return s
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ')
    .replace(/[・‧·／/]/g, '')
    .replace(/[ー－‐‑‒–—―]/g, '-')
    .replace(/\s+/g, '')
    .toLowerCase()
}
