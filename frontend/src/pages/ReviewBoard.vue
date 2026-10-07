<script setup lang="ts">
/**
 * 模块 8：/reviews 院所审核台（院所审核组侧）
 * 审核组只管审核单与驳回条目：受理航次生成审核单、逐条样带通过 / 驳回、
 * 签发审核单、复核销号驳回条目、对账挂起后重新对账。
 * 驳回为条目级：只退被驳回的样带，同航次其余样带签发后照常计入礁区结论。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Checked, Refresh, Stamp } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import BleachTag from '@/components/common/BleachTag.vue'
import { useReefStore } from '@/stores/reefStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { useReviewStore } from '@/stores/reviewStore'
import { REVIEW_STATUS_META } from '@/types/review'
import type { RejectEntry, ReviewOrder, ReviewStatus } from '@/types/review'
import type { Belt } from '@/types/belt'
import { bleachGrade, bleachIndex, coralCoveragePct } from '@/utils/bleach'
import { initDatabase } from '@/utils/db'

/** 模板里 el-table 的 row 为 any，经此函数取回类型化的状态展示元数据 */
function reviewMeta(status: ReviewStatus): { label: string; tagType: 'info' | 'primary' | 'warning' | 'success' | 'danger' } {
  return REVIEW_STATUS_META[status]
}

const router = useRouter()
const reefStore = useReefStore()
const surveyStore = useSurveyStore()
const reviewStore = useReviewStore()

const reviewDialogVisible = ref(false)
const activeReviewId = ref<string | null>(null)
const busy = ref(false)
const signForm = reactive({ reviewer: '', comment: '' })

const activeReview = computed(() => reviewStore.reviewById(activeReviewId.value))
const activeVoyage = computed(() =>
  activeReview.value ? reviewStore.voyageById(activeReview.value.voyageId) : null
)
const activeBelts = computed(() => reviewStore.beltsOfReview(activeReview.value))
const activeRejects = computed(() => reviewStore.rejectsOfReview(activeReviewId.value))
const activeReconcile = computed(() =>
  activeReview.value ? reviewStore.scope.reconcileOf(activeReview.value.voyageId) : null
)

const stats = computed(() => ({
  pendingAccept: reviewStore.pendingVoyages.length,
  pendingSign: reviewStore.reviews.filter((review) => review.status === 'pending').length,
  suspended: reviewStore.suspendedReviews.length,
  openRejects: reviewStore.openRejectEntries.length
}))

/** 审核单行：附对账结果与驳回统计 */
const reviewRows = computed(() =>
  [...reviewStore.reviews]
    .sort((a, b) => b.submittedAt - a.submittedAt)
    .map((review) => {
      const reconcile = reviewStore.scope.reconcileOf(review.voyageId)
      const rejects = reviewStore.rejectsOfReview(review.id)
      return {
        review,
        voyage: reviewStore.voyageById(review.voyageId),
        suspended: reconcile !== null && !reconcile.ok,
        reconcileReasons: reconcile?.reasons ?? [],
        openRejectCount: rejects.filter((entry) => entry.status === 'open').length,
        rejectCount: rejects.length
      }
    })
)

function openRejectOf(beltId: string): RejectEntry | null {
  return activeRejects.value.find((entry) => entry.beltId === beltId && entry.status === 'open') ?? null
}

function beltStats(belt: Belt): { coveragePct: number; bleachIndex: number; grade: ReturnType<typeof bleachGrade> } {
  const corals = surveyStore.coralsOfBelt(belt.id)
  const coverCmTotal = corals.reduce((sum, coral) => sum + coral.coverCm, 0)
  const index = bleachIndex(corals)
  return { coveragePct: coralCoveragePct(coverCmTotal, belt.lengthM), bleachIndex: index, grade: bleachGrade(index) }
}

function siteNoOf(siteId: string): string {
  return reefStore.siteById(siteId)?.no ?? '—'
}

/** 受理待审航次：生成审核单（院所侧独立写入，失败不影响普查队数据） */
async function acceptVoyage(voyageId: string, voyageNo: string): Promise<void> {
  busy.value = true
  try {
    await reviewStore.acceptVoyage(voyageId)
    ElMessage.success(`航次 ${voyageNo} 的审核单已生成，可开始逐条审核`)
  } catch (err) {
    ElMessage.error(`审核单生成失败：${err instanceof Error ? err.message : '未知错误'}（普查队数据不受影响，可重试）`)
  } finally {
    busy.value = false
  }
}

