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

/**
 * 起動能力の注釈（ユーザー校正済み。DESIGN.md §5.1「起動アクションのデータ層」）。
 * `type`が`常時`以外＝起動型（詳細パネルにトリガーボタンを出す対象）。
 * `cost`はミニ表記のラベル表示のみ（自動処理はP3b）。
 */
export interface AbilityAnnotation {
  name: string
  type: '通常起動' | '割込起動' | '常時' | '通常起動+割込起動'
  cost: string
}

/** card.id をキーにした起動能力注釈のマップ */
export type AnnotationsMap = Record<string, AbilityAnnotation[]>
