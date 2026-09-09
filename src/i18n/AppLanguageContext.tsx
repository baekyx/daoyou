import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { supabase } from '@/db/supabase';
import { useAuth } from '@/contexts/AuthContext';
import {
  EN_UI_COPY,
  translateUiText,
  type AppLocale,
} from '@/i18n/translations';

const LAST_LOCALE_KEY = 'shiguang-ui-locale:last';
const USER_LOCALE_PREFIX = 'shiguang-ui-locale:user:';
const UI_LOCALE_METADATA_KEY = 'ui_locale';
const TRANSLATABLE_ATTRIBUTES = ['aria-label', 'placeholder', 'title', 'alt'] as const;

type SyncState = 'idle' | 'saving' | 'saved' | 'local-only';

interface AppLanguageContextValue {
  locale: AppLocale;
  isEnglish: boolean;
  syncState: SyncState;
  setLocale: (locale: AppLocale) => Promise<boolean>;
  resetLocaleForDeletedAccount: () => void;
  t: (source: string) => string;
}

const AppLanguageContext = createContext<AppLanguageContextValue | null>(null);
const originalText = new WeakMap<Text, string>();
const originalAttributes = new WeakMap<Element, Map<string, string>>();

function normalizeLocale(value: unknown): AppLocale | null {
  return value === 'en' || value === 'zh-CN' ? value : null;
}

function readStoredLocale(key: string): AppLocale | null {
  try {
    return normalizeLocale(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function writeStoredLocale(key: string, locale: AppLocale) {
  try {
    localStorage.setItem(key, locale);
  } catch {
    // Storage can be unavailable in private browsing; account metadata remains the durable source.
  }
}

function translateTextNode(node: Text, locale: AppLocale) {
  const current = node.nodeValue ?? '';
  if (locale === 'zh-CN') {
    const original = originalText.get(node);
    if (original != null && current !== original) node.nodeValue = original;
    return;
  }
  if (/[\u4e00-\u9fff]/.test(current)) originalText.set(node, current);
  const source = originalText.get(node) ?? current;
  const translated = translateUiText(source, locale);
  if (translated !== current) node.nodeValue = translated;
}

function translateElementAttributes(element: Element, locale: AppLocale) {
  let cache = originalAttributes.get(element);
  for (const attribute of TRANSLATABLE_ATTRIBUTES) {
    const current = element.getAttribute(attribute);
    if (current == null) continue;
    if (locale === 'zh-CN') {
      const original = cache?.get(attribute);
      if (original != null && current !== original) element.setAttribute(attribute, original);
      continue;
    }
    if (/[\u4e00-\u9fff]/.test(current)) {
      if (!cache) {
        cache = new Map();
        originalAttributes.set(element, cache);
      }
      cache.set(attribute, current);
    }
    const source = cache?.get(attribute) ?? current;
    const translated = translateUiText(source, locale);
    if (translated !== current) element.setAttribute(attribute, translated);
  }
}

function translateTree(root: Node, locale: AppLocale) {
  if (root.nodeType === Node.TEXT_NODE) {
    translateTextNode(root as Text, locale);
    return;
  }
  if (!(root instanceof Element)) return;
  if (root.matches('script, style, [data-no-ui-translate]')) return;
  translateElementAttributes(root, locale);
  root.childNodes.forEach(child => translateTree(child, locale));
}

function AppLanguageDomBridge({ locale }: { locale: AppLocale }) {
  useEffect(() => {
    const root = document.getElementById('root');
    if (!root) return;

    document.documentElement.lang = locale;
    document.body.dataset.uiLocale = locale;
    document.title = locale === 'en'
      ? 'Timeglow Travel'
      : '拾光旅伴｜静态 H5 页面框架';
    translateTree(root, locale);

    const observer = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        if (mutation.type === 'characterData') {
          translateTextNode(mutation.target as Text, locale);
          continue;
        }
        if (mutation.type === 'attributes' && mutation.target instanceof Element) {
          translateElementAttributes(mutation.target, locale);
          continue;
        }
        mutation.addedNodes.forEach(node => translateTree(node, locale));
      }
    });
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...TRANSLATABLE_ATTRIBUTES],
    });
    return () => observer.disconnect();
  }, [locale]);

  return null;
}

export function AppLanguageProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [locale, setLocaleState] = useState<AppLocale>(
    () => readStoredLocale(LAST_LOCALE_KEY) ?? 'zh-CN',
  );
  const [syncState, setSyncState] = useState<SyncState>('idle');
  const activeUserRef = useRef<string | null>(null);

  useEffect(() => {
    const userId = user?.id ?? null;
    if (activeUserRef.current === userId) return;
    activeUserRef.current = userId;
    if (!userId) return;

    const remoteLocale = normalizeLocale(user?.user_metadata?.[UI_LOCALE_METADATA_KEY]);
    const localLocale = readStoredLocale(`${USER_LOCALE_PREFIX}${userId}`);
    const nextLocale = remoteLocale ?? localLocale ?? 'zh-CN';
    setLocaleState(nextLocale);
    writeStoredLocale(LAST_LOCALE_KEY, nextLocale);
    writeStoredLocale(`${USER_LOCALE_PREFIX}${userId}`, nextLocale);
  }, [user?.id, user?.user_metadata]);

  const setLocale = useCallback(async (nextLocale: AppLocale) => {
    setLocaleState(nextLocale);
    writeStoredLocale(LAST_LOCALE_KEY, nextLocale);
    if (!user?.id) {
      setSyncState('saved');
      return true;
    }

    writeStoredLocale(`${USER_LOCALE_PREFIX}${user.id}`, nextLocale);
    setSyncState('saving');
    const { error } = await supabase.auth.updateUser({
      data: { [UI_LOCALE_METADATA_KEY]: nextLocale },
    });
    setSyncState(error ? 'local-only' : 'saved');
    return !error;
  }, [user?.id]);

  const resetLocaleForDeletedAccount = useCallback(() => {
    try {
      localStorage.removeItem(LAST_LOCALE_KEY);
      if (user?.id) localStorage.removeItem(`${USER_LOCALE_PREFIX}${user.id}`);
    } catch {
      // Ignore storage restrictions; the deleted remote account no longer carries a preference.
    }
    setLocaleState('zh-CN');
    setSyncState('idle');
  }, [user?.id]);

  const t = useCallback(
    (source: string) => locale === 'en' ? (EN_UI_COPY[source] ?? translateUiText(source, locale)) : source,
    [locale],
  );

  const value = useMemo<AppLanguageContextValue>(() => ({
    locale,
    isEnglish: locale === 'en',
    syncState,
    setLocale,
    resetLocaleForDeletedAccount,
    t,
  }), [locale, resetLocaleForDeletedAccount, setLocale, syncState, t]);

  return (
    <AppLanguageContext.Provider value={value}>
      <AppLanguageDomBridge locale={locale} />
      {children}
    </AppLanguageContext.Provider>
  );
}

export function useAppLanguage() {
  const context = useContext(AppLanguageContext);
  if (!context) throw new Error('useAppLanguage must be used within AppLanguageProvider');
  return context;
}
