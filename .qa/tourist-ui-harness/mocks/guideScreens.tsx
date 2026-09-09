import { Camera, Captions, CircleUserRound, DoorOpen, Headphones, History, Images } from 'lucide-react';
import type { ElementType } from 'react';

type NavItem = [ElementType, string, string];

export function BottomNav({
  active,
  go,
  variant = 'visitorHome',
}: {
  active: string;
  go?: (id: string) => void;
  variant?: 'visitorHome' | 'room' | 'photographer';
}) {
  const items: NavItem[] = variant === 'room'
    ? [[Headphones, '语音', 'listening'], [Captions, '字幕', 'subtitle-tab'], [Images, '相册', 'room-album']]
    : variant === 'photographer'
      ? [[Camera, '任务', 'photographer-tasks'], [Images, '相册', 'photographer-album'], [CircleUserRound, '我的', 'photographer-my']]
      : [[DoorOpen, '房间', 'room-list'], [History, '最近', 'recent-rooms'], [CircleUserRound, '我的', 'tourist-my']];

  return (
    <div className="bottom-nav">
      {items.map(([Icon, name, target]) => (
        <button
          key={name}
          className={active === name ? 'active' : ''}
          onClick={() => go?.(target)}
          aria-label={name}
        >
          <Icon size={22} strokeWidth={1.9} aria-hidden="true" />
          <span>{name}</span>
        </button>
      ))}
    </div>
  );
}
