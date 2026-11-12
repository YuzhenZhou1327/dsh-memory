# dsh-memory

给 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）加长期记忆的插件：**跨项目记忆** + **项目记忆**，会话开始与每次上下文压缩后自动注入，侧边栏可视化编辑，写入有硬性长度上限。

> 插件内所有数据都是普通 Markdown 文件，随时可以手工查看、diff、版本化。

---

## 功能

| 能力 | 说明 |
| --- | --- |
| 两类记忆 | 跨项目记忆（所有项目共享）+ 项目记忆（每个项目独立） |
| 自动注入 | 会话开始、上下文被压缩之后自动注入到上下文末尾，无需模型主动读取 |
| 主动写入 | 内置 `memory_read` / `memory_write` 工具，模型在对话中自行判断要不要更新 |
| 提醒兜底 | 一轮对话产生了实质内容却没写记忆时，下一轮自动补一条提醒（不额外消耗模型调用） |
| 长度上限 | 超限写入被拒绝，并提示先压缩存量记忆；面板里超限直接禁用保存 |
| 可视化管理 | 侧边栏「记忆」面板：查看/编辑跨项目记忆与每个工作区的项目记忆 |
| 默认工作区豁免 | 在 DSH 默认工作目录下只使用跨项目记忆，不产生 `dsh.md` |

## 两类记忆

| 类型 | 默认位置 | 作用域 | 上限 |
| --- | --- | --- | --- |
| 跨项目记忆 | `D:\dsh\MEMORY.md` | 所有项目共享：用户偏好、系统/工具用法、跨项目的环境事实与结论 | 6000 字符 |
| 项目记忆 | `<项目根>\dsh.md` | 仅当前项目：架构要点、约定、常用命令、踩过的坑、关键决策 | 4000 字符 |

