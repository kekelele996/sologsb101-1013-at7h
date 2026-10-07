<script setup lang="ts">
/**
 * 模块 7：/voyages 航次批次（普查队侧）
 * 普查队按航次批次管理下水作业：建航次、归批样带、提交审核。
 * 审核单写失败时只重试审核这侧，已录的样带 / 珊瑚覆盖 / 鱼类计数照旧。
 * 审核单与驳回条目归院所审核组（/reviews），本页只读展示驳回结果。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Plus, Refresh, Ship, Upload } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useReefStore } from '@/stores/reefStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { useVoyageStore } from '@/stores/voyageStore'
import { useReviewStore } from '@/stores/reviewStore'
import { VOYAGE_STATUS_META } from '@/types/voyage'
import type { Voyage, VoyageStatus } from '@/types/voyage'
import { initDatabase } from '@/utils/db'

/** 模板里 el-table 的 row 为 any，经此函数取回类型化的状态展示元数据 */
function voyageMeta(status: VoyageStatus): { label: string; tagType: 'info' | 'primary' | 'warning' | 'success' | 'danger' } {
  return VOYAGE_STATUS_META[status]
}

const router = useRouter()
const reefStore = useReefStore()
const surveyStore = useSurveyStore()
const voyageStore = useVoyageStore()
const reviewStore = useReviewStore()

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const busyVoyageId = ref<string | null>(null)
const form = reactive({
  voyageNo: '',
  title: '',
  team: '',
  startDate: '',
  endDate: '',
  note: ''
})

/** 航次行：批次状态 + 样带数 + 记录数 + 对账与驳回情况 */
const rows = computed(() =>
  voyageStore.sortedVoyages.map((voyage) => {
    const belts = voyageStore.beltsOfVoyage(voyage.id)
    const review = reviewStore.scope.reviewOf(voyage.id)
    const reconcile = reviewStore.scope.reconcileOf(voyage.id)
    const openRejects = reviewStore.scope.openRejectsOfVoyage(voyage.id)
    const recordCounts = belts.reduce(
      (acc, belt) => {
        const counts = surveyStore.beltRecordCounts[belt.id] ?? { coralCount: 0, fishCount: 0 }
        acc.coralCount += counts.coralCount
        acc.fishCount += counts.fishCount
        return acc
      },
      { coralCount: 0, fishCount: 0 }
    )
    return {
      voyage,
      belts,
      review,
      suspended: reconcile !== null && !reconcile.ok,
      reconcileReasons: reconcile?.reasons ?? [],
      openRejects,
      ...recordCounts
    }
  })
)

const stats = computed(() => ({
  voyageCount: voyageStore.voyages.length,
  beltCount: voyageStore.belts.length,
  pendingCount: reviewStore.pendingVoyages.length,
  approvedCount: voyageStore.voyages.filter(
    (voyage) => voyage.status === 'approved' || voyage.status === 'partial'
  ).length,
  suspendedCount: reviewStore.suspendedReviews.length
}))

function siteNoOf(siteId: string): string {
  return reefStore.siteById(siteId)?.no ?? '—'
}

function openCreate(): void {
  editingId.value = null
  voyageStore.resetDraft()
  Object.assign(form, voyageStore.draft)
  dialogVisible.value = true
}

function openEdit(voyage: Voyage): void {
  editingId.value = voyage.id
  form.voyageNo = voyage.voyageNo
  form.title = voyage.title
  form.team = voyage.team
  form.startDate = voyage.startDate
  form.endDate = voyage.endDate
  form.note = voyage.note
  dialogVisible.value = true
}

