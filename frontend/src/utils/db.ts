/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 库名 gbcoralbelt，含数据结构版本号与升级迁移逻辑
 * - 升级时按 version().stores() 补齐索引
 * - v3 起数据分两侧：普查队侧（航次/样带/珊瑚/鱼类）与院所审核侧（审核单/驳回条目）
 * - 历史数据没记航次：升级时按调查日期分组补归属（LEG-<日期> 批次，待院所受理）
 * - 首次打开自动播种互相引用的演示数据（礁区 → 站位 → 航次 → 样带 → 珊瑚记录/鱼类计数 → 审核单/驳回条目）
 * - 纯前端应用：不依赖任何后端服务或数据库服务
 */
import Dexie, { liveQuery, type Table } from 'dexie'
import type { Reef } from '@/types/reef'
import type { Site } from '@/types/site'
import type { Belt } from '@/types/belt'
import type { CoralRecord } from '@/types/coralRecord'
import type { FishCount } from '@/types/fishCount'
import type { Voyage } from '@/types/voyage'
import type { RejectEntry, ReviewOrder } from '@/types/review'

/** 当前数据结构版本号：每次调整字段结构必须 +1 并补迁移 */
export const DB_VERSION = 3

/** 数据库名（浏览器 IndexedDB 中的库名） */
export const DB_NAME = 'gbcoralbelt'

/** localStorage 侧少量元数据键名 */
export const LS_KEYS = {
  dbVersion: 'gbcoralbelt:db-version',
  lastBackupAt: 'gbcoralbelt:last-backup-at',
  lastReefId: 'gbcoralbelt:last-reef-id'
} as const

/** 备份文件结构，供 utils/export.ts 与覆盖度汇总页使用 */
export interface BackupPayload {
  app: 'gbcoralbelt'
  dbVersion: number
  exportedAt: string
  reefs: Reef[]
  sites: Site[]
  belts: Belt[]
  corals: CoralRecord[]
  fishes: FishCount[]
  voyages: Voyage[]
  reviews: ReviewOrder[]
  rejectEntries: RejectEntry[]
}

export class CoralBeltDatabase extends Dexie {
  reefs!: Table<Reef, string>
  sites!: Table<Site, string>
  belts!: Table<Belt, string>
  corals!: Table<CoralRecord, string>
  fishes!: Table<FishCount, string>
  voyages!: Table<Voyage, string>
  reviews!: Table<ReviewOrder, string>
  rejectEntries!: Table<RejectEntry, string>

