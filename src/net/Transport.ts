// 通信層。P0 ではインターフェースだけ置いた（実装はP2 = PeerJsTransport.ts）。
// PeerJS はこのインターフェースの裏にだけ現れる。Unity 移植時は Relay + Netcode に差し替える。
// プロトコル（seq/version/ack）は net/session.ts の担当。ここは「生の管」のまま薄く保つ（PHASE2.md §8）。

export interface Transport {
  /** ルームコードを返す */
  host(): Promise<string>
  join(code: string): Promise<void>
  send(msg: unknown): void
  onMessage(cb: (msg: unknown) => void): void
  /** 接続が切れたとき（相手のタブが閉じた・回線が落ちた等）に呼ばれる */
  onDisconnect(cb: () => void): void
}