async function submitForm(): Promise<void> {
  if (!form.voyageNo.trim()) {
    ElMessage.warning('请填写航次号')
    return
  }
  if (!form.title.trim()) {
    ElMessage.warning('请填写航次名称')
    return
  }
  if (!form.startDate || !form.endDate) {
    ElMessage.warning('请选择作业起止日期')
    return
  }
  if (form.endDate < form.startDate) {
    ElMessage.warning('结束日期不应早于开始日期')
    return
  }
  const duplicated = voyageStore.voyages.some(
    (voyage) => voyage.voyageNo === form.voyageNo.trim() && voyage.id !== editingId.value
  )
  if (duplicated) {
    ElMessage.warning(`航次号「${form.voyageNo.trim()}」已存在，两边对账要求航次号唯一`)
    return
  }
  submitting.value = true
  try {
    const payload = {
      voyageNo: form.voyageNo.trim(),
      title: form.title.trim(),
      team: form.team.trim(),
      startDate: form.startDate,
      endDate: form.endDate,
      note: form.note.trim()
    }
    if (editingId.value) {
      await voyageStore.updateVoyage(editingId.value, payload)
      ElMessage.success('航次已更新')
    } else {
      const created = await voyageStore.createVoyage(payload)
      voyageStore.selectVoyage(created.id)
      ElMessage.success(`航次 ${created.voyageNo} 已建立，可在样带布设时归入该批次`)
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

/** 提交审核：审核单写失败时只提示重试，普查队已录数据照旧 */
async function submitVoyage(voyage: Voyage): Promise<void> {
  busyVoyageId.value = voyage.id
  try {
    await voyageStore.submitVoyage(voyage.id)
    ElMessage.success(`航次 ${voyage.voyageNo} 已提交，院所审核单已生成`)
  } catch (err) {
    ElMessage.error(
      `审核单生成失败：${err instanceof Error ? err.message : '未知错误'}。普查队已录数据不受影响，可点「重试受理」只重试审核这侧。`
    )
  } finally {
    busyVoyageId.value = null
  }
}

/** 只重试审核这侧（航次保持已提交，已录数据不动） */
async function retryAcceptance(voyage: Voyage): Promise<void> {
  busyVoyageId.value = voyage.id
  try {
    await voyageStore.retryAcceptance(voyage.id)
    ElMessage.success(`航次 ${voyage.voyageNo} 的审核单已补生成，等待院所审核`)
  } catch (err) {
    ElMessage.error(`重试仍失败：${err instanceof Error ? err.message : '未知错误'}`)
  } finally {
    busyVoyageId.value = null
  }
}

async function removeVoyage(voyage: Voyage): Promise<void> {
  const beltCount = voyageStore.voyageBeltCounts[voyage.id] ?? 0
  try {
    await ElMessageBox.confirm(
      `删除航次「${voyage.voyageNo}」不会删除其 ${beltCount} 条样带与已录记录，只会解除样带的航次归属（可重新归批）。确认删除？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  try {
    await voyageStore.removeVoyage(voyage.id)
    ElMessage.success('航次已删除，样带归属已解除')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '删除失败')
  }
}

function gotoReviews(): void {
  void router.push('/reviews')
}

onMounted(() => {
  if (reefStore.reefs.length === 0) void initDatabase()
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">航次批次（普查队）</h2>
        <p class="gb-hint">
          每趟下水为一个航次批次，样带、珊瑚覆盖与鱼类计数按批次归口；录完提交院所审核，审过的批次才进礁区结论。
          审核单写失败可只重试审核这侧，已录数据照旧。
        </p>
      </div>
      <div class="page__actions">
        <el-button :icon="Ship" @click="gotoReviews">院所审核台 →</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">新建航次</el-button>
      </div>
    </div>

    <div class="gb-stats-row">
      <StatBadge label="航次批次" :value="stats.voyageCount" suffix="个" icon="Ship" />
      <StatBadge label="归批样带" :value="stats.beltCount" suffix="条" tone="info" icon="Files" />
      <StatBadge label="待院所受理" :value="stats.pendingCount" suffix="批" tone="warning" icon="Upload" />
      <StatBadge label="已审定批次" :value="stats.approvedCount" suffix="批" tone="success" icon="DataLine" />
      <StatBadge
        label="对账挂起"
        :value="stats.suspendedCount"
        suffix="批"
        :tone="stats.suspendedCount > 0 ? 'danger' : 'primary'"
        icon="WarningFilled"
      />
    </div>

    <el-alert
      v-if="stats.suspendedCount > 0"
      type="error"
      show-icon
      :closable="false"
      title="有批次对账挂起，暂不计入礁区结论"
      description="审核单快照与普查队当前数据对不上（航次号或样带编号不一致）。请与院所核对后到审核台「重新对账」解除挂起。"
    />

    <EmptyPanel
      v-if="rows.length === 0"
      title="还没有航次批次"
      description="新建航次后，在样带布设时把样带归入该批次；录完珊瑚覆盖与鱼类计数后整批提交院所审核。"
      action-text="新建航次"
      @action="openCreate"
    />

    <el-table v-else :data="rows" border stripe class="gb-table-compact">
      <el-table-column type="expand">
        <template #default="{ row }">
          <div class="page__expand">
            <h4 class="page__sub">批内样带（{{ row.belts.length }} 条）</h4>
            <el-table :data="row.belts" size="small" border class="gb-table-compact">
              <el-table-column prop="no" label="样带编号" width="100" />
              <el-table-column label="站位" width="90">
                <template #default="{ row: belt }">{{ siteNoOf(belt.siteId) }}</template>
              </el-table-column>
              <el-table-column prop="lengthM" label="长度 (m)" width="90" align="right" />
              <el-table-column prop="orientation" label="朝向" width="70" align="center" />
              <el-table-column prop="surveyDate" label="调查日期" width="110" />
              <el-table-column prop="observer" label="调查人" width="100" />
              <el-table-column label="珊瑚 / 鱼类记录" min-width="130">
                <template #default="{ row: belt }">
                  <span class="gb-mono">
                    {{ surveyStore.beltRecordCounts[belt.id]?.coralCount ?? 0 }} /
                    {{ surveyStore.beltRecordCounts[belt.id]?.fishCount ?? 0 }} 条
                  </span>
                </template>
              </el-table-column>
            </el-table>
            <template v-if="row.openRejects.length > 0">
              <h4 class="page__sub page__sub--danger">院所驳回条目（{{ row.openRejects.length }} 条，复核销号前不计入结论）</h4>
              <el-alert
                v-for="entry in row.openRejects"
                :key="entry.id"
                type="warning"
                show-icon
                :closable="false"
                class="page__reject"
                :title="`样带 ${entry.beltNo}：${entry.reason}`"
              />
            </template>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="航次号" width="170">
        <template #default="{ row }">
          <span class="gb-mono">{{ row.voyage.voyageNo }}</span>
          <div v-if="row.suspended">
            <el-tag size="small" type="danger" effect="dark">对账挂起</el-tag>
          </div>
        </template>
      </el-table-column>
      <el-table-column prop="voyage.title" label="航次名称" min-width="150" />
      <el-table-column label="作业日期" width="200">
        <template #default="{ row }">
          <span class="gb-mono">{{ row.voyage.startDate || '—' }} ~ {{ row.voyage.endDate || '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="voyage.team" label="普查队" width="130">
        <template #default="{ row }">{{ row.voyage.team || '—' }}</template>
      </el-table-column>
      <el-table-column label="批次状态" width="150">
        <template #default="{ row }">
          <el-tag size="small" :type="voyageMeta(row.voyage.status).tagType" effect="light">
            {{ voyageMeta(row.voyage.status).label }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="样带" width="80" align="right">
        <template #default="{ row }">
          <span class="gb-mono">{{ row.belts.length }}</span>
        </template>
      </el-table-column>
      <el-table-column label="珊瑚 / 鱼类" width="110" align="right">
        <template #default="{ row }">
          <span class="gb-mono">{{ row.coralCount }} / {{ row.fishCount }}</span>
        </template>
      </el-table-column>
      <el-table-column label="未复核驳回" width="110" align="right">
        <template #default="{ row }">
          <span v-if="row.openRejects.length > 0" class="gb-danger gb-mono">{{ row.openRejects.length }} 条</span>
          <span v-else class="gb-hint">—</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="300" fixed="right">
        <template #default="{ row }">
          <el-button
            v-if="row.voyage.status === 'open'"
            size="small"
            type="primary"
            :icon="Upload"
            :loading="busyVoyageId === row.voyage.id"
            @click="submitVoyage(row.voyage)"
          >
            提交审核
          </el-button>
          <el-button
            v-if="row.voyage.status === 'submitted' && !row.review"
            size="small"
            type="warning"
            :icon="Refresh"
            :loading="busyVoyageId === row.voyage.id"
            @click="retryAcceptance(row.voyage)"
          >
            重试受理
          </el-button>
          <el-button v-if="row.voyage.status === 'open'" size="small" :icon="Edit" @click="openEdit(row.voyage)">
            编辑
          </el-button>
          <el-button
            v-if="!row.review"
            size="small"
            type="danger"
            plain
            :icon="Delete"
            @click="removeVoyage(row.voyage)"
          >
            删除
          </el-button>
          <span v-if="row.suspended" class="gb-hint">挂起中，请到审核台对账</span>
        </template>
      </el-table-column>
      <template #empty>
        <EmptyPanel title="暂无航次" description="点击右上角「新建航次」开始。" compact />
      </template>
    </el-table>

    <p class="gb-hint">
      提示：已提交 / 已审定的航次不可编辑或删除；提交后再改动批内样带会导致审核单对账失败（批次挂起），需院所重新对账。
    </p>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑航次' : '新建航次'" width="560px" :close-on-click-modal="false">
      <el-form label-width="104px">
        <el-form-item label="航次号" required>
          <el-input v-model="form.voyageNo" placeholder="如：VY-20261007-01" maxlength="32" />
          <div class="gb-hint">两边对账关键字，全库唯一；新建时已按日期自动建议</div>
        </el-form-item>
        <el-form-item label="航次名称" required>
          <el-input v-model="form.title" placeholder="如：清澜湾近岸普查航次" maxlength="40" />
        </el-form-item>
        <el-form-item label="普查队">
          <el-input v-model="form.team" placeholder="如：院属普查一队" maxlength="30" />
        </el-form-item>
        <el-form-item label="作业日期" required>
          <el-date-picker v-model="form.startDate" type="date" value-format="YYYY-MM-DD" placeholder="开始日期" class="page__date" />
          <span class="page__unit">至</span>
          <el-date-picker v-model="form.endDate" type="date" value-format="YYYY-MM-DD" placeholder="结束日期" class="page__date" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.note" placeholder="选填" maxlength="60" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ editingId ? '保存修改' : '新建航次' }}
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.page__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.page__title {
  margin: 0 0 4px;
  font-size: 19px;
  color: #0b5d5a;
}

.page__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.page__expand {
  padding: 8px 12px;
}

.page__sub {
  margin: 4px 0 8px;
  font-size: 13px;
  color: #4c6663;
}

.page__sub--danger {
  color: #c0392b;
  margin-top: 12px;
}

.page__reject + .page__reject {
  margin-top: 6px;
}

.page__unit {
  margin: 0 8px;
  font-size: 12px;
  color: #7c9995;
}

.page__date {
  width: 160px;
}
</style>