function openReview(review: ReviewOrder): void {
  activeReviewId.value = review.id
  signForm.reviewer = review.reviewer
  signForm.comment = review.comment
  reviewDialogVisible.value = true
}

/** 条目级驳回：填理由后只退这一条样带 */
async function rejectBelt(belt: Belt): Promise<void> {
  if (!activeReview.value) return
  let reason = ''
  try {
    const result = await ElMessageBox.prompt(
      `驳回样带 ${belt.no}（只退这一条，同航次其余样带不受影响）。请填写驳回理由：`,
      '条目级驳回',
      { confirmButtonText: '确认驳回', cancelButtonText: '取消', inputPlaceholder: '如：白化等级与现场照片不符' }
    )
    reason = String(result.value ?? '').trim()
  } catch {
    return
  }
  if (!reason) {
    ElMessage.warning('驳回理由不能为空')
    return
  }
  try {
    await reviewStore.rejectBelt(activeReview.value.id, belt, reason)
    ElMessage.success(`样带 ${belt.no} 已驳回，复核销号前不计入礁区结论`)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '驳回失败')
  }
}

async function withdrawReject(entry: RejectEntry): Promise<void> {
  try {
    await reviewStore.withdrawReject(entry.id)
    ElMessage.success(`已撤销对样带 ${entry.beltNo} 的驳回`)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '撤销失败')
  }
}

