-- ============================================================
-- SECTION: SCHEMA
-- ============================================================

--
-- PostgreSQL database dump
--


-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS "public";


--
-- Name: SCHEMA "public"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA "public" IS 'standard public schema';


--
-- Name: pg_graphql; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "pg_graphql" WITH SCHEMA "graphql";


--
-- Name: EXTENSION "pg_graphql"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION "pg_graphql" IS 'pg_graphql: GraphQL support';


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";


--
-- Name: EXTENSION "pgcrypto"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION "pgcrypto" IS 'cryptographic functions';


--
-- Name: supabase_vault; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";


--
-- Name: EXTENSION "supabase_vault"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION "supabase_vault" IS 'Supabase Vault Extension';


--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";


--
-- Name: EXTENSION "uuid-ossp"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION "uuid-ossp" IS 'generate universally unique identifiers (UUIDs)';


--
-- Name: room_status; Type: TYPE; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
      AND t.typname = 'room_status'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE TYPE "public"."room_status" AS ENUM (
    'pending',
    'live',
    'ended'
);
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: user_role; Type: TYPE; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
      AND t.typname = 'user_role'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE TYPE "public"."user_role" AS ENUM (
    'guide',
    'tourist',
    'photographer'
);
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: _is_room_participant("uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."_is_room_participant"("p_room_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
BEGIN
  RETURN (
    EXISTS (
      SELECT 1 FROM public.rooms r
      WHERE r.id = p_room_id AND r.guide_id = auth.uid()
    )
    OR
    EXISTS (
      SELECT 1 FROM public.room_members rm
      WHERE rm.room_id = p_room_id
        AND rm.user_id = auth.uid()
    )
  );
END;
$$;


--
-- Name: _sync_room_password_hash(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."_sync_room_password_hash"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF TG_OP = 'INSERT'
     OR (TG_OP = 'UPDATE' AND NEW.password IS DISTINCT FROM OLD.password) THEN
    IF NEW.password IS NOT NULL AND NEW.password <> '' THEN
      INSERT INTO public.room_secrets (room_id, pwd_hash, updated_at)
      VALUES (
        NEW.id,
        extensions.crypt(NEW.password, extensions.gen_salt('bf', 8)),
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


--
-- Name: asr_check_lease("uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."asr_check_lease"("p_session_id" "uuid") RETURNS TABLE("is_active" boolean)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  RETURN QUERY
    SELECT (closed_at IS NULL) AS is_active
    FROM public.asr_sessions
    WHERE id = p_session_id;
END;
$$;


--
-- Name: check_phone_available("text", "uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."check_phone_available"("p_phone_e164" "text", "p_exclude_uid" "uuid") RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM auth.users
    WHERE phone = p_phone_e164
      AND id != p_exclude_uid
  );
$$;


--
-- Name: check_room_access("uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."check_room_access"("p_room_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_uid         UUID;
  v_room_status TEXT;
  v_authorized  BOOLEAN := FALSE;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object(
      'authorized', false,
      'room_status', null,
      'reason', 'not_authenticated'
    );
  END IF;

  SELECT status::text INTO v_room_status FROM public.rooms WHERE id = p_room_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'authorized', false,
      'room_status', null,
      'reason', 'room_not_found'
    );
  END IF;

  -- 有效授权：access_granted_at IS NOT NULL AND access_revoked_at IS NULL
  SELECT EXISTS(
    SELECT 1 FROM public.room_members
    WHERE room_id   = p_room_id
      AND user_id   = v_uid
      AND access_granted_at IS NOT NULL
      AND access_revoked_at IS NULL
  ) INTO v_authorized;

  RETURN jsonb_build_object(
    'authorized',   v_authorized,
    'room_status',  v_room_status,
    'reason',
      CASE
        WHEN v_authorized                          THEN 'authorized'
        WHEN v_room_status NOT IN ('pending','live') THEN 'room_not_active'
        ELSE                                           'no_access'
      END
  );
END;
$$;


--
-- Name: create_room_secure("text", "text", "text", integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."create_room_secure"("p_name" "text", "p_password" "text", "p_cover_url" "text" DEFAULT NULL::"text", "p_estimated_duration" integer DEFAULT 60) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
DECLARE
  v_uid         UUID;
  v_role        TEXT;
  v_existing    public.rooms%ROWTYPE;
  v_new_room    public.rooms%ROWTYPE;
  v_room_number TEXT;
  v_attempt     INT := 0;
  v_err_msg     TEXT;
BEGIN
  -- 0. 登录校验
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_authenticated');
  END IF;

  -- 1. 角色校验（仅 guide）
  SELECT role::TEXT INTO v_role FROM public.profiles WHERE id = v_uid;
  IF v_role IS DISTINCT FROM 'guide' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'forbidden');
  END IF;

  -- 2. 参数校验
  p_name := TRIM(p_name);
  IF LENGTH(p_name) < 2 OR LENGTH(p_name) > 30 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_name');
  END IF;
  IF p_password !~ '^\d{6}$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_password');
  END IF;

  -- 3. 查重：该导游已有 pending/live 房间
  SELECT * INTO v_existing
  FROM public.rooms
  WHERE guide_id = v_uid
    AND status IN ('pending', 'live')
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;   -- 并发锁：防止两个请求同时通过查重

  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok',     true,
      'code',   'existed',
      'room',   jsonb_build_object(
        'id',                  v_existing.id,
        'room_number',         v_existing.room_number,
        'name',                v_existing.name,
        'cover_url',           v_existing.cover_url,
        'guide_id',            v_existing.guide_id,
        'status',              v_existing.status,
        'discoverable',        v_existing.discoverable,
        'estimated_duration',  v_existing.estimated_duration,
        'actual_duration',     v_existing.actual_duration,
        'online_count',        v_existing.online_count,
        'started_at',          v_existing.started_at,
        'ended_at',            v_existing.ended_at,
        'created_at',          v_existing.created_at
      )
    );
  END IF;

  -- 4. 循环生成唯一 room_number，最多 10 次
  LOOP
    v_attempt := v_attempt + 1;
    IF v_attempt > 10 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'room_number_exhausted');
    END IF;

    v_room_number := LPAD(
      (FLOOR(RANDOM() * 900000) + 100000)::TEXT,
      6, '0'
    );

    BEGIN
      INSERT INTO public.rooms (
        room_number, password, name, cover_url,
        guide_id, estimated_duration, status
      ) VALUES (
        v_room_number, p_password, p_name, p_cover_url,
        v_uid, p_estimated_duration, 'pending'
      )
      RETURNING * INTO v_new_room;

      -- 插入成功，退出循环
      EXIT;

    EXCEPTION
      WHEN unique_violation THEN
        -- 检查是哪个唯一约束
        GET STACKED DIAGNOSTICS v_err_msg = MESSAGE_TEXT;
        IF v_err_msg LIKE '%room_number%' OR v_err_msg LIKE '%rooms_room_number_key%' THEN
          CONTINUE;  -- room_number 冲突，重试
        ELSIF v_err_msg LIKE '%one_active_per_guide%' THEN
          -- 并发穿透：重查返回已有房间
          SELECT * INTO v_existing
          FROM public.rooms
          WHERE guide_id = v_uid AND status IN ('pending', 'live')
          ORDER BY created_at DESC LIMIT 1;
          IF FOUND THEN
            RETURN jsonb_build_object(
              'ok', true, 'code', 'existed',
              'room', jsonb_build_object(
                'id',                  v_existing.id,
                'room_number',         v_existing.room_number,
                'name',                v_existing.name,
                'cover_url',           v_existing.cover_url,
                'guide_id',            v_existing.guide_id,
                'status',              v_existing.status,
                'discoverable',        v_existing.discoverable,
                'estimated_duration',  v_existing.estimated_duration,
                'actual_duration',     v_existing.actual_duration,
                'online_count',        v_existing.online_count,
                'started_at',          v_existing.started_at,
                'ended_at',            v_existing.ended_at,
                'created_at',          v_existing.created_at
              )
            );
          END IF;
          RETURN jsonb_build_object('ok', false, 'code', 'concurrent_conflict');
        ELSE
          RAISE;
        END IF;
    END;
  END LOOP;

  -- 5. 触发器已自动写入 room_secrets，此处不重复写
  -- 返回安全字段（不含 password）
  RETURN jsonb_build_object(
    'ok',   true,
    'code', 'created',
    'room', jsonb_build_object(
      'id',                  v_new_room.id,
      'room_number',         v_new_room.room_number,
      'name',                v_new_room.name,
      'cover_url',           v_new_room.cover_url,
      'guide_id',            v_new_room.guide_id,
      'status',              v_new_room.status,
      'discoverable',        v_new_room.discoverable,
      'estimated_duration',  v_new_room.estimated_duration,
      'actual_duration',     v_new_room.actual_duration,
      'online_count',        v_new_room.online_count,
      'started_at',          v_new_room.started_at,
      'ended_at',            v_new_room.ended_at,
      'created_at',          v_new_room.created_at
    )
  );
END;
$_$;


--
-- Name: generate_room_number(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."generate_room_number"() RETURNS "text"
    LANGUAGE "plpgsql"
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


--
-- Name: get_active_rooms_secure(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."get_active_rooms_secure"() RETURNS "jsonb"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id',                  r.id,
        'room_number',         r.room_number,
        'name',                r.name,
        'cover_url',           r.cover_url,
        'guide_id',            r.guide_id,
        'status',              r.status,
        'discoverable',        r.discoverable,
        'estimated_duration',  r.estimated_duration,
        'actual_duration',     r.actual_duration,
        'online_count',        r.online_count,
        'started_at',          r.started_at,
        'ended_at',            r.ended_at,
        'created_at',          r.created_at,
        'guide',               jsonb_build_object(
          'id',         p.id,
          'username',   p.username,
          'nickname',   p.nickname,
          'avatar_url', p.avatar_url
        )
      )
      ORDER BY r.created_at DESC
    ),
    '[]'::JSONB
  )
  FROM public.rooms r
  LEFT JOIN public.profiles p ON p.id = r.guide_id
  WHERE r.status IN ('pending', 'live')
  LIMIT 30;
$$;


--
-- Name: get_guide_rooms_secure(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."get_guide_rooms_secure"() RETURNS "jsonb"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id',                  r.id,
        'room_number',         r.room_number,
        'name',                r.name,
        'cover_url',           r.cover_url,
        'guide_id',            r.guide_id,
        'status',              r.status,
        'discoverable',        r.discoverable,
        'estimated_duration',  r.estimated_duration,
        'actual_duration',     r.actual_duration,
        'online_count',        r.online_count,
        'started_at',          r.started_at,
        'ended_at',            r.ended_at,
        'created_at',          r.created_at
      )
      ORDER BY r.created_at DESC
    ),
    '[]'::JSONB
  )
  FROM public.rooms r
  WHERE r.guide_id = auth.uid()
  LIMIT 50;
$$;


--
-- Name: get_is_admin("uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."get_is_admin"("uid" "uuid") RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT COALESCE(is_admin, false) FROM public.profiles WHERE id = uid;
$$;


SET default_tablespace = '';

SET default_table_access_method = "heap";

--
-- Name: knowledge_cards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."knowledge_cards" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "title_cn" "text" NOT NULL,
    "title_en" "text",
    "desc_cn" "text" DEFAULT ''::"text" NOT NULL,
    "desc_en" "text",
    "category" "text" DEFAULT '建筑'::"text" NOT NULL,
    "image_url" "text",
    "era" "text",
    "location" "text",
    "status" "text" DEFAULT 'published'::"text" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "deleted_at" timestamp with time zone
);


