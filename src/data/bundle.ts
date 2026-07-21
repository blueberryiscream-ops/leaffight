import { strFromU8, unzipSync } from 'fflate'
import { db, readAnnotations, writeAnnotations, writeBundleMeta } from './db'
import type { AnnotationsMap, BundleMeta, PoolCard, StoredImage } from './types'

// ZIP展開はブラウザ内で行う（サーバーを持たないため）。fflate は軽くて依存ゼロ。

export type ImportProgress = (message: string) => void

// fflate の Uint8Array は ArrayBufferLike 型（SharedArrayBuffer の可能性を含む）なので
// そのままでは BlobPart に渡せない。実体は必ず通常の ArrayBuffer なので絞り込む。
const toBlobPart = (data: Uint8Array): BlobPart => data as Uint8Array<ArrayBuffer>

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

  onProgress?.(`カード ${cards.length} 種を保存しています…`)
  const images: StoredImage[] = []
  for (const card of cards) {
    if (!card.image) continue
    const data = entries[card.image]
    if (data) images.push({ id: card.id, blob: new Blob([toBlobPart(data)], { type: 'image/jpeg' }) })
  }

  // 入れ替えは1つのトランザクションで行う。途中で失敗しても、前のデータが消えたまま残らない。
  await db.transaction('rw', db.cards, db.images, db.meta, async () => {
    await db.cards.clear()
    await db.images.clear()
    await db.meta.clear()
    await db.cards.bulkPut(cards)
    await db.images.bulkPut(images)
    await writeBundleMeta({ ...meta, cardCount: cards.length, imageCount: images.length })
    await writeAnnotations(annotations)
  })

  return { ...meta, cardCount: cards.length, imageCount: images.length }
}

/** 一覧描画用に、カードと画像のURL・起動能力の注釈をまとめて取り出す。URLは呼び出し側が revoke する */
export async function loadLibrary(): Promise<{ cards: PoolCard[]; imageUrls: Map<string, string>; annotations: AnnotationsMap }> {
  const cards = await db.cards.toArray()
  cards.sort((a, b) => a.kind.localeCompare(b.kind) || a.kana.localeCompare(b.kana, 'ja'))

  const imageUrls = new Map<string, string>()
  for (const img of await db.images.toArray()) {
    imageUrls.set(img.id, URL.createObjectURL(img.blob))
  }
  const annotations = await readAnnotations()
  return { cards, imageUrls, annotations }
}
