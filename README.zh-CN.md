# pi-rex-adapter

[English](https://github.com/xiangsam/pi-rex-adapter#readme) | **简体中文**

**让 Pi 的任务并行展开，让主线保持专注。**

把代码审查交给独立的 Pi agent，在主对话右侧讨论一个临时问题，让耗时的构建与测试在后台运行。pi-rex-adapter 把这些工作放进 Rex 的 tab 和 pane，完成后主动把结果送回来。

- **完整的 Pi 子 agent**：在专属 tab 中运行，自动回报每轮结果，随时进入继续交流。
- **随手发起的侧聊**：`/btw` 在主对话右侧开启独立会话，只有你选择的结论才回到主线。
- **会主动回报的后台任务**：`/bg` 运行长命令，回传退出码和日志摘要，送达后自动收起 pane。
- **轻量的任务概览**：活跃任务每项一行，完成即移出；历史、日志和控制集中在一个浮层。

保留 Pi 原生交互，尊重用户调整过的布局。没有待监控任务时不常驻监听；配置只有界面语言和每 tab 的 pane 上限。

目标环境是 **Pi 1.4+、Node 22.19+**，Rex CLI 需要支持 `window new/split --json --shell=none --focus=false` 、`block inspect --json`、`block call … process`（包含 `last_exit`）和 `events -s … --json`（终端退出与 block 关闭事件）。

## 安装

在 Rex 终端中执行：

```sh
pi install npm:pi-rex-adapter
# 在已运行的 Pi 中执行 /reload，或重新启动 pi
```

也可以只试用一次：

```sh
pi -e git:github.com/xiangsam/pi-rex-adapter
```

也可以从 GitHub 安装：`pi install git:github.com/xiangsam/pi-rex-adapter`。

父进程必须在 Rex 中运行，依赖 `REX_SESSION` 和 `REX_BLOCK` 定位，始终使用父 block 而不是界面当前焦点。CLI 不在 PATH 时会探测 macOS 的 Rex/Rex Beta 应用；也可设置 `PI_REX_BIN`。子进程默认使用当前 Pi 的入口，`PI_REX_PI_BIN` 可覆盖。运行环境为同一台机器、同一文件系统；不支持远程 Rex host。

## 配置

只提供两个设置，均可省略：

```json
{
  "language": "en",
  "panesPerTab": 2
}
```

- 全局：`~/.pi/agent/rex.json`。设置了 `PI_CODING_AGENT_DIR` 时，使用该目录下的 `rex.json`。
- 项目：当前工作目录的 `.pi/rex.json`，按字段覆盖全局配置。

| 设置 | 默认 | 含义 |
| --- | --- | --- |
| `language` | `"en"` | 插件界面语言，支持 `"en"` / `"zh"`。覆盖**主 agent 看板**的标题、运行状态、数量提示，以及浮层、操作提示和子会话提示。例如默认显示 `Running`，中文显示“运行中”。 |
| `panesPerTab` | `2` | 每个 Agents / Jobs tab 容纳的本扩展 pane 上限，取正整数。`1` 表示每任务单独开 tab，`3` 表示第三个任务仍在同一 tab，第四个进入下一页。 |

例如只想切换中文，在项目的 `.pi/rex.json` 中写 `{"language":"zh"}` 即可，pane 上限继续沿用全局值或默认值。

配置在启动、切换会话或 `/reload` 时读取，不创建默认文件，也不额外监听配置变化。已有子 Pi 在自己的会话中 `/reload` 后更新语言；通过 `cwd` 指定另一个 checkout 的子任务仍读取父项目的配置。配置无效会提示文件与原因，无效字段保留上一级有效值或默认值，其余有效字段照常应用。

语言设置不翻译用户任务、agent 回答、日志、底层错误或结构化状态字段，也不改变模型的回答语言。工具名、slash 命令及其描述保持英文。pane 上限只影响后续创建，不重排、移动或关闭已有 pane；始终左右分屏，每次对目标 pane 做 50% 分割，不自动均分整个 tab。BTW 仍在主 tab 右侧复用一个 pane，不受此上限控制。用户手动添加的 pane 仍不计入上限。

## 使用

```text
/btw 这个模块如果改成事件驱动，有什么取舍？
/bg npm test
/rex-agent 检查认证模块，报告风险与相关文件，不修改代码
/rex-tasks
```

`/btw <问题>` 首次在父 block **右侧占 50%** 打开交互式 Pi，默认保留主线焦点；点击侧栏、单独执行 `/btw`，或在 `/rex-tasks` 中选择“聚焦到任务”进入。它有独立 session，默认继承当前分支的文本快照（最近 48,000 字符，包含摘要，不含图片、thinking 和工具输出），继承模型和 thinking level。它不是 Pi session 的完整 clone。

同一父 Pi 再次执行 `/btw <问题>` 会复用当前侧聊，保留原有历史，通过文件 inbox 将问题送入侧聊的 Pi 输入接口；忙时等它空闲后合并接收，不向终端模拟按键。只有问题实际写入侧聊的 Pi 会话后才确认接收；调用输入接口本身不算成功。Pi 的接口不返回异步确认，因此未确认的问题不会自动反复重发，避免慢认证或输入扩展造成重复提问。10 秒后仍未确认会在侧聊状态栏提示，问题继续保留；处理模型/认证/输入错误后，在侧聊执行 `/reload` 重试。单独 `/btw` 聚焦现有侧聊。已有侧聊保持创建时的上下文快照，后续问题不自动重拷贝主线历史；需要刷新背景时在问题中补充。关闭侧聊后再次提问会新建独立会话；正常退出但保留的侧聊 block 会先关闭再替换。明确指定不同的 cwd/model 时要求先关闭现有侧聊。

侧聊不会自动回传每轮回答。在侧聊中执行：

```text
/btw-return
/btw-return 采用方案 B，只改缓存层，其他部分暂缓
```

不带参数时回传最后一条 assistant 回答；带参数只回传指定文字。回传后侧聊仍可继续，并可再次回传。默认仅启用 `read,grep,find,ls` 且禁用 MCP，适合讨论；这是工具选择，不是权限沙箱。不会自动合并文件。

`/bg` 将 shell 命令放到Jobs 分组 tab 中的独立 terminal block，stdin 关闭，使用 `/bin/sh -c`，工作目录默认与父 Pi 相同。完整 stdout/stderr 写入 `output.log`，同时在 block 展示；两端均处理背压，写入失败时停止 shell 并尽量保存失败记录；结束时回传退出码、最后 16,000 字符和日志路径。长驻 server 直到退出才产生完成结果。命令结束后进程立即退出；主线会话确认持久化收到结果后（包括非零退出），扩展自动关闭它的 block，保留日志与任务记录。仅排入消息队列不算送达；父 Pi 离线时会等它恢复、接收结果后再清理。它适合启动前就决定放后台的构建、测试和服务；**此版本不接管已经运行的内置 bash，也未实现 Ctrl+B/超时自动转后台**，避免重跑正在执行的命令。

Shell pane 启动后立即显示任务名、工作目录和完整提交命令（支持多行），随后显示实时输出；结束时显示结果、退出码或信号及耗时，无输出时也会明确说明。标题采用低饱和蓝色，提示遵循 `language` 配置。这些展示文字不写入 `output.log`，也不混入回传给主 agent 的结果。

Runner 设置终端标题，并通过 [Rex 原生程序状态协议](https://www.superlogical.com/rex/docs/build/program-status)报告 working/done/error，取消时报告 idle，无需轮询。pane 打开期间可在 Rex 中滚动查看输出；结果送达后的自动关闭规则保持不变。

为保留完整日志和进程组取消能力，命令输出仍使用管道采集。默认给 Python 设置 `PYTHONUNBUFFERED=1`，使普通 `print()` 尽快显示；已有环境变量值会保留。其他程序仍可能需要自身的刷新/进度参数；命令主动重定向到其他文件的内容不会被自动跟读。

未指定名称时，任务名使用任务首行的短摘要，避免历史列表只显示时间戳。

通过 `subagent` 或 `/rex-agent` 启动的子 agent 会携带 Pi 的 `--approve` 参数，仅为本次运行信任项目本地文件（包括项目配置和扩展），避免指定新 `cwd` 时等待目录信任确认；不会保存永久信任决定。

新建子会话名区分 `Agent · <名称>` 与 `BTW · <名称>`，Pi 会将其显示在终端标题中。编辑器上方用低饱和蓝色单行展示原始委派任务或侧聊主题；底部显示启动、运行、失败、中断等状态。Agent 完成后显示“结果已排队 · 等待主 agent 处理”，仅表示回报文件已写入，并不表示主 agent 已收到或审阅。

BTW 回传是可选操作：普通回答结束后提示“答案已就绪 · 可用 /btw-return 回传”，不会自动生成主会话回传消息；只有显式执行 `/btw-return` 才显示“结论已排队 · 可继续侧聊”。上述提示同时支持英文与中文，遵循 `language` 配置，不向对话正文追加状态消息。Rex 的 working/blocked/done/error 仍由 Pi 1.4 原生报告，插件不重复接管、不增加状态轮询。

`/rex-agent` 在 Agents 分组 tab 的独立 terminal block 中启动完整交互式 Pi（不使用 `--print`）。每轮任务 settled 后自动回传该轮回答，Pi 会话保持打开；可聚焦该 block 继续输入下一轮，后续回答也分别回传。主 agent 检查完交付、无需该 agent 继续下一轮时，应及时调用 `rex_finish` 关闭该 block；关闭后文件、结果与 Pi 会话记录仍保留，主 agent 可以继续集成或测试，无需等整个主任务结束才关窗。这是工具说明和结果通知中的收尾约定，不是强制自动关闭，也不会反复发送提醒。工具会检查任务已完成且进程 idle/已退出，不会关闭正在运行的任务或 BTW。这由主 agent 调用执行，不是子进程自行关闭。子进程默认不注册本 adapter 的委派工具。子任务共享工作目录；并行写入请通过工具的 `cwd` 指定事先准备的独立 checkout。此版本不自动管理 worktree、角色包、模型 fallback 或持久 specialist。

## 主页面任务概览

父 Pi 输入框上方只展示仍在运行、启动中或待核实的 Agent / Shell，BTW 不展示。采用低饱和蓝灰色（#7e98ad）的细分隔线与标题、灰色正文；每个任务最多一行，显示类型、名称、状态和可容纳的任务摘要，不展示 UUID、时间或第二行命令。最多显示六项，其余通过面板查看。完成、失败、中断、取消或关闭的任务自动移出概览；全部结束后整个概览消失，历史记录不删除。任务文本中的终端控制字符会被清理，窄窗口自动截断。

`/rex-tasks` 是唯一的管理入口，使用 Pi 原生居中悬浮框，最大宽度 84 列，窄窗口自动收缩。面板有不透明蓝灰背景、圆角边框、内边距和整行选中高亮，覆盖在终端内容之上，退出后恢复原页面。没有任务时显示 `No tasks yet` 和创建提示（`language: "zh"` 时为“暂无任务”）：

- 上下键选择任务，Enter 打开，Esc 返回；长列表与详情支持 PageUp/PageDown 滚动。详情/日志返回原任务菜单，菜单返回列表时保留选中任务和滚动位置；操作出错后仍可留在原菜单继续处理。
- 任务菜单集中提供详情、日志、聚焦、中断、完成并关闭、显式关闭。
- 菜单第一项切换主页面概览的显示/隐藏，偏好按父 Pi session 保存。
- 已关闭任务仍能查看结果和日志，BTW 可在历史列表管理。
- 已完成且未关闭的 agent 显示“已完成 · 待回传”或“已回传 · 待关闭”。只有最新一轮结果对应的回执已写入主会话才算送达；仅排队或上一轮已送达不算。“已回传”不代表主 agent 已审核，任务菜单和详情会说明区别。这些提示支持中英文，打开或返回浮层时更新，不增加定时器或模型唤醒；完成项仍不回到主看板。
- 创建结果不确定、没有 block ID 时不显示必然失败的聚焦/关闭操作。检查 Rex 并确认资源不存在且相关进程已停止后，可使用任务菜单的“核实资源已移除…”修复记录、解除后续创建阻塞。此操作不发送关窗或杀进程命令；连接错误不能当作资源已移除。
- 任务查询、详情和错误不向主对话追加 JSON 或通知；创建任务成功只在状态栏短暂提示。

父会话仅保留 `/btw`、`/bg`、`/rex-agent`、`/rex-tasks` 四个 slash 命令；原独立的面板、概览开关、聚焦/中断/关闭、日志命令已合并到任务浮层。子会话保留 `/btw-return`。模型使用的 `rex_tasks`、`bg_logs`、`rex_control` 等结构化工具不受影响。

首次恢复会话只做一次任务发现；没有待监控任务时，不创建任务目录、不启动 watcher/定时器。首次委派后才启用相关结果文件事件和每 5 秒对账，忽略日志内容变化；已关闭且结果已送达的任务退出监控，历史详情在打开面板时读取。概览内容不变时不重复刷新；不额外轮询 Rex，也不会单独触发模型工作。面板操作重新验证父会话与任务归属。概览的“运行/待命”是子进程最后报告；打开面板或刷新概览不意味着实时验证每个 Rex block。

关闭策略：**Shell 自动回报并收起；subagent 由主 agent 处理结果后收尾；BTW 保留。** 自动清理遇到 Rex 连接失败时保留记录并在 `/rex-tasks` 显示“清理失败”，后续对账重试。自动关窗在独立串行清理队列执行，模型回合边界不等待 Rex CLI 或磁盘扫描。日志和对话记录不会随 block 一起删除。

## 给 agent 的工具

| 工具 | 参数与行为 |
| --- | --- |
| `subagent` | `task`，可选 `name,cwd,model,fork`；启动后台 Pi，自动回传 |
| `btw` | 参数同上；`task` 可省略以聚焦，提供问题时复用右侧会话，手动回传 |
| `bg_run` | `command`，可选 `name,cwd`；启动后台 shell，自动回传 |
| `bg_logs` | `id`；读取 shell 日志最后 16 KB；无日志时返回 `logAvailable:false` 与说明，agent/BTW 结果通过 `rex_tasks` 查看 |
| `bg_kill` | `id`；关闭所属 shell block |
| `rex_finish` | `id`；主 agent 处理完成结果后收尾，要求任务 completed 且进程 idle/已退出，保留记录 |
| `rex_tasks` | 可选 `id` 精确查询所属任务，省略则列出全部，始终返回数组；包含任务、进程、block 状态和实际 window，检查失败显示 unverified 与原因 |
| `rex_control` | `id,action`；`focus`、`interrupt`、`close` |

在 Rex 中仅启动任务与 `rex_finish` 默认直接暴露给模型，诊断/日志/控制工具使用 Pi 的 deferred 按需发现机制；没有启用 `tool_search` 或 `codemode` 的配置，在有待处理任务时才直接暴露必要控制工具。非 Rex 且没有所属任务的会话不增加默认工具声明或系统提示规则，不修改 Pi 原生工具。

`fork:false` 不传父上下文。`interrupt` 对 Pi 发送 Escape，仅中断当前 turn；子 agent 与 BTW 均保持交互会话。停止 shell 用 `bg_kill` 或 `close`。控制操作只接受本父 session 登记的完整任务 UUID，不接受任意 Rex block ID。

失败或中断的任务保留以便诊断、继续交互；检查结果后，如需关闭，显式调用 `rex_control({id, action: "close"})`。`rex_finish` 仍仅用于 completed 且 idle/已退出的任务；拒绝时会说明当前任务和进程状态，以及显式关闭方式。

任务浮层的 Esc 每次返回一层：详情/错误 → 任务菜单 → 任务列表 → 关闭。重复调用 `/rex-tasks` 不会叠加任务管理器。

## 生命周期与恢复

控制工具返回的任务状态与 `rex_tasks` 使用相同的推导规则。成功关闭或核实资源已移除时，会将该结果保存到 `run.json`；重复关闭也会修正旧的已关闭记录中的过期状态。任务未关闭时，`run.json` 是生命周期记录，并非实时状态源；应通过 `rex_tasks` 合并 activity、result、exit 记录查询。不会新增后台迁移来批量重写历史记录。

```text
父 Pi → 任务记录 → Rex block → Pi（Agent / BTW）
  │                       └→ shell runner → shell
  ↑
  └── 批量回报 ← 完成文件 / 可选主动回传文件
      进程退出 ← Rex 事件 / 恢复时核对
```

借鉴 [pi-herdr-agents](https://github.com/giuseppecrj/pi-herdr-agents) 的独立子进程、非阻塞委派、结果回传，以及 [pi-background-tasks](https://github.com/SakikoTogawa233/pi-background-tasks) 的持久任务登记和完成通知；Rex 负责 session/window/block 布局与进程。实现为独立包，未复制上述项目源码，也不是两者全部功能的移植。

Agent 和 BTW 由 Rex 直接启动 Pi：短暂的 `env` 设置任务目录与 PATH 后替换为 Pi，不再常驻一层 adapter Node supervisor。终端标题与原生 `app=pi` 状态由 Pi 自己管理。Shell 保留 runner，负责完整日志、终端输出、背压和进程组取消；它以 `app=shell` 上报身份，不再被识别成 Pi。已启动的旧子进程保持原架构，关闭后重新创建才使用新路径。

存在直接启动的 Pi pane 时，父扩展为每个 Rex session 保留一条事件订阅，将终端退出写入 `exit.json`，并跟踪 block 关闭。首次订阅、新增任务及断线重连时核对 `process.last_exit`，同一 session 的恢复查询串行执行；正常运行不循环查询进程，也不阻塞主 agent 的回合边界。父会话 reload/退出时释放订阅，保留子进程；断线重连采用有上限的退避。

若父会话离线期间直接启动的 Pi block 已消失，Rex 无法再提供退出码，会记录 `closed`、`exit.unknown=true` 与原因。已完成且空闲时保存的回报继续保留；未完成任务记为 `exited`，不伪造成功，也不一直显示运行中。仍保留的 block 正常恢复已知退出码。BTW 的退出只更新历史，结论仍需通过 `/btw-return` 主动回传。

父扩展监听结果文件，先存入本地 inbox，不为每条结果单独排一个 `followUp`。主线工作时在 `turn_end`（本次模型响应及工具执行结束）或 `agent_before_settle` 将全部就绪结果合成一条 custom message，并请求一次 continuation；不用等整个任务空闲。主线空闲时用 300ms 合并窗口收集结果，再触发一次新 turn。模型正在输出或工具正在执行时不强行插入消息；尚未完成的任务也不会阻止已有结果送达。用户中止主线后不会因待收结果立即自动重启；下一次用户启动主线时再接收。agent 无需运行状态轮询。有待监控任务时，内部每 5 秒做一次文件对账，以补偿丢失的文件事件。回合边界只消费已经收集的结果，不等待扫描结束。多轮回报记录时间/顺序，恢复后按顺序批量送达；旧版无顺序字段的结果以文件修改时间兼容排序。任务目录位于父 Pi session directory 的 `rex-adapter/<parent-session-id>/<task-id>/`，私有权限保存任务正文、上下文、session、日志和退出记录。

`/reload` 或恢复相同父 session 会重新发现完成结果，通过已持久化消息中的 receipts 去重（兼容旧版单 receipt）。切换到另一 session 后不会把旧任务结果投递给新主线；返回原 session 时补发。退出父 Pi 不会主动关闭 Rex block，但父进程离线时不会触发模型，重新打开原 session 后才能补发。工具取消信号传递到排队后的检查、资源操作与 CLI 子进程；创建请求尚未发出时取消不会开新 block。请求已经发出后被取消、超时或返回格式异常，记录标记为 `uncertain`，不自动重试，以免重复执行。

Shell block 在结果确认送达后自动清理；子 agent 由主 agent 通过 `rex_finish` 收尾，BTW 默认保留。也可通过 `/rex-tasks` 中的任务操作 显式关闭。重复或并发关闭同一任务幂等。关闭前已完成的任务保留原状态；关闭导致的进程退出归为 cancelled，通知仍保留信号/启动失败原因。任务记录与日志不自动删除，长驻任务日志会持续增长。对于 Shell 和旧版 runner 任务，若 runner 被 SIGKILL、Rex 崩溃或主机断电而未写出退出记录，状态可能停留在 running/uncertain，需要检查 block；不将缺失记录误判为成功。通知对普通 reload 可去重，进程崩溃与队列持久化的极小窗口内不保证事务式 exactly-once。Shell 在 POSIX 下使用独立进程组，runner 收到终止信号时转发给该组，2 秒后仍未结束则升级终止；主动脱离该组的进程不在此保证内。

子进程使用 Rex 环境和父进程的 PATH，不复制主 Pi 的全部环境变量或临时凭证；模型认证应能由子 Pi 的正常配置加载。命令、子 agent 与项目扩展均以当前用户权限运行。

## 发布版本

推送 `v*` tag 后，[发版工作流](.github/workflows/publish.yml)会校验 tag 与 `package.json` 版本一致，执行语法检查和测试，自动创建带更新说明的 GitHub Release，再发布带来源证明的 npm 包。例如 `0.2.0-beta.1` 会自动标记为 GitHub 预发布版并更新 npm 的 `next`；正式版更新 `latest`。两个操作在同一个工作流内完成，因为使用 `GITHUB_TOKEN` 创建的 Release 不会触发另一个 Release 工作流。

维护者只需配置一次：在 npm 包的 **Settings → Trusted Publisher** 选择 **GitHub Actions**，填写：

| 配置项 | 值 |
| --- | --- |
| Organization or user | `xiangsam` |
| Repository | `pi-rex-adapter` |
| Workflow filename | `publish.yml` |
| Environment name | 留空 |
| Allowed actions | 允许通过 `npm publish` 直接发布 |

使用 [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)，无需添加 `NPM_TOKEN` secret。首次自动发布前，需要先在 npm 保存上述配置。

之后每次发版，将 `package.json` 改为尚未发布的新版本并提交，再从 Git 克隆仓库推送对应 tag。例如版本 `0.1.1` 已提交时：

```sh
git push origin main
git tag v0.1.1
git push origin v0.1.1
```

在 **Actions → Release and publish to npm** 查看结果，无需手动创建 Release。推送分支、编辑 Release 都不会发布 npm。tag 指向的提交必须包含此工作流和对应的包版本；推送 tag 不会自动修改版本号。

如果 npm 发布失败，GitHub Release 可能已经创建。修复原因后重跑失败的工作流即可，它会复用已有 Release。npm 不允许覆盖版本；如果已经发布成功，后续改动需使用新版本。README 改动会随下一个版本更新到 npm。

## 验证

```sh
npm test
npm run check
npm pack --dry-run
```

自动化覆盖 Rex 参数契约、上下文裁剪、交互式 Pi 参数、真实 shell 成功/失败路径、Pi 启动失败、批量通知与 reload 去重、BTW 显式回传、控制所有权、并发/重复 close 与取消退出竞态、失败原因展示、左右分组与溢出、BTW 并发复用和输入去重、手动移动保留、独立任务/进程/block 状态、概览与隐藏恢复、送达后 shell 自动清理、主 agent 安全收尾、关闭竞态和页码回收。另覆盖取消排队/已发出创建、慢清理与主线隔离、冷历史不再读取、异步拒收后的输入恢复、多轮顺序、人工核实恢复、浮层返回位置、慢终端背压、日志写入失败以及 shell 进程组终止。配置测试覆盖默认英文、全局/项目覆盖、错误配置回退、主看板与浮层语言切换、子会话继承父项目配置，以及 pane 上限与 reload 后保留已有布局。已用本机 Pi 1.4.0 的真实扩展 loader 验证注册。新增测试覆盖直接启动参数、事件订阅释放、退出/关闭、断线恢复、未知退出原因、旧结果不冒充新回合成功和回报去重；独立真实 Rex session 验证中英文 Pi 启动、原生 Pi 身份、启动失败以及父会话离线后的退出和缺失 pane 恢复。

本次开发环境禁止连接 Rex 本地 socket，因此尚未完成真实 Rex 布局/关闭进程的端到端验证。在 Rex 中安装后建议验收：

1. `/bg printf hello`：立即返回任务 ID，稍后主线收到 exit=0 与 hello。
2. `/bg sleep 5; echo done; exit 7`：执行期间主线可继续工作，随后收到 exit=7。
3. `/btw 回顾一下我们正在解决什么问题`：右侧出现新 Pi，主线保持焦点；侧聊回答不进入主线，`/btw-return` 后才回传。
4. 后台任务运行时 `/reload`：结束后只通知一次；在任务浮层关闭任务后不会影响其他资源，模型工具重复关闭同一任务保持幂等。
5. 同时完成多个后台任务：主线收到一批结果；主线正在工作时在下一回合边界接收，而不是空闲一条、工作一轮。
6. 默认 `panesPerTab: 2` 时，连续启动三个 `/rex-agent`：前两个在同一个 Agents tab 左右排列，第三个进入 Agents 2；每个都是完整 Pi TUI。
7. 连续启动三个 `/bg`：同样分为 Jobs 与 Jobs 2；与 Agents 分组相互独立。
8. 再次 `/btw 新问题`：不增加 pane，原侧聊继续回答；单独 `/btw` 聚焦它。
9. `/rex-tasks` 区分 completed/idle/open 与 completed/exited/closed；关闭 idle agent 保留其完成结果。
10. 检查主页面概览：每个活跃 Agent / Shell 一行，不显示 BTW，完成后移出，全部结束后隐藏；`/rex-tasks` 可查看历史结果。Shell 回报后 pane 自动关闭；subagent 待主 agent 调用 `rex_finish`。
11. 关闭 Jobs 2/3 的全部任务后，下一页不会因历史记录直接跳到 Jobs 4。

## 工作区与布局策略

Rex session 表达工作的归属，window/tab 表达注意力分组，pane 表达需要同时查看的内容。Pi session 保存对话，两种 session 独立：多个 Pi session 可以在同一个 Rex 工作区中运行，布局不会共享上下文或隔离文件修改。

```text
当前 Rex session（由用户选择；下图为默认 panesPerTab: 2）
├─ 当前主 tab：主 Pi | BTW
├─ Agents · <父 Pi ID>：agent 1 | agent 2
├─ Agents 2 · <父 Pi ID>：agent 3 | agent 4
└─ Jobs · <父 Pi ID>：build | test
```

- **一律左右分屏，每次将目标 pane 按 50% 分割**。每个分组 tab 默认最多安排两个本扩展管理的 pane，可用 `panesPerTab` 修改，满后新建下一页。保留横向排列，不自动根据窗口大小改成上下排列。
- Agents 和 Jobs 分开，分组归属于父 Pi session，标题带父 ID 前缀。同一 Rex session 内不同父 Pi 不会复用对方的任务 pane。主 tab 不被重命名。
- 同一个父会话的布局创建与关闭串行执行，避免并发创建重复 BTW 或超出容量。分组依据磁盘任务记录恢复，`/reload` 后仍可复用。
- 结果送达前保留输出的 shell block 仍占一个位置；送达后自动关闭，或在任务浮层显式关闭后，可以复用剩余 pane 所在的 tab。新页码只参考未关闭记录，已关闭的高页码不会继续抬高序号。空 tab 不主动删除，以免影响用户添加的内容，因此编号复用时旧空 tab 的标题可能与新 tab 相同。
- 用户移动过的 block 保留原位置，不被搬回；移动不改变父子关系、结果接收方和控制权限。新任务不会以已移出的 block 为分屏锚点。手动添加的非本扩展 pane 不计入上述 pane 上限，也不会自动重排。
- 选择布局或复用 BTW 时，若 Rex 明确返回直接启动的 Pi block 不存在，自动将记录标为关闭并继续创建；没有退出码时明确标注进程退出原因未知，保留已有回答。旧版 runner 任务仍需有效退出记录才能自动回收。结果和日志保留，已消失的页不再推进新 tab 页码。连接失败、session 不存在或创建结果不确定时仍停止新建；人工核实资源已停止且不存在后，可通过任务面板的恢复操作修复记录。

模型工具 `rex_tasks` 返回 `taskState`、`processState`、`blockState`：例如 agent 回答后可以是 `completed / idle / open`，后台命令结束后可以是 `completed / exited / open`。前两者来自子进程最后报告和退出记录；`blockState` 来自此次 Rex 检查，无法验证时为 `unverified` 并显示原因；已经确认关闭的记录强制为 `closed`，即使检查期间刚好发生关闭也不会返回旧的 open。Rex 不可达或旧版 runner 没有退出记录时，最后报告可能过期；不会将连接错误当作 block 已关闭。`resultAvailable` 标识是否存在 `result.json`；只有退出记录时仍展示退出原因/取消状态，并可在任务浮层选择“查看日志”读取保留日志，不伪造正常结果。底部状态行仅显示活跃的 Agent / Shell 数量，无活跃任务时清空；BTW 和已结束任务仍可在面板中查看。

旧版本已经打开的 Agents/Jobs tab 不自动迁移，新的分组规则作用于新任务。旧 BTW 需要在侧聊中 `/reload` 后才能接收复用问题，或关闭后重建。尚不支持同一父 Pi session 被多个独立主进程同时操控；串行锁覆盖当前 Pi 进程及其 reload。

Rex 命令以已安装 CLI 的 `rex __internal skill`、`rex split --help` 为依据。概念参考：[Rex 文档](https://www.superlogical.com/rex/docs)。