--
-- Name: get_kc_by_push("uuid", "uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."get_kc_by_push"("p_room_id" "uuid", "p_kc_card_id" "uuid") RETURNS "public"."knowledge_cards"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT kc.*
  FROM public.knowledge_cards kc
  WHERE kc.id = p_kc_card_id
    AND EXISTS (
      SELECT 1 FROM public.card_pushes cp
      WHERE cp.room_id = p_room_id
        AND cp.kc_card_id = p_kc_card_id
    )
    AND (
      EXISTS (
        SELECT 1 FROM public.room_members rm
        WHERE rm.room_id = p_room_id
          AND rm.user_id = auth.uid()
          AND rm.left_at IS NULL
      )
      OR EXISTS (
        SELECT 1 FROM public.rooms r
        WHERE r.id = p_room_id
          AND r.guide_id = auth.uid()
      )
    )
  LIMIT 1;
$$;


--
-- Name: get_kc_by_push_event("uuid", "uuid", "uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."get_kc_by_push_event"("p_room_id" "uuid", "p_push_id" "uuid", "p_kc_id" "uuid") RETURNS TABLE("push_event_id" "uuid", "room_id" "uuid", "kc_card_id" "uuid", "sequence" integer, "pushed_at" timestamp with time zone, "kc_id" "uuid", "title_cn" "text", "title_en" "text", "desc_cn" "text", "desc_en" "text", "image_url" "text", "category" "text", "era" "text", "location" "text", "status" "text", "deleted_at" timestamp with time zone)
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT
    cp.id         AS push_event_id,
    cp.room_id,
    cp.kc_card_id,
    cp.sequence,
    cp.pushed_at,
    kc.id         AS kc_id,
    kc.title_cn,
    kc.title_en,
    kc.desc_cn,
    kc.desc_en,
    kc.image_url,
    kc.category,
    kc.era,
    kc.location,
    kc.status,
    kc.deleted_at
  FROM public.card_pushes cp
  JOIN public.knowledge_cards kc ON kc.id = cp.kc_card_id
  WHERE cp.id        = p_push_id
    AND cp.room_id   = p_room_id
    AND cp.kc_card_id = p_kc_id
    AND (
      EXISTS (
        SELECT 1 FROM public.room_members rm
        WHERE rm.room_id = p_room_id
          AND rm.user_id = auth.uid()
          AND rm.left_at IS NULL
      )
      OR EXISTS (
        SELECT 1 FROM public.rooms r
        WHERE r.id = p_room_id AND r.guide_id = auth.uid()
      )
    )
  LIMIT 1;
$$;


--
-- Name: get_latest_pushed_kc_for_room("uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."get_latest_pushed_kc_for_room"("p_room_id" "uuid") RETURNS "public"."knowledge_cards"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT kc.*
  FROM public.knowledge_cards kc
  JOIN public.card_pushes cp ON cp.kc_card_id = kc.id
  WHERE cp.room_id = p_room_id
    -- 权限校验：导游或成员
    AND (
      EXISTS (
        SELECT 1 FROM public.rooms r
        WHERE r.id = p_room_id AND r.guide_id = auth.uid()
      )
      OR EXISTS (
        SELECT 1 FROM public.room_members rm
        WHERE rm.room_id = p_room_id
          AND rm.user_id = auth.uid()
          AND rm.left_at IS NULL
      )
    )
  ORDER BY cp.sequence DESC NULLS LAST, cp.pushed_at DESC
  LIMIT 1;
$$;


--
-- Name: get_my_joined_rooms_secure(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."get_my_joined_rooms_secure"() RETURNS "jsonb"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id',                  r.id,
        'room_number',         r.room_number,
        'name',                r.name,
        'cover_url',           r.cover_url,
        'guide_id',            r.guide_id,
        'status',              r.status,
        'discoverable',        r.discoverable,
        'estimated_duration',  r.estimated_duration,
        'actual_duration',     r.actual_duration,
        'online_count',        r.online_count,
        'started_at',          r.started_at,
        'ended_at',            r.ended_at,
        'created_at',          r.created_at,
        'guide',               jsonb_build_object(
          'id',         p.id,
          'username',   p.username,
          'nickname',   p.nickname,
          'avatar_url', p.avatar_url
        )
      )
      ORDER BY rm.joined_at DESC
    ),
    '[]'::JSONB
  )
  FROM public.room_members rm
  JOIN public.rooms r ON r.id = rm.room_id
  LEFT JOIN public.profiles p ON p.id = r.guide_id
  WHERE rm.user_id = auth.uid()
  LIMIT 30;
$$;


--
-- Name: get_my_profile_private(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."get_my_profile_private"() RETURNS TABLE("id" "uuid", "role" "text", "nickname" "text", "phone" "text", "gender" "text", "avatar_url" "text", "username" "text", "created_at" timestamp with time zone, "updated_at" timestamp with time zone)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
DECLARE
  v_uid uuid := auth.uid();
  v_auth_phone text;
  v_canonical_phone text;
BEGIN
  IF v_uid IS NULL THEN RETURN; END IF;

  -- 从 auth.users 取 canonical phone
  SELECT u.phone INTO v_auth_phone
  FROM auth.users u WHERE u.id = v_uid;

  -- 规范化为 11 位裸号
  v_canonical_phone := CASE
    WHEN v_auth_phone ~ '^86[1][3-9][0-9]{9}$'   THEN SUBSTR(v_auth_phone, 3)
    WHEN v_auth_phone ~ '^\+86[1][3-9][0-9]{9}$' THEN SUBSTR(v_auth_phone, 4)
    WHEN v_auth_phone ~ '^[1][3-9][0-9]{9}$'      THEN v_auth_phone
    ELSE NULL
  END;

  RETURN QUERY
  SELECT
    p.id,
    p.role::text,
    p.nickname,
    COALESCE(v_canonical_phone, p.phone) AS phone,
    p.gender,
    p.avatar_url,
    p.username,
    p.created_at,
    p.updated_at
  FROM public.profiles p
  WHERE p.id = v_uid;
END;
$_$;


--
-- Name: get_my_room_password("uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."get_my_room_password"("p_room_id" "uuid") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
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


--
-- Name: get_push_baseline_for_room("uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."get_push_baseline_for_room"("p_room_id" "uuid") RETURNS TABLE("push_id" "uuid", "sequence" integer, "pushed_at" timestamp with time zone, "kc_card_id" "uuid")
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT
    cp.id       AS push_id,
    cp.sequence,
    cp.pushed_at,
    cp.kc_card_id
  FROM public.card_pushes cp
  WHERE cp.room_id = p_room_id
    AND cp.kc_card_id IS NOT NULL
    AND (
      EXISTS (
        SELECT 1 FROM public.room_members rm
        WHERE rm.room_id = p_room_id
          AND rm.user_id = auth.uid()
          AND rm.left_at IS NULL
      )
      OR EXISTS (
        SELECT 1 FROM public.rooms r
        WHERE r.id = p_room_id AND r.guide_id = auth.uid()
      )
    )
  ORDER BY cp.sequence DESC NULLS LAST, cp.pushed_at DESC
  LIMIT 1;
$$;


--
-- Name: get_pushed_kc_for_room("uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."get_pushed_kc_for_room"("p_room_id" "uuid") RETURNS SETOF "public"."knowledge_cards"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT DISTINCT kc.*
  FROM public.knowledge_cards kc
  JOIN public.card_pushes cp ON cp.kc_card_id = kc.id
  WHERE cp.room_id = p_room_id
    AND (
      -- 调用者是该房间成员
      EXISTS (
        SELECT 1 FROM public.room_members rm
        WHERE rm.room_id = p_room_id
          AND rm.user_id = auth.uid()
          AND rm.left_at IS NULL
      )
      -- 或调用者是该房间导游
      OR EXISTS (
        SELECT 1 FROM public.rooms r
        WHERE r.id = p_room_id
          AND r.guide_id = auth.uid()
      )
    );
$$;


--
-- Name: get_room_by_id_secure("uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."get_room_by_id_secure"("p_room_id" "uuid") RETURNS "jsonb"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT jsonb_build_object(
    'id',                  r.id,
    'room_number',         r.room_number,
    'name',                r.name,
    'cover_url',           r.cover_url,
    'guide_id',            r.guide_id,
    'status',              r.status,
    'discoverable',        r.discoverable,
    'estimated_duration',  r.estimated_duration,
    'actual_duration',     r.actual_duration,
    'online_count',        r.online_count,
    'started_at',          r.started_at,
    'ended_at',            r.ended_at,
    'created_at',          r.created_at,
    'guide',               jsonb_build_object(
      'id',         p.id,
      'username',   p.username,
      'nickname',   p.nickname,
      'avatar_url', p.avatar_url
    )
  )
  FROM public.rooms r
  LEFT JOIN public.profiles p ON p.id = r.guide_id
  WHERE r.id = p_room_id
  LIMIT 1;
$$;


--
-- Name: get_room_by_number_secure("text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."get_room_by_number_secure"("p_room_number" "text") RETURNS "jsonb"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT jsonb_build_object(
    'id',                  r.id,
    'room_number',         r.room_number,
    'name',                r.name,
    'cover_url',           r.cover_url,
    'guide_id',            r.guide_id,
    'status',              r.status,
    'discoverable',        r.discoverable,
    'estimated_duration',  r.estimated_duration,
    'actual_duration',     r.actual_duration,
    'online_count',        r.online_count,
    'started_at',          r.started_at,
    'ended_at',            r.ended_at,
    'created_at',          r.created_at,
    'guide',               jsonb_build_object(
      'id',         p.id,
      'username',   p.username,
      'nickname',   p.nickname,
      'avatar_url', p.avatar_url
    )
  )
  FROM public.rooms r
  LEFT JOIN public.profiles p ON p.id = r.guide_id
  WHERE r.room_number = p_room_number
  LIMIT 1;
$$;


--
-- Name: get_room_member_history_safe("uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."get_room_member_history_safe"("p_room_id" "uuid") RETURNS TABLE("id" "uuid", "room_id" "uuid", "user_id" "uuid", "role" "text", "joined_at" timestamp with time zone, "left_at" timestamp with time zone, "profile_id" "uuid", "profile_username" "text", "profile_nickname" "text", "profile_avatar_url" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  -- 仅允许该房间的导游调用
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.rooms
    WHERE id = p_room_id AND guide_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'permission_denied';
  END IF;

  RETURN QUERY
  SELECT
    rm.id,
    rm.room_id,
    rm.user_id,
    rm.role::text,
    rm.joined_at,
    rm.left_at,
    p.id          AS profile_id,
    p.username    AS profile_username,
    p.nickname    AS profile_nickname,
    p.avatar_url  AS profile_avatar_url
  FROM public.room_members rm
  LEFT JOIN public.profiles p ON p.id = rm.user_id
  WHERE rm.room_id    = p_room_id
    AND rm.role::text = 'tourist'
  ORDER BY rm.joined_at ASC;
END;
$$;


--
-- Name: get_room_members_safe("uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."get_room_members_safe"("p_room_id" "uuid") RETURNS TABLE("id" "uuid", "room_id" "uuid", "user_id" "uuid", "role" "text", "joined_at" timestamp with time zone, "left_at" timestamp with time zone, "profile_id" "uuid", "profile_username" "text", "profile_nickname" "text", "profile_avatar_url" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public._is_room_participant(p_room_id) THEN
    RAISE EXCEPTION 'permission_denied';
  END IF;

  RETURN QUERY
  SELECT
    rm.id,
    rm.room_id,
    rm.user_id,
    rm.role::text,
    rm.joined_at,
    rm.left_at,
    p.id          AS profile_id,
    p.username    AS profile_username,
    p.nickname    AS profile_nickname,
    p.avatar_url  AS profile_avatar_url
  FROM public.room_members rm
  LEFT JOIN public.profiles p ON p.id = rm.user_id
  WHERE rm.room_id = p_room_id
    AND rm.left_at IS NULL
  ORDER BY rm.joined_at ASC
  LIMIT 200;
END;
$$;


--
-- Name: get_room_password_for_guide("uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."get_room_password_for_guide"("p_room_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_uid      uuid;
  v_guide_id uuid;
  v_password text;
BEGIN
  -- 1. 必须已登录
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_authenticated');
  END IF;

  -- 2. 查询房间归属（只读必要字段，不 SELECT *）
  SELECT guide_id, password
    INTO v_guide_id, v_password
    FROM public.rooms
   WHERE id = p_room_id
   LIMIT 1;

  -- 3. 房间不存在
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'room_not_found');
  END IF;

  -- 4. 必须是该房间的导游（非房主一律拒绝）
  IF v_guide_id IS DISTINCT FROM v_uid THEN
    RETURN jsonb_build_object('ok', false, 'code', 'forbidden');
  END IF;

  -- 5. 返回密码（不含任何其他字段，不含 pwd_hash）
  RETURN jsonb_build_object('ok', true, 'password', v_password);
END;
$$;


--
-- Name: get_room_photos("uuid", integer, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."get_room_photos"("p_room_id" "uuid", "p_limit" integer DEFAULT 50, "p_before" timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS TABLE("id" "uuid", "room_id" "uuid", "photographer_id" "uuid", "url" "text", "taken_at" timestamp with time zone, "uploaded_at" timestamp with time zone, "photographer_nickname" "text", "photographer_username" "text", "photographer_avatar" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_allowed bool := false;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  -- 导游或有效成员
  IF public._is_room_participant(p_room_id) THEN
    v_allowed := true;
  END IF;

  -- approved photographer（memberships）
  IF NOT v_allowed THEN
    SELECT EXISTS(
      SELECT 1 FROM public.memberships m
      WHERE m.room_id = p_room_id
        AND m.user_id = auth.uid()
        AND m.role = 'photographer'
        AND m.approval_status = 'approved'
        AND m.left_at IS NULL
    ) INTO v_allowed;
  END IF;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'permission_denied';
  END IF;

  RETURN QUERY
  SELECT
    ph.id,
    ph.room_id,
    ph.photographer_id,
    ph.url,
    ph.taken_at,
    ph.uploaded_at,
    p.nickname  AS photographer_nickname,
    p.username  AS photographer_username,
    p.avatar_url AS photographer_avatar
  FROM public.photos ph
  LEFT JOIN public.profiles p ON p.id = ph.photographer_id
  WHERE ph.room_id = p_room_id
    AND (p_before IS NULL OR ph.uploaded_at < p_before)
  ORDER BY ph.uploaded_at DESC
  LIMIT v_limit;
END;
$$;


--
-- Name: get_room_public_profiles("uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."get_room_public_profiles"("p_room_id" "uuid") RETURNS TABLE("id" "uuid", "username" "text", "nickname" "text", "avatar_url" "text", "member_role" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public._is_room_participant(p_room_id) THEN
    RAISE EXCEPTION 'permission_denied';
  END IF;

  RETURN QUERY
  -- 导游（来自 rooms）
  SELECT
    p.id,
    p.username,
    p.nickname,
    p.avatar_url,
    'guide'::text AS member_role
  FROM public.rooms r
  JOIN public.profiles p ON p.id = r.guide_id
  WHERE r.id = p_room_id

  UNION ALL

  -- 有效成员（left_at IS NULL）
  SELECT
    p.id,
    p.username,
    p.nickname,
    p.avatar_url,
    rm.role::text AS member_role
  FROM public.room_members rm
  JOIN public.profiles p ON p.id = rm.user_id
  WHERE rm.room_id = p_room_id
    AND rm.left_at IS NULL;
END;
$$;


--
-- Name: get_room_subtitles("uuid", integer, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."get_room_subtitles"("p_room_id" "uuid", "p_limit" integer DEFAULT 50, "p_before" timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS TABLE("id" "uuid", "room_id" "uuid", "sequence" integer, "content_cn" "text", "content_en" "text", "audio_url" "text", "chinese_audio_url" "text", "created_at" timestamp with time zone)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public._is_room_participant(p_room_id) THEN
    RAISE EXCEPTION 'permission_denied';
  END IF;

  RETURN QUERY
  SELECT
    s.id, s.room_id, s.sequence, s.content_cn, s.content_en,
    s.audio_url, s.chinese_audio_url, s.created_at
  FROM public.subtitles s
  WHERE s.room_id = p_room_id
    AND (p_before IS NULL OR s.created_at < p_before)
  -- 分页必须先取当前游标之前的最新一页；客户端再按时间升序展示。
  -- 旧版 ASC + LIMIT 会在字幕超过 p_limit 后始终返回最早的一页。
  ORDER BY
    s.created_at DESC,
    s.sequence DESC NULLS LAST
  LIMIT v_limit;
END;
$$;


--
-- Name: get_user_role("uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."get_user_role"("uid" "uuid") RETURNS "public"."user_role"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT role FROM public.profiles WHERE id = uid;
$$;


--
-- Name: handle_new_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  derived_username TEXT;
BEGIN
  IF NEW.email IS NOT NULL THEN
    derived_username := split_part(NEW.email, '@', 1);
  ELSIF NEW.phone IS NOT NULL THEN
    derived_username := 'u_' || right(NEW.phone, 6) || substr(md5(random()::text), 1, 4);
  ELSE
    derived_username := 'user_' || substr(md5(NEW.id::text), 1, 8);
  END IF;

  INSERT INTO public.profiles (id, username, role, phone)
  VALUES (
    NEW.id,
    derived_username,
    NULL,   -- 不预设角色，由前端引导用户在角色选择页完成
    NEW.phone
  );
  RETURN NEW;
END;
$$;


--
-- Name: has_joined_room_secure("uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."has_joined_room_secure"("p_room_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_uid    UUID;
  v_result BOOLEAN;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN RETURN FALSE; END IF;

  SELECT EXISTS(
    SELECT 1 FROM public.room_members
    WHERE room_id           = p_room_id
      AND user_id           = v_uid
      AND access_granted_at IS NOT NULL
      AND access_revoked_at IS NULL
  ) INTO v_result;

  RETURN v_result;
END;
$$;


--
-- Name: increment_online_count("uuid", integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."increment_online_count"("room_id" "uuid", "delta" integer) RETURNS "void"
    LANGUAGE "sql"
    AS $$
  UPDATE public.rooms
  SET online_count = GREATEST(0, online_count + delta)
  WHERE id = room_id;
$$;


--
-- Name: join_room_with_password("uuid", "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."join_room_with_password"("p_room_id" "uuid", "p_password" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_uid           UUID;
  v_room_status   public.room_status;
  v_hash          TEXT;
  v_rate_fail     INT;
  v_rate_locked   TIMESTAMPTZ;
  v_rate_found    BOOLEAN := FALSE;
  v_final_fail    INT;
  v_final_locked  TIMESTAMPTZ;
  v_remaining     INT;
  v_lock_secs     INT;
  v_authorized    BOOLEAN := FALSE;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_authenticated');
  END IF;

  SELECT status INTO v_room_status FROM public.rooms WHERE id = p_room_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'room_not_found');
  END IF;
  IF v_room_status NOT IN ('pending', 'live') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'room_not_active');
  END IF;

  -- 有效授权检查
  SELECT EXISTS(
    SELECT 1 FROM public.room_members
    WHERE room_id           = p_room_id
      AND user_id           = v_uid
      AND access_granted_at IS NOT NULL
      AND access_revoked_at IS NULL
  ) INTO v_authorized;

  IF v_authorized THEN
    UPDATE public.room_members
    SET left_at = NULL
    WHERE room_id = p_room_id AND user_id = v_uid;
    RETURN jsonb_build_object('ok', true, 'code', 'resumed');
  END IF;

  -- 串行化同一 uid+room_id 的写入
  PERFORM pg_advisory_xact_lock(
    hashtextextended(v_uid::text || ':' || p_room_id::text, 0)
  );

  -- 限流检查
  SELECT fail_count, locked_until INTO v_rate_fail, v_rate_locked
  FROM public.room_join_rate_limits
  WHERE user_id = v_uid AND room_id = p_room_id;
  IF FOUND THEN v_rate_found := TRUE; END IF;

  IF v_rate_found AND v_rate_locked IS NOT NULL AND v_rate_locked > NOW() THEN
    v_lock_secs := EXTRACT(EPOCH FROM (v_rate_locked - NOW()))::INT;
    RETURN jsonb_build_object(
      'ok', false, 'code', 'rate_limited',
      'retry_after_seconds', v_lock_secs, 'attempts_remaining', 0
    );
  END IF;

  -- 读取密码 hash
  SELECT pwd_hash INTO v_hash FROM public.room_secrets WHERE room_id = p_room_id;
  IF v_hash IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'room_not_found');
  END IF;

  -- bcrypt 对比
  IF extensions.crypt(p_password, v_hash) = v_hash THEN
    -- 密码正确：清限流 + upsert room_members + 写授权
    DELETE FROM public.room_join_rate_limits WHERE user_id = v_uid AND room_id = p_room_id;
    INSERT INTO public.room_members
      (room_id, user_id, role, joined_at, left_at, access_granted_at, access_revoked_at)
    VALUES
      (p_room_id, v_uid, 'tourist', NOW(), NULL, NOW(), NULL)
    ON CONFLICT (room_id, user_id) DO UPDATE
      SET left_at           = NULL,
          joined_at         = NOW(),
          role              = 'tourist',
          access_granted_at = NOW(),
          access_revoked_at = NULL;
    RETURN jsonb_build_object('ok', true, 'code', 'joined');
  ELSE
    -- 密码错误：只更新限流，不写 room_members / 授权
    -- ★ 锁定时长改为 15 秒 ★
    INSERT INTO public.room_join_rate_limits
      (user_id, room_id, fail_count, last_fail_at, locked_until)
    VALUES (v_uid, p_room_id, 1, NOW(), NULL)
    ON CONFLICT (user_id, room_id) DO UPDATE
      SET fail_count =
            CASE WHEN room_join_rate_limits.locked_until IS NOT NULL
                      AND room_join_rate_limits.locked_until <= NOW()
                 THEN 1
                 ELSE room_join_rate_limits.fail_count + 1
            END,
          last_fail_at = NOW(),
          locked_until =
            CASE WHEN room_join_rate_limits.locked_until IS NOT NULL
                      AND room_join_rate_limits.locked_until <= NOW()
                 THEN NULL
                 WHEN (CASE WHEN room_join_rate_limits.locked_until IS NOT NULL
                                 AND room_join_rate_limits.locked_until <= NOW()
                            THEN 1
                            ELSE room_join_rate_limits.fail_count + 1
                       END) >= 5
                 THEN NOW() + INTERVAL '15 seconds'   -- ★ 15s ★
                 ELSE NULL
            END
    RETURNING fail_count, locked_until INTO v_final_fail, v_final_locked;

    IF v_final_fail IS NULL THEN v_final_fail := 1; v_final_locked := NULL; END IF;
    v_remaining := GREATEST(0, 5 - v_final_fail);

    IF v_final_locked IS NOT NULL AND v_final_locked > NOW() THEN
      RETURN jsonb_build_object(
        'ok', false, 'code', 'rate_limited',
        'retry_after_seconds', 15, 'attempts_remaining', 0  -- ★ 15s ★
      );
    ELSE
      RETURN jsonb_build_object(
        'ok', false, 'code', 'wrong_password', 'attempts_remaining', v_remaining
      );
    END IF;
  END IF;
END;
$$;


--
-- Name: list_audio_files_by_owner("uuid"[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."list_audio_files_by_owner"("p_owner_ids" "uuid"[]) RETURNS TABLE("name" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    AS $$
  SELECT o.name
  FROM storage.objects o
  WHERE o.bucket_id = 'audio'
    AND o.owner = ANY(p_owner_ids);
$$;


--
-- Name: prevent_is_admin_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."prevent_is_admin_change"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_jwt_role text;
BEGIN
  IF NEW.is_admin IS DISTINCT FROM OLD.is_admin THEN
    -- 读取 PostgREST 注入的 JWT role claim（仅 HTTP 请求存在）
    v_jwt_role := current_setting('request.jwt.claim.role', true);

    -- 如果是 authenticated 或 anon（即浏览器/客户端 JWT 请求），拒绝
    IF v_jwt_role IN ('authenticated', 'anon') THEN
      RAISE EXCEPTION 'permission denied: is_admin can only be changed by service_role';
    END IF;
    -- service_role 直连、postgres 直连、迁移上下文：v_jwt_role 为空，允许通过
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: FUNCTION "prevent_is_admin_change"(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION "public"."prevent_is_admin_change"() IS 'v2: 用 request.jwt.claim.role 检测浏览器JWT请求，拒绝 authenticated/anon 修改 is_admin；service_role/postgres 直连不受限';


--
-- Name: rooms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."rooms" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "room_number" "text" NOT NULL,
    "password" "text" NOT NULL,
    "name" "text" NOT NULL,
    "cover_url" "text",
    "guide_id" "uuid" NOT NULL,
    "status" "public"."room_status" DEFAULT 'pending'::"public"."room_status" NOT NULL,
    "estimated_duration" integer,
    "actual_duration" integer,
    "online_count" integer DEFAULT 0 NOT NULL,
    "started_at" timestamp with time zone,
    "ended_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "discoverable" boolean DEFAULT true NOT NULL
);


--
-- Name: restore_current_room_for_user("uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."restore_current_room_for_user"("p_user_id" "uuid") RETURNS "public"."rooms"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT r.*
  FROM public.rooms r
  JOIN public.room_members rm ON rm.room_id = r.id
  WHERE rm.user_id = p_user_id
    AND rm.user_id = auth.uid()       -- 只能查自己
    AND rm.left_at IS NULL
  ORDER BY
    -- 优先 pending/live（CASE 值越小越优先）
    CASE r.status
      WHEN 'live'    THEN 1
      WHEN 'pending' THEN 2
      ELSE               3            -- ended 及其他
    END ASC,
    rm.joined_at DESC
  LIMIT 1;
$$;


--
-- Name: restore_current_room_secure(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."restore_current_room_secure"() RETURNS "jsonb"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT jsonb_build_object(
    'id',                  r.id,
    'room_number',         r.room_number,
    'name',                r.name,
    'cover_url',           r.cover_url,
    'guide_id',            r.guide_id,
    'status',              r.status,
    'discoverable',        r.discoverable,
    'estimated_duration',  r.estimated_duration,
    'actual_duration',     r.actual_duration,
    'online_count',        r.online_count,
    'started_at',          r.started_at,
    'ended_at',            r.ended_at,
    'created_at',          r.created_at,
    'guide',               jsonb_build_object(
      'id',         p.id,
      'username',   p.username,
      'nickname',   p.nickname,
      'avatar_url', p.avatar_url
    )
  )
  FROM public.rooms r
  JOIN public.room_members rm ON rm.room_id = r.id
  LEFT JOIN public.profiles p ON p.id = r.guide_id
  WHERE rm.user_id           = auth.uid()
    AND rm.access_granted_at IS NOT NULL      -- 有效授权
    AND rm.access_revoked_at IS NULL          -- 未被撤销
    AND rm.left_at           IS NULL          -- 当前在线
    AND r.status             IN ('pending', 'live')   -- 仅恢复实时房间
  ORDER BY
    CASE r.status WHEN 'live' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END ASC,
    rm.joined_at DESC
  LIMIT 1;
$$;


--
-- Name: resume_room_membership("uuid"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."resume_room_membership"("p_room_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_uid        UUID;
  v_authorized BOOLEAN;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_authenticated');
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM public.room_members
    WHERE room_id           = p_room_id
      AND user_id           = v_uid
      AND access_granted_at IS NOT NULL
      AND access_revoked_at IS NULL
  ) INTO v_authorized;

  IF NOT v_authorized THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_authorized');
  END IF;

  UPDATE public.room_members
  SET left_at = NULL
  WHERE room_id = p_room_id AND user_id = v_uid;

  RETURN jsonb_build_object('ok', true, 'code', 'resumed');
END;
$$;


--
-- Name: set_card_push_sequence(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."set_card_push_sequence"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  -- 以 room_id 为键获取事务级 advisory lock
  -- hashtextextended(text, seed) 将 uuid 映射到 bigint，不同 room 得到不同 key
  -- pg_advisory_xact_lock 是事务级（事务提交/回滚后自动释放），同 room 并发 INSERT 串行等待
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.room_id::text, 0));

  -- 加锁后安全读取该 room 当前最大 sequence，+1 覆盖客户端值
  SELECT COALESCE(MAX(sequence), 0) + 1
    INTO NEW.sequence
    FROM public.card_pushes
   WHERE room_id = NEW.room_id;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."prevent_duplicate_kc_push"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF NEW.kc_card_id IS NULL THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.room_id::text || ':' || NEW.kc_card_id::text, 0)
  );
  IF EXISTS (
    SELECT 1 FROM public.card_pushes
    WHERE room_id = NEW.room_id AND kc_card_id = NEW.kc_card_id
  ) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: set_my_role("public"."user_role"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."set_my_role"("new_role" "public"."user_role") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_current_role public.user_role;
BEGIN
  -- 1. 必须已登录
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  -- 2. 白名单：只允许 guide / tourist / photographer
  IF new_role NOT IN ('guide', 'tourist', 'photographer') THEN
    RAISE EXCEPTION 'invalid_role: 仅允许设置 guide、tourist 或 photographer 角色';
  END IF;

  -- 3. 读取当前角色
  SELECT role INTO v_current_role
  FROM public.profiles
  WHERE id = auth.uid();

  -- 4. 核心守护：role 已有值则拒绝修改（身份固定，不允许自助切换）
  IF v_current_role IS NOT NULL THEN
    RAISE EXCEPTION 'role_already_set: 账号身份已固定，不允许修改。如需更换身份请联系管理员申请审核。';
  END IF;

  -- 5. 仅首次注册（role IS NULL）时允许写入
  UPDATE public.profiles
  SET role = new_role, updated_at = now()
  WHERE id = auth.uid();
END;
$$;


--
-- Name: switch_my_role("text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."switch_my_role"("p_role" "text") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_uid  uuid := auth.uid();
  v_role public.user_role;
BEGIN
  -- 1. 拒绝匿名调用
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'switch_my_role: 未登录，拒绝切换';
  END IF;

  -- 2. 白名单校验（强转失败会自动抛 invalid_text_representation 异常）
  IF p_role NOT IN ('tourist', 'guide', 'photographer') THEN
    RAISE EXCEPTION 'switch_my_role: 非法身份值 %', p_role;
  END IF;
  v_role := p_role::public.user_role;

  -- 3. profile 必须存在
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_uid) THEN
    RAISE EXCEPTION 'switch_my_role: profile 不存在，请先完成注册';
  END IF;

  -- 4. 仅更新当前用户的 role
  UPDATE public.profiles
  SET role = v_role, updated_at = now()
  WHERE id = v_uid;

  RETURN v_role::text;
END;
$$;


--
-- Name: verify_room_password_only("uuid", "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION "public"."verify_room_password_only"("p_room_id" "uuid", "p_password" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_uid          UUID;
  v_room_status  public.room_status;
  v_hash         TEXT;
  v_rate_fail    INT;
  v_rate_locked  TIMESTAMPTZ;
  v_rate_found   BOOLEAN := FALSE;
  v_final_fail   INT;
  v_final_locked TIMESTAMPTZ;
  v_remaining    INT;
  v_lock_secs    INT;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_authenticated');
  END IF;

  SELECT status INTO v_room_status FROM public.rooms WHERE id = p_room_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'room_not_found');
  END IF;
  IF v_room_status NOT IN ('pending', 'live') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'room_not_active');
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(v_uid::text || ':' || p_room_id::text, 0)
  );

  SELECT fail_count, locked_until INTO v_rate_fail, v_rate_locked
  FROM public.room_join_rate_limits
  WHERE user_id = v_uid AND room_id = p_room_id;
  IF FOUND THEN v_rate_found := TRUE; END IF;

  IF v_rate_found AND v_rate_locked IS NOT NULL AND v_rate_locked > NOW() THEN
    v_lock_secs := EXTRACT(EPOCH FROM (v_rate_locked - NOW()))::INT;
    RETURN jsonb_build_object(
      'ok', false, 'code', 'rate_limited',
      'retry_after_seconds', v_lock_secs, 'attempts_remaining', 0
    );
  END IF;

  SELECT pwd_hash INTO v_hash FROM public.room_secrets WHERE room_id = p_room_id;
  IF v_hash IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'room_not_found');
  END IF;

  IF extensions.crypt(p_password, v_hash) = v_hash THEN
    DELETE FROM public.room_join_rate_limits WHERE user_id = v_uid AND room_id = p_room_id;
    RETURN jsonb_build_object('ok', true, 'code', 'verified');
  ELSE
    INSERT INTO public.room_join_rate_limits
      (user_id, room_id, fail_count, last_fail_at, locked_until)
    VALUES (v_uid, p_room_id, 1, NOW(), NULL)
    ON CONFLICT (user_id, room_id) DO UPDATE
      SET fail_count =
            CASE WHEN room_join_rate_limits.locked_until IS NOT NULL
                      AND room_join_rate_limits.locked_until <= NOW()
                 THEN 1
                 ELSE room_join_rate_limits.fail_count + 1
            END,
          last_fail_at = NOW(),
          locked_until =
            CASE WHEN room_join_rate_limits.locked_until IS NOT NULL
                      AND room_join_rate_limits.locked_until <= NOW()
                 THEN NULL
                 WHEN (CASE WHEN room_join_rate_limits.locked_until IS NOT NULL
                                 AND room_join_rate_limits.locked_until <= NOW()
                            THEN 1
                            ELSE room_join_rate_limits.fail_count + 1
                       END) >= 5
                 THEN NOW() + INTERVAL '60 seconds'
                 ELSE NULL
            END
    RETURNING fail_count, locked_until INTO v_final_fail, v_final_locked;

    IF v_final_fail IS NULL THEN v_final_fail := 1; v_final_locked := NULL; END IF;
    v_remaining := GREATEST(0, 5 - v_final_fail);

    IF v_final_locked IS NOT NULL AND v_final_locked > NOW() THEN
      RETURN jsonb_build_object(
        'ok', false, 'code', 'rate_limited',
        'retry_after_seconds', 60, 'attempts_remaining', 0
      );
    ELSE
      RETURN jsonb_build_object(
        'ok', false, 'code', 'wrong_password', 'attempts_remaining', v_remaining
      );
    END IF;
  END IF;
END;
$$;


--
-- Name: asr_diagnostics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."asr_diagnostics" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "request_id" "text" NOT NULL,
    "sequence" integer,
    "capture_mode" "text",
    "platform" "text",
    "mime_type" "text",
    "blob_bytes" integer,
    "record_ms" integer,
    "decoded_duration_s" double precision,
    "source_sample_rate" integer,
    "source_channels" integer,
    "resample_out_samples" integer,
    "wav_bytes" integer,
    "convert_ms" integer,
    "rms" double precision,
    "peak" double precision,
    "noise_floor" double precision,
    "snr" double precision,
    "voiced_ratio" double precision,
    "voiced_ms" integer,
    "skip_reason" "text",
    "queue_wait_ms" integer,
    "asr_ms" integer,
    "asr_success" boolean,
    "baidu_err_no" integer,
    "baidu_err_msg" "text",
    "baidu_sn" "text",
    "has_text" boolean,
    "translate_ms" integer,
    "translate_status" "text"
);


--
-- Name: TABLE "asr_diagnostics"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."asr_diagnostics" IS '语音识别分片诊断——仅测试用，建议每72小时清理一次；禁止保存音频/字幕正文/密钥';


--
-- Name: asr_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."asr_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "ticket_id" "uuid" NOT NULL,
    "room_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "closed_at" timestamp with time zone
);


--
-- Name: asr_tickets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."asr_tickets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "room_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone DEFAULT ("now"() + '00:01:00'::interval) NOT NULL,
    "used_at" timestamp with time zone,
    "ticket_value" "text" DEFAULT ''::"text" NOT NULL
);


--
-- Name: card_pushes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."card_pushes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "room_id" "uuid" NOT NULL,
    "card_id" "uuid",
    "pushed_by" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "pushed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "room_card_id" "uuid",
    "kc_card_id" "uuid",
    "sequence" integer
);


--
-- Name: cards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."cards" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "title_cn" "text" NOT NULL,
    "title_en" "text",
    "content_cn" "text" NOT NULL,
    "content_en" "text",
    "category" "text" DEFAULT '建筑'::"text" NOT NULL,
    "tags" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "image_url" "text",
    "created_by" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: favorites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."favorites" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "target_type" "text" NOT NULL,
    "target_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "favorites_target_type_check" CHECK (("target_type" = ANY (ARRAY['subtitle'::"text", 'photo'::"text"])))
);


--
-- Name: feedbacks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."feedbacks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "role" "text" DEFAULT ''::"text" NOT NULL,
    "category" "text" DEFAULT ''::"text" NOT NULL,
    "content" "text" NOT NULL,
    "contact" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."memberships" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "room_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role" "text" DEFAULT 'tourist'::"text" NOT NULL,
    "approval_status" "text" DEFAULT 'approved'::"text" NOT NULL,
    "rejection_reason" "text",
    "joined_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "left_at" timestamp with time zone
);


--
-- Name: photos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."photos" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "room_id" "uuid" NOT NULL,
    "photographer_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "url" "text" NOT NULL,
    "taken_at" timestamp with time zone,
    "uploaded_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "username" "text" NOT NULL,
    "nickname" "text",
    "avatar_url" "text",
    "phone" "text",
    "role" "public"."user_role" DEFAULT 'tourist'::"public"."user_role",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "wechat_openid" "text",
    "wechat_pwd" "text",
    "gender" "text" DEFAULT 'male'::"text",
    "is_admin" boolean DEFAULT false NOT NULL,
    CONSTRAINT "profiles_gender_check" CHECK (("gender" = ANY (ARRAY['male'::"text", 'female'::"text"])))
);


--
-- Name: questions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."questions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "room_id" "uuid" NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "content" "text" NOT NULL,
    "is_answered" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "original_language" "text",
    "translated_text" "text"
);


--
-- Name: room_barrages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."room_barrages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "room_id" "uuid" NOT NULL,
    "user_id" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "content" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "room_barrages_content_check" CHECK ((("char_length"("content") >= 1) AND ("char_length"("content") <= 30)))
);


--
-- Name: room_cards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."room_cards" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "room_id" "uuid" NOT NULL,
    "source_card_id" "uuid" NOT NULL,
    "imported_by" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "imported_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: room_join_rate_limits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."room_join_rate_limits" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "room_id" "uuid" NOT NULL,
    "fail_count" integer DEFAULT 0 NOT NULL,
    "locked_until" timestamp with time zone,
    "last_fail_at" timestamp with time zone
);


--
-- Name: room_join_rate_limits_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE IF NOT EXISTS "public"."room_join_rate_limits_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: room_join_rate_limits_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE "public"."room_join_rate_limits_id_seq" OWNED BY "public"."room_join_rate_limits"."id";


--
-- Name: room_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."room_members" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "room_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role" "public"."user_role" NOT NULL,
    "joined_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "left_at" timestamp with time zone,
    "access_granted_at" timestamp with time zone,
    "access_revoked_at" timestamp with time zone
);


--
-- Name: room_secrets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."room_secrets" (
    "room_id" "uuid" NOT NULL,
    "pwd_hash" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: subtitles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."subtitles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "room_id" "uuid" NOT NULL,
    "content_cn" "text" NOT NULL,
    "content_en" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "audio_url" "text" DEFAULT ''::"text" NOT NULL,
    "chinese_audio_url" "text" DEFAULT ''::"text" NOT NULL,
    "sequence" integer
);


--
-- Name: wechat_identities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS "public"."wechat_identities" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "openid" "text" NOT NULL,
    "appid" "text" DEFAULT ''::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);

ALTER TABLE ONLY "public"."wechat_identities" FORCE ROW LEVEL SECURITY;


--
-- Name: room_join_rate_limits id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."room_join_rate_limits" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."room_join_rate_limits_id_seq"'::"regclass");


--
-- Name: asr_diagnostics asr_diagnostics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'asr_diagnostics_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'asr_diagnostics'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."asr_diagnostics"
    ADD CONSTRAINT "asr_diagnostics_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: asr_sessions asr_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'asr_sessions_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'asr_sessions'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."asr_sessions"
    ADD CONSTRAINT "asr_sessions_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: asr_tickets asr_tickets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'asr_tickets_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'asr_tickets'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."asr_tickets"
    ADD CONSTRAINT "asr_tickets_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: card_pushes card_pushes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'card_pushes_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'card_pushes'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."card_pushes"
    ADD CONSTRAINT "card_pushes_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: cards cards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'cards_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'cards'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."cards"
    ADD CONSTRAINT "cards_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: favorites favorites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'favorites_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'favorites'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."favorites"
    ADD CONSTRAINT "favorites_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: favorites favorites_user_id_target_type_target_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'favorites_user_id_target_type_target_id_key'
      AND n.nspname = 'public'
      AND c.relname = 'favorites'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."favorites"
    ADD CONSTRAINT "favorites_user_id_target_type_target_id_key" UNIQUE ("user_id", "target_type", "target_id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: feedbacks feedbacks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'feedbacks_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'feedbacks'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."feedbacks"
    ADD CONSTRAINT "feedbacks_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: knowledge_cards knowledge_cards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'knowledge_cards_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'knowledge_cards'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."knowledge_cards"
    ADD CONSTRAINT "knowledge_cards_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: memberships memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'memberships_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'memberships'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."memberships"
    ADD CONSTRAINT "memberships_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: memberships memberships_room_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'memberships_room_id_user_id_key'
      AND n.nspname = 'public'
      AND c.relname = 'memberships'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."memberships"
    ADD CONSTRAINT "memberships_room_id_user_id_key" UNIQUE ("room_id", "user_id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: photos photos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'photos_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'photos'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."photos"
    ADD CONSTRAINT "photos_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'profiles_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'profiles'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: profiles profiles_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'profiles_username_key'
      AND n.nspname = 'public'
      AND c.relname = 'profiles'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_username_key" UNIQUE ("username");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: profiles profiles_wechat_openid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'profiles_wechat_openid_key'
      AND n.nspname = 'public'
      AND c.relname = 'profiles'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_wechat_openid_key" UNIQUE ("wechat_openid");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: questions questions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'questions_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'questions'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."questions"
    ADD CONSTRAINT "questions_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: room_barrages room_barrages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'room_barrages_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'room_barrages'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."room_barrages"
    ADD CONSTRAINT "room_barrages_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: room_cards room_cards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'room_cards_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'room_cards'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."room_cards"
    ADD CONSTRAINT "room_cards_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: room_cards room_cards_room_id_source_card_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'room_cards_room_id_source_card_id_key'
      AND n.nspname = 'public'
      AND c.relname = 'room_cards'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."room_cards"
    ADD CONSTRAINT "room_cards_room_id_source_card_id_key" UNIQUE ("room_id", "source_card_id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: room_join_rate_limits room_join_rate_limits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'room_join_rate_limits_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'room_join_rate_limits'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."room_join_rate_limits"
    ADD CONSTRAINT "room_join_rate_limits_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: room_join_rate_limits room_join_rate_limits_user_id_room_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'room_join_rate_limits_user_id_room_id_key'
      AND n.nspname = 'public'
      AND c.relname = 'room_join_rate_limits'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."room_join_rate_limits"
    ADD CONSTRAINT "room_join_rate_limits_user_id_room_id_key" UNIQUE ("user_id", "room_id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: room_members room_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'room_members_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'room_members'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."room_members"
    ADD CONSTRAINT "room_members_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: room_members room_members_room_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'room_members_room_id_user_id_key'
      AND n.nspname = 'public'
      AND c.relname = 'room_members'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."room_members"
    ADD CONSTRAINT "room_members_room_id_user_id_key" UNIQUE ("room_id", "user_id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: room_secrets room_secrets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'room_secrets_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'room_secrets'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."room_secrets"
    ADD CONSTRAINT "room_secrets_pkey" PRIMARY KEY ("room_id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: rooms rooms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'rooms_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'rooms'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."rooms"
    ADD CONSTRAINT "rooms_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: rooms rooms_room_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'rooms_room_number_key'
      AND n.nspname = 'public'
      AND c.relname = 'rooms'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."rooms"
    ADD CONSTRAINT "rooms_room_number_key" UNIQUE ("room_number");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: subtitles subtitles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'subtitles_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'subtitles'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."subtitles"
    ADD CONSTRAINT "subtitles_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: wechat_identities wechat_identities_openid_appid_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'wechat_identities_openid_appid_unique'
      AND n.nspname = 'public'
      AND c.relname = 'wechat_identities'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."wechat_identities"
    ADD CONSTRAINT "wechat_identities_openid_appid_unique" UNIQUE ("openid", "appid");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: wechat_identities wechat_identities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'wechat_identities_pkey'
      AND n.nspname = 'public'
      AND c.relname = 'wechat_identities'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."wechat_identities"
    ADD CONSTRAINT "wechat_identities_pkey" PRIMARY KEY ("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: wechat_identities wechat_identities_user_appid_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'wechat_identities_user_appid_unique'
      AND n.nspname = 'public'
      AND c.relname = 'wechat_identities'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."wechat_identities"
    ADD CONSTRAINT "wechat_identities_user_appid_unique" UNIQUE ("user_id", "appid");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: asr_sessions_room_user_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "asr_sessions_room_user_active" ON "public"."asr_sessions" USING "btree" ("room_id", "user_id") WHERE ("closed_at" IS NULL);


--
-- Name: asr_sessions_unique_active_lease; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS "asr_sessions_unique_active_lease" ON "public"."asr_sessions" USING "btree" ("room_id", "user_id") WHERE ("closed_at" IS NULL);


--
-- Name: asr_tickets_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "asr_tickets_expires_at" ON "public"."asr_tickets" USING "btree" ("expires_at");


--
-- Name: asr_tickets_ticket_value_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS "asr_tickets_ticket_value_unique" ON "public"."asr_tickets" USING "btree" ("ticket_value");


--
-- Name: idx_barrages_room_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "idx_barrages_room_time" ON "public"."room_barrages" USING "btree" ("room_id", "created_at" DESC);


--
-- Name: idx_card_pushes_room_kc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "idx_card_pushes_room_kc" ON "public"."card_pushes" USING "btree" ("room_id", "kc_card_id", "pushed_at" DESC);


--
-- Name: idx_subtitles_room_seq; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS "idx_subtitles_room_seq" ON "public"."subtitles" USING "btree" ("room_id", "sequence");


--
-- Name: profiles_phone_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS "profiles_phone_unique_idx" ON "public"."profiles" USING "btree" ("phone") WHERE ("phone" IS NOT NULL);


--
-- Name: rooms_one_active_per_guide_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS "rooms_one_active_per_guide_idx" ON "public"."rooms" USING "btree" ("guide_id") WHERE ("status" = ANY (ARRAY['pending'::"public"."room_status", 'live'::"public"."room_status"]));


--
-- Name: card_pushes trg_card_push_sequence; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER "trg_card_push_sequence" BEFORE INSERT ON "public"."card_pushes" FOR EACH ROW EXECUTE FUNCTION "public"."set_card_push_sequence"();
CREATE OR REPLACE TRIGGER "trg_card_push_dedupe" BEFORE INSERT ON "public"."card_pushes" FOR EACH ROW EXECUTE FUNCTION "public"."prevent_duplicate_kc_push"();


--
-- Name: profiles trg_prevent_is_admin_change; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER "trg_prevent_is_admin_change" BEFORE UPDATE OF "is_admin" ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."prevent_is_admin_change"();


--
-- Name: rooms trg_sync_room_password_hash; Type: TRIGGER; Schema: public; Owner: -
--

CREATE OR REPLACE TRIGGER "trg_sync_room_password_hash" AFTER INSERT OR UPDATE OF "password" ON "public"."rooms" FOR EACH ROW EXECUTE FUNCTION "public"."_sync_room_password_hash"();


--
-- Name: asr_sessions asr_sessions_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'asr_sessions_ticket_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'asr_sessions'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."asr_sessions"
    ADD CONSTRAINT "asr_sessions_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "public"."asr_tickets"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: asr_sessions asr_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'asr_sessions_user_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'asr_sessions'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."asr_sessions"
    ADD CONSTRAINT "asr_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: asr_tickets asr_tickets_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'asr_tickets_user_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'asr_tickets'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."asr_tickets"
    ADD CONSTRAINT "asr_tickets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: card_pushes card_pushes_card_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'card_pushes_card_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'card_pushes'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."card_pushes"
    ADD CONSTRAINT "card_pushes_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: card_pushes card_pushes_kc_card_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'card_pushes_kc_card_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'card_pushes'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."card_pushes"
    ADD CONSTRAINT "card_pushes_kc_card_id_fkey" FOREIGN KEY ("kc_card_id") REFERENCES "public"."knowledge_cards"("id") ON DELETE SET NULL;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: card_pushes card_pushes_pushed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'card_pushes_pushed_by_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'card_pushes'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."card_pushes"
    ADD CONSTRAINT "card_pushes_pushed_by_fkey" FOREIGN KEY ("pushed_by") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: card_pushes card_pushes_room_card_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'card_pushes_room_card_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'card_pushes'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."card_pushes"
    ADD CONSTRAINT "card_pushes_room_card_id_fkey" FOREIGN KEY ("room_card_id") REFERENCES "public"."room_cards"("id") ON DELETE SET NULL;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: card_pushes card_pushes_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'card_pushes_room_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'card_pushes'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."card_pushes"
    ADD CONSTRAINT "card_pushes_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: cards cards_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'cards_created_by_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'cards'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."cards"
    ADD CONSTRAINT "cards_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: favorites favorites_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'favorites_user_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'favorites'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."favorites"
    ADD CONSTRAINT "favorites_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: feedbacks feedbacks_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'feedbacks_user_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'feedbacks'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."feedbacks"
    ADD CONSTRAINT "feedbacks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: room_cards fk_room_cards_source_card; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'fk_room_cards_source_card'
      AND n.nspname = 'public'
      AND c.relname = 'room_cards'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."room_cards"
    ADD CONSTRAINT "fk_room_cards_source_card" FOREIGN KEY ("source_card_id") REFERENCES "public"."knowledge_cards"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: knowledge_cards knowledge_cards_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'knowledge_cards_created_by_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'knowledge_cards'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."knowledge_cards"
    ADD CONSTRAINT "knowledge_cards_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: memberships memberships_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'memberships_room_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'memberships'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."memberships"
    ADD CONSTRAINT "memberships_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: memberships memberships_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'memberships_user_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'memberships'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."memberships"
    ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: photos photos_photographer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'photos_photographer_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'photos'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."photos"
    ADD CONSTRAINT "photos_photographer_id_fkey" FOREIGN KEY ("photographer_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: photos photos_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'photos_room_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'photos'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."photos"
    ADD CONSTRAINT "photos_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: profiles profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'profiles_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'profiles'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: questions questions_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'questions_room_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'questions'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."questions"
    ADD CONSTRAINT "questions_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: questions questions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'questions_user_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'questions'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."questions"
    ADD CONSTRAINT "questions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: room_barrages room_barrages_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'room_barrages_room_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'room_barrages'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."room_barrages"
    ADD CONSTRAINT "room_barrages_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: room_barrages room_barrages_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'room_barrages_user_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'room_barrages'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."room_barrages"
    ADD CONSTRAINT "room_barrages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: room_cards room_cards_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'room_cards_room_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'room_cards'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."room_cards"
    ADD CONSTRAINT "room_cards_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: room_members room_members_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'room_members_room_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'room_members'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."room_members"
    ADD CONSTRAINT "room_members_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: room_members room_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'room_members_user_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'room_members'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."room_members"
    ADD CONSTRAINT "room_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: room_secrets room_secrets_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'room_secrets_room_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'room_secrets'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."room_secrets"
    ADD CONSTRAINT "room_secrets_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: rooms rooms_guide_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'rooms_guide_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'rooms'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."rooms"
    ADD CONSTRAINT "rooms_guide_id_fkey" FOREIGN KEY ("guide_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: subtitles subtitles_room_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'subtitles_room_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'subtitles'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."subtitles"
    ADD CONSTRAINT "subtitles_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: wechat_identities wechat_identities_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.conname = 'wechat_identities_user_id_fkey'
      AND n.nspname = 'public'
      AND c.relname = 'wechat_identities'
  ) THEN
    EXECUTE $pg_schema_sql$
ALTER TABLE ONLY "public"."wechat_identities"
    ADD CONSTRAINT "wechat_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: asr_diagnostics asr_diag_admin_select; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'asr_diag_admin_select'
      AND n.nspname = 'public'
      AND c.relname = 'asr_diagnostics'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "asr_diag_admin_select" ON "public"."asr_diagnostics" FOR SELECT TO "authenticated" USING (("public"."get_is_admin"("auth"."uid"()) = true));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: asr_diagnostics asr_diag_service_insert; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'asr_diag_service_insert'
      AND n.nspname = 'public'
      AND c.relname = 'asr_diagnostics'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "asr_diag_service_insert" ON "public"."asr_diagnostics" FOR INSERT TO "service_role" WITH CHECK (true);
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: asr_diagnostics asr_diag_service_update; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'asr_diag_service_update'
      AND n.nspname = 'public'
      AND c.relname = 'asr_diagnostics'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "asr_diag_service_update" ON "public"."asr_diagnostics" FOR UPDATE TO "service_role" USING (true) WITH CHECK (true);
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: asr_diagnostics; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."asr_diagnostics" ENABLE ROW LEVEL SECURITY;

--
-- Name: asr_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."asr_sessions" ENABLE ROW LEVEL SECURITY;

--
-- Name: asr_sessions asr_sessions_owner_select; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'asr_sessions_owner_select'
      AND n.nspname = 'public'
      AND c.relname = 'asr_sessions'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "asr_sessions_owner_select" ON "public"."asr_sessions" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: asr_sessions asr_sessions_service_all; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'asr_sessions_service_all'
      AND n.nspname = 'public'
      AND c.relname = 'asr_sessions'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "asr_sessions_service_all" ON "public"."asr_sessions" TO "service_role" USING (true) WITH CHECK (true);
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: asr_tickets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."asr_tickets" ENABLE ROW LEVEL SECURITY;

--
-- Name: asr_tickets asr_tickets_owner_select; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'asr_tickets_owner_select'
      AND n.nspname = 'public'
      AND c.relname = 'asr_tickets'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "asr_tickets_owner_select" ON "public"."asr_tickets" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: asr_tickets asr_tickets_service_all; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'asr_tickets_service_all'
      AND n.nspname = 'public'
      AND c.relname = 'asr_tickets'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "asr_tickets_service_all" ON "public"."asr_tickets" TO "service_role" USING (true) WITH CHECK (true);
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: room_barrages barrages: live 成员可发送; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'barrages: live 成员可发送'
      AND n.nspname = 'public'
      AND c.relname = 'room_barrages'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "barrages: live 成员可发送" ON "public"."room_barrages" FOR INSERT TO "authenticated" WITH CHECK ((("user_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."rooms" "r"
  WHERE (("r"."id" = "room_barrages"."room_id") AND ("r"."status" = 'live'::"public"."room_status")))) AND (EXISTS ( SELECT 1
   FROM "public"."room_members" "rm"
  WHERE (("rm"."room_id" = "room_barrages"."room_id") AND ("rm"."user_id" = "auth"."uid"()) AND ("rm"."left_at" IS NULL))))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: room_barrages barrages: 成员和导游可查看; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'barrages: 成员和导游可查看'
      AND n.nspname = 'public'
      AND c.relname = 'room_barrages'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "barrages: 成员和导游可查看" ON "public"."room_barrages" FOR SELECT TO "authenticated" USING ((("user_id" = "auth"."uid"()) OR ("room_id" IN ( SELECT "rooms"."id"
   FROM "public"."rooms"
  WHERE ("rooms"."guide_id" = "auth"."uid"()))) OR (EXISTS ( SELECT 1
   FROM "public"."room_members" "rm"
  WHERE (("rm"."room_id" = "room_barrages"."room_id") AND ("rm"."user_id" = "auth"."uid"()) AND ("rm"."left_at" IS NULL))))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: card_pushes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."card_pushes" ENABLE ROW LEVEL SECURITY;

--
-- Name: cards; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."cards" ENABLE ROW LEVEL SECURITY;

--
-- Name: cards cards: 任何已登录可查看; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'cards: 任何已登录可查看'
      AND n.nspname = 'public'
      AND c.relname = 'cards'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "cards: 任何已登录可查看" ON "public"."cards" FOR SELECT TO "authenticated" USING (true);
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: cards cards: 导游可创建; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'cards: 导游可创建'
      AND n.nspname = 'public'
      AND c.relname = 'cards'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "cards: 导游可创建" ON "public"."cards" FOR INSERT TO "authenticated" WITH CHECK ((("public"."get_user_role"("auth"."uid"()) = 'guide'::"public"."user_role") AND ("created_by" = "auth"."uid"())));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: cards cards: 导游可更新自己的; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'cards: 导游可更新自己的'
      AND n.nspname = 'public'
      AND c.relname = 'cards'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "cards: 导游可更新自己的" ON "public"."cards" FOR UPDATE TO "authenticated" USING (("created_by" = "auth"."uid"())) WITH CHECK (("created_by" = "auth"."uid"()));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: card_pushes cp_strict_insert; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'cp_strict_insert'
      AND n.nspname = 'public'
      AND c.relname = 'card_pushes'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "cp_strict_insert" ON "public"."card_pushes" FOR INSERT TO "authenticated" WITH CHECK (((EXISTS ( SELECT 1
   FROM "public"."rooms" "r"
  WHERE (("r"."id" = "card_pushes"."room_id") AND ("r"."guide_id" = "auth"."uid"())))) AND (("kc_card_id" IS NOT NULL) OR ("room_card_id" IS NOT NULL) OR ("card_id" IS NOT NULL)) AND (("kc_card_id" IS NULL) OR (EXISTS ( SELECT 1
   FROM "public"."knowledge_cards" "kc"
  WHERE (("kc"."id" = "card_pushes"."kc_card_id") AND ("kc"."created_by" = "auth"."uid"()) AND ("kc"."deleted_at" IS NULL)))))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: card_pushes cp_strict_select; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'cp_strict_select'
      AND n.nspname = 'public'
      AND c.relname = 'card_pushes'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "cp_strict_select" ON "public"."card_pushes" FOR SELECT TO "authenticated" USING (((EXISTS ( SELECT 1
   FROM "public"."rooms" "r"
  WHERE (("r"."id" = "card_pushes"."room_id") AND ("r"."guide_id" = "auth"."uid"())))) OR (EXISTS ( SELECT 1
   FROM "public"."room_members" "rm"
  WHERE (("rm"."room_id" = "card_pushes"."room_id") AND ("rm"."user_id" = "auth"."uid"()) AND ("rm"."left_at" IS NULL))))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: favorites; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."favorites" ENABLE ROW LEVEL SECURITY;

--
-- Name: favorites favorites: 用户可取消收藏; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'favorites: 用户可取消收藏'
      AND n.nspname = 'public'
      AND c.relname = 'favorites'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "favorites: 用户可取消收藏" ON "public"."favorites" FOR DELETE TO "authenticated" USING (("user_id" = "auth"."uid"()));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: favorites favorites: 用户可收藏; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'favorites: 用户可收藏'
      AND n.nspname = 'public'
      AND c.relname = 'favorites'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "favorites: 用户可收藏" ON "public"."favorites" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "auth"."uid"()));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: favorites favorites: 用户查看自己的; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'favorites: 用户查看自己的'
      AND n.nspname = 'public'
      AND c.relname = 'favorites'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "favorites: 用户查看自己的" ON "public"."favorites" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: feedbacks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."feedbacks" ENABLE ROW LEVEL SECURITY;

--
-- Name: feedbacks feedbacks_insert_own; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'feedbacks_insert_own'
      AND n.nspname = 'public'
      AND c.relname = 'feedbacks'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "feedbacks_insert_own" ON "public"."feedbacks" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "auth"."uid"()));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: feedbacks feedbacks_select_own; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'feedbacks_select_own'
      AND n.nspname = 'public'
      AND c.relname = 'feedbacks'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "feedbacks_select_own" ON "public"."feedbacks" FOR SELECT TO "authenticated" USING (("user_id" = "auth"."uid"()));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: knowledge_cards kc_delete; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'kc_delete'
      AND n.nspname = 'public'
      AND c.relname = 'knowledge_cards'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "kc_delete" ON "public"."knowledge_cards" FOR DELETE TO "authenticated" USING (("created_by" = "auth"."uid"()));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: knowledge_cards kc_insert; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'kc_insert'
      AND n.nspname = 'public'
      AND c.relname = 'knowledge_cards'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "kc_insert" ON "public"."knowledge_cards" FOR INSERT TO "authenticated" WITH CHECK ((("created_by" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'guide'::"public"."user_role"))))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: knowledge_cards kc_select; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'kc_select'
      AND n.nspname = 'public'
      AND c.relname = 'knowledge_cards'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "kc_select" ON "public"."knowledge_cards" FOR SELECT TO "authenticated" USING (("created_by" = "auth"."uid"()));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: knowledge_cards kc_update; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'kc_update'
      AND n.nspname = 'public'
      AND c.relname = 'knowledge_cards'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "kc_update" ON "public"."knowledge_cards" FOR UPDATE TO "authenticated" USING (("created_by" = "auth"."uid"())) WITH CHECK (("created_by" = "auth"."uid"()));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: knowledge_cards; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."knowledge_cards" ENABLE ROW LEVEL SECURITY;

--
-- Name: memberships; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."memberships" ENABLE ROW LEVEL SECURITY;

--
-- Name: memberships memberships: 仅导游可审批; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'memberships: 仅导游可审批'
      AND n.nspname = 'public'
      AND c.relname = 'memberships'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "memberships: 仅导游可审批" ON "public"."memberships" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."rooms" "r"
  WHERE (("r"."id" = "memberships"."room_id") AND ("r"."guide_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."rooms" "r"
  WHERE (("r"."id" = "memberships"."room_id") AND ("r"."guide_id" = "auth"."uid"())))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: memberships memberships: 摄影师可申请加入; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'memberships: 摄影师可申请加入'
      AND n.nspname = 'public'
      AND c.relname = 'memberships'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "memberships: 摄影师可申请加入" ON "public"."memberships" FOR INSERT TO "authenticated" WITH CHECK ((("user_id" = "auth"."uid"()) AND ("role" = 'photographer'::"text") AND ("approval_status" = 'pending'::"text")));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: memberships memberships: 本人可撤回申请; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'memberships: 本人可撤回申请'
      AND n.nspname = 'public'
      AND c.relname = 'memberships'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "memberships: 本人可撤回申请" ON "public"."memberships" FOR DELETE TO "authenticated" USING ((("user_id" = "auth"."uid"()) AND ("approval_status" = 'pending'::"text")));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: memberships memberships: 本人或导游可查看; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'memberships: 本人或导游可查看'
      AND n.nspname = 'public'
      AND c.relname = 'memberships'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "memberships: 本人或导游可查看" ON "public"."memberships" FOR SELECT TO "authenticated" USING ((("user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."rooms" "r"
  WHERE (("r"."id" = "memberships"."room_id") AND ("r"."guide_id" = "auth"."uid"()))))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: photos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."photos" ENABLE ROW LEVEL SECURITY;

--
-- Name: photos photos: 任何已登录可查看; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'photos: 任何已登录可查看'
      AND n.nspname = 'public'
      AND c.relname = 'photos'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "photos: 任何已登录可查看" ON "public"."photos" FOR SELECT TO "authenticated" USING (true);
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: photos photos: 已授权摄影师可上传; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'photos: 已授权摄影师可上传'
      AND n.nspname = 'public'
      AND c.relname = 'photos'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "photos: 已授权摄影师可上传" ON "public"."photos" FOR INSERT TO "authenticated" WITH CHECK ((("photographer_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."memberships" "m"
  WHERE (("m"."room_id" = "photos"."room_id") AND ("m"."user_id" = "auth"."uid"()) AND ("m"."role" = 'photographer'::"text") AND ("m"."approval_status" = 'approved'::"text") AND ("m"."left_at" IS NULL))))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: photos photos: 已授权摄影师可删除自己的; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'photos: 已授权摄影师可删除自己的'
      AND n.nspname = 'public'
      AND c.relname = 'photos'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "photos: 已授权摄影师可删除自己的" ON "public"."photos" FOR DELETE TO "authenticated" USING ((("photographer_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."memberships" "m"
  WHERE (("m"."room_id" = "photos"."room_id") AND ("m"."user_id" = "auth"."uid"()) AND ("m"."role" = 'photographer'::"text") AND ("m"."approval_status" = 'approved'::"text") AND ("m"."left_at" IS NULL))))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: photos photos: 已授权摄影师可更新自己的; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'photos: 已授权摄影师可更新自己的'
      AND n.nspname = 'public'
      AND c.relname = 'photos'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "photos: 已授权摄影师可更新自己的" ON "public"."photos" FOR UPDATE TO "authenticated" USING ((("photographer_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."memberships" "m"
  WHERE (("m"."room_id" = "photos"."room_id") AND ("m"."user_id" = "auth"."uid"()) AND ("m"."role" = 'photographer'::"text") AND ("m"."approval_status" = 'approved'::"text") AND ("m"."left_at" IS NULL)))))) WITH CHECK ((("photographer_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."memberships" "m"
  WHERE (("m"."room_id" = "photos"."room_id") AND ("m"."user_id" = "auth"."uid"()) AND ("m"."role" = 'photographer'::"text") AND ("m"."approval_status" = 'approved'::"text") AND ("m"."left_at" IS NULL))))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles profiles: 任何已登录用户可查看他人; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'profiles: 任何已登录用户可查看他人'
      AND n.nspname = 'public'
      AND c.relname = 'profiles'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "profiles: 任何已登录用户可查看他人" ON "public"."profiles" FOR SELECT TO "authenticated" USING (true);
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: profiles profiles: 用户更新自己(禁改role); Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'profiles: 用户更新自己(禁改role)'
      AND n.nspname = 'public'
      AND c.relname = 'profiles'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "profiles: 用户更新自己(禁改role)" ON "public"."profiles" FOR UPDATE TO "authenticated" USING (("id" = "auth"."uid"())) WITH CHECK ((("id" = "auth"."uid"()) AND ("role" = "public"."get_user_role"("auth"."uid"()))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: profiles profiles: 用户查看自己; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'profiles: 用户查看自己'
      AND n.nspname = 'public'
      AND c.relname = 'profiles'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "profiles: 用户查看自己" ON "public"."profiles" FOR SELECT TO "authenticated" USING (("id" = "auth"."uid"()));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: questions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."questions" ENABLE ROW LEVEL SECURITY;

--
-- Name: questions questions: 成员和导游可查看; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'questions: 成员和导游可查看'
      AND n.nspname = 'public'
      AND c.relname = 'questions'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "questions: 成员和导游可查看" ON "public"."questions" FOR SELECT TO "authenticated" USING (((EXISTS ( SELECT 1
   FROM "public"."room_members" "rm"
  WHERE (("rm"."room_id" = "questions"."room_id") AND ("rm"."user_id" = "auth"."uid"()) AND ("rm"."left_at" IS NULL)))) OR (EXISTS ( SELECT 1
   FROM "public"."rooms" "r"
  WHERE (("r"."id" = "questions"."room_id") AND ("r"."guide_id" = "auth"."uid"()))))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: questions questions: 有效成员可提问; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'questions: 有效成员可提问'
      AND n.nspname = 'public'
      AND c.relname = 'questions'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "questions: 有效成员可提问" ON "public"."questions" FOR INSERT TO "authenticated" WITH CHECK ((("user_id" = "auth"."uid"()) AND (EXISTS ( SELECT 1
   FROM "public"."room_members" "rm"
  WHERE (("rm"."room_id" = "questions"."room_id") AND ("rm"."user_id" = "auth"."uid"()) AND ("rm"."left_at" IS NULL)))) AND (EXISTS ( SELECT 1
   FROM "public"."rooms" "r"
  WHERE (("r"."id" = "questions"."room_id") AND ("r"."status" = ANY (ARRAY['pending'::"public"."room_status", 'live'::"public"."room_status"])))))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: questions questions_insert_own; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'questions_insert_own'
      AND n.nspname = 'public'
      AND c.relname = 'questions'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "questions_insert_own" ON "public"."questions" FOR INSERT WITH CHECK ((("auth"."uid"() = "user_id") AND (EXISTS ( SELECT 1
   FROM "public"."room_members" "rm"
  WHERE (("rm"."room_id" = "questions"."room_id") AND ("rm"."user_id" = "auth"."uid"()) AND ("rm"."left_at" IS NULL))))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: questions questions_select_guide; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'questions_select_guide'
      AND n.nspname = 'public'
      AND c.relname = 'questions'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "questions_select_guide" ON "public"."questions" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."rooms" "r"
  WHERE (("r"."id" = "questions"."room_id") AND ("r"."guide_id" = "auth"."uid"())))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: questions questions_select_own; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'questions_select_own'
      AND n.nspname = 'public'
      AND c.relname = 'questions'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "questions_select_own" ON "public"."questions" FOR SELECT USING (("auth"."uid"() = "user_id"));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: questions questions_update_guide; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'questions_update_guide'
      AND n.nspname = 'public'
      AND c.relname = 'questions'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "questions_update_guide" ON "public"."questions" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."rooms" "r"
  WHERE (("r"."id" = "questions"."room_id") AND ("r"."guide_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."rooms" "r"
  WHERE (("r"."id" = "questions"."room_id") AND ("r"."guide_id" = "auth"."uid"())))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: room_barrages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."room_barrages" ENABLE ROW LEVEL SECURITY;

--
-- Name: room_cards; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."room_cards" ENABLE ROW LEVEL SECURITY;

--
-- Name: room_cards room_cards_delete; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'room_cards_delete'
      AND n.nspname = 'public'
      AND c.relname = 'room_cards'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "room_cards_delete" ON "public"."room_cards" FOR DELETE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."rooms" "r"
  WHERE (("r"."id" = "room_cards"."room_id") AND ("r"."guide_id" = "auth"."uid"())))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: room_cards room_cards_insert; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'room_cards_insert'
      AND n.nspname = 'public'
      AND c.relname = 'room_cards'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "room_cards_insert" ON "public"."room_cards" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."rooms" "r"
  WHERE (("r"."id" = "room_cards"."room_id") AND ("r"."guide_id" = "auth"."uid"())))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: room_cards room_cards_select; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'room_cards_select'
      AND n.nspname = 'public'
      AND c.relname = 'room_cards'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "room_cards_select" ON "public"."room_cards" FOR SELECT TO "authenticated" USING (((EXISTS ( SELECT 1
   FROM "public"."room_members" "rm"
  WHERE (("rm"."room_id" = "room_cards"."room_id") AND ("rm"."user_id" = "auth"."uid"()) AND ("rm"."left_at" IS NULL)))) OR (EXISTS ( SELECT 1
   FROM "public"."rooms" "r"
  WHERE (("r"."id" = "room_cards"."room_id") AND ("r"."guide_id" = "auth"."uid"()))))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: room_cards room_cards_update; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'room_cards_update'
      AND n.nspname = 'public'
      AND c.relname = 'room_cards'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "room_cards_update" ON "public"."room_cards" FOR UPDATE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."rooms" "r"
  WHERE (("r"."id" = "room_cards"."room_id") AND ("r"."guide_id" = "auth"."uid"())))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: room_join_rate_limits; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."room_join_rate_limits" ENABLE ROW LEVEL SECURITY;

--
-- Name: room_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."room_members" ENABLE ROW LEVEL SECURITY;

--
-- Name: room_members room_members: 已登录用户可加入; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'room_members: 已登录用户可加入'
      AND n.nspname = 'public'
      AND c.relname = 'room_members'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "room_members: 已登录用户可加入" ON "public"."room_members" FOR INSERT TO "authenticated" WITH CHECK (("user_id" = "auth"."uid"()));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: room_members room_members: 房间成员可查看; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'room_members: 房间成员可查看'
      AND n.nspname = 'public'
      AND c.relname = 'room_members'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "room_members: 房间成员可查看" ON "public"."room_members" FOR SELECT TO "authenticated" USING ((("user_id" = "auth"."uid"()) OR ("room_id" IN ( SELECT "rooms"."id"
   FROM "public"."rooms"
  WHERE ("rooms"."guide_id" = "auth"."uid"())))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: room_members room_members: 自己可离开(update left_at); Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'room_members: 自己可离开(update left_at)'
      AND n.nspname = 'public'
      AND c.relname = 'room_members'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "room_members: 自己可离开(update left_at)" ON "public"."room_members" FOR UPDATE TO "authenticated" USING (("user_id" = "auth"."uid"()));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: room_secrets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."room_secrets" ENABLE ROW LEVEL SECURITY;

--
-- Name: rooms; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."rooms" ENABLE ROW LEVEL SECURITY;

--
-- Name: rooms rooms: 任何已登录可查看进行中或等待中; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'rooms: 任何已登录可查看进行中或等待中'
      AND n.nspname = 'public'
      AND c.relname = 'rooms'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "rooms: 任何已登录可查看进行中或等待中" ON "public"."rooms" FOR SELECT TO "authenticated" USING (("status" = ANY (ARRAY['pending'::"public"."room_status", 'live'::"public"."room_status"])));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: rooms rooms: 导游可创建; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'rooms: 导游可创建'
      AND n.nspname = 'public'
      AND c.relname = 'rooms'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "rooms: 导游可创建" ON "public"."rooms" FOR INSERT TO "authenticated" WITH CHECK (("guide_id" = "auth"."uid"()));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: rooms rooms: 导游可更新自己的房间; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'rooms: 导游可更新自己的房间'
      AND n.nspname = 'public'
      AND c.relname = 'rooms'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "rooms: 导游可更新自己的房间" ON "public"."rooms" FOR UPDATE TO "authenticated" USING (("guide_id" = "auth"."uid"())) WITH CHECK (("guide_id" = "auth"."uid"()));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: rooms rooms: 导游可查看自己的所有房间; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'rooms: 导游可查看自己的所有房间'
      AND n.nspname = 'public'
      AND c.relname = 'rooms'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "rooms: 导游可查看自己的所有房间" ON "public"."rooms" FOR SELECT TO "authenticated" USING (("guide_id" = "auth"."uid"()));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: subtitles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."subtitles" ENABLE ROW LEVEL SECURITY;

--
-- Name: subtitles subtitles: 房间参与者可查看; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'subtitles: 房间参与者可查看'
      AND n.nspname = 'public'
      AND c.relname = 'subtitles'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "subtitles: 房间参与者可查看" ON "public"."subtitles" FOR SELECT TO "authenticated" USING ("public"."_is_room_participant"("room_id"));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: subtitles subtitles: 导游可插入; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'subtitles: 导游可插入'
      AND n.nspname = 'public'
      AND c.relname = 'subtitles'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "subtitles: 导游可插入" ON "public"."subtitles" FOR INSERT TO "authenticated" WITH CHECK (("room_id" IN ( SELECT "rooms"."id"
   FROM "public"."rooms"
  WHERE ("rooms"."guide_id" = "auth"."uid"()))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: subtitles subtitles: 导游可更新; Type: POLICY; Schema: public; Owner: -
--

DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'subtitles: 导游可更新'
      AND n.nspname = 'public'
      AND c.relname = 'subtitles'
  ) THEN
    EXECUTE $pg_schema_sql$
CREATE POLICY "subtitles: 导游可更新" ON "public"."subtitles" FOR UPDATE TO "authenticated" USING (("room_id" IN ( SELECT "rooms"."id"
   FROM "public"."rooms"
  WHERE ("rooms"."guide_id" = "auth"."uid"())))) WITH CHECK (("room_id" IN ( SELECT "rooms"."id"
   FROM "public"."rooms"
  WHERE ("rooms"."guide_id" = "auth"."uid"()))));
$pg_schema_sql$;
  END IF;
END
$pg_schema_restore$;


--
-- Name: wechat_identities; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."wechat_identities" ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--




-- ============================================================
-- SECTION: DIFF FILTER OBJECTS
-- ============================================================
-- Objects that match diff-filter.json but cannot be represented
-- precisely by pg_dump --filter.

-- auth.users trigger: on_auth_user_created
DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT t.tgisinternal
      AND t.tgname = 'on_auth_user_created'
      AND n.nspname = 'auth'
      AND c.relname = 'users'
  ) THEN
    EXECUTE 'CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();';
  END IF;
END
$pg_schema_restore$;
-- policy: "audio: 导游可上传" on storage.objects
DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'audio: 导游可上传'
      AND n.nspname = 'storage'
      AND c.relname = 'objects'
  ) THEN
    EXECUTE 'CREATE POLICY "audio: 导游可上传" ON storage.objects AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (((bucket_id = ''audio''::text) AND (EXISTS ( SELECT 1
   FROM public.rooms r
  WHERE (((r.id)::text = (storage.foldername(objects.name))[1]) AND (r.guide_id = auth.uid()))))));';
  END IF;
END
$pg_schema_restore$;
-- policy: "audio: 导游可删除" on storage.objects
DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'audio: 导游可删除'
      AND n.nspname = 'storage'
      AND c.relname = 'objects'
  ) THEN
    EXECUTE 'CREATE POLICY "audio: 导游可删除" ON storage.objects AS PERMISSIVE FOR DELETE TO authenticated USING (((bucket_id = ''audio''::text) AND (EXISTS ( SELECT 1
   FROM public.rooms r
  WHERE (((r.id)::text = (storage.foldername(objects.name))[1]) AND (r.guide_id = auth.uid()))))));';
  END IF;
END
$pg_schema_restore$;
-- policy: "audio: 导游可更新" on storage.objects
DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'audio: 导游可更新'
      AND n.nspname = 'storage'
      AND c.relname = 'objects'
  ) THEN
    EXECUTE 'CREATE POLICY "audio: 导游可更新" ON storage.objects AS PERMISSIVE FOR UPDATE TO authenticated USING (((bucket_id = ''audio''::text) AND (EXISTS ( SELECT 1
   FROM public.rooms r
  WHERE (((r.id)::text = (storage.foldername(objects.name))[1]) AND (r.guide_id = auth.uid())))))) WITH CHECK (((bucket_id = ''audio''::text) AND (EXISTS ( SELECT 1
   FROM public.rooms r
  WHERE (((r.id)::text = (storage.foldername(objects.name))[1]) AND (r.guide_id = auth.uid()))))));';
  END IF;
END
$pg_schema_restore$;
-- policy: "avatars: 公开可读" on storage.objects
DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'avatars: 公开可读'
      AND n.nspname = 'storage'
      AND c.relname = 'objects'
  ) THEN
    EXECUTE 'CREATE POLICY "avatars: 公开可读" ON storage.objects AS PERMISSIVE FOR SELECT TO PUBLIC USING ((bucket_id = ''avatars''::text));';
  END IF;
END
$pg_schema_restore$;
-- policy: "avatars: 已登录可上传" on storage.objects
DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'avatars: 已登录可上传'
      AND n.nspname = 'storage'
      AND c.relname = 'objects'
  ) THEN
    EXECUTE 'CREATE POLICY "avatars: 已登录可上传" ON storage.objects AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((bucket_id = ''avatars''::text));';
  END IF;
END
$pg_schema_restore$;
-- policy: "card-images: 公开可读" on storage.objects
DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'card-images: 公开可读'
      AND n.nspname = 'storage'
      AND c.relname = 'objects'
  ) THEN
    EXECUTE 'CREATE POLICY "card-images: 公开可读" ON storage.objects AS PERMISSIVE FOR SELECT TO PUBLIC USING ((bucket_id = ''card-images''::text));';
  END IF;
END
$pg_schema_restore$;
-- policy: "card-images: 导游可上传" on storage.objects
DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'card-images: 导游可上传'
      AND n.nspname = 'storage'
      AND c.relname = 'objects'
  ) THEN
    EXECUTE 'CREATE POLICY "card-images: 导游可上传" ON storage.objects AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((bucket_id = ''card-images''::text));';
  END IF;
END
$pg_schema_restore$;
-- policy: "photos: 公开可读" on storage.objects
DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'photos: 公开可读'
      AND n.nspname = 'storage'
      AND c.relname = 'objects'
  ) THEN
    EXECUTE 'CREATE POLICY "photos: 公开可读" ON storage.objects AS PERMISSIVE FOR SELECT TO PUBLIC USING ((bucket_id = ''photos''::text));';
  END IF;
END
$pg_schema_restore$;
-- policy: "photos: 已授权摄影师可上传" on storage.objects
DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'photos: 已授权摄影师可上传'
      AND n.nspname = 'storage'
      AND c.relname = 'objects'
  ) THEN
    EXECUTE 'CREATE POLICY "photos: 已授权摄影师可上传" ON storage.objects AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (((bucket_id = ''photos''::text) AND ((storage.foldername(name))[2] = (auth.uid())::text) AND (EXISTS ( SELECT 1
   FROM public.memberships m
  WHERE (((m.room_id)::text = (storage.foldername(objects.name))[1]) AND (m.user_id = auth.uid()) AND (m.role = ''photographer''::text) AND (m.approval_status = ''approved''::text) AND (m.left_at IS NULL))))));';
  END IF;
END
$pg_schema_restore$;
-- policy: "photos: 已授权摄影师可删除" on storage.objects
DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'photos: 已授权摄影师可删除'
      AND n.nspname = 'storage'
      AND c.relname = 'objects'
  ) THEN
    EXECUTE 'CREATE POLICY "photos: 已授权摄影师可删除" ON storage.objects AS PERMISSIVE FOR DELETE TO authenticated USING (((bucket_id = ''photos''::text) AND ((storage.foldername(name))[2] = (auth.uid())::text) AND (EXISTS ( SELECT 1
   FROM public.memberships m
  WHERE (((m.room_id)::text = (storage.foldername(objects.name))[1]) AND (m.user_id = auth.uid()) AND (m.role = ''photographer''::text) AND (m.approval_status = ''approved''::text) AND (m.left_at IS NULL))))));';
  END IF;
