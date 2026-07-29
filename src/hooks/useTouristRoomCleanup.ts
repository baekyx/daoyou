/**
 * useTouristRoomCleanup — 游客房间主动离线 helper（v375）
 *
 * 问题背景：
 *   退出登录、切换身份、账号注销三条路径原先直接调用 signOut()，
 *   未执行 untrackPresence + leaveRoom，导致：
 *     - Presence 在线人数需等服务端超时才归零（通常 30-60s）
 *     - room_members.left_at 永远为 null，历史记录时间残缺
 *
 * 修复方案：
 *   抽取可复用 hook，返回单一 performTouristCleanup() 函数。
 *   调用方在 signOut/switchRole/delete 前先 await 此函数。
 *
 * 调用顺序（规范）：
 *   await performTouristCleanup()   ← untrack Presence + 写 left_at
 *   await signOut() / switchRole() / delete-account
 *
 * 安全性：
 *   - 无房间时空操作，导游/摄影师调用无副作用
 *   - untrackPresence 已有内部 guard（trackedRef），重复调用安全
 *   - 异常断网仍由 Presence 自动 leave，此函数只处理主动退出
 *
 * 依赖：
 *   - useAuth：获取 currentRoom + user
 *   - useRoomRtc（可选）：获取 untrackPresence；若不在 RoomRtcProvider 内则降级
 *   - leaveRoom API：写 left_at
 */
import { useCallback } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useRoomPresence } from '@/hooks/use-room-presence';
import { leaveRoom } from '@/api/roomActivity';

export function useTouristRoomCleanup() {
  const { user, currentRoom, setCurrentRoom } = useAuth();
  // 安全降级：若不在 RoomPresenceProvider 内（非游客在房间内），返回空操作
  const { untrackPresence } = useRoomPresence();

  /**
   * 游客主动离开房间的完整清理序列：
   *   1. 清除 Presence 追踪意图（防止 SUBSCRIBED 回调补 track）
   *   2. await untrackPresence()（通知服务端立即 leave）
   *   3. await leaveRoom()（写 room_members.left_at）
   *   4. setCurrentRoom(null)（清除本地状态）
   *
   * 安全：无房间或非游客角色时自动空操作。
   */
  const performTouristCleanup = useCallback(async () => {
    // 无房间：空操作（导游/摄影师/未进入房间的游客）
    if (!currentRoom || !user) {
      setCurrentRoom(null);
      return;
    }

    // 1. untrack Presence（先于 leaveRoom）
    await untrackPresence();

    // 2. 写 left_at
    try {
      await leaveRoom(currentRoom.id, user.id);
    } catch (err) {
      // 网络异常时不阻塞退出流程
      console.warn('[TouristCleanup] leaveRoom 失败，继续退出:', err);
    }

    // 3. 清除本地房间状态
    setCurrentRoom(null);
  }, [currentRoom, user, untrackPresence, setCurrentRoom]);

  return { performTouristCleanup };
}
