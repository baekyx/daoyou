请继续修复当前项目 app-dgh89h0lz9j5。当前秒哒页面创建房间时报错：PostgREST schema cache 找不到 public.create_room_secure(p_cover_url, p_estimated_duration, p_name, p_password)。前端源码和路由已经与 V5 同步，本轮只修复目标 Supabase 的 RPC 契约并做完整核对，不修改任何 UI、路由、页面或业务数据。

【权威源码】
以秒哒工作区内已上传 V5 的本地迁移为唯一依据：
/workspace/app-dgh89h0lz9j5/tasks/shiguang-deploy/拾光旅伴-H5-v5/supabase/migrations/
create_room_secure 的权威定义位于 00031_a2_02_secure_rpcs.sql，签名必须是：
public.create_room_secure(TEXT, TEXT, TEXT, INT)
参数名必须是：p_name、p_password、p_cover_url、p_estimated_duration。

【第一步：只读诊断】
1. 查询 pg_proc、pg_namespace 和 information_schema.routines，确认 create_room_secure 是否存在、参数名称/类型/顺序、返回类型、security definer、search_path 和权限。
2. 使用 to_regprocedure('public.create_room_secure(text,text,text,integer)') 验证精确签名。
3. 不要只看 migration 记录；必须检查目标数据库实际对象。

【第二步：精准修复】
1. 如果函数缺失或签名不一致，从 00031_a2_02_secure_rpcs.sql 提取完整 CREATE OR REPLACE FUNCTION public.create_room_secure 定义和对应 REVOKE/GRANT，原样应用到当前目标 Supabase。
2. 不要手工改写或简化函数逻辑；必须保持本地的登录校验、guide 角色校验、名称和六位密码校验、已有 pending/live 房间复用、唯一房间号生成、并发处理及安全 JSONB 返回。
3. 确保 authenticated 拥有 EXECUTE，anon 和 PUBLIC 不拥有执行权限。
4. 执行 NOTIFY pgrst, 'reload schema'; 刷新 PostgREST schema cache，然后重新查询精确签名。
5. 若函数已经存在且签名正确，只刷新 schema cache 和权限，不重复改写无关对象。

【第三步：完整 RPC 契约审计】
请把当前 V5 前端实际调用的以下 RPC 与目标数据库逐项比对：
- check_room_access
- create_room_secure
- get_active_rooms_secure
- get_guide_rooms_secure
- get_my_joined_rooms_secure
- get_my_profile_private
- get_room_by_id_secure
- get_room_by_number_secure
- get_room_member_history_safe
- get_room_members_safe
- get_room_photos
- get_room_public_profiles
- get_room_subtitles
- has_joined_room_secure
- increment_online_count
- join_photographer_room_with_password
- join_room_with_password
- restore_current_room_secure
- resume_room_membership
- set_my_role
- switch_my_role
- verify_room_password_only

对每个 RPC 报告 EXISTS/MISSING 和实际签名。若有缺失，只能从 V5 的现有 migration 或 schema.sql 中复制对应的权威定义并幂等创建；找不到权威定义的项目必须停止并标记 MISSING，不得猜测实现。

【路由和功能一致性】
1. 不修改前端任何文件；当前完整 V5 的 src、public 和 index.css 已完成同步。
2. 不修改 hash 路由名称、登录态判断、角色判断、按钮操作、跳转和返回关系。
3. 不创建兼容性假函数，不将安全 RPC 改为客户端直写表。

【严格禁止】
- 不修改任何表结构、列、索引、触发器、RLS、Storage bucket、Edge Function 或现有业务数据。
- 不重新初始化 Supabase，不重复执行整套 migrations，不创建新项目。
- 不读取、输出或改写任何密钥。
- 不发布生产版本。

【验收】
1. to_regprocedure 对 create_room_secure 四参数签名返回非空。
2. 参数名与前端调用完全一致：p_name、p_password、p_cover_url、p_estimated_duration。
3. authenticated 有 EXECUTE；anon/PUBLIC 无 EXECUTE。
4. PostgREST schema cache 已刷新。
5. 22 个前端 RPC 输出完整 EXISTS/MISSING 清单，所有找到权威定义的缺失项均已补齐。
6. 完成后通过 Supabase/PostgREST 做一次不写入业务数据的函数可发现性检查，确认不再返回 PGRST202/找不到 schema cache。

完成后只报告：create_room_secure 修复前后状态、执行的 SQL 来源文件、22 个 RPC 契约清单、schema cache 刷新结果、未解决项，并确认前端/路由/表结构/RLS/Storage/业务数据/生产发布均未修改。
