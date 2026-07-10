import Dexie, { type Table } from 'dexie'
import type { BundleMeta, PoolCard, StoredImage } from './types'

// カードデータと画像はリポジトリに入れない（権利面。DESIGN.md §7.5）。
// ユーザーがローカルのZIPを読み込み、その中身をこの IndexedDB に保存して以後使う。

interface MetaRow {
  key: string
  value: unknown
}

export class LeafFightDb extends Dexie {
  cards!: Table<PoolCard, string>
  images!: Table<StoredImage, string>
  meta!: Table<MetaRow, string>

  constructor() {
    super('leaffight')
    this.version(1).stores({
      cards: 'id, kind, name',
      images: 'id',
      meta: 'key',
    })
  }
}

export const db = new LeafFightDb()

const META_KEY = 'bundle'

export async function readBundleMeta(): Promise<BundleMeta | null> {
  const row = await db.meta.get(META_KEY)
  return (row?.value as BundleMeta | undefined) ?? null
}

export async function writeBundleMeta(meta: BundleMeta): Promise<void> {
  await db.meta.put({ key: META_KEY, value: meta })
}

/** 「データを削除して読み込み直す」用 */
export async function clearBundle(): Promise<void> {
  await db.transaction('rw', db.cards, db.images, db.meta, async () => {
    await db.cards.clear()
    await db.images.clear()
    await db.meta.clear()
  })
}
