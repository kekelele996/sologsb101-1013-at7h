/**
 * 备份导入导出：整库 JSON 快照的组装、校验、下载与导入；
 * 以及按礁区/站位汇总的覆盖度结论生成。
 * 结论口径与 utils/scope.ts 一致：只统计院所审定批次内未被驳回的样带，
 * 复制结论与结论 JSON 导出都走 buildCoverageLines，保证同一个口径。
 */
import {
  db,
  DB_NAME,
  DB_VERSION,
  createId,
  clearAllTables,
  ensureVoyageAttribution,
  stampBackupTime,
  type BackupPayload
} from '@/utils/db'
import {
  BLEACH_LEVELS,
  type BleachLevel
} from '@/types/coralRecord'
import { resolveReviewScope } from '@/utils/scope'
import { bleachGrade, bleachIndex, bleachedSharePct, coralCoveragePct, fishDensity, round } from '@/utils/bleach'

/** 备份集合键名 */
export const BACKUP_KEYS = ['reefs', 'sites', 'belts', 'corals', 'fishes', 'voyages', 'reviews', 'rejectEntries'] as const
export type BackupKey = (typeof BACKUP_KEYS)[number]

export type CountMap = Record<BackupKey, number>

/** 组装当前本地数据的完整快照 */
export async function buildBackupPayload(): Promise<BackupPayload> {
  const [reefs, sites, belts, corals, fishes, voyages, reviews, rejectEntries] = await Promise.all([
    db.reefs.toArray(),
    db.sites.toArray(),
    db.belts.toArray(),
    db.corals.toArray(),
    db.fishes.toArray(),
    db.voyages.toArray(),
    db.reviews.toArray(),
    db.rejectEntries.toArray()
  ])
  return {
    app: 'gbcoralbelt',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    reefs,
    sites,
    belts,
    corals,
    fishes,
    voyages,
    reviews,
    rejectEntries
  }
}

/** 校验外部 JSON 是否为本站可识别的备份文件（v2 旧备份缺审核侧三表，按空表兼容） */
export function validateBackup(input: unknown): { ok: boolean; errors: string[]; payload: BackupPayload | null } {
  const errors: string[] = []
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['文件内容不是合法的 JSON 对象'], payload: null }
  }
  const obj = input as Partial<BackupPayload>
  if (obj.app !== undefined && obj.app !== 'gbcoralbelt') {
    errors.push('app 字段应为 gbcoralbelt，文件来源不明')
  }
  const requiredKeys: BackupKey[] = ['reefs', 'sites', 'belts', 'corals', 'fishes']
  for (const key of requiredKeys) {
    if (!Array.isArray(obj[key])) errors.push(`${key} 字段缺失或不是数组`)
  }
  if (errors.length > 0) return { ok: false, errors, payload: null }
  const payload: BackupPayload = {
    app: 'gbcoralbelt',
    dbVersion: typeof obj.dbVersion === 'number' ? obj.dbVersion : DB_VERSION,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
    reefs: obj.reefs ?? [],
    sites: obj.sites ?? [],
    belts: obj.belts ?? [],
    corals: obj.corals ?? [],
    fishes: obj.fishes ?? [],
    voyages: Array.isArray(obj.voyages) ? obj.voyages : [],
    reviews: Array.isArray(obj.reviews) ? obj.reviews : [],
    rejectEntries: Array.isArray(obj.rejectEntries) ? obj.rejectEntries : []
  }
  return { ok: true, errors, payload }
}

/** 统计快照各表行数 */
export function countPayload(payload: BackupPayload): CountMap {
  return {
    reefs: payload.reefs.length,
    sites: payload.sites.length,
    belts: payload.belts.length,
    corals: payload.corals.length,
    fishes: payload.fishes.length,
    voyages: payload.voyages.length,
    reviews: payload.reviews.length,
    rejectEntries: payload.rejectEntries.length
  }
}

