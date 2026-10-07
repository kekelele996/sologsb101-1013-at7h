/** 航次批次：普查队按航次管理样带的单元 */
export interface VoyageBatch {
  id: string
  /** 航次号，如 V20261007 */
  voyageNo: string
  /** 调查日期（航次归属日期） */
  surveyDate: string
  /** 调查队 / 负责人 */
  team: string
  /** 备注 */
  note: string
  createdAt: number
  updatedAt: number
}

/** 航次审核状态（派生）：未送审 / 已审 / 已挂起 */
export type VoyageReviewStatus = '未送审' | '已审' | '已挂起'

export const VOYAGE_REVIEW_STATUSES: VoyageReviewStatus[] = ['未送审', '已审', '已挂起']

/** 航次批次草稿（存于 voyageStore） */
export interface VoyageDraft {
  voyageNo: string
  surveyDate: string
  team: string
  note: string
}

export function createEmptyVoyageDraft(surveyDate?: string): VoyageDraft {
  const date = surveyDate ?? new Date().toISOString().slice(0, 10)
  return {
    voyageNo: suggestVoyageNo(date),
    surveyDate: date,
    team: '',
    note: ''
  }
}

/** 由调查日期生成航次号建议：V + YYYYMMDD */
export function suggestVoyageNo(surveyDate: string): string {
  return `V${surveyDate.replace(/-/g, '')}`
}
