// 盤面の状態とその操作。純TypeScript（DESIGN.md §3 / PHASE1.md §1）。
// すべての操作は「現在の状態 + 引数」から「次の状態 + ログ」を返す純関数。
// 乱数・時刻はここでは生成しない。呼び出し側（ui/）が生成して引数で渡す
// （P2でホストの操作をそのまま再生できるようにするため。PHASE1.md §6地雷）。

import type { Attr } from './types'
import type { CostToken, GameResult, Phase, ProcFrame, ProcMeta } from './proc'

// 絶対座席（PHASE2.5.md §2.1）。'自分/相手' のような視点依存の語は core/ に一切持ち込まない。
// 「どちらが自分か」はクライアント側だけが知る情報（ui/board/useBoard.ts の localSeat）。
export type Seat = 'A' | 'B'

/** 'aside'＝横に置いたカード（強襲モード・R4c G5e）。持ち主ごと・裏向き（手札ではない＝使えない）。相手には枚数だけ */
export type ZoneId = 'deck' | 'hand' | 'trash' | 'leader' | 'char' | 'battle' | 'field' | 'pending' | 'aside'

export type Orientation = 'ready' | 'rested'

/**
 * engine＝ルールエンジンが手順（proc）を進める／free＝手動（エンジンを動かさない・盤面を手で直す）。
 * DESIGN §5.3 R2u の決定③。旧 'assist'（半自動）は R2u-2 で消した（git タグ assist-final に残る）。保存盤面の assist は free として読む
 */
export type Mode = 'engine' | 'free'

export interface CardInstance {
  iid: string
  cardId: string
  owner: Seat
  zone: ZoneId
  index: number
  orientation: Orientation
  faceUp: boolean
  /** 気力（キャラ/リーダー/タッグのみ使う）。バトル/アイテム等は null のまま */
  kiryoku: number | null
  /** アイテム等がキャラに付いている場合、対象キャラの iid（DESIGN.md §4.14） */
  attachedTo: string | null
  /** バトルカードの未使用/使用済み（19-3）。待機/消耗(orientation)とは別の概念。
   *  🚨 プレイヤーが自由に変えられない。ルールと効果でのみ変わる（oldrule.txt:1016-1017） */
  used?: boolean
  /** 二重人格（R4c G6b-3）: 別のキャラのコピーとして扱われているとき、元の cardId。cardId はコピー元のカードの id に差し替わる（core は意味を知らない） */
  baseCardId?: string
  /** 二重人格で上に乗せたカード（aside にある）が、どのキャラ（iid）の上に乗っているか */
  personaOf?: string
}

/** 修正の切れ方の目印。自動消滅はしない（DESIGN.md §4.16）。人間が見て判断・削除する */
export type ModScope = 'このバトル' | 'ターン終了時' | '発生元依存' | 'その他'

/**
 * 修正の種類（DESIGN.md §4.16・原典の用語 oldrule.txt:1212-1215。P3d-3）。
 * 【能力値修正】キャラの能力値を変化させる効果／【攻防修正】バトル参加キャラの攻撃・防御能力値を変化させる効果。
 * 切れ方が違う（[28]で失われるのは攻防修正だけ）ので必ず区別する。
 */
export type ModifierKind = '能力値修正' | '攻防修正'

export interface Modifier {
  id: string
  targetIid: string
  sourceLabel: string
  /** 能力値修正のときだけ使う（力/早/賢/根/感） */
  stat?: Attr
  /** 攻防修正のときだけ使う（stat は使わない）。P3d-3 */
  battleStat?: 'atk' | 'def'
  delta?: number
  note?: string
  kind: ModifierKind
  scope: ModScope
  /**
   * 手直しの層（DESIGN §5.4「人の手直しの層」・R3）の連番。エンジンの導出（継続効果の層 K3）の後に、この順で重ねる。
   * 旧データ（R3 より前の保存盤面）には無い → fillBoardDefaults が並びの順で補う
   */
  seq?: number
}

/**
 * 継続効果の層（DESIGN §5.4 K3・R3）。続く効果1つ＝層1枚。core は入れ物と連番と期限だけを持ち、中身（body）は読まない
 * （中身＝DSL の Continuous と評価の環境。エンジンが書き、エンジンが読む）。
 * 期限（until）: turn＝ターン終了時まで（12-1・10-8）／battle＝バトル終了時まで（20-4[28]）／
 * whileSource＝発生源がフィールドにある間（12-2 常時効果。エンジンが発生源を見て足し外しする）
 */
export type LayerUntil = 'turn' | 'battle' | 'whileSource'

