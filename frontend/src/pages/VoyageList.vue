<script setup lang="ts">
/**
 * 航次批次：普查队按航次批次管样带。
 * 航次批次是样带的管理单元，样带通过 voyageNo 归属到航次。
 * 审核状态（未送审/已审/已挂起）为派生值，点击可展开本航次样带。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Plus, Right, Warning } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useBeltStore } from '@/stores/beltStore'
import { useVoyageStore } from '@/stores/voyageStore'
import { useReviewStore } from '@/stores/reviewStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { createEmptyVoyageDraft, suggestVoyageNo, VOYAGE_REVIEW_STATUSES } from '@/types/voyage'
import type { VoyageBatch } from '@/types/voyage'
import type { VoyageReviewStatus } from '@/types/voyage'
import { initDatabase } from '@/utils/db'

const router = useRouter()
const beltStore = useBeltStore()
const voyageStore = useVoyageStore()
const reviewStore = useReviewStore()
const surveyStore = useSurveyStore()

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const expandedVoyageNo = ref<string | null>(null)
const form = reactive({
  voyageNo: '',
  surveyDate: '',
  team: '',
  note: ''
})

/** 航次行：样带数、珊瑚/鱼类记录数、审核状态 */
const rows = computed(() =>
  voyageStore.voyages.map((voyage) => {
    const belts = voyageStore.beltsOfVoyage(voyage.voyageNo, beltStore.belts)
    const status = reviewStore.statusOfVoyage(voyage.voyageNo, beltStore.belts)
    const approvedCount = belts.filter((belt) => reviewStore.isBeltApproved(belt, beltStore.belts)).length
    return {
      voyage,
      beltCount: belts.length,
      coralCount: belts.reduce((sum, belt) => sum + surveyStore.coralsOfBelt(belt.id).length, 0),
      fishCount: belts.reduce((sum, belt) => sum + surveyStore.fishesOfBelt(belt.id).length, 0),
      approvedCount,
      status
    }
  })
)

const stats = computed(() => ({
  voyageCount: rows.value.length,
  beltCount: rows.value.reduce((sum, row) => sum + row.beltCount, 0),
  approvedCount: rows.value.reduce((sum, row) => sum + row.approvedCount, 0),
  suspendedCount: rows.value.filter((row) => row.status === '已挂起').length
}))

function statusType(status: VoyageReviewStatus): '' | 'success' | 'warning' | 'info' {
  if (status === '已审') return 'success'
  if (status === '已挂起') return 'warning'
  return 'info'
}

function toggleExpand(voyageNo: string): void {
  expandedVoyageNo.value = expandedVoyageNo.value === voyageNo ? null : voyageNo
}

function beltsOf(voyageNo: string) {
  return voyageStore.beltsOfVoyage(voyageNo, beltStore.belts)
}

function openCreate(): void {
  editingId.value = null
  const draft = createEmptyVoyageDraft()
  form.voyageNo = draft.voyageNo
  form.surveyDate = draft.surveyDate
  form.team = ''
  form.note = ''
  dialogVisible.value = true
}

function openEdit(voyage: VoyageBatch): void {
  editingId.value = voyage.id
  form.voyageNo = voyage.voyageNo
  form.surveyDate = voyage.surveyDate
  form.team = voyage.team
  form.note = voyage.note
  dialogVisible.value = true
}

