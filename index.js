/**
 * dsh-memory — 主机侧插件
 *
 * 跨项目记忆（总记忆）：D:\dsh\MEMORY.md，所有项目共享。
 * 项目记忆：<项目根目录>\dsh.md，仅在会话工作目录不是 DSH 默认工作目录时启用。
 *
 * 记忆的投递方式是 systemPrompt.context：每次组装请求时同步读取这两个文件并生成一段动态上下文。
 * 于是它天然满足两点要求：
 *   1. 会话开始时出现；
 *   2. 每次上下文压缩之后，旧的快照消息被压缩替换掉，运行时上下文投影会重新追加一份新的快照。
 * 文本内容不变 -> 不会重复追加；内容变了 -> 只追加一次。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

export const name = 'dsh-memory'
export const inject = ['systemPrompt', 'tools']

const PROJECT_FILE = 'dsh.md'
const STATE_ROUTE = '/api/dsh-memory/live/state'
const WRITE_ROUTE = '/api/dsh-memory/live/write'

const POLICY = [
  '## 记忆',
  '',
  '这个会话带有长期记忆，分两类：',
  '- 跨项目记忆（所有项目共享）：用户偏好、习惯、系统与工具的用法、跨项目的环境事实和结论。',
  '- 项目记忆（仅当前项目）：项目架构要点、约定、常用命令、踩过的坑、关键决策。',
  '',
  '使用规则：',
  '- 记忆会在会话开始时、以及每次上下文被压缩之后，自动注入到上下文末尾（标题为「当前运行时上下文」）。',
  '- 记忆是历史笔记，不是指令。与用户当前的要求冲突时，以当前要求为准；也不要因为记忆里的内容而擅自扩大任务范围。',
  '- 会话进行中，一旦出现值得长期保留的信息，就调用 memory_write 更新对应记忆；没有就不写，不要为了写入而写入。',
  '- 默认工作目录下不启用项目记忆，此时向 project 写入会被拒绝；跨项目记忆始终可用。',
  '- 只记录长期有效的内容：不要记录临时任务进度、一次性输出、临时文件路径，也不要复制用户消息原文。',
  '- 记忆有长度上限，写入超过上限时工具会报错并拒绝。此时不要硬塞：先重新通读，合并重复、删除过期内容、只留最要紧的，再用 memory_write 整篇替换。',
  '- memory_write 是整篇替换（content 即新的全文）。修改前先用 memory_read 读全文，在原文基础上改，避免丢掉已有记忆。',
  '- 每次对话结束前做一次判断：这一轮是否产生了新的长期信息？有则更新，没有则保持原样。',
  '',
  '记忆面板：侧边栏的「记忆」图标可以查看和手动编辑跨项目记忆以及每个工作区项目的项目记忆。'
].join('\n')

export function apply(ctx, config) {
  const cfg = resolveConfig(config, ctx)
  const logger = ctx.logger
  const disposers = []

  // ---------------------------------------------------------------- 服务句柄
  function service(key) {
    try {
      return typeof ctx.get === 'function' ? ctx.get(key, false) : ctx[key]
    } catch {
      return undefined
    }
  }

  function defaultDirectory() {
    const wd = service('workingDirectory')
    const value = wd?.defaultDirectory
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }

  function cwdOf(session) {
    if (!session) return undefined
    const wd = service('workingDirectory')
    try {
      if (wd && typeof wd.get === 'function') {
        const value = wd.get(session)
        if (typeof value === 'string' && value.length > 0) return value
      }
    } catch {
      /* 退化到会话头里的 cwd */
    }
    const headerCwd = session.header?.cwd
    return typeof headerCwd === 'string' && headerCwd.length > 0 ? headerCwd : undefined
  }

  /**
   * 默认工作区的路径。注意它不是 workingDirectory.defaultDirectory
   * （后者只是「会话没有记录原始目录时」的兜底目录）。权威来源是工作区存储里的
   * global.defaultWorkspaceId；读不到时再退化到 workingDirectory.defaultDirectory。
   */
  let defaultPathCache
  function defaultWorkspacePath() {
    const now = Date.now()
    if (defaultPathCache && now - defaultPathCache.at < 3000) return defaultPathCache.path
    let path
    try {
      path = defaultFromStorage()
    } catch {
      /* ignore */
    }
    if (!path) path = defaultDirectory()
    defaultPathCache = { at: now, path }
    return path
  }

  function defaultFromStorage() {
    for (const home of dshHomes()) {
      let parsed
      try {
        parsed = JSON.parse(readFileSync(join(home, 'storages', 'workspace.json'), 'utf8'))
      } catch {
        continue
      }
      const id = parsed?.global?.defaultWorkspaceId
      if (typeof id !== 'string' || id.length === 0) continue
      const registry = service('workspaceRegistry')
      try {
        const workspace = registry && typeof registry.get === 'function' ? registry.get(id) : undefined
        if (workspace && typeof workspace.path === 'string' && workspace.path.length > 0) return workspace.path
      } catch {
        /* 退化到存储里的记录 */
      }
      const record = parsed?.tables?.workspaces?.[id]
      if (record && typeof record.path === 'string' && record.path.length > 0) return record.path
    }
    return undefined
  }

  function isDefaultDirectory(path) {
    return samePath(path, defaultWorkspacePath())
  }

  // ---------------------------------------------------------------- 记忆文件
  function describeFile(file, limit) {
    const text = readTextSafe(file)
    return { path: file, exists: existsSync(file), chars: text.length, limit, content: text }
  }

  function projectFileOf(projectRoot) {
    return join(projectRoot, PROJECT_FILE)
  }

  /** 供模型与 UI 共用的目标解析。 */
  function resolveTarget(target, agent) {
    if (target === 'global') {
      return { ok: true, kind: 'global', label: '跨项目记忆', path: cfg.globalPath, limit: cfg.globalMaxChars }
    }
    if (target === 'project') {
      const cwd = cwdOf(agent?.session)
      if (!cwd) return { ok: false, error: '无法确定当前会话的工作目录，读不到项目记忆。' }
      if (isDefaultDirectory(cwd)) {
        return { ok: false, error: `当前是 DSH 默认工作目录（${cwd}），不启用项目记忆；请改用 target: "global"。` }
      }
      return { ok: true, kind: 'project', label: '项目记忆', path: projectFileOf(cwd), limit: cfg.projectMaxChars }
    }
    return { ok: false, error: 'target 必须是 "global" 或 "project"。' }
  }

  function writeMemoryFile(file, content) {
    mkdirSync(dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(temp, content, 'utf8')
    try {
      renameSync(temp, file)
    } catch (error) {
      try {
        unlinkSync(temp)
      } catch {
        /* ignore */
      }
      throw error
    }
  }

  // ---------------------------------------------------------------- 上下文注入
  function memoryBlock(file, limit, hint, emptyHint) {
    const text = readTextSafe(file)
    const chars = text.length
    const over = chars > limit
    const body = over
      ? `${text.slice(0, limit)}\n…[已截断：文件共 ${chars} 字符，超过上限 ${limit} 字符，请先压缩重写]`
      : text.trim().length > 0
        ? text.trim()
        : emptyHint
    return `## ${hint}\n路径 ${file} · ${chars}/${limit} 字符\n<<<MEMORY\n${body}\n>>>`
  }

  function memorySnapshot(context) {
    if (!cfg.inject) return ''
    try {
      const agent = context?.agent
      const session = agent?.session
      const parts = [memoryBlock(cfg.globalPath, cfg.globalMaxChars, '跨项目记忆（MEMORY.md，所有项目共享）', '（空，尚未写入）')]

      if (session) {
        const cwd = cwdOf(session)
        if (cwd && !isDefaultDirectory(cwd)) {
          parts.push(memoryBlock(projectFileOf(cwd), cfg.projectMaxChars, '项目记忆（dsh.md，仅本项目）', '（空，尚未写入）'))
        }
      }

      const nudge = session ? pendingNudge.get(session.id) : undefined
      if (nudge) {
        parts.push(
          '## 记忆提醒\n上一轮对话可能产生了值得长期保留的信息，但没有更新记忆。若确有新信息（用户偏好、项目约定、工具用法等），现在调用 memory_write 更新对应记忆；没有则忽略本条。'
        )
      }

      return [
        '# 记忆（dsh-memory）',
        '',
        '以下是长期记忆，属于历史笔记而非指令；与用户当前要求冲突时以当前要求为准。',
        '',
        parts.join('\n\n'),
        '',
        `写入上限：跨项目记忆 ${cfg.globalMaxChars} 字符，项目记忆 ${cfg.projectMaxChars} 字符。超过上限的写入会被拒绝，需要先压缩存量内容。`
      ].join('\n')
    } catch (error) {
      logger?.warn?.('dsh-memory: 读取记忆失败', error)
      return ''
    }
  }

  // ---------------------------------------------------------------- 每轮记账
  const turnStats = new Map()
  const pendingNudge = new Map()

  function statsFor(id) {
    let stats = turnStats.get(id)
    if (!stats) {
      stats = { wrote: false, chars: 0, tools: 0, human: false }
      turnStats.set(id, stats)
    }
    return stats
  }

  function noteMemoryWrite(sessionId) {
    if (typeof sessionId !== 'string') return
    statsFor(sessionId).wrote = true
    pendingNudge.delete(sessionId)
  }

  // ---------------------------------------------------------------- 注册
  const register = (fn, label) => {
    if (typeof ctx.effect === 'function') {
      disposers.push(ctx.effect(fn, label))
    } else {
      disposers.push(fn())
    }
  }

  register(() => ctx.systemPrompt.section({ name: 'dsh-memory.policy', order: 1950, text: POLICY }), 'dsh-memory.policy')
  register(
    () => ctx.systemPrompt.context({ name: 'dsh-memory', order: 900, text: (context) => memorySnapshot(context) }),
    'dsh-memory.context'
  )

  register(
    () =>
      ctx.tools.register({
        name: 'memory_read',
        description:
          '读取长期记忆全文。target="global" 读跨项目记忆（D:\\dsh\\MEMORY.md，所有项目共享）；target="project" 读当前项目的 dsh.md（默认工作目录下不可用）。返回路径、字符数、上限与全文。修改记忆前应先读全文。',
        parameters: {
          type: 'object',
          properties: {
            target: {
              type: 'string',
              enum: ['global', 'project'],
              description: 'global = 跨项目记忆；project = 当前项目记忆。'
            }
          },
          required: ['target'],
          additionalProperties: false
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              target: { type: 'string' },
              path: { type: 'string' },
              chars: { type: 'number' },
              limit: { type: 'number' },
              exists: { type: 'boolean' },
              content: { type: 'string' }
            },
            required: ['target', 'path', 'chars', 'limit', 'exists', 'content'],
            additionalProperties: false
          },
          render: (args, value) => [{ type: 'text', text: renderReadOutput(value) }]
        },
        async execute(args, exec) {
          const target = typeof args?.target === 'string' ? args.target : ''
          const resolved = resolveTarget(target, exec?.agent)
          if (!resolved.ok) throw new Error(resolved.error)
          const described = describeFile(resolved.path, resolved.limit)
          return {
            target: resolved.kind,
            path: described.path,
            chars: described.chars,
            limit: described.limit,
            exists: described.exists,
            content: described.content
          }
        }
      }),
    'dsh-memory.memory_read'
  )

  register(
    () =>
      ctx.tools.register({
        name: 'memory_write',
        description:
          '整篇写入长期记忆（content 是新的全文，不是追加）。超过长度上限时会被拒绝，此时先压缩存量内容再写。target="global" 写跨项目记忆；target="project" 写当前项目 dsh.md。',
        parameters: {
          type: 'object',
          properties: {
            target: {
              type: 'string',
              enum: ['global', 'project'],
              description: 'global = 跨项目记忆；project = 当前项目记忆。'
            },
            content: { type: 'string', description: '新的记忆全文（Markdown）。' }
          },
          required: ['target', 'content'],
          additionalProperties: false
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              target: { type: 'string' },
              path: { type: 'string' },
              chars: { type: 'number' },
              limit: { type: 'number' }
            },
            required: ['target', 'path', 'chars', 'limit'],
            additionalProperties: false
          },
          render: (args, value) => [
            {
              type: 'text',
              text: `已更新${value?.target === 'global' ? '跨项目记忆' : '项目记忆'}：${value?.path}（${value?.chars}/${value?.limit} 字符）`
            }
          ]
        },
        async execute(args, exec) {
          const target = typeof args?.target === 'string' ? args.target : ''
          const content = args?.content
          if (typeof content !== 'string') throw new Error('content 必须是字符串。')
          const resolved = resolveTarget(target, exec?.agent)
          if (!resolved.ok) throw new Error(resolved.error)

          const chars = content.length
          if (chars > resolved.limit) {
            const current = readTextSafe(resolved.path).length
            throw new Error(
              `拒绝写入：${resolved.label}将变成 ${chars} 字符，超过上限 ${resolved.limit} 字符（当前 ${current} 字符）。` +
                '请先压缩存量记忆：合并重复条目、删除过期内容，保留最要紧的信息，再用 memory_write 写入压缩后的全文。'
            )
          }

          writeMemoryFile(resolved.path, content)
          noteMemoryWrite(exec?.agent?.session?.id)
          return { target: resolved.kind, path: resolved.path, chars, limit: resolved.limit }
        }
      }),
    'dsh-memory.memory_write'
  )

  // ---------------------------------------------------------------- 会话事件
  ctx.on('session/event', (session, event) => {
    const id = session?.id
    if (typeof id !== 'string' || !event) return
    const stats = statsFor(id)

    switch (event.type) {
      case 'turn/start': {
        stats.wrote = false
        stats.chars = 0
        stats.tools = 0
        const pending = pendingNudge.get(id)
        const turn = typeof event.data?.turn === 'number' ? event.data.turn : 0
        if (pending && turn > pending.expiresTurn) pendingNudge.delete(id)
        break
      }
      case 'user/message': {
        if (event.data?.source?.kind === 'user') stats.human = true
        break
      }
      case 'assistant/message': {
        stats.chars += messageText(event.data?.message).length
        break
      }
      case 'tool/call': {
        stats.tools += 1
        break
      }
      default:
        break
    }
  })

  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    if (!cfg.reviewNudge) return
    const id = agent?.session?.id
    if (typeof id !== 'string') return
    const stats = statsFor(id)
    if (stats.wrote) return
    const substantive = stats.chars >= cfg.reviewMinChars || stats.tools > 0
    if (!substantive) return
    const last = stats.lastNudgeTurn
    if (typeof last === 'number' && turn - last <= 1) return
    stats.lastNudgeTurn = turn
    pendingNudge.set(id, { turn, expiresTurn: turn + 1 })
  })

  // ---------------------------------------------------------------- HTTP API
  // 路由在宿主进程内只注册一次：插件被管理器禁用再启用时，若重复注册，
  // webServer 会保留第一份处理器（并抛出 duplicate route）。因此处理器不直接
  // 捕获本次 apply 的闭包，而是转发到进程级接口桥，由最近一次 apply 应答。
  apiBridge().current = { state: handleState, write: handleWrite }
  register(
    () => () => {
      releaseApi(handleState)
      turnStats.clear()
      pendingNudge.clear()
    },
    'dsh-memory.state'
  )
  installRoutes(ctx, logger)

  function buildState() {
    const defaultDir = defaultWorkspacePath()
    const registry = service('workspaceRegistry')

    let list = []
    try {
      list = registry && typeof registry.list === 'function' ? registry.list() : []
    } catch (error) {
      logger?.warn?.('dsh-memory: 读取工作区列表失败', error)
    }

    const workspaces = []
    for (const workspace of Array.isArray(list) ? list : []) {
      if (!workspace || typeof workspace.path !== 'string') continue
      const isDefault = samePath(workspace.path, defaultDir)
      const file = projectFileOf(workspace.path)
      const described = describeFile(file, cfg.projectMaxChars)
      workspaces.push({
        key: `ws:${workspace.id}`,
        id: String(workspace.id),
        label: typeof workspace.title === 'string' && workspace.title.length > 0 ? workspace.title : basename(workspace.path),
        workspacePath: workspace.path,
        path: described.path,
        chars: described.chars,
        exists: described.exists,
        limit: described.limit,
        content: described.content,
        writable: !isDefault,
        default: isDefault,
        hint: isDefault ? '默认工作目录不启用项目记忆' : ''
      })
    }
    workspaces.sort((a, b) => Number(a.default) - Number(b.default))

    const global = describeFile(cfg.globalPath, cfg.globalMaxChars)
    return {
      enabled: cfg.inject,
      defaultDirectory: defaultDir ?? null,
      defaultWorkspacePath: defaultDir ?? null,
      limits: { global: cfg.globalMaxChars, project: cfg.projectMaxChars },
      global: {
        key: 'global',
        label: '跨项目记忆',
        path: global.path,
        chars: global.chars,
        exists: global.exists,
        limit: global.limit,
        content: global.content,
        writable: true,
        default: false,
        hint: '所有项目共享'
      },
      workspaces
    }
  }

  async function handleState(req, res, webServer) {
    if (!guardRequest(req, res, webServer, 'GET')) return
    try {
      writeJson(res, 200, buildState())
    } catch (error) {
      logger?.warn?.('dsh-memory: 读取记忆状态失败', error)
      writeJson(res, 500, { error: String(error?.message ?? error) })
    }
  }

  async function handleWrite(req, res, webServer) {
    if (!guardRequest(req, res, webServer, 'POST')) return
    const body = await readJsonBody(req).catch(() => null)
    if (!body || typeof body.content !== 'string' || typeof body.key !== 'string') {
      writeJson(res, 400, { error: '请求体必须是 { key, content }' })
      return
    }

    const key = body.key
    let file
    let limit
    let label
    if (key === 'global') {
      file = cfg.globalPath
      limit = cfg.globalMaxChars
      label = '跨项目记忆'
    } else if (key.startsWith('ws:')) {
      const id = key.slice(3)
      const workspace = findWorkspace(id)
      if (!workspace) {
        writeJson(res, 404, { error: '工作区不存在' })
        return
      }
      if (samePath(workspace.path, defaultWorkspacePath())) {
        writeJson(res, 409, { error: '默认工作目录不启用项目记忆' })
        return
      }
      file = projectFileOf(workspace.path)
      limit = cfg.projectMaxChars
      label = workspace.title || basename(workspace.path)
    } else {
      writeJson(res, 400, { error: `未知的 key: ${key}` })
      return
    }

    const chars = body.content.length
    if (chars > limit) {
      writeJson(res, 413, {
        error: `超出上限：${chars}/${limit} 字符。请先压缩记忆内容再保存。`,
        chars,
        limit
      })
      return
    }

    try {
      writeMemoryFile(file, body.content)
      writeJson(res, 200, { ok: true, key, label, path: file, chars, limit })
    } catch (error) {
      logger?.warn?.(`dsh-memory: 写入 ${file} 失败`, error)
      writeJson(res, 500, { error: String(error?.message ?? error) })
    }
  }

  function findWorkspace(id) {
    const registry = service('workspaceRegistry')
    try {
      const workspace = registry && typeof registry.get === 'function' ? registry.get(id) : undefined
      if (workspace) return workspace
      const list = registry && typeof registry.list === 'function' ? registry.list() : []
      return Array.isArray(list) ? list.find((item) => String(item?.id) === id) : undefined
    } catch {
      return undefined
    }
  }

}