export interface Layer {
  id: string
  /** 発揮し始めた順（12-2「既に発揮した全ての効果の後に発揮したとみなされ」oldrule.txt:505-506）。procMeta.seq から取る */
  seq: number
  /** 発生源（カード）。無ければ null */
  source: string | null
  /** 常時効果なら発生源の能力の番号（エンジンが発生源を見て足し外しする）。null＝効果で足した層（12-1） */
  ability: number | null
  by: Seat
  label: string
  /** 修正の種類（原典の用語 oldrule.txt:1212-1215）。[28] は攻防修正を、10-8 は能力値修正を失わせる。修正でない層は null */
  kind: ModifierKind | null
  until: LayerUntil
  /** until battle・攻防修正のとき、そのバトル（最も近いバトルのフレーム） */
  battleId: string | null
  /** 効果を得たカード（12-1「これらの効果を得ていた対象が失われた場合…失われます」）。空＝決まった対象が無い（常時効果は毎回導き出す） */
  targets: string[]
  /** アイテムの常時効果: 層を足したときの装備先（装備先が変わったら層は終わる） */
  host: string | null
  /** 中身（エンジンの持ち物。DSL の Continuous・評価の環境）。core は読まない */
  body: Record<string, unknown>
}

/** 層の入れ物。bound・unusable はエンジンが導き出して置く控え（core の手順が読む。中身の意味は持たない） */
export interface LayerState {
  list: Layer[]
  /** アイテム → 装備対象として指定されたキャラ（17-1。装備対象がその1枚に決まるアイテム《電波での復活》） */
  bound: Record<string, string>
  /** 使用できないバトルカード（効果による。20-3・20-4[5][16] の「選択可能な」から除く） */
  unusable: string[]
  /** 使用済みにならないバトルカード（battle.reusable。[18] で used にしない） */
  reusable: string[]
  /** 一度挑んだキャラはこのターン中挑めないバトルカード（battle.oncePerCharPerTurn。procMeta.marks に印を控える） */
  oncePerChar: string[]
  /** バトルを挑めないキャラ（barFromBattle role challenge。20-4[7] の候補から外す。エンジンが導き出して置く控え。中身の意味は持たない） */
  barChallenge: string[]
  /** バトルに参加できないキャラ（barFromBattle role any。20-4[7][11] の候補から外す） */
  barAny: string[]
  /** 消耗状態でもバトルを受けるキャラに選べるキャラ（receiveWhenRested。20-4[11] の候補に足す。《坂神蝉丸》守る者 R4c G2b-1a。エンジンが導き出して置く控え。中身の意味は持たない） */
  receiveRested: string[]
  /** 10-4[2] の規定の待機戻しの候補から外すキャラ（noEntryReady。《病気》R4c G11a-2。エンジンが導き出して置く控え。中身の意味は持たない） */
  noEntryReady: string[]
  /** 挑むキャラに選ぶ時に挑んだプレイヤーが発生済みのコストで払う [W] の数（iid ごと。challengeCost。マネージャー・やる気ナシ・ロゥ R4c G4d）。20-4[7] の候補は払える額のキャラだけ。エンジンが導き出して置く控え。中身の意味は持たない */
  challengeCost: Record<string, number>
  /** 挑んだキャラ → そのキャラに優先して受けさせる相手側のキャラ（receiverPriority。《衣装・バニースーツ》R4c G6a-3・FAQ:187）。20-4[11] の候補に、受けることのできるこの中のキャラがいればその中だけにする。エンジンが導き出して置く控え。中身の意味は持たない */
  receivePrefer: Record<string, string[]>
  /** 手札調整 [3] の上限枚数（席ごと。null＝無限。無ければ 7＝4-2-1。エンジンが層から導き出して置く控え。core は中身を知らない。R4c G7・NH-38） */
  handLimit?: { A: number | null; B: number | null }
  /** 効かなくなっている層の id（エンジンが導き出して置く。再び効き始めたら seq を取り直す＝NH-37⑯・FAQ:2199。core は中身を知らない） */
  held?: string[]
}

export const EMPTY_LAYERS: LayerState = { list: [], bound: {}, unusable: [], reusable: [], oncePerChar: [], barChallenge: [], barAny: [], receiveRested: [], noEntryReady: [], challengeCost: {}, receivePrefer: {} }

/**
 * デッキで始めたときの開始準備の進み具合（DESIGN.md §4.21「対戦卓での使用」・PHASE5b.md §1-1）。
 * null＝デッキで始めていない（今までどおりの手置き）。`clearBoard` で両方 null に戻る。
 */
export interface SetupState {
  deckName: string
  mulliganUsed: boolean
  leaderRevealed: boolean
}

