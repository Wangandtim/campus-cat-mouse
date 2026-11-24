# Docker 与 openGauss 环境说明

## 当前状态

- Docker Desktop 安装包已下载：
  - `C:\Users\Jerry\Downloads\DockerDesktop\Docker Desktop_4.100.1_Machine_X64_exe_en-US.exe`
- Docker Desktop 已安装，Docker CLI 可用：
  - `docker --version` 可使用
- Docker daemon 未启动：
  - `com.docker.service` 处于 Stopped
  - current session 无法启动该服务（需要提升权限）
- WSL2 未安装：
  - `wsl --install` 需要管理员权限
  - 当前 `wsl --status` 提示需要安装 Linux 的 Windows 子系统
- 当前机器 `VirtualizationFirmwareEnabled=False`，需要确认 BIOS/宿主虚拟化。

## Docker 启用步骤（需要管理员）

```powershell
# 管理员 PowerShell
wsl --install
# 重启
winget install --id Docker.DockerDesktop -e
```

安装后启动 Docker Desktop，确认：

```powershell
docker version
docker run --rm hello-world
```

## openGauss

openGauss 没有官方 Windows 原生版，必须运行在 Linux 或 Docker 中。

Docker 可用后，可运行：

```powershell
docker run -d --name opengauss `
  -e GS_PASSWORD=<强密码> `
  -p 5432:5432 `
  enmotech/opengauss:latest
```

注意：当前项目数据库层只支持 MySQL 8 和 SQLite。openGauss 是 PostgreSQL 系，不等于 MySQL，不能只改 `MYSQL_URL` 直接接入。

接入 openGauss 需要：

1. 增加 openGauss/PostgreSQL 驱动；
2. 重写 SQL 方言（迁移、upsert、JSON、时间函数）；
3. 增加双库测试；
4. 完成数据迁移和回归验证。

在这些完成前，生产数据库仍应使用 MySQL 8。
