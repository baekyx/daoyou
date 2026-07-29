-- 导游本人安全读取自己房间明文密码
-- 仅当 auth.uid() = rooms.guide_id 时返回密码，否则返回 NULL
-- SECURITY DEFINER + 固定 search_path 防止搜索路径注入
CREATE OR REPLACE FUNCTION public.get_my_room_password(p_room_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_guide_id UUID;
  v_password TEXT;
BEGIN
  -- 获取房间的导游 ID
  SELECT guide_id, password
    INTO v_guide_id, v_password
    FROM public.rooms
   WHERE id = p_room_id;

  -- 未找到房间
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- 严格校验：只有房间所属导游本人才能获取密码
  IF v_guide_id IS DISTINCT FROM auth.uid() THEN
    RETURN NULL;
  END IF;

  RETURN v_password;
END;
$$;

-- 权限：只有已认证用户可调用（RPC 内部再做 guide_id 校验）
REVOKE ALL ON FUNCTION public.get_my_room_password(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_my_room_password(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_my_room_password(UUID) TO authenticated;