  constructor() {
    super(DB_NAME)

    // v1：初版结构（保留历史数据，仅基础索引）
    this.version(1).stores({
      reefs: 'id, name, protectStatus',
      sites: 'id, reefId, no',
      belts: 'id, siteId, no, surveyDate',
      corals: 'id, beltId, genus, form',
      fishes: 'id, beltId, family, sizeClass'
    })

    // v2：补齐筛选与统计需要的索引（位置/面积、经纬度/水深、样带长度与朝向、白化等级、类别）
    this.version(2)
      .stores({
        reefs: 'id, name, location, protectStatus, areaKm2, manager, updatedAt',
        sites: 'id, reefId, no, lat, lng, depthM, substrate, updatedAt',
        belts: 'id, siteId, no, lengthM, orientation, surveyDate, observer, updatedAt',
        corals: 'id, beltId, genus, form, coverCm, bleachLevel, updatedAt',
        fishes: 'id, beltId, family, count, sizeClass, category, updatedAt'
      })
      .upgrade(async (tx) => {
        // 迁移：历史数据补齐时间戳与必填字段，避免列表排序与筛选拿到 undefined
        const defaults: Array<[string, () => Record<string, unknown>]> = [
          ['reefs', () => ({ manager: '', areaKm2: 0 })],
          ['sites', () => ({ lat: 0, lng: 0, depthM: 5, substrate: '珊瑚礁石' })],
          ['belts', () => ({ lengthM: 50, orientation: '北', observer: '' })],
          ['corals', () => ({ coverCm: 0, bleachLevel: '无', remark: '' })],
          ['fishes', () => ({ count: 0, sizeClass: '11-20cm', category: '鱼类' })]
        ]
        for (const [tableName, factory] of defaults) {
          await tx
            .table(tableName)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              const now = Date.now()
              if (typeof row.createdAt !== 'number') row.createdAt = now
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt
              Object.assign(row, factory())
            })
        }
      })

    // v3：普查队 / 院所审核两侧拆分
    // - 新增 voyages（航次批次）、reviews（审核单，一航次一单）、rejectEntries（驳回条目）
    // - belts 增加 voyageId 归属索引；历史数据按调查日期分组补归属（LEG-<日期> 批次，待受理）
    this.version(DB_VERSION)
      .stores({
        reefs: 'id, name, location, protectStatus, areaKm2, manager, updatedAt',
        sites: 'id, reefId, no, lat, lng, depthM, substrate, updatedAt',
        belts: 'id, siteId, voyageId, no, lengthM, orientation, surveyDate, observer, updatedAt',
        corals: 'id, beltId, genus, form, coverCm, bleachLevel, updatedAt',
        fishes: 'id, beltId, family, count, sizeClass, category, updatedAt',
        voyages: 'id, &voyageNo, status, startDate, updatedAt',
        reviews: 'id, &voyageId, voyageNo, status, updatedAt',
        rejectEntries: 'id, reviewId, voyageId, beltId, status, updatedAt'
      })
      .upgrade(async (tx) => {
        // 迁移：已有数据没记航次，按调查日期补上归属
        const belts = (await tx.table('belts').toArray()) as Array<Record<string, unknown>>
        const byDate = new Map<string, Array<Record<string, unknown>>>()
        belts.forEach((belt) => {
          if (typeof belt.voyageId === 'string' && belt.voyageId.length > 0) return
          const date =
            typeof belt.surveyDate === 'string' && belt.surveyDate.length > 0 ? belt.surveyDate : '未知日期'
          const list = byDate.get(date) ?? []
          list.push(belt)
          byDate.set(date, list)
        })
        let offset = 0
        for (const [date, rows] of Array.from(byDate.entries()).sort(([a], [b]) => a.localeCompare(b))) {
          const now = Date.now() + offset
          const voyage: Voyage = {
            id: createId('voy'),
            voyageNo: `LEG-${date}`,
            title: `历史批次 ${date}（升级补录）`,
            team: '普查队',
            startDate: date === '未知日期' ? '' : date,
            endDate: date === '未知日期' ? '' : date,
            status: 'submitted',
            note: '结构升级时按调查日期补归属，待院所受理审核',
            createdAt: now,
            updatedAt: now
          }
          await tx.table('voyages').put(voyage)
          for (const row of rows) {
            await tx.table('belts').update(String(row.id), { voyageId: voyage.id })
          }
          offset += 1
        }
      })
  }
}

export const db = new CoralBeltDatabase()

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/** 订阅单表变化（liveQuery），返回取消订阅函数 */
export function watchTable<T>(table: () => Table<T, string>): { subscribe: (cb: (rows: T[]) => void) => () => void } {
  return {
    subscribe(cb: (rows: T[]) => void): () => void {
      const observable = liveQuery(async () => table().toArray())
      const subscription = observable.subscribe({
        next: (rows: T[]) => cb(rows),
        error: () => cb([])
      })
      return () => subscription.unsubscribe()
    }
  }
}

/* ------------------------------ 演示数据播种 ------------------------------ */

interface SeedCoral {
  id: string
  beltId: string
  genus: string
  form: CoralRecord['form']
  coverCm: number
  bleachLevel: CoralRecord['bleachLevel']
  remark: string
}

interface SeedFish {
  id: string
  beltId: string
  family: string
  count: number
  sizeClass: FishCount['sizeClass']
  category: FishCount['category']
}

interface SeedBelt {
  id: string
  siteId: string
  voyageId: string
  no: string
  lengthM: number
  orientation: Belt['orientation']
  surveyDate: string
  observer: string
  corals: SeedCoral[]
  fishes: SeedFish[]
}

