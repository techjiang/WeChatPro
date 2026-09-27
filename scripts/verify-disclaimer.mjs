/**
 * 免责声明触达校验。
 *
 * 为什么单独做一道构建期断言：这份声明失效的方式**不是写错，而是被删掉**。
 * 单元测试盯的是 `src/legal` 里的文本，但声明真正要生效必须**同时**出现在
 * 四个出口：README、面板、CLI、引擎接口。任何一处断了，那一类使用者就看不到了
 * ——比如只用面板的人不会去读 README。
 *
 * 所以这里校验的是「触达面」而不是措辞，且刻意走**编译产物**：
 * 源码里有、构建后没了（被打包分支漏掉、被 tree-shaking 掉）才是真正的事故。
 *
 * 用法：node scripts/verify-disclaimer.mjs <panel.html>
 */

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const problems = [];
const report = (ok, message) => {
  if (!ok) problems.push(message);
};

const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : '');

/* 1) README：最外层入口，也是搜索引擎与仓库首页能看到的那一份 */
const readme = read('README.md');
report(readme.includes('## 免责声明与风险提示'), 'README 缺少「免责声明与风险提示」章节');
report(/高风险提示/.test(readme), 'README 顶部缺少高风险提示');
report(readme.includes('停止使用并删除本项目'), 'README 缺少「不同意即停止使用」的收尾条款');
for (const title of ['作者责任', '使用者责任', '数据与隐私', '许可与二次开发']) {
  report(readme.includes(title), `README 免责声明缺少分组「${title}」`);
}
report(readme.includes('docs/disclaimer.md'), 'README 未链接到 docs/disclaimer.md');

/* 2) 面板：只用面板的人（大多数）唯一的入口 */
const panelPath = process.argv[2] ?? '/tmp/panel.html';
const panel = read(panelPath);
report(panel.length > 0, `面板文件为空或不存在: ${panelPath}`);
report(panel.includes('renderDisclaimer'), '面板「关于」页未渲染免责声明');
report(panel.includes("api('/api/disclaimer')"), '面板未从接口拉取声明文本');
// 面板里硬编码一份声明 = 迟早和 src/legal 漂移，两处说法不一致时无从判断哪份有效。
report(!panel.includes('适销性'), '面板硬编码了声明文本（应与 src/legal 共用一份）');

/* 3) CLI：装之前就能看到完整条款，且启动横幅必然带风险提示 */
const cli = read('dist/cli.js');
report(cli.includes('disclaimer'), 'CLI 产物中缺少 disclaimer 子命令');
report(/可能导致微信账号被限制或封禁/.test(cli), 'CLI 启动横幅中缺少风险提示');

/* 4) 引擎接口：面板与脚本的实际数据源 */
const server = read('dist/api/server.js');
report(server.includes('/api/disclaimer'), 'API 产物缺少 /api/disclaimer 路由');

/* 5) 真的执行一次 CLI，确认声明能被打印出来（不是只存在于字符串里） */
const cliRun = spawnSync('node', ['dist/cli.js', 'disclaimer', '--json'], { encoding: 'utf8' });
if (cliRun.status !== 0) {
  report(false, `wechatpro disclaimer 执行失败: ${cliRun.stderr?.slice(0, 200) ?? ''}`);
} else {
  try {
    const payload = JSON.parse(cliRun.stdout);
    report(payload.risk?.level === 'high', 'disclaimer --json 未声明高风险等级');
    report((payload.notice?.length ?? 0) >= 5, 'disclaimer --json 风险提示条目不足');
    report(
      (payload.sections?.length ?? 0) >= 4,
      'disclaimer --json 声明的分组不足（作者责任/使用者责任/数据与隐私/许可）',
    );
    report(/不承担任何责任/.test(payload.short ?? ''), 'disclaimer --json 一句话版缺少免责结论');
  } catch (error) {
    report(false, `disclaimer --json 输出不是合法 JSON: ${String(error)}`);
  }
}

if (problems.length > 0) {
  process.stderr.write('免责声明触达校验失败：\n' + problems.map((p) => `  ✗ ${p}`).join('\n') + '\n');
  process.exit(1);
}

process.stdout.write('免责声明触达校验通过：README / 面板 / CLI / API 四个出口齐全，且同源\n');
