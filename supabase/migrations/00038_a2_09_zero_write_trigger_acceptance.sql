
-- ══════════════════════════════════════════════════════════════════════
-- A2 Migration 09：真正零净变化触发器验收
--
-- 方法：PL/pgSQL 嵌套 BEGIN...EXCEPTION 子事务
--   内层子块：真实触发 UPDATE rooms.password → 触发器写 room_secrets.pwd_hash
--             → extensions.crypt 验证新 hash
--             → 主动抛出 sentinel exception 强制内层全部回滚
--   外层 EXCEPTION：只捕获 sentinel；其他异常继续向上传播
--   回到外层后：重新读取并逐项断言所有字段与测试前完全相同（包括 updated_at）
--
-- 结构前置条件（已只读确认）：
--   rooms      : 无 updated_at 列；trg_sync_room_password_hash 仅 AFTER INSERT/DELETE（不含 UPDATE）
--   room_secrets: 有 updated_at（NOT NULL，default now()）
--   因此内层回滚后：
--     rooms.password           完全恢复（子事务回滚）
--     room_secrets.pwd_hash    完全恢复（子事务回滚）
--     room_secrets.updated_at  完全恢复（子事务回滚）
--   → 真正零净变化
-- ══════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  -- sentinel 使用一个不与业务异常冲突的自定义 SQLSTATE（P0001 = raise_exception）
  -- 我们用字面标签捕获，而非 SQLSTATE，以便精确匹配
  c_sentinel CONSTANT TEXT := 'A2_09_SENTINEL_ROLLBACK';

  v_room_id         UUID;
  -- 保存测试前原值（不输出）
  v_orig_password   TEXT;
  v_orig_pwd_hash   TEXT;
  v_orig_rs_updated TIMESTAMPTZ;

  -- 测试后重新读取值
  v_post_password   TEXT;
  v_post_pwd_hash   TEXT;
  v_post_rs_updated TIMESTAMPTZ;

  -- 测试变量
  v_test_pwd        TEXT;
  v_new_hash        TEXT;
  v_inner_ok        BOOLEAN := FALSE;
BEGIN

  -- ── 外层：选取并锁定目标行 ──
  SELECT r.id, r.password, rs.pwd_hash, rs.updated_at
  INTO   v_room_id, v_orig_password, v_orig_pwd_hash, v_orig_rs_updated
  FROM   public.rooms r
  JOIN   public.room_secrets rs ON rs.room_id = r.id
  WHERE  r.password IS NOT NULL AND r.password <> ''
  ORDER  BY r.created_at
  LIMIT  1
  FOR UPDATE OF r;   -- 锁 rooms 行（room_secrets 通过触发器写，子事务回滚保障一致）

  IF v_room_id IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: no room with room_secrets found';
  END IF;
  -- 仅记录字段是否存在，不输出值
  RAISE NOTICE '[a2_09] target locked; orig fields captured (not shown)';

  -- 测试密码：随机，不会与真实密码碰撞
  v_test_pwd := 'a2_09_test_' || md5(gen_random_uuid()::text);

  -- ════════════════════════════════════════
  -- 内层子事务（BEGIN ... EXCEPTION）
  -- ════════════════════════════════════════
  BEGIN

    -- 真实 UPDATE，触发 _sync_room_password_hash → 写 room_secrets.pwd_hash + updated_at
    UPDATE public.rooms SET password = v_test_pwd WHERE id = v_room_id;

    -- 读取触发器写入的新 hash
    SELECT pwd_hash INTO v_new_hash
    FROM   public.room_secrets WHERE room_id = v_room_id;

    IF v_new_hash IS NULL THEN
      RAISE EXCEPTION 'INNER FAIL: room_secrets.pwd_hash is NULL after trigger';
    END IF;

    -- 验证触发器生成的 hash 可由 extensions.crypt 正确验证
    IF extensions.crypt(v_test_pwd, v_new_hash) <> v_new_hash THEN
      RAISE EXCEPTION 'INNER FAIL: extensions.crypt(test_pwd, new_hash) != new_hash';
    END IF;
    RAISE NOTICE '[a2_09] inner: trigger ran, new hash verified by extensions.crypt  ✅';

    -- 标记内层验证成功，然后主动抛出 sentinel 触发回滚
    v_inner_ok := TRUE;
    RAISE EXCEPTION '%', c_sentinel;

  EXCEPTION
    WHEN OTHERS THEN
      -- 只允许 sentinel 通过；其他异常（如 crypt 验证失败）继续向上抛出
      IF SQLERRM <> c_sentinel THEN
        RAISE;   -- 重新抛出，让 migration 失败
      END IF;
      -- sentinel 捕获：内层子事务已全部回滚
      RAISE NOTICE '[a2_09] sentinel caught; inner subtransaction rolled back  ✅';
  END;
  -- ════════════════════════════════════════

  -- 断言内层验证确实通过再被 sentinel 中止（而非被其他错误中止）
  IF NOT v_inner_ok THEN
    RAISE EXCEPTION 'OUTER FAIL: inner block did not reach sentinel (v_inner_ok=false)';
  END IF;

  -- ── 外层：重新读取，逐项断言与测试前完全相同 ──
  SELECT r.password, rs.pwd_hash, rs.updated_at
  INTO   v_post_password, v_post_pwd_hash, v_post_rs_updated
  FROM   public.rooms r
  JOIN   public.room_secrets rs ON rs.room_id = r.id
  WHERE  r.id = v_room_id;

  -- 断言 rooms.password
  IF v_post_password IS DISTINCT FROM v_orig_password THEN
    RAISE EXCEPTION 'FAIL zero-write: rooms.password changed after inner rollback';
  END IF;
  RAISE NOTICE '[a2_09] rooms.password: unchanged  ✅';

  -- 断言 room_secrets.pwd_hash
  IF v_post_pwd_hash IS DISTINCT FROM v_orig_pwd_hash THEN
    RAISE EXCEPTION 'FAIL zero-write: room_secrets.pwd_hash changed after inner rollback';
  END IF;
  RAISE NOTICE '[a2_09] room_secrets.pwd_hash: unchanged  ✅';

  -- 断言 room_secrets.updated_at（子事务回滚保障）
  IF v_post_rs_updated IS DISTINCT FROM v_orig_rs_updated THEN
    RAISE EXCEPTION 'FAIL zero-write: room_secrets.updated_at changed after inner rollback (expected same as before)';
  END IF;
  RAISE NOTICE '[a2_09] room_secrets.updated_at: unchanged  ✅';

  RAISE NOTICE '════ a2_09 ZERO-WRITE TRIGGER ACCEPTANCE PASSED ════';
  RAISE NOTICE '     rooms.password / room_secrets.pwd_hash / room_secrets.updated_at';
  RAISE NOTICE '     all fields identical to pre-test values — true zero net change  ✅';

END;
$$;
