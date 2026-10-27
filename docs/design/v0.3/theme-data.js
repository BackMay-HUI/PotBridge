export const themes = {
  luna: { name: '月下礼仪', subtitle: 'LUNA / 樱小路露娜', description: '银白发与红瞳，化作一页安静的月光。樱小路露娜主题。', colors: ['#f6f3ed', '#28262e', '#803750'] },
  porcelain: { name: '瓷白', subtitle: 'PORCELAIN / 简约通透', description: '细腻的白，轻盈的层次。借鉴 Apple 界面的秩序与留白。', colors: ['#f5f5f7', '#202127', '#155edb'] },
  reload: { name: '深蓝时刻', subtitle: 'RELOAD / P3R 灵感', description: '电光蓝、切角与大胆排版。将 P3R 的动势留在每次点击里。', colors: ['#071b46', '#f6f9ff', '#63e7ff'] },
  mica: { name: '云母', subtitle: 'MICA / Fluent 灵感', description: '雾面的柔光，熟悉的 Windows 秩序。安静融入你的桌面。', colors: ['#edf0f6', '#242b3a', '#365cbc'] },
  forest: { name: '墨绿', subtitle: 'FOREST / 夜间专注', description: '深墨底色、低饱和绿与温润数字。给深夜观看的一点安静。', colors: ['#141e1b', '#e8eee8', '#b8d6ac'] },
};
export function readTheme() {
  try { const saved = localStorage.getItem('potbridge-design-theme'); return themes[saved] ? saved : 'luna'; } catch { return 'luna'; }
}
export function saveTheme(theme) {
  try { localStorage.setItem('potbridge-design-theme', theme); } catch { /* Preview remains usable if storage is unavailable. */ }
}
