# 冷启动 / 重连实验与下一步方案

日期：2026-11-24

## 已做实验

### 1. 异步位置写入

3 次重复结果已记录在 [FAULT-TOLERANCE-ASYNC.md](FAULT-TOLERANCE-ASYNC.md)。

- MySQL 慢查询：错误率 26.99% → 0.05%，真实且稳定；
- cold-2000：6.81% → 6.86%，无改善；
- reconnect-storm：中位数都在 6.75% 左右，无显著改善。

结论：异步写入只解决 MySQL 持久化故障，不解决连接建立阶段。

### 2. 提高握手 DB lane 并发

分支 `perf/handshake-capacity`：

```text
handshake 8 → 9
general   6 → 5
总连接预算仍为 40（poolSize=40 时）
```

3 次 `--resilience-only` 结果：

| 场景 | 当前 async 基线 | 提升握手 lane |
|---|---:|---:|
| cold-2000 错误率 | 6.86% | 6.77%（三次 6.82/6.77/6.72） |
| reconnect-storm 错误率 | 6.71% | 13.25%（三次 26.29/6.68/6.78，一次异常拉高） |
| reconnect 中位数 | 约 6.75% | 约 6.78% |

没有稳定收益，**不合并**。已回滚。

### 3. 重连握手直接读缓存

尝试去掉 `cache.get(..., { refresh: true })`，让重连直接使用缓存。

结果：

```text
revalidates each recovered player ... failed
```

这会绕过重连时的账号/角色复核，安全测试不通过。已回滚，不合并。

## 当前结论

- 位置写入异步化：保留（慢查询收益明确）；
- 提高握手并发、跳过握手复核：都不成立；
- cold-2000 和 reconnect-storm 的错误主要发生在连接建立/重连阶段，不是位置写入阶段；
- 下一步不能继续调同一个参数，要单独设计连接网关。

## 下一步方案

### A. 连接网关与会话版本

- 握手不再直接查 MySQL；
- JWT 中带 `sessionVersion`；
- Redis 保存 `user -> {role, stage, sharing, version}`；
- 管理员改角色/学生改共享时递增 version；
- 握手只校验 JWT + Redis version；
- 版本不一致才回源 DB。
- 这样既保留重连复核，又避免每连接查 MySQL。

### B. 冷启动预热

- 活动开始前 5–10 分钟，后台批量预热：
  - MySQL 连接池；
  - Redis 角色/场次缓存；
  - 客户端心跳/场次信息；
- 负载均衡 readiness 检查通过后放流量。

### C. 重连独立限流

- 初始连接和重连分开令牌桶；
- 重连按指数退避 + 抖动；
- 重连优先走缓存；
- 服务端限制单 IP 重连频率；
- 不要提高总 `maxPending`，上一轮实验证明会恶化重连。

### D. 验收

每项都重复 3 次以上，取均值/中位数，并同时报告：

- cold-2000 错误率；
- reconnect-storm 错误率；
- P95/P99；
- 队列/缓存命中率；
- 安全测试结果。

只有 cold/reconnect 错误率稳定低于当前约 6.7%，才合并。
