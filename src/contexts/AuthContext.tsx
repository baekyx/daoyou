import { createContext, useContext, useEffect, useState, useCallback, useRef, type ReactNode } from 'react';
import { supabase } from '@/db/supabase';
import type { User, Session } from '@supabase/supabase-js';
import type { Profile, Room, SubtitlePrefs } from '@/types/types';
import { fetchMyProfile } from '@/api/profiles';

interface AuthContextType {
  user: User | null;
  profile: Profile | null;
  loading: boolean;
  profileLoading: boolean;
  currentRoom: Room | null;
  setCurrentRoom: (room: Room | null) => void;
  subtitlePrefs: SubtitlePrefs;
  setSubtitlePrefs: (prefs: SubtitlePrefs) => void;
  // auth
  sendPhoneOtp: (phone: string) => Promise<{ error: string | null }>;
  verifyPhoneOtp: (phone: string, token: string) => Promise<{ error: string | null }>;
  updatePhone: (phone: string, token: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  setSession: (session: Session) => void;
  /** 已登录用户身份切换（仅供 IdentityAccount 调用） */
  switchRole: (newRole: string) => Promise<{ role: string | null; error: string | null }>;
}

const DEFAULT_PREFS: SubtitlePrefs = {
  showCn: true,
  showEn: true,
  mode: 'bilingual',
  fontSize: 'medium',
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(false);
  const [currentRoom, setCurrentRoomState] = useState<Room | null>(() => {
    try {
      const saved = sessionStorage.getItem('shiguang-current-room');
      if (saved) return JSON.parse(saved) as Room;
      if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('demo')) {
        // A2 预置：demo fallback 不包含 password 字段
        return {
          id: 'demo-room', room_number: '888888', name: '故宫文化探索团',
          cover_url: null, guide_id: 'demo-guide', status: 'live', discoverable: true,
          estimated_duration: 90, actual_duration: null, online_count: 26,
          started_at: new Date().toISOString(), ended_at: null, created_at: new Date().toISOString(),
          guide: { id: 'demo-guide', username: 'zhang', nickname: '张老师', avatar_url: null },
        };
      }
      return null;
    } catch {
      return null;
    }
  });
  const [subtitlePrefs, setSubtitlePrefs] = useState<SubtitlePrefs>(() => {
    try {
      const saved = localStorage.getItem('shiguang-subtitle-prefs');
      return saved ? { ...DEFAULT_PREFS, ...JSON.parse(saved) } : DEFAULT_PREFS;
    } catch {
      return DEFAULT_PREFS;
    }
  });

  useEffect(() => {
    localStorage.setItem('shiguang-subtitle-prefs', JSON.stringify(subtitlePrefs));
  }, [subtitlePrefs]);

  const setCurrentRoom = useCallback((room: Room | null) => {
    setCurrentRoomState(room);
    if (room) sessionStorage.setItem('shiguang-current-room', JSON.stringify(room));
    else sessionStorage.removeItem('shiguang-current-room');
  }, []);

  // 请求序号：每次调用 loadProfile 递增，旧请求响应到达时若序号不匹配则丢弃
  const loadSeqRef = useRef(0);

  const loadProfile = useCallback((_uid: string) => {
    const seq = ++loadSeqRef.current;
    setProfileLoading(true);
    fetchMyProfile().then(p => {
      // 序号不匹配说明期间已切换用户/重新登录，丢弃旧响应
      if (seq !== loadSeqRef.current) return;
      setProfile(p);
    }).catch(() => {
      if (seq !== loadSeqRef.current) return;
      // RPC 网络失败时保留已有 profile，不强制清空（防止误判为未注册）
    }).finally(() => {
      if (seq !== loadSeqRef.current) return;
      setProfileLoading(false);
    });
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      if (session?.user) {
        loadProfile(session.user.id);
      }
    }).finally(() => setLoading(false));

