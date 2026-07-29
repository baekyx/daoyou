
-- feedbacks 表
CREATE TABLE public.feedbacks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT '',
  category    text NOT NULL DEFAULT '',
  content     text NOT NULL,
  contact     text,
  status      text NOT NULL DEFAULT 'pending',
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.feedbacks ENABLE ROW LEVEL SECURITY;

-- 已登录用户只能 INSERT 自己的反馈
CREATE POLICY "feedbacks_insert_own" ON public.feedbacks
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

-- 已登录用户只能 SELECT 自己的反馈
CREATE POLICY "feedbacks_select_own" ON public.feedbacks
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- 匿名用户无任何权限（不添加策略即拒绝）

-- service_role 全管理（默认绕过 RLS，无需额外策略）
