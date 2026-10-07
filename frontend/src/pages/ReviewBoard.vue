<script setup lang="ts">
/**
 * 审核管理：院所审核组只管审核单与驳回条目。
 * 审核单按航次号关联普查航次，审核条目按「航次号 + 样带编号」对账；
 * 核不上的批次先挂起。写审核单失败只重试审核侧，普查队录好的不动。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Plus, Warning } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useBeltStore } from '@/stores/beltStore'
import { useVoyageStore } from '@/stores/voyageStore'
import { useReviewStore } from '@/stores/reviewStore'
import { REVIEW_VERDICTS } from '@/types/review'
import type { ReviewForm, ReviewItem, ReviewVerdict } from '@/types/review'
import type { VoyageReviewStatus } from '@/types/voyage'
import { initDatabase } from '@/utils/db'

const beltStore = useBeltStore()
const voyageStore = useVoyageStore()
const reviewStore = useReviewStore()

const dialogVisible = ref(false)
const editingFormId = ref<string | null>(null)
const submitting = ref(false)
const itemsVisible = ref(false)
const currentForm = ref<ReviewForm | null>(null)
const form = reactive({
  voyageNo: '',
  reviewer: '',
  reviewedAt: '',
  note: ''
})

/** 审核单行：条目数、驳回数、对账状态 */
const rows = computed(() =>
  reviewStore.reviewForms.map((form) => {
    const items = reviewStore.itemsOfForm(form.id)
    const status = reviewStore.statusOfVoyage(form.voyageNo, beltStore.belts)
    const reconcile = reviewStore.reconcileOfVoyage(form.voyageNo, beltStore.belts)
    return {
      form,
      itemCount: items.length,
      rejectedCount: items.filter((item) => item.verdict === '驳回').length,
      matchedCount: reconcile.matched.length,
      unmatchedCount: reconcile.unmatched.length,
      status
    }
  })
)

const stats = computed(() => ({
  formCount: rows.value.length,
  itemCount: rows.value.reduce((sum, row) => sum + row.itemCount, 0),
  rejectedCount: rows.value.reduce((sum, row) => sum + row.rejectedCount, 0),
  suspendedCount: rows.value.filter((row) => row.status === '已挂起').length
}))

/** 可送审的航次（普查侧已建立航次批次） */
const voyageOptions = computed(() => voyageStore.voyages.map((voyage) => voyage.voyageNo))

function statusType(status: VoyageReviewStatus): '' | 'success' | 'warning' | 'info' {
  if (status === '已审') return 'success'
  if (status === '已挂起') return 'warning'
  return 'info'
}

function openCreate(): void {
  editingFormId.value = null
  form.voyageNo = voyageOptions.value[0] ?? ''
  form.reviewer = ''
  form.reviewedAt = new Date().toISOString().slice(0, 10)
  form.note = ''
  dialogVisible.value = true
}

function openEdit(reviewForm: ReviewForm): void {
  editingFormId.value = reviewForm.id
  form.voyageNo = reviewForm.voyageNo
  form.reviewer = reviewForm.reviewer
  form.reviewedAt = reviewForm.reviewedAt
  form.note = reviewForm.note
  dialogVisible.value = true
}

async function submitForm(): Promise<void> {
  if (!form.voyageNo.trim()) {
    ElMessage.warning('请选择航次')
    return
  }
  if (!form.reviewer.trim()) {
    ElMessage.warning('请填写审核人')
    return
  }
  submitting.value = true
  try {
    const payload = {
      voyageNo: form.voyageNo.trim(),
      reviewer: form.reviewer.trim(),
      reviewedAt: form.reviewedAt,
      note: form.note.trim()
    }
    if (editingFormId.value) {
      await reviewStore.updateReviewForm(editingFormId.value, payload)
      ElMessage.success('审核单已更新')
    } else {
      const created = await reviewStore.createReviewForm(payload)
      // 为该航次每条样带预生成一条通过条目，审核人可逐条改驳回
      const belts = voyageStore.beltsOfVoyage(payload.voyageNo, beltStore.belts)
      for (const belt of belts) {
        await reviewStore.createReviewItem({
          reviewFormId: created.id,
          voyageNo: payload.voyageNo,
          beltNo: belt.no,
          verdict: '通过',
          reason: ''
        })
      }
      ElMessage.success(`审核单已建立，已为 ${belts.length} 条样带预生成审核条目`)
    }
    dialogVisible.value = false
  } catch (err) {
    ElMessage.error(`审核单写入失败（已重试 3 次）：${err instanceof Error ? err.message : '未知错误'}；普查队数据未受影响，可稍后重试`)
  } finally {
    submitting.value = false
  }
}

