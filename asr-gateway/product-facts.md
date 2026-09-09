# 已核对的部署事实（2026-08-04）

- 百度 BCI 运行标准容器镜像，支持环境变量、端口、启动参数和健康探针；本地电脑负责构建镜像，BCI 负责云端运行。
- BCI 默认使用 VPC 内网；需要访问公网百度 ASR 上游以及被公网 H5 访问时，应配置 EIP 或对应公网网络方案。
- 百度 CCR 用于保存并向 BCI 分发 Docker/OCI 镜像。
- 秒哒正式页面使用 HTTPS，因此浏览器端实时识别网关必须提供可信证书下的 `wss://` 地址，不能使用公网 `ws://`。
- 当前项目本地实时 ASR 由 Vite `configureServer` 提供，不会包含在静态 `vite build` 产物中，因此必须拆为独立长期运行的 WebSocket 服务。

官方资料：

- BCI：https://cloud.baidu.com/doc/BCI/index.html
- 创建容器组：https://cloud.baidu.com/doc/BCI/s/Xjxv31bv2
- BCI 公网连接：https://cloud.baidu.com/doc/BCI/s/Dlm8sv0sq
- BCI 健康检查：https://cloud.baidu.com/doc/BCI/s/Tlbxb39np
- CCR：https://cloud.baidu.com/doc/CCR/index.html
