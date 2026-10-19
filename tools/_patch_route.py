import io
import os

PATH = r"E:\workbuddytoharness\packages\dsh-plugin-workbuddy\lib\route.mjs"
NEW = PATH + ".new"

text = io.open(PATH, encoding="utf-8").read()

ADD = '''
/**
 * 本包自己的 cordis.patch.yml。
 *
 * 比用户补丁多一行 insert：给 UI 半体一个可寻址的行（Client 模块按 package 名加载）。
 * 路由部分与用户补丁完全一致。
 */
export function renderBundlePatch({ models = loadModels(), baseUrl = DEFAULT_BASE_URL } = {}) {
  const header = [
    '# 本文件由 sync-models.mjs 生成，请勿手改。',
    '# 第一行给 UI 半体挂一个可寻址的行；后面是 llm-pi-ai 的 workbuddy 路由。',
    '- insert:',
    '    - id: workbuddy-ui',
    `      name: 'dsh-plugin-workbuddy'`,
    '',
  ].join('\\n')
  return header + renderPatchBlock({ models, baseUrl })
}
'''

text = text.rstrip() + "\n" + ADD
io.open(NEW, "w", encoding="utf-8", newline="").write(text)
try:
    os.replace(NEW, PATH)
    print("route.mjs 已更新")
except PermissionError:
    os.remove(PATH)
    os.replace(NEW, PATH)
    print("route.mjs 已更新（先删后换）")