/** 签发审核单：先对账，核不上禁止签发 */
async function signReview(): Promise<void> {
  if (!activeReview.value) return
  if (!signForm.reviewer.trim()) {
    ElMessage.warning('请填写审核人')
    return
  }
  const openCount = activeRejects.value.filter((entry) => entry.status === 'open').length
  try {
    await ElMessageBox.confirm(
      openCount === 0
        ? '本批次无驳回条目，签发后整批计入礁区结论。确认签发？'
        : `本批次有 ${openCount} 条驳回条目，签发后其余样带计入礁区结论（条目级退回）。确认签发？`,
      '签发确认',
      { type: 'warning', confirmButtonText: '签发', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  busy.value = true
  try {
    const status = await reviewStore.signReview(activeReview.value.id, signForm.reviewer, signForm.comment)
    ElMessage.success(`审核单已签发：${REVIEW_STATUS_META[status].label}`)
    reviewDialogVisible.value = false
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '签发失败')
  } finally {
    busy.value = false
  }
}

/** 复核销号：驳回条目整改复核通过，该样带重新计入结论 */
async function resolveReject(entry: RejectEntry): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确认样带 ${entry.beltNo} 已整改复核通过？销号后该样带重新计入礁区结论。`,
      '复核销号',
      { type: 'warning', confirmButtonText: '销号', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await reviewStore.resolveReject(entry.id)
  ElMessage.success(`样带 ${entry.beltNo} 的驳回已销号`)
}

/** 重新对账：以普查队当前数据刷新审核单快照，解除挂起 */
async function recheckReview(review: ReviewOrder): Promise<void> {
  try {
    await reviewStore.recheckReview(review.id)
    ElMessage.success(`审核单 ${review.voyageNo} 已按普查队当前数据重新对账`)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '重新对账失败')
  }
}

function gotoVoyages(): void {
  void router.push('/voyages')
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
        <h2 class="page__title">院所审核台</h2>
        <p class="gb-hint">
          审核组只管审核单与驳回条目：按航次号与样带编号同普查队对账，核不上的批次先挂起；
          驳回为条目级，只退被驳回的样带。审过的批次才进礁区覆盖率与白化指数结论。
        </p>
      </div>
      <el-button :icon="Checked" @click="gotoVoyages">普查队航次 →</el-button>
    </div>

    <div class="gb-stats-row">
      <StatBadge label="待受理批次" :value="stats.pendingAccept" suffix="批" tone="warning" icon="Files" />
      <StatBadge label="待签发审核单" :value="stats.pendingSign" suffix="张" tone="info" icon="Stamp" />
      <StatBadge
        label="对账挂起"
        :value="stats.suspended"
        suffix="批"
        :tone="stats.suspended > 0 ? 'danger' : 'primary'"
        icon="WarningFilled"
      />
      <StatBadge
        label="未复核驳回"
        :value="stats.openRejects"
        suffix="条"
        :tone="stats.openRejects > 0 ? 'warning' : 'success'"
        icon="DataLine"
      />
    </div>

    <el-card v-if="reviewStore.pendingVoyages.length > 0" shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>待受理批次（{{ reviewStore.pendingVoyages.length }}）</h3>
        <span class="gb-hint">普查队已提交，受理后生成审核单（快照航次号与样带编号作为对账基准）</span>
      </div>
      <el-table :data="reviewStore.pendingVoyages" border stripe class="gb-table-compact">
        <el-table-column label="航次号" width="170">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.voyageNo }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="title" label="航次名称" min-width="150" />
        <el-table-column prop="team" label="普查队" width="130">
          <template #default="{ row }">{{ row.team || '—' }}</template>
        </el-table-column>
        <el-table-column label="作业日期" width="200">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.startDate || '—' }} ~ {{ row.endDate || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="140" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="primary" :loading="busy" @click="acceptVoyage(row.id, row.voyageNo)">
              受理并开单
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>审核单（{{ reviewRows.length }} 张）</h3>
        <span class="gb-hint">一航次一单；签发前必须先通过航次号与样带编号对账</span>
      </div>

      <EmptyPanel
        v-if="reviewRows.length === 0"
        title="还没有审核单"
        description="普查队提交航次后，在上方「待受理批次」受理开单；受理后即可逐条审核并签发。"
        compact
      />

      <el-table v-else :data="reviewRows" border stripe class="gb-table-compact">
        <el-table-column label="航次号" width="170">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.review.voyageNo }}</span>
            <div v-if="row.suspended">
              <el-tag size="small" type="danger" effect="dark">对账挂起</el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="150">
          <template #default="{ row }">
            <el-tag size="small" :type="reviewMeta(row.review.status).tagType" effect="light">
              {{ reviewMeta(row.review.status).label }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="在册样带" width="100" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.review.beltNos.length }}</span>
          </template>
        </el-table-column>
        <el-table-column label="驳回条目" width="110" align="right">
          <template #default="{ row }">
            <span v-if="row.openRejectCount > 0" class="gb-danger gb-mono">{{ row.openRejectCount }} 条未复核</span>
            <span v-else class="gb-mono">{{ row.rejectCount }}</span>
          </template>
        </el-table-column>
        <el-table-column label="受理 / 签发" width="200">
          <template #default="{ row }">
            <div class="gb-mono">{{ new Date(row.review.submittedAt).toLocaleString('zh-CN') }}</div>
            <div class="gb-hint gb-mono">
              {{ row.review.signedAt ? new Date(row.review.signedAt).toLocaleString('zh-CN') : '未签发' }}
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="review.reviewer" label="审核人" width="100">
          <template #default="{ row }">{{ row.review.reviewer || '—' }}</template>
        </el-table-column>
        <el-table-column label="对账" min-width="180">
          <template #default="{ row }">
            <span v-if="row.suspended" class="gb-danger">{{ row.reconcileReasons.join('；') }}</span>
            <span v-else class="gb-hint">航次号与样带编号核对一致</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="230" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="primary" :icon="Stamp" @click="openReview(row.review)">
              {{ row.review.status === 'pending' ? '审核' : '查看' }}
            </el-button>
            <el-button
              v-if="row.suspended"
              size="small"
              type="warning"
              :icon="Refresh"
              @click="recheckReview(row.review)"
            >
              重新对账
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>驳回条目（未复核 {{ stats.openRejects }} 条）</h3>
        <span class="gb-hint">条目级退回：只退被驳回的样带；整改复核通过后销号，该样带重新计入结论</span>
      </div>

      <EmptyPanel
        v-if="reviewStore.openRejectEntries.length === 0"
        title="没有未复核的驳回条目"
        description="被驳回的样带会列在这里，等待普查队整改后由审核组复核销号。"
        compact
      />

      <el-table v-else :data="reviewStore.openRejectEntries" border stripe class="gb-table-compact">
        <el-table-column label="航次号" width="170">
          <template #default="{ row }">
            <span class="gb-mono">{{ reviewStore.reviewById(row.reviewId)?.voyageNo ?? '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="beltNo" label="样带编号" width="100" />
        <el-table-column prop="reason" label="驳回理由" min-width="220" show-overflow-tooltip />
        <el-table-column label="驳回时间" width="170">
          <template #default="{ row }">
            <span class="gb-mono">{{ new Date(row.createdAt).toLocaleString('zh-CN') }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="140" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="success" plain :icon="Checked" @click="resolveReject(row)">
              复核销号
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog
      v-model="reviewDialogVisible"
      :title="activeReview ? `审核单 · ${activeReview.voyageNo}` : '审核单'"
      width="860px"
      :close-on-click-modal="false"
    >
      <template v-if="activeReview">
        <el-alert
          v-if="activeReconcile && !activeReconcile.ok"
          type="error"
          show-icon
          :closable="false"
          title="批次对账挂起"
          :description="`${activeReconcile.reasons.join('；')}。请与普查队核对后「重新对账」，对账通过前不能签发。`"
        />
        <el-descriptions :column="3" border size="small" class="page__meta">
          <el-descriptions-item label="航次号">{{ activeReview.voyageNo }}</el-descriptions-item>
          <el-descriptions-item label="航次名称">{{ activeVoyage?.title ?? '—' }}</el-descriptions-item>
          <el-descriptions-item label="普查队">{{ activeVoyage?.team || '—' }}</el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag size="small" :type="REVIEW_STATUS_META[activeReview.status].tagType" effect="light">
              {{ REVIEW_STATUS_META[activeReview.status].label }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="受理时间">
            <span class="gb-mono">{{ new Date(activeReview.submittedAt).toLocaleString('zh-CN') }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="在册样带">{{ activeReview.beltNos.join('、') }}</el-descriptions-item>
        </el-descriptions>

        <el-table :data="activeBelts" border stripe class="gb-table-compact page__belts">
          <el-table-column prop="no" label="样带编号" width="100" />
          <el-table-column label="站位" width="80">
            <template #default="{ row }">{{ siteNoOf(row.siteId) }}</template>
          </el-table-column>
          <el-table-column label="覆盖率" width="100" align="right">
            <template #default="{ row }">
              <span class="gb-mono">{{ beltStats(row).coveragePct }}%</span>
            </template>
          </el-table-column>
          <el-table-column label="白化评定" width="150">
            <template #default="{ row }">
              <BleachTag :level="beltStats(row).grade" size="small" />
              <span class="gb-hint gb-mono"> {{ beltStats(row).bleachIndex }}</span>
            </template>
          </el-table-column>
          <el-table-column label="审核结论" min-width="200">
            <template #default="{ row }">
              <template v-if="openRejectOf(row.id)">
                <el-tag size="small" type="danger" effect="plain">已驳回</el-tag>
                <span class="gb-hint"> {{ openRejectOf(row.id)?.reason }}</span>
              </template>
              <span v-else class="gb-hint">通过（默认）</span>
            </template>
          </el-table-column>
          <el-table-column v-if="activeReview.status === 'pending'" label="操作" width="150" fixed="right">
            <template #default="{ row }">
              <el-button
                v-if="!openRejectOf(row.id)"
                size="small"
                type="danger"
                plain
                @click="rejectBelt(row)"
              >
                驳回
              </el-button>
              <el-button v-else size="small" @click="withdrawReject(openRejectOf(row.id)!)">撤销驳回</el-button>
            </template>
          </el-table-column>
        </el-table>

        <template v-if="activeReview.status === 'pending'">
          <el-form label-width="90px" class="page__sign">
            <el-form-item label="审核人" required>
              <el-input v-model="signForm.reviewer" placeholder="如：顾审言" maxlength="20" />
            </el-form-item>
            <el-form-item label="审核意见">
              <el-input v-model="signForm.comment" type="textarea" :rows="2" placeholder="选填" maxlength="120" />
            </el-form-item>
          </el-form>
        </template>
        <template v-else>
          <el-descriptions :column="1" border size="small">
            <el-descriptions-item label="审核人">{{ activeReview.reviewer || '—' }}</el-descriptions-item>
            <el-descriptions-item label="审核意见">{{ activeReview.comment || '—' }}</el-descriptions-item>
            <el-descriptions-item label="签发时间">
              <span class="gb-mono">
                {{ activeReview.signedAt ? new Date(activeReview.signedAt).toLocaleString('zh-CN') : '—' }}
              </span>
            </el-descriptions-item>
          </el-descriptions>
        </template>
      </template>

      <template #footer>
        <el-button @click="reviewDialogVisible = false">关闭</el-button>
        <el-button
          v-if="activeReview && activeReview.status === 'pending'"
          type="primary"
          :icon="Stamp"
          :loading="busy"
          :disabled="activeReconcile !== null && !activeReconcile.ok"
          @click="signReview"
        >
          签发审核单
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

.page__meta {
  margin-top: 12px;
}

.page__belts {
  margin-top: 12px;
}

.page__sign {
  margin-top: 14px;
}
</style>
