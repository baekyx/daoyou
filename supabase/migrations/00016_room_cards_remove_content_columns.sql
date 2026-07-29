
-- room_cards 去掉内容副本列，只保留关联字段
-- 先把现有数据中 source_card_id 为 null 的记录打个标记（不删，保持数据完整性）
-- 删除内容副本列
ALTER TABLE room_cards
  DROP COLUMN IF EXISTS title_cn,
  DROP COLUMN IF EXISTS title_en,
  DROP COLUMN IF EXISTS desc_cn,
  DROP COLUMN IF EXISTS desc_en,
  DROP COLUMN IF EXISTS category,
  DROP COLUMN IF EXISTS image_url,
  DROP COLUMN IF EXISTS era,
  DROP COLUMN IF EXISTS location;

-- source_card_id 改为 NOT NULL（关联关系是必须的）
-- 先清理孤儿记录（source_card_id 为 null 的无法关联原卡，删除）
DELETE FROM room_cards WHERE source_card_id IS NULL;
ALTER TABLE room_cards ALTER COLUMN source_card_id SET NOT NULL;

-- 加外键约束，确保引用完整性
ALTER TABLE room_cards
  ADD CONSTRAINT fk_room_cards_source_card
  FOREIGN KEY (source_card_id) REFERENCES knowledge_cards(id) ON DELETE CASCADE;
