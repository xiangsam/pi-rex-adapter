# pi-rex-adapter

**English** | [简体中文](https://github.com/xiangsam/pi-rex-adapter/blob/main/README.zh-CN.md)

**Give your Pi tasks room to run.**

Send a code review to another Pi agent. Explore a side question beside your main conversation. Let a long build finish in the background. pi-rex-adapter gives each task a place in Rex—and brings the results back when they are ready.

- **Full Pi subagents.** Delegate work to interactive Pi sessions in dedicated tabs. Get results automatically, then step into a session whenever you want to continue the conversation.
- **A conversation on the side.** `/btw` opens an independent Pi beside your main chat. Only the conclusions you choose to return enter the main conversation.
- **Background jobs that report back.** `/bg` runs long shell commands, delivers their exit code and output, and closes the pane after delivery.
- **A compact view of active work.** One line per task. Finished tasks leave the overview; history, logs, and controls stay available in a single overlay.

Built to stay out of the way: native Pi tools remain available, user-adjusted layouts are respected, and monitoring stops when no tasks need it. Configuration is just two settings: UI language and panes per tab.

## Installation

Requires **Pi 1.4+**, **Node.js 22.19+**, and Rex with support for `window new/split --json --shell=none --focus=false` and `block inspect --json`.

Run inside a Rex terminal:

```sh
pi install npm:pi-rex-adapter
# Run /reload in an existing Pi session, or restart Pi.
```

You can also install from GitHub:

```sh
pi install git:github.com/xiangsam/pi-rex-adapter
```

Or try it for one session:

```sh
pi -e git:github.com/xiangsam/pi-rex-adapter
```

The parent Pi must run inside Rex. The adapter uses `REX_SESSION` and `REX_BLOCK` to target the parent block, regardless of which pane currently has focus. If `rex` is not on `PATH`, it checks the standard macOS Rex and Rex Beta application locations; `PI_REX_BIN` can specify the executable. Child sessions use the current Pi entry point unless `PI_REX_PI_BIN` is set.

Parent and child processes must share the same machine and filesystem. Remote Rex hosts are not supported.

## Quick start

```text
/btw What would we gain by making this module event-driven?
/rex-agent Review the authentication module. Report risks and relevant files without making changes.
/bg npm test
/rex-tasks
```

| Command | What it does |
| --- | --- |
| `/btw <question>` | Opens or reuses a side conversation to the right of the main Pi |
| `/btw` | Focuses the existing side conversation |
| `/rex-agent <task>` | Starts an interactive Pi subagent in an Agents tab |
| `/bg <command>` | Starts a background shell job in a Jobs tab |
| `/rex-tasks` | Opens the task manager overlay |

The main agent can also launch and manage tasks through structured tools. Completion arrives automatically; it does not need to poll for results.

**Closing policy:** shell jobs close after their results are delivered; the main agent closes completed subagents after reviewing them; BTW conversations stay open.

## Configuration

Both settings are optional:

```json
{
  "language": "en",
  "panesPerTab": 2
}
```

- **Global:** `~/.pi/agent/rex.json`, or `rex.json` inside `PI_CODING_AGENT_DIR` when that variable is set.
- **Project:** `.pi/rex.json` in the current working directory. Project fields override global fields.

| Setting | Default | Behavior |
| --- | --- | --- |
| `language` | `"en"` | `"en"` or `"zh"`. Covers the **main agent's overview**, including titles, task states and counts, plus overlays, action feedback and child-session notices. |
| `panesPerTab` | `2` | A positive integer limiting adapter-managed panes in each Agents or Jobs tab. Set `1` for a separate tab per task, or `3` to keep the first three tasks together and open a new page for the fourth. |

For example, `{"language":"zh"}` in the project file changes only the UI language. The pane limit still comes from the global configuration or its default.

Settings are read at startup, session switches, and `/reload`. No default file is created and no configuration watcher is added. Reload an existing child Pi separately to update its UI language. Children launched into another checkout through `cwd` still read their parent project's configuration. Invalid settings report their source and fall back to inherited or default values; other valid fields still apply.

Language settings leave task text, agent answers, logs, underlying errors, and structured status values intact. They do not set the model's response language. Tool names, slash commands, and their descriptions remain in English.

The pane limit affects future launches only. Existing panes are not moved, resized, or closed. Splits are always horizontal: each new pane takes the right half of its target pane. The adapter does not rebalance the entire tab. BTW keeps its own reusable pane beside the parent, outside this limit. Manually added panes do not count toward it.

## Side conversations

`/btw <question>` opens a full interactive Pi in the **right half of the parent block**, keeping focus on the main conversation by default. Click the pane, run `/btw` without a question, or choose **Focus task** in `/rex-tasks` to enter it.

The conversation has its own Pi session. By default it inherits the parent's model, thinking level, and a text snapshot of the current branch: up to 48,000 recent characters, including summaries but excluding images, thinking, and tool output. This is a text snapshot, not a complete Pi session clone.

Further `/btw <question>` calls reuse the same conversation and history. Questions go through a file inbox into Pi's input API; no terminal keystrokes are simulated. Questions arriving while the child is busy are combined when it becomes idle. The original context snapshot is retained, so include any newer background in the question itself.

An input is acknowledged only after it appears in the child's Pi session. Pi's input API returns no asynchronous confirmation, so an unconfirmed input is retained rather than repeatedly resent while authentication or input handlers may still be running. After 10 seconds, the child status line shows a notice. Fix the model, authentication, or input error, then run `/reload` in the child to retry.

To send a conclusion back, run this **inside the side conversation**:

```text
/btw-return
/btw-return Use option B. Change the cache layer first and leave the rest for later.
```

Without arguments, it returns the last assistant answer. With arguments, it returns only that text. The conversation stays open and can return more conclusions later; ordinary answers are not automatically sent to the parent.

BTW enables only `read,grep,find,ls` by default and disables MCP. This is a tool selection, not a security sandbox. Files are not automatically merged. To change the existing conversation's `cwd` or model, close it before creating another. A normally exited but retained BTW block is closed and replaced when a new question is submitted.

## Interactive subagents

`/rex-agent` starts a **full interactive Pi**, without `--print`, in an Agents tab. Every settled turn returns its answer to the parent. The Pi session remains open, so you can focus it and continue the conversation; later turns produce separate reports.

After reviewing a completed result, the main agent calls `rex_finish` when no further interaction is needed. This requires a completed task with an idle or exited process. It will not finish an active task or a BTW conversation. Failed or interrupted tasks stay available for diagnosis or follow-up; after reviewing them, use `rex_control({id, action: "close"})` to explicitly close them. Closing is a main-agent action, not a child that exits itself.

Child sessions do not register this adapter's delegation tools. Tasks share a working directory unless the main agent supplies another `cwd`. For parallel writers, prepare separate checkouts and pass their paths explicitly. The adapter does not create worktrees or manage role packs, model fallbacks, or persistent specialists.

If no name is supplied, the task's first line becomes a short, readable name.

## Background shell jobs

`/bg` runs `/bin/sh -c` in a dedicated terminal block in a Jobs tab, using the parent's working directory by default and closed stdin.

Full stdout and stderr are written to `output.log` and displayed in the block. Both destinations apply backpressure; a write failure stops the shell and attempts to record the failure. When the command exits, the parent receives its exit code, the last 16,000 characters of output, and the artifact path. A long-running server reports completion only when it exits.

The command process exits when it finishes. The adapter closes its block once the parent session has durably received the result, including nonzero exits. Merely queuing a notification does not count as delivery. If the parent is offline, the block is retained until the parent resumes and receives the result. Logs and task records remain available afterward.

Use this for commands you choose to start in the background. **The adapter does not take over an already-running native `bash` command or implement Ctrl+B/timeout-based backgrounding.** It does not rerun an existing command to make it a background task.

## Task overview and controls

Above the parent's editor, the overview shows only running, starting, or unverified Agent and Shell tasks. Each occupies at most one line, with its type, name, state, and a task excerpt. BTW conversations are omitted. Completed, failed, interrupted, cancelled, and closed tasks disappear from the overview; when none remain, the overview disappears too. History is retained.

The display uses muted slate blue (`#7e98ad`), thin separators, and grey body text. At most six tasks appear; the task manager contains the rest. Terminal control characters are stripped and narrow panes truncate lines.

`/rex-tasks` is the single management entry point. It opens a native Pi overlay, up to 84 columns wide, with an opaque blue-grey background, border, padding, and a highlighted selection. Closing it restores the underlying page.

- Use arrow keys and Enter to select; Esc goes back one level (details/error → task menu → task list → close). Lists, details, and logs support PageUp/PageDown. Repeated `/rex-tasks` invocations do not stack task managers.
- Task menus contain details, logs, focus, interrupt, finish, and close actions. Returning from details or logs preserves the task menu; returning to the list preserves the selection and scroll position. Errors return to the same menu.
- The first list entry toggles the main-page overview. This preference is saved per parent Pi session.
- Closed tasks retain their results and logs. BTW conversations remain manageable here.
- An uncertain launch without a block ID does not offer unusable focus or close actions. After checking Rex and verifying that the resource is absent and the related process has stopped, use **Confirm resource removed…** to repair the record. This does not send a close or kill command. A connection failure alone is not evidence that a resource is gone.
- Queries, details, and action errors stay in overlays. Creating a task gives brief status-bar feedback instead of a JSON dump in the main conversation.

Only `/btw`, `/bg`, `/rex-agent`, and `/rex-tasks` are registered in the parent. The child also has `/btw-return`. Separate panel, overview, focus, interrupt, close, and log slash commands are consolidated into the overlay.

The overview reflects the child's last reported activity. Opening it does not inspect every Rex block. Failed automatic shell cleanup is shown in the task manager and retried in the background. Cleanup runs in a separate serial queue; model turn boundaries never wait for Rex CLI calls or disk scans.

## Tools for the main agent

| Tool | Parameters and behavior |
| --- | --- |
| `subagent` | `task`; optional `name,cwd,model,fork`. Starts an interactive Pi with automatic reports. |
| `btw` | The same optional fields; omit `task` to focus, or supply a question to reuse the right-side conversation. Reports are explicit. |
| `bg_run` | `command`; optional `name,cwd`. Starts a shell job with automatic completion delivery. |
| `bg_logs` | `id`. Reads the last 16 KB of shell output. A missing log returns `logAvailable:false` and a note; agent/BTW results are available through `rex_tasks`. |
| `bg_kill` | `id`. Closes an owned shell block. |
| `rex_finish` | `id`. Closes a completed, idle or exited task after review; retains records. |
| `rex_tasks` | Optional `id` queries one owned task; omit it to list all. Always returns an array. Includes task, process, and block states and the actual window. Failed inspection reports `unverified` with the reason. |
| `rex_control` | `id,action`, where action is `focus`, `interrupt`, or `close`. |

`fork:false` omits the parent snapshot. `interrupt` sends Escape to Pi and interrupts only its current turn, leaving the interactive session open. Use `bg_kill` or `close` to stop a shell job. Control tools accept only full task UUIDs owned by the current parent session, not arbitrary Rex block IDs.

Inside Rex, launch tools and `rex_finish` are exposed directly by default. Diagnostic, log, and control tools use Pi's deferred discovery. If neither `tool_search` nor `codemode` is active, necessary controls are exposed directly while tasks need attention. A non-Rex session with no owned tasks gains no default tool declarations or system-prompt rules. Native Pi tools are unchanged.

## Workspace and layout

A **Rex session** groups the workspace. A **window/tab** groups attention. A **pane** is a position in that layout, while a terminal **block** hosts a process. A **Pi session** stores a conversation. Multiple Pi sessions can share a Rex workspace without sharing conversation context or isolating file changes.

With the default `panesPerTab: 2`:

```text
Current Rex session (selected by the user)
├─ Main tab: main Pi | BTW
├─ Agents · <parent Pi ID>: agent 1 | agent 2
├─ Agents 2 · <parent Pi ID>: agent 3 | agent 4
└─ Jobs · <parent Pi ID>: build | test
```

- All splits place the new pane on the right, taking 50% of the target pane. The adapter never switches to vertical stacking based on window size.
- Agents and Jobs have separate groups, owned by a parent Pi session. Titles include a short parent ID. Different parents do not reuse one another's task panes. The main tab and Rex session are not renamed; Rex sessions are not automatically created.
- Layout creation and closing are serialized per parent. Group membership is restored from task records after `/reload`.
- Shell blocks retained for undelivered results still occupy a slot. After delivery and cleanup, the remaining tab can accept another task. Only open records advance page numbers.
- Empty tabs are not deleted automatically because users may have added content. Reused page numbers can therefore produce the same title as an older empty tab.
- Blocks moved by the user stay where they are. A moved block is not reused as a split anchor outside its original managed window. Moving it does not change ownership, result delivery, or control permissions. Manually added panes do not count toward the configured limit and are not rearranged.
- An inspection failure or uncertain creation stops further creation in that group. The adapter does not interpret a failed connection as a missing resource. Verified removal can be recorded through the task manager's recovery action.

`rex_tasks` separates `taskState`, `processState`, and `blockState`. An answered agent can be `completed / idle / open`; a finished shell job can be `completed / exited / open`. Task and process states come from the last activity and exit records. Block state comes from the current Rex inspection, or `unverified` if inspection fails. Confirmed closed records always report `closed`, including when a close races with inspection.

`resultAvailable` says whether `result.json` exists. A task with only an exit record still exposes its cancellation or exit reason and retained logs; a successful result is not invented. The footer counts only active Agent and Shell tasks.

Control responses use the same derived task state as `rex_tasks`. Successful closes and confirmed resource removal also save that outcome in `run.json`; repeating a close repairs an older closed record's stale status. While a task remains open, `run.json` is a lifecycle manifest, not a live status feed: query `rex_tasks` to combine activity, result, and exit records. Historical records are not rewritten in a background migration.

Existing tabs are not automatically migrated. Older BTW children need `/reload` to support question delivery, or can be closed and recreated. Multiple independent parent processes controlling the same Pi session are not supported; the layout lock covers one Pi process and its reloads.

## Delivery and recovery

```text
Parent Pi → task record → Rex block → runner → Pi / shell
    ↑                                             ↓
    └── batched rex_result ← completion / return files
```

The parent collects results in a local inbox. While it is working, `turn_end` or `agent_before_settle` combines ready results into one custom message and requests a continuation. It does not wait for the entire task to become idle or queue a separate follow-up per result. While idle, it collects results for 300 ms before waking the agent once.

Messages are not forced into an in-progress model response or tool execution. Pending results do not immediately restart a parent that the user aborted; they can be received on the next user-started run. Multi-turn reports carry ordering information and are delivered in order after recovery. Older reports without that information fall back to file modification time.

Startup makes one recovery discovery. A session with no tasks to monitor creates no task directory, watcher, or timer. Active monitoring uses relevant file events and a five-second reconciliation interval, ignoring log-content changes. Closed tasks whose results have been delivered leave monitoring; history is loaded when requested. Unchanged overview content is not redrawn. Model boundaries consume already-collected results without waiting for scans.

Artifacts are stored under the parent's Pi session directory at `rex-adapter/<parent-session-id>/<task-id>/`, with private permissions. They include task text, snapshots, child sessions, logs, and exit records.

Reloading or reopening the same parent session discovers pending results and deduplicates them against persisted message receipts, including older single-receipt records. Switching sessions does not deliver old task results into a new parent. Returning to the original parent permits delivery. Exiting the parent does not close its blocks; results wait for that parent to resume.

Cancellation is checked after queued layout work and before resource operations, and is passed to CLI subprocesses. Cancelling before a creation request is sent prevents a new block. Once a request has been sent, cancellation, timeout, or an invalid acknowledgment produces an `uncertain` record rather than an automatic retry that could duplicate work.

Repeated or concurrent closes are idempotent. A task completed before closing keeps its outcome; an exit caused by closing an active task is classified as cancelled, with signal or startup errors retained. Records are not automatically deleted, and long-running jobs can keep growing their full logs.

On POSIX, shell jobs have an isolated process group. The runner forwards termination signals to the group and escalates after two seconds if necessary. Processes that deliberately leave that group are outside this guarantee. SIGKILL, a Rex crash, or power loss may prevent exit records from being written, leaving the last state stale. Missing records never imply success. Ordinary reloads deduplicate delivery; crash windows do not provide transactional exactly-once guarantees.

Children use the Rex environment and the parent's `PATH`, without copying the parent's entire environment or temporary credentials. Model authentication should be available through the child's normal Pi configuration. Commands, agents, and project extensions run with the current user's permissions.

## Development and verification

```sh
npm test
npm run check
npm pack --dry-run
```

The regression suite covers CLI arguments, context snapshots, interactive Pi startup, real shell success and failure, bounded result payloads, batching and deduplication, ownership, cancellation, close races, layout overflow and restoration, BTW reuse and input confirmation, task overlays, cleanup after delivery, and manual recovery. It also covers slow-terminal backpressure, log failures, process-group termination, configuration precedence, language switching, and configurable pane limits. Registration has been checked with the Pi 1.4.0 extension loader.

The development environment could not access the Rex socket, so real Rex layout, focus, and close behavior still require end-to-end verification. Suggested smoke tests inside Rex:

1. `/bg printf hello`: receive `exit=0` and `hello`, then see the pane close after delivery.
2. `/bg sleep 5; echo done; exit 7`: continue working while the job runs, then receive the nonzero exit.
3. Open a BTW conversation: verify the right-side split and retained main focus; return a conclusion with `/btw-return`.
4. Reload the parent while jobs run: receive each result once after completion. Repeat a close and verify that it is harmless.
5. Finish several jobs together: receive a batch instead of a separate model turn for every result.
6. With the default pane limit, launch three agents, then three shell jobs: verify separate Agents/Jobs groups and second pages.
7. Ask another BTW question: verify that the same conversation is reused and bare `/btw` focuses it.
8. Verify that finishing an idle agent preserves its result and that its task, process, and block states remain distinct.
9. Check that finished tasks leave the overview but remain in history. Shell panes close after delivery; agents wait for the main agent to finish them.
10. Close all tasks in Jobs 2 and Jobs 3: verify that closed pages do not force the next new page to be Jobs 4.
11. Change UI language and pane limit, then reload: verify the main overview and future launches while preserving existing layouts.

## Publishing releases

Pushing a `v*` tag triggers [the release workflow](.github/workflows/publish.yml). It checks that the tag matches `package.json`, runs syntax checks and the test suite, creates a GitHub Release with generated notes, then publishes to npm with provenance. Versions such as `0.2.0-beta.1` automatically become GitHub pre-releases and use npm's `next` tag; stable versions use `latest`. Both operations run in the same workflow: a release created using `GITHUB_TOKEN` does not trigger another release workflow.

One-time maintainer setup: in the npm package's **Settings → Trusted Publisher**, select **GitHub Actions** and enter:

| Field | Value |
| --- | --- |
| Organization or user | `xiangsam` |
| Repository | `pi-rex-adapter` |
| Workflow filename | `publish.yml` |
| Environment name | Leave empty |
| Allowed actions | Enable direct publishing with `npm publish` |

This uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/); no `NPM_TOKEN` secret is needed. The npm-side configuration must be saved before the first automated release.

