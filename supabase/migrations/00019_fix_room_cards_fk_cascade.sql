
-- 外键约束名称确认后重建
ALTER TABLE room_cards
  DROP CONSTRAINT IF EXISTS fk_room_cards_source_card;

ALTER TABLE room_cards
  ADD CONSTRAINT fk_room_cards_source_card
  FOREIGN KEY (source_card_id)
  REFERENCES knowledge_cards(id)
  ON DELETE CASCADE;
