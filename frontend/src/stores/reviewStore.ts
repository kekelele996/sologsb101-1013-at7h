/**
 * 院所审核组 store：只管审核单与驳回条目。
 * - 受理航次生成审核单（快照航次号 + 样带编号清单，作为对账基准）
 * - 逐条样带通过 / 驳回（条目级驳回，只退被驳回的几条）
 * - 签发审核单、复核销号驳回条目、对账挂起与重新对账
 * 结论口径（哪些样带计入礁区覆盖率与白化指数）统一由 utils/scope.ts 派生，本 store 只负责审核侧写入。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { createId, db, watchTable } from '@/utils/db'
import type { Belt } from '@/types/belt'
import type { Voyage } from '@/types/voyage'
import type { RejectEntry, ReviewOrder, ReviewStatus } from '@/types/review'
import { reconcileVoyage, resolveReviewScope, type ReviewScope } from '@/utils/scope'

export const useReviewStore = defineStore('review', () => {
  const voyages = ref<Voyage[]>([])
  const reviews = ref<ReviewOrder[]>([])
  const rejectEntries = ref<RejectEntry[]>([])
  const belts = ref<Belt[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<Voyage>(() => db.voyages).subscribe((rows) => {
      voyages.value = rows
      ready.value = true
      error.value = null
    })
    watchTable<ReviewOrder>(() => db.reviews).subscribe((rows) => {
      reviews.value = rows
    })
    watchTable<RejectEntry>(() => db.rejectEntries).subscribe((rows) => {
      rejectEntries.value = rows
    })
    watchTable<Belt>(() => db.belts).subscribe((rows) => {
      belts.value = rows
    })
  }

  /** 结论口径：计入礁区覆盖率与白化指数的样带集合、挂起批次、对账结果 */
  const scope = computed<ReviewScope>(() =>
    resolveReviewScope({
      belts: belts.value,
      voyages: voyages.value,
      reviews: reviews.value,
      rejectEntries: rejectEntries.value
    })
  )

  /** 待受理批次：普查队已提交但尚未生成审核单的航次 */
  const pendingVoyages = computed<Voyage[]>(() =>
    voyages.value
      .filter((voyage) => voyage.status === 'submitted' && !scope.value.reviewOf(voyage.id))
      .sort((a, b) => a.voyageNo.localeCompare(b.voyageNo, 'zh-Hans-CN'))
  )

  /** 挂起的审核单（对账失败，不计入结论） */
  const suspendedReviews = computed<ReviewOrder[]>(() =>
    reviews.value.filter((review) => scope.value.suspendedVoyageIds.has(review.voyageId))
  )

  /** 未复核的驳回条目 */
  const openRejectEntries = computed<RejectEntry[]>(() =>
    rejectEntries.value.filter((entry) => entry.status === 'open')
  )

  function reviewById(id: string | null | undefined): ReviewOrder | null {
    if (!id) return null
    return reviews.value.find((review) => review.id === id) ?? null
  }

  function voyageById(id: string | null | undefined): Voyage | null {
    if (!id) return null
    return voyages.value.find((voyage) => voyage.id === id) ?? null
  }

  /** 审核单在册样带（按审核单 voyageId 取普查队当前样带） */
  function beltsOfReview(review: ReviewOrder | null | undefined): Belt[] {
    if (!review) return []
    return belts.value
      .filter((belt) => belt.voyageId === review.voyageId)
      .sort((a, b) => a.no.localeCompare(b.no, 'zh-Hans-CN'))
  }

  function rejectsOfReview(reviewId: string | null | undefined): RejectEntry[] {
    if (!reviewId) return []
    return rejectEntries.value.filter((entry) => entry.reviewId === reviewId)
  }

  /**
   * 受理航次：生成审核单（院所侧独立写入）。
   * 失败（如空航次、并发重复受理）只影响审核侧，普查队已录数据照旧；
   * 调用方捕获失败后可只重试本函数。voyageId 唯一索引兜底幂等。
   */
  async function acceptVoyage(voyageId: string): Promise<ReviewOrder> {
    const voyage = await db.voyages.get(voyageId)
    if (!voyage) throw new Error('航次不存在，无法生成审核单')
    const voyageBelts = await db.belts.where('voyageId').equals(voyageId).toArray()
    if (voyageBelts.length === 0) throw new Error('该航次还没有样带，不能生成审核单')
    const now = Date.now()
    const order: ReviewOrder = {
      id: createId('rev'),
      voyageId,
      voyageNo: voyage.voyageNo,
      beltNos: voyageBelts.map((belt) => belt.no).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')),
      status: 'pending',
      reviewer: '',
      comment: '',
      submittedAt: now,
      signedAt: null,
      createdAt: now,
      updatedAt: now
    }
    try {
      await db.reviews.add(order)
    } catch (err) {
      // 并发下重复受理：唯一索引冲突时复用已生成的审核单（幂等）
      const existing = await db.reviews.where('voyageId').equals(voyageId).first()
      if (existing) return existing
      throw err
    }
    // 受理成功，航次推进到「院所审核中」（仅当仍处于已提交状态）
    await db.voyages
      .where('id')
      .equals(voyageId)
      .filter((row) => row.status === 'submitted')
      .modify({ status: 'reviewing', updatedAt: Date.now() })
    return order
  }

  /** 条目级驳回：只退被驳回的样带（签发前可反复调整） */
  async function rejectBelt(reviewId: string, belt: Belt, reason: string): Promise<RejectEntry> {
    const review = await db.reviews.get(reviewId)
    if (!review) throw new Error('审核单不存在')
    if (review.status !== 'pending') throw new Error('审核单已签发，不能再驳回')
    const duplicated = await db.rejectEntries
      .where('reviewId')
      .equals(reviewId)
      .filter((entry) => entry.beltId === belt.id && entry.status === 'open')
      .count()
    if (duplicated > 0) throw new Error(`样带 ${belt.no} 已在驳回条目里`)
    const now = Date.now()
    const entry: RejectEntry = {
      id: createId('rej'),
      reviewId,
      voyageId: review.voyageId,
      beltId: belt.id,
      beltNo: belt.no,
      reason,
      status: 'open',
      createdAt: now,
      updatedAt: now
    }
    await db.rejectEntries.put(entry)
    return entry
  }

  /** 签发前撤销某条驳回 */
  async function withdrawReject(entryId: string): Promise<void> {
    const entry = await db.rejectEntries.get(entryId)
    if (!entry) return
    const review = await db.reviews.get(entry.reviewId)
    if (review && review.status !== 'pending') throw new Error('审核单已签发，驳回条目只能复核销号')
    await db.rejectEntries.delete(entryId)
  }

  /**
   * 签发审核单：先对账，核不上禁止签发（批次保持挂起）。
   * 结果：无驳回 → approved；全部驳回 → rejected；其余 → partial，并同步航次状态。
   */
  async function signReview(reviewId: string, reviewer: string, comment: string): Promise<ReviewStatus> {
    const review = await db.reviews.get(reviewId)
    if (!review) throw new Error('审核单不存在')
    if (review.status !== 'pending') throw new Error('审核单已签发')
    const voyage = await db.voyages.get(review.voyageId)
    const voyageBelts = await db.belts.where('voyageId').equals(review.voyageId).toArray()
    const reconcile = reconcileVoyage(voyage ?? null, review, voyageBelts)
    if (!reconcile.ok) throw new Error(`对账未通过，批次挂起：${reconcile.reasons.join('；')}`)
    const openRejects = await db.rejectEntries
      .where('reviewId')
      .equals(reviewId)
      .filter((entry) => entry.status === 'open')
      .toArray()
    const status: ReviewStatus =
      openRejects.length === 0 ? 'approved' : openRejects.length >= voyageBelts.length ? 'rejected' : 'partial'
    const now = Date.now()
    await db.transaction('rw', [db.reviews, db.voyages], async () => {
      await db.reviews.update(reviewId, {
        status,
        reviewer: reviewer.trim(),
        comment: comment.trim(),
        signedAt: now,
        updatedAt: now
      } as never)
      await db.voyages.update(review.voyageId, { status, updatedAt: now } as never)
    })
    return status
  }

  /** 复核销号：驳回条目整改复核通过后销号，该样带重新计入结论 */
  async function resolveReject(entryId: string): Promise<void> {
    const now = Date.now()
    await db.transaction('rw', [db.rejectEntries, db.reviews, db.voyages], async () => {
      const entry = await db.rejectEntries.get(entryId)
      if (!entry || entry.status !== 'open') return
      await db.rejectEntries.update(entryId, { status: 'resolved', updatedAt: now })
      const remaining = await db.rejectEntries
        .where('reviewId')
        .equals(entry.reviewId)
        .filter((item) => item.status === 'open' && item.id !== entryId)
        .count()
      // 全部驳回条目销号后，审核单与航次回到「通过」
      if (remaining === 0) {
        const review = await db.reviews.get(entry.reviewId)
        if (review && review.status !== 'pending') {
          await db.reviews.update(review.id, { status: 'approved', updatedAt: now } as never)
          await db.voyages.update(review.voyageId, { status: 'approved', updatedAt: now } as never)
        }
      }
    })
  }

  /** 重新对账：以普查队当前数据刷新审核单快照（航次号 + 样带编号清单），解除挂起 */
  async function recheckReview(reviewId: string): Promise<void> {
    const review = await db.reviews.get(reviewId)
    if (!review) throw new Error('审核单不存在')
    const voyage = await db.voyages.get(review.voyageId)
    if (!voyage) throw new Error('航次在普查队侧不存在，无法重新对账')
    const voyageBelts = await db.belts.where('voyageId').equals(review.voyageId).toArray()
    await db.reviews.update(reviewId, {
      voyageNo: voyage.voyageNo,
      beltNos: voyageBelts.map((belt) => belt.no).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')),
      updatedAt: Date.now()
    } as never)
  }

  return {
    voyages,
    reviews,
    rejectEntries,
    belts,
    ready,
    error,
    scope,
    pendingVoyages,
    suspendedReviews,
    openRejectEntries,
    start,
    reviewById,
    voyageById,
    beltsOfReview,
    rejectsOfReview,
    acceptVoyage,
    rejectBelt,
    withdrawReject,
    signReview,
    resolveReject,
    recheckReview
  }
})