/** 导出 JSON 文件到浏览器下载目录 */
export async function exportBackupJson(): Promise<{ fileName: string; counts: CountMap }> {
  const payload = await buildBackupPayload()
  const fileName = `${DB_NAME}-backup-v${payload.dbVersion}-${payload.exportedAt
    .slice(0, 19)
    .replace(/[:T]/g, '')}.json`
  downloadJson(payload, fileName)
  stampBackupTime(payload.exportedAt)
  return { fileName, counts: countPayload(payload) }
}

function downloadJson(data: unknown, fileName: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

/** 读取用户选择的备份文件文本 */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsText(file, 'utf-8')
  })
}

/**
 * 导入快照：overwrite=true 先清空全部表，否则按主键合并。
 * 导入完成后统一补航次归属：旧版备份的样带没有航次，按调查日期归入 LEG-<日期> 批次。
 */
export async function importBackup(payload: BackupPayload, overwrite: boolean): Promise<CountMap> {
  if (overwrite) await clearAllTables()
  await db.transaction(
    'rw',
    [db.reefs, db.sites, db.belts, db.corals, db.fishes, db.voyages, db.reviews, db.rejectEntries],
    async () => {
      await db.reefs.bulkPut(payload.reefs)
      await db.sites.bulkPut(payload.sites)
      await db.voyages.bulkPut(payload.voyages)
      await db.belts.bulkPut(payload.belts)
      await db.corals.bulkPut(payload.corals)
      await db.fishes.bulkPut(payload.fishes)
      await db.reviews.bulkPut(payload.reviews)
      await db.rejectEntries.bulkPut(payload.rejectEntries)
    }
  )
  await ensureVoyageAttribution()
  return countPayload(payload)
}

/** 追加式导入：为导入数据重新分配 id，避免覆盖现有档案 */
export function remapIds(payload: BackupPayload): BackupPayload {
  const reefMap = new Map<string, string>()
  const siteMap = new Map<string, string>()
  const beltMap = new Map<string, string>()
  const voyageMap = new Map<string, string>()
  const reviewMap = new Map<string, string>()

  const reefs = payload.reefs.map((reef) => {
    const id = createId('reef')
    reefMap.set(reef.id, id)
    return { ...reef, id }
  })
  const sites = payload.sites.map((site) => {
    const id = createId('site')
    siteMap.set(site.id, id)
    return { ...site, id, reefId: reefMap.get(site.reefId) ?? site.reefId }
  })
  const voyages = payload.voyages.map((voyage) => {
    const id = createId('voy')
    voyageMap.set(voyage.id, id)
    return { ...voyage, id }
  })
  const belts = payload.belts.map((belt) => {
    const id = createId('belt')
    beltMap.set(belt.id, id)
    return {
      ...belt,
      id,
      siteId: siteMap.get(belt.siteId) ?? belt.siteId,
      voyageId: voyageMap.get(belt.voyageId) ?? belt.voyageId ?? ''
    }
  })
  const corals = payload.corals.map((coral) => ({
    ...coral,
    id: createId('cor'),
    beltId: beltMap.get(coral.beltId) ?? coral.beltId
  }))
  const fishes = payload.fishes.map((fish) => ({
    ...fish,
    id: createId('fsh'),
    beltId: beltMap.get(fish.beltId) ?? fish.beltId
  }))
  const reviews = payload.reviews.map((review) => {
    const id = createId('rev')
    reviewMap.set(review.id, id)
    return { ...review, id, voyageId: voyageMap.get(review.voyageId) ?? review.voyageId }
  })
  const rejectEntries = payload.rejectEntries.map((entry) => ({
    ...entry,
    id: createId('rej'),
    reviewId: reviewMap.get(entry.reviewId) ?? entry.reviewId,
    voyageId: voyageMap.get(entry.voyageId) ?? entry.voyageId,
    beltId: beltMap.get(entry.beltId) ?? entry.beltId
  }))
  return { ...payload, reefs, sites, belts, corals, fishes, voyages, reviews, rejectEntries }
}

/** 白化等级分布：各等级累计覆盖长度 */
export type BleachDistribution = Record<BleachLevel, number>

