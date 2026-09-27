/*
 * ルールの穴（原典・FAQ に書いていないこと）の切り替え — DESIGN.md §5.3「ルールの穴の決定」・§5.4
 *
 * 穴ごとに名前つきの選択肢を1つ持つ。エンジンは該当する処理でここを読む。
 * - decided: 利用者が決めた／裁定から決まった
 * - provisional: 統括の仮の既定（後で覆せる）
 * - undecided: 利用者に確認中。value は仮の既定（null なら manual に倒す）
 * 決定が変わったら value と status を書き換え、holes にこの ID を持つ FAQ ケースを見直す。
 */

import type { HoleId } from './dsl'

export type HoleStatus = 'decided' | 'provisional' | 'undecided'

export interface HoleSetting<V extends string = string> {
  options: readonly V[]
  value: V | null
  status: HoleStatus
  note: string
}

export const HOLES = {
  'H-1': { options: ['perDamage'], value: 'perDamage', status: 'decided', note: 'ダメージ1件（受け手ごと・発生ごと）に処理。FAQ:507 は《鬼の暴走》の状況' },
  'H-2': { options: ['oncePerDamage'], value: 'oncePerDamage', status: 'decided', note: '尊い犠牲の受け渡しはダメージ1件につき1回・AP が選ぶ（FAQ:497）' },
  'H-3': { options: ['activatedOnly'], value: 'activatedOnly', status: 'decided', note: '「使う」は起動する特殊能力（コスト発生を含む）。処理条件がある常時効果は入らない（FAQ:1058・2765・3324）' },
  'H-4': { options: ['target', 'select'], value: 'target', status: 'decided', note: '模写は対象にとる' },
  'H-5': { options: ['noEffect'], value: 'noEffect', status: 'provisional', note: 'コピーした能力の「このアイテム」は無し＝効果なし。範囲内で該当0枚' },
  'H-6': { options: ['swapCurrent', 'swapBase'], value: 'swapBase', status: 'decided', note: '性格反転キノコは元の値（印刷値）で入れ替えて上書き。先に掛かった修正は消え、後から来た修正は上に乗る（統括12 2026-09-26・FAQ:443・1666・2973。R4a で swapCurrent から決め直し）' },
  'H-7a': { options: ['target', 'select'], value: 'target', status: 'decided', note: '決闘の指名は対象にとる' },
  'H-7b': { options: ['likeAllocation', 'likeCost'], value: 'likeCost', status: 'decided', note: '決闘の気力−2 は使用代償型: 気力1以上なら払え、0未満ならただちにダウン（利用者 2026-09-25・FAQ:3263）' },
  'H-7c': { options: ['notAction', 'action'], value: 'notAction', status: 'provisional', note: '決闘の気力−2 の支払いはアクションでない' },
  'H-7d': { options: ['mandateWins'], value: 'mandateWins', status: 'decided', note: '決闘（いかなる場合でも）は「受けられない」に勝つ' },
  'H-7e': { options: ['noExhaust', 'exhaust'], value: 'exhaust', status: 'decided', note: '決闘が通ったら指名されたキャラを消耗させる（利用者 2026-09-25）' },
  'H-8': { options: ['perProcedure'], value: 'perProcedure', status: 'decided', note: '打ち消し: 行き先は手順どおり・代償は戻らない・範囲は「その効果」だけ' },
  'H-9a': { options: ['includeLeader', 'excludeLeader'], value: 'includeLeader', status: 'decided', note: '鬼ごっこ系の「待機状態の味方キャラ全て」に待機のリーダーも入る' },
  'H-9b': { options: ['keep', 'abort'], value: 'keep', status: 'decided', note: '鬼ごっこ系で待機の味方キャラが0体なら元の参加キャラのまま（利用者 2026-09-25）' },
  'H-9c': { options: ['challenger', 'battleCardChooser', 'battleCardPlacer'], value: 'challenger', status: 'provisional', note: '「このバトルを使用したプレイヤー」＝挑んだ側' },
  'H-10': { options: ['itemsFollowController'], value: 'itemsFollowController', status: 'provisional', note: '妖刀で移るとき: 状態は保つ・コストの持ち越しなし（決定）。付いたアイテムは一緒に移り使用権はキャラの使用者に従う（仮）' },
  'H-11': { options: ['noReduce', 'reduce'], value: 'noReduce', status: 'provisional', note: 'W 減で [G][R] は減らない（FAQ:25 の逆向き）' },
  'H-12': { options: ['narrow', 'wide'], value: 'narrow', status: 'decided', note: '割り込み中の保留は派生元のダウン処理が加えたダウン数（と終了判定）だけ。他の途中結果は即座に効く（利用者 2026-09-25・候補A）' },
  'H-13': { options: ['originalOpponent', 'none'], value: 'originalOpponent', status: 'provisional', note: '身代わりで受け渡されたバトルの結果ダメージの受け手にとっての「対戦キャラ」＝元の受け手の対戦キャラ（FAQ:2352）' },
  'NH-8': { options: ['continue', 'abort'], value: 'continue', status: 'decided', note: '複数参加のバトルで参加キャラが1体だけ失われても中断しない。残りの参加キャラで続け、失われたキャラとの組は計算しない。その陣営の参加キャラが全員失われたら中断（利用者 2026-09-27・DESIGN §5.3・20-6 の1体だけの場合を扱う明文は無い）。core/proc.ts の battleLost がこの決定を直接実装（NH-* は holes.ts 未登録のものが多く core に直接ハードコードするのが従来の作り。PHASE-R4b の指示でここに登録もする）' },
} as const satisfies Partial<Record<HoleId, HoleSetting>>

export type KnownHole = keyof typeof HOLES
