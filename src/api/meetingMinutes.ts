import { supabase } from "@/db/supabase";
import type { MeetingMinutes } from "@/lib/meetingMinutes";

type MeetingMinutesRow = {
  room_id: string;
  content: MeetingMinutes;
};

/** 云端读取纪要；表尚未迁移或没有权限时明确抛错。 */
export async function fetchMeetingMinutesCloud(roomId: string): Promise<MeetingMinutes | null> {
  const { data, error } = await supabase
    .from("meeting_minutes")
    .select("room_id,content")
    .eq("room_id", roomId)
    .maybeSingle();
  if (error) throw new Error(error.message || "会议纪要读取失败");
  return data ? (data as MeetingMinutesRow).content : null;
}

/** 返回当前导游已生成纪要的房间集合。 */
export async function fetchMeetingMinutesRoomIds(): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("meeting_minutes")
    .select("room_id");
  if (error) throw new Error(error.message || "会议纪要索引读取失败");
  return new Set((Array.isArray(data) ? data : []).map(row => String(row.room_id)));
}

/** 以 room_id 幂等保存，跨设备可读取同一份纪要。 */
export async function saveMeetingMinutesCloud(
  minutes: MeetingMinutes,
  guideId: string,
): Promise<void> {
  const { error } = await supabase
    .from("meeting_minutes")
    .upsert({
      room_id: minutes.roomId,
      guide_id: guideId,
      content: minutes,
      subtitle_count: minutes.subtitleCount,
      generated_at: minutes.generatedAt,
      updated_at: new Date().toISOString(),
    }, { onConflict: "room_id" });
  if (error) throw new Error(error.message || "会议纪要保存失败");
}