END
$pg_schema_restore$;
-- policy: "photos: 已授权摄影师可更新" on storage.objects
DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'photos: 已授权摄影师可更新'
      AND n.nspname = 'storage'
      AND c.relname = 'objects'
  ) THEN
    EXECUTE 'CREATE POLICY "photos: 已授权摄影师可更新" ON storage.objects AS PERMISSIVE FOR UPDATE TO authenticated USING (((bucket_id = ''photos''::text) AND ((storage.foldername(name))[2] = (auth.uid())::text) AND (EXISTS ( SELECT 1
   FROM public.memberships m
  WHERE (((m.room_id)::text = (storage.foldername(objects.name))[1]) AND (m.user_id = auth.uid()) AND (m.role = ''photographer''::text) AND (m.approval_status = ''approved''::text) AND (m.left_at IS NULL)))))) WITH CHECK (((bucket_id = ''photos''::text) AND ((storage.foldername(name))[2] = (auth.uid())::text) AND (EXISTS ( SELECT 1
   FROM public.memberships m
  WHERE (((m.room_id)::text = (storage.foldername(objects.name))[1]) AND (m.user_id = auth.uid()) AND (m.role = ''photographer''::text) AND (m.approval_status = ''approved''::text) AND (m.left_at IS NULL))))));';
  END IF;
