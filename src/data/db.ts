import Dexie, { type Table } from 'dexie'
import type { BoardState } from '../core/board'
import type { Deck } from './deck'
import type { AnnotationsMap, BundleMeta, InterruptsMap, PoolCard, StoredImage } from './types'

// カードデータと画像はリポジトリに入れない（権利面。DESIGN.md §7.5）。
// ユーザーがローカルのZIPを読み込み、その中身をこの IndexedDB に保存して以後使う。

interface MetaRow {
  key: string
  value: unknown
}

interface BoardRow {
  key: string
  value: BoardState
}

export class LeafFightDb extends Dexie {
  cards!: Table<PoolCard, string>
  images!: Table<StoredImage, string>
  meta!: Table<MetaRow, string>
  board!: Table<BoardRow, string>
  decks!: Table<Deck, string>

  constructor() {
    super('leaffight')
    this.version(1).stores({
      cards: 'id, kind, name',
      images: 'id',
      meta: 'key',
    })
    // P1: 盤面（ローカル対戦卓）の自動保存用テーブルを追加
    this.version(2).stores({
      cards: 'id, kind, name',
      images: 'id',
      meta: 'key',
      board: 'key',
    })
    // P5a: デッキ保存用テーブルを追加（PHASE5a.md §3）。既存テーブルの定義はそのまま繰り返す
    this.version(3).stores({
      cards: 'id, kind, name',
      images: 'id',
      meta: 'key',
      board: 'key',
      decks: 'id, updatedAt',
    })
  }
}

export const db = new LeafFightDb()

const META_KEY = 'bundle'
const BOARD_KEY = 'board'
const ANNOTATIONS_KEY = 'annotations'
const INTERRUPTS_KEY = 'interrupts'

export async function readBundleMeta(): Promise<BundleMeta | null> {
  const row = await db.meta.get(META_KEY)
  return (row?.value as BundleMeta | undefined) ?? null
}

export async function writeBundleMeta(meta: BundleMeta): Promise<void> {
  await db.meta.put({ key: META_KEY, value: meta })
}

/** 起動能力の注釈（PHASE3a-2b.md §3-2）。annotations.json が無いzip（旧バンドル）では空のまま */
export async function readAnnotations(): Promise<AnnotationsMap> {
  const row = await db.meta.get(ANNOTATIONS_KEY)
  return (row?.value as AnnotationsMap | undefined) ?? {}
}

export async function writeAnnotations(annotations: AnnotationsMap): Promise<void> {
  await db.meta.put({ key: ANNOTATIONS_KEY, value: annotations })
}

/** 割り込みの注釈（PHASE3c.md §1）。interrupts.json が無いzip（旧バンドル）では空のまま */
export async function readInterrupts(): Promise<InterruptsMap> {
  const row = await db.meta.get(INTERRUPTS_KEY)
  return (row?.value as InterruptsMap | undefined) ?? {}
}

export async function writeInterrupts(interrupts: InterruptsMap): Promise<void> {
  await db.meta.put({ key: INTERRUPTS_KEY, value: interrupts })
}

/** 「データを削除して読み込み直す」用。カード定義が消えるので、それを参照する盤面も一緒に消す */
export async function clearBundle(): Promise<void> {
  await db.transaction('rw', db.cards, db.images, db.meta, db.board, async () => {
    await db.cards.clear()
    await db.images.clear()
    await db.meta.clear()
    await db.board.clear()
  })
}

export async function readBoardState(): Promise<BoardState | null> {
  const row = await db.board.get(BOARD_KEY)
  return row?.value ?? null
}

export async function writeBoardState(state: BoardState): Promise<void> {
  await db.board.put({ key: BOARD_KEY, value: state })
}

// デッキ（PHASE5a.md §3）。🚨 clearBundle（カードデータの削除・上の関数）はdecksに触らない。
// カードデータを入れ直してもデッキは残るべきで、id は `kind_正規化名` で安定している（DESIGN.md §4.21）。

export async function listDecks(): Promise<Deck[]> {
  return db.decks.toArray()
}

export async function saveDeck(deck: Deck): Promise<void> {
  await db.decks.put(deck)
}

export async function deleteDeck(id: string): Promise<void> {
  await db.decks.delete(id)
}
