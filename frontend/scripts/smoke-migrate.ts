/* 冒烟测试：v2 → v3 结构升级，历史样带按调查日期补航次归属 —— 临时脚本，验证后可删 */
import 'fake-indexeddb/auto'
import Dexie from 'dexie'

let failures = 0
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  ok  ${name}`)
  else {
    failures += 1
    console.error(`FAIL  ${name}`)
  }
}

// 1) 先以 v2 结构建库并写入「没记航次」的历史数据
const legacy = new Dexie('gbcoralbelt')
legacy.version(1).stores({
  reefs: 'id, name, protectStatus',
  sites: 'id, reefId, no',
  belts: 'id, siteId, no, surveyDate',
  corals: 'id, beltId, genus, form',
  fishes: 'id, beltId, family, sizeClass'
})
legacy.version(2).stores({
  reefs: 'id, name, location, protectStatus, areaKm2, manager, updatedAt',
  sites: 'id, reefId, no, lat, lng, depthM, substrate, updatedAt',
  belts: 'id, siteId, no, lengthM, orientation, surveyDate, observer, updatedAt',
  corals: 'id, beltId, genus, form, coverCm, bleachLevel, updatedAt',
  fishes: 'id, beltId, family, count, sizeClass, category, updatedAt'
})
await legacy.open()
await legacy.table('belts').bulkPut([
  { id: 'b1', siteId: 's1', no: 'T-01', lengthM: 50, orientation: '北', surveyDate: '2026-09-30', observer: '甲', createdAt: 1, updatedAt: 1 },
  { id: 'b2', siteId: 's1', no: 'T-02', lengthM: 50, orientation: '东', surveyDate: '2026-09-30', observer: '甲', createdAt: 1, updatedAt: 1 },
  { id: 'b3', siteId: 's2', no: 'T-01', lengthM: 30, orientation: '南', surveyDate: '2026-10-02', observer: '乙', createdAt: 1, updatedAt: 1 }
])
await legacy.close()

// 2) 以 v3 代码打开同一库，触发升级迁移
const { db, DB_VERSION } = await import('@/utils/db')
await db.open()
check('结构版本为 3', DB_VERSION === 3 && db.verno === 3)

const voyages = await db.voyages.toArray()
const belts = await db.belts.toArray()
check('按调查日期生成 2 个历史批次', voyages.length === 2)
check('批次航次号为 LEG-<日期>', voyages.every((v) => /^LEG-\d{4}-\d{2}-\d{2}$/.test(v.voyageNo)))
check('迁移批次为待受理状态', voyages.every((v) => v.status === 'submitted'))
check('全部样带已补归属', belts.every((b) => typeof b.voyageId === 'string' && b.voyageId.length > 0))
check('同日期样带归入同一批次', (() => {
  const b1 = belts.find((b) => b.id === 'b1')
  const b2 = belts.find((b) => b.id === 'b2')
  return b1?.voyageId === b2?.voyageId
})())
check('不同日期样带归入不同批次', (() => {
  const b1 = belts.find((b) => b.id === 'b1')
  const b3 = belts.find((b) => b.id === 'b3')
  return b1?.voyageId !== b3?.voyageId
})())
check('归属指向真实航次', belts.every((b) => voyages.some((v) => v.id === b.voyageId)))

// 3) ensureVoyageAttribution：导入旧备份后的补归属同一口径
const { ensureVoyageAttribution } = await import('@/utils/db')
await db.belts.put({ id: 'b9', siteId: 's1', voyageId: '', no: 'T-09', lengthM: 20, orientation: '西', surveyDate: '2026-10-02', observer: '丙', createdAt: 1, updatedAt: 1 })
const assigned = await ensureVoyageAttribution()
const b9 = await db.belts.get('b9')
const voyage1002 = await db.voyages.where('voyageNo').equals('LEG-2026-10-02').first()
check('补归属处理 1 条孤儿样带', assigned === 1)
check('孤儿样带并入同日期既有批次', b9?.voyageId === voyage1002?.id)

await db.close()
Dexie.delete('gbcoralbelt')

if (failures > 0) {
  console.error(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
