# AGENTS.md — 果冻校园内置游戏 / 猫鼠追缉令

> 给 Codex 的项目上下文。每次新任务先读本文件，再读 `TASKS.md` 和 `HANDOFF.md`。
> 目的：不靠聊天记忆，也能接上上一次的进度。

## 1. 项目事实

- 项目路径：`D:\果冻校园内置游戏`
- 产品：微信 H5「猫鼠追缉令」校园追光计划；单校区，西安欧亚学院。
- 计划首场：2026-11-23 06:30；早场 06:30–08:10，晚场 17:30–20:30。
- 技术栈：Vue 3 + Vite + TypeScript + Leaflet；可选高德 JS API 2.0；Node 24 HTTP 服务；本地 SQLite 预览。
- 包管理器：pnpm；本地预览端口 4173。
- 现有状态：**游戏业务已完成，但只是本地预览，不是生产多人版**。
- 高德 Key/安全密钥：`.env.local` 已配置（非空）；**不要读取、打印、提交或修改 `.env.local`**。

## 2. 目录地图

```text
src/
  App.vue                 页面骨架/导航/弹窗
  composables/useGame.ts  前端状态；当前是 1s/5s 轮询
  components/             CampusMap / CatPanel / MousePanel / ScanDialog / Leaderboard / Records
  map/amap.ts             高德底图；serviceHost 代理
  data/campus.json        校区围栏、区域、演示点
server/
  index.mjs               静态服务 + /api + /_AMapService 代理
  api.mjs                 preview API；无 admin/auth/export
  game.mjs                游戏规则/抓捕/积分/榜单
  database.mjs            SQLite 表结构（预览）
  rules.mjs               场次/积分/排序常量
  rules.test.mjs          node:test 规则测试
public/                   地图/素材
.campus/preview.sqlite3   本地预览数据库（不要读/提交）
```

## 3. 已经有的能力（不要重写）

- 猫/鼠双端 H5 UI；校园地图/围栏/鼠迹区域。
- 动态二维码：`qrcode` 生成、`jsQR` 扫描、30 秒过期、成功后换码。
- 规则：同场同猫同鼠一次；100 米体力；同一区域 30 秒内 5 次后冷却；每场 100 分、每天 200 分。
- 排行榜、运动记录、规则页、AMap 代理。
- `pnpm test` 有基础规则测试。

**不要重写这些业务；P0 只补生产运行层。**

## 4. 当前真正缺的 P0（详见 TASKS.md）

1. **真实多人实时位置**：`players`/`progress` 没有经纬度；地图只有固定区域 + 个人演示点；`useGame.ts` 是轮询；没有 WebSocket/Redis。
2. **服务端抓捕距离校验**：`capture()` 只校验 code/场次/重复/体力/区域冷却；没有双端坐标、accuracy、30m、校园围栏。
3. **真实身份/报名**：当前 cookie 演示账号；没有微信 OAuth/学校 SSO；没有姓名/学号/年级/学院/班级/电话/邮箱。
4. **生产数据/并发**：只有本地 SQLite；没有 MySQL/Redis、唯一索引、乐观锁、迁移/备份。
5. **后台/导出**：没有教师任命鼠、Top20 邮件、约谈、按班级 xlsx 导出。
6. **安全/压测**：没有限流、审计、精确位置隐私、2000 峰值压测。

## 5. 硬约束

- **不重写游戏业务**：H5、规则、积分、二维码、榜单保持现有实现。
- **不换框架**：不引入 React/Next、不引入微服务/K8s、不接 Traccar/Hauk/Reitti/PhoneTrack（除非我明确说 P1）。
- **不改规则/数值**：每场 100/每天 200、100 米体力、5 次/30s、同场同鼠一次；要改先问。
- **不提交密钥**：`.env.local` 不动；只更新 `.env.example`。
- **新增依赖**：每个任务不超过 3 个；超过先问。
- **不读大目录**：`node_modules`、`dist`、`.campus/*.sqlite3`、完整设计文档不要读。
- **需要规则时**：只读 `C:\Users\Jerry\Documents\deepseek-harness\default-workspace\campus-cat-mouse\01-完整设计文档.md` 的指定章节，不要整份读。
- **不改 `.env.local`、不打印其内容**。

## 6. 工作方式（省 Token）

- 每次只做一个 `P0-x`；不要一次把 TASKS.md 全做完。
- 先读相关文件，输出 **5 行计划**，不要写代码。
- 我回复「执行」后，只改任务卡允许的文件，做**最小 diff**。
- 不全量重写文件，不顺手重构无关代码。
- 只跑目标测试；失败日志只贴最后 30 行。
- 完成后只输出：改动文件、测试命令/结果、风险、下一任务。
- 新任务开始时先读 `HANDOFF.md`；完成后更新它（5 行以内）。

## 7. 常用命令

```powershell
cd D:\果冻校园内置游戏
pnpm dev          # 本地预览 http://127.0.0.1:4173/
pnpm test         # node:test 规则测试
pnpm build        # vue-tsc + vite build
pnpm start        # 构建后本地服务 + preview API
```

> 不要反复全量 build；开发中只跑目标测试，最后再 build。

## 8. 参考地址

官方/包（需要时看，不要 clone 大项目）：

- Socket.IO：https://socket.io/docs/v4/ · https://github.com/socketio/socket.io
- Redis adapter：https://socket.io/docs/v4/redis-adapter/
- Redis GEO：https://redis.io/docs/latest/commands/geosearch/
- node-redis：https://github.com/redis/node-redis
- ioredis：https://github.com/redis/ioredis
- mysql2：https://github.com/sidorares/node-mysql2
- Turf.js：https://github.com/Turfjs/turf
- ExcelJS：https://github.com/exceljs/exceljs
- Nodemailer：https://github.com/nodemailer/nodemailer
- rate-limiter-flexible：https://github.com/animir/node-rate-limiter-flexible
- openid-client：https://github.com/panva/openid-client
- 微信网页授权：https://developers.weixin.qq.com/doc/offiaccount/OA_Web_Apps/Wechat_webpage_authorization.html
- Playwright：https://github.com/microsoft/playwright
- k6：https://github.com/grafana/k6

只读参考（**先不要接、不要读源码**）：

- Hauk：https://github.com/bilde2910/Hauk
- Traccar：https://github.com/traccar/traccar
- Reitti：https://github.com/dedicatedcode/reitti
- PhoneTrack：https://github.com/julien-nc/phonetrack
- Tile38：https://github.com/tidwall/tile38

## 9. 当前下一步

`P0-0` 已完成。下一步按 `TASKS.md` 顺序：

1. `P0-1a`：Redis + positions 最小底座（先 SQLite，不做 MySQL）
2. `P0-3`：Socket.IO + Redis GEO 实时位置
3. `P0-4`：服务端距离/围栏/场次校验
4. `P0-1b`：MySQL 完整迁移
5. `P0-2` → `P0-5`/`P0-6` → `P0-7`

时间不够时优先 `P0-1a`、`P0-3`、`P0-4`。
