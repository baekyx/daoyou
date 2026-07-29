/**
 * 邀请链接工具 — 统一生成正式域名邀请地址
 *
 * 规则：
 * 1. 始终使用正式域名 https://app-d04hti6zlz42.appmiaoda.com/
 *    不使用 window.location.origin（避免开发/沙箱环境泄漏）
 * 2. 仅携带 invite=<6位房间号> 参数，不含任何密码
 */

/** 正式对外域名（不以 / 结尾） */
export const INVITE_ORIGIN = 'https://app-d04hti6zlz42.appmiaoda.com';

/**
 * 生成标准邀请链接
 * @param roomNumber 6 位房间号
 * @returns 完整邀请 URL，例如 https://app-d04hti6zlz42.appmiaoda.com/?invite=809316
 */
export function buildInviteUrl(roomNumber: string | number): string {
  return `${INVITE_ORIGIN}/?invite=${roomNumber}`;
}