async function removeForm(reviewForm: ReviewForm): Promise<void> {
  try {
    await ElMessageBox.confirm(`删除航次「${reviewForm.voyageNo}」的审核单将同时删除其审核条目，确认删除？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  await reviewStore.removeReviewForm(reviewForm.id)
  ElMessage.success('审核单已删除')
}

function openItems(reviewForm: ReviewForm): void {
  currentForm.value = reviewForm
  itemsVisible.value = true
}

/** 当前审核单的条目（按样带编号排序） */
const currentItems = computed<ReviewItem[]>(() =>
  currentForm.value ? reviewStore.itemsOfForm(currentForm.value.id) : []
)

/** 当前审核单的对账结果 */
const currentReconcile = computed(() =>
  currentForm.value ? reviewStore.reconcileOfVoyage(currentForm.value.voyageNo, beltStore.belts) : { matched: [], unmatched: [] }
)

async function setVerdict(item: ReviewItem, verdict: ReviewVerdict): Promise<void> {
  try {
    await reviewStore.updateReviewItem(item.id, {
      verdict,
      reason: verdict === '驳回' ? item.reason || '退回重测' : ''
    })
  } catch (err) {
    ElMessage.error(`审核条目写入失败（已重试 3 次）：${err instanceof Error ? err.message : '未知错误'}`)
  }
}

async function setAllVerdict(verdict: ReviewVerdict): Promise<void> {
  for (const item of currentItems.value) {
    await reviewStore.updateReviewItem(item.id, {
      verdict,
      reason: verdict === '驳回' ? item.reason || '退回重测' : ''
    })
  }
  ElMessage.success(`已将 ${currentItems.value.length} 条条目全部设为「${verdict}」`)
}

async function addUnmatchedItem(): Promise<void> {
  if (!currentForm.value) return
  try {
    await reviewStore.createReviewItem({
      reviewFormId: currentForm.value.id,
      voyageNo: currentForm.value.voyageNo,
      beltNo: 'T-99',
      verdict: '通过',
      reason: ''
    })
    ElMessage.success('已添加一条引用不存在样带的条目（演示挂起）')
  } catch (err) {
    ElMessage.error(`审核条目写入失败：${err instanceof Error ? err.message : '未知错误'}`)
  }
}

onMounted(() => {
  if (reviewStore.reviewForms.length === 0) void initDatabase()
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">审核管理</h2>
        <p class="gb-hint">
          院所审核组只管审核单与驳回条目。审核单按航次号关联普查航次，审核条目按「航次号 + 样带编号」对账；核不上的批次先挂起，写单失败只重试审核侧。
        </p>
      </div>
      <el-button type="primary" :icon="Plus" @click="openCreate">新建审核单</el-button>
    </div>

    <div class="gb-stats-row">
      <StatBadge label="审核单" :value="stats.formCount" suffix="张" icon="Files" />
      <StatBadge label="审核条目" :value="stats.itemCount" suffix="条" tone="info" icon="Grid" />
      <StatBadge label="驳回条目" :value="stats.rejectedCount" suffix="条" tone="warning" icon="Warning" />
      <StatBadge label="挂起批次" :value="stats.suspendedCount" suffix="个" tone="danger" icon="CircleClose" />
    </div>

    <el-alert
      type="warning"
      :closable="false"
      show-icon
      title="口径说明：只退这几条——被驳回的样带不计入结论，同批次通过的样带仍计入；结论与导出共用同一口径。"
    />

    <EmptyPanel
      v-if="rows.length === 0"
      title="还没有审核单"
      description="新建第一张审核单，按航次号关联普查航次并逐条出具审核结论。"
      action-text="新建审核单"
      @action="openCreate"
    />

    <el-table v-else :data="rows" border stripe class="gb-table-compact">
      <el-table-column prop="form.voyageNo" label="航次号" width="140" />
      <el-table-column label="审核人" width="120">
        <template #default="{ row }">{{ row.form.reviewer || '—' }}</template>
      </el-table-column>
      <el-table-column label="审核时间" width="130">
        <template #default="{ row }">
          <span class="gb-mono">{{ row.form.reviewedAt }}</span>
        </template>
      </el-table-column>
      <el-table-column label="条目 / 驳回" width="110" align="center">
        <template #default="{ row }">
          <span class="gb-mono">{{ row.itemCount }} / {{ row.rejectedCount }}</span>
        </template>
      </el-table-column>
      <el-table-column label="对账" width="160">
        <template #default="{ row }">
          <el-tag size="small" type="success" effect="plain">匹配 {{ row.matchedCount }}</el-tag>
          <el-tag v-if="row.unmatchedCount > 0" size="small" type="danger" effect="plain">核不上 {{ row.unmatchedCount }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag size="small" :type="statusType(row.status)" effect="dark">{{ row.status }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="form.note" label="备注" min-width="140" show-overflow-tooltip />
      <el-table-column label="操作" width="240" fixed="right">
        <template #default="{ row }">
          <el-button size="small" type="primary" @click="openItems(row.form)">审核条目</el-button>
          <el-button size="small" :icon="Edit" @click="openEdit(row.form)">编辑</el-button>
          <el-button size="small" type="danger" plain :icon="Delete" @click="removeForm(row.form)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialogVisible" :title="editingFormId ? '编辑审核单' : '新建审核单'" width="540px" :close-on-click-modal="false">
      <el-form label-width="100px">
        <el-form-item label="航次" required>
          <el-select v-model="form.voyageNo" placeholder="选择普查航次" filterable style="width: 100%">
            <el-option v-for="voyage in voyageOptions" :key="voyage" :label="voyage" :value="voyage" />
          </el-select>
          <div class="gb-hint">航次号由普查队在「航次批次」中建立</div>
        </el-form-item>
        <el-form-item label="审核人" required>
          <el-input v-model="form.reviewer" placeholder="如：院所审核组" maxlength="40" />
        </el-form-item>
        <el-form-item label="审核时间">
          <el-date-picker v-model="form.reviewedAt" type="date" value-format="YYYY-MM-DD" placeholder="选择审核时间" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.note" placeholder="如：常规审核 / 专项复核" maxlength="80" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ editingFormId ? '保存修改' : '建立审核单' }}
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="itemsVisible" :title="`审核条目 · ${currentForm?.voyageNo ?? ''}`" width="780px" :close-on-click-modal="false">
      <div class="items__head">
        <div class="gb-hint">
          按「航次号 + 样带编号」对账：匹配 {{ currentReconcile.matched.length }} 条 · 核不上
          {{ currentReconcile.unmatched.length }} 条
          <el-tag v-if="currentReconcile.unmatched.length > 0" size="small" type="warning" effect="dark" style="margin-left: 8px">
            已挂起
          </el-tag>
        </div>
        <div class="items__actions">
          <el-button size="small" @click="setAllVerdict('通过')">全部通过</el-button>
          <el-button size="small" @click="setAllVerdict('驳回')">全部驳回</el-button>
          <el-button size="small" :icon="Warning" @click="addUnmatchedItem">添加核不上条目</el-button>
        </div>
      </div>

      <el-table :data="currentItems" size="small" border class="gb-table-compact">
        <el-table-column label="样带编号" width="120">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.beltNo }}</span>
            <el-tag
              v-if="!currentReconcile.matched.some((m) => m.item.id === row.id)"
              size="small"
              type="danger"
              effect="plain"
              style="margin-left: 6px"
            >核不上</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="结论" width="160">
          <template #default="{ row }">
            <el-radio-group
              :model-value="row.verdict"
              size="small"
              @change="(val: ReviewVerdict) => setVerdict(row, val)"
            >
              <el-radio-button v-for="v in REVIEW_VERDICTS" :key="v" :value="v">{{ v }}</el-radio-button>
            </el-radio-group>
          </template>
        </el-table-column>
        <el-table-column label="驳回原因" min-width="180">
          <template #default="{ row }">
            <el-input
              v-if="row.verdict === '驳回'"
              :model-value="row.reason"
              size="small"
              placeholder="退回原因"
              @change="(val: string) => reviewStore.updateReviewItem(row.id, { reason: val })"
            />
            <span v-else class="gb-hint">—</span>
          </template>
        </el-table-column>
      </el-table>

      <template #footer>
        <el-button @click="itemsVisible = false">关闭</el-button>
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

.items__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}

.items__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
</style>
