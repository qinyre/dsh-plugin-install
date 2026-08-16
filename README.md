# dsh-plugin-install

A dsh plugin that adds an "Install" tab to the Web UI's Settings page, so any dsh plugin can be installed by npm spec without leaving the app.

给 dsh 的 Web UI 设置页加一个「安装」Tab：按包名（npm spec）直接安装任意 dsh 插件，不必经过插件市场，也不必碰命令行。在 `dsh web` 和 DSH Desktop 里都能用。

## 安装

```sh
dsh plugin --profile web add dsh-plugin-install
```

装完打开 Web UI 的 设置 → 插件，多出来的「安装」Tab 就是它。卸载用同一个页面的按钮，或者 `dsh plugin --profile web remove dsh-plugin-install`。

本地开发时可以直接装源码检出：`dsh plugin --profile web add file:/path/to/dsh-plugin-install`（包里的 prepare 脚本会自己构建出 `lib/`）。

## 它做了什么

插件分两半。node 半边在 Web 服务器上注册 `/dsh-plugin-install/*` 路由：安装走 `dsh plugin add`（和命令行完全同一条路径，`dsh.profile.bundles` 由 CLI 负责 reconcile），卸载走 `remove`。client 半边贡献设置页的「安装」Tab：输入 spec、看进度、列出已装插件、卸载。

装完一个简单插件（patch 只含普通 insert 行）会尝试免重启热挂载；组合更复杂时如实提示需要重启。在 DSH Desktop 里运行时，重启按钮交给桌面壳层执行，插件自己不会脱离监督重启进程。

写操作有几道栅栏：spec 走字符白名单（拒绝参数注入和 shell 元字符，比如开头的 `-`、分号、重定向符），POST 要求同源，同一时刻只允许一个安装/卸载在跑。这些是纵深防御——服务器本身只绑回环地址。

## 开发

```sh
npm install
npm run typecheck
npm test
npm run build
```

有一个端到端 smoke 测试默认关闭，因为它需要旁边有一份 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 源码检出（与本仓库同级），且 Node ≥ 22.19：

```sh
DSH_DESKTOP_PLUGIN_SMOKE=1 npm test
```

它会临时建一个 DSH_HOME，把本插件装进 `web` profile，真实启动 `dsh web`，再逐个探测安装、卸载、取消等路由。

MIT License.
