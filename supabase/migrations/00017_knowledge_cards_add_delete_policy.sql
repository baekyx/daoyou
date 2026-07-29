
-- 允许创建者删除自己的卡片
CREATE POLICY kc_delete ON knowledge_cards
  FOR DELETE
  USING (uid() = created_by);
