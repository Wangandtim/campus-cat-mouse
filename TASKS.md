# TASKS.md — 生产 P0 任务清单

> 每次只做一张任务卡；做完在 `HANDOFF.md` 写 5 行，再开下一个。
> 不要一次把 P0-0 到 P0-7 全做完。

## 状态总览

| ID | 任务 | 状态 | 优先级 |
|---|---|---|---|
| P0-0 | 工程基线与上下文 | [x] 已完成 | 已完成 |
| P0-1a | Redis + positions 最小底座 | [ ] 未开始 | 下一步 |
| P0-1b | MySQL 完整迁移 | [ ] 未开始 | P0-4 后 |
| P0-2 | 微信 OAuth + 学校身份 + 报名 | [ ] 未开始 | 高 |
| P0-3 | Socket.IO + Redis GEO 实时位置 | [ ] 未开始 | 最高（P0-1a 后） |
| P0-4 | 服务端距离/围栏/场次校验 | [ ] 未开始 | 最高 |
| P0-5 | 教师后台 + Top20 邮件/约谈 | [ ] 未开始 | 高 |
| P0-6 | 按班级导出 xlsx | [ ] 未开始 | 高 |
| P0-7 | 限流/审计/隐私/2000 压测 | [ ] 未开始 | 高 |

## 时间现实

这套是生产级 P0，**不是 4 天能全部做完的**。  
如果 2026-11-23 必须上线，优先：`P0-0` → `P0-1a` → `P0-3` → `P0-4`；`P0-1b` 放 P0-4 后。  
`P0-2` 用名单/微信授权兜底；`P0-5`/`P0-6` 能手工就手工；`P0-7` 至少做限流 + 500 并发压测。

---

## P0-0：工程基线与上下文

**状态**：已完成（本地基线提交 `e58b0d5`；`pnpm test` 6 项通过，`pnpm build` 通过）。

**目标**：可回滚、可验收；不改功能。

**允许改**：新文件、`.gitignore`；如果环境有 git 就初始化，没有就跳过。

**要做**
1. 确认 `AGENTS.md`、`TASKS.md`、`HANDOFF.md` 存在且内容最新。
2. 建/补 `.gitignore`：`.env.local`、`node_modules/`、`dist/`、`.campus/*.sqlite3*`。
3. 如果 git 可用：初始化并做一次基线提交。
4. 跑 `pnpm test` 和 `pnpm build`，记录基线。

**验收**：基线测试/build 通过；没有功能改动；`HANDOFF.md` 已更新。

---

## P0-1a：Redis + positions 最小底座

**目标**：先让 P0-3 有 Redis 和 positions 表，不做 MySQL 迁移。

**允许改**：`server/database.mjs`、`server/index.mjs`、`server/api.mjs`、`server/live/redis.mjs`、`package.json`、`.env.example`。

**要做**
1. Redis 连接（`redis` 或 `ioredis`），启动时 ping 检查。
2. `positions` 表先加在 SQLite：`user_id, role, lat, lng, accuracy, updated_at`。
3. 最小位置读写接口，供 P0-3 使用。
4. 不改积分/二维码/规则/UI。

**验收**：Redis ping 通过；positions 可写/可查；`pnpm test` 通过；本地预览仍可跑。  
**不要**：做 MySQL 迁移。

---

## P0-1b：MySQL 完整迁移

**目标**：P0-4 跑通后，把预览 SQLite 适配到生产 MySQL 8，保留本地 SQLite 预览。

**允许改**：`server/db/*`、`server/database.mjs`、`server/index.mjs`、`server/api.mjs`、`package.json`、`.env.example`。

**要做**
1. MySQL 连接/迁移。
2. 核心表：`users`（姓名/学号/年级/学院/班级/电话/邮箱）、`event_sessions`、`positions`、`captures`、`points_ledger`、`points_accounts`、`points_session_accounts`、`audit_logs`。
3. 唯一索引：`(event_id, session_id, cat_id, mouse_id)`；乐观锁字段。
4. 保留 SQLite fallback，不影响本地预览。

**验收**：MySQL 启动；迁移可重复执行；`pnpm test` 通过；本地预览仍可跑。  
**不要**：改游戏规则/UI。

---

## P0-2：微信 OAuth + 学校身份 + 报名

**目标**：真实学生身份；不重写现有 H5。

**允许改**：`server/auth/*`、`server/api.mjs`、`server/database.mjs`、`src/App.vue`、新增 `src/components/Register.vue`、`.env.example`。

