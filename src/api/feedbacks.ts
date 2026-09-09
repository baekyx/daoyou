import { supabase } from "@/db/supabase";
import type { Feedback } from "@/types/types";

const FEEDBACK_SUBMIT_TIMEOUT_MS = 12_000;

function getFeedbackErrorMessage(error: unknown, timedOut: boolean): string {
  if (timedOut) {
    return "提交超时，请检查网络后重试";
  }

  if (error && typeof error === "object") {
    const code = "code" in error ? String(error.code) : "";
    const message = "message" in error ? String(error.message) : "";

    if (code === "PGRST205" || code === "42P01") {
      return "反馈服务尚未完成数据库配置";
    }

    if (message) {
      return message;
    }
  }

  return error instanceof Error ? error.message : "提交失败，请稍后重试";
}

export async function insertFeedback(
  payload: Omit<Feedback, "id" | "user_id" | "status" | "created_at">
): Promise<{ error: string | null }> {
  const controller = new AbortController();
  const timeoutId = globalThis.setTimeout(
    () => controller.abort(),
    FEEDBACK_SUBMIT_TIMEOUT_MS
  );

  try {
    const { data, error } = await supabase
      .from("feedbacks")
      .insert(payload)
      .select("id")
      .abortSignal(controller.signal)
      .single();

    if (error) {
      return {
        error: getFeedbackErrorMessage(error, controller.signal.aborted),
      };
    }

    if (!data?.id) {
      return { error: "反馈未成功写入，请重试" };
    }

    return { error: null };
  } catch (error) {
    return {
      error: getFeedbackErrorMessage(error, controller.signal.aborted),
    };
  } finally {
    globalThis.clearTimeout(timeoutId);
  }
}
