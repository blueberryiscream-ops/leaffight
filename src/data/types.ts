import type { Card } from '../core/types'

/**
 * データバンドル（leaffight-data.zip）に入っているカード1種。
 * core の Card に、再解釈用の生データと画像パスを足したもの。
 */
export interface PoolCard extends Card {
  /** wiki のテーブルセルの生文字列。抽出を間違えたときの唯一の復旧手段（DESIGN.md §7.6） */
  cells: string[]
  /** ZIP内のパス 'images/xxx.jpg' または null */
  image: string | null
}

/** ZIP内の meta.json */
export interface BundleMeta {
  generatedAt: string
  poolSets: string[]
  cardCount: number
  imageCount: number
}

export interface StoredImage {
  id: string
  blob: Blob
}
