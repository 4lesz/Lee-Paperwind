// 圆头线条图标：24×24 画布，描边 1.75px（设计规范 §3.5）
const svg = (body, size = 18) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`

export const icons = {
  outline: svg('<rect x="3" y="4" width="18" height="16" rx="3.5"/><path d="M9 4v16"/><path d="M5.5 8h1M5.5 11h1M5.5 14h1"/>'),
  new: svg('<path d="M12 20h-5.5A3.5 3.5 0 0 1 3 16.5v-9A3.5 3.5 0 0 1 6.5 4h11A3.5 3.5 0 0 1 21 7.5V12"/><path d="M8 9h8M8 13h4"/><path d="M18 15v6M15 18h6"/>'),
  open: svg('<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2h7.4A2.5 2.5 0 0 1 21 9.5v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5z"/>'),
  save: svg('<path d="M12 4v10"/><path d="m8 10 4 4 4-4"/><path d="M5 15v2.5A2.5 2.5 0 0 0 7.5 20h9a2.5 2.5 0 0 0 2.5-2.5V15"/>'),
  source: svg('<path d="m8.5 8-4 4 4 4M15.5 8l4 4-4 4"/>'),
  read: svg('<path d="M3 6.5C5 5.2 7.6 5 12 6.8c4.4-1.8 7-1.6 9-.3V19c-2-1.3-4.6-1.5-9 .3-4.4-1.8-7-1.6-9-.3z"/><path d="M12 6.8v12.5"/>'),
  moon: svg('<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>'),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/>'),

  bold: svg('<path d="M7 5h5.5a3.5 3.5 0 0 1 0 7H7zM7 12h6.5a3.5 3.5 0 0 1 0 7H7z" stroke-width="2.2"/>'),
  italic: svg('<path d="M18 5h-7M13 19H6M14.5 5l-5 14"/>'),
  underline: svg('<path d="M7 4.5V11a5 5 0 0 0 10 0V4.5M5.5 20h13"/>'),
  strike: svg('<path d="M16.5 7.5C16 5.6 14.3 4.5 12 4.5c-2.6 0-4.5 1.4-4.5 3.4 0 1.4.9 2.4 2.6 3.1M4.5 12h15M8 16.5c.5 1.9 2.2 3 4.5 3 2.6 0 4.5-1.4 4.5-3.4 0-.6-.2-1.2-.5-1.6"/>'),
  highlight: svg('<path d="m14.5 5.5 4 4L10 18H6v-4z"/><path d="M4 21h16" stroke-width="2.4" stroke="var(--mark-strong, currentColor)"/>'),
  code: svg('<path d="m9 8-4 4 4 4M15 8l4 4-4 4"/>'),
  codeBlock: svg('<rect x="3" y="4" width="18" height="16" rx="3.5"/><path d="m9.5 10-2 2 2 2M14.5 10l2 2-2 2"/>'),
  quote: svg('<path d="M5 6v12"/><path d="M10 8h9M10 12h9M10 16h6"/>'),
  bulletList: svg('<path d="M10 6.5h10M10 12h10M10 17.5h10"/><circle cx="5" cy="6.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="5" cy="17.5" r="1.2" fill="currentColor" stroke="none"/>'),
  orderedList: svg('<path d="M11 6.5h9M11 12h9M11 17.5h9"/><path d="M4.5 5 6 4v5M4 14.5c0-.8.7-1.3 1.4-1.3s1.4.5 1.4 1.2c0 1.2-2.8 1.8-2.8 3.1h2.9" stroke-width="1.5"/>'),
  taskList: svg('<circle cx="6" cy="7" r="2.5"/><circle cx="6" cy="17" r="2.5"/><path d="M11 7h9M11 17h9"/><path d="m4.9 17 .8.8 1.5-1.6" stroke-width="1.5"/>'),
  link: svg('<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>'),
  image: svg('<rect x="3" y="4" width="18" height="16" rx="3.5"/><circle cx="9" cy="10" r="1.8"/><path d="m21 16-4.5-4.5L7 20"/>'),
  table: svg('<rect x="3" y="4" width="18" height="16" rx="3.5"/><path d="M3 10h18M3 15h18M10 10v10"/>'),
  hr: svg('<path d="M4 12h16"/><path d="M4 7h16M4 17h16" opacity=".35"/>'),
  chevron: svg('<path d="m7 10 5 5 5-5"/>', 14),
  check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>', 16),
  pencil: svg('<path d="M14.5 5.5l4 4L9 19H5v-4z"/><path d="m12.5 7.5 4 4"/>', 14),
  folder: svg('<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2h7.4A2.5 2.5 0 0 1 21 9.5v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5z"/>', 14),
  info: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><circle cx="12" cy="8" r=".6" fill="currentColor"/>', 16),
  file: svg('<path d="M14 3.5H8A2.5 2.5 0 0 0 5.5 6v12A2.5 2.5 0 0 0 8 20.5h8a2.5 2.5 0 0 0 2.5-2.5V8z"/><path d="M14 3.5V8h4.5"/>', 28),
}
