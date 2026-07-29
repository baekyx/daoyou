
-- A2 预置 Migration 01 (修正版)
-- room_secrets + room_join_rate_limits + 哈希回填 + 兼容触发器

-- ── 1. room_secrets ──
CREATE TABLE IF NOT EXISTS public.room_secrets (
  room_id     UUID        NOT NULL PRIMARY KEY
                          REFERENCES public.rooms(id) ON DELETE CASCADE,
  pwd_hash    TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.room_secrets ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.room_secrets FROM PUBLIC;
REVOKE ALL ON public.room_secrets FROM authenticated;
REVOKE ALL ON public.room_secrets FROM anon;

-- ── 2. room_join_rate_limits ──
CREATE TABLE IF NOT EXISTS public.room_join_rate_limits (
  id            BIGSERIAL   NOT NULL PRIMARY KEY,
  user_id       UUID        NOT NULL,
  room_id       UUID        NOT NULL,
  fail_count    INT         NOT NULL DEFAULT 0,
  locked_until  TIMESTAMPTZ          DEFAULT NULL,
  last_fail_at  TIMESTAMPTZ          DEFAULT NULL,
  UNIQUE (user_id, room_id)
);

ALTER TABLE public.room_join_rate_limits ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.room_join_rate_limits FROM PUBLIC;
REVOKE ALL ON public.room_join_rate_limits FROM authenticated;
REVOKE ALL ON public.room_join_rate_limits FROM anon;

-- ── 3. 回填现有 rooms.password 的 bcrypt 哈希（幂等）──
INSERT INTO public.room_secrets (room_id, pwd_hash)
SELECT
  r.id,
  crypt(r.password, gen_salt('bf', 8))
FROM public.rooms r
WHERE NOT EXISTS (
  SELECT 1 FROM public.room_secrets rs WHERE rs.room_id = r.id
)
  AND r.password IS NOT NULL
  AND r.password <> '';

-- ── 4. 触发器：旧前端写 rooms.password 时自动同步哈希 ──
CREATE OR REPLACE FUNCTION public._sync_room_password_hash()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.password IS DISTINCT FROM OLD.password) THEN
    IF NEW.password IS NOT NULL AND NEW.password <> '' THEN
      INSERT INTO public.room_secrets (room_id, pwd_hash, updated_at)
      VALUES (
        NEW.id,
        crypt(NEW.password, gen_salt('bf', 8)),
        NOW()
      )
      ON CONFLICT (room_id) DO UPDATE
        SET pwd_hash   = EXCLUDED.pwd_hash,
            updated_at = NOW();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public._sync_room_password_hash() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_sync_room_password_hash ON public.rooms;
CREATE TRIGGER trg_sync_room_password_hash
  AFTER INSERT OR UPDATE OF password ON public.rooms
  FOR EACH ROW
  EXECUTE FUNCTION public._sync_room_password_hash();