export interface BoardState {
  cards: Record<string, CardInstance>
  /** 人の手直しの層（右クリックの能力値修正・攻防修正）。エンジンの間も手動の間も、層の最後に重なる（R3） */
  modifiers: Record<string, Modifier>
  /** 継続効果の層（K3・R3） */
  layers: LayerState
  /** engine＝エンジンが進める／free＝手動（R2u §2-3）。共有・同期される */
  mode: Mode
  /** 開始準備の状態（座席ごと）。PHASE5b.md §1-1 */
  setup: Record<Seat, SetupState | null>
  // ── R2a（DESIGN §5.4 K1・PHASE-R2a §2）: 原典の処理手順（窓・バトルもここ。R2u-2 で旧 priority/battle を置き換えた）
  /** 手順のスタック（空＝何も処理していない）。末尾＝今の手順 */
  proc: ProcFrame[]
  /** 手順の付帯状態（メインフェイズの窓・選択・連番・使用回数など） */
  procMeta: ProcMeta
  /** 手番（アクティブプレイヤー）とフェイズ。null＝未設定（AP は A として扱う） */
  /** n: ターンの番号（1＝先攻の1ターン目・10-2-4 の制限に使う。R2u）。無い盤面（R2a/R2b のテスト・旧データ）は制限なし */
  turn: { active: Seat; phase: Phase; n?: number } | null
  /** 確定したキャラのダウン数（9-2）。ダウン処理[3]で加えた分は[6]の後に確定する（H-12） */
  downs: Record<Seat, number>
  /** 発生済みのコスト（7-3） */
  costs: Record<Seat, CostToken[]>
  /** ゲームの結果（9）。null＝続いている */
  result: GameResult | null
}

/** 手順の付帯状態の既定値（proc.ts と循環 import しないよう型だけ受け取り、値はここに置く） */
export const EMPTY_PROC_META: ProcMeta = {
  seq: 0,
  base: null,
  mainClosed: false,
  choice: null,
  answers: {},
  used: {},
  marks: {},
  leaderLost: [],
  aborted: [],
  battles: [],
  phaseRun: null,
  asideStack: [],
  presented: {},
  mustMarks: {},
}

export const EMPTY_BOARD: BoardState = {
  cards: {},
  modifiers: {},
  layers: EMPTY_LAYERS,
  mode: 'free',
  setup: { A: null, B: null },
  proc: [],
  procMeta: EMPTY_PROC_META,
  turn: null,
  downs: { A: 0, B: 0 },
  costs: { A: [], B: [] },
  result: null,
}

/**
 * 保存された盤面に、新しいフィールドの既定値を補う（旧保存盤面用。IMPLEMENTATION-NOTES.md
 * 「永続状態にフィールドを足したら、古い保存盤面を既定値で補完する」の実体を切り出したもの。
 * `useBoard.ts` の読込処理と test-setup.ts の両方がこれを使う）。
 */
export function fillBoardDefaults(saved: Partial<BoardState>): BoardState {
  // R2a で足した手順の状態も、古い保存盤面では既定値で補う（procMeta は欄ごとに補う）
  // R2u: 半自動（assist）の保存盤面はフリーとして読む（PHASE-R2u §1）。R2u-2 で消した旧 priority・battle の欄は捨てる
  const { priority: _p, battle: _b, ...rest } = saved as Partial<BoardState> & { priority?: unknown; battle?: unknown }
  void _p
  void _b
  const mode: Mode | undefined = (rest.mode as string | undefined) === 'assist' ? 'free' : rest.mode
  // R3: R2b の修正の記録（procMeta.mods）は継続効果の層に移す。手直しの層（modifiers）に連番が無ければ並びの順で補う
  const { mods: oldMods, ...procMeta } = (rest.procMeta ?? {}) as Partial<ProcMeta> & { mods?: OldProcMod[] }
  const layers: LayerState = { ...EMPTY_LAYERS, ...(rest.layers ?? {}) }
  if (oldMods?.length && !rest.layers) layers.list = oldMods.map((m, i) => oldModToLayer(m, i))
  let modifiers = rest.modifiers
  if (modifiers && Object.values(modifiers).some((m) => m.seq === undefined)) {
    modifiers = Object.fromEntries(Object.entries(modifiers).map(([id, m], i) => [id, m.seq === undefined ? { ...m, seq: i + 1 } : m]))
  }
  return { ...EMPTY_BOARD, ...rest, ...(mode ? { mode } : {}), ...(modifiers ? { modifiers } : {}), layers, procMeta: { ...EMPTY_PROC_META, ...procMeta } }
}

/** R2b の修正の記録（procMeta.mods）の形。旧データを読むときだけ使う */
interface OldProcMod {
  id: string
  iid: string
  stat: string
  delta: number
  kind: ModifierKind
  until: 'turn' | 'battle'
  battleId: string | null
}

/** 旧データの修正の記録を層1枚にする（中身はエンジンが効果で足す修正と同じ形: engine/layers.ts の modBody） */
function oldModToLayer(m: OldProcMod, i: number): Layer {
  return {
    id: `old${m.id}`,
    seq: i + 1,
    source: null,
    ability: null,
    by: 'A',
    label: '修正（旧データ）',
    kind: m.kind,
    until: m.until,
    battleId: m.battleId,
    targets: [m.iid],
    host: null,
    body: { mod: { stat: m.stat, delta: m.delta } },
  }
}

