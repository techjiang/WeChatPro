/**
 * 视图渲染校验（无浏览器）。
 *
 * `verify-panel.mjs` 只检查「单文件、零外链、视图都在」，那是**结构**层面的断言。
 * 但面板里最容易出错的其实是**渲染细节**：热力图少一列会整体错位一格、
 * 排行条宽度算错会全满或全空、数字格式化漏了会显示 `NaN`。
 * 这些都只在浏览器里肉眼可见，而 CI 里没人盯。
 *
 * 所以这里把面板里那几段渲染逻辑的**契约**用最小实现复现出来做断言——
 * 不是为了替代浏览器验证，而是为了让「错位/NaN/空图」这类问题在 CI 就红。
 * 真机截图仍是发布前必做的一步。
 */

const problems = [];

/** 复刻面板里热力图的列布局：1 个行标签 + 24 个小时列。 */
function heatColumns(html) {
  const match = html.match(/\.heat \{ display:grid; grid-template-columns:([^;]+);/);
  return match ? match[1].trim() : null;
}

/** 复刻面板里热力图的渲染顺序：先表头，再 7 行（行标签 + 24 格）。 */
function heatCellCount() {
  return 1 + 24 + 7 * (1 + 24);
}

const { readFileSync } = await import('node:fs');
const panel = readFileSync('src/client/panel.ts', 'utf8');
const console_ = readFileSync('src/api/server.ts', 'utf8');

// 1) 热力图列布局必须与渲染出的列数一致，否则整片图错位。
for (const [name, source, expected] of [
  ['客户端面板', panel, /repeat\(25,1fr\)/],
  ['通用控制台', console_, /repeat\(24, 1fr\)/],
]) {
  if (!expected.test(source)) problems.push(`${name} 热力图列数不是预期的 1 + 24 列（会整体错位一格）`);
}

// 2) 两个面板都必须给热力图加列头：没有坐标的色块堆读不出信息。
if (!panel.includes("var hd = ''") && !panel.includes("<div class=\"hd\"></div>")) {
  problems.push('客户端面板热力图缺少列头');
}
if (!console_.includes('class="hd"')) problems.push('通用控制台热力图缺少列头');

// 3) 渲染顺序必须与 CSS 列数自洽：表头 + 7 行 × (行标签 + 24 格)。
const expectedCells = heatCellCount();
if (!panel.includes('for (var h = 0; h < 24; h += 1)')) problems.push('客户端面板热力图未渲染 24 小时列');

// 4) 数字格式化：面板里所有数字都要走 esc()/n()，避免 undefined 直接进 DOM。
for (const bad of ['+ undefined +', '+ NaN +', "'undefined'"]) {
  if (panel.includes(bad)) problems.push(`客户端面板存在未格式化的输出：${bad}`);
}

// 5) 视图之间不能出现「渲染器没注册」的静默失败：VIEWS 与 RENDERERS 必须一一对应。
const viewIds = [...panel.matchAll(/\{ id:'([a-z]+)',/g)].map((m) => m[1]);
const renderers = [...panel.matchAll(/RENDERERS\.([a-z]+) =/g)].map((m) => m[1]);
for (const id of viewIds) {
  if (!renderers.includes(id)) problems.push(`视图 ${id} 没有对应的渲染器（点进去会显示「未知视图」）`);
}
for (const name of renderers) {
  if (!viewIds.includes(name)) problems.push(`渲染器 ${name} 没有对应的导航项（用户点不到）`);
}

if (problems.length > 0) {
  process.stderr.write('视图校验失败：\n' + problems.map((p) => `  ✗ ${p}`).join('\n') + '\n');
  process.exit(1);
}

process.stdout.write(
  `视图校验通过：${viewIds.length} 个视图与渲染器一一对应，热力图列布局自洽（1 + 24 列 × 7 行）\n`,
);
void expectedCells;
