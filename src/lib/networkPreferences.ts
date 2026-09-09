export const WIFI_ONLY_STORAGE_KEY = 'shiguang-wifi-only';

type NetworkInformation = {
  type?: string;
};

/**
 * Web 端只有部分浏览器会暴露准确的网络连接类型。
 * - 明确检测到蜂窝网络时阻止上传；
 * - Wi-Fi / 有线网络时允许；
 * - 不支持检测时不误拦截，并交由页面提示用户。
 */
export function getUploadNetworkState(): {
  allowed: boolean;
  detectable: boolean;
  reason: string | null;
} {
  if (!navigator.onLine) {
    return { allowed: false, detectable: true, reason: '当前设备离线，请联网后重试' };
  }

  const connection = (navigator as Navigator & {
    connection?: NetworkInformation;
    mozConnection?: NetworkInformation;
    webkitConnection?: NetworkInformation;
  }).connection
    ?? (navigator as Navigator & { mozConnection?: NetworkInformation }).mozConnection
    ?? (navigator as Navigator & { webkitConnection?: NetworkInformation }).webkitConnection;

  const type = connection?.type?.toLowerCase();
  if (!type) return { allowed: true, detectable: false, reason: null };
  if (type === 'wifi' || type === 'ethernet') {
    return { allowed: true, detectable: true, reason: null };
  }
  if (type === 'cellular' || type === 'wimax') {
    return { allowed: false, detectable: true, reason: '已开启仅 Wi-Fi 上传，当前网络不是 Wi-Fi' };
  }
  return { allowed: true, detectable: true, reason: null };
}

export function isWifiOnlyUploadEnabled() {
  return localStorage.getItem(WIFI_ONLY_STORAGE_KEY) === 'true';
}
