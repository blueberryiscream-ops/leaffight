// R4c G9a-2b: タッグの構成要素の名前（キャラ名）の解決。core はカード知識ゼロのまま、engine の層に1か所だけ置く。
// タッグの名前は「由綺＆理奈」のように構成要素の短い名前を「＆」でつないで書かれている（当たるのは たま＆アレイ・マルチ＆セリオ等だけ完全一致）。
// ここで ctx.cards（キャラクターカード）の名前に解決する。tagParts（drive.ts のタッグ化の宣言）・layers の構成要素制限・eval の componentOf・HM-12S の「末尾Ｓ」の読みはすべてここを通る。
import type { EngineCtx } from './ctx'

const cache = new WeakMap<object, Map<string, string[]>>()

/** 短い名前 → キャラ名。完全一致があればそれ。無ければ「キャラ名が短い名前を含む」キャラが1つだけならその名前。2つ以上なら「短い名前で終わる」ものが1つだけのときそれ。0 または決まらなければ未解決（短い名前のまま返す）。別名のカード（SP・覆製身）はここでは選ばず、componentKey で元のキャラにそろえて突き合わせる（利用者の決定 2026-11-05＝別名も構成要素に入る） */
export function resolveCharName(ctx: EngineCtx, short: string): string {
  const names = new Set<string>()
  for (const c of Object.values(ctx.cards)) if (c.kind === 'c') names.add(c.name)
  if (names.has(short)) return short
  const inc = [...names].filter((n) => n.includes(short))
  if (inc.length === 1) return inc[0]
  // 2つ以上: 末尾が一致するもの（神岸あかり／神岸あかりSP・坂神蝉丸／坂神蝉丸・覆製身 のように接尾の付く別名のカードを除く）が1つだけならそれ
  const end = inc.filter((n) => n.endsWith(short))
  return end.length === 1 ? end[0] : short
}

const keyCache = new WeakMap<object, Map<string, string>>()

/**
 * キャラ名 → 構成要素として突き合わせる名前（統括41・利用者の決定 2026-11-05）: 別名のカード（神岸あかりSP・太田香奈子SP・坂神蝉丸・覆製身・杜若きよみ・覆製身・スフィー（マジカルサンダー））は
 * 元のキャラ（その名前で始まる、より短いキャラ名のうち最も長いもの）としてタッグの構成要素に入る。元が無ければその名前のまま
 */
export function componentKey(ctx: EngineCtx, charName: string): string {
  let m = keyCache.get(ctx.cards)
  if (!m) keyCache.set(ctx.cards, (m = new Map()))
  const got = m.get(charName)
  if (got !== undefined) return got
  let best = charName
  for (const c of Object.values(ctx.cards)) if (c.kind === 'c' && c.name !== charName && charName.startsWith(c.name) && (best === charName || c.name.length > best.length)) best = c.name
  m.set(charName, best)
  return best
}

/** タッグの名前 → 構成要素のキャラ名2つ（componentKey にそろえた名前）。「＆」の無いタッグ（ＨＭ－１２Ｓ）は末尾の「Ｓ」を除いた名前の2体（FAQ:3529）。タッグでない名前は [名前]（短い名前の解決はしない） */
export function tagComponents(ctx: EngineCtx, name: string): string[] {
  let m = cache.get(ctx.cards)
  if (!m) cache.set(ctx.cards, (m = new Map()))
  const got = m.get(name)
  if (got) return got
  const ps = name.split('＆')
  const out = ps.length === 1 ? (name.endsWith('Ｓ') ? [name.slice(0, -1), name.slice(0, -1)] : [name]) : ps
  const res = out.map((p) => componentKey(ctx, resolveCharName(ctx, p)))
  m.set(name, res)
  return res
}
