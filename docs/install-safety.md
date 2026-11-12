# 安装安全机制（防止插件把 DSH 启动搞崩）

## 背景

DSH Web boot 只要**一个插件 entry 激活失败**，整个应用就会弹「应用无法启动」对话框。
我们的 GUI half 在插件 entry 里执行，历史上两次事故都属于这一类：

1. `apply` 里某个 slot 注册抛错 → entry 不激活 → 启动失败
2. 顶层 `require` 失败 / 远程契约不匹配 → 同上

另外两个操作风险也出现过：

- 手工改 `cordis.patch.yml` 造成双重编码/行丢失；崩溃恢复对话框会把 patch 清空
- 在任务运行中重启 DSH，把任务和命令自身一起杀掉

## 现在的机制

### 1. 客户端入口加固（必须保持）

`src/client/index.js`：

- 顶层 `require('react/jsx-runtime')`、`require('react')` 走 `safeRequire`，失败返回最小 stub
- `apply` 外层包 try/catch：任何异常只记录日志，**绝不让 entry 激活失败**
- 每段 slot 注册独立 guard；单点失败不影响其他面板

### 2. Boot Canary（安装前验证）

```bash
node scripts/boot-canary.mjs --tgz <打包产物>
# 或 npm run boot:canary -- --tgz <tgz>
```

- 用 `--from-default-profile web` 创建**独立模板 profile**（不碰 desktop）
- 安装待验证 tgz → 启动 → 等 `dsh web: http://...` 或失败标志
- 通过：`PASS boot-canary`；失败：打印失败行并退出 1
- 结束后删除临时 profile

### 3. 安全安装 + 自动回滚

```bash
node scripts/install-safe.mjs --tgz <新 tgz> [--previous <旧 tgz>]
# 或 npm run install:safe -- --tgz <tgz>
```

流程：

1. `boot-canary` 必须通过，否则**不安装**
2. 安装到 desktop profile
3. 通过 WMI 启动**脱离 DSH 进程树**的 watcher（`scripts/post-install-watch.ps1`）
   - 原因：安装脚本本身是 DSH 子进程，直接重启会把自己杀掉
4. watcher 重启 DSH，等待 35 秒，检查是否出现新 crash 日志
5. 出现崩溃 → 自动重装旧 tgz 并重启；结果写入 `%TEMP%\ms-install-safe-*.result`（`PASS` / `ROLLED_BACK`）

## 操作规则

1. 发布前**只用** `install:safe`，不手工 remove/add
2. 不在任务运行期间重启/重装
3. 不手工编辑 `cordis.patch.yml`；需要恢复时从 `cordis.patch.yml.bak-*` 复制
4. GUI 改动必须先本地测试全绿，再走 canary
