// 设置（设计规范 §6.6c）：标题栏齿轮按钮打开弹窗，按分组往下排。
// 这一版只有「动效」一组；以后新增设置项在同一个弹窗里追加分组。
import { icons } from './icons.js'

export const JUMP_EFFECTS = [
  { id: 'classic', name: '经典', desc: '翻页时旧页碎成粒子，链接跳转时旧页随风落成新页' },
  { id: 'curl', name: '卷纸翻书', desc: '旧页像一张纸从一侧卷起翻过' },
  { id: 'ink', name: '墨迹晕散', desc: '旧页像墨滴落在纸上一样化开、散尽' },
  { id: 'wind', name: '风吹纸页', desc: '旧页被风吹成一条条，飘离纸面' },
  { id: 'fade', name: '轻盈淡入', desc: '新页轻轻浮现，最安静' },
]

const KEY = 'jumpEffect'
const IDS = new Set(JUMP_EFFECTS.map((e) => e.id))

export function getJumpEffect() {
  try {
    const v = localStorage.getItem(KEY)
    return IDS.has(v) ? v : 'classic'
  } catch {
    return 'classic'
  }
}

export function setJumpEffect(id) {
  if (!IDS.has(id)) return
  try {
    localStorage.setItem(KEY, id)
  } catch {}
}

export function createSettings({ onChange } = {}) {
  let mask = null

  function close() {
    if (!mask) return
    const el = mask
    mask = null
    document.body.classList.remove('modal-open')
    el.classList.add('leaving')
    setTimeout(() => el.remove(), 150)
  }

  function open() {
    if (mask) return
    mask = document.createElement('div')
    mask.className = 'modal-mask'
    mask.innerHTML = `
      <div class="modal settings-modal" role="dialog" aria-label="设置">
        <div class="modal-title">设置</div>
        <div class="settings-group">
          <div class="settings-group-title">动效</div>
          <div class="settings-group-hint">翻页和文中链接跳转时播放</div>
          <div class="settings-options">
            ${JUMP_EFFECTS.map(
              (e) => `
              <button type="button" class="setting-row" data-effect="${e.id}" aria-pressed="false">
                <span class="setting-main">
                  <span class="setting-name">${e.name}</span>
                  <span class="setting-desc">${e.desc}</span>
                </span>
                <span class="setting-check">${icons.check}</span>
              </button>`
            ).join('')}
          </div>
        </div>
        <div class="settings-note">系统开启「减少动态效果」时，统一只做淡入。</div>
        <div class="modal-actions">
          <span class="spacer"></span>
          <button type="button" class="btn primary" data-act="done">完成</button>
        </div>
      </div>`

    const rows = [...mask.querySelectorAll('.setting-row')]
    const mark = (id) => {
      rows.forEach((r) => {
        const on = r.dataset.effect === id
        r.classList.toggle('on', on)
        r.setAttribute('aria-pressed', on ? 'true' : 'false')
      })
    }
    mark(getJumpEffect())
    rows.forEach((r) => {
      r.addEventListener('click', () => {
        const id = r.dataset.effect
        setJumpEffect(id)
        mark(id)
        onChange?.(id)
      })
    })
    mask.querySelector('[data-act=done]').addEventListener('click', close)
    mask.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
      }
    })
    mask.addEventListener('mousedown', (e) => e.target === mask && close())
    document.body.appendChild(mask)
    document.body.classList.add('modal-open')
    mask.querySelector('.btn.primary').focus()
  }

  return { open, close, isOpen: () => !!mask }
}