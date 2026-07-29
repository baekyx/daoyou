import type { ComponentType } from 'react';

export interface RouteConfig {
  name: string;
  path: string;
  component: ComponentType;
  visible?: boolean;
  /** Accessible without login. Routes without this flag require authentication. Has no effect when RouteGuard is not in use. */
  public?: boolean;
}

export const routes: RouteConfig[] = [
  {
    name: '拾光旅伴',
    path: '/',
    component: () => null, // placeholder — App.tsx renders PrototypePage directly
    public: true,
  }
];
