// 生成「连续写作」测试样本：node scripts/make-samples.cjs
const fs = require('node:fs')
const path = require('node:path')

const dir = path.join(__dirname, '..', 'samples', '连载')
fs.rmSync(dir, { recursive: true, force: true })
for (const d of ['子文件夹', '第一卷', '素材', '.草稿', 'node_modules/包']) fs.mkdirSync(path.join(dir, d), { recursive: true })

const paras = (from, to, tag) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${tag}第 ${from + i} 段。连续写作需要在篇目之间来回跳转，这一段用来把文章撑长，方便测试阅读位置的记忆。`).join('\n\n')

const files = {
  '01-开篇.md': `# 开篇

这是连载的第一篇。下一篇见[第二章](02-第二章.md)，直接看[第二章的小结](02-第二章.md#小结)。

编码过的链接：[第十章](10-%E7%AC%AC%E5%8D%81%E7%AB%A0.md)；本文内的标题：[跳到本篇小结](#本篇小结)。

其他链接：[不存在的篇](99-不存在.md)、[参考资料](资料.pdf)、[危险脚本](run.bat)、[附录](附录.md)。

${paras(1, 30, '开篇 · ')}

## 本篇小结

${paras(31, 60, '开篇 · ')}
`,
  '02-第二章.md': `# 第二章

回到[开篇](01-开篇.md)。

${paras(1, 25, '第二章 · ')}

## 小结

第二章的小结在这里。

${paras(26, 40, '第二章 · ')}
`,
  '10-第十章.md': `# 第十章\n\n文件名以 10 开头，应当排在 02 之后。\n`,
  '附录.md': `# 附录\n\n没有编号的文章排在最后。\n`,
  '笔记.txt': '文本文件不应出现在篇目中。\n',
  '子文件夹/内部.md': '# 内部\n\n子文件夹中的文章，在篇目树的「子文件夹」下面。\n',
  // 子文件夹（v1.4）：第一卷有两篇，上一篇 / 下一篇只在卷内翻
  '第一卷/01-起源.md': '# 起源\n\n第一卷的第一篇。\n',
  '第一卷/02-相遇.md': '# 相遇\n\n第一卷的第二篇。回到[开篇](../01-开篇.md)。\n',
  // 不应出现在篇目中：没有 Markdown 的文件夹、隐藏文件夹、工具文件夹
  '素材/封面.txt': '只有文本文件的文件夹不显示。\n',
  '.草稿/草稿.md': '# 草稿\n\n隐藏文件夹里的文章不显示。\n',
  'node_modules/包/README.md': '# 包\n\n工具文件夹里的文章不显示。\n',
  // 用于验证：非 Markdown 文件只在资源管理器中显示，绝不运行
  'run.bat': '@echo off\r\necho executed > "%~dp0executed.txt"\r\n',
  '资料.pdf': '%PDF-1.4\n% 测试用的占位文件\n',
}
for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content, 'utf8')
console.log('已生成', dir)

// 翻页索引（v1.5，设计规范 §4.13b）：文档开头的属性区里写 prev / next
const ixDir = path.join(__dirname, '..', 'samples', '索引')
fs.rmSync(ixDir, { recursive: true, force: true })
const ixFiles = {
  // 下一篇跨进子文件夹；属性区里还有别的内容（title、tags），必须逐字保留
  '01-甲.md': '---\ntitle: 甲篇\ntags: [示例, 翻页]\nnext: 子/03-丙.md\n---\n\n# 甲\n\n下一篇指定为子文件夹里的「丙」，不是按文件名排在后面的「乙」。\n',
  // 没有属性区：按文件名顺序
  '02-乙.md': '# 乙\n\n没有属性区，按文件名顺序翻页。\n',
  // 自定义卡片文字（分行缩进写法）；不显示下一篇
  '子/03-丙.md': '---\nprev:\n  text: 回到开头\n  link: ../01-甲.md\nnext: false\n---\n\n# 丙\n\n上一篇卡片显示「回到开头」，没有下一篇。\n',
  // 目标不存在；行内写法、带 #标题
  '子/04-丁.md': '---\nprev: { text: 丙篇, link: "03-丙.md#丙" }\nnext: 不存在.md\n---\n\n# 丁\n\n下一篇指向一个不存在的文件。\n',
  // Windows 换行（CRLF）：改写后仍保持 CRLF
  '05-戊.md': '---\r\nauthor: 某人\r\n---\r\n\r\n# 戊\r\n\r\n这一篇用 Windows 换行。\r\n',
  // 不是属性区：分隔线 + 段落 + 分隔线
  '06-己.md': '---\n\n不是属性区，只是分隔线中间的一段文字。\n\n---\n\n# 己\n',
}
for (const [name, content] of Object.entries(ixFiles)) {
  fs.mkdirSync(path.dirname(path.join(ixDir, name)), { recursive: true })
  fs.writeFileSync(path.join(ixDir, name), content, 'utf8')
}
console.log('已生成', ixDir)
