# dsh-plugin-install

A dsh plugin that adds an "Install" tab to the Web UI's Settings page, so any dsh plugin can be installed by npm spec without leaving the app.

一个 dsh 插件：在 Web UI 的设置页中新增「安装」标签页，可按 npm spec 安装任意 dsh 插件，无需借助插件市场，也无需使用命令行。在 `dsh web` 里用上面的命令安装；桌面客户端 [DSH Desktop](https://github.com/qinyre/dsh-Desktop) 则开箱预装了这个标签页，装好即用。

## 安装

```sh
dsh plugin --profile web add dsh-plugin-install
```

安装后打开 Web UI 的 设置 → 插件，即可看到新增的「安装」标签页。卸载可在同一页面完成，或执行：

```sh
dsh plugin --profile web remove dsh-plugin-install
```

开发时也可以直接安装本地源码检出：`dsh plugin --profile web add file:/path/to/dsh-plugin-install`。包内的 `prepare` 脚本会自动构建出 `lib/`。

## 工作原理

插件由服务端与客户端两部分组成。服务端在 Web 服务器上注册 `/dsh-plugin-install/*` 路由：安装与卸载分别调用 `dsh plugin add` / `remove`，与命令行完全同一条路径，`dsh.profile.bundles` 的同步由 CLI 负责。客户端向设置页贡献「安装」标签页，提供 spec 输入、安装进度、已安装列表与卸载操作。

对于 patch 仅包含普通 insert 行的简单插件，安装后会尝试免重启热挂载；组合较复杂的插件则会明确提示需要重启。在 DSH Desktop 中运行时，重启操作交由桌面壳层执行，插件不会绕开监督自行重启进程。

写操作设有三重防护：spec 采用字符白名单校验，拒绝参数注入与 shell 元字符（如首字符 `-`、分号、重定向符）；POST 请求要求同源；同一时刻仅允许一个安装或卸载操作运行。服务器本身仅绑定回环地址，上述措施构成纵深防御。

## 开发

```sh
npm install
npm run typecheck
npm test
npm run build
```

端到端 smoke 测试默认关闭，它要求同级目录下存在 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 源码检出，且 Node ≥ 22.19：

```sh
DSH_DESKTOP_PLUGIN_SMOKE=1 npm test
```

该测试会创建临时 `DSH_HOME`，将本插件安装进 `web` profile，启动 `dsh web`，并对安装、卸载、取消等路由逐一探测。

## 许可

[MIT](./LICENSE)