END
$pg_schema_restore$;
-- policy: "room-covers: 公开可读" on storage.objects
DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'room-covers: 公开可读'
      AND n.nspname = 'storage'
      AND c.relname = 'objects'
  ) THEN
    EXECUTE 'CREATE POLICY "room-covers: 公开可读" ON storage.objects AS PERMISSIVE FOR SELECT TO PUBLIC USING ((bucket_id = ''room-covers''::text));';
  END IF;
END
$pg_schema_restore$;
-- policy: "room-covers: 导游可上传" on storage.objects
DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'room-covers: 导游可上传'
      AND n.nspname = 'storage'
      AND c.relname = 'objects'
  ) THEN
    EXECUTE 'CREATE POLICY "room-covers: 导游可上传" ON storage.objects AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK ((bucket_id = ''room-covers''::text));';
  END IF;
END
$pg_schema_restore$;
-- policy: audio_select_all on storage.objects
DO $pg_schema_restore$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE pol.polname = 'audio_select_all'
      AND n.nspname = 'storage'
      AND c.relname = 'objects'
  ) THEN
    EXECUTE 'CREATE POLICY audio_select_all ON storage.objects AS PERMISSIVE FOR SELECT TO PUBLIC USING ((bucket_id = ''audio''::text));';
  END IF;
