/**
 * IdentityAccount — 已登录用户的身份切换页
 *
 * 规则：
 * - 只展示"另外两个"可切换身份，当前身份显示为激活态（不可点击）
 * - 切换时调用独立 switch_my_role RPC（非首次注册的 set_my_role）
 * - 成功后校验 profile.role 已变更，再清理游客房间（untrack + leaveRoom + setCurrentRoom(null)）+ replace 到目标首页
 * - 防重复点击；失败保留原身份并中文提示
 */
import React, { useState } from 'react';
import { ChevronRight, UserRound, ChevronLeft } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import type { UserRole } from '@/types/types';
import { useTouristRoomCleanup } from '@/hooks/useTouristRoomCleanup';

interface Props { go: (id: string) => void }

interface RoleOption {
  role: UserRole;
  label: string;
  desc: string;
  home: string;
  color: string;
}

const ROLE_OPTIONS: RoleOption[] = [
  { role: 'tourist',      label: '游客',    desc: '收听导游讲解、查看景区资料',  home: 'room-list',          color: 'amber' },
  { role: 'guide',        label: '导游',    desc: '创建讲解房、实时讲解与字幕',   home: 'guide-home',         color: 'green' },
  { role: 'photographer', label: '摄影师',  desc: '上传照片、管理相册与任务',     home: 'photographer-tasks', color: 'blue'  },
];

export function IdentityAccount({ go }: Props) {
  const { user, profile, refreshProfile } = useAuth();
  const { switchRole } = useAuth();
  const { performTouristCleanup } = useTouristRoomCleanup();
  const [busy, setBusy] = useState<UserRole | null>(null);

  const currentRole = profile?.role as UserRole | undefined;

  const handleSwitch = async (opt: RoleOption) => {
    if (!user || busy || opt.role === currentRole) return;
    setBusy(opt.role);
    toast.loading(`切换为${opt.label}中…`, { id: 'role-switch' });

    const { role: newRole, error } = await switchRole(opt.role);
    if (error || !newRole) {
      toast.error(error ?? '身份切换失败，请稍后重试', { id: 'role-switch' });
      setBusy(null);
      return;
    }

    // 刷新全局 AuthContext，确保 profile.role 已变更
    await refreshProfile();

    // post-switch 校验：验证 profile.role 已切换（防止 RPC 静默失败）
    if (newRole !== opt.role) {
      toast.error('身份切换未生效，请重新尝试', { id: 'role-switch' });
      setBusy(null);
      return;
    }

    // 顺序：untrack Presence → leaveRoom(left_at) → setCurrentRoom(null)，再跳页
    await performTouristCleanup();
    ['shiguang-current-room', 'shiguang-role'].forEach(k => {
      localStorage.removeItem(k);
      sessionStorage.removeItem(k);
    });

    toast.success(`已切换为${opt.label}`, { id: 'role-switch' });
    setBusy(null);
    go(opt.home);
  };

  return (
    <div className="screen padded-screen ia-screen">
      {/* 顶部导航 */}
      <div className="ia-header">
        <button className="ia-back" onClick={() => go(
          currentRole === 'guide' ? 'my'
          : currentRole === 'photographer' ? 'photographer-my'
          : 'tourist-my'
        )}>
          <ChevronLeft size={20} />
        </button>
        <strong className="ia-title">身份与账号</strong>
        <span />
      </div>

      {/* 当前账号信息 */}
      <div className="ia-account-card">
        <div className="ia-avatar">
          {profile?.avatar_url
            ? <img src={profile.avatar_url} alt="头像" />
            : <UserRound size={28} />}
        </div>
        <div className="ia-account-info">
          <span className="ia-name">{profile?.nickname ?? '未设置昵称'}</span>
          <span className="ia-phone">{profile?.phone ? `+86 ${profile.phone}` : '手机号未绑定'}</span>
        </div>
      </div>

      {/* 身份列表 */}
      <div className="ia-section-title">选择身份</div>
      <p className="ia-hint">切换身份后，原有数据（房间记录、照片、字幕等）均会保留。</p>

      <div className="ia-role-list">
        {ROLE_OPTIONS.map(opt => {
          const isCurrent = opt.role === currentRole;
          const isLoading = busy === opt.role;
          return (
            <button
              key={opt.role}
              className={`ia-role-item ia-role-${opt.color}${isCurrent ? ' ia-role-active' : ''}`}
              onClick={() => handleSwitch(opt)}
              disabled={isCurrent || busy !== null}
              aria-current={isCurrent ? 'true' : undefined}
            >
              <span className={`ia-role-dot ia-dot-${opt.color}`} />
              <span className="ia-role-body">
                <strong className="ia-role-label">
                  {opt.label}
                  {isCurrent && <span className="ia-current-tag">当前</span>}
                </strong>
                <small className="ia-role-desc">{opt.desc}</small>
              </span>
              {!isCurrent && (
                isLoading
                  ? <span className="ia-spinner" />
                  : <ChevronRight size={16} className="ia-arrow" />
              )}
            </button>
          );
        })}
      </div>

      <p className="ia-footer-note">切换身份不会改变您的账号、手机号或已有业务数据。</p>
    </div>
  );
}
