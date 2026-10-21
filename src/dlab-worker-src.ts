/* 下载加速实验室的两个脚本源码，均以字符串形式由对应路由下发。
 * 注意：这两个字符串内禁止出现反引号与 ${ 序列。 */

/* OPFS 写入小工（/dlab-worker.js）：同步访问句柄只能在 Worker 里用，按偏移写入。 */
export const DLAB_WORKER_SRC = `
let sync = null, handle = null;
self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === "open") {
      const root = await navigator.storage.getDirectory();
      handle = await root.getFileHandle(m.name, { create: true });
      sync = await handle.createSyncAccessHandle();
      sync.truncate(0);
      self.postMessage({ type: "opened" });
    } else if (m.type === "openkeep") {
      const root = await navigator.storage.getDirectory();
      handle = await root.getFileHandle(m.name, { create: true });
      sync = await handle.createSyncAccessHandle();
      self.postMessage({ type: "opened" });
    } else if (m.type === "write") {
      const n = sync.write(new Uint8Array(m.buf), { at: m.offset });
      self.postMessage({ type: "written", id: m.id, len: n });
    } else if (m.type === "finish") {
      sync.flush(); sync.close(); sync = null;
      self.postMessage({ type: "done" });
    } else if (m.type === "abort") {
      try { if (sync) sync.close(); } catch (_) {}
      sync = null;
      const root2 = await navigator.storage.getDirectory();
      await root2.removeEntry(m.name).catch(() => {});
      self.postMessage({ type: "aborted" });
    }
  } catch (err) {
    self.postMessage({ type: "error", id: m.id, msg: String((err && err.message) || err) });
  }
};
`;

/* Service Worker（/dlab/sw.js，作用域仅 /dlab/）：快速检测用。
 * 拦截 /dlab/sw-test，本地生成 50MB 流式响应触发浏览器下载，
 * 验证该浏览器的 SW 能否返回流式下载响应。不经网络、不碰其他路径。 */
export const DLAB_SW_SRC = `
self.addEventListener("install", (e) => { self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (u.pathname !== "/dlab/sw-test") return;
  const total = 50 * 1024 * 1024;
  const piece = new Uint8Array(1024 * 1024);
  for (let i = 0; i < piece.length; i++) piece[i] = i % 251;
  let sent = 0;
  const stream = new ReadableStream({
    pull(c) {
      if (sent >= total) { c.close(); return; }
      const n = Math.min(piece.length, total - sent);
      sent += n;
      c.enqueue(n === piece.length ? piece : piece.slice(0, n));
    }
  });
  e.respondWith(new Response(stream, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": "attachment; filename=\\"dlab-sw-50mb.bin\\"",
      "Content-Length": String(total)
    }
  }));
});
`;