/** 覆盖度结论行：按样带汇总珊瑚覆盖率、白化占比与鱼类密度 */
export interface CoverageLine {
  beltId: string
  beltNo: string
  reefId: string
  reefName: string
  siteId: string
  siteNo: string
  voyageId: string
  voyageNo: string
  lengthM: number
  orientation: string
  surveyDate: string
  observer: string
  coralCount: number
  coverCmTotal: number
  /** 珊瑚覆盖率（%） */
  coveragePct: number
  /** 白化指数 0 ~ 4 */
  bleachIndex: number
  /** 总体白化等级 */
  grade: BleachLevel
  /** 白化占比（%，覆盖长度加权） */
  bleachedSharePct: number
  distribution: BleachDistribution
  fishTotal: number
  invertebrateTotal: number
  /** 鱼类密度（尾 / 100 m²） */
  fishDensity: number
  conclusion: string
}

/**
 * 按样带生成覆盖度结论行。
 * 口径与 /coverage 页一致：只含院所审定批次内未被驳回、批次对账未挂起的样带。
 */
export function buildCoverageLines(payload: BackupPayload): CoverageLine[] {
  const scope = resolveReviewScope({
    belts: payload.belts,
    voyages: payload.voyages,
    reviews: payload.reviews,
    rejectEntries: payload.rejectEntries
  })
  const reefById = new Map(payload.reefs.map((reef) => [reef.id, reef]))
  const siteById = new Map(payload.sites.map((site) => [site.id, site]))
  const voyageById = new Map(payload.voyages.map((voyage) => [voyage.id, voyage]))
  const coralsByBelt = new Map<string, typeof payload.corals>()
  payload.corals.forEach((coral) => {
    const list = coralsByBelt.get(coral.beltId) ?? []
    list.push(coral)
    coralsByBelt.set(coral.beltId, list)
  })
  const fishesByBelt = new Map<string, typeof payload.fishes>()
  payload.fishes.forEach((fish) => {
    const list = fishesByBelt.get(fish.beltId) ?? []
    list.push(fish)
    fishesByBelt.set(fish.beltId, list)
  })

  return payload.belts
    .filter((belt) => scope.approvedBeltIds.has(belt.id))
    .map((belt) => {
      const site = siteById.get(belt.siteId)
      const reef = site ? reefById.get(site.reefId) : undefined
      const voyage = voyageById.get(belt.voyageId)
      const corals = coralsByBelt.get(belt.id) ?? []
      const fishes = fishesByBelt.get(belt.id) ?? []
      const coverCmTotal = round(
        corals.reduce((sum, coral) => sum + coral.coverCm, 0),
        1
      )
      const index = bleachIndex(corals)
      const grade = bleachGrade(index)
      const distribution: BleachDistribution = { 无: 0, 轻: 0, 中: 0, 重: 0, 死亡: 0 }
      BLEACH_LEVELS.forEach((level) => {
        distribution[level] = round(
          corals.filter((coral) => coral.bleachLevel === level).reduce((sum, coral) => sum + coral.coverCm, 0),
          1
        )
      })
      const fishTotal = fishes.filter((fish) => fish.category === '鱼类').reduce((sum, fish) => sum + fish.count, 0)
      const invertebrateTotal = fishes
        .filter((fish) => fish.category === '无脊椎动物')
        .reduce((sum, fish) => sum + fish.count, 0)
      return {
        beltId: belt.id,
        beltNo: belt.no,
        reefId: reef?.id ?? '',
        reefName: reef?.name ?? '未知礁区',
        siteId: site?.id ?? '',
        siteNo: site?.no ?? '—',
        voyageId: voyage?.id ?? '',
        voyageNo: voyage?.voyageNo ?? '—',
        lengthM: belt.lengthM,
        orientation: belt.orientation,
        surveyDate: belt.surveyDate,
        observer: belt.observer,
        coralCount: corals.length,
        coverCmTotal,
        coveragePct: coralCoveragePct(coverCmTotal, belt.lengthM),
        bleachIndex: index,
        grade,
        bleachedSharePct: bleachedSharePct(corals),
        distribution,
        fishTotal,
        invertebrateTotal,
        fishDensity: fishDensity(fishTotal, belt.lengthM),
        conclusion:
          corals.length === 0
            ? '该样带尚未录入珊瑚记录'
            : grade === '无'
              ? `珊瑚覆盖率 ${coralCoveragePct(coverCmTotal, belt.lengthM)}%，未见白化`
              : `珊瑚覆盖率 ${coralCoveragePct(coverCmTotal, belt.lengthM)}%，白化指数 ${index}（${grade}），白化占比 ${bleachedSharePct(corals)}%`
      }
    })
    .sort((a, b) => b.bleachIndex - a.bleachIndex)
}