/** 手直しの層の次の連番（R3） */
export function nextModifierSeq(state: BoardState): number {
  return Object.values(state.modifiers).reduce((a, m) => Math.max(a, m.seq ?? 0), 0) + 1
}

/**
 * フィールド系ゾーンの固定スロット数（座席ごと）。DESIGN.md §4.13。ルール強制ではなくUIの置き場。
 * 🚨 `field` はここに含めない。両陣営で共有1枚であり「座席ごと」の容量という考え方自体が誤り
 * （PHASE2.6.md §3。P1〜P2.5では座席ごとに1スロットあり、フィールドカード2枚同時という
 * ルール上ありえない盤面を作れてしまっていた＝統括が承認していた簡略化の誤り）。
 */
export const SLOT_CAPACITY: Partial<Record<ZoneId, number>> = {
  leader: 1,
  char: 5,
  battle: 3,
}

/** フィールドは盤面全体で1枚（座席を問わない共有スロット）。DESIGN.md §4.13訂正 */
export const FIELD_CAPACITY = 1

export function isSlotted(zone: ZoneId): boolean {
  return zone in SLOT_CAPACITY || zone === 'field'
}

export function cardsInZone(state: BoardState, owner: Seat, zone: ZoneId): CardInstance[] {
  return Object.values(state.cards)
    .filter((c) => c.owner === owner && c.zone === zone)
    .sort((a, b) => a.index - b.index)
}

/** フィールドの現在の1枚（無ければundefined）。座席を問わない共有スロットなのでownerでは絞らない */
export function fieldCard(state: BoardState): CardInstance | undefined {
  return Object.values(state.cards).find((c) => c.zone === 'field')
}

export function modifiersFor(state: BoardState, iid: string): Modifier[] {
  return Object.values(state.modifiers).filter((m) => m.targetIid === iid)
}

/**
 * ログに名前を出してよいか（PHASE5c.md §1）。手札は持ち主には見えるが相手には見えない＝
 * ログは両者が読むので非公開扱い。デッキも常に非公開（自分でも一番上は知らない）。
 * zone/faceUp だけを見るので、移動前後の仮の状態（`{ zone, faceUp }`）を渡しても使える。
 */
export function isPublicCard(c: Pick<CardInstance, 'zone' | 'faceUp'>): boolean {
  return c.zone !== 'deck' && c.zone !== 'hand' && c.zone !== 'aside' && c.faceUp
}

/**
 * 表示能力値 = 素の値 + 有効な Modifier の合計（DESIGN.md §4.16）。
 * 🚨 kind==='能力値修正' だけを数える。攻防修正はここに入らない（攻防能力値の算出側で別に足す。§5.2・P3d-3）。
 */
export function effectiveStat(state: BoardState, iid: string, base: number, stat: Attr): number {
  const delta = modifiersFor(state, iid)
    .filter((m) => m.kind === '能力値修正' && m.stat === stat)
    .reduce((sum, m) => sum + (m.delta ?? 0), 0)
  return base + delta
}

/**
 * 気力の上限（リーダーゾーンなら×2）。PHASE3d-2b §3: CardContextMenu.tsx と
 * BattlePanel.tsx（ダメージ確認表のmax）が同じ計算を2か所に複製しないよう、ここに切り出した。
 * 挙動はCardContextMenu.tsx旧実装（`baseMax * 2`）から変更していない。
 */
export function maxKiryokuFor(zone: ZoneId, baseMax: number | null): number | null {
  return zone === 'leader' && baseMax !== null ? baseMax * 2 : baseMax
}

function cloneBoard(state: BoardState): BoardState {
  return {
    ...state,
    cards: { ...state.cards },
    modifiers: { ...state.modifiers },
    setup: { ...state.setup },
  }
}

/** ゾーン内の index を 0..n-1 の連番に詰め直す（DESIGN.md §2.2「正規化して1箇所で管理」） */
function normalizeZone(state: BoardState, owner: Seat, zone: ZoneId): BoardState {
  const next = cloneBoard(state)
  const list = cardsInZone(next, owner, zone)
  list.forEach((c, i) => {
    if (c.index !== i) next.cards[c.iid] = { ...c, index: i }
  })
  return next
}

// ---------------------------------------------------------------------------
// 個々の操作（純関数）。それぞれ { state, log } を返す。
// ---------------------------------------------------------------------------

export interface Result {
  state: BoardState
  log: string
}

