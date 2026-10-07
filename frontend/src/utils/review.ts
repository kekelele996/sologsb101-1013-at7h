/**
 * 审核对账工具：审核条目 ↔ 普查样带（按航次号 + 样带编号）。
 * 纯函数，供 store 与页面派生响应式状态。
 */
import type { VoyageReviewStatus } from '@/types/voyage'
import type { ReviewForm, ReviewItem } from '@/types/review'
import type { Belt } from '@/types/belt'

export interface ReconcileResult {
  /** 对账成功：审核条目 ↔ 普查样带 */
  matched: Array<{ item: ReviewItem; belt: Belt }>
  /** 对账失败：审核条目引用的样带在普查侧不存在（核不上） */
  unmatched: ReviewItem[]
}

/** 对账：逐条审核条目匹配普查样带（航次号 + 样带编号） */
export function reconcileItems(items: ReviewItem[], belts: Belt[]): ReconcileResult {
  const matched: Array<{ item: ReviewItem; belt: Belt }> = []
  const unmatched: ReviewItem[] = []
  items.forEach((item) => {
    const belt = belts.find((b) => b.voyageNo === item.voyageNo && b.no === item.beltNo)
    if (belt) matched.push({ item, belt })
    else unmatched.push(item)
  })
  return { matched, unmatched }
}

/** 航次审核状态：未送审 / 已审 / 已挂起 */
export function voyageReviewStatus(
  voyageNo: string,
  reviewForms: ReviewForm[],
  reviewItems: ReviewItem[],
  belts: Belt[]
): VoyageReviewStatus {
  const form = reviewForms.find((rf) => rf.voyageNo === voyageNo)
  if (!form) return '未送审'
  const items = reviewItems.filter((ri) => ri.reviewFormId === form.id)
  const { unmatched } = reconcileItems(items, belts)
  return unmatched.length > 0 ? '已挂起' : '已审'
}

/** 样带是否通过审核（可计入结论） */
export function beltApproved(
  belt: Belt,
  reviewForms: ReviewForm[],
  reviewItems: ReviewItem[],
  belts: Belt[]
): boolean {
  const form = reviewForms.find((rf) => rf.voyageNo === belt.voyageNo)
  if (!form) return false
  if (voyageReviewStatus(belt.voyageNo, reviewForms, reviewItems, belts) === '已挂起') return false
  const item = reviewItems.find((ri) => ri.reviewFormId === form.id && ri.beltNo === belt.no)
  return item?.verdict === '通过'
}

/** 航次下通过审核的样带（可计入结论） */
export function approvedBeltsOfVoyage(
  voyageNo: string,
  reviewForms: ReviewForm[],
  reviewItems: ReviewItem[],
  belts: Belt[]
): Belt[] {
  return belts.filter(
    (belt) => belt.voyageNo === voyageNo && beltApproved(belt, reviewForms, reviewItems, belts)
  )
}
