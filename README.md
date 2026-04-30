# dev-scripts

一个用于集中存放各类开发脚本、用户脚本与小型自动化项目的公开仓库。

## 仓库定位

这个仓库主要用于整理和维护日常开发过程中沉淀下来的小项目，特点是：

- 体量较小，适合独立维护与快速迭代
- 以脚本、工具、浏览器用户脚本为主
- 强调实用性、可复用性与持续积累
- 每个子项目尽量保持相对独立，便于单独使用与迁移

## 目录结构

```text
dev-scripts/
  userscripts/
    currency-converter/
```

## 当前项目

### `userscripts/currency-converter`

外币自动转换人民币助手，一个浏览器用户脚本，用于自动识别网页中的外币价格并转换为人民币显示。

主要能力：

- 自动识别常见外币价格
- 支持替换模式与附加模式
- 支持白名单 / 黑名单
- 支持动态页面内容识别
- 支持汇率自动刷新

项目入口：

- 脚本文件：[userscripts/currency-converter/currency-converter.user.js](./userscripts/currency-converter/currency-converter.user.js)
- 项目说明：[userscripts/currency-converter/README.md](./userscripts/currency-converter/README.md)

## 使用说明

不同子项目的使用方式可能不同，请优先查看对应项目目录下的 `README.md`。

## 开源协议

本仓库采用 [MIT License](./LICENSE) 开源协议。