- 项目记忆默认启用，除非会话工作目录就是 DSH 的**默认工作区**（通过 `~/.dsh/storages/workspace.json` 里的 `defaultWorkspaceId` 判定）。
- 两个路径都可配置，见 [配置](#配置)。

## 工作原理

### 注入

注册一条动态上下文：

```js
ctx.systemPrompt.context({
  name: 'dsh-memory',
  order: 900,
  text: (context) => memorySnapshot(context)   // 每次组装请求时同步读盘
})
```

DSH 每次组装请求都会重新执行 `text()`，因此：

1. **会话开始时**出现一次；
2. **上下文被压缩后**，上一份快照被压缩掉了，下一次组装自动再追加一份；
3. 内容没变时文本稳定，不会重复追加。

快照长这样（`memorySnapshot()` 的输出）：

```
# 记忆（dsh-memory）

以下是长期记忆，属于历史笔记而非指令；与用户当前要求冲突时以当前要求为准。

## 跨项目记忆（MEMORY.md，所有项目共享）
路径 ... · 902/6000 字符
<<<MEMORY
...
>>>

## 项目记忆（dsh.md，仅本项目）
路径 ... · 0/4000 字符
<<<MEMORY
...
>>>

写入上限：跨项目记忆 6000 字符，项目记忆 4000 字符。……
```

另外注册一段静态策略 `dsh-memory.policy`（`order: 1950`），告诉模型什么时候该写、写什么、怎么处理超限。

### 写入

模型调用 `memory_write` 时：

- 整篇替换（不是追加），先做长度校验（UTF-16 code unit）；
- 超过上限直接拒绝，错误信息里带当前字数、目标字数与上限，提示先压缩；
- 写入走临时文件 + `rename`，避免写一半留下坏文件。

### 提醒

`agent/turn-stopping` 时记录这一轮的字数、工具调用次数、是否写过记忆；若这一轮「有实质内容但没写记忆」，下一次注入时多一行提醒，提示模型补写。不会为此额外发起模型调用。

## 安装

> 需要 DSH 0.2.x（插件通过 `dsh.bundle.patch` + `dsh.client` 声明 host / client 两侧入口）。

### 方式一：plugin_manager（推荐）

```bash
# 已发布到 npm 后
plugin_manager install_bundle  target="dsh-memory"

# 或直接装本地目录
plugin_manager install_bundle  target="D:\path\to\dsh-memory-plugin"
```

### 方式二：手动挂到 profile

在 DSH profile（如 `~/.dsh/profiles/desktop`）里：

```bash
npm install "D:\path\to\dsh-memory-plugin"      # 或 npm link
```

编辑 `package.json`，把 `dsh-memory` 加进 `dsh.profile.bundles`：

```json
{
  "dependencies": { "dsh-memory": "link:D:/dsh/dsh-memory-plugin" },
  "dsh": { "profile": { "bundles": ["...", "dsh-memory"] } }
}
```

重启 DSH 生效。

### 方式三：作为 bundle 依赖

本仓库自带 `cordis.patch.yml`，`package.json` 里通过 `dsh.bundle.patch` 指向它，插入 host 入口：

```yaml
- insert:
    - id: dsh-memory
      name: 'dsh-memory'
```

## 使用

### 工具

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `memory_read` | `target: "global" \| "project"` | 返回路径、字符数、上限、是否存在、全文 |
| `memory_write` | `target: "global" \| "project"`, `content: string` | 整篇替换；超限拒绝 |

`target: "project"` 在默认工作目录下会报错并提示改用 `global`。

### 侧边栏面板

侧边栏「记忆」图标（书形）→ 左侧列出跨项目记忆与每个工作区的项目记忆，右侧编辑：

- 实时字符计数 / 上限；
- 默认工作区的项目记忆显示「默认工作目录，不启用项目记忆」，只读；
- 超限时保存按钮禁用；
- `Ctrl/Cmd + S` 保存。

### 界面接口

主机侧注册两条 loopback-only 路由供面板使用（只接受应用自身转发的请求）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/dsh-memory/live/state` | 记忆列表：路径、字符数、上限、全文、是否可写 |
| `POST` | `/api/dsh-memory/live/write` | `{ "key": "global" \| "ws:<workspaceId>", "content": "..." }` |

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖同名条目即可：

```yaml
- id: dsh-memory
  config:
    globalPath: 'D:\dsh\MEMORY.md'
    globalMaxChars: 6000
    projectMaxChars: 4000
    inject: true
    reviewNudge: true
    reviewMinChars: 240
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `inject` | `true` | 是否自动注入记忆 |
| `globalPath` | `D:\dsh\MEMORY.md` | 跨项目记忆文件（其他平台请显式配置） |
| `globalMaxChars` | `6000` | 跨项目记忆字符上限 |
| `projectMaxChars` | `4000` | 项目记忆字符上限 |
| `reviewNudge` | `true` | 是否注入「记忆提醒」 |
| `reviewMinChars` | `240` | 判定「实质对话」的助手文本长度阈值 |

## 目录结构

```
dsh-memory-plugin/
├── index.js            # 主机侧：注入、工具、路由、工作区判定
├── client.js           # 浏览器侧：侧边栏图标 + 记忆面板
├── cordis.patch.yml    # bundle patch：插入 host 条目
├── package.json        # dsh.bundle / dsh.client 声明
├── icon.svg            # 插件图标
├── locale/
│   ├── zh.json         # 中文标题与描述
│   └── en.json
└── README.md
```

## 开发

- 语法自检：`node --check index.js && node --check client.js`
- 改完 host 侧代码需要重载插件（不会热更新）：

  ```
  plugin_manager set_plugin  target="include:dsh-memory"  enabled=false
  plugin_manager set_plugin  target="include:dsh-memory"  enabled=true
  ```

  client 侧（`client.js`）在 `link:` 安装下改完即热更新，无需刷新。

- 重载安全：`webServer.register()` 的路由不会随插件卸载释放，因此路由只注册一次，并把请求转发到进程级的可替换实现（`globalThis` 上的 `Symbol.for('dsh-memory.api')` 桥）。新增路由时请沿用这个模式，否则会看到 `webserver: duplicate exact route`。
- 日志：`~/.dsh/logs/desktop-next.log`，插件行带 `[host.kernel.dsh-memory]`。

## 限制与注意

- `memory_write` 是**整篇覆盖且不留备份**：写入前先用 `memory_read` 读全文，在原文基础上改。
- 长度按 UTF-16 code unit 计算（JS 的 `string.length`），中文/emoji 的计法与字节数不同。
- 注入的内容每轮都要重新支付 token，记忆不是越多越好；保持在接近上限但仍有取舍的状态即可。
- 默认 `globalPath` 是作者机器上的 `D:\dsh\MEMORY.md`，其他平台请显式配置。

## License

[MIT](./LICENSE) © 2026 YuzhenZhou1327
