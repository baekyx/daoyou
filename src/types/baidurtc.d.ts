declare module 'baidurtc';

type BaiduRtcStartOptions = {
  server?: string;
  appid: string;
  token: string;
  roomname: string;
  userid: string;
  displayname: string;
  stream?: MediaStream;
  aspublisher: boolean;
  usingdatachannel: boolean;
  usingvideo: boolean;
  usingaudio: boolean;
  receivingvideo: boolean;
  receivingaudio: boolean;
  autosubscribe: boolean;
  autopublish: boolean;
  remotevideoviewid: string;
  localvideoviewid: string;
  shownovideo?: boolean;
  showspinner?: boolean;
  debuglevel?: boolean | string | string[];
  userevent?: boolean;
  success?: () => void;
  error?: (error: unknown) => void;
  destroyed?: (error: unknown) => void;
  linkdownevent?: () => void;
  linkupevent?: () => void;
  mediastate?: (medium: string, on: boolean) => void;
  remotevideoon?: (index: number) => void;
  remotevideooff?: (index: number) => void;
  remotevideocoming?: (id: string, display: string, attribute: string) => void;
  remotevideoleaving?: (id: string) => void;
  remotevideounpublished?: (id: string) => void;
  localvideopublished_ok?: () => void;
};

interface Window {
  BRTC_Start?: (options: BaiduRtcStartOptions) => void;
  BRTC_Stop?: () => void;
  BRTC_MuteMicphone?: (muted: boolean) => void;
  BRTC_Version?: () => string;
}

