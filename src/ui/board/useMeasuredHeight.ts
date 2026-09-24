import { useCallback, useRef, useState } from 'react'

// マスの大きさは「行の実際の高さ」から計算する（DESIGN.md §4.18.1）。
// CSS Gridの fr 単位で行の高さを配分する以上、実ピクセル値はレイアウト後にしか分からない
// ため、ResizeObserverで計測してJS側でpxの正方形/縦長サイズを組み立てる
// （aspect-ratio + %のCSSだけで解決しようとすると循環参照で壊れる。
// IMPLEMENTATION-NOTES.md参照）。
//
// 🚨 コールバックref方式にしている理由（PHASE2.10.md・レイアウトA/B切替対応）:
// 素朴な`useRef`+`useLayoutEffect(..., [])`だと、ResizeObserverは初回マウント時の
// DOM要素だけを見続ける。レイアウトを実行時に切り替えて計測対象の行そのものが
// 別のDOM要素に置き換わる（Aの行1が消えBの行1が生まれる）と、古い要素を見続けたまま
// 新しい要素を見に行かず、行の高さが更新されなくなる。コールバックrefなら
// マウント/アンマウントのたびに呼ばれるので、要素が変わるたびに監視し直せる。

export function useMeasuredHeight<T extends HTMLElement>(): [(el: T | null) => void, number] {
  return useMeasured<T>('clientHeight')
}

/** 幅版。レイアウトBでマスの大きさに横幅の上限をかけるのに使う（下の cellSizeForB） */
export function useMeasuredWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  return useMeasured<T>('clientWidth')
}

function useMeasured<T extends HTMLElement>(prop: 'clientHeight' | 'clientWidth'): [(el: T | null) => void, number] {
  const [value, setValue] = useState(0)
  const observerRef = useRef<ResizeObserver | null>(null)

  const setRef = useCallback((el: T | null) => {
    observerRef.current?.disconnect()
    observerRef.current = null
    if (!el) return
    setValue(el[prop])
    const ro = new ResizeObserver(() => setValue(el[prop]))
    ro.observe(el)
    observerRef.current = ro
  }, [prop])

  return [setRef, value]
}

/**
 * レイアウトBのマスの一辺。行の高さに加えて横幅でも頭を打つ。
 * Bの行は「左=バトル3マス（またはゴミ箱/デッキ/帯）｜中央=キャラ3マス｜右=空」を
 * 1fr/auto/1fr で並べ、中央を盤面の中心線に揃える（DESIGN.md §4.18.2）。左の列は
 * (幅−中央)/2 しか無いので、行の高さだけで決めると 3マスが入り切らず justify-end で
 * 左へ突き抜け、ログ欄に重なっていた（2026-09-24 利用者の指摘・1920×1080 で再現）。
 * 必要な幅＝左3マス＋中央3マス＋右に左と同じ幅＝9マス＋隙間(gap-1=4px)×6。
 */
export function cellSizeForB(rowHeight: number, boardWidth: number): number {
  if (boardWidth <= 0) return rowHeight
  return Math.min(rowHeight, Math.floor((boardWidth - 4 * 6) / 9))
}

/** カードの縦横比 63:88（DESIGN.md §4.18.1） */
export const CARD_RATIO = 63 / 88

export function squareCell(rowHeight: number) {
  return { w: rowHeight, h: rowHeight }
}

export function portraitCell(rowHeight: number) {
  return { w: rowHeight * CARD_RATIO, h: rowHeight }
}
