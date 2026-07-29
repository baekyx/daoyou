
CREATE OR REPLACE FUNCTION public.increment_online_count(room_id uuid, delta int)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE public.rooms
  SET online_count = GREATEST(0, online_count + delta)
  WHERE id = room_id;
$$;
