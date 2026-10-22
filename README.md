# 飞翼通 Admin 管理平台

Vue 3 + TypeScript + Vite + Element Plus。包含首页值守看板、平台大屏、订单与任务查询、用户/飞手详情、投诉处置、只读图传监管和系统日志。

## 安装与开发

使用 pnpm 和 `pnpm-lock.yaml`。安装锁定版本使用 `pnpm install --frozen-lockfile`；新增或更新依赖后提交更新的 pnpm 锁文件。建议使用当前维护的 Node.js 22 LTS。

```sh
cd frontend
pnpm install --frozen-lockfile
pnpm dev
```

开发服务默认把 `/api` 和 `/ws` 代理至 `localhost:8081`。可通过 `VITE_API_BASE_URL` 设置 HTTP 接口前缀。生产部署需要配置 API 反向代理及 SPA history fallback，深链接必须回退到 `index.html`。不得把管理员密码、视频签名或后端密钥写入前端环境变量。

## 检查与测试

```sh
pnpm run check          # 契约、ESLint、带覆盖率的单元/组件测试、类型检查和生产构建
pnpm run test:e2e       # 构建后启动生产预览，执行 Playwright 浏览器流程测试
```

首次运行浏览器测试：`pnpm exec playwright install chromium`。本机已有 Chrome 时，PowerShell 可执行 `$env:PLAYWRIGHT_CHANNEL='chrome'; pnpm run test:e2e`。上述命令在 `frontend` 目录内执行；在外层目录启动开发服务可使用 `pnpm --dir frontend dev`。

单元/组件测试使用 happy-dom；浏览器测试使用实际 Vue、Router、Axios 和 Element Plus，HTTP 响应在测试中隔离，退款测试不会调用真实支付渠道。浏览器测试不等于真实后端、TRTC 或支付渠道的联调验收。覆盖率报告在 `coverage/index.html`，浏览器报告在 `playwright-report/index.html`；失败保留截图和 trace。覆盖率最低门槛为 statements/lines 75%、branches 60%、functions 70%。

CI 可依次执行 `pnpm install --frozen-lockfile`、`pnpm run check`、`pnpm exec playwright install --with-deps chromium` 和 `pnpm exec playwright test`。修改接口或业务行为时，提交对应回归用例。

## 页面行为与数据边界

- 管理员登录默认进入首页；从受保护页面进入登录后，成功登录恢复原页面。
- 当前管理员登录契约只返回 access token。过期后清除会话和页签，提示重新登录并保留目标地址，不虚构管理员续期能力。
- 大屏展示真实平台统计及最新 10 条任务、订单、飞手；支持刷新与轮播。首页在册飞手采用管理端分页总数。
- 精确编号（订单号 `MO…`、任务号 `RT…`）直接下推后端精确过滤，不受扫描上限影响；日期、人名等关键字与争议筛选仍受后端接口能力限制，前端扫描订单/任务最多 1000 条、任务索引最多 500 条、待处理投诉最多 1000 条。任何相关扫描截断都会提示结果或信息可能不完整；今日订单未取全时展示“至少 N”。其余精确全量筛选需要后端增加筛选/聚合接口。
- 首页“创建超 24 小时且待验收”按订单创建时间计算；契约未提供进入待验收的时刻，不把该指标称为验收超时。
- 订单基础分页保持服务端页边界，执行中订单仅在当前页内排序优先；CSV 明确导出当前页。
- 退款批准/驳回和无人机启停必须确认；取消不提交。退款金额和最终订单状态由后端决定。前端 ADMIN 路由限制不能替代后端权限与审计。
- 图传播放器按需加载；切换设备/订单忽略旧请求并调用 `/live/leave` 收口本人观看记录（不动推流，区别于 `/live/close`），轮询卸载后停止。首页遥测最多 4 个并发请求，避免轮询叠加。真实视频仍需具备可用设备、直播与服务端凭证。

## OpenAPI 契约（消费侧）

后端契约由 backend 仓导出（`backend/spec/openapi/drone-backend.openapi.json`），本仓 **vendor + sha256 对账 + 生成物入库**。后端发布 `contract-*` Release 时，GitHub Actions 机器人自动开 PR 同步（见 docs 仓库 ADR）。

```
openapi/drone-backend.openapi.json    # vendor 进来的规格（唯一事实源副本）
openapi/drone-backend.openapi.sha256  # 对账文件
src/api/generated/openapi.d.ts        # openapi-typescript 生成物（禁止手改）
src/api/contract.ts                   # 契约类型门面：apiGet/apiPost/apiPut/apiDelete/expectData
```

| 目的 | 命令 |
|---|---|
| vendor + 生成 + 对账 | `pnpm run api` |
| 只对账 sha256 | `pnpm run api:check` |
| 契约/单测门禁 | `pnpm test`（含 `tests/unit/openapi-contract.spec.ts`） |
| 类型门禁 | `pnpm run typecheck`（`pnpm run build` 已包含） |

**契约同步**：后端仓在契约变化时发布 `contract-*` Release 并触发 `repository_dispatch`，`.github/workflows/contract-sync.yml` 自动下载、校验 sha256 并创建 PR。本地手动同步可运行 `pnpm run api`（默认从后端 Release 或 raw URL 拉取）。

写调用点的固定动作：

1. 在 `src/api/modules/*.ts` 里用契约路径写字面量：`apiGet('/webUav/status', { params: { deviceId } })`；
2. 后端结构一律从 `Schemas['…']` 派生（`src/types/*.ts` 只保留前端视图模型）；
3. 把该端点登记进 `tests/unit/openapi-contract.spec.ts` 的 `CALLED_OPERATIONS`——漏登记会让契约门禁失去意义；
4. 端点不存在或参数不符时**先改后端注解并重新导出**，不要在本地绕过。
