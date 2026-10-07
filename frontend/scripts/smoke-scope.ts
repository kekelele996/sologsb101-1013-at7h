/* 冒烟测试：结论口径（对账 + 审定样带集合）—— 临时脚本，验证后可删 */
import { reconcileVoyage, resolveReviewScope, scopeNoteForBelt } from '@/utils/scope'
import type { Belt } from '@/types/belt'
import type { Voyage } from '@/types/voyage'
import type { RejectEntry, ReviewOrder } from '@/types/review'

let failures = 0
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  ok  ${name}`)
  else {
    failures += 1
    console.error(`FAIL  ${name}`)
  }
}

const voyage: Voyage = {
  id: 'voy1', voyageNo: 'VY-20261007-01', title: 't', team: 'team',
  startDate: '2026-10-07', endDate: '2026-10-07', status: 'approved', note: '',
  createdAt: 1, updatedAt: 1
}
const belt = (id: string, no: string, voyageId = 'voy1'): Belt => ({
  id, siteId: 's1', voyageId, no, lengthM: 50, orientation: '北',
  surveyDate: '2026-10-07', observer: 'o', createdAt: 1, updatedAt: 1
})
const review = (patch: Partial<ReviewOrder>): ReviewOrder => ({
  id: 'rev1', voyageId: 'voy1', voyageNo: 'VY-20261007-01', beltNos: ['T-01', 'T-02'],
  status: 'approved', reviewer: 'r', comment: '', submittedAt: 1, signedAt: 2, createdAt: 1, updatedAt: 1,
  ...patch
})
const reject = (patch: Partial<RejectEntry>): RejectEntry => ({
  id: 'rej1', reviewId: 'rev1', voyageId: 'voy1', beltId: 'b1', beltNo: 'T-01',
  reason: 'x', status: 'open', createdAt: 1, updatedAt: 1, ...patch
})

// 1) 对账
const belts = [belt('b1', 'T-01'), belt('b2', 'T-02')]
check('对账通过', reconcileVoyage(voyage, review({}), belts).ok)
check('航次号不符挂起', !reconcileVoyage(voyage, review({ voyageNo: 'VY-X' }), belts).ok)
check('普查队缺样带挂起', !reconcileVoyage(voyage, review({}), [belts[0]]).ok)
check('普查队多样带挂起', !reconcileVoyage(voyage, review({}), [...belts, belt('b3', 'T-03')]).ok)
check('航次不存在挂起', !reconcileVoyage(null, review({}), belts).ok)
check('同编号多重集可对账', reconcileVoyage(voyage, review({ beltNos: ['T-01', 'T-01'] }), [belt('b1', 'T-01'), belt('b2', 'T-01')]).ok)

// 2) 结论口径
const scopeOf = (r: ReviewOrder | null, entries: RejectEntry[] = [], bs = belts, vs = [voyage]) =>
  resolveReviewScope({ belts: bs, voyages: vs, reviews: r ? [r] : [], rejectEntries: entries })

check('已签发 approved → 全部计入', scopeOf(review({})).approvedBeltIds.size === 2)
check('未受理 → 不计入', scopeOf(null).approvedBeltIds.size === 0)
check('待签发 pending → 不计入', scopeOf(review({ status: 'pending' })).approvedBeltIds.size === 0)
check('整批驳回 rejected → 不计入', scopeOf(review({ status: 'rejected' })).approvedBeltIds.size === 0)
check('部分通过：被驳回样带不计入', (() => {
  const s = scopeOf(review({ status: 'partial' }), [reject({})])
  return s.approvedBeltIds.size === 1 && s.approvedBeltIds.has('b2')
})())
check('驳回已销号 → 重新计入', scopeOf(review({ status: 'partial' }), [reject({ status: 'resolved' })]).approvedBeltIds.size === 2)
check('对账挂起 → 整批不计入且标记挂起', (() => {
  const s = scopeOf(review({}), [], [...belts, belt('b3', 'T-03')])
  return s.approvedBeltIds.size === 0 && s.suspendedVoyageIds.has('voy1')
})())
check('未归批样带 → 不计入', scopeOf(review({}), [], [belt('b9', 'T-09', '')]).approvedBeltIds.size === 0)

// 3) 提示文案
check('未归批提示', scopeNoteForBelt(belt('b9', 'T-09', ''), scopeOf(null), [])?.includes('未归属') === true)
check('已计入无提示', scopeNoteForBelt(belts[0], scopeOf(review({})), [voyage]) === null)
check('被驳回提示', scopeNoteForBelt(belts[0], scopeOf(review({ status: 'partial' }), [reject({})]), [voyage])?.includes('驳回') === true)

if (failures > 0) {
  console.error(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
