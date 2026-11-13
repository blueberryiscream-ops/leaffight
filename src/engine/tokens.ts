/*
 * トークン（カードでないキャラ＝ゴースト。R4c G9a-2c・NH-42⑥⑦・FAQ:3302）
 *
 * core はカード知識ゼロのまま: トークンは CardInstance.token の印と、cardId `token:<名前>` の印刷情報だけを持つ。
 * 能力値・名前・性質（traits）はカードの記述（createToken の TokenSpec）から ctx.cards / ctx.defs に**ここで**登録する
 * （能力値を ctx.cards に無いところから読む口はここ1か所）。
 */
import type { CardInfo, EngineCtx } from './ctx'
import type { CardDef, TokenSpec } from './dsl'

export const tokenIdOf = (spec: TokenSpec): string => `token:${spec.name}`

export function registerToken(ctx: EngineCtx, spec: TokenSpec): void {
  const id = tokenIdOf(spec)
  if (ctx.cards[id]) return
  const info: CardInfo = {
    id,
    name: spec.name,
    kind: 'c',
    kiryoku: spec.kiryoku,
    stats: { ...spec.stats },
    cost: '',
    attr: spec.attrs.join(''),
    abilities: [],
    charTypes: [...spec.types],
    sex: spec.sex ?? '',
  }
  ctx.cards[id] = info
  const def: CardDef = { id, name: spec.name, kind: 'c', status: 'tested', abilities: spec.traits.length ? [{ kind: 'static', name: 'トークンの性質', effects: spec.traits }] : [] }
  ctx.defs[id] = def
}

/** 記述の中の createToken をすべて登録する（盤面に残っているトークンを、ctx を作り直した後でも読めるように） */
export function registerTokens(ctx: EngineCtx): void {
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) return x.forEach(walk)
    if (!x || typeof x !== 'object') return
    const o = x as Record<string, unknown>
    if (o.op === 'createToken' && o.token) registerToken(ctx, o.token as TokenSpec)
    for (const v of Object.values(o)) walk(v)
  }
  for (const d of Object.values(ctx.defs)) walk(d.abilities)
}

/** 記述の中の createToken の TokenSpec を列挙する（画面が `token:` の cardId を名前・能力値つきで出すため。能力値を読む口は引き続きここだけ） */
export function listTokenSpecs(defs: Record<string, CardDef>): TokenSpec[] {
  const out = new Map<string, TokenSpec>()
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) return x.forEach(walk)
    if (!x || typeof x !== 'object') return
    const o = x as Record<string, unknown>
    if (o.op === 'createToken' && o.token) {
      const spec = o.token as TokenSpec
      out.set(tokenIdOf(spec), spec)
    }
    for (const v of Object.values(o)) walk(v)
  }
  for (const d of Object.values(defs)) walk(d.abilities)
  return [...out.values()]
}
