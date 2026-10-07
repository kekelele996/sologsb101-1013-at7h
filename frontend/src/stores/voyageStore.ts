/**
 * 航次 store：普查队按航次批次管样带。
 * 航次批次是样带的管理单元，样带通过 voyageNo 归属到航次。
 * 院所审核组只管审核单与驳回条目，不碰本侧数据。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { VoyageBatch, VoyageDraft } from '@/types/voyage'
import { createEmptyVoyageDraft, suggestVoyageNo } from '@/types/voyage'
import type { Belt } from '@/types/belt'

export const useVoyageStore = defineStore('voyage', () => {
  const voyages = ref<VoyageBatch[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)
  const draft = ref<VoyageDraft>(createEmptyVoyageDraft())

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<VoyageBatch>(() => db.voyages).subscribe((rows) => {
      voyages.value = rows
      ready.value = true
      error.value = null
    })
  }

  /** 航次号 → 航次批次 */
  function voyageByNo(voyageNo: string | null | undefined): VoyageBatch | null {
    if (!voyageNo) return null
    return voyages.value.find((v) => v.voyageNo === voyageNo) ?? null
  }

  /** 某航次下的样带（按编号排序） */
  function beltsOfVoyage(voyageNo: string | null | undefined, belts: Belt[]): Belt[] {
    if (!voyageNo) return []
    return belts
      .filter((belt) => belt.voyageNo === voyageNo)
      .sort((a, b) => a.no.localeCompare(b.no, 'zh-Hans-CN'))
  }

  /** 由调查日期找航次（找不到返回 null） */
  function voyageBySurveyDate(surveyDate: string): VoyageBatch | null {
    return voyages.value.find((v) => v.surveyDate === surveyDate) ?? null
  }

  function resetDraft(surveyDate?: string): void {
    draft.value = createEmptyVoyageDraft(surveyDate)
  }

  async function createVoyage(payload: Omit<VoyageBatch, 'id' | 'createdAt' | 'updatedAt'>): Promise<VoyageBatch> {
    const now = Date.now()
    const row: VoyageBatch = { ...payload, id: createId('voy'), createdAt: now, updatedAt: now }
    await db.voyages.put(row)
    return row
  }

  async function updateVoyage(id: string, patch: Partial<VoyageBatch>): Promise<void> {
    await db.voyages.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  async function removeVoyage(id: string): Promise<void> {
    await db.voyages.delete(id)
  }

  /** 为样带确保航次归属：按航次号找，找不到则按样带上的航次号建立（空则按调查日期建议） */
  async function ensureVoyageForBelt(belt: Pick<Belt, 'voyageNo' | 'surveyDate'>): Promise<VoyageBatch> {
    const voyageNo = belt.voyageNo.trim() || suggestVoyageNo(belt.surveyDate)
    const existing = voyageByNo(voyageNo)
    if (existing) return existing
    return createVoyage({ voyageNo, surveyDate: belt.surveyDate, team: '', note: '' })
  }

  return {
    voyages,
    ready,
    error,
    draft,
    start,
    voyageByNo,
    beltsOfVoyage,
    voyageBySurveyDate,
    resetDraft,
    createVoyage,
    updateVoyage,
    removeVoyage,
    ensureVoyageForBelt,
    suggestVoyageNo
  }
})