export function spawnCard(
  state: BoardState,
  args: { iid: string; cardId: string; cardName: string; owner: Seat; zone: ZoneId },
): Result {
  const { iid, cardId, cardName, owner, zone } = args
  // フィールドは共有1枚なので、座席を問わず既存の有無だけで index を決める
  const index = zone === 'field' ? (fieldCard(state) ? 1 : 0) : cardsInZone(state, owner, zone).length
  const instance: CardInstance = {
    iid,
    cardId,
    owner,
    zone,
    index,
    // 実物同様、場に出た瞬間は消耗状態（召喚酔い。DESIGN.md §4.5）。手札等は待機扱いでよい
    orientation: zone === 'char' || zone === 'battle' || zone === 'leader' ? 'rested' : 'ready',
    faceUp: zone !== 'deck',
    kiryoku: null,
    attachedTo: null,
  }
  const next = cloneBoard(state)
  next.cards[iid] = instance
  return { state: next, log: `${cardName} を ${ZONE_LABEL[zone]} に置いた` }
}

/**
 * デッキへ入るときは裏、デッキから出るときは表にする（PHASE2.8.md §3「デッキから引いたカードが
 * 裏のままなのは使い勝手が悪い」）。それ以外の移動では今の表裏を維持する（手動の裏返しは別途可能）。
 */
function resolveFaceUp(fromZone: ZoneId, toZone: ZoneId, current: boolean): boolean {
  if (toZone === 'deck' || toZone === 'aside') return false
  if (fromZone === 'aside') return true
  if (fromZone === 'deck') return true
  return current
}

/** 占有スロットに移動するときは、既存の占有カードと入れ替える（実物マットの入れ替えと同じ挙動） */
export function moveCard(
  state: BoardState,
  args: { iid: string; toOwner?: Seat; toZone: ZoneId; toIndex?: number; cardName: string },
): Result {
  const card = state.cards[args.iid]
  if (!card) return { state, log: '' }
  const toOwner = args.toOwner ?? card.owner
  const fromZone = card.zone
  const fromOwner = card.owner
  const fromIndex = card.index
  const faceUp = resolveFaceUp(fromZone, args.toZone, card.faceUp)
  // 移動前・後のどちらも非公開なら、ログに名前を出さない（PHASE5c.md §2）
  const publicMove = isPublicCard(card) || isPublicCard({ zone: args.toZone, faceUp })

  let next = cloneBoard(state)

  if (args.toZone === 'field') {
    // 共有1枚（座席を問わない）。既にフィールドカードが出ていた場合、出ていたカードは
    // 「ゴミ箱送りになります」（oldrule.txt:935 ／ 18-2[11] は oldrule.txt:958）。
    // 🚨 P1以来ここは「追い出した側を移動元へ入れ替える」実装だったが、原典に反する誤りだった。
    //    PHASE3a-4 の統括検証で、移動元が pending のとき旧フィールドカードが提示エリアへ
    //    迷い込むことから発覚し、逐語引用に合わせて訂正した（2026-08-06）。
    const occupant = fieldCard(next)
    const actualOccupant = occupant && occupant.iid !== card.iid ? occupant : undefined
    next.cards[card.iid] = { ...card, owner: toOwner, zone: 'field', index: 0, faceUp }
    if (actualOccupant) {
      next.cards[actualOccupant.iid] = {
        ...actualOccupant,
        zone: 'trash',
        index: cardsInZone(next, actualOccupant.owner, 'trash').length,
        faceUp: resolveFaceUp('field', 'trash', actualOccupant.faceUp),
      }
      next = normalizeZone(next, actualOccupant.owner, 'trash')
    }
    if (fromOwner !== toOwner || fromZone !== args.toZone) {
      next = normalizeZone(next, fromOwner, fromZone)
    }
  } else if (isSlotted(args.toZone) && args.toIndex !== undefined) {
    const occupant = Object.values(next.cards).find(
      (c) => c.owner === toOwner && c.zone === args.toZone && c.index === args.toIndex && c.iid !== card.iid,
    )
    next.cards[card.iid] = { ...card, owner: toOwner, zone: args.toZone, index: args.toIndex, faceUp }
    if (occupant) {
      next.cards[occupant.iid] = {
        ...occupant,
        owner: fromOwner,
        zone: fromZone,
        index: fromIndex,
        faceUp: resolveFaceUp(args.toZone, fromZone, occupant.faceUp),
      }
    }
  } else {
    const toIndex = args.toIndex ?? cardsInZone(next, toOwner, args.toZone).length
    next.cards[card.iid] = { ...card, owner: toOwner, zone: args.toZone, index: toIndex, faceUp }
    next = normalizeZone(next, toOwner, args.toZone)
    if (fromOwner !== toOwner || fromZone !== args.toZone) {
      next = normalizeZone(next, fromOwner, fromZone)
    }
  }

  const log = publicMove
    ? `${args.cardName} を ${ZONE_LABEL[fromZone]} から ${ZONE_LABEL[args.toZone]} へ移動した`
    : `カードを1枚 ${ZONE_LABEL[fromZone]} から ${ZONE_LABEL[args.toZone]} へ移動した`
  return { state: next, log }
}

