
-- ========== RLS：profiles ==========
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "profiles: 用户查看自己" ON public.profiles
  FOR SELECT TO authenticated USING (id = auth.uid());

CREATE POLICY "profiles: 用户更新自己(禁改role)" ON public.profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid() AND role = get_user_role(auth.uid()));

-- 任何人都可以查看基本昵称（用于房间列表展示导游信息）
CREATE POLICY "profiles: 任何已登录用户可查看他人" ON public.profiles
  FOR SELECT TO authenticated USING (true);

-- ========== RLS：rooms ==========
ALTER TABLE public.rooms ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rooms: 任何已登录可查看进行中或等待中" ON public.rooms
  FOR SELECT TO authenticated USING (status IN ('pending','live'));

CREATE POLICY "rooms: 导游可查看自己的所有房间" ON public.rooms
  FOR SELECT TO authenticated USING (guide_id = auth.uid());

CREATE POLICY "rooms: 导游可创建" ON public.rooms
  FOR INSERT TO authenticated WITH CHECK (guide_id = auth.uid());

CREATE POLICY "rooms: 导游可更新自己的房间" ON public.rooms
  FOR UPDATE TO authenticated
  USING (guide_id = auth.uid()) WITH CHECK (guide_id = auth.uid());

-- ========== RLS：room_members ==========
ALTER TABLE public.room_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "room_members: 房间成员可查看" ON public.room_members
  FOR SELECT TO authenticated USING (
    user_id = auth.uid() OR
    room_id IN (SELECT id FROM public.rooms WHERE guide_id = auth.uid())
  );

CREATE POLICY "room_members: 已登录用户可加入" ON public.room_members
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

CREATE POLICY "room_members: 自己可离开(update left_at)" ON public.room_members
  FOR UPDATE TO authenticated USING (user_id = auth.uid());

-- ========== RLS：subtitles ==========
ALTER TABLE public.subtitles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "subtitles: 任何已登录可查看" ON public.subtitles
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "subtitles: 导游可插入" ON public.subtitles
  FOR INSERT TO authenticated WITH CHECK (
    room_id IN (SELECT id FROM public.rooms WHERE guide_id = auth.uid())
  );

-- ========== RLS：questions ==========
ALTER TABLE public.questions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "questions: 提问者和导游可查看" ON public.questions
  FOR SELECT TO authenticated USING (
    user_id = auth.uid() OR
    room_id IN (SELECT id FROM public.rooms WHERE guide_id = auth.uid())
  );

CREATE POLICY "questions: 任何已登录可提问" ON public.questions
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

-- ========== RLS：cards ==========
ALTER TABLE public.cards ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cards: 任何已登录可查看" ON public.cards
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "cards: 导游可创建" ON public.cards
  FOR INSERT TO authenticated WITH CHECK (
    get_user_role(auth.uid()) = 'guide' AND created_by = auth.uid()
  );

CREATE POLICY "cards: 导游可更新自己的" ON public.cards
  FOR UPDATE TO authenticated
  USING (created_by = auth.uid()) WITH CHECK (created_by = auth.uid());

-- ========== RLS：card_pushes ==========
ALTER TABLE public.card_pushes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "card_pushes: 任何已登录可查看" ON public.card_pushes
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "card_pushes: 导游可推送" ON public.card_pushes
  FOR INSERT TO authenticated WITH CHECK (
    pushed_by = auth.uid() AND
    room_id IN (SELECT id FROM public.rooms WHERE guide_id = auth.uid())
  );

-- ========== RLS：photos ==========
ALTER TABLE public.photos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "photos: 任何已登录可查看" ON public.photos
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "photos: 摄影师可上传" ON public.photos
  FOR INSERT TO authenticated WITH CHECK (photographer_id = auth.uid());

CREATE POLICY "photos: 摄影师可删除自己的" ON public.photos
  FOR DELETE TO authenticated USING (photographer_id = auth.uid());

-- ========== RLS：favorites ==========
ALTER TABLE public.favorites ENABLE ROW LEVEL SECURITY;

CREATE POLICY "favorites: 用户查看自己的" ON public.favorites
  FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE POLICY "favorites: 用户可收藏" ON public.favorites
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

CREATE POLICY "favorites: 用户可取消收藏" ON public.favorites
  FOR DELETE TO authenticated USING (user_id = auth.uid());

-- ========== Storage RLS ==========
CREATE POLICY "avatars: 已登录可上传" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (bucket_id = 'avatars');
CREATE POLICY "avatars: 公开可读" ON storage.objects
  FOR SELECT USING (bucket_id = 'avatars');

CREATE POLICY "room-covers: 导游可上传" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (bucket_id = 'room-covers');
CREATE POLICY "room-covers: 公开可读" ON storage.objects
  FOR SELECT USING (bucket_id = 'room-covers');

CREATE POLICY "photos: 摄影师可上传" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (bucket_id = 'photos');
CREATE POLICY "photos: 公开可读" ON storage.objects
  FOR SELECT USING (bucket_id = 'photos');

CREATE POLICY "card-images: 导游可上传" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (bucket_id = 'card-images');
CREATE POLICY "card-images: 公开可读" ON storage.objects
  FOR SELECT USING (bucket_id = 'card-images');
