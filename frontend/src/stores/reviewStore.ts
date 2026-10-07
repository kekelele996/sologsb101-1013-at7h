/**
 * 审核 store：院所审核组只管审核单与驳回条目。
 * 写审核单失败时只重试审核侧，普查队录好的样带/珊瑚/鱼类不动。
 * 审核状态（未送审/已审/已挂起）与样带是否通过均为派生值，不额外落库。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { ReviewForm, ReviewItem, ReviewFormDraft, ReviewItemDraft } from '@/types/review'
import { createEmptyReviewFormDraft, createEmptyReviewItemDraft } from '@/types/review'
import type { Belt } from '@/types/belt'
import { reconcileItems, voyageReviewStatus, beltApproved } from '@/utils/review'

/** 审核单写入重试次数 */
const REVIEW_WRITE_RETRIES = 3
/** 重试退避基数（ms） */
const REVIEW_WRITE_BACKOFF = 120

export const useReviewStore = defineStore('review', () => {
  const reviewForms = ref<ReviewForm[]>([])
  const reviewItems = ref<ReviewItem[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)
  const formDraft = ref<ReviewFormDraft>(createEmptyReviewFormDraft())
  const itemDraft = ref<ReviewItemDraft>(createEmptyReviewItemDraft())

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<ReviewForm>(() => db.reviewForms).subscribe((rows) => {
      reviewForms.value = rows
      ready.value = true
      error.value = null
    })
    watchTable<ReviewItem>(() => db.reviewItems).subscribe((rows) => {
      reviewItems.value = rows
    })
  }

  /** 航次号 → 审核单 */
  function reviewFormOfVoyage(voyageNo: string | null | undefined): ReviewForm | null {
    if (!voyageNo) return null
    return reviewForms.value.find((rf) => rf.voyageNo === voyageNo) ?? null
  }

  /** 审核单 → 审核条目（按样带编号排序） */
  function itemsOfForm(formId: string | null | undefined): ReviewItem[] {
    if (!formId) return []
    return reviewItems.value
      .filter((ri) => ri.reviewFormId === formId)
      .sort((a, b) => a.beltNo.localeCompare(b.beltNo, 'zh-Hans-CN'))
  }

  /** 某航次的对账结果（需传入普查样带） */
  function reconcileOfVoyage(voyageNo: string, belts: Belt[]) {
    const form = reviewFormOfVoyage(voyageNo)
    if (!form) return { matched: [], unmatched: [] }
    return reconcileItems(itemsOfForm(form.id), belts)
  }

  /** 航次审核状态（派生）：未送审 / 已审 / 已挂起 */
  function statusOfVoyage(voyageNo: string, belts: Belt[]) {
    return voyageReviewStatus(voyageNo, reviewForms.value, reviewItems.value, belts)
  }

  /** 样带是否通过审核（可计入结论） */
  function isBeltApproved(belt: Belt, belts: Belt[]) {
    return beltApproved(belt, reviewForms.value, reviewItems.value, belts)
  }

  function resetFormDraft(voyageNo = ''): void {
    formDraft.value = createEmptyReviewFormDraft(voyageNo)
  }

  function resetItemDraft(beltNo = ''): void {
    itemDraft.value = createEmptyReviewItemDraft(beltNo)
  }

  /** 带重试的审核单写入：失败只重试审核侧，不触碰普查数据 */
  async function createReviewForm(
    payload: Omit<ReviewForm, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<ReviewForm> {
    let lastError: unknown = null
    for (let attempt = 0; attempt < REVIEW_WRITE_RETRIES; attempt++) {
      try {
        const now = Date.now()
        const row: ReviewForm = { ...payload, id: createId('rev'), createdAt: now, updatedAt: now }
        await db.reviewForms.put(row)
        return row
      } catch (err) {
        lastError = err
        if (attempt < REVIEW_WRITE_RETRIES - 1) {
          await new Promise((resolve) => setTimeout(resolve, REVIEW_WRITE_BACKOFF * (attempt + 1)))
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error('审核单写入失败')
  }

  async function updateReviewForm(id: string, patch: Partial<ReviewForm>): Promise<void> {
    await db.reviewForms.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  async function removeReviewForm(id: string): Promise<void> {
    await db.transaction('rw', [db.reviewForms, db.reviewItems], async () => {
      await db.reviewItems.where('reviewFormId').equals(id).delete()
      await db.reviewForms.delete(id)
    })
  }

  /** 带重试的审核条目写入 */
  async function createReviewItem(
    payload: Omit<ReviewItem, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<ReviewItem> {
    let lastError: unknown = null
    for (let attempt = 0; attempt < REVIEW_WRITE_RETRIES; attempt++) {
      try {
        const now = Date.now()
        const row: ReviewItem = { ...payload, id: createId('rit'), createdAt: now, updatedAt: now }
        await db.reviewItems.put(row)
        return row
      } catch (err) {
        lastError = err
        if (attempt < REVIEW_WRITE_RETRIES - 1) {
          await new Promise((resolve) => setTimeout(resolve, REVIEW_WRITE_BACKOFF * (attempt + 1)))
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error('审核条目写入失败')
  }

  async function updateReviewItem(id: string, patch: Partial<ReviewItem>): Promise<void> {
    await db.reviewItems.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  async function removeReviewItem(id: string): Promise<void> {
    await db.reviewItems.delete(id)
  }

  return {
    reviewForms,
    reviewItems,
    ready,
    error,
    formDraft,
    itemDraft,
    start,
    reviewFormOfVoyage,
    itemsOfForm,
    reconcileOfVoyage,
    statusOfVoyage,
    isBeltApproved,
    resetFormDraft,
    resetItemDraft,
    createReviewForm,
    updateReviewForm,
    removeReviewForm,
    createReviewItem,
    updateReviewItem,
    removeReviewItem
  }
})
