import type { CardInstance, Seat } from '../../core/board'

/**
 * このクライアント（mySeat）の画面に、カードの中身を見せてよいか（PHASE5c.md §1）。
 * ログの非公開判定（core の isPublicCard）とは別物：こちらは「見ている本人にとって」の話なので
 * 視点（mySeat）を引数に取る。core には持ち込まない（DESIGN.md §5「localSeatをBoardStateに入れない」）。
 *
 * - デッキは🚨自分のデッキでも隠す（実物でも自分の山の一番上は知らない）
 * - 相手の手札・相手の裏向きカードは隠す
 * - 自分の裏向きリーダー・自分の手札は自分には見えてよい（P5bの方針どおり）
 */
export function hiddenFromViewer(c: Pick<CardInstance, 'owner' | 'zone' | 'faceUp'>, mySeat: Seat): boolean {
  if (c.zone === 'deck') return true
  return c.owner !== mySeat && (c.zone === 'hand' || !c.faceUp)
}
