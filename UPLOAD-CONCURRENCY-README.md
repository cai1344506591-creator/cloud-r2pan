# 上传 3 路并发补丁（✅ 已于 2026-10-21 凌晨 0:15 夜间包应用上线）

> 状态更新（2026-10-21 00:xx）：CAI 20:45 改主意——"按你的想法在我睡觉的时候优化"，
> 本补丁已在夜间包 r2pan-fix-range-count-traffic 中应用并部署（5 个 hunk 全部干净应用，
> 另按任务书补了单片失败 2 次重试）。**不要重复应用。**
> 浏览器端真实上传测速留给 CAI 早上第一次传大文件时确认。

CAI 2026-10-20 晚 20:22 批准：「上传改并发」——90MB 分片从逐片排队改为 3 片并发。
补丁文件：`upload-concurrency-3way.patch`（对 `public/admin.html` 的 unified diff，已在本机对脚本抽取做 `node --check` 语法校验通过）。

## 为什么现在不动
- 0:15 的夜间包（r2pan-fix-range-count-traffic）正在等开工，它也会改 `admin.html`（回收站前端）。
- 按 CAI 指示，今晚无人值守只做那 5 项；并发改动排明天。
- GitHub 推送审批卡没有「始终允许」选项（CAI 亲口确认，见 AGENTS.md），夜间不推。

## 明天操作顺序（他醒着时，一次会话全办）
1. 等 0:15 夜间包跑完并验证通过（或次日上午确认 cron 成功）。
2. 对**夜间包之后**的 `public/admin.html` 重新核对补丁锚点：
   - 锚点 A：`xhr.open('POST', '/api/admin/upload/part');` 及其上方的 `uploadPartXHR` 定义（夜间包不动这段，锚点应仍有效）。
   - 锚点 C：两个取消处理器里的 `if(state.xhr){ try { state.xhr.abort(); } catch {} }`。
   - 锚点 D：`// 2. 逐片上传（已传的跳过，每片传好就落盘记录）` 及其后的 for 循环。
   若任一锚点对不上，**停手**，手动移植逻辑，不要硬套补丁。
3. 应用：`patch -p1 < upload-concurrency-3way.patch`（在 `~/workspace/cloud-r2pan-src` 下），或按补丁手工改。
4. 校验：按夜间包的惯例抽取 `admin.html` 的 `<script>` 做 `node --check`。
5. 构建部署：按 0:15 任务书里的部署配方（esbuild + Workers Scripts API PUT 到 2 号账号）。
6. 实测验证（CAI 自己传一个 >90MB 文件，最好是他今晚说的那种慢场景）：
   - 上传时服务端应同时看到 3 个 part 请求在飞（查 Worker 日志或 D1 上传会话的 part 到达时间）。
   - 速度对比：并发前/后同文件上传耗时。诚实口径：**单连接瓶颈**时有效（他的 6Mbps 瓶颈若是机场共享出口按连接限速，3 路 ≈ 3×）；若是出口整体拥塞，提升有限。
   - 取消按钮：点取消后 3 路 XHR 全被 abort（网络面板确认无残留请求），走「已取消」语义。
   - 续传：中途关页面/断网，已传分片落盘记录仍在，刷新后提示续传可用。
   - 会话过期（NoSuchUpload/10024）：走整单重传 `restartFresh()`，不卡死。
7. GitHub 补推：今晚 0:15 的改动 + 这个并发改动，打包一次推，**审批卡由 CAI 本人点**（他已明确知道要坐电脑前）。

## 设计要点（补丁已实现）
- 只改前端 `uploadFileChunked`，服务端 `/api/admin/upload/part`、`/complete`、`/abort` **零改动**；R2 multipart 本就支持并发传分片。
- `complete` 要求的 parts 按 partNumber 排序：每片成功后仍 `parts.sort()`，合并语义不变。
- 每片成功即 `saveRec` 落盘：中断/断网可续传，语义与原来一致。
- 取消：两个取消处理器都改为 abort 全部在飞 XHR（`state.xhrList`）；`state.xhr` 保留给 `uploadFileSingle`（小文件直传）兼容。
- 任一片失败 → 其余 abort → 整体走「已中断（可续传）」，已传分片不丢。
- 并发数 3：90MB×3 = 270MB 在飞，浏览器内存可接受；后续想调只改 `CONCURRENCY` 常量。
