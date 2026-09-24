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
  /** 性別（PHASE-DB.md §3）。cells から抽出。表示・判定にはまだ使わない（入れるだけ） */
  sex: '男性' | '女性' | ''
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

/**
 * 割り込み（トリガー）の注釈（ユーザー校正済み。DESIGN.md §5.1「割り込み自動検出」）。
 * `timings` は原典60種の正規タイミング名（_local/interrupt-timings.md）そのまま。
 * `subject` は主語スコープの生テキスト（PHASE3c.md §3の表で解釈する。'相手が'/'味方キャラが' 等）。
 */
export interface InterruptAnnotation {
  ability: string
  cost: string
  subject: string
  timings: string[]
}

/** card.id をキーにした割り込み注釈のマップ */
export type InterruptsMap = Record<string, InterruptAnnotation[]>

/** 旧id -> 新id の読み替え表（PHASE-DB.md §2）。zip内 aliases.json。旧バンドルでは空扱い */
export type AliasMap = Record<string, string>
