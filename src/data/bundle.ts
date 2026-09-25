import { strFromU8, unzipSync } from 'fflate'
import { db, migrateAliasReferences, readAnnotations, readCardDefs, readInterrupts, writeAnnotations, writeBundleMeta, writeCardDefs, writeInterrupts } from './db'
import type { AliasMap, AnnotationsMap, BundleMeta, InterruptsMap, PoolCard, StoredImage } from './types'

// ZIP展開はブラウザ内で行う（サーバーを持たないため）。fflate は軽くて依存ゼロ。

export type ImportProgress = (message: string) => void

/** カード裏面画像の db.images 上の予約id（PHASE2.11.md §4）。カードidと衝突しない形にする。 */
export const CARD_BACK_IMAGE_ID = '__card-back__'

// fflate の Uint8Array は ArrayBufferLike 型（SharedArrayBuffer の可能性を含む）なので
// そのままでは BlobPart に渡せない。実体は必ず通常の ArrayBuffer なので絞り込む。
const toBlobPart = (data: Uint8Array): BlobPart => data as Uint8Array<ArrayBuffer>

/** zip内のパスの拡張子から MIME を決める。発見画像に webp が混じるため jpeg 固定にはできない
 *  （PHASE: 手動発見画像の配線・2026-08-06）。未知の拡張子は jpeg 扱いで従来どおり。 */
const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
}
const mimeOf = (p: string): string => MIME_BY_EXT[p.slice(p.lastIndexOf('.') + 1).toLowerCase()] ?? 'image/jpeg'

/**
 * ローカルの leaffight-data.zip を読み込み、IndexedDB に保存する。
 * 既存のデータは置き換える。
 */
export async function importBundle(file: File, onProgress?: ImportProgress): Promise<BundleMeta> {
  onProgress?.('ZIPを読み込んでいます…')
  const bytes = new Uint8Array(await file.arrayBuffer())

  onProgress?.('ZIPを展開しています…')
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(bytes)
  } catch (e) {
    throw new Error(`ZIPを展開できませんでした（壊れているか、ZIPではありません）: ${String(e)}`)
  }

  const poolRaw = entries['pool.json']
  if (!poolRaw) {
    throw new Error('pool.json が入っていません。leaffight-data.zip を選んでください。')
  }

  const cards = JSON.parse(strFromU8(poolRaw)) as PoolCard[]
  if (!Array.isArray(cards) || cards.length === 0) {
    throw new Error('pool.json にカードが入っていません。')
  }

  // 旧バンドル（Ability.cost/auto・PoolCard.charTypes を持たない zip）の既定値の補い（PHASE-E0.md §4）。
  // 新フィールドが無ければ既定値で補う: cost無し→''、auto無し→false、charTypes無し→[]
  for (const card of cards) {
    card.charTypes ??= []
    for (const ability of card.abilities) {
      ability.cost ??= ''
      ability.auto ??= false
    }
  }

  const metaRaw = entries['meta.json']
  const meta: BundleMeta = metaRaw
    ? (JSON.parse(strFromU8(metaRaw)) as BundleMeta)
    : {
        generatedAt: new Date().toISOString(),
        poolSets: [...new Set(cards.map((c) => c.setVer))],
        cardCount: cards.length,
        imageCount: 0,
      }

  // 起動能力の注釈（PHASE3a-2b.md §3-1/§3-2）。旧バンドル（annotations.json未収載）では空扱い
  const annotationsRaw = entries['annotations.json']
  const annotations: AnnotationsMap = annotationsRaw ? (JSON.parse(strFromU8(annotationsRaw)) as AnnotationsMap) : {}

  // 割り込みの注釈（PHASE3c.md §1）。旧バンドル（interrupts.json未収載）では空扱い
  const interruptsRaw = entries['interrupts.json']
  const interrupts: InterruptsMap = interruptsRaw ? (JSON.parse(strFromU8(interruptsRaw)) as InterruptsMap) : {}

  // カードの記述（R2u）。旧バンドル（carddefs.json未収載）では空扱い
  const cardDefsRaw = entries['carddefs.json']
  const cardDefs: Record<string, unknown> = cardDefsRaw ? (JSON.parse(strFromU8(cardDefsRaw)) as Record<string, unknown>) : {}

  // 旧id→新idの読み替え表（PHASE-DB.md §2）。旧バンドル（aliases.json未収載）では空扱い
  const aliasesRaw = entries['aliases.json']
  const aliases: AliasMap = aliasesRaw ? (JSON.parse(strFromU8(aliasesRaw)) as AliasMap) : {}

  onProgress?.(`カード ${cards.length} 種を保存しています…`)
  const images: StoredImage[] = []
  for (const card of cards) {
    if (!card.image) continue
    const data = entries[card.image]
    if (data) images.push({ id: card.id, blob: new Blob([toBlobPart(data)], { type: mimeOf(card.image) }) })
  }

  // カード裏面（PHASE2.11.md §4）。旧ZIP（back.jpg未収載）では単に無い扱い＝旧挙動のまま
  const backRaw = entries['back.jpg']
  if (backRaw) {
    images.push({ id: CARD_BACK_IMAGE_ID, blob: new Blob([toBlobPart(backRaw)], { type: mimeOf('back.jpg') }) })
  }

  // 入れ替えは1つのトランザクションで行う。途中で失敗しても、前のデータが消えたまま残らない。
  await db.transaction('rw', db.cards, db.images, db.meta, async () => {
    await db.cards.clear()
    await db.images.clear()
    await db.meta.clear()
    await db.cards.bulkPut(cards)
    await db.images.bulkPut(images)
    // imageCount は「カード画像」の枚数（カード裏面は別枠なので数えない・DataGate等の表示に一致させる）
    const cardImageCount = images.filter((img) => img.id !== CARD_BACK_IMAGE_ID).length
    await writeBundleMeta({ ...meta, cardCount: cards.length, imageCount: cardImageCount })
    await writeAnnotations(annotations)
    await writeInterrupts(interrupts)
    await writeCardDefs(cardDefs)
  })

  // カードデータ本体とは別トランザクション（db.decks/db.board は clearBundle 同様に触らない設計。
  // db.ts参照）。保存済みデッキ・盤面が旧idを参照していれば新idに読み替える
  await migrateAliasReferences(aliases)

  const cardImageCount = images.filter((img) => img.id !== CARD_BACK_IMAGE_ID).length
  return { ...meta, cardCount: cards.length, imageCount: cardImageCount }
}

/** 一覧描画用に、カードと画像のURL・起動能力/割り込みの注釈をまとめて取り出す。URLは呼び出し側が revoke する */
export async function loadLibrary(): Promise<{
  cards: PoolCard[]
  imageUrls: Map<string, string>
  annotations: AnnotationsMap
  interrupts: InterruptsMap
  cardDefs: Record<string, unknown>
}> {
  const cards = await db.cards.toArray()
  cards.sort((a, b) => a.kind.localeCompare(b.kind) || a.kana.localeCompare(b.kana, 'ja'))

  const imageUrls = new Map<string, string>()
  for (const img of await db.images.toArray()) {
    imageUrls.set(img.id, URL.createObjectURL(img.blob))
  }
  const annotations = await readAnnotations()
  const interrupts = await readInterrupts()
  const cardDefs = await readCardDefs()
  return { cards, imageUrls, annotations, interrupts, cardDefs }
}