For each release, update `package.json` to a new, unpublished version, commit the changes, and push the matching tag from a Git clone. For example, with version `0.1.1` already committed:

```sh
git push origin main
git tag v0.1.1
git push origin v0.1.1
```

Check **Actions → Release and publish to npm** for the result. There is no need to create a Release manually. Branch pushes and Release edits do not publish npm. The tag must point to a commit containing this workflow and the matching package version; pushing a tag does not change the version for you.

If npm publication fails, the GitHub Release may already exist. Fix the cause and rerun the failed workflow; it reuses the existing Release. npm versions cannot be overwritten: if publication already succeeded, use a new version for further changes. README changes reach npm with the next package version.

## Acknowledgments

Inspired by [pi-herdr-agents](https://github.com/giuseppecrj/pi-herdr-agents) for independent agents, non-blocking delegation, and result delivery, and [pi-background-tasks](https://github.com/SakikoTogawa233/pi-background-tasks) for persistent task records and completion notifications. Rex supplies the workspace, layout, and process hosts. This is an independent implementation, with no source copied from those projects; it does not reproduce their entire feature sets.

Rex CLI behavior is based on the installed `rex __internal skill` and `rex split --help`. See the [Rex documentation](https://www.superlogical.com/rex/docs) for its workspace concepts.

## License

[MIT](./LICENSE)
