// 内联 SVG 图标集: 统一 24 viewBox / 1.8 描边 / 圆角端点 (轻系列家族语言)
const wrap = (inner) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`

export const ICONS = {
  // 阅读: 打开的书
  read: wrap(
    '<path d="M12 6.5C10.4 4.9 8 4.3 5.5 4.3c-1 0-2 .1-2.9.4v13.6c.9-.3 1.9-.4 2.9-.4 2.5 0 4.9.6 6.5 2.2 1.6-1.6 4-2.2 6.5-2.2 1 0 2 .1 2.9.4V4.7c-.9-.3-1.9-.4-2.9-.4-2.5 0-4.9.6-6.5 2.2z"/><line x1="12" y1="6.5" x2="12" y2="20.1"/>'
  ),
  // 水印: 画框角落的水滴
  watermark: wrap(
    '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="M15.9 13.8a2.9 2.9 0 1 1-5.8 0c0-2 2.9-4.6 2.9-4.6s2.9 2.6 2.9 4.6z"/>'
  ),
  // 页面管理: 网格
  pages: wrap(
    '<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/>'
  ),
  // 合并: 两路汇入
  merge: wrap(
    '<path d="M4 6.5h3.6l4.4 5.5h8"/><path d="M4 17.5h3.6L12 12"/><polyline points="16.8 8.8 20 12 16.8 15.2"/>'
  ),
  // 转图片: 山与太阳
  image: wrap(
    '<rect x="3" y="4.5" width="18" height="15" rx="3"/><circle cx="9" cy="10" r="1.8"/><path d="M4.5 17.5l4.5-4 3.5 3 3-2.5 4 3.5"/>'
  ),
  // 压缩: 向内箭头
  compress: wrap(
    '<polyline points="4.5 9.5 9.5 9.5 9.5 4.5"/><polyline points="19.5 14.5 14.5 14.5 14.5 19.5"/><line x1="9.5" y1="9.5" x2="4" y2="4"/><line x1="14.5" y1="14.5" x2="20" y2="20"/>'
  ),
  // 加密: 挂锁
  lock: wrap(
    '<rect x="5" y="10.5" width="14" height="9.5" rx="2.4"/><path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7"/><circle cx="12" cy="15" r="1.4" fill="currentColor" stroke="none"/>'
  ),
  // 解密: 开锁 (锁梁弹开)
  unlock: wrap(
    '<rect x="5" y="10.5" width="14" height="9.5" rx="2.4"/><path d="M8 10.5V7.8a4 4 0 0 1 7.7-1.5"/><circle cx="12" cy="15" r="1.4" fill="currentColor" stroke="none"/>'
  ),
  plus: wrap('<line x1="12" y1="5.5" x2="12" y2="18.5"/><line x1="5.5" y1="12" x2="18.5" y2="12"/>'),
  minus: wrap('<line x1="5.5" y1="12" x2="18.5" y2="12"/>'),
  close: wrap('<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>'),
  back: wrap('<path d="M9.5 6.5L4 12l5.5 5.5"/><path d="M4.5 12H14a5 5 0 0 1 5 5v.5"/>'),
  forward: wrap('<path d="M14.5 6.5L20 12l-5.5 5.5"/><path d="M19.5 12H10a5 5 0 0 0-5 5v.5"/>'),
  chevronLeft: wrap('<polyline points="14.5 6.5 9 12 14.5 17.5"/>'),
  chevronRight: wrap('<polyline points="9.5 6.5 15 12 9.5 17.5"/>'),
  chevronUp: wrap('<polyline points="6.5 14.5 12 9 17.5 14.5"/>'),
  chevronDown: wrap('<polyline points="6.5 9.5 12 15 17.5 9.5"/>'),
  search: wrap('<circle cx="10.7" cy="10.7" r="6.2"/><line x1="15.3" y1="15.3" x2="20" y2="20"/>'),
  outline: wrap('<line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="4.5" cy="6" r=".8" fill="currentColor"/><circle cx="4.5" cy="12" r=".8" fill="currentColor"/><circle cx="4.5" cy="18" r=".8" fill="currentColor"/>'),
  thumbnails: wrap('<rect x="3.5" y="4" width="6.5" height="7" rx="1"/><rect x="14" y="4" width="6.5" height="7" rx="1"/><rect x="3.5" y="14" width="6.5" height="6" rx="1"/><rect x="14" y="14" width="6.5" height="6" rx="1"/>'),
  singlePage: wrap('<rect x="6.5" y="3.5" width="11" height="17" rx="1.5"/><line x1="9.5" y1="8" x2="14.5" y2="8"/><line x1="9.5" y1="11.5" x2="14.5" y2="11.5"/>'),
  facing: wrap('<rect x="2.8" y="5" width="8.2" height="14" rx="1.3"/><rect x="13" y="5" width="8.2" height="14" rx="1.3"/>'),
  book: wrap('<path d="M12 6.5C10.2 5.1 7.7 4.6 4 5v13c3.7-.4 6.2.1 8 1.5 1.8-1.4 4.3-1.9 8-1.5V5c-3.7-.4-6.2.1-8 1.5z"/><line x1="12" y1="6.5" x2="12" y2="19.5"/>'),
  continuous: wrap('<rect x="6.5" y="2.8" width="11" height="7" rx="1.2"/><rect x="6.5" y="14.2" width="11" height="7" rx="1.2"/><path d="M12 10v4.2"/><polyline points="9.8 12.1 12 14.3 14.2 12.1"/>'),
  rotateLeft: wrap('<path d="M5.3 8.2A7.5 7.5 0 1 1 4.8 15"/><polyline points="4.8 4.5 4.8 9 9.3 9"/>'),
  rotateRight: wrap('<path d="M18.7 8.2A7.5 7.5 0 1 0 19.2 15"/><polyline points="19.2 4.5 19.2 9 14.7 9"/>'),
  fullscreen: wrap('<polyline points="8.5 3.5 3.5 3.5 3.5 8.5"/><polyline points="15.5 3.5 20.5 3.5 20.5 8.5"/><polyline points="8.5 20.5 3.5 20.5 3.5 15.5"/><polyline points="15.5 20.5 20.5 20.5 20.5 15.5"/>'),
  // 品牌: 折角书页 (与应用图标同构)
  brand:
    '<svg viewBox="0 0 40 40" fill="none"><rect width="40" height="40" rx="10.5" fill="url(#ls-g)"/><path d="M17 9.5h8.2L30 14.3V29a1.8 1.8 0 0 1-1.8 1.8H17A1.8 1.8 0 0 1 15.2 29V11.3A1.8 1.8 0 0 1 17 9.5z" fill="#fff"/><path d="M25.2 9.5l4.8 4.8h-4.8V9.5z" fill="#CBF1FF"/><path d="M18.6 17h5.2M18.6 20.6h7M18.6 24.2h7M18.6 27.8h4.4" stroke="#6EC3FF" stroke-width="1.7" stroke-linecap="round"/><path d="M6.5 14.5h4M6.5 20h2.8M6.5 25.5h4" stroke="#fff" stroke-opacity=".85" stroke-width="2.2" stroke-linecap="round"/><defs><linearGradient id="ls-g" x1="4" y1="3" x2="36" y2="38" gradientUnits="userSpaceOnUse"><stop stop-color="#6BDBFF"/><stop offset="1" stop-color="#2E8BFF"/></linearGradient></defs></svg>',
}
