
-- ================================================================
-- Migration 00025: 用 advisory lock 串行化同一 room 的 sequence 生成
-- 不同 room_id 之间使用不同 lock key，互不阻塞
-- 覆盖 00024 中的触发器函数，触发器绑定不变
-- ================================================================

CREATE OR REPLACE FUNCTION public.set_card_push_sequence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
