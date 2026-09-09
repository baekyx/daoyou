import { qaPendingRoom, qaRooms } from './rooms';

function membershipQuery(table = 'memberships') {
  const variant = new URLSearchParams(window.location.search).get('variant');
  const baseMemberships = qaRooms.slice(0, 2).map((room, index) => ({
    id: `qa-membership-${index + 1}`,
    room_id: room.id,
    user_id: 'qa-tourist',
    role: 'photographer',
    approval_status: 'approved',
    left_at: room.status === 'ended' ? new Date(Date.now() - 1800000).toISOString() : null,
    joined_at: new Date(Date.now() - index * 3600000).toISOString(),
    rooms: room,
  }));
  const tableData = table === 'rooms'
    ? qaRooms
    : table === 'memberships'
      ? baseMemberships
      : [];
  const result = {
    data: variant === 'empty' ? [] : tableData,
    error: variant === 'error' ? { message: 'QA request failed' } : null,
  };

  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'in', 'order', 'update', 'insert', 'delete', 'not', 'is', 'gt', 'gte', 'lt', 'lte', 'range']) {
    chain[method] = () => chain;
  }
  chain.limit = () => chain;
  chain.maybeSingle = () => Promise.resolve({
    data: table === 'rooms'
      ? variant === 'pending'
        ? qaPendingRoom
        : qaRooms.find(room => room.status === 'live') ?? null
      : table === 'memberships'
        ? { approval_status: 'approved', left_at: null }
        : null,
    error: null,
  });
  chain.single = () => Promise.resolve({ data: null, error: null });
  chain.then = (resolve: (value: unknown) => unknown) => (
    variant === 'loading'
      ? new Promise<typeof result>(done => window.setTimeout(() => done(result), 1500)).then(resolve)
      : Promise.resolve(result).then(resolve)
  );
  return chain;
}

export const supabase = {
  from: (table: string) => membershipQuery(table),
  rpc: async () => ({ data: null, error: null }),
  functions: { invoke: async () => ({ data: {}, error: null }) },
  channel: () => ({
    on() { return this; },
    subscribe() { return this; },
    send: async () => undefined,
    unsubscribe() { return undefined; },
  }),
  removeChannel: () => undefined,
};