/** 按礁区汇总：站位/样带数量、平均白化指数与总体等级（基于审定口径的样带结论行） */
export interface ReefSummary {
  reefId: string
  reefName: string
  protectStatus: string
  siteCount: number
  beltCount: number
  coralCount: number
  coverCmTotal: number
  avgBleachIndex: number
  grade: BleachLevel
  fishTotal: number
}

export function buildReefSummaries(payload: BackupPayload, lines: CoverageLine[]): ReefSummary[] {
  const approvedBeltIds = new Set(lines.map((line) => line.beltId))
  return payload.reefs.map((reef) => {
    const siteIds = new Set(payload.sites.filter((site) => site.reefId === reef.id).map((site) => site.id))
    const beltIds = new Set(
      payload.belts.filter((belt) => siteIds.has(belt.siteId) && approvedBeltIds.has(belt.id)).map((belt) => belt.id)
    )
    const corals = payload.corals.filter((coral) => beltIds.has(coral.beltId))
    const lines4Reef = lines.filter((line) => line.reefId === reef.id)
    const avgBleachIndex =
      lines4Reef.length === 0
        ? 0
        : round(lines4Reef.reduce((sum, line) => sum + line.bleachIndex, 0) / lines4Reef.length, 2)
    return {
      reefId: reef.id,
      reefName: reef.name,
      protectStatus: reef.protectStatus,
      siteCount: siteIds.size,
      beltCount: beltIds.size,
      coralCount: corals.length,
      coverCmTotal: round(
        corals.reduce((sum, coral) => sum + coral.coverCm, 0),
        1
      ),
      avgBleachIndex,
      grade: bleachGrade(avgBleachIndex),
      fishTotal: payload.fishes
        .filter((fish) => beltIds.has(fish.beltId))
        .reduce((sum, fish) => sum + fish.count, 0)
    }
  })
}

/** 结论导出文件结构：只含审定口径的样带结论与礁区汇总 */
export interface ConclusionPayload {
  app: 'gbcoralbelt'
  kind: 'coverage-conclusion'
  dbVersion: number
  exportedAt: string
  scopeNote: string
  lines: CoverageLine[]
  reefSummaries: ReefSummary[]
}

/**
 * 导出覆盖度结论 JSON：与 /coverage 页、复制结论同一口径（审定批次）。
 */
export async function exportConclusionJson(): Promise<{ fileName: string; lineCount: number }> {
  const payload = await buildBackupPayload()
  const lines = buildCoverageLines(payload)
  const conclusion: ConclusionPayload = {
    app: 'gbcoralbelt',
    kind: 'coverage-conclusion',
    dbVersion: payload.dbVersion,
    exportedAt: new Date().toISOString(),
    scopeNote: '只统计院所审定批次内未被驳回、对账未挂起的样带',
    lines,
    reefSummaries: buildReefSummaries(payload, lines)
  }
  const fileName = `${DB_NAME}-conclusion-v${payload.dbVersion}-${conclusion.exportedAt
    .slice(0, 19)
    .replace(/[:T]/g, '')}.json`
  downloadJson(conclusion, fileName)
  return { fileName, lineCount: lines.length }
}