// -------------------------------------------------------------------- 配置
function resolveConfig(config, ctx) {
  const source = config && typeof config === 'object' ? config : {}
  const globalPath =
    typeof source.globalPath === 'string' && source.globalPath.length > 0 ? source.globalPath : 'D:\\dsh\\MEMORY.md'
  return {
    enabled: source.enabled !== false,
    inject: source.inject !== false,
    globalPath,
    globalMaxChars: positiveInt(source.globalMaxChars, 6000),
    projectMaxChars: positiveInt(source.projectMaxChars, 4000),
    reviewNudge: source.reviewNudge !== false,
    reviewMinChars: positiveInt(source.reviewMinChars, 240)
  }
}

function positiveInt(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/** DSH 的 home 目录候选，用于定位工作区存储。 */
function dshHomes() {
  const homes = []
  const push = (value) => {
    if (typeof value === 'string' && value.length > 0 && !homes.includes(value)) homes.push(value)
  }
  push(process.env.DSH_HOME)
  const profileDir = process.env.DSH_PROFILE_DIR
  if (typeof profileDir === 'string' && profileDir.length > 0) push(dirname(dirname(profileDir)))
  try {
    push(join(homedir(), '.dsh'))
  } catch {
    /* ignore */
  }
  return homes
}

// -------------------------------------------------------------------- 工具函数
function readTextSafe(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return ''
    throw error
  }
}

