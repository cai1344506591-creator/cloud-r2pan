#!/usr/bin/env python3
"""cloud-r2pan Worker 部署脚本（豆包专用，API 直传）。
用法：先 esbuild 打包到 /tmp/worker-bundle.js，再 python3 deploy_doubao.py
凭证走 custom.cloudflare-2 surrogate，不落盘明文。
注意：worker.js 分片的 Content-Type 必须是 application/javascript+module，
写成 application/javascript 会被 CF 校验器以脚本模式解析并报 Unexpected token 'export'。
"""
import json, urllib.request, urllib.error, sys
sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request

ACCOUNT = "0c13c4d12fea0a56ea9a042046f6d2ee"
SCRIPT = "cloud-r2pan"
BOUNDARY = "----doubao123"

# admin 密钥绑定必须随部署清单一起提交：脚本 PUT 会以清单为准重建绑定，
# 漏掉 secret_text 会把 env.admin 冲掉（= 登录密码 + 会话签名 + 密文解密钥匙，冲掉即后台锁死）。
# 值从 600 权限备份文件读入（2026-10-21 已对线上登录验明字节一致），只进请求体、绝不打印。
# 路径按候选找：备份目录会按"只留最新 3 版"轮换进 retired/，写死日期 2026-10-22 就栽过一次。
import glob as _glob
_cands = sorted(_glob.glob("/home/hatch/workspace/backups/cloud-r2pan/2026-*/admin-pwd.txt"), reverse=True) \
    + sorted(_glob.glob("/home/hatch/workspace/backups/cloud-r2pan/retired/2026-*/admin-pwd.txt"), reverse=True)
if not _cands:
    sys.exit("admin-pwd.txt not found in backups")
with open(_cands[0], "rb") as _f:
    ADMIN_SECRET = _f.read().rstrip(b"\r\n").decode("utf-8")

with open("/tmp/worker-bundle.js", "rb") as f:
    bundle = f.read()

metadata = {
    "main_module": "worker.js",
    "compatibility_date": "2025-01-01",
    "bindings": [
        {"type": "d1", "name": "db", "id": "1c4efe71-90c0-4331-8981-d0aa08d05ae2"},
        {"type": "r2_bucket", "name": "r2", "bucket_name": "cloud-r2pan"},
        {"type": "r2_bucket", "name": "r2_webdav", "bucket_name": "webdav"},
        {"type": "r2_bucket", "name": "r2_broshare", "bucket_name": "bro-share"},
        {"type": "r2_bucket", "name": "r2_faka", "bucket_name": "faka-assets"},
        {"type": "secret_text", "name": "admin", "text": ADMIN_SECRET},
    ],
}

body = b""
body += f"--{BOUNDARY}\r\n".encode()
body += b'Content-Disposition: form-data; name="metadata"\r\n'
body += b"Content-Type: application/json\r\n\r\n"
body += json.dumps(metadata).encode() + b"\r\n"
body += f"--{BOUNDARY}\r\n".encode()
body += b'Content-Disposition: form-data; name="worker.js"; filename="worker.js"\r\n'
body += b"Content-Type: application/javascript+module\r\n\r\n"
body += bundle + b"\r\n"
body += f"--{BOUNDARY}--\r\n".encode()

url = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/workers/scripts/{SCRIPT}"
req = urllib.request.Request(url, data=body, method="PUT")
req.add_header("Content-Type", f"multipart/form-data; boundary={BOUNDARY}")
req.add_header("User-Agent", "doubao-deploy/1.0")
add_surrogate_to_request(req, "custom.cloudflare-2", allowed_hosts=["api.cloudflare.com"])

try:
    with urllib.request.urlopen(req, timeout=120) as r:
        j = json.loads(r.read())
        print("HTTP", r.status, "success:", j.get("success"))
        if not j.get("success"):
            print(json.dumps(j.get("errors"), ensure_ascii=False))
except urllib.error.HTTPError as e:
    print("HTTPError", e.code)
    print(e.read().decode()[:800])
