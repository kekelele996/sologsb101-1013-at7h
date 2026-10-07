/** 审核结论：通过 / 驳回 */
export type ReviewVerdict = '通过' | '驳回'

export const REVIEW_VERDICTS: ReviewVerdict[] = ['通过', '驳回']

/** 审核单：院所审核组按航次出具的审核单 */
export interface ReviewForm {
  id: string
  /** 航次号（关联航次批次） */
  voyageNo: string
  /** 审核人 */
  reviewer: string
  /** 审核时间（YYYY-MM-DD） */
  reviewedAt: string
  /** 备注 */
  note: string
  createdAt: number
  updatedAt: number
}

/** 审核条目：审核单内逐条样带的结论 */
export interface ReviewItem {
  id: string
  /** 所属审核单 */
  reviewFormId: string
  /** 航次号（与样带对账用） */
  voyageNo: string
  /** 样带编号（与样带对账用） */
  beltNo: string
  /** 审核结论 */
  verdict: ReviewVerdict
  /** 驳回原因 */
  reason: string
  createdAt: number
  updatedAt: number
}

/** 审核单草稿（存于 reviewStore） */
export interface ReviewFormDraft {
  voyageNo: string
  reviewer: string
  reviewedAt: string
  note: string
}

export function createEmptyReviewFormDraft(voyageNo = ''): ReviewFormDraft {
  return {
    voyageNo,
    reviewer: '',
    reviewedAt: new Date().toISOString().slice(0, 10),
    note: ''
  }
}

/** 审核条目草稿（存于 reviewStore） */
export interface ReviewItemDraft {
  beltNo: string
  verdict: ReviewVerdict
  reason: string
}

export function createEmptyReviewItemDraft(beltNo = ''): ReviewItemDraft {
  return {
    beltNo,
    verdict: '通过',
    reason: ''
  }
}
