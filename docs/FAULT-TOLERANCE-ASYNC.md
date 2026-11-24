# 异步位置写入实验结果

分支：`perf/async-positions`
基线：`68b0f46`（同步位置写 MySQL）

## 改动

- Socket.IO 收到位置后先更新实时索引，再进入 32 个按玩家 ID 分片的写队列；
- 每个分片单 worker，保证同一玩家顺序；
- MySQL 临时失败时队列内重试，不把错误返回客户端；
- 静止/常规路径仍保留同步模式：`CAMPUS_POSITION_WRITE_BEHIND=0` 可完全回滚；
- 生产默认开启，本地/测试默认关闭。

## 全量对比

同一台机器、临时 MySQL 8.0.33 + Redis 8.10.3、4 shard。

| 场景 | 基线 | 异步写入 | 结论 |
|---|---:|---:|---|
| steady-2000 错误 | 0% | 0% | 持平 |
| steady-2000 P95 | 1010ms | 1071ms | 约 +6% |
| steady-2000 P99 | 1480ms | 1912ms | 约 +29% |
| cold-2000 错误 | 8.02% | **6.70%** | 改善 |
| redis-restart 错误 | 0% | 0% | 持平 |
| mysql-slow-query 错误 | **24.04%** | **0.75%** | 大幅改善 |
| mysql-slow-query P95 | 4114ms | **3477ms** | 改善 |
| reconnect-storm 错误 | 6.86% | **6.72%** | 小幅改善 |
| reconnect-storm P95 | 1169ms | 1283ms | 约 +10% |

原始数据：

- `acceptance-async-full.json`
- `fault-async-v3.json`
- `fault-async-mysql.json`

## 判断

收益主要来自 MySQL 慢查询/连接池打满场景：

- 错误率 24.04% → 0.75%；
- P95 4114ms → 3477ms；
- Redis 故障保持 0%；
- 冷启动小幅改善。

代价：

- 稳态 P99 从 1480ms 升到 1912ms；
- 重连 P95 略升；
- 位置最终落库有短暂延迟，实时地图仍由实时索引即时更新。

P99 仍在 2 秒目标内，且故障场景收益远大于稳态代价，因此建议保留异步写入，但保留 `CAMPUS_POSITION_WRITE_BEHIND=0` 作为一键回滚。

## 未解决

- cold-2000 仍有 6.7%；
- reconnect-storm 仍有 6.7%；
- 这两个更偏连接建立/重连阶段，下一步应做握手缓存和重连独立限流，而不是继续调位置写入。
