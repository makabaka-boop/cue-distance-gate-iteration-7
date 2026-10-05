# 舞台监督工作台

两个相互独立的 Web 入口共用一套服务：

1. **演出场次控制台**：舞台监督创建场次（`待演`），开演后进入 `运行中`，
   可在运行与暂停间切换，运行时逐条登记整数 cue，结束后查看**封存的只读时间线**。
   创建时**可选**附带一份固定的计划 cue 序列与容许距离 K：此后每提交一条现场
   cue，服务端按插入/删除代价增量维护「现场前缀 ↔ 各计划前缀」的距离边界
   （`min_j D(live[0..i), plan[0..j))`，带状 DP，每 cue O(K)），最小值 ≤ K 即
   **仍可追回**，> K 即**已超出容许范围**（边界单调、不可回落）；结束场次时再与
   **完整计划**比较给出最终距离（≤ K 时为精确整数）或 `exceeded`。未附计划的
   旧场次不返回任何偏差状态，保持原流程。计划仅在创建时封存，此后页面草稿的改动
   只能影响下一次创建。
   所有变更携带 `expectedVersion`（乐观并发）与 `requestId`（请求去重），
   经单场次串行裁决后一次提交；被拒绝时数据、版本与距离边界均保持不变。
2. **Cue 序列偏差校验**：在开演间隙核对**计划 cue 序列**与**现场触发序列**
   的偏差是否在容许阈值内。序列为 32 位有符号整数数组（各 ≤ 50000 项），
   阈值 K 为 0–500 的整数。

## 距离定义与算法

- 元素仅按**整数相等**比较；插入、删除各计 1，**替换计 2**（等价于删除+插入）。
- 真实距离 ≤ K 时返回**精确整数**；超过 K 时只返回 `exceeded` 信号。
- 核心实现（`server/src/distance.ts`）是**对角带有界动态规划**：任何满足
  |i − j| > K 的格子距离必然大于 K，不可能出现在预算内的最优路径上，
  因此只计算 |i − j| ≤ K 的带状区域。
  - 时间 O((n + m) · K)：50000 项、K = 500 时约 5×10⁷ 次基本操作；
  - 内存 O(m)：两行滚动数组（约 400 KB），**不构造 O(nm) 矩阵**；
  - 长度差 |n − m| > K 时直接判定超限；
  - 不调用任何差异比较库。

## 服务组成

| 服务     | 说明 |
| -------- | ---- |
| `server` | Fastify API（容器内 3000 端口）：距离校验 + 场次命令裁决（内存存储） |
| `web`    | React 静态页 + nginx `/api` 反向代理，宿主端口由 `WEB_PORT` 覆盖（默认 8080） |
| `verify` | 一次性验收服务：参考值、5 万项样本、越界结论、场次全生命周期（经 Web 代理）、计划场次的逐条前缀边界（短序列完整 DP 预言机）/终局结论/暂停重试/拒绝与重放不推进/跨场次隔离/旧场次兼容、同步屏障交错的跨场次全局 requestId 去重（两场次 / 创建与修改 / 已提交后换目标）、宿主端口覆盖 |

## 运行（Docker Compose）

```bash
# 启动 Web 与 API（宿主端口默认 8080，可用 WEB_PORT 覆盖）
WEB_PORT=9000 docker compose up --build web

# 跑一次性验收（自动拉起依赖，退出码即验收结果）
docker compose up --build --exit-code-from verify verify
```

浏览器访问 `http://localhost:${WEB_PORT:-8080}`，默认进入「演出场次控制台」页签：
填写名称即可创建场次，随后开演 / 暂停 / 继续 / 结束，运行中逐条登记整数 cue，
结束后时间线封存为只读；也可以粘贴场次 ID 重新载入快照（等价于刷新页面）。
另一页签保留原有的「Cue 序列偏差校验」：两个 JSON 数组编辑区 + 阈值 K，
点击「比较」后显示精确偏差距离或超限信号。

## API

### `POST /api/distance`

请求体（标准 JSON 基础类型，不解释文本格式）：

```json
{ "a": [101, 102, 103], "b": [101, 103], "k": 3 }
```

- `a` / `b`：32 位有符号整数数组，长度各 ≤ 50000；
- `k`：整数，0 ≤ k ≤ 500。

响应（200）：

```json
{ "status": "ok", "distance": 1, "k": 3, "lengths": { "a": 3, "b": 2 } }
{ "status": "exceeded", "k": 3, "lengths": { "a": 3, "b": 2 } }
```

错误响应（稳定错误码，4xx）：

```json
{ "error": { "code": "INVALID_ELEMENT", "message": "..." } }
```

| 状态码 | code | 含义 |
| ------ | ---- | ---- |
| 400 | `INVALID_JSON` | 请求体不是合法 JSON |
| 400 | `INVALID_BODY` | 顶层不是对象或字段缺失/类型不符 |
| 400 | `INVALID_ELEMENT` | 元素非 32 位有符号整数 |
| 400 | `ARRAY_TOO_LONG` | 数组超过 50000 项 |
| 400 | `INVALID_K` | K 非 0–500 整数 |
| 413 | `PAYLOAD_TOO_LARGE` | 请求体过大 |

另有 `GET /api/health` 返回 `{ "status": "ok" }`。

## 演出场次 API

会话保存在服务端内存中（单实例）。场次字段：`id`、`name`、`status`、
`version`、`requestId`（最近一次已提交命令的请求标识）、有序 `cues`。

状态机（非法迁移一律拒绝）：