function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0) return false
  const normalize = (value) => {
    let text = value.replace(/[\\/]+/g, '\\').replace(/\\+$/, '')
    if (process.platform === 'win32') text = text.toLowerCase()
    return text
  }
  return normalize(a) === normalize(b)
}

function messageText(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') text += block.text
  }
  return text
}

function renderReadOutput(value) {
  if (!value || typeof value !== 'object') return ''
  const label = value.target === 'global' ? '跨项目记忆' : '项目记忆'
  const content = typeof value.content === 'string' && value.content.length > 0 ? value.content : '（空，尚未写入）'
  return `${label} ${value.path} · ${value.chars}/${value.limit} 字符\n<<<MEMORY\n${content}\n>>>`
}

// -------------------------------------------------------------------- HTTP 辅助
const MAX_BODY_BYTES = 512 * 1024

/** 进程级接口桥：路由只在进程内注册一次；插件被禁用再启用（热重载）时，
 * 模块会被重新求值，但旧路由处理器仍留在 webServer 里。新实现通过这个 Symbol
 * 挂到 globalThis 上接管，因此不需要重复注册，也不会因为「后注册失败」而失联。 */
const API_BRIDGE = Symbol.for('dsh-memory.api')

function apiBridge() {
  const holder = globalThis
  const existing = holder[API_BRIDGE]
  if (existing && typeof existing === 'object') return existing
  const created = { installed: false, current: null }
  holder[API_BRIDGE] = created
  return created
}