END
$pg_schema_restore$;
-- publication table: supabase_realtime -> public.card_pushes
DO $pg_schema_restore$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') AND NOT EXISTS (
    SELECT 1 FROM pg_publication_rel pr
    JOIN pg_publication p ON p.oid = pr.prpubid
    WHERE p.pubname = 'supabase_realtime'
      AND pr.prrelid = to_regclass('public.card_pushes')
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.card_pushes;';
  END IF;
END
$pg_schema_restore$;
-- publication table: supabase_realtime -> public.questions
DO $pg_schema_restore$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') AND NOT EXISTS (
    SELECT 1 FROM pg_publication_rel pr
    JOIN pg_publication p ON p.oid = pr.prpubid
    WHERE p.pubname = 'supabase_realtime'
      AND pr.prrelid = to_regclass('public.questions')
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.questions;';
  END IF;
END
$pg_schema_restore$;
-- publication table: supabase_realtime -> public.room_barrages
DO $pg_schema_restore$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') AND NOT EXISTS (
    SELECT 1 FROM pg_publication_rel pr
    JOIN pg_publication p ON p.oid = pr.prpubid
    WHERE p.pubname = 'supabase_realtime'
      AND pr.prrelid = to_regclass('public.room_barrages')
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.room_barrages;';
  END IF;
