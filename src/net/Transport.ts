// 通信層。P0 ではインターフェースだけ置く（実装は P2）。
// PeerJS はこのインターフェースの裏にだけ現れる。Unity 移植時は Relay + Netcode に差し替える。

export interface Transport {
  /** ルームコードを返す */
  host(): Promise<string>
  join(code: string): Promise<void>
  send(msg: unknown): void
  onMessage(cb: (msg: unknown) => void): void
}