export function setOrientation(
  state: BoardState,
  args: { iid: string; orientation: Orientation; cardName: string },
): Result {
  const card = state.cards[args.iid]
  if (!card) return { state, log: '' }
  const next = cloneBoard(state)
  next.cards[card.iid] = { ...card, orientation: args.orientation }
  const subject = isPublicCard(card) ? args.cardName : 'カード'
  return {
    state: next,
    log: `${subject} を ${args.orientation === 'rested' ? '消耗' : '待機'} にした`,
  }
}

export function toggleOrientation(state: BoardState, args: { iid: string; cardName: string }): Result {
  const card = state.cards[args.iid]
  if (!card) return { state, log: '' }
  return setOrientation(state, {
    iid: args.iid,
    orientation: card.orientation === 'ready' ? 'rested' : 'ready',
    cardName: args.cardName,
  })
}

export function setKiryoku(state: BoardState, args: { iid: string; value: number; cardName: string }): Result {
  const card = state.cards[args.iid]
  if (!card) return { state, log: '' }
  const next = cloneBoard(state)
  next.cards[card.iid] = { ...card, kiryoku: args.value }
  const subject = isPublicCard(card) ? args.cardName : 'カード'
  return { state: next, log: `${subject} の気力を ${args.value} にした` }
}

export function adjustKiryoku(
  state: BoardState,
  args: { iid: string; delta: number; max: number; cardName: string },
): Result {
  const card = state.cards[args.iid]
  if (!card) return { state, log: '' }
  const before = card.kiryoku ?? args.max
  // 気力は上限を超えない（DESIGN.md §4.6）。下限は決め打ちしない（マイナス表示も実戦であり得る）
  const after = Math.min(before + args.delta, args.max)
  const next = cloneBoard(state)
  next.cards[card.iid] = { ...card, kiryoku: after }
  const subject = isPublicCard(card) ? args.cardName : 'カード'
  return { state: next, log: `${subject} の気力 ${before}→${after}` }
}

export function setFaceUp(state: BoardState, args: { iid: string; faceUp: boolean; cardName: string }): Result {
  const card = state.cards[args.iid]
  if (!card) return { state, log: '' }
  const next = cloneBoard(state)
  next.cards[card.iid] = { ...card, faceUp: args.faceUp }
  // 表→裏は「前が公開」で名前を出してよい。裏→表も「後が公開」になるので出してよい
  // （PHASE5c.md §2 🚨）。両方とも非公開のまま（例: 非公開ゾーンで裏のまま操作）のときだけ隠す
  const publicChange = isPublicCard(card) || isPublicCard({ zone: card.zone, faceUp: args.faceUp })
  const subject = publicChange ? args.cardName : 'カード'
  return { state: next, log: `${subject} を ${args.faceUp ? '表' : '裏'} にした` }
}

/** バトルカードの未使用/使用済み（19-3）。プレイヤーが直接叩く想定のsetterではない（ルールと効果でのみ変わる） */
export function setUsed(state: BoardState, args: { iid: string; used: boolean; cardName: string }): Result {
  const card = state.cards[args.iid]
  if (!card) return { state, log: '' }
  const next = cloneBoard(state)
  next.cards[card.iid] = { ...card, used: args.used }
  const subject = isPublicCard(card) ? args.cardName : 'カード'
  return { state: next, log: `${subject} を ${args.used ? '使用済み' : '未使用'} にした` }
}

export function flip(state: BoardState, args: { iid: string; cardName: string }): Result {
  const card = state.cards[args.iid]
  if (!card) return { state, log: '' }
  return setFaceUp(state, { iid: args.iid, faceUp: !card.faceUp, cardName: args.cardName })
}

export function addModifier(state: BoardState, args: { modifier: Modifier; cardName: string }): Result {
  const next = cloneBoard(state)
  // 手直しの層（R3）: 連番を付けて最後に重ねる
  next.modifiers[args.modifier.id] = args.modifier.seq === undefined ? { ...args.modifier, seq: nextModifierSeq(state) } : args.modifier
  const statPart = args.modifier.stat
    ? `${args.modifier.stat}${(args.modifier.delta ?? 0) >= 0 ? '+' : ''}${args.modifier.delta ?? 0}`
    : (args.modifier.note ?? '')
  const target = state.cards[args.modifier.targetIid]
  const subject = !target || isPublicCard(target) ? args.cardName : 'カード'
  return { state: next, log: `${subject} に修正「${args.modifier.sourceLabel} ${statPart}」を追加した` }
}

export function removeModifier(state: BoardState, args: { modId: string; cardName: string }): Result {
  const mod = state.modifiers[args.modId]
  if (!mod) return { state, log: '' }
  const next = cloneBoard(state)
  delete next.modifiers[args.modId]
  const target = state.cards[mod.targetIid]
  const subject = !target || isPublicCard(target) ? args.cardName : 'カード'
  return { state: next, log: `${subject} の修正「${mod.sourceLabel}」を消した` }
}

