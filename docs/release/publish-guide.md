# 发布到 GitHub 与 DSH 插件市场

> 目标版本：`0.1.0-alpha.31` → 首个公开发布
> 仓库：`github.com/Railly1983/dsh-meetingstone`

---

## 一、DSH 插件市场的真实机制（先说清楚）

**DSH 没有独立的"插件市场"服务**。官方机制是三者组合：

| 环节 | 做法 | 谁负责 |
|---|---|---|
| 1. 包分发 | 发布到**公开 npm registry** | 你（`npm publish`） |
| 2. 发现入口 | GitHub 仓库加 **`dsh-plugin` topic** | 你（仓库设置里加） |
| 3. 市场展示 | 社区市场（[DSH Plugin Hub](https://dsh-plugin.org)、[dsh.plus](https://dsh.plus)、[DSH Market](https://dshplugin.dev)）定时扫 topic | 自动 |

依据：
- [官方发布文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)：
  > "the core requirement is an installable package: publish it to a public npm registry...
  >  Adding the `dsh-plugin` topic to your repository is the official way to make a plugin discoverable."
- 本机实测：DSH 的 `plugin-manager` 里只有 `registry.npmjs.org` / `registry.npmmirror.com` 两个源，
  `plugin-market` 插件本身只是"发现页"外壳，数据来自市场索引。

**所以：npm publish 是必须的，GitHub topic 是必须的，市场收录会自动发生。**

---

## 二、发布前检查（已完成 ✅ / 待办 ⬜）

| 项 | 状态 |
|---|---|
| 包名可用（`dsh-meetingstone` 未被占用） | ✅ 已查，npm 返回 404 |
| `package.json` 元数据齐全 | ✅ `description` / `repository` / `homepage` / `bugs` / `author` / `license` |
| `keywords` 含 `dsh-plugin` | ✅ |
| `publishConfig.access = public` | ✅ |
| `engines.dsh` 兼容范围 | ✅ `>=0.2.2-rc.1 <0.3.0-0` |
| README 说明用途/安装/用法 | ✅（含新增的「子代理使用建议」） |
| LICENSE（MIT） | ✅ |
| SECURITY.md / CONTRIBUTING.md | ✅ |
| 测试通过 | ✅ 700 tests / 699 pass |
| 门禁通过 | ✅ 10 PASS |
| **npm 已登录** | ⬜ **需要你操作** |
| **GitHub 仓库已建** | ⬜ **需要你建或授权我建** |
| **加 `dsh-plugin` topic** | ⬜ 建完仓库后加 |

---

## 三、需要你做的两件事

### 3.1 npm 登录

当前状态：`npm whoami` → `ENEEDAUTH`（未登录），且 registry 指向 `registry.npmmirror.com`。

**要发布到公开市场，必须用官方 registry 且已登录：**

```powershell
# 1) 切到官方 registry（发布必须）
& "C:\Program Files\nodejs\npm.cmd" config set registry https://registry.npmjs.org/

# 2) 登录（会打开浏览器）
& "C:\Program Files\nodejs\npm.cmd" login
```

> 如果你没有 npm 账号，先去 https://www.npmjs.com/signup 注册（免费）。

**注意**：切 registry 会影响你其他项目的依赖安装速度。
发布完成后可以切回来：

```powershell
& "C:\Program Files\nodejs\npm.cmd" config set registry https://registry.npmmirror.com
```

### 3.2 GitHub 仓库

我无法直接建仓库（本机没装 `gh` CLI，git 也没配置用户信息）。

**方案 A：你在网页建（最快）**

1. 打开 https://github.com/new
2. Repository name 填 `dsh-meetingstone`
3. **不要**勾选 "Add a README"（我们已经有）
4. 创建后告诉我，我来配置 remote 并推送

**方案 B：我装 gh CLI 后帮你建**

需要先装 `gh`（`winget install GitHub.cli`），然后 `gh auth login`。
比方案 A 多两步，但后续操作更顺。

---

## 四、发布步骤（你完成后我执行）

### 4.1 推送 GitHub

```powershell
cd D:\MeetingStone
git remote add origin https://github.com/Railly1983/dsh-meetingstone.git
git branch -M main
git push -u origin main
```

### 4.2 加 `dsh-plugin` topic

仓库页 → 右上齿轮（About）→ Topics 加 `dsh-plugin`

或命令行（需 gh）：
```powershell
gh repo edit Railly1983/dsh-meetingstone --add-topic dsh-plugin,dsh,deepseek-harness,agent,dispatch
```

### 4.3 发布 npm

```powershell
cd D:\MeetingStone
node scripts/release-check.mjs        # 先过门禁
npm publish --registry=https://registry.npmjs.org/
```

首次公开发布，`0.1.0-alpha.31` 会被标记为 `latest`。
如果想让 alpha 不占 latest：

```powershell
npm publish --tag alpha --registry=https://registry.npmjs.org/
```

### 4.4 验证安装

在**干净的 profile** 里验证（避免污染现有环境）：

```powershell
dsh plugin --profile test-install add dsh-meetingstone
```

确认插件能用后卸载。

### 4.5 提交市场收录

- [DSH Plugin Hub](https://dsh-plugin.org) —— 有提交页，人工审核
- [dsh.plus/submit](https://dsh.plus/submit) —— 需要 GitHub 仓库 URL + 分类 + 邮箱
- [DSH Market](https://dshplugin.dev) —— 自动扫 GitHub topic

**审核常见拒绝原因**（来自 [dsh.plus 指南](https://dsh.plus/zh/guides/submit-to-dsh-plus)）：

| 原因 | 我们的情况 |
|---|---|
| README 语焉不详 | ✅ 有完整说明 |
| 无法安装/运行 | ✅ 有安装命令 |
| 与 DSH 无关 | ✅ 注册 10 个工具 + 设置页 |
| 无 LICENSE | ✅ MIT |
| 仓库归档/404 | ⬜ 待建 |
| **缺 `dsh-plugin` topic** | ⬜ 待加 |

---

## 五、发布后要做什么

1. **README 加徽章**（收录后可拿到）
2. **打 tag**：`git tag v0.1.0-alpha.31 && git push --tags`
3. **写 GitHub Release**：贴 CHANGELOG 的 alpha.31 段落
4. **监控 issues**

---

## 六、我建议的版本策略

当前是 `0.1.0-alpha.31`。第一个公开版本建议：

| 选项 | 版本号 | 适用 |
|---|---|---|
| A（推荐） | `0.1.0-alpha.31` 直接发，tag `alpha` | 诚实标注仍是 alpha，给早期用户 |
| B | 升到 `0.1.0` | 正式版，但你说过 D1 视觉验收还没做完 |
| C | `0.1.0-beta.1` | 介于两者之间 |

**我倾向 A** —— 因为：
- D1 视觉验收还没你亲自确认
- 「刷新能力」按钮我还没在真实 GUI 上验证过
- 诚实标注 alpha 比假装正式版好

你要是觉得可以发正式版，我再改。
