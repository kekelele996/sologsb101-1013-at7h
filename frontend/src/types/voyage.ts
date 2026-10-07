/**
 * 航次批次：普查队每趟下水的录入口径单位。
 * 样带（及其珊瑚覆盖、鱼类计数）按航次归批，航次提交后由院所审核组审定，
 * 未审定的批次不进入礁区覆盖率与白化指数结论。
 */

/** 航次状态机：open → submitted → reviewing → approved / partial / rejected */
export type VoyageStatus = 'open' | 'submitted' | 'reviewing' | 'approved' | 'partial' | 'rejected'

export const VOYAGE_STATUSES: VoyageStatus[] = ['open', 'submitted', 'reviewing', 'approved', 'partial', 'rejected']

/** 状态展示文案与标签配色（Element Plus tag type） */
export const VOYAGE_STATUS_META: Record<VoyageStatus, { label: string; tagType: 'info' | 'primary' | 'warning' | 'success' | 'danger' }> = {
  open: { label: '录入中', tagType: 'info' },
  submitted: { label: '已提交待受理', tagType: 'primary' },
  reviewing: { label: '院所审核中', tagType: 'warning' },
  approved: { label: '已审定通过', tagType: 'success' },
  partial: { label: '部分通过（有驳回）', tagType: 'warning' },
  rejected: { label: '整批驳回', tagType: 'danger' }
}

/** 航次：普查队一次下水作业形成的批次 */
export interface Voyage {
  id: string
  /** 航次号，两边对账关键字之一，全库唯一，如 VY-20261007-01 */
  voyageNo: string
  /** 航次名称 */
  title: string
  /** 普查队 */
  team: string
  /** 作业起止日期 */
  startDate: string
  endDate: string
  status: VoyageStatus
  /** 备注（迁移补录来源等） */
  note: string
  createdAt: number
  updatedAt: number
}

/** 航次草稿（存于 voyageStore） */
export interface VoyageDraft {
  voyageNo: string
  title: string
  team: string
  startDate: string
  endDate: string
  note: string
}

/** 按当天日期与序号生成航次号：VY-YYYYMMDD-NN */
export function suggestVoyageNo(existingNos: string[], date = new Date()): string {
  const compact = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
  const prefix = `VY-${compact}-`
  let seq = 1
  const taken = new Set(existingNos)
  while (taken.has(`${prefix}${String(seq).padStart(2, '0')}`)) seq += 1
  return `${prefix}${String(seq).padStart(2, '0')}`
}

export function createEmptyVoyageDraft(existingNos: string[] = []): VoyageDraft {
  const today = new Date().toISOString().slice(0, 10)
  return {
    voyageNo: suggestVoyageNo(existingNos),
    title: '',
    team: '',
    startDate: today,
    endDate: today,
    note: ''
  }
}