/**
 * 播种演示数据：3 个礁区 → 4 个站位 → 2 个航次 → 5 条样带 → 14 条珊瑚记录 + 12 条计数记录，
 * 另含 1 张已签发审核单（部分通过）与 1 条驳回条目，覆盖无 / 轻 / 中 / 重 / 死亡 全部白化等级。
 * 航次一（已审定·部分通过）演示「驳回条目级退回」；航次二（已提交待受理）演示院所受理与签发流程。
 */
export async function seedDemoData(): Promise<void> {
  const now = Date.now()
  const today = new Date(now).toISOString().slice(0, 10)
  const yesterday = new Date(now - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const compact = (iso: string): string => iso.replace(/-/g, '')

  const reefs: Array<Omit<Reef, 'createdAt' | 'updatedAt'>> = [
    {
      id: 'reef_ql01',
      name: '清澜湾珊瑚礁区',
      location: '海南文昌清澜湾东侧 3.5 km 海域',
      areaKm2: 18.6,
      protectStatus: '核心区',
      manager: '清澜湾海洋保护站'
    },
    {
      id: 'reef_yr02',
      name: '永兴岛西侧礁盘',
      location: '西沙永兴岛西侧礁盘外缘',
      areaKm2: 42.3,
      protectStatus: '缓冲区',
      manager: '西沙海洋环境监测中心'
    },
    {
      id: 'reef_dz03',
      name: '大洲岛南岸礁区',
      location: '万宁大洲岛南岸潮下带',
      areaKm2: 6.4,
      protectStatus: '实验区',
      manager: '大洲岛国家级自然保护区管理处'
    }
  ]

  const sites: Array<Omit<Site, 'createdAt' | 'updatedAt'>> = [
    {
      id: 'site_ql_01',
      reefId: 'reef_ql01',
      no: 'S-01',
      lat: 19.5621,
      lng: 110.7924,
      depthM: 4.2,
      substrate: '珊瑚礁石'
    },
    {
      id: 'site_ql_02',
      reefId: 'reef_ql01',
      no: 'S-02',
      lat: 19.5487,
      lng: 110.8103,
      depthM: 8.6,
      substrate: '礁砂'
    },
    {
      id: 'site_yr_01',
      reefId: 'reef_yr02',
      no: 'S-01',
      lat: 16.8342,
      lng: 112.3286,
      depthM: 12.4,
      substrate: '砾石'
    },
    {
      id: 'site_dz_01',
      reefId: 'reef_dz03',
      no: 'S-01',
      lat: 18.6712,
      lng: 110.4913,
      depthM: 6.8,
      substrate: '岩礁'
    }
  ]

  const voyages: Array<Omit<Voyage, 'createdAt' | 'updatedAt'>> = [
    {
      id: 'voy_seed_1',
      voyageNo: `VY-${compact(today)}-01`,
      title: '清澜湾近岸普查航次',
      team: '院属普查一队',
      startDate: today,
      endDate: today,
      status: 'partial',
      note: ''
    },
    {
      id: 'voy_seed_2',
      voyageNo: `VY-${compact(yesterday)}-01`,
      title: '永兴—大洲联合航次',
      team: '院属普查二队',
      startDate: yesterday,
      endDate: today,
      status: 'submitted',
      note: ''
    }
  ]

  const belts: SeedBelt[] = [
    {
      id: 'belt_ql01_a',
      siteId: 'site_ql_01',
      voyageId: 'voy_seed_1',
      no: 'T-01',
      lengthM: 50,
      orientation: '北',
      surveyDate: today,
      observer: '林之遥',
      corals: [
        { id: 'cor_ql01a_1', beltId: 'belt_ql01_a', genus: '鹿角珊瑚属', form: '枝状', coverCm: 860, bleachLevel: '无', remark: '长势良好' },
        { id: 'cor_ql01a_2', beltId: 'belt_ql01_a', genus: '杯形珊瑚属', form: '枝状', coverCm: 540, bleachLevel: '轻', remark: '局部褪色' },
        { id: 'cor_ql01a_3', beltId: 'belt_ql01_a', genus: '滨珊瑚属', form: '块状', coverCm: 1120, bleachLevel: '无', remark: '' },
        { id: 'cor_ql01a_4', beltId: 'belt_ql01_a', genus: '软珊瑚属', form: '软珊瑚', coverCm: 380, bleachLevel: '轻', remark: '' }
      ],
      fishes: [
        { id: 'fsh_ql01a_1', beltId: 'belt_ql01_a', family: '雀鲷科', count: 46, sizeClass: '0-10cm', category: '鱼类' },
        { id: 'fsh_ql01a_2', beltId: 'belt_ql01_a', family: '蝴蝶鱼科', count: 18, sizeClass: '11-20cm', category: '鱼类' },
        { id: 'fsh_ql01a_3', beltId: 'belt_ql01_a', family: '鹦嘴鱼科', count: 7, sizeClass: '21-30cm', category: '鱼类' },
        { id: 'fsh_ql01a_4', beltId: 'belt_ql01_a', family: '海胆科', count: 12, sizeClass: '0-10cm', category: '无脊椎动物' }
      ]
    },
    {
      id: 'belt_ql01_b',
      siteId: 'site_ql_01',
      voyageId: 'voy_seed_1',
      no: 'T-02',
      lengthM: 50,
      orientation: '东',
      surveyDate: today,
      observer: '林之遥',
      corals: [
        { id: 'cor_ql01b_1', beltId: 'belt_ql01_b', genus: '蔷薇珊瑚属', form: '叶状', coverCm: 720, bleachLevel: '中', remark: '边缘白化明显' },
        { id: 'cor_ql01b_2', beltId: 'belt_ql01_b', genus: '蜂巢珊瑚属', form: '块状', coverCm: 980, bleachLevel: '轻', remark: '' },
        { id: 'cor_ql01b_3', beltId: 'belt_ql01_b', genus: '鹿角珊瑚属', form: '枝状', coverCm: 430, bleachLevel: '重', remark: '大面积白化，部分死亡' }
      ],
      fishes: [
        { id: 'fsh_ql01b_1', beltId: 'belt_ql01_b', family: '隆头鱼科', count: 22, sizeClass: '11-20cm', category: '鱼类' },
        { id: 'fsh_ql01b_2', beltId: 'belt_ql01_b', family: '刺尾鱼科', count: 15, sizeClass: '21-30cm', category: '鱼类' },
        { id: 'fsh_ql01b_3', beltId: 'belt_ql01_b', family: '砗磲科', count: 3, sizeClass: '>30cm', category: '无脊椎动物' }
      ]
    },
    {
      id: 'belt_ql02_a',
      siteId: 'site_ql_02',
      voyageId: 'voy_seed_1',
      no: 'T-01',
      lengthM: 30,
      orientation: '南',
      surveyDate: today,
      observer: '周渝',
      corals: [
        { id: 'cor_ql02a_1', beltId: 'belt_ql02_a', genus: '滨珊瑚属', form: '块状', coverCm: 1240, bleachLevel: '无', remark: '' },
        { id: 'cor_ql02a_2', beltId: 'belt_ql02_a', genus: '陀螺珊瑚属', form: '块状', coverCm: 260, bleachLevel: '死亡', remark: '仅存骨骼，附着藻类' }
      ],
      fishes: [
        { id: 'fsh_ql02a_1', beltId: 'belt_ql02_a', family: '石斑鱼科', count: 4, sizeClass: '>30cm', category: '鱼类' },
        { id: 'fsh_ql02a_2', beltId: 'belt_ql02_a', family: '海参科', count: 6, sizeClass: '21-30cm', category: '无脊椎动物' }
      ]
    },
    {
      id: 'belt_yr01_a',
      siteId: 'site_yr_01',
      voyageId: 'voy_seed_2',
      no: 'T-01',
      lengthM: 100,
      orientation: '西',
      surveyDate: yesterday,
      observer: '陈立群',
      corals: [
        { id: 'cor_yr01a_1', beltId: 'belt_yr01_a', genus: '星珊瑚属', form: '块状', coverCm: 1580, bleachLevel: '轻', remark: '' },
        { id: 'cor_yr01a_2', beltId: 'belt_yr01_a', genus: '柳珊瑚属', form: '软珊瑚', coverCm: 640, bleachLevel: '中', remark: '水流较强区域' },
        { id: 'cor_yr01a_3', beltId: 'belt_yr01_a', genus: '石芝珊瑚属', form: '叶状', coverCm: 480, bleachLevel: '无', remark: '' }
      ],
      fishes: [
        { id: 'fsh_yr01a_1', beltId: 'belt_yr01_a', family: '笛鲷科', count: 28, sizeClass: '21-30cm', category: '鱼类' },
        { id: 'fsh_yr01a_2', beltId: 'belt_yr01_a', family: '篮子鱼科', count: 11, sizeClass: '11-20cm', category: '鱼类' },
        { id: 'fsh_yr01a_3', beltId: 'belt_yr01_a', family: '法螺科', count: 2, sizeClass: '>30cm', category: '无脊椎动物' }
      ]
    },
    {
      id: 'belt_dz01_a',
      siteId: 'site_dz_01',
      voyageId: 'voy_seed_2',
      no: 'T-01',
      lengthM: 25,
      orientation: '东',
      surveyDate: yesterday,
      observer: '陈立群',
      corals: [
        { id: 'cor_dz01a_1', beltId: 'belt_dz01_a', genus: '杯形珊瑚属', form: '枝状', coverCm: 520, bleachLevel: '重', remark: '受台风扰动后白化' },
        { id: 'cor_dz01a_2', beltId: 'belt_dz01_a', genus: '蜂巢珊瑚属', form: '块状', coverCm: 310, bleachLevel: '中', remark: '' }
      ],
      fishes: [
        { id: 'fsh_dz01a_1', beltId: 'belt_dz01_a', family: '雀鲷科', count: 34, sizeClass: '0-10cm', category: '鱼类' },
        { id: 'fsh_dz01a_2', beltId: 'belt_dz01_a', family: '海星科', count: 5, sizeClass: '11-20cm', category: '无脊椎动物' }
      ]
    }
  ]

  const reviews: Array<Omit<ReviewOrder, 'createdAt' | 'updatedAt'>> = [
    {
      id: 'rev_seed_1',
      voyageId: 'voy_seed_1',
      voyageNo: voyages[0].voyageNo,
      beltNos: ['T-01', 'T-01', 'T-02'],
      status: 'partial',
      reviewer: '顾审言',
      comment: 'T-02 白化数据与现场照片不符，条目级退回；其余样带通过',
      submittedAt: now - 2 * 60 * 60 * 1000,
      signedAt: now - 60 * 60 * 1000
    }
  ]

  const rejectEntries: Array<Omit<RejectEntry, 'createdAt' | 'updatedAt'>> = [
    {
      id: 'rej_seed_1',
      reviewId: 'rev_seed_1',
      voyageId: 'voy_seed_1',
      beltId: 'belt_ql01_b',
      beltNo: 'T-02',
      reason: '白化等级与现场照片记录不符，退回普查队复核',
      status: 'open'
    }
  ]

  await db.transaction(
    'rw',
    [db.reefs, db.sites, db.belts, db.corals, db.fishes, db.voyages, db.reviews, db.rejectEntries],
    async () => {
      const stamp = (offset: number): { createdAt: number; updatedAt: number } => ({
        createdAt: now + offset,
        updatedAt: now + offset
      })

      await db.reefs.bulkPut(reefs.map((reef, index) => ({ ...reef, ...stamp(index) })))
      await db.sites.bulkPut(sites.map((site, index) => ({ ...site, ...stamp(100 + index) })))
      await db.voyages.bulkPut(voyages.map((voyage, index) => ({ ...voyage, ...stamp(150 + index) })))
      await db.belts.bulkPut(
        belts.map((belt, index) => {
          const { corals, fishes, ...rest } = belt
          void corals
          void fishes
          return { ...rest, ...stamp(200 + index) }
        })
      )
      await db.corals.bulkPut(
        belts.flatMap((belt, beltIndex) =>
          belt.corals.map((coral, coralIndex) => ({ ...coral, ...stamp(300 + beltIndex * 100 + coralIndex) }))
        )
      )
      await db.fishes.bulkPut(
        belts.flatMap((belt, beltIndex) =>
          belt.fishes.map((fish, fishIndex) => ({ ...fish, ...stamp(400 + beltIndex * 100 + fishIndex) }))
        )
      )
      await db.reviews.bulkPut(reviews.map((review, index) => ({ ...review, ...stamp(500 + index) })))
      await db.rejectEntries.bulkPut(rejectEntries.map((entry, index) => ({ ...entry, ...stamp(600 + index) })))
    }
  )
}

/** 打开数据库并幂等播种：仅当礁区表为空时灌入演示数据 */
export async function initDatabase(): Promise<void> {
  await db.open()
  const count = await db.reefs.count()
  if (count === 0) {
    await seedDemoData()
  }
  stampDbVersion()
}

/** 清空全部业务表（导入覆盖与重置共用） */
export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [db.reefs, db.sites, db.belts, db.corals, db.fishes, db.voyages, db.reviews, db.rejectEntries],
    async () => {
      await Promise.all([
        db.reefs.clear(),
        db.sites.clear(),
        db.belts.clear(),
        db.corals.clear(),
        db.fishes.clear(),
        db.voyages.clear(),
        db.reviews.clear(),
        db.rejectEntries.clear()
      ])
    }
  )
}

