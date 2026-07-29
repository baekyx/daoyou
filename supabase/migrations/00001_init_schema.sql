
-- 用户角色枚举
CREATE TYPE public.user_role AS ENUM ('guide', 'tourist', 'photographer');

-- 房间状态枚举
CREATE TYPE public.room_status AS ENUM ('pending', 'live', 'ended');

-- ========== profiles ==========
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username text UNIQUE NOT NULL,
  nickname text,
  avatar_url text,
  phone text,
  role public.user_role NOT NULL DEFAULT 'tourist',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, username, role)
  VALUES (
    NEW.id,
    split_part(NEW.email, '@', 1),
    COALESCE((NEW.raw_user_meta_data->>'role')::public.user_role, 'tourist')
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

CREATE FUNCTION public.get_user_role(uid uuid)
RETURNS public.user_role
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  SELECT role FROM public.profiles WHERE id = uid;
$$;

-- ========== rooms ==========
CREATE TABLE public.rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_number text UNIQUE NOT NULL,
  password text NOT NULL,
  name text NOT NULL,
  cover_url text,
  guide_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status public.room_status NOT NULL DEFAULT 'pending',
  estimated_duration int,
  actual_duration int,
  online_count int NOT NULL DEFAULT 0,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 自动生成唯一6位数字房间号
CREATE FUNCTION public.generate_room_number()
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  num text;
  exists_already bool;
BEGIN
  LOOP
    num := lpad((floor(random() * 900000) + 100000)::int::text, 6, '0');
    SELECT EXISTS(SELECT 1 FROM public.rooms WHERE room_number = num) INTO exists_already;
    EXIT WHEN NOT exists_already;
  END LOOP;
  RETURN num;
END;
$$;

-- ========== room_members ==========
CREATE TABLE public.room_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role public.user_role NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  UNIQUE(room_id, user_id)
);

-- ========== subtitles ==========
CREATE TABLE public.subtitles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  content_cn text NOT NULL,
  content_en text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ========== questions ==========
CREATE TABLE public.questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES public.profiles(id) ON DELETE CASCADE,
  content text NOT NULL,
  is_answered bool NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ========== cards ==========
CREATE TABLE public.cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title_cn text NOT NULL,
  title_en text,
  content_cn text NOT NULL,
  content_en text,
  category text NOT NULL DEFAULT '建筑',
  tags text[] NOT NULL DEFAULT '{}',
  image_url text,
  created_by uuid NOT NULL DEFAULT auth.uid() REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ========== card_pushes ==========
CREATE TABLE public.card_pushes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  card_id uuid NOT NULL REFERENCES public.cards(id) ON DELETE CASCADE,
  pushed_by uuid NOT NULL DEFAULT auth.uid() REFERENCES public.profiles(id) ON DELETE CASCADE,
  pushed_at timestamptz NOT NULL DEFAULT now()
);

-- ========== photos ==========
CREATE TABLE public.photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  photographer_id uuid NOT NULL DEFAULT auth.uid() REFERENCES public.profiles(id) ON DELETE CASCADE,
  url text NOT NULL,
  taken_at timestamptz,
  uploaded_at timestamptz NOT NULL DEFAULT now()
);

-- ========== favorites ==========
CREATE TABLE public.favorites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES public.profiles(id) ON DELETE CASCADE,
  target_type text NOT NULL CHECK (target_type IN ('subtitle', 'photo')),
  target_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, target_type, target_id)
);

-- ========== Storage Buckets ==========
INSERT INTO storage.buckets (id, name, public) VALUES
  ('avatars', 'avatars', true),
  ('room-covers', 'room-covers', true),
  ('photos', 'photos', true),
  ('card-images', 'card-images', true);

-- ========== Realtime ==========
ALTER PUBLICATION supabase_realtime ADD TABLE public.subtitles;
ALTER PUBLICATION supabase_realtime ADD TABLE public.questions;
ALTER PUBLICATION supabase_realtime ADD TABLE public.card_pushes;
ALTER PUBLICATION supabase_realtime ADD TABLE public.rooms;
ALTER PUBLICATION supabase_realtime ADD TABLE public.room_members;
