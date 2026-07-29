
-- 删掉冲突的旧外键（SET NULL 与 NOT NULL 列不兼容）
ALTER TABLE room_cards
  DROP CONSTRAINT room_cards_source_card_id_fkey;
