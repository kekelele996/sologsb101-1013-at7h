/* 冒烟测试：播种数据 + 审核全流程（受理/驳回/签发/销号/挂起/重新对账）—— 临时脚本，验证后可删 */
import 'fake-indexeddb/auto'
import { createPinia, setActivePinia } from 'pinia'

setActivePinia(createPinia())

const { resetDatabase, db } = await import('@/utils/db')
const { useReviewStore } = await import('@/stores/reviewStore')
const { useVoyageStore } = await import('@/stores/voyageStore')

let failures = 0
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  ok  ${name}`)
  else {
    failures += 1
    console.error(`FAIL  ${name}`)
  }
}

await resetDatabase()
const reviewStore = useReviewStore()
const voyageStore = useVoyageStore()
reviewStore.start()
voyageStore.start()
await new Promise((resolve) => setTimeout(resolve, 300))

// 1) 播种后的口径
check('播种 2 个航次', reviewStore.voyages.length === 2)
check('播种 1 张已签发审核单', reviewStore.reviews.length === 1)
check('播种 1 条未复核驳回', reviewStore.openRejectEntries.length === 1)
check('口径只含航次一未驳回的 2 条样带', reviewStore.scope.approvedBeltIds.size === 2)
check('被驳回的 belt_ql01_b 不计入', !reviewStore.scope.approvedBeltIds.has('belt_ql01_b'))
check('待受理批次为航次二', reviewStore.pendingVoyages.length === 1 && reviewStore.pendingVoyages[0].id === 'voy_seed_2')

// 2) 受理航次二（院所侧独立写入）
const review2 = await reviewStore.acceptVoyage('voy_seed_2')
check('受理生成审核单', review2.voyageNo.startsWith('VY-') && review2.status === 'pending')
const again = await reviewStore.acceptVoyage('voy_seed_2')
check('重复受理幂等（同一审核单）', again.id === review2.id && (await db.reviews.count()) === 2)
const voy2 = await db.voyages.get('voy_seed_2')
check('受理后航次进入审核中', voy2?.status === 'reviewing')

// 3) 空航次提交失败：普查队数据照旧，可重试
const emptyVoyage = await voyageStore.createVoyage({
  voyageNo: 'VY-20990101-01', title: '空航次', team: 't', startDate: '2099-01-01', endDate: '2099-01-01', note: ''
})
let submitError = ''
try {
  await voyageStore.submitVoyage(emptyVoyage.id)
} catch (err) {
  submitError = err instanceof Error ? err.message : ''
}
check('空航次提交被拒绝且航次保持录入中', submitError.includes('样带') && (await db.voyages.get(emptyVoyage.id))?.status === 'open')

// 4) 逐条审 + 签发
const belts2 = await db.belts.where('voyageId').equals('voy_seed_2').toArray()
await reviewStore.rejectBelt(review2.id, belts2[0], '计数区与样带偏移，退回复核')
const signed = await reviewStore.signReview(review2.id, '顾审言', '一条退回，其余通过')
check('签发为部分通过', signed === 'partial')
check('航次状态同步', (await db.voyages.get('voy_seed_2'))?.status === 'partial')
check('口径含航次二未驳回样带', reviewStore.scope.approvedBeltIds.has(belts2[1].id))
check('口径不含航次二被驳回样带', !reviewStore.scope.approvedBeltIds.has(belts2[0].id))

// 5) 复核销号
const openEntries = reviewStore.openRejectEntries
const seedReject = openEntries.find((e) => e.id === 'rej_seed_1')
await reviewStore.resolveReject(seedReject!.id)
check('销号后航次一回到通过', (await db.voyages.get('voy_seed_1'))?.status === 'approved')
check('belt_ql01_b 重新计入', reviewStore.scope.approvedBeltIds.has('belt_ql01_b'))

// 6) 签发后普查队改动样带 → 对账挂起 → 重新对账解除
await db.belts.put({
  id: 'belt_extra', siteId: 'site_ql_01', voyageId: 'voy_seed_1', no: 'T-03', lengthM: 50,
  orientation: '西', surveyDate: '2026-10-07', observer: 'x', createdAt: 1, updatedAt: 1
})
await new Promise((resolve) => setTimeout(resolve, 200))
check('提交后加样带导致挂起', reviewStore.scope.suspendedVoyageIds.has('voy_seed_1'))
check('挂起批次整批不计入', !reviewStore.scope.approvedBeltIds.has('belt_ql01_a'))
await reviewStore.recheckReview('rev_seed_1')
await new Promise((resolve) => setTimeout(resolve, 200))
check('重新对账后解除挂起', !reviewStore.scope.suspendedVoyageIds.has('voy_seed_1'))
check('解除挂起后恢复计入', reviewStore.scope.approvedBeltIds.has('belt_ql01_a'))

// 7) 签发中的审核单对账失败禁止签发
await db.belts.put({
  id: 'belt_extra2', siteId: 'site_yr_01', voyageId: 'voy_seed_2', no: 'T-09', lengthM: 50,
  orientation: '北', surveyDate: '2026-10-07', observer: 'x', createdAt: 1, updatedAt: 1
})
let signError = ''
try {
  await reviewStore.signReview(review2.id, '顾审言', '')
} catch (err) {
  signError = err instanceof Error ? err.message : ''
}
check('已签发审核单不能重复签发', signError.includes('已签发'))

if (failures > 0) {
  console.error(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