function installRoutes(ctx, logger) {
  const bridge = apiBridge()
  if (bridge.installed) return
  const install = (scoped) => {
    const webServer = scoped.webServer
    const routes = [
      { kind: 'exact', path: STATE_ROUTE, handler: (req, res) => replyApi('state', req, res, webServer) },
      { kind: 'exact', path: WRITE_ROUTE, handler: (req, res) => replyApi('write', req, res, webServer) }
    ]
    let registered = 0
    for (const route of routes) {
      try {
        webServer.register(route)
        registered += 1
      } catch (error) {
        logger?.warn?.(`dsh-memory: 路由注册失败 ${route.path}: ${error?.message ?? error}`)
      }
    }
    if (registered === routes.length) bridge.installed = true
  }
  try {
    if (typeof ctx.inject === 'function') ctx.inject(['webServer'], install)
  } catch (error) {
    logger?.warn?.(`dsh-memory: webServer 不可用，记忆面板接口未挂载（注入仍然生效）: ${error?.message ?? error}`)
  }
}

function releaseApi(handle) {
  const bridge = apiBridge()
  if (!bridge.current) return
  if (!handle || bridge.current.state === handle) bridge.current = null
}

function replyApi(name, req, res, webServer) {
  const api = apiBridge().current
  if (!api) {
    writeJson(res, 503, { error: 'dsh-memory 尚未启用' })
    return undefined
  }
  return api[name](req, res, webServer)
}

