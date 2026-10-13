# DSH TaskPulse V3.0 产品设计与架构规范

## 1. 产品定位

DSH TaskPulse 是 DSH 的 AI 工作状态控制中心。

目标：

-   监控所有 Workspace 工作区
-   聚合 Conversation 对话状态
-   展示 AgentTask AI执行任务
-   管理等待确认事项
-   记录历史执行过程

------------------------------------------------------------------------

## 2. 核心架构

    DSH

    Workspace
        |
    Conversation
        |
    AgentTask
        |
    +-----------+
    | Timeline |
    | Metrics  |
    | History  |
    +-----------+

------------------------------------------------------------------------

## 3. 数据模型

### Workspace

``` ts
interface Workspace {
 id:string;
 name:string;
 path:string;
 conversations:Conversation[];
}
```

### Conversation

``` ts
interface Conversation {
 id:string;
 workspaceId:string;
 title:string;
 lastActivityTime:string;
 tasks:AgentTask[];
}
```

### AgentTask

``` ts
interface AgentTask {
 id:string;
 title:string;
 status:string;
 progress:number;
 currentStep:string;
 lastActionTime:string;
 timeline:Timeline[];
}
```

------------------------------------------------------------------------

## 4. 状态机

    START
     |
    RUNNING
     |
    +-- SUCCESS
    +-- ERROR
    +-- WAIT_CONFIRM
    +-- BLOCKED

状态：

  状态           说明
  -------------- --------------
  RUNNING        执行中
  WAIT_CONFIRM   等待用户确认
  SUCCESS        完成
  ERROR          异常
  BLOCKED        阻塞

------------------------------------------------------------------------

## 5. 动态发现

监听：

-   workspace.created
-   conversation.created
-   agent.started
-   tool.called
-   task.updated
-   conversation.finished

新增工作区自动加入任务列表。

------------------------------------------------------------------------

## 6. 生命周期

完成任务：

SUCCESS + 30分钟无动作

=\> 从活跃列表隐藏

=\> 保存History

------------------------------------------------------------------------

## 7. Timeline

记录：

-   时间
-   操作
-   状态
-   输出

------------------------------------------------------------------------

## 8. 最终定位

DSH TaskPulse：

> 多工作区、多Agent AI任务监控中心。