    // In this function, do NOT use any await calls. Use `.then()` instead to avoid deadlocks.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      if (session?.user) {
        loadProfile(session.user.id);
      } else {
        setProfile(null);
        setProfileLoading(false);
        // 保留邀请链接已经选中的房间；游客登录后应回到同一密码/收听流程。
      }
    });
    return () => subscription.unsubscribe();
  }, [loadProfile]);

  const refreshProfile = useCallback(async () => {
    if (user) loadProfile(user.id);
  }, [user, loadProfile]);

  // 测试白名单：指定号码使用固定验证码 888888，不走真实短信
  // verifyPhoneOtp 白名单命中后调用 dev-test-login EF，由服务端用 generateLink 签发真实 session
  const DEV_PHONE_WHITELIST: Record<string, string> = {
    '18888888888': '888888',
  };

  const sendPhoneOtp = useCallback(async (phone: string) => {
    if (DEV_PHONE_WHITELIST[phone]) {
      // 白名单号码：跳过真实发送，静默成功
      return { error: null };
    }
    const { error } = await supabase.auth.signInWithOtp({
      phone: `+86${phone}`,
    });
    return { error: error?.message ?? null };
  }, []);

  const verifyPhoneOtp = useCallback(async (phone: string, token: string) => {
    if (DEV_PHONE_WHITELIST[phone]) {
      if (token !== DEV_PHONE_WHITELIST[phone]) {
        return { error: '验证码错误' };
      }
      // 白名单命中：调用 dev-test-login EF，服务端用 generateLink(magiclink) 签发真实 Supabase session
      // 不走 supabase.auth.verifyOtp(手机 OTP)，避免 Supabase 未发过该 OTP 导致失败
      const { data, error: efErr } = await supabase.functions.invoke('dev-test-login', {
        body: { phone, code: token },
      });
      if (efErr || data?.error) {
        return { error: data?.error ?? efErr?.message ?? '测试登录失败' };
      }
      if (!data?.session) return { error: '测试登录未返回 session' };
      // 注入真实 session（触发 onAuthStateChange → loadProfile）
      await supabase.auth.setSession({
        access_token:  data.session.access_token,
        refresh_token: data.session.refresh_token,
      });
      return { error: null };
    }
    const { error } = await supabase.auth.verifyOtp({
      phone: `+86${phone}`,
      token,
      type: 'sms',
    });
    return { error: error?.message ?? null };
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setUser(null);
    setProfile(null);
    setCurrentRoom(null);
  }, []);

  // 更换绑定手机号：验证新手机OTP后更新 profiles 表
  const updatePhone = useCallback(async (phone: string, token: string) => {
    // 验证新手机 OTP
    const { error: verifyErr } = await supabase.auth.verifyOtp({
      phone: `+86${phone}`,
      token,
      type: 'sms',
    });
    if (verifyErr) return { error: verifyErr.message };
    // 写入 profiles 表
    const uid = (await supabase.auth.getUser()).data.user?.id;
    if (!uid) return { error: '未登录' };
    const { error: updateErr } = await supabase
      .from('profiles')
      .update({ phone: phone.trim() })
      .eq('id', uid);
    if (updateErr) return { error: updateErr.message };
    return { error: null };
  }, []);

  const setSession = useCallback((session: Session) => {
    // 同步更新 supabase JS client 内部 token，确保后续 Storage 上传等请求携带 JWT
    supabase.auth.setSession({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    });
    setUser(session.user);
    loadProfile(session.user.id);
  }, [loadProfile]);

  // 已登录用户身份切换（仅供 IdentityAccount 调用），懒加载 api 模块避免顶层循环依赖
  const switchRole = useCallback(async (newRole: string) => {
    const { switchRole: apiSwitchRole } = await import('@/api/users');
    return apiSwitchRole(newRole);
  }, []);

  return (
    <AuthContext.Provider value={{
      user, profile, loading, profileLoading,
      currentRoom, setCurrentRoom,
      subtitlePrefs, setSubtitlePrefs,
      sendPhoneOtp, verifyPhoneOtp, updatePhone, signOut, refreshProfile, setSession,
      switchRole,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}
