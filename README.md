<div align="center">

<img src="docs/images/banner.svg" width="100%" alt="dsh-plugin-install — 让每个 dsh 插件在原地看见自己的更新" />

[![npm version](https://img.shields.io/npm/v/dsh-plugin-install?color=38bdf8&label=npm)](https://www.npmjs.com/package/dsh-plugin-install)
[![downloads](https://img.shields.io/npm/d18m/dsh-plugin-install?color=38bdf8&label=downloads%20%2F%2018m)](https://www.npmjs.com/package/dsh-plugin-install)
![dsh](https://img.shields.io/badge/requires-dsh%20%3E%3D%200.2.0-4c6ef5)
![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-64748b)
[![License: MIT](https://img.shields.io/badge/license-MIT-22c55e)](./LICENSE)

**dsh 插件页的更新层。** 绿点亮起、一键更新、原地热替换。

<sub>Updates for every DSH plugin, right where the plugin list lives.</sub>

[功能总览](#功能总览) · [检测与更新规则](#检测与更新规则) · [安装](#安装) · [安全](#安全)

</div>

## 这是什么

dsh 0.2.0 起，官方插件页自带安装、卸载与启停管理，本插件随之收窄为一件事：**让每个插件在原地看见自己的更新**。安装新插件用插件页自带的「添加插件」即可；本插件不再提供独立的设置页标签。

<p align="center"><img src="docs/images/screenshot-updates.png" width="88%" alt="插件页的更新提示"></p>

## 功能总览

| 能力 | 说明 |
|:--|:--|
| 🟢 **更新绿点** | 有新版本的插件在图标右上角亮起绿点，启用开关旁出现「更新」按钮；没有更新的插件不显示任何额外元素 |
| 🏷 **详情页标签** | 点进插件详情页，标题旁挂「可更新 x.y.z」绿色标签（github 安装则提示远端有新提交），页首操作区同样提供「更新」 |
| 🔢 **侧栏角标** | 侧栏「插件」导航行上的计数角标：有待更新插件的个数一目了然 |
| 🔥 **热替换** | 更新完成后多数情况原地生效——正在运行的插件被自动摘下再挂上，新代码即刻加载 |
| ♻️ **兜底重启** | 无法热替换时按钮翻转为「重启」：桌面端由壳层重启 sidecar，独立 `dsh web` 由插件接力重启，页面恢复后自动刷新 |
| 🧹 **强制卸载** | 详情页「强制卸载」通道绕过发布冷静期直接移除——官方卸载被冷静期拦截时使用，两次点击确认，不可撤销 |

## 检测与更新规则

- **检测来源**：更新走的仍是 `dsh plugin add` 这条 CLI 路径——npm 安装的对照 registry 的 latest 版本号，github 安装的对照仓库 HEAD 提交，本地链接则如实标注、不做检查。
- **方向核对**：更新前核对方向，registry 的 latest 不高于已装版本时拒绝执行，绝不把更新变成降级；更新完成后还会核对实际落地的版本号，与 registry latest 不一致时如实提示，而不是谎报成功。
- **发布冷静期绕行**：每次 add 与 remove 都附带 `--config.minimum-release-age=0`。pnpm 11 默认开启 24 小时发布冷静期，`@latest` 会被静默解析到窗口外的旧版本，发布当天点更新等于原地不动；它还会在每次操作前对整个 lockfile 做策略校验，只要里面有窗口内发布的条目（例如显式钉版安装带进来的传递依赖），安装与卸载会一并被 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` 拦死——界面上点名的操作不受这层默认限制（旧版 pnpm 不认识该参数时自动去掉重试）。
- **热替换与重启**：落盘之后尽量原地生效——正在运行的插件被自动摘下再挂上，宿主的活重组按包名重新解析，pnpm 换盘后的新代码即刻加载，浏览器端刷新一次页面即与新版对齐。热替换不适用时（组合含无法行级停用的行、插件当前未运行、或更新的是本插件自身），按钮翻转为「重启」——桌面宿主里交由壳层重启受监督的 sidecar，独立运行 `dsh web` 时则由插件自行接力：分离的中转进程等旧进程让出端口后按原启动命令拉起新实例，终端场景下再交接回原终端。

## 安装

```sh
dsh plugin --profile web add dsh-plugin-install
```

打开 Web UI 的插件页即可；要求 dsh 0.2.0 或更高版本。卸载执行：

```sh
dsh plugin --profile web remove dsh-plugin-install
```

开发时也可以直接安装本地源码检出，包内的 `prepare` 脚本会自动构建出 `lib/`：

```sh
dsh plugin --profile web add file:/path/to/dsh-plugin-install
```

## 安全

写操作设有三重防护：更新目标只能取自已安装清单；POST 请求要求同源——官方桌面壳转发而来的请求没有 Origin 头，仅当回环 Host、回环连接对端、无代理痕迹且无跨站 Sec-Fetch-Site 标记时放行；同一时刻仅允许一个安装、卸载或更新操作运行。服务本身只绑定回环地址，上述措施构成纵深防御。

## 开发

```sh
npm install
npm run typecheck
npm test
npm run build
```

端到端 smoke 默认关闭，要求同级目录下存在 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 源码检出，且 Node ≥ 22.19：

```sh
DSH_DESKTOP_PLUGIN_SMOKE=1 npm test
```

它会创建临时 `DSH_HOME`，将本插件安装进 `web` profile，启动 `dsh web`，并对安装、卸载、取消、更新检查等路由逐一探测。

## 许可

[MIT](./LICENSE)

---

<div align="center">
<sub>觉得好用的话，去 <a href="https://github.com/qinyre/dsh-plugin-install">仓库首页</a> 点一个 ⭐ Star 是最快的鼓励。</sub>
</div>
