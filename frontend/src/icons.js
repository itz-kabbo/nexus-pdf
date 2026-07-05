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
  plus: wrap('<line x1="12" y1="5.5" x2="12" y2="18.5"/><line x1="5.5" y1="12" x2="18.5" y2="12"/>'),
  close: wrap('<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>'),
  // 品牌: 折角书页 (与应用图标同构)
  brand:
    '<svg viewBox="0 0 40 40" fill="none"><rect width="40" height="40" rx="10.5" fill="url(#ls-g)"/><path d="M17 9.5h8.2L30 14.3V29a1.8 1.8 0 0 1-1.8 1.8H17A1.8 1.8 0 0 1 15.2 29V11.3A1.8 1.8 0 0 1 17 9.5z" fill="#fff"/><path d="M25.2 9.5l4.8 4.8h-4.8V9.5z" fill="#CBF1FF"/><path d="M18.6 17h5.2M18.6 20.6h7M18.6 24.2h7M18.6 27.8h4.4" stroke="#6EC3FF" stroke-width="1.7" stroke-linecap="round"/><path d="M6.5 14.5h4M6.5 20h2.8M6.5 25.5h4" stroke="#fff" stroke-opacity=".85" stroke-width="2.2" stroke-linecap="round"/><defs><linearGradient id="ls-g" x1="4" y1="3" x2="36" y2="38" gradientUnits="userSpaceOnUse"><stop stop-color="#6BDBFF"/><stop offset="1" stop-color="#2E8BFF"/></linearGradient></defs></svg>',
}