export function clearModifiers(state: BoardState, args: { iid: string; scope?: ModScope; cardName: string }): Result {
  const next = cloneBoard(state)
  let count = 0
  for (const [id, mod] of Object.entries(state.modifiers)) {
    if (mod.targetIid !== args.iid) continue
    if (args.scope && mod.scope !== args.scope) continue
    delete next.modifiers[id]
    count++
  }
  const target = state.cards[args.iid]
  const subject = !target || isPublicCard(target) ? args.cardName : 'カード'
  return { state: next, log: `${subject} の修正を ${count} 件クリアした` }
}

export function attach(state: BoardState, args: { itemIid: string; targetIid: string; itemName: string; targetName: string }): Result {
  const item = state.cards[args.itemIid]
  if (!item) return { state, log: '' }
  const next = cloneBoard(state)
  next.cards[item.iid] = { ...item, attachedTo: args.targetIid }
  const target = state.cards[args.targetIid]
  const itemSubject = isPublicCard(item) ? args.itemName : 'カード'
  const targetSubject = !target || isPublicCard(target) ? args.targetName : 'カード'
  return { state: next, log: `${itemSubject} を ${targetSubject} に付けた` }
}

export function detach(state: BoardState, args: { itemIid: string; itemName: string }): Result {
  const item = state.cards[args.itemIid]
  if (!item) return { state, log: '' }
  const next = cloneBoard(state)
  next.cards[item.iid] = { ...item, attachedTo: null }
  const subject = isPublicCard(item) ? args.itemName : 'カード'
  return { state: next, log: `${subject} を取り外した` }
}

export function toTrash(state: BoardState, args: { iid: string; cardName: string }): Result {
  const card = state.cards[args.iid]
  if (!card) return { state, log: '' }
  return moveCard(state, { iid: args.iid, toZone: 'trash', cardName: args.cardName })
}

export function removeCard(state: BoardState, args: { iid: string; cardName: string }): Result {
  const card = state.cards[args.iid]
  if (!card) return { state, log: '' }
  const next = cloneBoard(state)
  delete next.cards[card.iid]
  for (const [id, mod] of Object.entries(next.modifiers)) {
    if (mod.targetIid === card.iid) delete next.modifiers[id]
  }
  const subject = isPublicCard(card) ? args.cardName : 'カード'
  return { state: next, log: `${subject} を盤外に出した` }
}

/** シャッフル。乱数は呼び出し側が消費し、結果の並び（iid配列）だけを渡す（core純粋性のため） */
export function shuffleDeck(state: BoardState, args: { owner: Seat; orderedIids: string[] }): Result {
  let next = cloneBoard(state)
  args.orderedIids.forEach((iid, i) => {
    const card = next.cards[iid]
    if (card) next.cards[iid] = { ...card, index: i }
  })
  next = normalizeZone(next, args.owner, 'deck')
  // ログは座席名(A/B)で書く。「自分/相手」は視点依存でcoreに置けない（PHASE2.5.md §2.1）
  return { state: next, log: `${args.owner} のデッキをシャッフルした` }
}

export function clearBoard(): Result {
  return { state: EMPTY_BOARD, log: '盤面をクリアした' }
}

// ---------------------------------------------------------------------------
// デッキで始める（開始準備 10-1・マリガン 10-1-1）。DESIGN.md §4.21・PHASE5b.md §1。
// 🚨 乱数・カード種別の知識は持ち込まない。シャッフルの並び（iid配列）とマリガンできるかの判定は
// ui が決めて渡す。ここは「渡された並びが正しい集合か」だけ確かめる（shuffleDeckと同じ流儀）。
// ---------------------------------------------------------------------------

/**
 * デッキで開始準備（10-1 [1]〜[4]）。owner の盤面を全部片付けてから、リーダー・デッキ・手札を置く。
 * 手順（proc）が動いている最中は差し替えない（参照が壊れるため）。
 */
