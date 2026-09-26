/*
 * 「止める」の設定（K4・D9） — PHASE-R4a §2 D9・DESIGN.md §5.4「段階」
 *
 * tested のカードの記述から来た K4 の違反（禁止・対象にならない・特殊能力を失っている・装備対象）だけを
 * declare が断る（ok: false・根拠つき）。draft のカードの違反は今までどおり警告（止めない）。
 * 切り替えは ENFORCE 1つ。人の手直しの層・フリーモード（画面側）はこれとは別に残る。
 */
export type EnforceMode = 'warn' | 'tested'

/** 既定 'tested'（利用者の決定 2026-09-26）。テストで 'warn' に戻すことがあるので export const（書き換え可） */
export let ENFORCE: EnforceMode = 'tested'

/** テスト用: 一時的に切り替える（呼び出し側が元の値を控えて戻すこと） */
export function setEnforce(mode: EnforceMode): void {
  ENFORCE = mode
}