async function submitForm(): Promise<void> {
  if (!form.voyageNo.trim()) {
    ElMessage.warning('请填写航次号')
    return
  }
  if (!form.surveyDate) {
    ElMessage.warning('请选择调查日期')
    return
  }
  const duplicated = voyageStore.voyages.some(
    (voyage) => voyage.voyageNo === form.voyageNo.trim() && voyage.id !== editingId.value
  )
  if (duplicated) {
    ElMessage.warning(`航次号「${form.voyageNo.trim()}」已存在`)
    return
  }
  submitting.value = true
  try {
    const payload = {
      voyageNo: form.voyageNo.trim(),
      surveyDate: form.surveyDate,
      team: form.team.trim(),
      note: form.note.trim()
    }
    if (editingId.value) {
      await voyageStore.updateVoyage(editingId.value, payload)
      ElMessage.success('航次批次已更新')
    } else {
      await voyageStore.createVoyage(payload)
      ElMessage.success(`航次 ${payload.voyageNo} 已建立，可到样带布设选择该航次`)
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function removeVoyage(voyage: VoyageBatch): Promise<void> {
  const belts = voyageStore.beltsOfVoyage(voyage.voyageNo, beltStore.belts)
  try {
    await ElMessageBox.confirm(
      `删除航次「${voyage.voyageNo}」不删除其下 ${belts.length} 条样带（样带会保留为未归属），确认删除？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await voyageStore.removeVoyage(voyage.id)
  ElMessage.success('航次批次已删除')
}

function gotoBelts(voyage: VoyageBatch): void {
  // 跳到该航次下第一条样带所属站位的样带布设页
  const belts = voyageStore.beltsOfVoyage(voyage.voyageNo, beltStore.belts)
  const first = belts[0]
  if (first) void router.push(`/sites/${first.siteId}/belts`)
  else ElMessage.info('该航次下还没有样带')
}

onMounted(() => {
  if (voyageStore.voyages.length === 0) void initDatabase()
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">航次批次</h2>
        <p class="gb-hint">
          普查队按航次批次管理样带、珊瑚覆盖与鱼类计数；院所审核组只管审核单与驳回条目。礁区覆盖率与白化指数只按审过的批次算。
        </p>
      </div>
      <el-button type="primary" :icon="Plus" @click="openCreate">新建航次</el-button>
    </div>

    <div class="gb-stats-row">
      <StatBadge label="航次批次" :value="stats.voyageCount" suffix="个" icon="Files" />
      <StatBadge label="样带总数" :value="stats.beltCount" suffix="条" tone="info" icon="Grid" />
      <StatBadge label="已审过样带" :value="stats.approvedCount" suffix="条" tone="success" icon="CircleCheck" />
      <StatBadge label="挂起批次" :value="stats.suspendedCount" suffix="个" tone="warning" icon="Warning" />
    </div>

    <el-alert
      type="info"
      :closable="false"
      show-icon
      title="对账口径：审核条目按「航次号 + 样带编号」匹配普查样带；核不上的批次先挂起，挂起批次的样带不计入结论。"
    />

    <EmptyPanel
      v-if="rows.length === 0"
      title="还没有航次批次"
      description="新建第一个航次批次，然后到样带布设页把样带归属到该航次。"
      action-text="新建航次"
      @action="openCreate"
    />

    <div v-else class="voyage-grid">
      <el-card v-for="row in rows" :key="row.voyage.id" shadow="hover" class="voyage-card">
        <template #header>
          <div class="voyage-card__head">
            <div>
              <strong class="voyage-card__no">{{ row.voyage.voyageNo }}</strong>
              <el-tag size="small" effect="plain" class="voyage-card__date">{{ row.voyage.surveyDate }}</el-tag>
            </div>
            <el-tag size="small" :type="statusType(row.status)" effect="dark">{{ row.status }}</el-tag>
          </div>
        </template>

        <div class="voyage-card__stats">
          <StatBadge label="样带" :value="row.beltCount" suffix="条" size="small" icon="Files" />
          <StatBadge label="珊瑚记录" :value="row.coralCount" suffix="条" size="small" tone="success" icon="Histogram" />
          <StatBadge label="计数记录" :value="row.fishCount" suffix="条" size="small" tone="warning" icon="DataLine" />
          <StatBadge label="已审过" :value="row.approvedCount" suffix="条" size="small" tone="info" icon="CircleCheck" />
        </div>

        <div class="voyage-card__meta">
          <span v-if="row.voyage.team">调查队：{{ row.voyage.team }}</span>
          <span v-if="row.voyage.note">备注：{{ row.voyage.note }}</span>
          <span v-else class="gb-hint">暂无备注</span>
        </div>

        <div v-if="row.status === '已挂起'" class="voyage-card__warning">
          <el-icon><Warning /></el-icon>
          <span>该航次有审核条目核不上，已挂起，样带暂不计入结论</span>
        </div>

        <div class="voyage-card__actions">
          <el-button size="small" type="primary" :icon="Right" @click="gotoBelts(row.voyage)">查看样带</el-button>
          <el-button size="small" @click="toggleExpand(row.voyage.voyageNo)">
            {{ expandedVoyageNo === row.voyage.voyageNo ? '收起' : '展开' }}
          </el-button>
          <el-button size="small" :icon="Edit" @click="openEdit(row.voyage)">编辑</el-button>
          <el-button size="small" type="danger" plain :icon="Delete" @click="removeVoyage(row.voyage)">删除</el-button>
        </div>

        <el-table
          v-if="expandedVoyageNo === row.voyage.voyageNo"
          :data="beltsOf(row.voyage.voyageNo)"
          size="small"
          border
          class="voyage-card__table"
        >
          <el-table-column prop="no" label="样带编号" width="100" />
          <el-table-column label="朝向" width="70" align="center">
            <template #default="{ row: belt }">
              <el-tag size="small" effect="plain">{{ belt.orientation }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="长度" width="80" align="right">
            <template #default="{ row: belt }">
              <span class="gb-mono">{{ belt.lengthM }} m</span>
            </template>
          </el-table-column>
          <el-table-column prop="surveyDate" label="调查日期" width="120" />
          <el-table-column label="审核" width="90" align="center">
            <template #default="{ row: belt }">
              <el-tag v-if="reviewStore.isBeltApproved(belt, beltStore.belts)" size="small" type="success" effect="plain">
                通过
              </el-tag>
              <el-tag v-else size="small" type="info" effect="plain">未过审</el-tag>
            </template>
          </el-table-column>
        </el-table>
      </el-card>
    </div>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑航次批次' : '新建航次批次'" width="540px" :close-on-click-modal="false">
      <el-form label-width="100px">
        <el-form-item label="航次号" required>
          <el-input v-model="form.voyageNo" placeholder="如：V20261007" maxlength="32" />
          <div class="gb-hint">建议格式 V + 调查日期 YYYYMMDD，如 {{ suggestVoyageNo(form.surveyDate || new Date().toISOString().slice(0, 10)) }}</div>
        </el-form-item>
        <el-form-item label="调查日期" required>
          <el-date-picker v-model="form.surveyDate" type="date" value-format="YYYY-MM-DD" placeholder="选择调查日期" />
        </el-form-item>
        <el-form-item label="调查队">
          <el-input v-model="form.team" placeholder="如：南海普查队" maxlength="40" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.note" placeholder="如：首航 / 跨礁区联合调查" maxlength="80" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ editingId ? '保存修改' : '建立航次' }}
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

.voyage-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
  gap: 14px;
}

.voyage-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.voyage-card__no {
  font-size: 16px;
  color: #10312f;
}

.voyage-card__date {
  margin-left: 8px;
}

.voyage-card__stats {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 10px;
}

.voyage-card__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  font-size: 13px;
  color: #4c6663;
}

.voyage-card__warning {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  background: #fdf3e3;
  color: #b9770e;
  font-size: 12px;
}

.voyage-card__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.voyage-card__table {
  margin-top: 12px;
}
</style>
