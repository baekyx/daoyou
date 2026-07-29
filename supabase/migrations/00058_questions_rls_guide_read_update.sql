
-- ================================================================
-- v363: questions 表 RLS 策略
-- 目标：
--   1. 房间内游客只能 INSERT 自己的问题（校验已加入该房间）
--   2. 对应房间的 guide_id 导游可 SELECT 全部问题
--   3. 导游可 UPDATE 问题（如标记已读/is_answered）
--   4. 无关用户不可读取
--   5. 兼容历史数据，不删除旧记录
-- ================================================================

-- 先确保 RLS 已启用
ALTER TABLE questions ENABLE ROW LEVEL SECURITY;

-- 删除旧策略（幂等）
DROP POLICY IF EXISTS "questions_insert_own"    ON questions;
DROP POLICY IF EXISTS "questions_select_guide"  ON questions;
DROP POLICY IF EXISTS "questions_select_own"    ON questions;
DROP POLICY IF EXISTS "questions_update_guide"  ON questions;

-- 1. 游客 INSERT：必须是本人、且已加入该房间（room_members 中有记录且 left_at IS NULL）
CREATE POLICY "questions_insert_own" ON questions
  FOR INSERT
  WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM room_members rm
      WHERE rm.room_id = questions.room_id
        AND rm.user_id = auth.uid()
        AND rm.left_at IS NULL
    )
  );

-- 2. 导游 SELECT：rooms.guide_id = 当前用户
CREATE POLICY "questions_select_guide" ON questions
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM rooms r
      WHERE r.id = questions.room_id
        AND r.guide_id = auth.uid()
    )
  );

-- 3. 游客 SELECT 自己的问题（让游客提问页能看到自己发过的记录）
CREATE POLICY "questions_select_own" ON questions
  FOR SELECT
  USING (auth.uid() = user_id);

-- 4. 导游 UPDATE（标记已读/is_answered）
CREATE POLICY "questions_update_guide" ON questions
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM rooms r
      WHERE r.id = questions.room_id
        AND r.guide_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM rooms r
      WHERE r.id = questions.room_id
        AND r.guide_id = auth.uid()
    )
  );

-- 确保 questions 表已加入 Realtime 发布集（幂等）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'questions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE questions;
  END IF;
END $$;