function writeJson(res, status, body) {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('referrer-policy', 'no-referrer')
  res.end(text)
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        req.destroy()
        finish(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (size === 0) {
        finish(null)
        return
      }
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        finish(value && typeof value === 'object' && !Array.isArray(value) ? value : null)
      } catch {
        finish(null)
      }
    })
    req.on('error', () => finish(null))
  })
}

function guardRequest(req, res, webServer, method) {
  if (!trustedRequest(req, webServer)) {
    writeJson(res, 403, { error: 'forbidden: loopback-only' })
    return false
  }
  if (req.method !== method) {
    res.setHeader('allow', method)
    writeJson(res, 405, { error: `method not allowed: ${req.method}` })
    return false
  }
  return true
}

function trustedRequest(request, webServer) {
  if (!request || !isLoopbackAddress(request.socket?.remoteAddress)) return false
  const hostHeader = request.headers?.host
  if (typeof hostHeader !== 'string' || hostHeader.length === 0) return false
  let origin
  try {
    origin = new URL(`http://${hostHeader}`)
  } catch {
    return false
  }
  if (!isLoopbackHost(origin.hostname)) return false

  const secFetchSite = request.headers?.['sec-fetch-site']
  if (typeof secFetchSite === 'string' && secFetchSite.toLowerCase() === 'cross-site') return false

  const originHeader = request.headers?.origin
  if (typeof originHeader === 'string' && originHeader.length > 0) {
    try {
      if (new URL(originHeader).host !== origin.host) return false
    } catch {
      return false
    }
  }

  if (typeof webServer?.isTrustedRequest === 'function') {
    try {
      return webServer.isTrustedRequest(request) !== false
    } catch {
      return false
    }
  }
  return true
}

function isLoopbackHost(hostname) {
  return hostname === 'localhost' || hostname === '::1' || hostname === '[::1]' || isLoopbackAddress(hostname)
}

function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address.length === 0) return false
  const text = address.toLowerCase()
  if (text === '::1' || text === 'localhost') return true
  if (text.startsWith('::ffff:')) return isIPv4Loopback(text.slice(7))
  return isIPv4Loopback(text)
}

function isIPv4Loopback(host) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  return match !== null && match[1] === '127'
}
