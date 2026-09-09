import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import svgr from "vite-plugin-svgr";
import path from "path";
import { baiduLocalApiPlugin } from "./local-api/baidu";

export default defineConfig(({ mode }) => {
  // 读取 supabase/.env.local 中不带 VITE_ 前缀的服务端密钥。
  // loadEnv 只在 Node 端执行，变量不会被打进浏览器代码。
  const serverEnv = loadEnv(mode, path.resolve(__dirname, "supabase"), "");
  const publicEnv = loadEnv(mode, __dirname, "VITE_");

  return {
    plugins: [
      react(),
      svgr({
        svgrOptions: {
          icon: true,
          exportType: "named",
          namedExport: "ReactComponent",
        },
      }),
      baiduLocalApiPlugin({
        apiKey: serverEnv.BAIDU_API_KEY ?? "",
        secretKey: serverEnv.BAIDU_SECRET_KEY ?? "",
        speechAppId: serverEnv.BAIDU_SPEECH_APP_ID ?? "",
        speechApiKey: serverEnv.BAIDU_SPEECH_API_KEY ?? "",
        translationApiKey: serverEnv.BAIDU_TRANSLATION_API_KEY ?? "",
        translationSecretKey: serverEnv.BAIDU_TRANSLATION_SECRET_KEY ?? "",
        ttsApiKey: serverEnv.BAIDU_TTS_API_KEY ?? "",
        ttsSecretKey: serverEnv.BAIDU_TTS_SECRET_KEY ?? "",
        rtcAppId: serverEnv.BAIDU_RTC_APP_ID ?? serverEnv.VITE_BAIDU_RTC_APP_ID ?? "",
        rtcAppKey: serverEnv.BAIDU_RTC_APP_KEY ?? "",
      }),
    ],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    // 仅把可公开的百度 RTC AppID 注入浏览器；AppKey 始终只保留在本地 Node 服务端。
    define: {
      "import.meta.env.VITE_BAIDU_RTC_APP_ID": JSON.stringify(
        publicEnv.VITE_BAIDU_RTC_APP_ID ??
        serverEnv.VITE_BAIDU_RTC_APP_ID ??
        serverEnv.BAIDU_RTC_APP_ID ??
        "",
      ),
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes("node_modules")) return;
            if (id.includes("@supabase")) return "supabase";
            if ((id.includes("react") || id.includes("scheduler")) && !id.includes("react-refresh")) return "react";
            if (id.includes("lucide-react") || id.includes("sonner") || id.includes("qrcode")) return "ui";
            return "vendor";
          },
        },
      },
    },
  };
});
