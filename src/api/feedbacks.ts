import { supabase } from "@/db/supabase";
import type { Feedback } from "@/types/types";

export async function insertFeedback(
  payload: Omit<Feedback, "id" | "user_id" | "status" | "created_at">
): Promise<{ error: string | null }> {
  const { error } = await supabase.from("feedbacks").insert(payload);
  return { error: error?.message ?? null };
}
