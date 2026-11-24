# 校园猫鼠追缉令 H5

西安欧亚学院校园猫鼠追缉令的完整 H5 + Node.js 服务端。

**这个仓库不是只有演示版。** `server/` 是完整服务端，包含 MySQL 持久化、学号/微信身份、实时位置、抓捕、积分结算、教师后台、Top20、成绩导出；`demo` 只是本地体验模式之一。

## 技术栈

- 前端：Vue 3 + Vite + TypeScript + Leaflet / 高德 JS API
- 服务端：Node.js 24、Socket.IO、MySQL 8、Redis（生产推荐）
- 测试：Node test runner、SQLite/MySQL 双路径

## 本地体验

```sh
pnpm install
pnpm dev
```

打开 <http://127.0.0.1:4173/>。
本地预览使用 SQLite，教师入口为 <http://127.0.0.1:4173/admin>。
`mock`/`demo` 模式仅允许在 `development`/`test` 使用。

## 上线运行

### 1. 前置条件

- Node.js 24
- MySQL 8（生产必须，启动时自动迁移）
- Redis 7（生产多实例/限流/实时位置推荐）
- HTTPS 反向代理（Nginx / 云负载均衡）
- 可用的 `CAMPUS_PUBLIC_ORIGIN`

### 2. 构建

```sh
pnpm install --frozen-lockfile
pnpm build
```

`dist/` 是构建产物，本仓库同时保留了一份可直接打开的构建结果；部署时仍建议在服务器上重新构建。

演示数据在 `data/preview.sqlite3`，只含虚构体验账号，不含真实学生信息。

### 3. 环境变量

复制并填写：

```sh
cp .env.example .env.local
```

生产至少需要：

```text
NODE_ENV=production
PORT=4173
CAMPUS_PUBLIC_ORIGIN=https://你的域名
CAMPUS_AUTH_MODE=roster
CAMPUS_JWT_SECRET=<至少 32 字节随机 base64url>
MYSQL_URL=mysql://用户:密码@数据库:3306/库名
CAMPUS_ROSTER_CSV=/绝对路径/roster.csv
CAMPUS_TEACHER_ALLOWLIST=teacher
CAMPUS_TEACHER_PASSWORD_HASHES={"teacher":"<scrypt hash>"}
CAMPUS_TEACHER_JWT_SECRET=<与 CAMPUS_JWT_SECRET 不同的随机值>
REDIS_URL=redis://...
AMAP_JS_KEY=...
AMAP_SECURITY_CODE=...
```

说明：

- `CAMPUS_AUTH_MODE` 支持 `wechat`、`roster`、`mock`、`demo`。
- 生产不要使用 `mock`/`demo`。
- 生产必须使用 HTTPS；`roster` 模式要求 `CAMPUS_ROSTER_CSV` 在项目目录外。
- `CAMPUS_TEST_NOW` 只允许本地验证，production 会直接拒绝启动。
- `.env.local` 已被 `.gitignore` 忽略，禁止提交。

### 4. 启动

```sh
pnpm start
```

服务默认监听 `127.0.0.1:4173`，由 Nginx/负载均衡提供 HTTPS 和公网入口。
MySQL 表结构会在启动时自动迁移。

也可以使用 Docker：

```sh
docker build -t campus-cat-mouse .
docker run --rm -p 4173:4173 --env-file .env.local campus-cat-mouse
```

### 5. 教师入口

- 学生 H5：`https://你的域名/`
- 教师后台：`https://你的域名/admin`

教师可以配置活动开始日期和持续天数；活动开始后只能延长，不能缩短。

## 功能

- 学号 + 姓名 + 手机号后四位登录（当前 `roster` 模式）
- 学生报名、猫/鼠阵营、实时位置共享
- 二维码抓捕、距离/精度/围栏/体力校验
- 场次结算、积分、里程、Top20
- 教师后台、鼠阵营任命、约谈、换人
- 按日成绩导出 + 活动总成绩累计导出（总榜 + 班级 sheet）

## 测试

```sh
pnpm test
```

当前基线：74 通过 / 11 跳过 / 0 失败。MySQL 与 Redis 的跳过项需要对应服务后单独跑。

## 安全与验收

- 不提交真实学生名单、手机号、`.env.local` 或密钥。
- AppSecret、数据库密码、教师密码哈希只放部署环境。
- 2000 并发目前是单机回环压测结果，不等于生产容量结论；上线前必须在目标 HTTPS/MySQL/Redis/微信链路重新压测。
- 真实定位、真实微信/小程序 WebView 仍需真机人工验证。
- 容错优化计划见 [docs/FAULT-TOLERANCE.md](docs/FAULT-TOLERANCE.md)。
- 异步位置写入实验与对比见 [docs/FAULT-TOLERANCE-ASYNC.md](docs/FAULT-TOLERANCE-ASYNC.md)。
- 玩家状态缓存 TTL 实验见 [docs/FAULT-TOLERANCE-CACHE.md](docs/FAULT-TOLERANCE-CACHE.md)。
- Docker/openGauss 环境说明见 [docs/DOCKER-OPENGAUSS.md](docs/DOCKER-OPENGAUSS.md)。

## 目录

```text
src/            H5 前端
server/         Node.js API、鉴权、游戏、后台、导出
server/db/      MySQL / SQLite / 迁移
server/live/    Socket.IO 实时位置
server/admin/   教师后台、Top20、任命
server/export/  XLSX 导出
tests/load/     压测工具与报告
```