/** 清空并重新播种演示数据 */
export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDemoData()
}

/**
 * 补归属：为缺失航次归属（或归属已失效）的样带按调查日期建批次。
 * 导入旧版备份（无航次概念）后调用，与 v3 升级迁移同一口径：LEG-<调查日期>，待院所受理。
 */
export async function ensureVoyageAttribution(): Promise<number> {
  return db.transaction('rw', [db.belts, db.voyages], async () => {
    const voyages = await db.voyages.toArray()
    const validIds = new Set(voyages.map((voyage) => voyage.id))
    const orphans = await db.belts
      .filter((belt) => !belt.voyageId || !validIds.has(belt.voyageId))
      .toArray()
    if (orphans.length === 0) return 0
    const byDate = new Map<string, typeof orphans>()
    orphans.forEach((belt) => {
      const date = belt.surveyDate && belt.surveyDate.length > 0 ? belt.surveyDate : '未知日期'
      const list = byDate.get(date) ?? []
      list.push(belt)
      byDate.set(date, list)
    })
    const byNo = new Map(voyages.map((voyage) => [voyage.voyageNo, voyage]))
    let assigned = 0
    for (const [date, rows] of byDate) {
      const voyageNo = `LEG-${date}`
      let voyage = byNo.get(voyageNo)
      if (!voyage) {
        const now = Date.now()
        voyage = {
          id: createId('voy'),
          voyageNo,
          title: `历史批次 ${date}（导入补录）`,
          team: '普查队',
          startDate: date === '未知日期' ? '' : date,
          endDate: date === '未知日期' ? '' : date,
          status: 'submitted',
          note: '导入旧版备份后按调查日期补归属，待院所受理审核',
          createdAt: now,
          updatedAt: now
        }
        await db.voyages.put(voyage)
        byNo.set(voyageNo, voyage)
      }
      await Promise.all(rows.map((belt) => db.belts.update(belt.id, { voyageId: voyage.id })))
      assigned += rows.length
    }
    return assigned
  })
}

/** 统计各表行数，供页脚概览与覆盖度页展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [reefs, sites, belts, corals, fishes, voyages, reviews, rejectEntries] = await Promise.all([
    db.reefs.count(),
    db.sites.count(),
    db.belts.count(),
    db.corals.count(),
    db.fishes.count(),
    db.voyages.count(),
    db.reviews.count(),
    db.rejectEntries.count()
  ])
  return { reefs, sites, belts, corals, fishes, voyages, reviews, rejectEntries }
}

/** 写入结构版本号到 localStorage，便于覆盖度页比对 */
export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
  } catch {
    // 隐私模式下 localStorage 不可用，忽略即可
  }
}

export function readStampedDbVersion(): number {
  try {
    const raw = localStorage.getItem(LS_KEYS.dbVersion)
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION
  } catch {
    return DB_VERSION
  }
}

export function stampBackupTime(iso: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, iso)
  } catch {
    // 忽略
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt)
  } catch {
    return null
  }
}

export function readLastReefId(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastReefId)
  } catch {
    return null
  }
}

export function writeLastReefId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(LS_KEYS.lastReefId)
    else localStorage.setItem(LS_KEYS.lastReefId, id)
  } catch {
    // 忽略
  }
}
