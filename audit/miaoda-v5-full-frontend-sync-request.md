请继续修改当前已有项目 app-dgh89h0lz9j5。上一轮仅修复了入口，但代码快照比对证明根目录仍未完整同步 V5：根目录 src/index.css 仍是秒哒默认模板样式，约 89 行，而已上传 V5 的正式样式约 7795 行；根目录 AuthContext.tsx、routes.tsx 等也仍是旧模板版本。因此当前预览不可能与本地 V5 一致。

【唯一目标】
把当前秒哒工作区中最初上传并解压的完整 V5 前端源码目录：
/workspace/app-dgh89h0lz9j5/tasks/shiguang-deploy/拾光旅伴-H5-v5/
同步到秒哒项目根目录：
/workspace/app-dgh89h0lz9j5/
让项目根目录真实运行完整 V5，而不是只复制 pages 或只修复 App.tsx。

【执行步骤】
1. 先确认嵌套 V5 目录存在，并读取其 package.json、src/main.tsx、src/App.tsx、src/index.css；若目录不存在立即停止并报告，不要自行重写页面。
2. 将嵌套 V5 的以下前端内容完整、递归同步到项目根目录，允许覆盖根目录同名旧模板文件：
   - src/ 整个目录，包括 api、components、contexts、db、hooks、i18n、lib、pages、types
   - public/ 整个目录
   - index.html
   - package.json、pnpm-lock.yaml
   - vite.config.ts
   - tsconfig.json、tsconfig.app.json、tsconfig.node.json
   - postcss.config.*、tailwind.config.*、components.json 等现有前端构建配置
3. 必须确保根目录以下文件与嵌套 V5 对应文件内容一致：
   - src/index.css
   - src/contexts/AuthContext.tsx
   - src/pages/Prototype.tsx
   - src/pages/tourist/TouristExtra.tsx
   - src/pages/tourist/TouristScreens.tsx
   - src/pages/guide/GuideScreens.tsx
   - src/pages/photographer/PhotographerScreens.tsx
   - public 下全部人物、头像、房间图片和图标资源
4. 使用 cmp 或 sha256sum 比较上述文件，完成报告必须明确给出 MATCH/DIFF 结论，但不要输出文件正文或任何 Secret。
5. 保留当前秒哒项目自己的环境配置和目标 Supabase 连接。不得从嵌套 V5 复制 .env、.env.local、任何密钥文件、node_modules、dist、.git、audit、.qa、local-api 或桌面打包文件。
6. 不复制或覆盖 supabase/，不执行 migration，不部署 Edge Function，不修改 Storage/RLS，不修改数据库和业务数据。
7. 清除旧前端构建缓存后重新安装依赖，执行 tsc --noEmit 和 vite build，并重新激活编辑器预览服务。

【必须保留】
- 完整 V5 的 UI、字体、位置、视觉层级、绿色设计体系、图片、badge、卡片、底栏和安全区。
- 完整 V5 的 hash 路由、登录、角色判断、导游/游客/摄影师三端页面、按钮、操作、返回、跳转、持久化及业务链路。
- 当前目标 Supabase、数据库、RLS、Storage、Edge Functions 和服务端 Secrets。

【禁止】
- 不根据文字重新设计，不手工近似重写 CSS，不保留秒哒默认 SamplePage/模板设计系统。
- 不只复制 pages；必须同步完整 src 和 public。
- 不再次首次生成，不创建新项目，不发布生产。
- 不在日志或回复中显示任何百度、Supabase 或秒哒密钥。

【验收门禁】
1. 根目录 src/index.css 不再是默认模板，必须与嵌套 V5 完全 MATCH。
2. 根目录 src、public 与嵌套 V5 的指定关键文件全部 MATCH。
3. 未登录根路径显示 V5 登录页；登录后导游、游客、摄影师按原角色链路进入。
4. 390×844 与 320px 宽度均使用真实单列 H5，无横向溢出、底栏遮挡和异常留白。
5. tsc 与 vite build 成功，控制台无致命错误。

完成后只报告：同步文件范围、关键文件 MATCH/DIFF 清单、typecheck/build、编辑器预览状态、未完成项，以及确认环境密钥/数据库/业务数据/生产发布均未修改。
