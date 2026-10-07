/* 冒烟测试：结论导出口径（buildCoverageLines / buildReefSummaries）—— 临时脚本，验证后可删 */
import { buildCoverageLines, buildReefSummaries } from '@/utils/export'
import type { BackupPayload } from '@/utils/db'

let failures = 0
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  ok  ${name}`)
  else {
    failures += 1
    console.error(`FAIL  ${name}`)
  }
}

const payload: BackupPayload = {
  app: 'gbcoralbelt',
  dbVersion: 3,
  exportedAt: '2026-10-07T00:00:00.000Z',
  reefs: [
    { id: 'r1', name: '礁区一', location: '', areaKm2: 10, protectStatus: '核心区', manager: '', createdAt: 1, updatedAt: 1 }
  ],
  sites: [
    { id: 's1', reefId: 'r1', no: 'S-01', lat: 18, lng: 110, depthM: 5, substrate: '珊瑚礁石', createdAt: 1, updatedAt: 1 }
  ],
  belts: [
    { id: 'b1', siteId: 's1', voyageId: 'v1', no: 'T-01', lengthM: 50, orientation: '北', surveyDate: '2026-10-06', observer: 'a', createdAt: 1, updatedAt: 1 },
    { id: 'b2', siteId: 's1', voyageId: 'v1', no: 'T-02', lengthM: 50, orientation: '东', surveyDate: '2026-10-06', observer: 'a', createdAt: 1, updatedAt: 1 },
    { id: 'b3', siteId: 's1', voyageId: 'v2', no: 'T-01', lengthM: 50, orientation: '南', surveyDate: '2026-10-07', observer: 'b', createdAt: 1, updatedAt: 1 }
  ],
  corals: [
    { id: 'c1', beltId: 'b1', genus: '鹿角珊瑚属', form: '枝状', coverCm: 1000, bleachLevel: '无', remark: '', createdAt: 1, updatedAt: 1 },
    { id: 'c2', beltId: 'b2', genus: '滨珊瑚属', form: '块状', coverCm: 500, bleachLevel: '重', remark: '', createdAt: 1, updatedAt: 1 },
    { id: 'c3', beltId: 'b3', genus: '滨珊瑚属', form: '块状', coverCm: 2500, bleachLevel: '死亡', remark: '', createdAt: 1, updatedAt: 1 }
  ],
  fishes: [
    { id: 'f1', beltId: 'b1', family: '雀鲷科', count: 10, sizeClass: '0-10cm', category: '鱼类', createdAt: 1, updatedAt: 1 },
    { id: 'f2', beltId: 'b3', family: '雀鲷科', count: 99, sizeClass: '0-10cm', category: '鱼类', createdAt: 1, updatedAt: 1 }
  ],
  voyages: [
    { id: 'v1', voyageNo: 'VY-20261006-01', title: '航次一', team: 't', startDate: '2026-10-06', endDate: '2026-10-06', status: 'partial', note: '', createdAt: 1, updatedAt: 1 },
    { id: 'v2', voyageNo: 'VY-20261007-01', title: '航次二', team: 't', startDate: '2026-10-07', endDate: '2026-10-07', status: 'submitted', note: '', createdAt: 1, updatedAt: 1 }
  ],
  reviews: [
    { id: 'rev1', voyageId: 'v1', voyageNo: 'VY-20261006-01', beltNos: ['T-01', 'T-02'], status: 'partial', reviewer: 'r', comment: '', submittedAt: 1, signedAt: 2, createdAt: 1, updatedAt: 1 }
  ],
  rejectEntries: [
    { id: 'rej1', reviewId: 'rev1', voyageId: 'v1', beltId: 'b2', beltNo: 'T-02', reason: '数据存疑', status: 'open', createdAt: 1, updatedAt: 1 }
  ]
}

const lines = buildCoverageLines(payload)
check('只含审定批次未驳回样带（b1）', lines.length === 1 && lines[0].beltId === 'b1')
check('被驳回的 b2 不进导出', !lines.some((line) => line.beltId === 'b2'))
check('未受理航次的 b3 不进导出', !lines.some((line) => line.beltId === 'b3'))
check('结论行带航次号', lines[0]?.voyageNo === 'VY-20261006-01')
check('覆盖率计算正确', lines[0]?.coveragePct === 20)

const summaries = buildReefSummaries(payload, lines)
check('礁区汇总只算计入样带', summaries[0].beltCount === 1 && summaries[0].coralCount === 1)
check('礁区鱼类合计不含未审批次', summaries[0].fishTotal === 10)

if (failures > 0) {
  console.error(`\n${failures} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
