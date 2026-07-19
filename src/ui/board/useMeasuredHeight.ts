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
  const [height, setHeight] = useState(0)
  const observerRef = useRef<ResizeObserver | null>(null)

  const setRef = useCallback((el: T | null) => {
    observerRef.current?.disconnect()
    observerRef.current = null
    if (!el) return
    setHeight(el.clientHeight)
    const ro = new ResizeObserver(() => setHeight(el.clientHeight))
    ro.observe(el)
    observerRef.current = ro
  }, [])

  return [setRef, height]
}

/** カードの縦横比 63:88（DESIGN.md §4.18.1） */
export const CARD_RATIO = 63 / 88

export function squareCell(rowHeight: number) {
  return { w: rowHeight, h: rowHeight }
}

export function portraitCell(rowHeight: number) {
  return { w: rowHeight * CARD_RATIO, h: rowHeight }
}
