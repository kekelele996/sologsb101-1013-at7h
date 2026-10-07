# sologsb101-1013 珊瑚礁样带普查与白化分级台

面向礁区生态普查队的纯前端单页应用：按站位布设样带，逐条记录底质、珊瑚分类覆盖与鱼类计数，并评定白化等级。数据全部保存在浏览器本地（IndexedDB），不依赖任何后端服务或外部接口。

**普查队 / 院所审核组两侧分离**：普查队按航次批次管理样带、珊瑚覆盖与鱼类计数；院所审核组只管审核单与驳回条目。礁区覆盖率与白化指数只按院所审过的批次计算，录完未审的数据不进结论。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动完成后访问：**http://localhost:22813**

常用命令：

```bash
docker compose ps                 # 查看容器状态
docker compose logs -f frontend   # 查看 nginx 访问日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 修改代码后重新构建
```

> 宿主端口由 `.env` 中的 `FRONTEND_PORT` 控制（默认 22813）。
> 容器为纯静态 nginx，无数据库服务、不挂载任何命名卷，可随时删除重建。

## 二、技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3.5（Composition API + `<script setup>`） | 页面全部按路由懒加载 |
| 语言 | TypeScript 5.7（strict） | 构建脚本执行 `vue-tsc --noEmit` 类型检查 |
| UI 组件 | Element Plus 2.9 + @element-plus/icons-vue | 中文语言包，表格 / 表单 / 弹窗 / 徽标 |
| 构建 | Vite 6 | 产物 `dist/`，交给 nginx 托管 |
| 状态管理 | Pinia 2（setup store） | `reefStore` / `beltStore` / `surveyStore` / `voyageStore` / `reviewStore` |
| 路由 | Vue Router 4（history 模式） | 路径与提示词逐字一致，支持深链刷新 |
| 持久化 | Dexie 4（IndexedDB，库名 `gbcoralbelt`） | 结构版本 v3 + upgrade 迁移 + liveQuery 订阅 |
| 容器 | node:20-alpine 构建 → nginx:alpine 运行 | 多阶段构建，运行阶段 `chmod -R a+rX` |

## 三、路由与功能模块

| 路由 | 页面 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/reefs` | 礁区台账 | Reef、Site、Belt、CoralRecord | 新建/编辑/删除礁区，按保护区状态与面积分档筛选，卡片汇总站位数、样带数与本礁区平均白化指数（只按审定批次） |
| `/reefs/:id/sites` | 站位列表与水深标记 | Site、Reef、Belt | 新增/编辑/删除站位，经纬度校验（纬度 ±90、经度 ±180）并显示度分秒，按水深区间筛选，展开样带 |
| `/sites/:id/belts` | 样带布设 | Belt、Site、Voyage、CoralRecord、FishCount | 布设样带（编号、长度、朝向、调查日期、调查人、**所属航次**），回显已录记录数、覆盖率、白化指数与批次状态，朝向排序校验 |
| `/belts/:id/corals` | 底质与珊瑚分类计数 | CoralRecord、Belt | 按属名与形态逐条录入覆盖长度与白化等级，汇总覆盖率、白化指数、白化占比与等级分布，批量粘贴、批量改级；提示本样带是否计入结论 |
| `/belts/:id/fishes` | 鱼类与无脊椎动物计数 | FishCount、Belt | 按科名与体长段录入数量，按类别筛选与批量改类别，按科名和体长段汇总并折算密度（尾/100 m²） |
| `/voyages` | 航次批次（普查队） | Voyage、Belt、RejectEntry | 新建/编辑/删除航次，按批次归口样带与记录；提交审核、审核单写失败只重试审核侧；只读展示院所驳回条目 |
| `/reviews` | 院所审核台 | ReviewOrder、RejectEntry、Voyage、Belt | 受理航次开审核单、按航次号与样带编号对账（核不上挂起）、逐条通过/驳回、签发、驳回条目复核销号、重新对账 |
| `/coverage` | 白化等级评定与覆盖度汇总 | 全部模型 | 白化等级分布与按样带/按礁区汇总（**只含审定批次**）、结构版本查看、全量 JSON 导入导出、结论 JSON 导出、清空重建演示数据 |

带 `:id` 的层级路由在直接深链访问时同样可用：若 IndexedDB 中查不到该 id，页面渲染 `<RouteMissingPanel>` 友好空态（含返回入口与可用 id 快捷跳转），不会白屏。

## 四、两侧分离与结论口径

- **普查队侧**（`/voyages` + 各录入页）：航次批次 → 样带 → 珊瑚覆盖 / 鱼类计数。航次状态机：`录入中 → 已提交待受理 → 院所审核中 → 已审定通过 / 部分通过 / 整批驳回`。
- **院所审核侧**（`/reviews`）：只管审核单（一航次一单）与驳回条目，不动普查队的录入数据。
- **结论口径（唯一口径，`utils/scope.ts`）**：一条样带计入礁区覆盖率与白化指数，当且仅当
  1. 所属航次的审核单已签发（通过 / 部分通过）；
  2. 该样带没有未复核的驳回条目 —— **驳回为条目级，只退被驳回的几条**，同航次其余样带照常生效（全部驳回才等于整批退回）；
  3. 批次对账未挂起。
- **对账**：审核单受理时快照航次号与样带编号清单；与普查队当前数据比对，航次号不符或样带编号对不上（提交后增删样带）即挂起，挂起批次不计入结论，「重新对账」刷新快照后解除。
- **失败重试**：提交审核 = 普查队侧置「已提交」+ 院所侧生成审核单两个独立动作；审核单写失败时航次保持「已提交」，已录数据照旧，点「重试受理」只重试审核这侧（`reviews.voyageId` 唯一索引保证重复受理幂等）。
- **导出口径**：复制结论与「导出结论 JSON」和 `/coverage` 页同一口径；全量 JSON 备份则包含全部已录数据（八张表），用于迁移而非结论。

## 五、目录结构

```
sologsb101-1013/
├── README.md
├── docker-compose.yml          # name: gbcoralbelt，不写 version
├── Dockerfile                  # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
├── nginx.conf                  # try_files $uri $uri/ /index.html; + gzip
├── .env / .env.example         # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # 前端独立构建用（同样多阶段 + chmod -R a+rX）
    ├── nginx.conf              # 前端独立托管用
    ├── .dockerignore
    ├── package.json            # build = vue-tsc --noEmit && vite build
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    ├── public/favicon.svg
    ├── scripts/                # 冒烟测试（esbuild 打包后 node 运行，不参与构建）
    └── src/
        ├── main.ts             # 挂载 Pinia / Router / Element Plus，并打开并播种数据库
        ├── App.vue             # 顶部导航 + 上下文快捷入口 + 页脚数据概览
        ├── env.d.ts
        ├── types/              # reef / site / belt / coralRecord / fishCount / voyage / review / filter
        ├── stores/             # reefStore / beltStore / surveyStore / voyageStore（普查队）/ reviewStore（院所）
        ├── components/common/  # BleachTag / FilterBar / StatBadge / EmptyPanel / RouteMissingPanel
        ├── hooks/              # useIdbTable / useCoverage
        ├── pages/              # ReefList / SiteList / BeltBoard / CoralEntry / FishEntry / VoyageBoard / ReviewBoard / CoverageView
        ├── router/index.ts     # 路由表（路径与提示词逐字一致）
        ├── styles/main.css
        └── utils/              # bleach.ts（白化与覆盖度算法）/ scope.ts（结论口径与对账）/ db.ts（Dexie 封装）/ export.ts（导入导出与结论）
