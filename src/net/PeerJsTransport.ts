import Peer, { type DataConnection } from 'peerjs'
import type { Transport } from './Transport'

// Transport を PeerJS（WebRTC DataChannel）で実装する。
// シグナリングはPeerJSの公開クラウド（0.peerjs.com）＝統括決定のA案（PHASE2.md §1）。
// 自前サーバーは持たない。Unity移植時はここだけ Relay+Netcode に差し替える。

// ルームコード＝ホストのPeer ID。読み間違えやすい 0/O/1/I/l を抜いた英数字（PHASE2.md §8）。
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
function randomRoomCode(len = 6): string {
  let s = ''
  for (let i = 0; i < len; i++) s += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)]
  return s
}

function isUnavailableIdError(e: unknown): boolean {
  return !!e && typeof e === 'object' && 'type' in e && (e as { type: string }).type === 'unavailable-id'
}

/** Peer の open/error を Promise にまとめる。PeerJS公開クラウドは稀に混雑するのでタイムアウトを持つ */
function openPeer(id: string | undefined, timeoutMs: number): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const peer = id ? new Peer(id) : new Peer()
    const timer = setTimeout(() => {
      peer.destroy()
      reject(new Error('接続がタイムアウトしました（PeerJSのシグナリングが混雑している可能性があります）'))
    }, timeoutMs)
    peer.once('open', () => {
      clearTimeout(timer)
      resolve(peer)
    })
    peer.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

export class PeerJsTransport implements Transport {
  private peer: Peer | null = null
  private conns = new Set<DataConnection>()
  private messageHandlers: Array<(msg: unknown) => void> = []
  private disconnectHandlers: Array<() => void> = []

  /** ルームコード（=自分のPeer ID）を発行してゲストの接続を待つ */
  async host(): Promise<string> {
    let lastErr: unknown
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = randomRoomCode()
      try {
        this.peer = await openPeer(code, 10000)
        lastErr = undefined
        break
      } catch (e) {
        lastErr = e
        // ID衝突以外（回線断など）は即座に諦める。衝突は別のコードで再試行
        if (!isUnavailableIdError(e)) throw e
      }
    }
    if (!this.peer) throw lastErr instanceof Error ? lastErr : new Error('ルームコードの発行に失敗しました')

    const peer = this.peer
    peer.on('connection', (conn) => this.wireConnection(conn))
    peer.on('error', () => {
      // ホスト稼働中のエラー（相手のブラウザ拡張機能の妨害等）はここに来る。個々のconnのcloseで対処するため無視
    })
    return peer.id
  }

  /** ルームコードでホストに接続する */
  async join(code: string): Promise<void> {
    this.peer = await openPeer(undefined, 10000)
    const conn = this.peer.connect(code, { reliable: true })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('相手に接続できませんでした（ルームコードを確認してください）')),
        10000,
      )
      conn.once('open', () => {
        clearTimeout(timer)
        resolve()
      })
      conn.once('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
    this.wireConnection(conn)
  }

  private wireConnection(conn: DataConnection): void {
    this.conns.add(conn)
    conn.on('data', (data) => {
      for (const h of this.messageHandlers) h(data)
    })
    const onGone = () => {
      this.conns.delete(conn)
      for (const h of this.disconnectHandlers) h()
    }
    conn.on('close', onGone)
    conn.on('error', onGone)
  }

  send(msg: unknown): void {
    for (const conn of this.conns) {
      if (conn.open) conn.send(msg)
    }
  }

  onMessage(cb: (msg: unknown) => void): void {
    this.messageHandlers.push(cb)
  }

  onDisconnect(cb: () => void): void {
    this.disconnectHandlers.push(cb)
  }

  /** 接続中の相手がいるか（UIの接続状態表示用） */
  hasPeer(): boolean {
    return this.conns.size > 0
  }

  destroy(): void {
    this.peer?.destroy()
    this.peer = null
    this.conns.clear()
    this.messageHandlers = []
    this.disconnectHandlers = []
  }
}
