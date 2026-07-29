
-- 模型 B：所有导游共享卡片库，均可增删改查
-- 先删除旧策略
DROP POLICY IF EXISTS kc_select ON knowledge_cards;
DROP POLICY IF EXISTS kc_insert ON knowledge_cards;
DROP POLICY IF EXISTS kc_update ON knowledge_cards;
DROP POLICY IF EXISTS kc_delete ON knowledge_cards;

-- SELECT：所有登录用户可查（导游+游客均可，用于展示）
CREATE POLICY kc_select ON knowledge_cards
  FOR SELECT USING (true);

-- INSERT / UPDATE / DELETE：仅限导游角色
CREATE POLICY kc_insert ON knowledge_cards
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM profiles WHERE id = uid() AND role = 'guide')
  );

CREATE POLICY kc_update ON knowledge_cards
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = uid() AND role = 'guide')
  );

CREATE POLICY kc_delete ON knowledge_cards
  FOR DELETE USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = uid() AND role = 'guide')
  );
