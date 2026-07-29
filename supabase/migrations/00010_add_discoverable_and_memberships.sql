
-- 1. rooms 表新增 discoverable 字段
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS discoverable boolean NOT NULL DEFAULT true;

-- 2. memberships 表（统一管理成员+摄影师审批）
CREATE TABLE IF NOT EXISTS memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'tourist',
  approval_status text NOT NULL DEFAULT 'approved',
  rejection_reason text,
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  UNIQUE(room_id, user_id)
);
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY "members_select" ON memberships FOR SELECT USING (true);
CREATE POLICY "members_insert" ON memberships FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "members_update" ON memberships FOR UPDATE USING (true);

-- 3. knowledge_cards 表
CREATE TABLE IF NOT EXISTS knowledge_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title_cn text NOT NULL,
  title_en text,
  desc_cn text NOT NULL DEFAULT '',
  desc_en text,
  category text NOT NULL DEFAULT '建筑',
  image_url text,
  era text,
  location text,
  status text NOT NULL DEFAULT 'published',
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE knowledge_cards ENABLE ROW LEVEL SECURITY;
CREATE POLICY "kc_select" ON knowledge_cards FOR SELECT USING (true);
CREATE POLICY "kc_insert" ON knowledge_cards FOR INSERT WITH CHECK (auth.uid() = created_by);
CREATE POLICY "kc_update" ON knowledge_cards FOR UPDATE USING (auth.uid() = created_by);

-- 4. card_pushes 更新：确保有 pushed_at
CREATE TABLE IF NOT EXISTS card_pushes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  card_id uuid NOT NULL REFERENCES knowledge_cards(id) ON DELETE CASCADE,
  pushed_by uuid REFERENCES auth.users(id),
  pushed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE card_pushes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "cp_select" ON card_pushes FOR SELECT USING (true);
CREATE POLICY "cp_insert" ON card_pushes FOR INSERT WITH CHECK (true);

-- 5. 预置知识卡片示例数据
INSERT INTO knowledge_cards (title_cn, title_en, desc_cn, desc_en, category, era, location, status, created_by)
SELECT '太和殿', 'Hall of Supreme Harmony',
  '太和殿，俗称"金銮殿"，建于明永乐十八年（1420年），是紫禁城内规格最高、体量最大的殿宇，坐落于三层汉白玉台基之上。这里是皇帝举行大典、接见群臣的重要场所。',
  'Built in 1420 during the Ming Dynasty, the Hall of Supreme Harmony is the largest and highest-ranked hall in the Forbidden City, standing on a three-tiered white marble terrace.',
  '建筑', '明永乐十八年（1420年）', '北京故宫', 'published', id
FROM auth.users LIMIT 1
ON CONFLICT DO NOTHING;

INSERT INTO knowledge_cards (title_cn, title_en, desc_cn, desc_en, category, era, location, status, created_by)
SELECT '清明上河图', 'Along the River During the Qingming Festival',
  '《清明上河图》是北宋画家张择端的传世名作，以精细的笔触描绘了北宋都城汴京（今开封）清明时节的繁华景象，全卷长约5.28米，宽约0.25米。',
  'A masterpiece by Zhang Zeduan of the Northern Song dynasty, this scroll vividly depicts the daily life along the Bian River during the Qingming Festival.',
  '文物', '北宋（约1085–1145年）', '北京故宫博物院', 'published', id
FROM auth.users LIMIT 1
ON CONFLICT DO NOTHING;

INSERT INTO knowledge_cards (title_cn, title_en, desc_cn, desc_en, category, era, location, status, created_by)
SELECT '颐和园', 'Summer Palace',
  '颐和园是中国现存规模最大、保存最完整的皇家园林，1998年被列入世界文化遗产名录。以昆明湖和万寿山为基础，汲取江南园林的设计手法，是中国造园艺术的集大成者。',
  'The Summer Palace is the largest and best-preserved imperial garden in China. Listed as a UNESCO World Heritage Site in 1998, it is a masterpiece of Chinese landscape garden design.',
  '自然', '清乾隆十五年（1750年）', '北京海淀区', 'published', id
FROM auth.users LIMIT 1
ON CONFLICT DO NOTHING;