export function startWithDeck(
  state: BoardState,
  args: {
    owner: Seat
    deckName: string
    leader: { iid: string; cardId: string; kiryoku: number | null }
    deck: { iid: string; cardId: string }[]
    draw: number
  },
): Result {
  if (state.proc.length > 0) return { state, log: '' }
  const { owner, deckName, leader, deck, draw } = args

  // 2. owner のカードを全ゾーンから消す（共有フィールドの owner 一致分も）。
  //    消したカードを対象にした modifiers も消す。相手のカードの attachedTo が
  //    消したカードを指していたら null にする（ぶら下がり参照を残さない）。
  const removedIids = new Set<string>()
  for (const c of Object.values(state.cards)) {
    if (c.owner === owner) removedIids.add(c.iid)
  }
  const cards: Record<string, CardInstance> = {}
  for (const [iid, c] of Object.entries(state.cards)) {
    if (removedIids.has(iid)) continue
    cards[iid] = c.attachedTo && removedIids.has(c.attachedTo) ? { ...c, attachedTo: null } : c
  }
  const modifiers: Record<string, Modifier> = {}
  for (const [id, m] of Object.entries(state.modifiers)) {
    if (removedIids.has(m.targetIid)) continue
    modifiers[id] = m
  }

  // 3. リーダーを裏向き・待機（ready）で置く（利用者確定 2026-09-24・DESIGN.md §4.21）。
  //    spawnCard の既定（leader ゾーンは消耗）ではないので明示して上書きする。
  cards[leader.iid] = {
    iid: leader.iid,
    cardId: leader.cardId,
    owner,
    zone: 'leader',
    index: 0,
    orientation: 'ready',
    faceUp: false,
    kiryoku: leader.kiryoku,
    attachedTo: null,
  }

  // 4[5]. deck の並びどおりデッキへ置き、上から draw 枚を手札へ（index 0 が一番上）
  const drawn = deck.slice(0, draw)
  const remaining = deck.slice(draw)
  drawn.forEach((d, i) => {
    cards[d.iid] = {
      iid: d.iid,
      cardId: d.cardId,
      owner,
      zone: 'hand',
      index: i,
      orientation: 'ready',
      faceUp: true,
      kiryoku: null,
      attachedTo: null,
    }
  })
  remaining.forEach((d, i) => {
    cards[d.iid] = {
      iid: d.iid,
      cardId: d.cardId,
      owner,
      zone: 'deck',
      index: i,
      orientation: 'ready',
      faceUp: false,
      kiryoku: null,
      attachedTo: null,
    }
  })

  const next: BoardState = {
    ...state,
    cards,
    modifiers,
    mode: state.mode,
    setup: { ...state.setup, [owner]: { deckName, mulliganUsed: false, leaderRevealed: false } },
  }

  // 🚨 リーダーの名前をログに出さない（10-1[1]「相手プレイヤーに見せないよう」）
  return {
    state: next,
    log: `「${deckName}」で開始準備（リーダーを裏向きで置き・${deck.length}枚シャッフル・${draw}枚ドロー）`,
  }
}

/** マリガン（10-1-1）。「1回だけ」「開始準備の中だけ」はここで守る。 */
export function mulligan(
  state: BoardState,
  args: { owner: Seat; orderedIids: string[]; revealedNames: string[]; draw: number },
): Result {
  const setup = state.setup[args.owner]
  if (!setup || setup.mulliganUsed || setup.leaderRevealed) return { state, log: '' }

  // orderedIids が「owner の hand ∪ deck」とちょうど同じ集合でなければ何もしない
  const combined = new Set<string>()
  for (const c of Object.values(state.cards)) {
    if (c.owner === args.owner && (c.zone === 'hand' || c.zone === 'deck')) combined.add(c.iid)
  }
  const ordered = new Set(args.orderedIids)
  if (combined.size !== args.orderedIids.length || ordered.size !== combined.size) return { state, log: '' }
  for (const iid of combined) {
    if (!ordered.has(iid)) return { state, log: '' }
  }

  // 手札を全部デッキへ → orderedIids の並びにする → 上から draw 枚を手札へ
  const cards: Record<string, CardInstance> = { ...state.cards }
  args.orderedIids.forEach((iid, i) => {
    const card = cards[iid]
    if (!card) return
    if (i < args.draw) {
      cards[iid] = { ...card, zone: 'hand', index: i, faceUp: true }
    } else {
      cards[iid] = { ...card, zone: 'deck', index: i - args.draw, faceUp: false }
    }
  })

  const next: BoardState = {
    ...state,
    cards,
    setup: { ...state.setup, [args.owner]: { ...setup, mulliganUsed: true } },
  }

  return { state: next, log: `マリガン: 手札を公開 [${args.revealedNames.join('・')}]` }
}

/** リーダーを表にする（10-1[7]）。 */
export function revealLeader(state: BoardState, args: { owner: Seat; cardName: string }): Result {
  const setup = state.setup[args.owner]
  if (!setup || setup.leaderRevealed) return { state, log: '' }
  const leader = cardsInZone(state, args.owner, 'leader')[0]
  if (!leader) return { state, log: '' }

  const next: BoardState = {
    ...state,
    cards: { ...state.cards, [leader.iid]: { ...leader, faceUp: true } },
    setup: { ...state.setup, [args.owner]: { ...setup, leaderRevealed: true } },
  }

  return { state: next, log: `リーダーを表にした: ${args.cardName}` }
}

export const ZONE_LABEL: Record<ZoneId, string> = {
  deck: 'デッキ',
  hand: '手札',
  trash: 'ゴミ箱',
  leader: 'リーダー',
  char: 'キャラ',
  battle: 'バトル',
  field: 'フィールド',
  pending: '宣言中',
  aside: '横に置いたカード',
}
