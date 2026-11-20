# TASKS.md — 生产 P0 任务清单

> 每次只做一张任务卡；做完在 `HANDOFF.md` 写 5 行，再开下一个。
> 不要一次把 P0-0 到 P0-7 全做完。

## 状态总览

| ID | 任务 | 状态 | 优先级 |
|---|---|---|---|
| P0-0 | 工程基线与上下文 | [x] 已完成 | 已完成 |
| P0-1a | Redis + positions 最小底座 | [x] 已完成 | 已完成 |
| P0-1b | MySQL 完整迁移 | [x] 已完成 | 已完成 |
| P0-2 | 微信 OAuth + 学校身份 + 报名 | [x] 已完成 | 已完成 |
| P0-3 | Socket.IO + Redis GEO 实时位置 | [x] 已完成 | 最高（P0-1a 后） |
| P0-3b | 高德实时标记与定位说明 | [x] 已完成 | P0-3 补丁 |
| P0-3c | 后续人工验证 | [ ] 待人工验证 | 本次跳过，P0-4 可继续 |
| P0-4 | 服务端距离/围栏/场次校验 | [x] 已完成 | 最高 |
| P0-5a | 猫/鼠里程与积分结算 | [x] 已完成 | 已完成 |
| P0-5b | 教师后台/Top20/邮件/约谈 | [x] 已完成 | 已完成 |
| P0-6 | 按班级导出 xlsx | [x] 已完成 | 已完成 |
| P0-7a | 限流/审计/隐私/清理 | [x] 已完成 | 已完成 |
| P0-7b | 2000 并发压测与容量报告 | [ ] 未开始 | 下一步 |

## 时间现实

这套是生产级 P0，**不是 4 天能全部做完的**。  
如果 2026-11-23 必须上线，优先：`P0-0` → `P0-1a` → `P0-3` → `P0-4`；`P0-1b` 放 P0-4 后。  
`P0-2` 用名单/微信授权兜底；`P0-5a` 先做；`P0-5b`/`P0-6` 能手工就手工；`P0-7` 至少做限流 + 500 并发压测。

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

### P0-3b 高德实时标记与定位说明

改动限于 `src/map/amap.ts`、`src/components/CampusMap.vue` 和 `src/App.vue` 的定位文案。双底图共享 WGS84 坐标，高德在绘制时转 GCJ-02。切换时同步当前标记，隐藏、过期、暂停共享、离线或活动结束时清除相应标记。

Chrome 和 Edge 使用临时 SQLite 与高德 SDK 测试替身验证了双底图切换、标记清除和规则文案。隔离 `pnpm build` 通过。

---

## P0-4：服务端距离/围栏/场次校验

**目标**：让现有 `capture()` 真正校验“人在现场”，不改变积分规则。

**允许改**：`server/game.mjs`、`server/rules.mjs`、`server/api.mjs`、`server/database.mjs`、`server/live/positions.mjs`、`server/rules.test.mjs`、`server/capture.test.mjs`、`package.json`、`pnpm-lock.yaml`。

**要做**
1. 双端坐标 + `accuracy` 校验。
2. 30m 距离 + 校园多边形围栏。
3. 同场同猫同鼠 1 次。
4. 100m 体力、5 次/30s 格锁。
5. 幂等/错误码：`SESSION_DUP` / `DISTANCE` / `ACCURACY` / `LOCK` / `STAMINA`。

**验收**：>30m 拒绝；低精度拒绝；重复拒绝；跨场可再抓；测试通过。  
**不要**：改每场 100/每天 200 的规则。

---

## P0-5a：猫/鼠里程与积分结算

**目标**：先建立“有效里程 + 猫配速门槛 + 猫鼠里程档位 + 停摆作废”的数据与结算基础。

