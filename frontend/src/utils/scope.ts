/**
 * 结论口径（唯一事实来源）：对账与「计入结论的样带集合」判定。
 * 覆盖度汇总页、礁区/站位白化汇总、复制结论与结论 JSON 导出全部走这里，
 * 保证「礁区覆盖率和白化指数只按审过的批次算」这一个口径。
 *
 * 口径定义：一条样带计入结论，当且仅当
 *   1. 它归属的航次已被院所受理（存在审核单）且审核单已签发（approved / partial）；
 *   2. 该样带没有未复核（open）的驳回条目 —— 驳回是条目级，只退被驳回的几条；
 *   3. 批次对账通过（未挂起）：审核单快照的航次号、样带编号清单与普查队当前数据一致。
 */
import type { Belt } from '@/types/belt'
import type { Voyage } from '@/types/voyage'
import type { RejectEntry, ReviewOrder } from '@/types/review'

/** 单航次对账结果 */
export interface ReconcileResult {
  ok: boolean
  /** 对不上的原因（挂起说明） */
  reasons: string[]
  /** 审核单快照里有、普查队当前缺失的样带编号 */
  missingBeltNos: string[]
  /** 普查队当前多出、审核单快照没有的样带编号 */
  extraBeltNos: string[]
}

/** 编号清单按多重集比较（同一航次内不同站位允许同编号，如两个站位都有 T-01） */
function diffMultiset(snapshot: string[], current: string[]): { missing: string[]; extra: string[] } {
  const countOf = (list: string[]): Map<string, number> => {
    const map = new Map<string, number>()
    list.forEach((no) => map.set(no, (map.get(no) ?? 0) + 1))
    return map
  }
  const snapCount = countOf(snapshot)
  const currCount = countOf(current)
  const missing: string[] = []
  const extra: string[] = []
  snapCount.forEach((count, no) => {
    const diff = count - (currCount.get(no) ?? 0)
    for (let i = 0; i < diff; i += 1) missing.push(no)
  })
  currCount.forEach((count, no) => {
    const diff = count - (snapCount.get(no) ?? 0)
    for (let i = 0; i < diff; i += 1) extra.push(no)
  })
  return { missing, extra }
}

const collator = (a: string, b: string): number => a.localeCompare(b, 'zh-Hans-CN')

/**
 * 对账：审核单快照（航次号 + 样带编号清单） vs 普查队当前数据。
 * 核不上的批次由调用方挂起（不计入结论），重新对账刷新快照后解除。
 */
export function reconcileVoyage(
  voyage: Voyage | null | undefined,
  review: ReviewOrder,
  belts: Belt[]
): ReconcileResult {
  if (!voyage) {
    return {
      ok: false,
      reasons: [`航次号「${review.voyageNo}」在普查队侧不存在，批次挂起`],
      missingBeltNos: [],
      extraBeltNos: []
    }
  }
  const reasons: string[] = []
  if (voyage.voyageNo !== review.voyageNo) {
    reasons.push(`航次号对不上：审核单「${review.voyageNo}」≠ 普查队「${voyage.voyageNo}」`)
  }
  const currentNos = belts
    .filter((belt) => belt.voyageId === voyage.id)
    .map((belt) => belt.no)
  const { missing, extra } = diffMultiset([...review.beltNos].sort(collator), currentNos.sort(collator))
  if (missing.length > 0) reasons.push(`样带编号对不上：审核单在册而普查队缺失 ${missing.join('、')}`)
  if (extra.length > 0) reasons.push(`样带编号对不上：普查队多出 ${extra.join('、')}（提交后改动需重新对账）`)
  return { ok: reasons.length === 0, reasons, missingBeltNos: missing, extraBeltNos: extra }
}

/** 全库结论口径视图 */
export interface ReviewScope {
  /** 计入结论的样带 id 集合（已审定批次内、未被驳回、批次未挂起） */
  approvedBeltIds: Set<string>
  /** 对账失败被挂起的航次 id 集合 */
  suspendedVoyageIds: Set<string>
  /** 航次 id → 审核单（未受理为 null） */
  reviewOf: (voyageId: string) => ReviewOrder | null
  /** 航次 id → 对账结果（无审核单为 null） */
  reconcileOf: (voyageId: string) => ReconcileResult | null
  /** 样带 id → 未复核驳回条目 */
  openRejectsOfBelt: (beltId: string) => RejectEntry[]
  /** 航次 id → 未复核驳回条目 */
  openRejectsOfVoyage: (voyageId: string) => RejectEntry[]
}

