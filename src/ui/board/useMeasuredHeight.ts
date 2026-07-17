import { useLayoutEffect, useRef, useState } from 'react'

// マスの大きさは「行の実際の高さ」から計算する（DESIGN.md §4.18.1）。
// CSS Gridの fr 単位で行の高さを配分する以上、実ピクセル値はレイアウト後にしか分からない
// ため、ResizeObserverで計測してJS側でpxの正方形/縦長サイズを組み立てる
// （aspect-ratio + %のCSSだけで解決しようとすると循環参照で壊れる。
// IMPLEMENTATION-NOTES.md参照）。

export function useMeasuredHeight<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [height, setHeight] = useState(0)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setHeight(el.clientHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return [ref, height]
}

/** カードの縦横比 63:88（DESIGN.md §4.18.1） */
export const CARD_RATIO = 63 / 88

export function squareCell(rowHeight: number) {
  return { w: rowHeight, h: rowHeight }
}

export function portraitCell(rowHeight: number) {
  return { w: rowHeight * CARD_RATIO, h: rowHeight }
}
