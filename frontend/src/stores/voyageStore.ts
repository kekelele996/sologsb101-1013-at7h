/**
 * 普查队航次 store：按航次批次管理下水作业。
 * - 航次 CRUD、按航次汇总样带 / 珊瑚覆盖 / 鱼类计数
 * - 提交审核：普查队侧先把航次置为「已提交」，再触发院所侧生成审核单；
 *   审核单写失败时航次保持「已提交」，可只重试审核这侧，已录数据照旧。
 * 审核单与驳回条目的读写归 reviewStore（院所侧），本 store 不直接改。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { createId, db, watchTable } from '@/utils/db'
import type { Belt } from '@/types/belt'
import type { Voyage, VoyageDraft } from '@/types/voyage'
import { createEmptyVoyageDraft } from '@/types/voyage'
import { useReviewStore } from '@/stores/reviewStore'

export const useVoyageStore = defineStore('voyage', () => {
  const reviewStore = useReviewStore()

  const voyages = ref<Voyage[]>([])
  const belts = ref<Belt[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)
  const currentVoyageId = ref<string | null>(null)
  const draft = ref<VoyageDraft>(createEmptyVoyageDraft())

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<Voyage>(() => db.voyages).subscribe((rows) => {
      voyages.value = rows
      ready.value = true
      error.value = null
    })
    watchTable<Belt>(() => db.belts).subscribe((rows) => {
      belts.value = rows
    })
  }

  /** 航次列表：按作业开始日期倒序，再按航次号 */
  const sortedVoyages = computed<Voyage[]>(() =>
    [...voyages.value].sort((a, b) => {
      const diff = b.startDate.localeCompare(a.startDate)
      if (diff !== 0) return diff
      return b.voyageNo.localeCompare(a.voyageNo, 'zh-Hans-CN')
    })
  )

  /** 录入中的航次（样带归属下拉首选） */
  const openVoyages = computed<Voyage[]>(() => voyages.value.filter((voyage) => voyage.status === 'open'))

  /** 航次 id → 样带清单（按编号排序） */
  function beltsOfVoyage(voyageId: string | null | undefined): Belt[] {
    if (!voyageId) return []
    return belts.value
      .filter((belt) => belt.voyageId === voyageId)
      .sort((a, b) => a.no.localeCompare(b.no, 'zh-Hans-CN'))
  }

  /** 航次 id → 样带数（列表回显用） */
  const voyageBeltCounts = computed<Record<string, number>>(() => {
    const counts: Record<string, number> = {}
    belts.value.forEach((belt) => {
      if (!belt.voyageId) return
      counts[belt.voyageId] = (counts[belt.voyageId] ?? 0) + 1
    })
    return counts
  })

  function voyageById(id: string | null | undefined): Voyage | null {
    if (!id) return null
    return voyages.value.find((voyage) => voyage.id === id) ?? null
  }

  function selectVoyage(id: string | null): void {
    currentVoyageId.value = id
  }

  function resetDraft(): void {
    draft.value = createEmptyVoyageDraft(voyages.value.map((voyage) => voyage.voyageNo))
  }

  async function createVoyage(payload: Omit<Voyage, 'id' | 'createdAt' | 'updatedAt' | 'status'>): Promise<Voyage> {
    const now = Date.now()
    const row: Voyage = { ...payload, status: 'open', id: createId('voy'), createdAt: now, updatedAt: now }
    await db.voyages.put(row)
    return row
  }

  async function updateVoyage(id: string, patch: Partial<Voyage>): Promise<void> {
    await db.voyages.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  /**
   * 删除航次：不级联删样带，只把样带的航次归属置空（普查队数据保留，可重新归批）。
   * 已有审核单的航次不允许删除（院所侧档案不能从普查队侧动）。
   */
  async function removeVoyage(id: string): Promise<void> {
    const review = await db.reviews.where('voyageId').equals(id).first()
    if (review) throw new Error('该航次已生成审核单，不能从普查队侧删除')
    await db.transaction('rw', [db.voyages, db.belts], async () => {
      await db.belts.where('voyageId').equals(id).modify({ voyageId: '' })
      await db.voyages.delete(id)
    })
    if (currentVoyageId.value === id) selectVoyage(null)
  }

  /**
   * 提交审核：两个独立事务。
   * 1) 普查队侧：航次 open → submitted（已录数据不再改动归属，只改状态）；
   * 2) 院所侧：生成审核单。失败时航次保持 submitted，调用方提示后可用 retryAcceptance 只重试这一步。
   */
  async function submitVoyage(id: string): Promise<void> {
    const voyage = await db.voyages.get(id)
    if (!voyage) throw new Error('航次不存在')
    if (voyage.status !== 'open') throw new Error('只有录入中的航次可以提交审核')
    const beltCount = await db.belts.where('voyageId').equals(id).count()
    if (beltCount === 0) throw new Error('该航次还没有样带，不能提交审核')
    await db.voyages.update(id, { status: 'submitted', updatedAt: Date.now() } as never)
    await reviewStore.acceptVoyage(id)
  }

  /** 只重试审核这侧：审核单生成失败后重新受理，普查队已录数据照旧 */
  async function retryAcceptance(id: string): Promise<void> {
    await reviewStore.acceptVoyage(id)
  }

  return {
    voyages,
    belts,
    ready,
    error,
    currentVoyageId,
    draft,
    sortedVoyages,
    openVoyages,
    voyageBeltCounts,
    start,
    beltsOfVoyage,
    voyageById,
    selectVoyage,
    resetDraft,
    createVoyage,
    updateVoyage,
    removeVoyage,
    submitVoyage,
    retryAcceptance
  }
})