```

## 六、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22813
npm run build      # 类型检查 + 生产构建
npm run preview    # 预览构建产物
```

冒烟测试（口径 / 导出 / 迁移 / 审核全流程，不参与构建）：

```bash
cd frontend
npm i --no-save fake-indexeddb   # 迁移与流程测试需要在内存里模拟 IndexedDB
npx esbuild scripts/smoke-scope.ts --bundle --platform=node --format=esm --alias:@=./src --outfile=/tmp/s.mjs && node /tmp/s.mjs
# smoke-export.ts / smoke-migrate.ts / smoke-flow.ts 同理
```

## 七、数据存储说明

- **存储位置**：浏览器 IndexedDB，库名 `gbcoralbelt`，当前结构版本 `v3`。读写统一经 `frontend/src/utils/db.ts` 封装，页面组件不直接触碰 Dexie 实例。
- **数据表**（八张）：普查队侧 `reefs`（礁区）、`sites`（站位）、`voyages`（航次批次）、`belts`（样带）、`corals`（珊瑚记录）、`fishes`（鱼类与无脊椎动物计数）；院所审核侧 `reviews`（审核单，`voyageId` 唯一）、`rejectEntries`（驳回条目）。
- **升级迁移**：`db.version(1)`、`db.version(2)` 保留历史结构，`db.version(3).stores(...).upgrade(...)` 新增审核侧三表与 `belts.voyageId` 索引；**已有数据没记航次，升级时按调查日期分组补归属**（生成 `LEG-<调查日期>` 批次，状态「已提交待受理」，等院所开单审核）。调整字段结构时递增 `DB_VERSION` 并补迁移。
- **首屏播种**：`initDatabase()` 在 `reefs` 表为空时执行幂等播种，生成互相引用的演示数据（3 个礁区 / 4 个站位 / 2 个航次 / 5 条样带 / 14 条珊瑚记录 / 12 条计数记录 / 1 张已签发审核单 / 1 条驳回条目），覆盖「无 / 轻 / 中 / 重 / 死亡」全部白化等级：航次一演示「部分通过 + 条目级驳回」，航次二演示「已提交待受理」。
- **实时同步**：`utils/db.ts` 的 `watchTable()` 基于 Dexie `liveQuery` 订阅表变化，Pinia store 自动刷新，页面只读消费。
- **算法口径**：珊瑚覆盖率 = 覆盖长度合计 / 样带长度 × 100%；白化指数 = 按覆盖长度加权的平均白化等级（无 0 / 轻 1 / 中 2 / 重 3 / 死亡 4，0 ~ 4），并按指数换算总体等级；鱼类密度 = 计数 / （样带长度 × 1 m）× 100（尾/100 m²）。**礁区覆盖率与白化指数只按审定批次内未被驳回、对账未挂起的样带计算**（`utils/scope.ts`）。
- **备份与恢复**：`/coverage` 页可导出包含八张表的 JSON 快照，支持「覆盖导入」与「追加导入（重新分配 id）」；导入旧版（无航次）备份后自动按调查日期补归属；备份时间写入 `localStorage`，页脚与汇总页均展示结构版本号。
- **离线可用**：应用为纯静态资源，无任何网络请求；换浏览器或清空站点数据后数据不跟随，需通过 JSON 备份迁移。
