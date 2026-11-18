# 仓库指令

DSH 插件「旁边记」：浏览器半侧在 `src/client/`，宿主半侧在 `host/` 与 `index.js`。
构建产物 `client/client.js` 提交进仓库、由壳直接加载。

## 构建

- 改 `src/` 后必须 `npm run build` 并提交产物；不要手改 `client/client.js`，CI 会逐字节比对。
- 提交前跑 `npm run check`（lint + typecheck + build + test + catalog:check）。

## 测试：先规则，再用例，最后测试

顺序不能反，细节见 [docs/testing.md](docs/testing.md) 与 [docs/case-design-method.md](docs/case-design-method.md)。

1. **规则**：`tests/catalog/design.yaml`。新行为先加/改规则，写清 `statement`、`failure`、有效/无效分支。
2. **用例**：`tests/catalog/*.yaml`。稳定 ID（永不复用），`rules` 指向规则，`expected` 用业务语言。
   暂时不写测试也可以，标 `state: planned` 并用 `reason` 说明；不允许既无用例也无记录。
3. **测试**：`tests/*.test.mjs`。用例名以 ID 开头（`t.test('NOTE-004 …')`），把完整名字填进 `automation.test`。

硬规则：

- 不要从已有测试反推用例；`expected` 是验收标准，只有人能改。
- 改动已评审规则（`statement` / `failure` / `branches`）后必须重新评审：
  `npm run design:review -- --since origin/main` 看改动，`--approve --by <名字>` 重新签，否则 `catalog:check` 会报「评审已过期」。
- 不要为了过 CI 删除或改写用例来迁就实现；实现不符合用例时改实现，或先与人确认。
- 新增/修改行为时优先补用例；`npm run catalog:check` 与 `review --strict` 是硬门禁。

## 验证

- `npm run test:run`：逐用例执行记录与报告（`.test/runs/`，不提交）。
- `npm run test:mutate`：确认用例能抓到真实缺陷（改实现→重建→跑用例→还原）。
- 发布前 `npm run test:strict`：全部通过且执行记录已复核。

## 提交

- 不要自动 `git push` 或开 PR；只有用户明确要求时才推送。
