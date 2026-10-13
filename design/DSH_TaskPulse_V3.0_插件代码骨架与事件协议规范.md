# DSH TaskPulse V3.0 插件代码骨架与事件协议规范

## 1. 工程结构

    dsh-taskpulse

    src

    ├── components
    │
    ├── models
    │
    ├── hooks
    │
    ├── store
    │
    ├── services
    │
    └── styles

------------------------------------------------------------------------

# 2. 组件结构

    TaskButton

    TaskPanel

    WorkspaceGroup

    ConversationItem

    TaskCard

    TaskDetail

    StatusBadge

    Timeline

------------------------------------------------------------------------

# 3. Store结构

``` ts
{
 workspaces:[
   {
    id:"",
    name:"",
    conversations:[]
   }
 ]
}
```

------------------------------------------------------------------------

# 4. 事件协议

## 工作区

    workspace.created
    workspace.removed
    workspace.updated

## 对话

    conversation.created
    conversation.updated
    conversation.finished

## Agent

    agent.started
    agent.progress
    agent.finished

## 工具

    tool.called
    tool.finished

------------------------------------------------------------------------

# 5. 事件流

    DSH Event

    ↓

    Event Service

    ↓

    Task Store

    ↓

    UI刷新

    ↓

    History保存

------------------------------------------------------------------------

# 6. 自动隐藏规则

    SUCCESS

    +

    30分钟无动作

    =

    removeActiveTask()

------------------------------------------------------------------------

# 7. 核心接口

``` ts
getWorkspaces()

getConversations()

getActiveTasks()

updateTaskStatus()

saveHistory()
```

------------------------------------------------------------------------

# 8. 权限设计

允许：

-   workspace.read
-   conversation.status.read
-   task.read
-   timeline.read

禁止：

-   修改用户内容
-   自动执行操作

------------------------------------------------------------------------

# 9. 开发目标

实现：

-   多项目监控
-   多会话同步
-   多Agent状态展示
-   实时任务跟踪
-   历史任务分析
