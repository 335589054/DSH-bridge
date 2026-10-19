import io
import os

PATH = r"E:\workbuddytoharness\packages\dsh-plugin-workbuddy\client.js"
NEW = PATH + ".new"

text = io.open(PATH, encoding="utf-8").read()
OLD = "            '抓到后点「停止并还原代理」，DSH 就不再依赖代理常开。'),"
NEWTXT = "            '抓到后点「停止并还原代理」，DSH 就不再依赖代理常开。')),"
assert OLD in text, "anchor not found"
text = text.replace(OLD, NEWTXT, 1)
io.open(NEW, "w", encoding="utf-8", newline="").write(text)

try:
    os.replace(NEW, PATH)
    print("client.js 已修复")
except PermissionError:
    os.remove(PATH)
    os.replace(NEW, PATH)
    print("client.js 已修复（先删后换）")
