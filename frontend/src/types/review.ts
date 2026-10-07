/**
 * 院所审核侧模型：审核单（一航次一单）与驳回条目（条目级驳回）。
 * 审核组只管这两类数据；普查队的航次、样带与记录不在此修改。
 */

/** 审核单状态：pending 待签发；签发后为 approved / partial / rejected（与航次状态同步） */
export type ReviewStatus = 'pending' | 'approved' | 'partial' | 'rejected'

export const REVIEW_STATUS_META: Record<ReviewStatus, { label: string; tagType: 'info' | 'primary' | 'warning' | 'success' | 'danger' }> = {
  pending: { label: '待签发', tagType: 'warning' },
  approved: { label: '已签发·通过', tagType: 'success' },
  partial: { label: '已签发·部分通过', tagType: 'warning' },
  rejected: { label: '已签发·整批驳回', tagType: 'danger' }
}

/**
 * 审核单：院所受理航次时生成，快照当时的航次号与样带编号清单作为对账基准。
 * 普查队提交后若再改动样带，快照即对不上，批次挂起，需重新对账。
 */
export interface ReviewOrder {
  id: string
  /** 对应航次（唯一：一个航次同时只存在一张审核单） */
  voyageId: string
  /** 快照：受理时的航次号 */
  voyageNo: string
  /** 快照：受理时的样带编号清单（多重集，排序存储） */
  beltNos: string[]
  status: ReviewStatus
  /** 审核人 */
  reviewer: string
  /** 审核意见 */
  comment: string
  /** 受理时间 */
  submittedAt: number
  /** 签发时间（未签发为 null） */
  signedAt: number | null
  createdAt: number
  updatedAt: number
}

/** 驳回条目状态：open 驳回中（不计入结论）；resolved 已复核销号（重新计入） */
export type RejectStatus = 'open' | 'resolved'

/** 驳回条目：条目级驳回，只退被驳回的样带，不牵连同航次其他样带 */
export interface RejectEntry {
  id: string
  /** 所属审核单 */
  reviewId: string
  /** 冗余航次与样带标识，便于按航次对账与展示 */
  voyageId: string
  beltId: string
  /** 快照：驳回时的样带编号 */
  beltNo: string
  /** 驳回理由 */
  reason: string
  status: RejectStatus
  createdAt: number
  updatedAt: number
}
