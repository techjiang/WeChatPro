# 品牌资源

WeChatPro 的 Logo 与图标，全部由仓库根目录那份**无背景原图**切出，
源文件：`brand/logo-source.png`（765×867 RGBA，六边形徽标 + 下方包名文字，透明底）。

## 两种裁切

原图不是圆形，而是「六边形徽标 + `WeChatPro` 文字」的竖版组合。所以派生出两套：

- **mark**（`logo*.png` / `icons/*`）—— 只取六边形徽标。16~64px 的任务栏、插件图标
  用它；那个尺寸下包名文字只会糊成一团噪点，且六边形能撑满画布。
- **lockup**（`logo-lockup*.png`）—— 徽标与包名文字完整保留。README、商店页、
  社区头像这类能看到项目名的地方用它。

两套共用同一个正方形边长口径，所以 mark 就是 lockup 在垂直方向上的放大视图，
并排放不会一大一小。

## 文件

| 文件 | 尺寸 | 用途 |
|---|---|---|
| `logo-source.png` | 765×867 | **唯一需要人工维护的源图** |
| `logo.png` | 765 | mark 原始裁切版（正方形透明底） |
| `logo-512/256/128/64/32/16.png` | 多尺寸 | mark 各用途；`logo-256.png` 是面板内联用的那份 |
| `logo-lockup.png` | 765 | lockup 原始裁切版 |
| `logo-lockup-512.png` / `logo-lockup-256.png` | 512 / 256 | README、商店页 |
| `avatar-512.png` | 512 | 圆形头像（GitHub / 社区） |
| `icons/icon-16…256.png` | 多尺寸 | 客户端插件图标（mark） |
| `icons/icon-256.ico` | 256 | Windows 快捷方式 |
| `icons/panel-24.png` / `panel-48.png` | 小尺寸 | 面板顶栏（1x / 2x） |

## 使用方式

**面板内联**：`brandIcon()` 读 `logo-256.png` 转成 base64 data URL 内联进 HTML。
之所以内联而不是引用相对路径，是因为客户端插件的面板常跑在 `file://` 或受限 CSP 环境，
外链图片会加载失败（表现为一片空白图标）。资源读不到时返回 `null`，
面板自动降级为纯文字标题——**品牌资源缺失不该让面板打不开**。

```ts
import { brandIcon, BRAND } from 'wechatpro';
const icon = brandIcon(); // data URL 或 null
```

**CLI**：

```bash
node dist/cli.js brand          # 品牌信息 + 资源状态
node dist/cli.js brand --json   # 脚本消费
```

## 重新生成

图标由原图派生，不手工维护多个尺寸。重新生成（需要 `sharp`，仅开发期依赖）：

```bash
npm i -D sharp
npx tsx scripts/brand-assets.ts brand/logo-source.png
```

脚本逻辑：

1. 用 `alpha > 16` 逐像素求内容边界框。阈值不能取 `alpha > 0` —— 原图带半透明
   投影，那样会把投影外沿算成内容，裁出来的图四周多一圈看不见的留白，小尺寸下
   表现为图标明显偏小。
2. 找「徽标」与「包名文字」之间那条完全透明的横带，据此把徽标单独框出来。
3. 两套各按内容中心裁成正方形，越界贴边（宁可偏心，也不能裁到画布外）。
4. 生成各尺寸 PNG 与 ICO。

**唯一需要人工维护的是源图**，其余全部可再生。

## 配色

| 名称 | 值 | 用途 |
|---|---|---|
| deep | `#0b1a33` | 背景主色 |
| navy | `#123a63` | 面板背景 |
| cyan | `#2ec5c5` | 强调色、图表填充 |
| ice | `#e8f4fb` | 正文 |
| silver | `#c8d2dc` | 次级文字 |

代码里用 `BRAND_COLORS` 引用，不要在面板 CSS 里写死色值。

## 作者信息

以 `BRAND`（`src/client/brand.ts`）为唯一来源，面板「关于」页、通知标题、
CLI 横幅都从这里读，避免多处维护后信息不一致。

- 作者：科技酱
- 网站：<https://docs.asoe.cn>
- GitHub：<https://github.com/techjiang/>
- 哔哩哔哩：<https://space.bilibili.com/1768832152>
- 玲珑论坛：<https://forums.asoe.cn/>
- QQ 群：291974598 ｜ 474819022
