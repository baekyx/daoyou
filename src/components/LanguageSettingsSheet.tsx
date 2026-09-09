import { Check, Globe2, Languages, X } from 'lucide-react';
import { toast } from 'sonner';
import { useAppLanguage } from '@/i18n/AppLanguageContext';
import type { AppLocale } from '@/i18n/translations';

interface LanguageSettingsSheetProps {
  open: boolean;
  onClose: () => void;
}

const OPTIONS: Array<{
  locale: AppLocale;
  label: string;
  nativeLabel: string;
  description: string;
}> = [
  {
    locale: 'zh-CN',
    label: '中文界面',
    nativeLabel: '简体中文',
    description: '默认界面语言',
  },
  {
    locale: 'en',
    label: 'English interface',
    nativeLabel: 'English',
    description: 'Clear, concise English',
  },
];

export function LanguageSettingsSheet({ open, onClose }: LanguageSettingsSheetProps) {
  const { locale, setLocale, syncState, t } = useAppLanguage();
  if (!open) return null;

  const handleSelect = async (nextLocale: AppLocale) => {
    if (nextLocale === locale || syncState === 'saving') return;
    const saved = await setLocale(nextLocale);
    toast[saved ? 'success' : 'warning'](
      nextLocale === 'en'
        ? saved ? 'Language preference saved' : 'Saved on this device, but cloud sync failed'
        : saved ? '语言偏好已保存' : '语言已在本机保存，云端同步失败',
    );
  };

  return (
    <div className="language-sheet-overlay" onClick={onClose}>
      <section
        className="language-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="language-sheet-title"
        onClick={event => event.stopPropagation()}
      >
        <div className="language-sheet-handle" aria-hidden="true" />
        <header className="language-sheet-header">
          <span className="language-sheet-heading-icon"><Globe2 size={20} /></span>
          <div>
            <h2 id="language-sheet-title">{t('语言设置')}</h2>
            <p>{t('本次选择会自动保存')}</p>
          </div>
          <button type="button" onClick={onClose} aria-label={t('关闭')}>
            <X size={20} />
          </button>
        </header>

        <div className="language-options" role="radiogroup" aria-label={t('界面语言')}>
          {OPTIONS.map(option => {
            const selected = locale === option.locale;
            return (
              <button
                key={option.locale}
                type="button"
                className={`language-option${selected ? ' is-selected' : ''}`}
                role="radio"
                aria-checked={selected}
                onClick={() => void handleSelect(option.locale)}
                disabled={syncState === 'saving'}
              >
                <span className="language-option-icon">
                  {option.locale === 'zh-CN'
                    ? <Languages size={19} />
                    : <span aria-hidden="true">EN</span>}
                </span>
                <span className="language-option-copy">
                  <b>{option.label}</b>
                  <small>{option.nativeLabel} · {option.description}</small>
                </span>
                <span className="language-option-check" aria-hidden="true">
                  {selected && <Check size={17} />}
                </span>
              </button>
            );
          })}
        </div>

        <p className="language-sheet-note">
          {t('仅更改界面文字，不会改变字幕、翻译或收听语言。')}
        </p>
        {syncState === 'saving' && (
          <p className="language-sheet-sync" role="status">
            <span className="spinner-sm" />{t('正在同步语言偏好…')}
          </p>
        )}
      </section>
    </div>
  );
}