export function resolveReviewScope(input: {
  belts: Belt[]
  voyages: Voyage[]
  reviews: ReviewOrder[]
  rejectEntries: RejectEntry[]
}): ReviewScope {
  const { belts, voyages, reviews, rejectEntries } = input
  const voyageById = new Map(voyages.map((voyage) => [voyage.id, voyage]))
  const reviewByVoyage = new Map(reviews.map((review) => [review.voyageId, review]))

  const openRejects = rejectEntries.filter((entry) => entry.status === 'open')
  const openRejectsByBelt = new Map<string, RejectEntry[]>()
  const openRejectsByVoyage = new Map<string, RejectEntry[]>()
  openRejects.forEach((entry) => {
    openRejectsByBelt.set(entry.beltId, [...(openRejectsByBelt.get(entry.beltId) ?? []), entry])
    openRejectsByVoyage.set(entry.voyageId, [...(openRejectsByVoyage.get(entry.voyageId) ?? []), entry])
  })

  const approvedBeltIds = new Set<string>()
  const suspendedVoyageIds = new Set<string>()
  const reconcileMap = new Map<string, ReconcileResult>()

  voyages.forEach((voyage) => {
    const review = reviewByVoyage.get(voyage.id)
    if (!review) return
    const reconcile = reconcileVoyage(voyage, review, belts)
    reconcileMap.set(voyage.id, reconcile)
    if (!reconcile.ok) {
      suspendedVoyageIds.add(voyage.id)
      return
    }
    // 未签发（pending）与整批驳回（rejected）的批次一律不计入结论
    if (review.status !== 'approved' && review.status !== 'partial') return
    belts
      .filter((belt) => belt.voyageId === voyage.id && !openRejectsByBelt.has(belt.id))
      .forEach((belt) => approvedBeltIds.add(belt.id))
  })

  return {
    approvedBeltIds,
    suspendedVoyageIds,
    reviewOf: (voyageId) => reviewByVoyage.get(voyageId) ?? null,
    reconcileOf: (voyageId) => reconcileMap.get(voyageId) ?? null,
    openRejectsOfBelt: (beltId) => openRejectsByBelt.get(beltId) ?? [],
    openRejectsOfVoyage: (voyageId) => openRejectsByVoyage.get(voyageId) ?? []
  }
}

/** 便捷过滤：从记录列表中挑出计入结论的部分（按 beltId 归属判定） */
export function filterApproved<T extends { beltId: string }>(records: T[], scope: ReviewScope): T[] {
  return records.filter((record) => scope.approvedBeltIds.has(record.beltId))
}

/** 供页面展示用的批次口径说明（voyageId 空串表示未归属航次） */
export function scopeNoteForBelt(belt: Belt | null | undefined, scope: ReviewScope, voyages: Voyage[]): string | null {
  if (!belt) return null
  if (scope.approvedBeltIds.has(belt.id)) return null
  const voyage = voyages.find((item) => item.id === belt.voyageId)
  if (!voyage) return '该样带未归属航次批次，不计入礁区结论'
  const review = scope.reviewOf(voyage.id)
  if (!review) return `航次「${voyage.voyageNo}」尚未被院所受理，本样带不计入礁区结论`
  if (scope.suspendedVoyageIds.has(voyage.id)) return `航次「${voyage.voyageNo}」对账挂起，本样带暂不计入礁区结论`
  if (review.status === 'pending') return `航次「${voyage.voyageNo}」审核单待签发，本样带暂不计入礁区结论`
  if (review.status === 'rejected') return `航次「${voyage.voyageNo}」整批驳回，本样带不计入礁区结论`
  if (scope.openRejectsOfBelt(belt.id).length > 0) return '本样带被院所驳回，复核销号前不计入礁区结论'
  return null
}