END
$pg_schema_restore$;
-- publication table: supabase_realtime -> public.room_cards
DO $pg_schema_restore$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') AND NOT EXISTS (
    SELECT 1 FROM pg_publication_rel pr
    JOIN pg_publication p ON p.oid = pr.prpubid
    WHERE p.pubname = 'supabase_realtime'
      AND pr.prrelid = to_regclass('public.room_cards')
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.room_cards;';
  END IF;
END
$pg_schema_restore$;
-- publication table: supabase_realtime -> public.room_members
DO $pg_schema_restore$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') AND NOT EXISTS (
    SELECT 1 FROM pg_publication_rel pr
    JOIN pg_publication p ON p.oid = pr.prpubid
    WHERE p.pubname = 'supabase_realtime'
      AND pr.prrelid = to_regclass('public.room_members')
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.room_members;';
  END IF;
END
$pg_schema_restore$;
-- publication table: supabase_realtime -> public.rooms
DO $pg_schema_restore$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') AND NOT EXISTS (
    SELECT 1 FROM pg_publication_rel pr
    JOIN pg_publication p ON p.oid = pr.prpubid
    WHERE p.pubname = 'supabase_realtime'
      AND pr.prrelid = to_regclass('public.rooms')
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.rooms;';
  END IF;
END
$pg_schema_restore$;
-- publication table: supabase_realtime -> public.subtitles
DO $pg_schema_restore$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') AND NOT EXISTS (
    SELECT 1 FROM pg_publication_rel pr
    JOIN pg_publication p ON p.oid = pr.prpubid
    WHERE p.pubname = 'supabase_realtime'
      AND pr.prrelid = to_regclass('public.subtitles')
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.subtitles;';
  END IF;
