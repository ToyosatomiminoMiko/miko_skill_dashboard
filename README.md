# miko_skill_dashboard

DeepSeek Harness（DSH 0.2.x）的 profile 插件 `@local/skill-dashboard`：左侧栏仪表盘（API Key + 技能库存），
外加**会话级技能选择**。

技能很多，但不是每次会话都需要。新建会话页不用点开任何浮层：输入卡下方直接排列技能矩阵，
点方块决定"本次会话启用哪些"。未启用的技能既不出现在模型可见的技能目录里，也调用不到——
是调用时硬拦截，不是提示词劝告。整页开场动画（虎鲸）与 hero 的居中逻辑保持上游原样，只做定位与底部留白。

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| `plugins/skill-dashboard/` | 插件本体（Host 半边 + Client 半边 + 单测），细节见 [插件 README](plugins/skill-dashboard/README.md) |
| `docs/skill-session-selection.feasibility.md` | 可行性研究：为什么只改目录正文、`{prepend:true}` 的顺序解法、硬拦截与 409，以及"chip 浮层 → 整页矩阵"的取舍 |

## 能力

- **会话级勾选**：空白会话用新建会话页的矩阵；已开始的会话用仪表盘第 5 个视图「会话技能」。
- **语义**：`{mode:'all'}` = 默认、不写状态、行为与插件不存在完全一致；`{mode:'set',names:[…]}` = 只启用这些，
  允许空数组（本次不用任何技能）。勾回全集自动收敛成 `mode:'all'`。
- **生效时机**：空白会话第一条消息即按选择下发；已开始的会话注入一条 `update:true` 的目录消息，下一轮生效；
  进程里没有活体 agent 的冷会话返回 409，不假装成功。
- **自愈**：选择只存在进程内存里。resume / fork / 重启后从日志里最后一条目录消息回读（`entries` 减去正文
  列出的行 = 启用集），`skill` 工具的 guard 随 agent 重建重装。
- **硬拦截**：`skill` 工具的参数名不在启用集 → 返回一句模型可读的 `skill "x" is not enabled in this session`。
  `/name` 是用户显式手势，刻意保留。

## 安装

本插件是 profile 级 bundle，与普通 npm 包的差别只有"由 DSH 的 plugin 系统加载 client 半边"：

1. 把本目录链进 profile 依赖。本机做法是写进 `~/.dsh/profiles/web/package.json`：

   ```json
   { "dependencies": { "@local/skill-dashboard": "link:/path/to/plugins/skill-dashboard" } }
   ```

   并在同一个文件的 `dsh.profile.bundles` 里加上 `@local/skill-dashboard`。
2. 包内 `cordis.patch.yml` 负责 insert 插件行（`apiKeyRef` 默认 `DEEPSEEK_API_KEY`），不需要改用户层补丁。
3. 依赖 DSH 0.2.x 的 client 插件 API 与 `conversation.hero.options` 槽位；升级 DSH 后跑一次单测确认目录文案骨架没变。

颜色全部使用 `--dsw-alias-*` 主题 token，深浅主题自动跟随。

## 测试

```bash
cd plugins/skill-dashboard && node --test test/
```

33 条：目录解析/裁剪/回读的纯逻辑、假 ctx 的路由与 guard 装配、Client 矩阵的点选提交与布局契约。
单测钉住的是上游目录文案的骨架（Host 侧唯一的漂移点），真机仍需一次端到端确认，见插件 README。