```
pending ──▶ running ◀──▶ paused
               │            │
               └──▶ ended ◀──┘   （ended 为终态）
```

### `POST /api/performances/commands`

统一命令入口（React 端唯一的写入入口），每个命令都带 `requestId`；
除创建外都带 `expectedVersion`。

创建场次（服务端生成 ID，初始 `pending`、`version = 1`）：

```json
{ "command": "create", "name": "9 月 17 日晚场", "requestId": "uuid-1" }
```

创建时可选封存一份计划 cue 序列与容许距离 K（两者必须同时提供；`planCues`
为 32 位有符号整数数组、≤ 50000 项，允许空数组 `[]`；`k` 为 0–500 整数）。
省略两者即创建不带偏差校验的旧场次；只给其一会返回 `INVALID_BODY`，坏元素 /
超长数组 / K 越界分别返回 `INVALID_ELEMENT` / `ARRAY_TOO_LONG` / `INVALID_K`：

```json
{ "command": "create", "name": "9 月 17 日晚场", "requestId": "uuid-1",
  "planCues": [101, 102, 103], "k": 3 }
```

状态推进（`status` ∈ `running` / `paused` / `ended`）：

```json
{ "command": "transition", "performanceId": "<id>", "status": "running",
  "expectedVersion": 1, "requestId": "uuid-2" }
```

登记 cue（`cue` 为 32 位有符号整数，仅 `running` 可写入，追加到有序时间线）：

```json
{ "command": "registerCue", "performanceId": "<id>", "cue": 101,
  "expectedVersion": 2, "requestId": "uuid-3" }
```

成功响应（200）返回提交后的快照：

```json
{ "status": "ok",
  "performance": { "id": "...", "name": "...", "status": "running",
    "version": 3, "requestId": "uuid-3", "cues": [101],
    "plan": { "cues": [101, 102, 103], "k": 3 },
    "deviation": { "k": 3, "plannedLength": 3, "liveLength": 1,
      "boundary": 0, "recoverable": true, "final": null } } }
```

快照新增两个字段（旧场次恒为 `null`）：

- `plan`：创建时封存的 `{ cues, k }`，场次存活期间永不改变；
- `deviation`：逐条距离状态——
  - `boundary`：`min_j D(现场已听全部前缀, 计划前缀 j)`，代价 > K 时封顶为 `K + 1`；
  - `recoverable`：`boundary ≤ K`，即「仍可追回」；每条**成功提交**的 cue
    将其推进一格，拒绝、重放、暂停均不推进；
  - `final`：运行/暂停时为 `null`；场次结束后为与**完整计划**比较的结论，
    `{ "status": "ok", "distance": d }`（d 为精确整数）或 `{ "status": "exceeded" }`。

裁决规则（命令先经**全局 requestId 串行槽**，再进入该场次的串行队列，
在槽内原子完成「读取—校验—写入」，要么提交一次，要么拒绝且数据、版本不变）：

- `expectedVersion` 与当前版本不一致 → `VERSION_CONFLICT`；
- 状态不在合法迁移表内 → `ILLEGAL_TRANSITION`；
- 非 `running` 态登记 cue → `NOT_RUNNING`；
- `requestId` **在整个服务生命周期内全局唯一**：同一标识无论打向哪个场次
  （或用于创建），都只对应一次成功提交。已提交标识的任何重放——换另一场次、
  换一个不存在的场次、或改作创建命令——一律返回 `DUPLICATE_REQUEST`，拒绝信息
  稳定指向该标识**首次提交归属的场次**，与重放目标无关，且没有任何副作用
  （不会新建场次，目标场次的状态、版本、cue 均不变）。跨场次并发同标识时，
  败方同样得到 `DUPLICATE_REQUEST`，不改变任一场次。仅**被拒绝**（版本冲突 /
  非法迁移 / 非运行态等）的标识不会被记录，更正条件后仍可复用同一标识提交。

### `GET /api/performances/:id`

React 端唯一的读入口，按 ID 载入快照（刷新页面后据此恢复）：

```json
{ "status": "ok", "performance": { "...": "..." } }
```

### 场次相关错误码

| 状态码 | code | reason | 含义 |
| ------ | ---- | ------ | ---- |
| 404 | `SESSION_NOT_FOUND` | — | 查询或命令引用了不存在的场次（已提交过的 requestId 除外：其重放优先返回 `DUPLICATE_REQUEST`，即使目标场次不存在） |
| 409 | `COMMAND_REJECTED` | `ILLEGAL_TRANSITION` | 非法状态迁移 |
| 409 | `COMMAND_REJECTED` | `NOT_RUNNING` | 非运行态登记 cue |
| 409 | `COMMAND_REJECTED` | `DUPLICATE_REQUEST` | 请求标识重复 |
| 409 | `COMMAND_REJECTED` | `VERSION_CONFLICT` | `expectedVersion` 过期 |
| 400 | `INVALID_BODY` / `INVALID_CUE` / `INVALID_JSON` | — | 命令信封非法 |

错误体形如 `{ "error": { "code": "COMMAND_REJECTED", "reason": "VERSION_CONFLICT", "message": "..." } }`。

## 本地开发

```bash
# 服务端：类型检查 + Vitest（算法边界、随机对拍、5 万项样本、API 校验、
# 场次状态机、同版本并发仅一条提交与重复请求无副作用）
cd server && npm install && npm test

# 前端（开发服务器代理 /api 到 localhost:3000）
cd web && npm install && npm run dev
```