END
$pg_schema_restore$;

-- ============================================================
-- SECTION: STORAGE BUCKETS DATA
-- ============================================================

INSERT INTO "storage"."buckets" ("id", "name", "owner", "created_at", "updated_at", "public", "avif_autodetection", "file_size_limit", "allowed_mime_types", "owner_id", "type") VALUES ('audio', 'audio', NULL, '2026-07-14 11:35:44.63338+00', '2026-07-14 11:35:44.63338+00', 'true', 'false', NULL, NULL, NULL, 'STANDARD') ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name", "owner" = EXCLUDED."owner", "created_at" = EXCLUDED."created_at", "updated_at" = EXCLUDED."updated_at", "public" = EXCLUDED."public", "avif_autodetection" = EXCLUDED."avif_autodetection", "file_size_limit" = EXCLUDED."file_size_limit", "allowed_mime_types" = EXCLUDED."allowed_mime_types", "owner_id" = EXCLUDED."owner_id", "type" = EXCLUDED."type";
INSERT INTO "storage"."buckets" ("id", "name", "owner", "created_at", "updated_at", "public", "avif_autodetection", "file_size_limit", "allowed_mime_types", "owner_id", "type") VALUES ('avatars', 'avatars', NULL, '2026-07-14 08:44:25.84849+00', '2026-07-14 08:44:25.84849+00', 'true', 'false', NULL, NULL, NULL, 'STANDARD') ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name", "owner" = EXCLUDED."owner", "created_at" = EXCLUDED."created_at", "updated_at" = EXCLUDED."updated_at", "public" = EXCLUDED."public", "avif_autodetection" = EXCLUDED."avif_autodetection", "file_size_limit" = EXCLUDED."file_size_limit", "allowed_mime_types" = EXCLUDED."allowed_mime_types", "owner_id" = EXCLUDED."owner_id", "type" = EXCLUDED."type";
INSERT INTO "storage"."buckets" ("id", "name", "owner", "created_at", "updated_at", "public", "avif_autodetection", "file_size_limit", "allowed_mime_types", "owner_id", "type") VALUES ('card-images', 'card-images', NULL, '2026-07-14 08:44:25.84849+00', '2026-07-14 08:44:25.84849+00', 'true', 'false', NULL, NULL, NULL, 'STANDARD') ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name", "owner" = EXCLUDED."owner", "created_at" = EXCLUDED."created_at", "updated_at" = EXCLUDED."updated_at", "public" = EXCLUDED."public", "avif_autodetection" = EXCLUDED."avif_autodetection", "file_size_limit" = EXCLUDED."file_size_limit", "allowed_mime_types" = EXCLUDED."allowed_mime_types", "owner_id" = EXCLUDED."owner_id", "type" = EXCLUDED."type";
INSERT INTO "storage"."buckets" ("id", "name", "owner", "created_at", "updated_at", "public", "avif_autodetection", "file_size_limit", "allowed_mime_types", "owner_id", "type") VALUES ('photos', 'photos', NULL, '2026-07-14 08:44:25.84849+00', '2026-07-14 08:44:25.84849+00', 'true', 'false', NULL, NULL, NULL, 'STANDARD') ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name", "owner" = EXCLUDED."owner", "created_at" = EXCLUDED."created_at", "updated_at" = EXCLUDED."updated_at", "public" = EXCLUDED."public", "avif_autodetection" = EXCLUDED."avif_autodetection", "file_size_limit" = EXCLUDED."file_size_limit", "allowed_mime_types" = EXCLUDED."allowed_mime_types", "owner_id" = EXCLUDED."owner_id", "type" = EXCLUDED."type";
INSERT INTO "storage"."buckets" ("id", "name", "owner", "created_at", "updated_at", "public", "avif_autodetection", "file_size_limit", "allowed_mime_types", "owner_id", "type") VALUES ('room-covers', 'room-covers', NULL, '2026-07-14 08:44:25.84849+00', '2026-07-14 08:44:25.84849+00', 'true', 'false', NULL, NULL, NULL, 'STANDARD') ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name", "owner" = EXCLUDED."owner", "created_at" = EXCLUDED."created_at", "updated_at" = EXCLUDED."updated_at", "public" = EXCLUDED."public", "avif_autodetection" = EXCLUDED."avif_autodetection", "file_size_limit" = EXCLUDED."file_size_limit", "allowed_mime_types" = EXCLUDED."allowed_mime_types", "owner_id" = EXCLUDED."owner_id", "type" = EXCLUDED."type";

-- ============================================================
-- SECTION: CRON JOBS
-- ============================================================
-- 用户自定义 pg_cron 任务。
