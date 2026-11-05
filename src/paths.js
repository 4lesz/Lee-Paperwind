// 文档内地址的解析与安全检查（图片、链接、HTML 片段共用）

let docDir = null
export function setDocDir(dir) {
  docDir = dir
}

// 图片：显示时把相对路径/本地路径转换成可加载的地址，保存时保持原样
export function resolveImageSrc(src) {
  if (!src) return src
  if (/^(https?:|data:image\/|blob:|localfile:)/i.test(src)) return src
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) && !/^[a-zA-Z]:[\\/]/.test(src) && !/^file:/i.test(src)) return '' // 其他协议一律不加载
  let p = src
  try {
    p = decodeURI(src)
  } catch {}
  p = p.replace(/^file:\/\/\/?/i, '')
  const isAbs = /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\')
  if (!isAbs) {
    if (!docDir) return src
    p = docDir.replace(/[\\/]+$/, '') + '\\' + p.replace(/^\.[\\/]/, '')
  }
  return 'localfile://file?path=' + encodeURIComponent(p.replace(/\//g, '\\'))
}

// 链接地址是否安全：相对路径、#标题、Windows 路径，以及 http(s) / mailto 等常见协议
// （编辑器自带的检查会把含 “/” 的相对路径误判为不安全，见 验收记录 AC-G02）
const SAFE_SCHEMES = /^(https?|mailto|ftp|ftps|tel|file):/i
export function isSafeHref(url) {
  const s = String(url ?? '').replace(/[\u0000- \u007f-\u009f]/g, '')
  if (!s) return true
  if (/^[a-zA-Z]:[\\/]/.test(s)) return true
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s)
  return !scheme || SAFE_SCHEMES.test(s)
}
