export function useAppLanguage() {
  return {
    locale: 'zh',
    t: (value: string) => value,
    resetLocaleForDeletedAccount: () => undefined,
  };
}