**要做**
1. 微信 OAuth：code → openid。
2. 学校 SSO/名单 adapter；拿不到接口就 mock + CSV 兜底。
3. 报名字段：姓名、学号、年级、学院、班级、电话、邮箱。
4. JWT；重复绑定/外校/学号不存在处理。

**验收**：新用户可报名；老用户可登录；重复/非法拒绝；测试通过。  
**不要**：改游戏规则/积分/二维码。

---

## P0-3：Socket.IO + Redis GEO 实时位置

**目标**：猫看全部 10 只鼠精确位置；鼠看 300m 内猫；5s 更新；不重写 UI。

**允许改**：`server/live/*`、`server/api.mjs`、`server/index.mjs`、`server/database.mjs`、`src/composables/useGame.ts`、`src/components/CampusMap.vue`、`package.json`。

**要做**
1. `positions` 表 + 位置上报接口。
2. Socket.IO 房间：`event:{id}:cats`、`event:{id}:mice:{mouseId}`。
3. Redis GEO：`GEOADD` / `GEOSEARCH`；猫收 10 鼠，鼠查 300m 内猫。
4. 在线/离线、断线重连、5s 批量推送；位置更新用 `volatile` 丢旧值。
5. 活动窗口外不显示位置；安全屋/离线不显示坐标。

**验收**：两个浏览器互看；猫看到 10 鼠；鼠看到附近猫；断线重连恢复；`pnpm build` 通过。  
**不要**：重写现有地图 UI/规则。

---

## P0-4：服务端距离/围栏/场次校验

**目标**：让现有 `capture()` 真正校验“人在现场”，不改变积分规则。

**允许改**：`server/game.mjs`、`server/rules.mjs`、`server/api.mjs`、`server/rules.test.mjs`。

**要做**
1. 双端坐标 + `accuracy` 校验。
2. 30m 距离 + 校园多边形围栏。
3. 同场同猫同鼠 1 次。
4. 100m 体力、5 次/30s 格锁。
5. 幂等/错误码：`SESSION_DUP` / `DISTANCE` / `ACCURACY` / `LOCK` / `STAMINA`。

**验收**：>30m 拒绝；低精度拒绝；重复拒绝；跨场可再抓；测试通过。  
**不要**：改每场 100/每天 200 的规则。

---

## P0-5：教师后台 + Top20 邮件/约谈

**目标**：老师能任命 10 鼠，系统能发 Top20 邮件并记录约谈。

**允许改**：`server/admin/*`、`server/api.mjs`、`server/database.mjs`、`src/admin/*`、`.env.example`。

**要做**
1. 教师指定/更换 10 鼠。
2. 日榜 Top20：总抓捕数 → 有效里程 → 最早达成；1.5km 门槛。
3. 20:40 邮件；站内/微信兜底。
4. 当日面谈、确认 10 人、放弃顺延、次日生效。

**验收**：10 鼠任命；Top20 邮件；确认/顺延；权限校验；测试通过。  
**不要**：重写现有榜单 UI。

---

## P0-6：按班级导出 xlsx

**目标**：后台生成 xlsx：总榜 + 每个班级 sheet。

**允许改**：`server/export/*`、`server/api.mjs`、`src/admin/*`、`package.json`。

**字段**：排名、姓名、学号、年级、学院、班级、电话、有效里程、积分、抓捕数、参与场次、异常标记。

**验收**：2000 行 <10s；班级 sheet 完整；未参与显示 0；越权拒绝；导出审计。  
**不要**：改积分/榜单规则。

---

## P0-7：限流/审计/隐私/2000 压测

**目标**：生产上线前的安全与容量验证。

**允许改**：`server/security/*`、`server/index.mjs`、`server/api.mjs`、`tests/load/*`。

**要做**
1. 登录/扫码/导出限流。
2. 管理端审计日志。
3. 精确位置仅活动窗口、地图水印、安全屋。
4. k6 2000 模拟客户端（5s 位置）。
5. 监控：连接数、P95、错误率、Redis 延迟、重连次数。

**验收**：2000 并发 P95 <2s、错误率 <1%；无重连风暴；报告。  
**不要**：改游戏规则。

---

## P1（先不要做）

- 积分兑换商城、学分报表、团队/任务/成就。
- 通知中心、内容运营、数据看板。
- Traccar/Hauk/Reitti/PhoneTrack/Tile38 的正式接入或替换。
- 微服务/K8s/新前端框架。

## 执行提醒

- 先读 `AGENTS.md` 和 `HANDOFF.md`。
- 只做我指定的 `P0-x`；先给 5 行计划，不要写代码。
- 只改允许文件，最小 diff；完成后更新 `HANDOFF.md`。
- 不读 `node_modules`/`dist`/完整设计文档；不打印 `.env.local`。
