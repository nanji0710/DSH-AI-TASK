/**
 * 工具名 → 中文动作标签。
 *
 * Timeline 展示的是「人类可读动作」（规范 8），因此这里把 DSH 的工具名映射成
 * 中文短语；未收录的工具名回退为原名，绝不丢信息。
 */

const TOOL_LABELS: Record<string, string> = {
  pwsh: '执行命令',
  bash: '执行命令',
  shell: '执行命令',
  read: '读取文件',
  write: '写入文件',
  edit: '修改文件',
  glob: '查找文件',
  grep: '搜索代码',
  compress: '压缩上下文',
  decompress: '恢复上下文',
  acp_status: '读取上下文状态',
  search_context: '检索上下文',
  web_fetch: '抓取网页',
  web_search: '搜索网络',
  advanced_search: '搜索网络',
  multi_search: '多源搜索',
  research: '深度调研',
  domain_search: '查询数据源',
  platform_search: '检索平台',
  video_search: '搜索视频',
  cache_search: '检索缓存',
  weather: '查询天气',
  todo_write: '更新任务清单',
  todo_read: '读取任务清单',
  create_goal: '设定目标',
  get_goal: '读取目标',
  update_goal: '更新目标',
  subagent: '派生子代理',
  subagent_fork: '派生子代理',
  send_message: '发送消息',
  interrupt_agent: '中断子代理',
  list_agents: '查看子代理',
  workflow: '编排工作流',
  present: '交付产物',
  read_image: '识别图片',
  ask_user_question: '向用户提问',
  exit_plan_mode: '提交计划',
  skill: '加载技能',
  job_list: '查看后台任务',
  job_output: '读取任务输出',
  job_kill: '终止任务',
  load_workspace_dependencies: '加载依赖',
  create_task: '创建任务'
}

/** 把工具名翻译成中文动作短语；未知工具原样返回。 */
export function toolLabel(name: string | undefined | null): string {
  if (!name) return '执行中'
  return TOOL_LABELS[name] ?? name
}

/** 把任意参数值压成一行、限长的可读摘要。 */
export function summarizeValue(value: unknown, maxLength = 120): string {
  if (value === null || value === undefined) return ''
  let text: string
  if (typeof value === 'string') text = value
  else if (typeof value === 'number' || typeof value === 'boolean') text = String(value)
  else {
    try {
      text = JSON.stringify(value)
    } catch {
      text = String(value)
    }
  }
  text = text.replace(/\s+/g, ' ').trim()
  if (text.length > maxLength) text = `${text.slice(0, maxLength - 1)}…`
  return text
}

/**
 * 从工具入参里挑出最有信息量的一行摘要（命令 > 路径 > 查询 > 首个标量）。
 * 目的：TaskCard 的「当前: xxx」要短、可读、能定位。
 */
export function summarizeToolArguments(args: unknown): string {
  if (args === null || args === undefined) return ''
  if (typeof args !== 'object') return summarizeValue(args, 100)
  const record = args as Record<string, unknown>
  const preferredKeys = [
    'command',
    'file_path',
    'path',
    'query',
    'pattern',
    'url',
    'objective',
    'prompt',
    'description',
    'name'
  ]
  for (const key of preferredKeys) {
    if (record[key] !== undefined) {
      const text = summarizeValue(record[key], 100)
      if (text) return key === 'command' ? text : `${key}: ${text}`
    }
  }
  for (const key of Object.keys(record)) {
    const text = summarizeValue(record[key], 80)
    if (text) return `${key}: ${text}`
  }
  return ''
}

/**
 * 从「会阻塞等人」的工具入参里取出**要用户回答的那句话**。
 *
 * 这两类工具的入参形状与普通工具不同，`summarizeToolArguments` 只会把它们
 * 压成一团 JSON，读不出「AI 到底在问什么」：
 *   - `ask_user_question` → `{ questions: [{ id, header?, question, options? }] }`
 *   - `exit_plan_mode`    → `{ plan: string }`
 *
 * 确认卡上要展示的正是这句话，所以按语义取值；形状不符时回退到通用摘要。
 */
export function questionText(args: unknown): string {
  if (args === null || args === undefined) return ''
  if (typeof args !== 'object') return summarizeValue(args, 160)
  const record = args as Record<string, unknown>

  const questions = record.questions
  if (Array.isArray(questions) && questions.length > 0) {
    const first = questions[0]
    if (first !== null && typeof first === 'object') {
      const item = first as Record<string, unknown>
      const header = summarizeValue(item.header, 40)
      const question = summarizeValue(item.question, 140)
      // 一次问多个问题时，正文只放第一个，但要说明还有几个 —— 别让用户以为只有一个。
      const rest = questions.length > 1 ? `（共 ${questions.length} 个问题）` : ''
      if (question) return `${header ? `【${header}】` : ''}${question}${rest}`
      if (header) return `${header}${rest}`
    }
  }

  const plan = summarizeValue(record.plan, 160)
  if (plan) return plan

  return summarizeToolArguments(args)
}
