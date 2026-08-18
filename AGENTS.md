# 仓库指南

## 项目结构与模块组织

- `index.js` 在 `127.0.0.1:3000` 启动本地 HTTP 服务，提供采集页面并分发 `/api` 请求。
- `api/` 存放接口处理逻辑：`index.js` 管理国道目录，`road-part.js` 管理道路分段。
- `collect/` 是基于高德地图的浏览器采集与管理界面；HTML、CSS 和 `res/` 中的前端资源应保持在此目录。
- 道路分段大约以200km为限。
- `db/road-index.json` 是道路目录。每条道路对应一个 `db/Gxxx/` 目录，其中的 GeoJSON 分段文件采用 `Gxxx-part-<编号>.json` 命名。
- `lib/pako.js` 是引入的浏览器依赖；除非明确升级该资源，否则不要修改。

## 构建、测试与开发命令

项目使用 Node.js 与 npm：

```sh
npm install       # 安装服务及开发依赖
npm start         # 启动服务并打开采集页面
npm run dev       # 开发时自动重启服务
```

当前没有构建步骤、测试套件、格式化工具或 Linter。提交前应启动服务，并在 `http://127.0.0.1:3000/collect/index.html` 验证受影响的页面或接口。

## 代码风格与命名约定

遵循现有 CommonJS 风格：使用 `require()` 导入、`module.exports` 导出、分号结尾及四空格缩进。JavaScript 函数和变量使用 camelCase，例如 `getRoadParts`；道路编号和分段文件名使用清晰的国道代码与连字符形式，例如 `G318-part-27.json`。

保持 GeoJSON 数据有效且结构一致：分段应为 `Feature`，包含 `geometry.coordinates`，并在 `properties` 中提供 `index`、`description`、`road`、`distance`、`status`。新增道路目录时，必须同步更新 `db/road-index.json`。

## 测试指南

目前没有自动化测试和覆盖率要求。修改数据后，至少解析变更的 JSON：

```sh
node -e "JSON.parse(require('fs').readFileSync('db/G318/G318-part-1.json'))"
```

修改接口时，应验证成功请求，以及参数缺失或格式错误的请求。仅修改数据的拉取请求应保持聚焦，便于审核坐标变更。

## 提交与拉取请求指南

近期提交采用简短的中文、范围优先摘要，通常写明道路或操作，例如 `G228 秦皇岛-天津市`、`cdn地址替换`。请延续这一风格：用一句祈使式摘要说明受影响道路和改动。

拉取请求中应说明修改的道路和文件、涉及的采集或接口行为，并在有对应事项时附上链接。修改界面时请提供截图。不要在同一 PR 中混入无关的道路数据、前端界面和服务端重构。