**允许改**：`server/db/*`、`server/database.mjs`、`server/live/positions.mjs`、`server/game.mjs`、`server/rules.mjs`、`server/api.mjs`、`server/auth/*` 的资料接线、`server/index.mjs` 和结算调度、相关测试、`.env.example`、`package.json`/`pnpm-lock.yaml`（如需）。H5 接线限 `src/App.vue`、`src/model.ts`、`useGame.ts`、登录/报名/资料补录、`CampusMap.vue` 及运动记录、积分上限和演示入口的相关组件。

**已定规则**
1. 猫：首次点「开始参与」开始计时；暂停/退出时间仍计入截止时间；完成后剩余时间自由。
2. 猫本场门槛：
   - 早场 2km：男 ≤17:00，女 ≤20:00
   - 晚场 3km：男 ≤25:30，女 ≤30:00
3. 鼠：跑满全场；本场累计暂停 <15 分钟算跑满；不要求配速。
4. 里程档位（累加，不替换）：
   - 猫：2km +1；额外满 6km（总 8km）+3；满 10km +10；单场最高 14。
   - 鼠：3km +1；额外满 6km（总 9km）+3；满 10km +10；单场最高 14。
   - 6km 的 +3 在 10km 时仍保留。
5. 鼠跑满全场：+100 基础分；再叠加里程档位（最高 114/场）。
6. 猫未过门槛：本场里程 + 本场抓捕积分作废；写负向流水/审计；鼠不受配速门槛限制。
7. 积分上限：每场 120、每天 250；所有来源计入；不再使用 0.5/0.125 碎分。
8. 鼠未跑满仍按实际有效里程领档位分。迟到、主动暂停和退出后的离场时间计入跑满判定，累计少于 15 分钟才给基础分。
9. 前台持续定位。页面隐藏、微信挂起或 GPS 中断时保持计时并停止计程，记录 `data_gap` 供结算后复核。基础分按实际参与状态授予，定位空档不计入 15 分钟额度。完整冲销已消费积分产生的负余额，由后续积分抵扣，可用额最低为 0。

**要做**
1. `users.gender` 迁移默认 `unknown`。报名采集 `male` 或 `female`，老账号登录后补录再参与。
2. `participation_sessions`：started_at/ended_at/status/paused_total_seconds/valid_meters/required_meters/max_seconds/completed_at。
3. `daily_mileage` 或按场汇总：位置上报时过滤 accuracy、跳点、超速、跨场、暂停；增量累计；事务更新。
4. 北京时间 08:10 和 20:30 触发结算，启动时补算未结算的已结束场次。按 `session_settlements` 唯一键和数据库事务锁防止多实例重复记账。
5. 测试：正常/低配速/暂停/退出、鼠未跑满、档位累加、10km 额外 +10、6km 仍保留、上限、重复结算、SQLite+MySQL。

**验收**：规则表与结算可复算；作废可审计；SQLite + MySQL 测试通过；不改 H5 学生端视觉。

---

## P0-5b：教师后台 + Top20 邮件/约谈

**目标**：在现有 H5 同一入口提供教师受保护视图；完成 10 鼠任命、Top20、邮件、面谈与次日生效。

**允许改**：`server/admin/*`、`server/api.mjs`、`server/database.mjs`、`src/App.vue`、`src/admin/*`、`.env.example`、测试。

**要做**
1. `/admin` 同一 Vue 应用/构建；教师独立凭据 + `role=teacher` JWT + 独立 Cookie；所有 `/api/admin/*` 服务端校验。
2. 教师每天最多任命 10 鼠、可换、记录操作者/时间；首日手动指定。
3. Top20：猫本场有效 + 总抓捕数 → 有效里程 → 最早达成；输出 20 人。
4. 20:40 邮件 + 站内兜底；面谈状态：待约谈/已确认/放弃/顺延；次日 06:30 生效。
5. 表/迁移：mouse_assignments、interview_records、email_outbox、admin_audit；SQLite/MySQL 都要有。
6. 测试：10 人上限、重复任命、排名、邮件去重、状态流转、权限、生效边界；`pnpm build`。

**验收**：教师可任命/换鼠；Top20 正确；邮件不重复；面谈/顺延/次日生效；学生端入口隐藏。

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
