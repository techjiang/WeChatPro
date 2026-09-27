/**
 * 面板产物校验。
 *
 * 面板要在**微信 PC 客户端的嵌入式 WebView** 里打开，那个环境有两个硬约束：
 * 可能没有外网（加载不到 CDN）、`file://` 下部分 API 受限。所以面板必须是
 * 零外部资源的单文件。这条约束如果只写在文档里，迟早会有人为了省事引一个 CDN。
 *
 * 用法：node scripts/verify-panel.mjs <panel.html>
 */

import { readFileSync, statSync } from 'node:fs';

const path = process.argv[2];
if (!path) {
  process.stderr.write('用法: node scripts/verify-panel.mjs <panel.html>\n');
  process.exit(2);
}

const problems = [];
const html = readFileSync(path, 'utf8');

const report = (ok, message) => {
  if (!ok) problems.push(message);
};

report(html.length > 0, '面板为空文件');
report(html.startsWith('<!DOCTYPE html>'), '缺少 DOCTYPE');
report(html.includes('<style>'), '缺少内联样式');
report(html.includes('<script>'), '缺少内联脚本');

// 外部资源断言：任何 src=/href= 指向 http(s) 或相对路径的 JS/CSS 都要拦下来。
const externalScripts = html.match(/<script[^>]+src=/gi) ?? [];
report(externalScripts.length === 0, `引用了外部脚本 ${externalScripts.length} 处`);
const externalStyles = html.match(/<link[^>]+stylesheet[^>]*href=["']https?:/gi) ?? [];
report(externalStyles.length === 0, `引用了外部样式表 ${externalStyles.length} 处`);
const cdnRefs = html.match(/https?:\/\/[^"')\s]+\.(js|css)/gi) ?? [];
report(cdnRefs.length === 0, `出现 CDN 资源引用: ${cdnRefs.slice(0, 3).join(', ')}`);

// Logo 必须内联：客户端 WebView 里外链图片会加载失败，表现为一片空白图标。
report(html.includes('data:image/png;base64,'), 'Logo 未内联为 data URL');

// 九个视图都要在：少了任何一个，用户点进去就是「未知视图」。
for (const view of ['dashboard', 'activity', 'heatmap', 'members', 'guard', 'knowledge', 'ai', 'rules', 'health', 'about']) {
  report(html.includes(`'${view}'`), `缺少视图 ${view}`);
}

if (problems.length > 0) {
  process.stderr.write('面板校验失败：\n' + problems.map((p) => `  ✗ ${p}`).join('\n') + '\n');
  process.exit(1);
}

const kb = (statSync(path).size / 1024).toFixed(0);
process.stdout.write(`面板校验通过：${kb} KB 单文件，零外部依赖，10 个视图齐全\n`);
