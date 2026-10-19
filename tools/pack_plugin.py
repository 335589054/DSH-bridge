#!/usr/bin/env python
"""把可分发的最小集合打成一个 zip。

产物结构（解开后必须保持同级，install.mjs 用 ../bridge 找网关）：

    workbuddy-dsh-plugin/
    ├── README.md            <- 取自 dsh-plugin-workbuddy/GUIDE.md（使用指南）
    ├── install.cmd          <- 双击：装插件 + 装证书 + 抓一次会话
    ├── install-ca.cmd       <- 双击：只装证书
    ├── link.cmd             <- 双击：复制桥接链接
    ├── stop-capture.cmd     <- 双击：停抓包 + 还原代理（代理卡住时的救命键）
    ├── start-bridge.cmd     <- 双击：只起本地网关（8790），不开网页端
    ├── dsh-web.cmd          <- 双击：起 DSH 网页端（3080）；已在跑就直接打开
    ├── dsh-plugin-workbuddy/
    ├── bridge/              <- 含 bridge/certs/（随包 CA）
    └── capture/

    python tools/pack_plugin.py            # -> dist/workbuddy-dsh-plugin-<version>.zip
"""

import json
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")

# 源目录 -> 归档内前缀
INCLUDE = [
    ("packages/dsh-plugin-workbuddy", "dsh-plugin-workbuddy"),
    ("packages/bridge", "bridge"),
    ("packages/capture", "capture"),
]

# 直接放在 zip 根目录的「双击就能用」脚本
ROOT_FILES = [
    "tools/package-root/install.cmd",
    "tools/package-root/install-ca.cmd",
    "tools/package-root/link.cmd",
    "tools/package-root/stop-capture.cmd",
    "tools/package-root/start-bridge.cmd",
    "tools/package-root/dsh-web.cmd",
]

SKIP_DIRS = {"node_modules", "__pycache__", ".git", ".cache", "dist", "tests", ".tools", ".ca"}
SKIP_NAMES = {
    ".bridge-token",
    ".capture-key",
    ".session.json",
    ".proxy-backup.json",
    ".bridge-config.json",  # 含 API 密钥哈希 + 局域网开关状态，属于本机私有
    ".DS_Store",
    "mitmproxy-dhparam.pem",  # mitmdump 自己会生成，没必要进包
}
SKIP_SUFFIX = (".log", ".pyc", ".tmp")
SKIP_MARK = ".workbuddy-backup-"


def version():
    pkg = os.path.join(ROOT, "packages/dsh-plugin-workbuddy/package.json")
    with open(pkg, encoding="utf-8") as fh:
        return json.load(fh)["version"]


def iter_files(base, prefix):
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in sorted(filenames):
            if name in SKIP_NAMES or name.endswith(SKIP_SUFFIX) or SKIP_MARK in name:
                continue
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, base).replace(os.sep, "/")
            yield full, f"{prefix}/{rel}"


def main():
    os.makedirs(DIST, exist_ok=True)
    ver = version()
    out = os.path.join(DIST, f"workbuddy-dsh-plugin-{ver}.zip")
    top = "workbuddy-dsh-plugin"

    # 使用指南作为 zip 根的 README（路径约定在 zip 里不成立，所以另取一份）
    guide = os.path.join(ROOT, "packages/dsh-plugin-workbuddy/GUIDE.md")
    if not os.path.exists(guide):
        guide = os.path.join(ROOT, "packages/dsh-plugin-workbuddy/INSTALL.md")
    if not os.path.exists(guide):
        guide = os.path.join(ROOT, "README.md")

    count = 0
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        if os.path.exists(guide):
            zf.write(guide, f"{top}/README.md")
            count += 1
        for rel in ROOT_FILES:
            full = os.path.join(ROOT, rel)
            if not os.path.exists(full):
                print(f"跳过不存在的文件: {rel}")
                continue
            zf.write(full, f"{top}/{os.path.basename(rel)}")
            count += 1
        for rel_base, prefix in INCLUDE:
            base = os.path.join(ROOT, rel_base)
            if not os.path.isdir(base):
                print(f"跳过不存在的目录: {rel_base}")
                continue
            for full, arc in iter_files(base, f"{top}/{prefix}"):
                zf.write(full, arc)
                count += 1

    size = os.path.getsize(out) / 1024
    print(f"已生成 {out}")
    print(f"  {count} 个文件，{size:.1f} KB")


if __name__ == "__main__":
    sys.exit(main())
